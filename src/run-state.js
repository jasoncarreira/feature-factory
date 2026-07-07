import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, rename, rm, mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  createAttestationIndex,
  createGateDecisionAttestation,
  hashFile,
  hashValue,
  resolveArtifactRef,
  resolveGateRef,
  validateGateDecisionAttestation,
  validateProvenanceAuthority,
} from "./provenance-authority.js";
import { pendingProtectedGate, validateFactoryLock, validateHeartbeatState, validateRun, validateRunAuthority } from "./validate.js";

export const TERMINAL_RUN_STATUSES = new Set(["completed", "blocked", "partial", "needs-human"]);

const ACTIVE_HEARTBEAT_STATUSES = new Set(["active", "running"]);
const HEARTBEAT_STEP_IN_FLIGHT_STATUSES = new Set(["running"]);
const HEARTBEAT_SLICE_IN_FLIGHT_STATUSES = new Set(["running", "review"]);
const SAFE_GATE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const SENSITIVE_SLICE_STATUSES = new Set(["review", "merged"]);
const PASSING_VALIDATOR_VERDICTS = new Set(["GO", "GO-WITH-NITS"]);
const PASSING_SECURITY_VERDICTS = new Set(["PASS"]);

const DEFAULT_LOCK_TIMEOUT_MS = 1000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const LOCK_DIR = "run-json.lock";
const LOCK_OWNER_FILE = "owner.json";
const RUN_FILE = "run.json";
const FACTORY_LOCK_FILE = "factory.lock";
const HEARTBEAT_FILE = "heartbeat.json";
const ATTESTATIONS_DIR = "attestations";
const ATTESTATIONS_INDEX_FILE = "index.json";
const ATTESTATIONS_GATES_DIR = "gates";

export async function withRunJsonLock(runDir, fn, options = {}) {
  if (typeof fn !== "function") throw new Error("withRunJsonLock requires a callback");
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const retryDelayMs = normalizePositiveInteger(options.retryDelayMs, DEFAULT_LOCK_RETRY_DELAY_MS);
  const lockDir = join(runDir, LOCK_DIR);
  const ownerPath = join(lockDir, LOCK_OWNER_FILE);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        const owner = await readJsonIfExists(ownerPath);
        throw new Error(formatLockTimeout(lockDir, owner));
      }
      await delay(Math.min(retryDelayMs, Math.max(1, deadline - Date.now())));
    }
  }

  const owner = {
    pid: process.pid,
    hostname: hostname(),
    acquired_at: new Date().toISOString(),
  };

  try {
    await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
    return await fn({ lock_dir: lockDir, owner });
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

export function hashRunState(run) {
  return hashValue(validateRun(cloneJson(run)));
}

export async function transitionRunJson(runDir, mutator, options = {}) {
  if (typeof mutator !== "function") throw new Error("transitionRunJson requires a mutator");
  return withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, mutator, options), options);
}

export async function transitionGateDecision(runDir, gateName, gate, options = {}) {
  if (!stringValue(gateName)) throw new Error("transitionGateDecision requires a gate name");
  assertSafeGateName(gateName);
  const nextGate = normalizeGateDecision(gateName, gate);

  if (nextGate.status !== "approved") {
    const result = await transitionRunJson(
      runDir,
      (draft) => {
        draft.gates = normalizeGateMap(draft.gates);
        draft.gates[gateName] = cloneJson(nextGate);
      },
      options,
    );
    return { ...result, gate: gateName, attestation_ref: null };
  }

  assertApprovedGateDecisionShape(gateName, nextGate);
  const attestationRef = gateAttestationRef(gateName);
  const gateAttestationPath = join(runDir, attestationRef);
  const indexPath = join(runDir, ATTESTATIONS_DIR, ATTESTATIONS_INDEX_FILE);

  return withRunJsonLock(
    runDir,
    async () => {
      const gateSnapshot = await snapshotFile(gateAttestationPath);
      const indexSnapshot = await snapshotFile(indexPath);
      let committed = false;

      try {
        const result = await transitionRunJsonLocked(
          runDir,
          (draft) => {
            draft.gates = normalizeGateMap(draft.gates);
            draft.gates[gateName] = cloneJson(nextGate);
          },
          options,
          {
            beforeValidateNext: async ({ current, next }) => {
              const graph = assertProvenanceGraphValid(runDir, options);
              const records = acceptedAttestationEntries(graph);
              const nextGateDecision = next.gates?.[gateName];
              const staged = createApprovedGateDecisionState({
                runDir,
                current,
                gateName,
                gate: nextGateDecision,
                records,
              });

              const attestationValidation = validateGateDecisionAttestation(staged.attestation, { ...options, runDir });
              assertValidationChecksValid(attestationValidation, "gate-decision validation failed");

              await mkdir(join(runDir, ATTESTATIONS_DIR, ATTESTATIONS_GATES_DIR), { recursive: true });
              await writeJsonAtomically(gateAttestationPath, staged.attestation);
              await writeJsonAtomically(indexPath, staged.index);
            },
          },
        );
        committed = true;
        return { ...result, gate: gateName, attestation_ref: attestationRef };
      } catch (error) {
        if (!committed) {
          try {
            await restoreSnapshot(gateSnapshot);
            await restoreSnapshot(indexSnapshot);
          } catch (restoreError) {
            throw rollbackError(error, restoreError);
          }
        }
        throw error;
      }
    },
    options,
  );
}

export async function transitionTerminalResult(runDir, terminalResult, options = {}) {
  const nextTerminalResult = normalizeTerminalResult(terminalResult);
  const result = await transitionLifecycleRun(
    runDir,
    (draft) => {
      const next = {
        ...cloneJson(nextTerminalResult),
        run_id: draft.run_id,
        status: nextTerminalResult.status,
      };
      draft.status = next.status;
      draft.terminal_result = next;
    },
    options,
  );
  return { ...result, terminal_result: result.run.terminal_result };
}

export async function transitionRunStep(runDir, stepSelector, updater, options = {}) {
  assertCollectionUpdater(updater, "transitionRunStep");
  let stepIndex = -1;

  const result = await transitionRunJson(
    runDir,
    async (draft) => {
      const hadSteps = Array.isArray(draft.steps);
      const steps = hadSteps ? draft.steps : [];
      const update = await applyCollectionItemUpdate({
        items: steps,
        selector: stepSelector,
        updater,
        selectorLabel: "step selector",
        seed: seedRunStep(stepSelector),
        identityKey: "agent",
      });
      stepIndex = update.index;
      if (!update.changed) return;
      if (!hadSteps) draft.steps = steps;
    },
    options,
  );

  return {
    ...result,
    step_index: stepIndex,
    step: stepIndex >= 0 ? result.run.steps?.[stepIndex] ?? null : null,
  };
}

export async function transitionRunSlice(runDir, sliceId, updater, options = {}) {
  assertCollectionUpdater(updater, "transitionRunSlice");
  let sliceIndex = -1;

  const result = await transitionRunJson(
    runDir,
    async (draft) => {
      const hadSlices = Array.isArray(draft.slices);
      const slices = hadSlices ? draft.slices : [];
      const update = await applyCollectionItemUpdate({
        items: slices,
        selector: sliceId,
        updater,
        selectorLabel: "slice selector",
        seed: seedRunSlice(sliceId),
        identityKey: "id",
      });
      sliceIndex = update.index;
      if (!update.changed) return;
      if (!hadSlices) draft.slices = slices;
    },
    options,
  );

  return {
    ...result,
    slice_index: sliceIndex,
    slice: sliceIndex >= 0 ? result.run.slices?.[sliceIndex] ?? null : null,
  };
}

export async function transitionLifecycleRun(runDir, mutator, options = {}) {
  return transitionRunJson(runDir, mutator, options);
}

export async function mutateRunJsonLocked(runDir, mutator, options = {}) {
  if (typeof mutator !== "function") throw new Error("mutateRunJsonLocked requires a mutator");
  if (existsSync(join(runDir, ATTESTATIONS_DIR, ATTESTATIONS_INDEX_FILE))) {
    return transitionRunJson(runDir, mutator, options);
  }

  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    await assertSemanticTransitionHeartbeatState(runDir, options);
    assertLegacyNoIndexCompatibleRun(current, "current");

    const draft = cloneJson(current);
    let nextValue = await mutator(draft, { current, runDir });
    if (nextValue === undefined) {
      if (sameJson(current, draft)) {
        return { updated: false, reason: "mutator-skip", status: current.status, run: current };
      }
      nextValue = draft;
    }

    const next = validateRun(nextValue);
    assertLegacyNoIndexCompatibleRun(next, "next");
    await writeJsonAtomically(join(runDir, RUN_FILE), next);
    return { updated: true, status: next.status, run: next };
  }, options);
}

export async function heartbeatOnce(runDir, { token, ownerPid, ownerCapability, now } = {}, options = {}) {
  if (!stringValue(token)) throw new Error("heartbeatOnce requires a token");
  const heartbeatOwnerPid = normalizeHeartbeatOwnerPid(ownerPid);
  const heartbeatAt = normalizeTimestamp(now);

  return withRunJsonLock(
    runDir,
    async () => {
      const current = await readRunJson(runDir);
      assertHeartbeatOwnerCapability(runDir, current.run_id, ownerCapability, "heartbeatOnce");
      if (TERMINAL_RUN_STATUSES.has(current.status)) {
        return { updated: false, reason: "terminal-status", status: current.status, run: current };
      }
      if (current.status !== "running") {
        return { updated: false, reason: "run-not-running", status: current.status, run: current };
      }

      const protectedGate = pendingProtectedGate(current);
      if (protectedGate) {
        return { updated: false, reason: "protected-gate-pending", gate: protectedGate, status: current.status, run: current };
      }
      if (!hasInFlightHeartbeatWork(current)) {
        return { updated: false, reason: "no-in-flight-work", status: current.status, run: current };
      }
      assertRunAuthorityValid(runDir, current, options);

      const lease = await inspectHeartbeatLease(runDir, current.run_id, {
        token,
        ownerPid: heartbeatOwnerPid,
        now: heartbeatAt,
      });
      if (!lease.active) {
        return { updated: false, reason: lease.reason, gate: lease.gate || null, status: current.status, run: current };
      }
      const next = validateRun({ ...current, heartbeat_at: heartbeatAt });
      await writeJsonAtomically(join(runDir, RUN_FILE), next);
      return { updated: true, status: next.status, heartbeat_at: heartbeatAt, run: next };
    },
    options,
  );
}

export function assertHeartbeatOwnerCapability(runDir, runId, ownerCapability, command = "heartbeat") {
  const file = join(runDir, FACTORY_LOCK_FILE);
  if (!existsSync(file)) throw new Error(`missing factory.lock for run '${runId}'`);

  let factoryLock;
  try {
    factoryLock = validateFactoryLock(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    throw new Error(`invalid factory.lock for run '${runId}': ${error.message}`);
  }

  if (factoryLock.run_id !== runId) throw new Error(`invalid factory.lock for run '${runId}': run id mismatch`);

  const capability = normalizeHeartbeatOwnerCapability(ownerCapability, command);
  if (factoryLock.heartbeat_owner !== capability) {
    throw new Error(`${command} requires trusted heartbeat owner capability from factory.lock`);
  }

  return factoryLock;
}

export function hasInFlightHeartbeatWork(run) {
  if (Array.isArray(run.steps) && run.steps.some((step) => HEARTBEAT_STEP_IN_FLIGHT_STATUSES.has(step?.status))) {
    return true;
  }
  if (Array.isArray(run.slices) && run.slices.some((slice) => HEARTBEAT_SLICE_IN_FLIGHT_STATUSES.has(slice?.status))) {
    return true;
  }
  return false;
}

async function transitionRunJsonLocked(runDir, mutator, options = {}, hooks = {}) {
  const current = await readRunJson(runDir);
  const authority = assertRunAuthorityValid(runDir, current, options);
  assertExpectedCurrentHash(current, options.expectedCurrentHash);
  await assertSemanticTransitionHeartbeatState(runDir, options);

  const draft = cloneJson(current);
  let nextValue = await mutator(draft, {
    authority,
    current,
    runDir,
  });

  if (nextValue === undefined) {
    if (sameJson(current, draft)) {
      return { updated: false, reason: "mutator-skip", status: current.status, run: current };
    }
    nextValue = draft;
  }

  const next = validateRun(nextValue);
  if (typeof hooks.beforeValidateNext === "function") {
    await hooks.beforeValidateNext({ authority, current, next, runDir });
  }
  assertRunAuthorityValid(runDir, next, options);
  if (typeof hooks.beforeCommit === "function") {
    await hooks.beforeCommit({ authority, current, next, runDir });
  }
  await writeJsonAtomically(join(runDir, RUN_FILE), next);
  if (typeof hooks.afterCommit === "function") {
    await hooks.afterCommit({ authority, current, next, runDir });
  }
  return { updated: true, status: next.status, run: next };
}

async function readRunJson(runDir) {
  const run = await readJson(join(runDir, RUN_FILE));
  return validateRun(run);
}

async function inspectHeartbeatLease(runDir, runId, { token, ownerPid, now } = {}) {
  const heartbeatPath = join(runDir, HEARTBEAT_FILE);
  if (!existsSync(heartbeatPath)) return { active: false, reason: "missing-heartbeat-lease" };

  let lease;
  try {
    lease = validateHeartbeatState(await readJson(heartbeatPath));
  } catch {
    return { active: false, reason: "invalid-heartbeat-lease" };
  }

  if (lease.run_id !== runId) return { active: false, reason: "heartbeat-run-id-mismatch" };
  if (lease.token !== token) return { active: false, reason: "heartbeat-token-mismatch" };
  if (lease.pid !== ownerPid) return { active: false, reason: "heartbeat-owner-mismatch" };

  const statusState = inspectHeartbeatLeaseStatus(lease.status, lease);
  if (!statusState.active) return statusState;

  const deadlineAt = lease.deadline_at;
  if (!stringValue(deadlineAt)) return { active: false, reason: "invalid-heartbeat-lease" };

  const deadlineMs = Date.parse(deadlineAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(deadlineMs) || Number.isNaN(nowMs)) return { active: false, reason: "invalid-heartbeat-lease" };
  if (nowMs >= deadlineMs) return { active: false, reason: "heartbeat-lease-expired" };

  return { active: true, lease };
}

function inspectHeartbeatLeaseStatus(status, lease) {
  if (stringValue(lease.stopped_at) || status === "stopped") {
    return { active: false, reason: "heartbeat-lease-stopped" };
  }
  if (stringValue(lease.stop_requested_at) || status === "stopping") {
    return { active: false, reason: "heartbeat-lease-stopping" };
  }
  if (stringValue(lease.stop_reason) && ACTIVE_HEARTBEAT_STATUSES.has(status)) {
    return { active: false, reason: "invalid-heartbeat-lease" };
  }
  if (TERMINAL_RUN_STATUSES.has(status)) {
    return { active: false, reason: "heartbeat-lease-terminal" };
  }
  if (status === "inactive") {
    return { active: false, reason: "heartbeat-lease-inactive" };
  }
  if (!ACTIVE_HEARTBEAT_STATUSES.has(status)) {
    return { active: false, reason: "invalid-heartbeat-lease" };
  }
  return { active: true };
}

async function assertSemanticTransitionHeartbeatState(runDir, options = {}) {
  if (options.allowActiveHeartbeat === true) return null;
  const heartbeatPath = join(runDir, HEARTBEAT_FILE);
  if (!existsSync(heartbeatPath)) return null;

  let lease;
  try {
    lease = validateHeartbeatState(await readJson(heartbeatPath));
  } catch (error) {
    throw new Error(`invalid heartbeat lease at ${heartbeatPath}: ${error.message}`);
  }

  if (lease.status === "stopped" || lease.status === "error") return lease;
  if (lease.status === "stopping") {
    throw new Error("foreground semantic run.json writes require a confirmed stopped heartbeat lease");
  }
  if (ACTIVE_HEARTBEAT_STATUSES.has(lease.status)) {
    throw new Error("stop heartbeat before foreground semantic run.json writes");
  }

  throw new Error(`invalid heartbeat lease at ${heartbeatPath}: unsupported status '${lease.status}'`);
}

function assertExpectedCurrentHash(run, expectedCurrentHash) {
  if (expectedCurrentHash === undefined || expectedCurrentHash === null) return;
  if (!stringValue(expectedCurrentHash)) throw new Error("expectedCurrentHash must be a non-empty string");
  const actualCurrentHash = hashRunState(run);
  if (actualCurrentHash !== expectedCurrentHash) {
    throw new Error(`stale run.json transition: expected current hash ${expectedCurrentHash}, found ${actualCurrentHash}`);
  }
}

function assertRunAuthorityValid(runDir, run, options = {}) {
  const authority = validateRunAuthority(runDir, run, options);
  return assertValidationChecksValid(authority, "run authority validation failed");
}

function assertProvenanceGraphValid(runDir, options = {}) {
  const graph = validateProvenanceAuthority(runDir, options);
  return assertValidationChecksValid(graph, "provenance authority validation failed");
}

function assertValidationChecksValid(result, fallbackMessage = "validation failed") {
  if (result?.ok) return result;
  const message = formatValidationChecks(result?.checks);
  throw new Error(message === "run validation failed" ? fallbackMessage : message);
}

function createApprovedGateDecisionState({ runDir, current, gateName, gate, records }) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("approved gate decisions require a non-empty accepted attestation index");
  }

  const ref = gateAttestationRef(gateName);
  const existingIndex = records.findIndex((record) => record.ref === ref);
  if (existingIndex !== -1 && existingIndex !== records.length - 1) {
    throw new Error(`approved gate '${gateName}' cannot update ${ref} after newer accepted attestations`);
  }

  const replacingLastRecord = existingIndex === records.length - 1;
  const previousRecord = replacingLastRecord ? records[records.length - 2] ?? null : records[records.length - 1] ?? null;
  const artifact = resolveArtifactRef(runDir, gate.artifact);
  const question = resolveGateRef(runDir, gate.question_ref);
  const answer = stringValue(gate.answer_ref) ? resolveGateRef(runDir, gate.answer_ref) : null;
  const attestation = createGateDecisionAttestation({
    run_id: current.run_id,
    sequence: replacingLastRecord ? records[existingIndex].attestation.sequence : (records.at(-1)?.attestation?.sequence ?? 0) + 1,
    prev_hash: previousRecord?.attestation?.attestation_hash ?? null,
    bindings: {
      gate: gateName,
      decision: gate.status,
      approval_source: gate.approval_source,
      question_ref: gate.question_ref,
      question_hash: hashFile(question.path),
      artifact_ref: gate.artifact,
      artifact_hash: hashFile(artifact.path),
      ...(answer
        ? {
            answer_ref: gate.answer_ref,
            answer_hash: hashFile(answer.path),
          }
        : {
            answer_text_hash: hashTextClaim(gate.answer),
          }),
    },
  });
  const nextRecords = replacingLastRecord
    ? [...records.slice(0, -1), { ref, attestation }]
    : [...records, { ref, attestation }];
  const index = createAttestationIndex(nextRecords);

  if (!Array.isArray(index.entries) || index.entries.length === 0) {
    throw new Error("approved gate decisions require a non-empty attestation index");
  }

  return { ref, attestation, index };
}

function acceptedAttestationEntries(authority) {
  return (authority.orderedRefs || [])
    .map((ref) => {
      const record = authority.acceptedAttestations?.[ref];
      if (!record?.attestation) return null;
      return {
        ref,
        attestation: cloneJson(record.attestation),
      };
    })
    .filter(Boolean);
}

function normalizeGateDecision(gateName, gate) {
  if (!isRecord(gate)) throw new Error(`transitionGateDecision requires a gate object for '${gateName}'`);
  return cloneJson(gate);
}

function assertApprovedGateDecisionShape(gateName, gate) {
  const missingFields = [];
  if (!stringValue(gate.artifact)) missingFields.push("artifact");
  if (!stringValue(gate.question_ref)) missingFields.push("question_ref");
  if (!stringValue(gate.approval_source)) missingFields.push("approval_source");
  if (!stringValue(gate.answer_ref) && !stringValue(gate.answer)) {
    missingFields.push("answer_ref or answer");
  }
  if (missingFields.length > 0) {
    throw new Error(`approved gate '${gateName}' requires ${missingFields.join(", ")}`);
  }
}

function gateAttestationRef(gateName) {
  assertSafeGateName(gateName);
  return join(ATTESTATIONS_DIR, ATTESTATIONS_GATES_DIR, `${gateName}.json`);
}

function assertSafeGateName(gateName) {
  if (!SAFE_GATE_NAME_PATTERN.test(gateName)) {
    throw new Error(`invalid gate name '${gateName}': must match safe pattern [a-z0-9][a-z0-9_-]*[a-z0-9]`);
  }
}

function assertLegacyNoIndexCompatibleRun(run, label) {
  const claims = collectProvenanceSensitiveClaims(run);
  if (claims.length === 0) return;
  throw new Error(
    `mutateRunJsonLocked compatibility mode requires no provenance-sensitive ${label} claims when attestations/index.json is absent: ${claims.join(", ")}`,
  );
}

function collectProvenanceSensitiveClaims(run) {
  const claims = [];
  if (!isRecord(run)) return claims;

  for (const [gateName, gate] of Object.entries(run.gates || {})) {
    if (isRecord(gate) && gate.status === "approved") claims.push(`gate:${gateName}`);
  }

  for (const [index, slice] of (Array.isArray(run.slices) ? run.slices : []).entries()) {
    if (sliceRequiresAuthority(slice)) claims.push(`slice:${slice?.id || index}`);
  }

  if (PASSING_VALIDATOR_VERDICTS.has(run.validator?.verdict)) claims.push("validator");
  if (PASSING_SECURITY_VERDICTS.has(run.security_review?.verdict)) claims.push("security_review");
  if (stringValue(run.pr_url)) claims.push("pr_url");
  if (stringValue(run.terminal_result?.pr_url)) claims.push("terminal_result.pr_url");
  if ([run.branch, run.worktree, run.base_ref, run.base_commit].some(stringValue)) claims.push("run_base");

  return claims;
}

function sliceRequiresAuthority(slice) {
  return isRecord(slice)
    && (SENSITIVE_SLICE_STATUSES.has(slice.status)
      || stringValue(slice.merge_commit)
      || (slice.status === "merged" && stringValue(slice.review_ref)));
}

function normalizeTerminalResult(terminalResult) {
  if (typeof terminalResult === "string") return { status: terminalResult };
  if (!isRecord(terminalResult)) throw new Error("transitionTerminalResult requires a terminal result object");
  return cloneJson(terminalResult);
}

function normalizeGateMap(gates) {
  return isRecord(gates) ? gates : {};
}

function assertCollectionUpdater(updater, label) {
  if (typeof updater === "function" || isRecord(updater)) return;
  throw new Error(`${label} requires an updater function or object`);
}

async function applyCollectionItemUpdate({ items, selector, updater, selectorLabel, seed, identityKey }) {
  const index = selectCollectionItemIndex(items, selector, selectorLabel, identityKey);
  const hasExisting = index >= 0;
  const original = hasExisting ? items[index] : undefined;
  const base = hasExisting ? cloneJson(original) : cloneJson(seed);
  let nextValue;

  if (typeof updater === "function") {
    nextValue = await updater(base, {
      current: hasExisting ? cloneJson(original) : null,
      index,
      selector,
    });
  } else {
    nextValue = updater;
  }

  if (nextValue === undefined) {
    if (hasExisting) {
      if (sameJson(original, base)) return { changed: false, index };
      items[index] = base;
      return { changed: true, index };
    }
    if (sameJson(seed, base)) return { changed: false, index: -1 };
    items.push(base);
    return { changed: true, index: items.length - 1 };
  }

  const replacement = isRecord(base) && isRecord(nextValue)
    ? { ...base, ...cloneJson(nextValue) }
    : cloneJson(nextValue);

  if (hasExisting) {
    if (sameJson(original, replacement)) return { changed: false, index };
    items[index] = replacement;
    return { changed: true, index };
  }
  if (sameJson(seed, replacement)) return { changed: false, index: -1 };
  items.push(replacement);
  return { changed: true, index: items.length - 1 };
}

function selectCollectionItemIndex(items, selector, selectorLabel, identityKey) {
  if (typeof selector === "function") return items.findIndex((item, index) => selector(item, index));
  if (Number.isInteger(selector)) {
    if (selector < 0) throw new Error(`${selectorLabel} index must be non-negative`);
    return selector < items.length ? selector : -1;
  }
  if (stringValue(selector)) return items.findIndex((item) => item?.[identityKey] === selector);
  if (isRecord(selector)) {
    if (Number.isInteger(selector.index)) {
      if (selector.index < 0) throw new Error(`${selectorLabel} index must be non-negative`);
      return selector.index < items.length ? selector.index : -1;
    }
    const entries = Object.entries(selector);
    if (entries.length === 0) return -1;
    return items.findIndex((item) => entries.every(([key, value]) => item?.[key] === value));
  }
  throw new Error(`invalid ${selectorLabel}`);
}

function seedRunStep(stepSelector) {
  if (stringValue(stepSelector)) return { agent: stepSelector };
  if (isRecord(stepSelector) && stringValue(stepSelector.agent)) return { agent: stepSelector.agent };
  return {};
}

function seedRunSlice(sliceSelector) {
  if (stringValue(sliceSelector)) return { id: sliceSelector };
  if (isRecord(sliceSelector) && stringValue(sliceSelector.id)) return { id: sliceSelector.id };
  return {};
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return await readJson(path);
  } catch {
    return null;
  }
}

async function snapshotFile(path) {
  if (!existsSync(path)) {
    return {
      exists: false,
      path,
      contents: null,
    };
  }

  return {
    exists: true,
    path,
    contents: await readFile(path, "utf8"),
  };
}

async function restoreSnapshot(snapshot) {
  if (!snapshot) return;
  if (snapshot.exists) {
    await writeTextAtomically(snapshot.path, snapshot.contents);
    return;
  }
  await rm(snapshot.path, { force: true });
}

async function writeJsonAtomically(path, value) {
  await writeTextAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomically(path, contents) {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(tempPath, contents, "utf8");
    await rename(tempPath, path);
  } finally {
    if (existsSync(tempPath)) await rm(tempPath, { force: true });
  }
}

function rollbackError(error, restoreError) {
  const primary = error instanceof Error ? error.message : String(error);
  const rollback = restoreError instanceof Error ? restoreError.message : String(restoreError);
  return new Error(`${primary}; failed to restore prior gate-decision state: ${rollback}`);
}

function formatLockTimeout(lockDir, owner) {
  if (!isRecord(owner)) return `timed out waiting for run.json lock at ${lockDir}`;
  const heldBy = [owner.hostname, owner.pid].filter((value) => value !== undefined && value !== null).join(":");
  const suffix = heldBy ? ` held by ${heldBy}` : "";
  const acquiredAt = stringValue(owner.acquired_at) ? ` since ${owner.acquired_at}` : "";
  return `timed out waiting for run.json lock at ${lockDir}${suffix}${acquiredAt}`;
}

function formatValidationChecks(checks) {
  const errors = (Array.isArray(checks) ? checks : []).flatMap((check) => Array.isArray(check?.errors) ? check.errors : []);
  if (errors.length === 0) return "run validation failed";
  return errors.map((error) => `${error.path}: ${error.message}`).join("; ");
}

function normalizeTimestamp(now) {
  if (now === undefined) return new Date().toISOString();
  const value = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(value)) throw new Error("invalid heartbeat timestamp");
  return new Date(value).toISOString();
}

function normalizePositiveInteger(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error("lock timing options must be positive integers");
  return value;
}

function normalizeHeartbeatOwnerPid(ownerPid) {
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) throw new Error("heartbeatOnce requires ownerPid");
  return ownerPid;
}

function normalizeHeartbeatOwnerCapability(ownerCapability, command) {
  if (!stringValue(ownerCapability)) throw new Error(`${command} requires trusted heartbeat owner capability from factory.lock`);
  return ownerCapability.trim();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hashTextClaim(value) {
  return `sha256:${createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
