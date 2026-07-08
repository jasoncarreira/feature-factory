import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { readFile, rename, rm, mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  canonicalizeGithubPrUrl,
  createAttestationIndex,
  createGateDecisionAttestation,
  createPrCreatedAttestation,
  hashFile,
  hashValue,
  resolveArtifactRef,
  resolveGateRef,
  validateGateDecisionAttestation,
  validatePrCreatedAttestation,
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
const ATTESTATIONS_INDEX_REF = `${ATTESTATIONS_DIR}/${ATTESTATIONS_INDEX_FILE}`;
const ATTESTATIONS_GATES_DIR = "gates";
const ATTESTATIONS_PR_CREATED_REF = `${ATTESTATIONS_DIR}/pr-created.json`;
const APPROVED_GATE_TRANSITION_HOOK = Symbol("approvedGateTransition");

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

  return withRunJsonLock(
    runDir,
    async () => {
      let stagedAttestationRef = null;
      let stagedSnapshots = [];
      let shouldStageAttestation = false;
      let forceTransition = false;
      let committed = false;

      try {
        const result = await transitionRunJsonLocked(
          runDir,
          (draft, { authority }) => {
            draft.gates = normalizeGateMap(draft.gates);
            const preparedGate = prepareGateDecisionTransition(runDir, gateName, draft.gates[gateName], nextGate);
            draft.gates[gateName] = preparedGate;

            const latestGateDecision = findAcceptedGateDecisionRecord(authority, gateName);
            shouldStageAttestation = shouldStageGateDecisionAttestation(latestGateDecision, preparedGate);
            forceTransition = shouldStageAttestation && preparedGate.status !== "approved";

            if (forceTransition) return draft;
          },
          options,
          {
            beforeValidateNext: async ({ current, next }) => {
              if (!shouldStageAttestation) return;

              const graph = assertProvenanceGraphValid(runDir, options);
              const records = acceptedAttestationEntries(graph);
              const staged = createGateDecisionState({
                runDir,
                current,
                gateName,
                gate: next.gates?.[gateName],
                records,
              });
              const gateAttestationPath = await resolveAttestationWritePath(runDir, staged.ref, { createParents: true });
              const indexPath = await resolveAttestationWritePath(runDir, ATTESTATIONS_INDEX_REF, { createParents: true });
              stagedSnapshots = [await snapshotFile(gateAttestationPath), await snapshotFile(indexPath)];
              stagedAttestationRef = staged.ref;

              const attestationValidation = validateGateDecisionAttestation(staged.attestation, { ...options, runDir });
              assertValidationChecksValid(attestationValidation, "gate-decision validation failed");

              await writeJsonAtomically(gateAttestationPath, staged.attestation);
              await writeJsonAtomically(indexPath, staged.index);
            },
            [APPROVED_GATE_TRANSITION_HOOK]: gateName,
          },
        );
        committed = true;
        return { ...result, gate: gateName, attestation_ref: stagedAttestationRef };
      } catch (error) {
        if (!committed && stagedSnapshots.length > 0) {
          try {
            for (const snapshot of stagedSnapshots) await restoreSnapshot(snapshot);
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

export async function transitionPrCreated(runDir, input, options = {}) {
  const request = normalizePrCreatedInput(input);

  return withRunJsonLock(
    runDir,
    async () => {
      let stagedSnapshots = [];
      let stagedAttestationRef = null;
      let committed = false;

      try {
        const result = await transitionRunJsonLocked(
          runDir,
          (draft, { authority }) => {
            const existingPrCreated = findAcceptedPrCreatedRecord(authority);
            if (existingPrCreated) {
              assertExistingPrCreatedRequestCompatible(runDir, existingPrCreated, request);
            }
            draft.pr_url = request.pr_url;
            draft.status = "completed";
            draft.terminal_result = normalizePrCreatedTerminalResult(draft, request);
          },
          options,
          {
            beforeValidateNext: async ({ current, next }) => {
              const graph = assertProvenanceGraphValid(runDir, options);
              const staged = createPrCreatedState({
                runDir,
                current,
                next,
                records: acceptedAttestationEntries(graph),
                request,
              });
              const attestationPath = await resolveAttestationWritePath(runDir, staged.ref, { createParents: true });
              const indexPath = await resolveAttestationWritePath(runDir, ATTESTATIONS_INDEX_REF, { createParents: true });
              if (staged.existing) {
                stagedAttestationRef = staged.ref;
                return;
              }
              stagedSnapshots = [await snapshotFile(attestationPath), await snapshotFile(indexPath)];
              stagedAttestationRef = staged.ref;

              const attestationValidation = validatePrCreatedAttestation(staged.attestation, {
                ...options,
                runDir,
                acceptedAttestations: acceptedAttestationMap(staged.records),
              });
              assertValidationChecksValid(attestationValidation, "pr-created validation failed");

              await writeJsonAtomically(attestationPath, staged.attestation);
              await writeJsonAtomically(indexPath, staged.index);
            },
          },
        );
        committed = true;
        return { ...result, attestation_ref: stagedAttestationRef, pr_url: result.run.pr_url, terminal_result: result.run.terminal_result };
      } catch (error) {
        if (!committed && stagedSnapshots.length > 0) {
          try {
            for (const snapshot of stagedSnapshots) await restoreSnapshot(snapshot);
          } catch (restoreError) {
            throw rollbackError(error, restoreError, "pr-created");
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
  const nextAuthority = assertRunAuthorityValid(runDir, next, options);
  assertGateDecisionTransitions(current, next, nextAuthority, hooks);
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

function createGateDecisionState({ runDir, current, gateName, gate, records }) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("gate decisions require a non-empty accepted attestation index");
  }

  assertFinalGateDecisionShape(gateName, gate);

  const latestGateRecord = findAcceptedGateDecisionEntry(records, gateName);
  const previousRecord = records.at(-1) ?? null;
  const sequence = (previousRecord?.attestation?.sequence ?? 0) + 1;
  const ref = latestGateRecord ? gateAttestationHistoryRef(gateName, sequence) : gateAttestationRef(gateName);
  const bindings = createGateDecisionBindings({
    runDir,
    currentGate: current.gates?.[gateName],
    gateName,
    gate,
  });
  const attestation = createGateDecisionAttestation({
    run_id: current.run_id,
    sequence,
    prev_hash: previousRecord?.attestation?.attestation_hash ?? null,
    bindings,
  });
  const nextRecords = [...records, { ref, attestation }];
  const index = createAttestationIndex(nextRecords);

  if (!Array.isArray(index.entries) || index.entries.length === 0) {
    throw new Error("gate decisions require a non-empty attestation index");
  }

  return { ref, attestation, index, records: nextRecords };
}

function createPrCreatedState({ runDir, current, next, records, request }) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("pr-created requires a non-empty accepted attestation index");
  }

  const runBaseRecord = findLastAcceptedAttestationEntry(records, (record) => record.attestation?.type === "run-base");
  const mergeChainRecord = findLastAcceptedAttestationEntry(records, (record) => record.attestation?.type === "merge-chain");
  const prePrGateRecord = findLastAcceptedAttestationEntry(
    records,
    (record) => record.attestation?.type === "gate-decision"
      && record.attestation?.bindings?.gate === "pre_pr"
      && record.attestation?.bindings?.decision === "approved",
  );
  const missing = [];
  if (!runBaseRecord) missing.push("run-base");
  if (!mergeChainRecord) missing.push("merge-chain");
  if (!prePrGateRecord) missing.push("approved pre_pr gate-decision");
  if (missing.length > 0) throw new Error(`pr-created requires current accepted ${missing.join(", ")}`);

  const latestPrCreated = findLastAcceptedAttestationEntry(records, (record) => record.attestation?.type === "pr-created");
  if (latestPrCreated) {
    assertExistingPrCreatedRequestCompatible(runDir, latestPrCreated, request);
    return {
      ref: latestPrCreated.ref,
      attestation: latestPrCreated.attestation,
      index: createAttestationIndex(records),
      records,
      existing: true,
    };
  }

  const runBase = runBaseRecord.attestation.bindings;
  const mergeChain = mergeChainRecord.attestation.bindings;
  const prBody = resolveArtifactRef(runDir, request.pr_body_ref);
  const previousRecord = records.at(-1) ?? null;
  const sequence = (previousRecord?.attestation?.sequence ?? 0) + 1;
  const ref = ATTESTATIONS_PR_CREATED_REF;
  const remoteObservation = request.remote_observation;
  const bindings = {
    pr_url: remoteObservation.pr_url,
    pr_number: remoteObservation.pr_number,
    provider: remoteObservation.provider,
    repository: remoteObservation.repository,
    remote: remoteObservation.remote,
    github_account: remoteObservation.github_account,
    head_branch: runBase.feature_branch,
    head_commit: mergeChain.head_commit,
    head_tree: mergeChain.head_tree,
    base_ref: runBase.base_ref,
    base_commit: runBase.base_commit,
    base_tree: runBase.base_tree,
    draft: remoteObservation.draft,
    pr_body_ref: request.pr_body_ref,
    pr_body_hash: hashFile(prBody.path, { mode: "raw" }),
    run_base_attestation_ref: runBaseRecord.ref,
    run_base_attestation_hash: runBaseRecord.attestation.attestation_hash,
    merge_chain_attestation_ref: mergeChainRecord.ref,
    merge_chain_attestation_hash: mergeChainRecord.attestation.attestation_hash,
    pre_pr_gate_attestation_ref: prePrGateRecord.ref,
    pre_pr_gate_attestation_hash: prePrGateRecord.attestation.attestation_hash,
    remote_observation: remoteObservation,
  };

  if (next.pr_url !== bindings.pr_url) throw new Error("run.pr_url must match pr-created binding");
  if (next.terminal_result?.pr_url !== bindings.pr_url) throw new Error("run.terminal_result.pr_url must match pr-created binding");

  const attestation = createPrCreatedAttestation({
    run_id: current.run_id,
    sequence,
    prev_hash: previousRecord?.attestation?.attestation_hash ?? null,
    bindings,
  });
  const nextRecords = [...records, { ref, attestation }];
  const index = createAttestationIndex(nextRecords);

  if (!Array.isArray(index.entries) || index.entries.length === 0) {
    throw new Error("pr-created requires a non-empty attestation index");
  }

  return { ref, attestation, index, records: nextRecords };
}

function createGateDecisionBindings({ runDir, currentGate, gateName, gate }) {
  if (gate?.status !== "pending") assertPendingGateMaterialFresh(runDir, gateName, currentGate, gate);
  const artifactRef = gate.artifact;
  const questionRef = gate.question_ref;
  const approvalSource = gate.approval_source;

  const missingFields = [];
  if (!stringValue(artifactRef)) missingFields.push("artifact");
  if (!stringValue(questionRef)) missingFields.push("question_ref");
  if (!stringValue(approvalSource)) missingFields.push("approval_source");
  if (missingFields.length > 0) {
    throw new Error(`gate decision '${gateName}' requires ${missingFields.join(", ")}`);
  }

  const artifact = resolveArtifactRef(runDir, artifactRef);
  const question = resolveGateRef(runDir, questionRef);
  const answerBindings = createGateDecisionAnswerBindings({ runDir, gateName, gate });

  return {
    gate: gateName,
    decision: gate.status,
    approval_source: approvalSource,
    question_ref: questionRef,
    question_hash: hashFile(question.path, { mode: "raw" }),
    artifact_ref: artifactRef,
    artifact_hash: hashFile(artifact.path, { mode: "raw" }),
    ...answerBindings,
  };
}

function createGateDecisionAnswerBindings({ runDir, gateName, gate }) {
  if (stringValue(gate?.answer_ref)) {
    const answer = resolveGateRef(runDir, gate.answer_ref);
    return {
      answer_ref: gate.answer_ref,
      answer_hash: hashFile(answer.path, { mode: "raw" }),
    };
  }

  if (stringValue(gate?.answer)) {
    return { answer_text_hash: hashTextClaim(gate.answer) };
  }

  throw new Error(`gate decision '${gateName}' requires answer_ref or answer`);
}

function shouldStageGateDecisionAttestation(latestGateDecision, gate) {
  if (gate?.status && gate.status !== "pending") return true;
  return latestGateDecision?.attestation?.bindings?.decision === "approved";
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

function acceptedAttestationMap(records) {
  return Object.fromEntries((records || []).map((record) => [record.ref, {
    ref: record.ref,
    attestation: record.attestation,
    attestation_hash: record.attestation?.attestation_hash,
  }]));
}

function assertGateDecisionTransitions(current, next, authority, hooks = {}) {
  const errors = [];
  const authorizedGate = stringValue(hooks[APPROVED_GATE_TRANSITION_HOOK]) ? hooks[APPROVED_GATE_TRANSITION_HOOK] : null;
  const currentGates = isRecord(current.gates) ? current.gates : {};
  const nextGates = isRecord(next.gates) ? next.gates : {};

  for (const [gateName, currentGate] of Object.entries(currentGates)) {
    if (!isRecord(currentGate) || currentGate.status !== "approved") continue;

    const nextGate = nextGates[gateName];
    if (nextGate?.status === "approved") continue;

    if (gateName !== authorizedGate) {
      errors.push({
        path: `run.gates.${gateName}.status`,
        message: "approved gate transitions must use transitionGateDecision",
      });
      continue;
    }

    const record = findAcceptedGateDecisionRecord(authority, gateName);
    if (record?.attestation?.bindings?.decision !== nextGate?.status) {
      errors.push({
        path: `run.gates.${gateName}.status`,
        message: "approved gate transitions must use transitionGateDecision",
      });
    }
  }

  for (const [gateName, gate] of Object.entries(nextGates)) {
    if (!isRecord(gate) || gate.status !== "approved") continue;

    const currentGate = currentGates[gateName];
    if (currentGate?.status !== "approved" && gateName !== authorizedGate) {
      errors.push({
        path: `run.gates.${gateName}.status`,
        message: "approved gate transitions must use transitionGateDecision",
      });
    }

    const record = findAcceptedGateDecisionRecord(authority, gateName);
    if (!record) continue;
    pushApprovedGateBindingErrors(errors, gateName, gate, record.attestation.bindings || {});
  }

  if (errors.length > 0) throw new Error(formatErrorItems(errors));
}

function findAcceptedGateDecisionRecord(authority, gateName) {
  return findAcceptedGateDecisionEntry(acceptedAttestationEntries(authority), gateName);
}

function findAcceptedPrCreatedRecord(authority) {
  return findLastAcceptedAttestationEntry(acceptedAttestationEntries(authority), (record) => record.attestation?.type === "pr-created");
}

function findAcceptedGateDecisionEntry(records, gateName) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.attestation?.type !== "gate-decision") continue;
    if (record.attestation?.bindings?.gate !== gateName) continue;
    return record;
  }
  return null;
}

function assertExistingPrCreatedRequestCompatible(runDir, record, request) {
  const bindings = record?.attestation?.bindings;
  if (!isRecord(bindings)) throw new Error("accepted pr-created attestation is missing bindings");
  const prBody = resolveArtifactRef(runDir, request.pr_body_ref);
  const requestedBodyHash = hashFile(prBody.path, { mode: "raw" });
  const remoteObservation = request.remote_observation;
  const mismatches = [];
  const comparisons = [
    ["pr_url", request.pr_url, bindings.pr_url],
    ["pr_number", request.pr_number, bindings.pr_number],
    ["provider", request.provider, bindings.provider],
    ["repository", request.repository, bindings.repository],
    ["remote", request.remote, bindings.remote],
    ["github_account", request.github_account, bindings.github_account],
    ["draft", request.draft, bindings.draft],
    ["pr_body_ref", request.pr_body_ref, bindings.pr_body_ref],
    ["pr_body_hash", requestedBodyHash, bindings.pr_body_hash],
    ["remote_observation", hashValue(remoteObservation), hashValue(bindings.remote_observation)],
  ];
  for (const [field, actual, expected] of comparisons) {
    if (actual !== expected) mismatches.push(field);
  }
  if (mismatches.length > 0) {
    throw new Error(`accepted pr-created attestation already exists with different ${mismatches.join(", ")}`);
  }
}

function findLastAcceptedAttestationEntry(records, predicate) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (predicate(records[index])) return records[index];
  }
  return null;
}

function prepareGateDecisionTransition(runDir, gateName, currentGate, gate) {
  const nextGate = cloneJson(gate);
  if (nextGate.status === "pending") {
    return preparePendingGateDecision(runDir, gateName, nextGate);
  }
  assertPendingGateMaterialFresh(runDir, gateName, currentGate, nextGate);
  return {
    ...nextGate,
    pending_snapshot: cloneJson(currentGate.pending_snapshot),
  };
}

function preparePendingGateDecision(runDir, gateName, gate) {
  const missingFields = [];
  if (!stringValue(gate.artifact)) missingFields.push("artifact");
  if (!stringValue(gate.question_ref)) missingFields.push("question_ref");
  if (missingFields.length > 0) {
    throw new Error(`pending gate '${gateName}' requires ${missingFields.join(", ")}`);
  }

  const snapshot = createPendingGateSnapshot(runDir, gateName, gate.artifact, gate.question_ref, gate.pending_snapshot?.created_at);
  if (gate.pending_snapshot !== undefined && gate.pending_snapshot !== null) {
    assertPendingSnapshotMatches(gateName, gate.pending_snapshot, snapshot, "supplied pending snapshot");
  }
  return {
    ...gate,
    pending_snapshot: snapshot,
  };
}

function assertPendingGateMaterialFresh(runDir, gateName, currentGate, gate) {
  if (!isRecord(currentGate) || currentGate.status !== "pending") {
    throw new Error(`gate decision '${gateName}' requires current gate status pending`);
  }
  if (!isRecord(currentGate.pending_snapshot)) {
    throw new Error(`gate decision '${gateName}' requires current pending material snapshot`);
  }
  if (!stringValue(gate?.artifact)) throw new Error(`gate decision '${gateName}' requires artifact`);
  if (!stringValue(gate?.question_ref)) throw new Error(`gate decision '${gateName}' requires question_ref`);
  const freshSnapshot = createPendingGateSnapshot(
    runDir,
    gateName,
    currentGate.pending_snapshot.artifact_ref,
    currentGate.pending_snapshot.question_ref,
    currentGate.pending_snapshot.created_at,
  );
  assertPendingSnapshotMatches(gateName, currentGate.pending_snapshot, freshSnapshot, "current pending snapshot");
  if (gate.artifact !== currentGate.pending_snapshot.artifact_ref) {
    throw new Error(`gate decision '${gateName}' artifact must match pending artifact '${currentGate.pending_snapshot.artifact_ref}'`);
  }
  if (gate.question_ref !== currentGate.pending_snapshot.question_ref) {
    throw new Error(`gate decision '${gateName}' question_ref must match pending question_ref '${currentGate.pending_snapshot.question_ref}'`);
  }
}

function createPendingGateSnapshot(runDir, gateName, artifactRef, questionRef, createdAt) {
  const artifact = resolveArtifactRef(runDir, artifactRef);
  const question = resolveGateRef(runDir, questionRef);
  return {
    question_ref: questionRef,
    question_hash: hashFile(question.path, { mode: "raw" }),
    artifact_ref: artifactRef,
    artifact_hash: hashFile(artifact.path, { mode: "raw" }),
    created_at: stringValue(createdAt) ? createdAt : new Date().toISOString(),
  };
}

function assertPendingSnapshotMatches(gateName, actual, expected, label) {
  const checks = [
    ["question_ref", actual?.question_ref, expected.question_ref],
    ["question_hash", actual?.question_hash, expected.question_hash],
    ["artifact_ref", actual?.artifact_ref, expected.artifact_ref],
    ["artifact_hash", actual?.artifact_hash, expected.artifact_hash],
  ];
  for (const [field, actualValue, expectedValue] of checks) {
    if (actualValue !== expectedValue) {
      throw new Error(`gate '${gateName}' ${label} ${field} is stale or mismatched`);
    }
  }
  if (!stringValue(actual?.created_at)) throw new Error(`gate '${gateName}' ${label} created_at is missing`);
}

function pushApprovedGateBindingErrors(errors, gateName, gate, bindings) {
  pushRequiredStringMatch(
    errors,
    gate?.artifact,
    bindings.artifact_ref,
    `run.gates.${gateName}.artifact`,
    "accepted gate artifact ref",
  );
  pushRequiredStringMatch(
    errors,
    gate?.question_ref,
    bindings.question_ref,
    `run.gates.${gateName}.question_ref`,
    "accepted gate question ref",
  );
  pushRequiredStringMatch(
    errors,
    gate?.approval_source,
    bindings.approval_source,
    `run.gates.${gateName}.approval_source`,
    "accepted gate approval source",
  );

  if (stringValue(bindings.answer_ref)) {
    pushRequiredStringMatch(
      errors,
      gate?.answer_ref,
      bindings.answer_ref,
      `run.gates.${gateName}.answer_ref`,
      "accepted gate answer ref",
    );
    return;
  }

  if (!stringValue(bindings.answer_text_hash)) {
    errors.push({
      path: `run.gates.${gateName}.answer`,
      message: "accepted gate decision is missing an answer binding",
    });
    return;
  }

  if (!stringValue(gate?.answer)) {
    errors.push({
      path: `run.gates.${gateName}.answer`,
      message: `must carry accepted answer hash '${bindings.answer_text_hash}'`,
    });
    return;
  }

  if (hashTextClaim(gate.answer) !== bindings.answer_text_hash) {
    errors.push({
      path: `run.gates.${gateName}.answer`,
      message: `must match accepted answer hash '${bindings.answer_text_hash}'`,
    });
  }
}

function pushRequiredStringMatch(errors, actual, expected, path, label) {
  if (!stringValue(actual)) {
    errors.push({ path, message: `${label} is missing` });
    return;
  }
  if (!stringValue(expected)) {
    errors.push({ path, message: `${label} is missing` });
    return;
  }
  if (actual !== expected) errors.push({ path, message: `must match ${label} '${expected}'` });
}

function normalizeGateDecision(gateName, gate) {
  if (!isRecord(gate)) throw new Error(`transitionGateDecision requires a gate object for '${gateName}'`);
  return cloneJson(gate);
}

function assertFinalGateDecisionShape(gateName, gate) {
  if (gate?.status === "pending") return;
  assertApprovedGateDecisionShape(gateName, gate);
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
  return `${ATTESTATIONS_DIR}/${ATTESTATIONS_GATES_DIR}/${gateName}.json`;
}

function gateAttestationHistoryRef(gateName, sequence) {
  assertSafeGateName(gateName);
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error(`invalid gate attestation sequence for '${gateName}'`);
  return `${ATTESTATIONS_DIR}/${ATTESTATIONS_GATES_DIR}/${gateName}/${sequence}.json`;
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

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (stringValue(value)) return value;
  }
  return null;
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
  if (stringValue(run.pr_url) || stringValue(run.terminal_result?.pr_url)) claims.push("pr_url");
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

function normalizePrCreatedInput(input) {
  if (!isRecord(input)) throw new Error("transitionPrCreated requires an input object");
  const remoteObservation = normalizePrRemoteObservation(input.remote_observation);
  const prUrl = canonicalizeGithubPrUrl(firstNonEmptyString(input.pr_url, remoteObservation.pr_url));
  const prNumber = normalizePrNumber(input.pr_number ?? remoteObservation.pr_number);
  const draft = normalizeBoolean(input.draft ?? remoteObservation.draft, "draft");
  const prBodyRef = firstNonEmptyString(input.pr_body_ref, input.prBodyRef);

  assertOptionalRemoteObservationMatch(input, remoteObservation, "pr_url");
  assertOptionalRemoteObservationMatch(input, remoteObservation, "pr_number");
  assertOptionalRemoteObservationMatch(input, remoteObservation, "provider");
  assertOptionalRemoteObservationMatch(input, remoteObservation, "repository");
  assertOptionalRemoteObservationMatch(input, remoteObservation, "remote");
  assertOptionalRemoteObservationMatch(input, remoteObservation, "github_account");
  assertOptionalRemoteObservationMatch(input, remoteObservation, "draft");

  if (!stringValue(prUrl)) throw new Error("transitionPrCreated requires pr_url");
  if (!stringValue(prBodyRef)) throw new Error("transitionPrCreated requires pr_body_ref");

  return {
    ...cloneJson(input),
    pr_url: prUrl,
    pr_number: prNumber,
    draft,
    pr_body_ref: prBodyRef,
    provider: firstNonEmptyString(input.provider, remoteObservation.provider),
    repository: firstNonEmptyString(input.repository, remoteObservation.repository),
    remote: firstNonEmptyString(input.remote, remoteObservation.remote),
    github_account: firstNonEmptyString(input.github_account, remoteObservation.github_account),
    remote_observation: remoteObservation,
  };
}

function assertOptionalRemoteObservationMatch(input, remoteObservation, key) {
  if (input[key] === undefined || input[key] === null) return;
  const actual = key === "pr_number"
    ? normalizePrNumber(input[key])
    : key === "pr_url"
      ? canonicalizeGithubPrUrl(input[key])
      : input[key];
  if (actual !== remoteObservation[key]) {
    throw new Error(`transitionPrCreated ${key} must match remote_observation.${key}`);
  }
}

function normalizePrRemoteObservation(observation) {
  if (!isRecord(observation)) throw new Error("transitionPrCreated requires remote_observation");
  const source = cloneJson(observation);
  const normalized = {
    pr_url: canonicalizeGithubPrUrl(source.pr_url),
    pr_number: normalizePrNumber(source.pr_number),
    provider: source.provider,
    repository: source.repository,
    remote: source.remote,
    github_account: source.github_account,
    head_branch: source.head_branch,
    head_commit: source.head_commit,
    head_tree: source.head_tree,
    base_ref: source.base_ref,
    base_commit: source.base_commit,
    base_tree: source.base_tree,
    draft: normalizeBoolean(source.draft, "remote_observation.draft"),
  };
  const missing = Object.entries(normalized)
    .filter(([key, value]) => key !== "pr_number" && key !== "draft" && !stringValue(value))
    .map(([key]) => key);
  if (missing.length > 0) throw new Error(`transitionPrCreated requires remote observation ${missing.join(", ")}`);
  return normalized;
}

function normalizePrCreatedTerminalResult(run, request) {
  const terminalResult = isRecord(request.terminal_result) ? cloneJson(request.terminal_result) : {};
  return {
    ...terminalResult,
    status: "completed",
    run_id: run.run_id,
    pr_url: request.pr_url,
    reason: terminalResult.reason ?? null,
    summary: terminalResult.summary ?? "Draft PR created.",
    artifacts: isRecord(terminalResult.artifacts) ? terminalResult.artifacts : {},
  };
}

function normalizePrNumber(value) {
  const number = typeof value === "string" && value.trim() !== "" ? Number.parseInt(value, 10) : value;
  if (!Number.isInteger(number) || number < 1) throw new Error("transitionPrCreated requires pr_number");
  return number;
}

function normalizeBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`transitionPrCreated requires boolean ${label}`);
  return value;
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

async function resolveAttestationWritePath(runDir, ref, { createParents = false } = {}) {
  const { attestationRootRealPath } = resolveAttestationRoot(runDir);
  const segments = normalizeAttestationRefSegments(ref);
  let currentPath = attestationRootRealPath;

  for (const segment of segments.slice(1, -1)) {
    const nextPath = join(currentPath, segment);
    if (!existsSync(nextPath)) {
      if (createParents) await mkdir(nextPath);
      currentPath = createParents ? readRealPath(nextPath, `${ref} parent`) : nextPath;
      assertContainedAttestationPath(ref, attestationRootRealPath, currentPath, "parent");
      continue;
    }

    const stats = lstatSync(nextPath);
    if (stats.isSymbolicLink()) throw new Error(`${ref} must not traverse symlinked attestation parents`);
    if (!stats.isDirectory()) throw new Error(`${ref} parent must be a directory: ${nextPath}`);
    currentPath = readRealPath(nextPath, `${ref} parent`);
    assertContainedAttestationPath(ref, attestationRootRealPath, currentPath, "parent");
  }

  const candidatePath = resolve(join(currentPath, segments.at(-1)));
  assertContainedAttestationPath(ref, attestationRootRealPath, candidatePath, "target");
  if (!existsSync(candidatePath)) return candidatePath;

  const stats = lstatSync(candidatePath);
  if (stats.isSymbolicLink()) throw new Error(`${ref} must not be a symlink`);
  if (stats.isDirectory()) throw new Error(`${ref} must be a file path`);
  const realPath = readRealPath(candidatePath, ref);
  assertContainedAttestationPath(ref, attestationRootRealPath, realPath, "target");
  return realPath;
}

function resolveAttestationRoot(runDir) {
  const runPath = resolve(requireNonEmptyString(runDir, "runDir"));
  const runRealPath = readRealPath(runPath, "runDir");
  const attestationRootPath = join(runPath, ATTESTATIONS_DIR);
  if (!existsSync(attestationRootPath)) {
    throw new Error(`attestations root is missing: ${attestationRootPath}`);
  }

  const stats = lstatSync(attestationRootPath);
  if (stats.isSymbolicLink()) throw new Error(`attestations root must not be a symlink: ${attestationRootPath}`);
  if (!stats.isDirectory()) throw new Error(`attestations root must be a directory: ${attestationRootPath}`);

  const attestationRootRealPath = readRealPath(attestationRootPath, "attestations root");
  if (!isContainedPath(runRealPath, attestationRootRealPath)) {
    throw new Error(`attestations root must be physically contained under ${runRealPath}`);
  }

  return { runRealPath, attestationRootRealPath };
}

function normalizeAttestationRefSegments(ref) {
  const normalizedRef = requireNonEmptyString(ref, "attestation ref");
  if (normalizedRef.includes("\\")) throw new Error(`${normalizedRef} must use forward slashes`);
  const segments = normalizedRef.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${normalizedRef} must not contain empty, '.' or '..' segments`);
  }
  if (segments[0] !== ATTESTATIONS_DIR) throw new Error(`${normalizedRef} must be rooted under ${ATTESTATIONS_DIR}/`);
  return segments;
}

function assertContainedAttestationPath(ref, attestationRootRealPath, candidatePath, label) {
  if (isContainedPath(attestationRootRealPath, candidatePath)) return;
  throw new Error(`${ref} ${label} must remain physically contained under ${attestationRootRealPath}`);
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

function rollbackError(error, restoreError, label = "gate-decision") {
  const primary = error instanceof Error ? error.message : String(error);
  const rollback = restoreError instanceof Error ? restoreError.message : String(restoreError);
  return new Error(`${primary}; failed to restore prior ${label} state: ${rollback}`);
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
  return formatErrorItems(errors);
}

function formatErrorItems(errors) {
  return errors.map((error) => `${error.path}: ${error.message}`).join("; ");
}

function readRealPath(pathValue, label) {
  try {
    return realpathSync.native(pathValue);
  } catch (error) {
    const reason = classifyRealPathFailure(error);
    throw new Error(`${label} is ${reason}: ${pathValue}`);
  }
}

function classifyRealPathFailure(error) {
  if (error?.code === "ENOENT") return "missing";
  if (error?.code === "EACCES" || error?.code === "EPERM") return "inaccessible";
  return "unresolvable";
}

function isContainedPath(parentPath, childPath) {
  const rel = relative(parentPath, childPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function requireNonEmptyString(value, label) {
  if (!stringValue(value)) throw new Error(`${label} must be a non-empty string`);
  return value;
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
