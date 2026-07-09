import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, rename, rm, mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { git } from "./git.js";
import { canonicalizeGithubPrUrl, githubPrUrlParts, hashFile, hashValue, resolveArtifactRef, resolveEvidenceRef, resolveGateRef, resolveReviewRef, resolveSteeringRef } from "./refs.js";
import { pendingProtectedGate, validateHeartbeatState, validateRun } from "./validate.js";
import { requireNonEmptyString, timestamp } from "./utils.js";

export const TERMINAL_RUN_STATUSES = new Set(["completed", "blocked", "partial", "needs-human"]);

const HEARTBEAT_STEP_IN_FLIGHT_STATUSES = new Set(["running"]);
const HEARTBEAT_SLICE_IN_FLIGHT_STATUSES = new Set(["running", "review"]);
const SAFE_GATE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const PASSING_VALIDATOR_VERDICTS = new Set(["GO", "GO-WITH-NITS"]);
const PASSING_SECURITY_VERDICTS = new Set(["PASS"]);
const GATE_DECISION_STATUSES = new Set(["approved", "changes_requested", "stopped"]);
const DEFAULT_LOCK_TIMEOUT_MS = 1000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const DEFAULT_STALE_LOCK_MS = 60000;
const DEFAULT_MISSING_OWNER_STEAL_MS = 5000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
const MIN_STALE_HEARTBEAT_MS = 120000;
const LOCK_DIR = "run-json.lock";
const LOCK_OWNER_FILE = "owner.json";
const RUN_FILE = "run.json";
const HEARTBEAT_FILE = "heartbeat.json";

export async function withRunJsonLock(runDir, fn, options = {}) {
  if (typeof fn !== "function") throw new Error("withRunJsonLock requires a callback");
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const retryDelayMs = normalizePositiveInteger(options.retryDelayMs, DEFAULT_LOCK_RETRY_DELAY_MS);
  const staleLockMs = normalizePositiveInteger(options.staleLockMs, DEFAULT_STALE_LOCK_MS);
  const lockDir = join(runDir, LOCK_DIR);
  const ownerPath = join(lockDir, LOCK_OWNER_FILE);
  const deadline = Date.now() + timeoutMs;
  let stolenFrom = null;
  let stealAttempted = false;

  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        const owner = await readJsonIfExists(ownerPath);
        if (!stealAttempted && canStealRunJsonLock(owner, staleLockMs, lockDir, options)) {
          await rm(lockDir, { recursive: true, force: true });
          stolenFrom = owner || { missing_owner: true };
          stealAttempted = true;
          continue;
        }
        throw new Error(formatLockTimeout(lockDir, owner));
      }
      await delay(Math.min(retryDelayMs, Math.max(1, deadline - Date.now())));
    }
  }

  const owner = { pid: process.pid, hostname: hostname(), acquired_at: new Date().toISOString() };
  if (stolenFrom) owner.stolen_from = sanitizeLockOwner(stolenFrom);

  try {
    await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
    return await fn({ lock_dir: lockDir, owner });
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function canStealRunJsonLock(owner, staleLockMs, lockDir, options = {}) {
  if (!isRecord(owner)) return missingOwnerLockIsOldEnough(lockDir, options);
  if (!isProcessAlive(owner.pid, options)) return true;
  const acquiredMs = Date.parse(owner.acquired_at || "");
  return Number.isFinite(acquiredMs) && Date.now() - acquiredMs > staleLockMs;
}

function missingOwnerLockIsOldEnough(lockDir, options = {}) {
  const threshold = normalizePositiveInteger(options.missingOwnerStealMs, DEFAULT_MISSING_OWNER_STEAL_MS);
  try {
    return Date.now() - statSync(lockDir).mtimeMs > threshold;
  } catch {
    return false;
  }
}

function sanitizeLockOwner(owner) {
  if (!isRecord(owner)) return owner;
  return Object.fromEntries(Object.entries(owner).filter(([key]) => key !== "stolen_from"));
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
  const nextGate = normalizeGateDecision(gateName, gate, options);
  const answerArchives = [];
  const result = await withRunJsonLock(runDir, async () => {
    return transitionRunJsonLocked(
      runDir,
      (draft) => {
        draft.gates = normalizeGateMap(draft.gates);
        draft.gates[gateName] = prepareGateDecisionTransition(runDir, gateName, draft.gates[gateName], nextGate, (archive) => answerArchives.push(archive));
      },
      options,
      { authorizedGate: gateName, beforeWrite: async () => {
        for (const archive of answerArchives) await archiveConsumedGateAnswer(archive);
      } },
    );
  }, options);
  return { ...result, gate: gateName };
}

export async function transitionSteeringQueued(runDir, message, options = {}) {
  const text = requireNonEmptyString(message, "steering message");
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    if (TERMINAL_RUN_STATUSES.has(current.status)) throw new Error(`terminal run '${current.status}' cannot be steered`);
    if (current.status !== "running") throw new Error(`steer requires a running run, found '${current.status}'`);
    if (isRecord(current.steering?.pending)) throw new Error("run already has pending steering");

    const createdAt = timestamp(options.now);
    const id = safeSteeringId(options.id || randomUUID());
    const ref = `steering/pending-${safeTimestamp(createdAt)}-${id}.json`;
    const resolved = resolveSteeringRef(runDir, ref, { mustExist: false });
    await mkdir(dirname(resolved.path), { recursive: true });
    if (existsSync(resolved.path)) throw new Error(`steering ref already exists: ${ref}`);
    const steeringFile = {
      schema_version: 1,
      kind: "operator-steering",
      run_id: current.run_id,
      id,
      message: text,
      message_chars: text.length,
      created_at: createdAt,
      source: "factory steer",
    };
    await writeJsonAtomically(resolved.path, steeringFile);
    const fileHash = hashFile(resolved.path, { mode: "raw" });
    const metadata = { id, ref, hash: fileHash, message_chars: text.length, created_at: createdAt };
    const history = Array.isArray(current.steering?.history) ? cloneJson(current.steering.history) : [];
    history.push({ event: "queued", ...metadata });
    const next = validateRun({
      ...cloneJson(current),
      updated_at: createdAt,
      steering: {
        schema_version: 1,
        pending: metadata,
        history,
      },
    });
    await writeJsonAtomically(join(runDir, RUN_FILE), next);
    return { updated: true, status: next.status, run: next, steering: metadata };
  }, options);
}

export async function transitionSteeringConsumed(runDir, input, options = {}) {
  const requestedRef = requireNonEmptyString(input?.ref, "steering ref");
  const requestedHash = requireNonEmptyString(input?.hash, "steering hash");
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    if (TERMINAL_RUN_STATUSES.has(current.status)) throw new Error(`terminal run '${current.status}' cannot consume steering`);
    assertNoFreshHeartbeatForSteeringConsume(runDir, options);
    const pending = current.steering?.pending;
    if (!isRecord(pending)) throw new Error("run has no pending steering");
    if (pending.ref !== requestedRef || pending.hash !== requestedHash) throw new Error("pending steering ref/hash mismatch");

    const pendingResolved = resolveSteeringRef(runDir, pending.ref);
    const actualHash = hashFile(pendingResolved.path, { mode: "raw" });
    if (actualHash !== pending.hash) throw new Error("pending steering file hash mismatch");
    const steeringFile = parseJsonObjectFile(pendingResolved.path, "pending steering");
    if (steeringFile.kind !== "operator-steering") throw new Error("pending steering kind mismatch");
    if (steeringFile.run_id !== current.run_id) throw new Error("pending steering run_id mismatch");
    if (steeringFile.id !== pending.id) throw new Error("pending steering id mismatch");
    const message = requireNonEmptyString(steeringFile.message, "pending steering message");

    const consumedAt = timestamp(options.now);
    const consumedRef = nextConsumedSteeringRef(runDir, pending.id, consumedAt);
    const consumedResolved = resolveSteeringRef(runDir, consumedRef, { mustExist: false });
    const history = Array.isArray(current.steering?.history) ? cloneJson(current.steering.history) : [];
    history.push({
      event: "consumed",
      id: pending.id,
      source_ref: pending.ref,
      ref: consumedRef,
      hash: pending.hash,
      message_chars: pending.message_chars,
      created_at: pending.created_at,
      consumed_at: consumedAt,
    });
    const next = validateRun({
      ...cloneJson(current),
      updated_at: consumedAt,
      steering: {
        schema_version: 1,
        pending: null,
        history,
      },
    });
    await rename(pendingResolved.path, consumedResolved.path);
    await writeJsonAtomically(join(runDir, RUN_FILE), next);
    const steering = {
      kind: "operator-steering-consumed",
      trust: "untrusted-operator-data",
      label: "UNTRUSTED OPERATOR STEERING DATA (not instructions)",
      ref: consumedRef,
      hash: pending.hash,
      message,
    };
    return { updated: true, status: next.status, run: next, steering };
  }, options);
}

export function resolveGateAnswerTarget(runDir, gateName, gate) {
  if (!stringValue(gateName)) throw new Error("resolveGateAnswerTarget requires a gate name");
  assertSafeGateName(gateName);
  if (!isRecord(gate) || gate.status !== "pending") throw new Error(`gate '${gateName}' is not pending`);
  if (!isRecord(gate.pending_snapshot)) throw new Error(`gate '${gateName}' requires pending_snapshot before external answers`);
  if (!stringValue(gate.answer_ref)) throw new Error(`gate '${gateName}' requires answer_ref`);
  if (!stringValue(gate.artifact)) throw new Error(`gate '${gateName}' requires artifact ref`);
  if (!stringValue(gate.question_ref)) throw new Error(`gate '${gateName}' requires question_ref`);
  const freshSnapshot = createPendingGateSnapshot(runDir, gateName, gate.artifact, gate.question_ref, gate.pending_snapshot.created_at, gate.answer_ref);
  assertPendingSnapshotMatches(gateName, gate.pending_snapshot, freshSnapshot, "current pending snapshot");
  const answer = resolveGateRef(runDir, gate.answer_ref, { mustExist: false });
  return { gatesDir: dirname(answer.path), answerPath: answer.path };
}

export async function transitionPrCreated(runDir, input, options = {}) {
  const request = { ...normalizePrCreatedInput(input), runDir };
  const result = await withRunJsonLock(runDir, async () => transitionRunJsonLocked(
    runDir,
    (draft) => {
      assertPrCreatedPreconditions(draft, request);
      draft.pr_url = request.pr_url;
      draft.status = "completed";
      draft.terminal_result = normalizePrCreatedTerminalResult(draft, request);
    },
    options,
    { prCreated: true },
  ), options);
  return { ...result, pr_url: result.run.pr_url, terminal_result: result.run.terminal_result };
}

export async function transitionTerminalResult(runDir, terminalResult, options = {}) {
  const nextTerminalResult = normalizeTerminalResult(terminalResult);
  const result = await transitionLifecycleRun(runDir, (draft) => {
    const next = { ...cloneJson(nextTerminalResult), run_id: draft.run_id, status: nextTerminalResult.status };
    draft.status = next.status;
    draft.terminal_result = next;
  }, options);
  return { ...result, terminal_result: result.run.terminal_result };
}

export async function transitionRecoverOrphan(runDir, reason = "orphaned factory run", options = {}) {
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    if (current.status !== "running") throw new Error(`recover requires a running run, found '${current.status}'`);
    const recoverable = inspectRecoverableHeartbeat(runDir, options);
    if (!recoverable.ok) throw new Error(`recover requires terminal, missing, stale, or dead heartbeat: ${recoverable.reason}`);

    const now = timestamp(options.now);
    await stopHeartbeatForRecovery(runDir, recoverable.heartbeat, now);
    const next = validateRun({
      ...current,
      status: "needs-human",
      updated_at: now,
      terminal_result: {
        status: "needs-human",
        run_id: current.run_id,
        pr_url: current.pr_url || null,
        reason: stringValue(reason) ? String(reason) : "orphaned factory run",
        summary: "Run was recovered from an orphaned or stale heartbeat and requires human inspection before resuming.",
        artifacts: {},
      },
    });

    await writeJsonAtomically(join(runDir, RUN_FILE), next);
    return { updated: true, status: next.status, run: next, recovery: recoverable };
  }, options);
}

export async function transitionRunStep(runDir, stepSelector, updater, options = {}) {
  assertCollectionUpdater(updater, "transitionRunStep");
  let stepIndex = -1;
  const result = await transitionRunJson(runDir, async (draft) => {
    const hadSteps = Array.isArray(draft.steps);
    const steps = hadSteps ? draft.steps : [];
    if (options.mustExist && !collectionHasItem(steps, stepSelector, "agent")) throw new Error(`step '${formatSelector(stepSelector)}' not found`);
    const update = await applyCollectionItemUpdate({ items: steps, selector: stepSelector, updater, selectorLabel: "step selector", seed: seedRunStep(stepSelector), identityKey: "agent" });
    stepIndex = update.index;
    if (!update.changed) return;
    if (!hadSteps) draft.steps = steps;
  }, options);
  return { ...result, step_index: stepIndex, step: stepIndex >= 0 ? result.run.steps?.[stepIndex] ?? null : null };
}

export async function transitionRunSlice(runDir, sliceId, updater, options = {}) {
  assertCollectionUpdater(updater, "transitionRunSlice");
  let sliceIndex = -1;
  const result = await transitionRunJson(runDir, async (draft) => {
    const hadSlices = Array.isArray(draft.slices);
    const slices = hadSlices ? draft.slices : [];
    if (options.mustExist && !collectionHasItem(slices, sliceId, "id")) throw new Error(`slice '${formatSelector(sliceId)}' not found`);
    const update = await applyCollectionItemUpdate({ items: slices, selector: sliceId, updater, selectorLabel: "slice selector", seed: seedRunSlice(sliceId), identityKey: "id" });
    sliceIndex = update.index;
    if (!update.changed) return;
    if (!hadSlices) draft.slices = slices;
    if (sliceIndex >= 0) assertSliceReviewPreconditions(runDir, slices[sliceIndex].id || sliceId, slices[sliceIndex]);
  }, options);
  return { ...result, slice_index: sliceIndex, slice: sliceIndex >= 0 ? result.run.slices?.[sliceIndex] ?? null : null };
}

export async function transitionSliceMerged(runDir, sliceId, input = {}, options = {}) {
  if (!stringValue(sliceId)) throw new Error("transitionSliceMerged requires a slice id");
  const request = normalizeSliceMergedInput(input);
  let sliceIndex = -1;
  const result = await transitionRunJson(runDir, (draft) => {
    const slices = Array.isArray(draft.slices) ? draft.slices : [];
    sliceIndex = slices.findIndex((slice) => slice?.id === sliceId);
    if (sliceIndex < 0) throw new Error(`slice '${sliceId}' not found`);
    const currentSlice = slices[sliceIndex];
    if (currentSlice.status === "merged") throw new Error(`slice '${sliceId}' is already merged`);
    const updatedAt = timestamp(options.now);
    const nextSlice = { ...currentSlice, merge_commit: request.merge_commit };
    assertSliceMergedPreconditions(runDir, sliceId, nextSlice, options);
    slices[sliceIndex] = {
      ...nextSlice,
      status: "merged",
      merge_commit: request.merge_commit,
      updated_at: updatedAt,
    };
    draft.slices = slices;
    draft.updated_at = updatedAt;
  }, options);
  return { ...result, slice_index: sliceIndex, slice: sliceIndex >= 0 ? result.run.slices?.[sliceIndex] ?? null : null };
}

export async function transitionLifecycleRun(runDir, mutator, options = {}) {
  return transitionRunJson(runDir, mutator, options);
}

export async function mutateRunJsonLocked(runDir, mutator, options = {}) {
  if (typeof mutator !== "function") throw new Error("mutateRunJsonLocked requires a mutator");
  return transitionRunJson(runDir, mutator, options);
}

export async function heartbeatOnce(runDir, { now } = {}, options = {}) {
  const heartbeatAt = timestamp(now);

  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    if (TERMINAL_RUN_STATUSES.has(current.status)) return { updated: false, reason: "terminal-status", status: current.status, run: current };
    if (current.status !== "running") return { updated: false, reason: "run-not-running", status: current.status, run: current };
    const protectedGate = pendingProtectedGate(current);
    if (protectedGate) return { updated: false, reason: "protected-gate-pending", gate: protectedGate, status: current.status, run: current };
    if (!hasInFlightHeartbeatWork(current)) return { updated: false, reason: "no-in-flight-work", status: current.status, run: current };

    const next = validateRun({ ...current, heartbeat_at: heartbeatAt });
    await writeJsonAtomically(join(runDir, RUN_FILE), next);
    return { updated: true, status: next.status, heartbeat_at: heartbeatAt, run: next };
  }, options);
}

export function hasInFlightHeartbeatWork(run) {
  if (Array.isArray(run.steps) && run.steps.some((step) => HEARTBEAT_STEP_IN_FLIGHT_STATUSES.has(step?.status))) return true;
  if (Array.isArray(run.slices) && run.slices.some((slice) => HEARTBEAT_SLICE_IN_FLIGHT_STATUSES.has(slice?.status))) return true;
  return false;
}

async function transitionRunJsonLocked(runDir, mutator, options = {}, hooks = {}) {
  const current = await readRunJson(runDir);
  assertExpectedCurrentHash(current, options.expectedCurrentHash);

  const draft = cloneJson(current);
  let nextValue = await mutator(draft, { current, runDir });
  if (nextValue === undefined) {
    if (sameJson(current, draft)) return { updated: false, reason: "mutator-skip", status: current.status, run: current };
    nextValue = draft;
  }

  const next = validateRun(nextValue);
  assertGateDecisionTransitions(current, next, hooks);
  assertTerminalTransition(current, next, hooks);
  if (typeof hooks.beforeWrite === "function") await hooks.beforeWrite(next, current);
  await writeJsonAtomically(join(runDir, RUN_FILE), next);
  return { updated: true, status: next.status, run: next };
}

async function readRunJson(runDir) {
  return validateRun(await readJson(join(runDir, RUN_FILE)));
}

function inspectRecoverableHeartbeat(runDir, options = {}) {
  const heartbeatPath = join(runDir, HEARTBEAT_FILE);
  if (!existsSync(heartbeatPath)) return { ok: true, reason: "missing-heartbeat", heartbeat: null };
  let heartbeat;
  try {
    heartbeat = validateHeartbeatState(JSON.parse(readFileSync(heartbeatPath, "utf8")));
  } catch (error) {
    return { ok: true, reason: `invalid-heartbeat:${error.message}`, heartbeat: null };
  }
  const liveness = inspectHeartbeatLiveness(heartbeat, options);
  if (!liveness.fresh) return { ok: true, reason: liveness.reason, heartbeat };
  return { ok: false, reason: "fresh-heartbeat", heartbeat };
}

function assertNoFreshHeartbeatForSteeringConsume(runDir, options = {}) {
  const heartbeatPath = join(runDir, HEARTBEAT_FILE);
  if (!existsSync(heartbeatPath)) return;
  let heartbeat;
  try {
    heartbeat = validateHeartbeatState(JSON.parse(readFileSync(heartbeatPath, "utf8")));
  } catch (error) {
    throw new Error(`steer-consume requires resumable run: invalid-run-state (${error.message})`);
  }
  if (inspectHeartbeatLiveness(heartbeat, options).fresh) {
    throw new Error("steer-consume requires resumable run: active-heartbeat");
  }
}

async function stopHeartbeatForRecovery(runDir, heartbeat, now) {
  if (!heartbeat) return;
  const next = validateHeartbeatState({
    ...heartbeat,
    pid: null,
    last_tick_at: now,
  });
  await writeJsonAtomically(join(runDir, HEARTBEAT_FILE), next);
}

function inspectHeartbeatLiveness(heartbeat, options = {}) {
  const nowMs = Date.parse(timestamp(options.now));
  const lastTickMs = Date.parse(heartbeat.last_tick_at || "");
  const intervalMs = Number.isInteger(heartbeat.interval_ms) && heartbeat.interval_ms > 0 ? heartbeat.interval_ms : DEFAULT_HEARTBEAT_INTERVAL_MS;
  const staleMs = Math.max(2 * intervalMs, MIN_STALE_HEARTBEAT_MS);
  const processAlive = isProcessAlive(heartbeat.pid, options);
  if (!processAlive) return { fresh: false, reason: "dead-heartbeat-process" };
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastTickMs)) return { fresh: false, reason: "invalid-heartbeat-time" };
  if (nowMs - lastTickMs > staleMs) return { fresh: false, reason: "stale-heartbeat" };
  return { fresh: true, reason: "fresh-heartbeat" };
}

function isProcessAlive(pid, options = {}) {
  if (typeof options.processAliveFn === "function") return Boolean(options.processAliveFn(pid));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return false;
  }
}

function assertExpectedCurrentHash(run, expectedCurrentHash) {
  if (expectedCurrentHash === undefined || expectedCurrentHash === null) return;
  if (!stringValue(expectedCurrentHash)) throw new Error("expectedCurrentHash must be a non-empty string");
  const actualCurrentHash = hashValue(run);
  if (actualCurrentHash !== expectedCurrentHash) throw new Error(`stale run.json transition: expected current hash ${expectedCurrentHash}, found ${actualCurrentHash}`);
}

function prepareGateDecisionTransition(runDir, gateName, currentGate, gate, onAnswerArchive) {
  const nextGate = cloneJson(gate);
  if (nextGate.status === "pending") return preparePendingGateDecision(runDir, gateName, nextGate);
  const decision = assertPendingGateMaterialFresh(runDir, gateName, currentGate, nextGate);
  if (decision.archive) {
    onAnswerArchive?.(decision.archive);
    nextGate.answer_ref = decision.archive.toRef;
  }
  return { ...nextGate, answer: decision.answer, pending_snapshot: cloneJson(currentGate.pending_snapshot) };
}

function preparePendingGateDecision(runDir, gateName, gate) {
  const missingFields = [];
  if (!stringValue(gate.artifact)) missingFields.push("artifact");
  if (!stringValue(gate.question_ref)) missingFields.push("question_ref");
  if (missingFields.length > 0) throw new Error(`pending gate '${gateName}' requires ${missingFields.join(", ")}`);
  assertNoPendingAnswerFile(runDir, gateName, gate.answer_ref);
  const snapshot = createPendingGateSnapshot(runDir, gateName, gate.artifact, gate.question_ref, gate.pending_snapshot?.created_at, gate.answer_ref);
  if (gate.pending_snapshot !== undefined && gate.pending_snapshot !== null) assertPendingSnapshotMatches(gateName, gate.pending_snapshot, snapshot, "supplied pending snapshot");
  return { ...gate, pending_snapshot: snapshot };
}

function assertPendingGateMaterialFresh(runDir, gateName, currentGate, gate) {
  if (!isRecord(currentGate) || currentGate.status !== "pending") throw new Error(`gate decision '${gateName}' requires current gate status pending`);
  if (!isRecord(currentGate.pending_snapshot)) throw new Error(`gate decision '${gateName}' requires current pending material snapshot`);
  if (!stringValue(gate?.artifact)) throw new Error(`gate decision '${gateName}' requires artifact`);
  if (!stringValue(gate?.question_ref)) throw new Error(`gate decision '${gateName}' requires question_ref`);
  const freshSnapshot = createPendingGateSnapshot(runDir, gateName, currentGate.pending_snapshot.artifact_ref, currentGate.pending_snapshot.question_ref, currentGate.pending_snapshot.created_at, currentGate.pending_snapshot.answer_ref);
  assertPendingSnapshotMatches(gateName, currentGate.pending_snapshot, freshSnapshot, "current pending snapshot");
  if (gate.artifact !== currentGate.pending_snapshot.artifact_ref) throw new Error(`gate decision '${gateName}' artifact must match pending artifact '${currentGate.pending_snapshot.artifact_ref}'`);
  if (gate.question_ref !== currentGate.pending_snapshot.question_ref) throw new Error(`gate decision '${gateName}' question_ref must match pending question_ref '${currentGate.pending_snapshot.question_ref}'`);
  if (stringValue(gate.answer_ref) && stringValue(currentGate.pending_snapshot.answer_ref) && gate.answer_ref !== currentGate.pending_snapshot.answer_ref) {
    throw new Error(`gate decision '${gateName}' answer_ref must match pending answer_ref '${currentGate.pending_snapshot.answer_ref}'`);
  }
  const decision = readGateDecisionAnswer(runDir, gateName, gate);
  assertGateAnswerMatchesStatus(gateName, gate.status, decision.answer);
  return decision;
}

function assertNoPendingAnswerFile(runDir, gateName, answerRef) {
  if (!stringValue(answerRef)) return;
  const answer = resolveGateRef(runDir, answerRef, { mustExist: false });
  if (existsSync(answer.path)) throw new Error(`pending gate '${gateName}' answer_ref already exists; archive or delete it before re-pending`);
}

function createPendingGateSnapshot(runDir, gateName, artifactRef, questionRef, createdAt, answerRef) {
  const artifact = resolveArtifactRef(runDir, artifactRef);
  const question = resolveGateRef(runDir, questionRef);
  const snapshot = {
    question_ref: questionRef,
    question_hash: hashFile(question.path, { mode: "raw" }),
    artifact_ref: artifactRef,
    artifact_hash: hashFile(artifact.path, { mode: "raw" }),
    created_at: stringValue(createdAt) ? createdAt : new Date().toISOString(),
  };
  if (stringValue(answerRef)) {
    const answer = resolveGateRef(runDir, answerRef, { mustExist: false });
    if (answer.path === question.path) throw new Error(`gate '${gateName}' answer_ref must not overlap question_ref`);
    snapshot.answer_ref = answerRef;
    if (existsSync(answer.path)) snapshot.answer_hash = hashFile(answer.path, { mode: "raw" });
  }
  return snapshot;
}

function assertPendingSnapshotMatches(gateName, actual, expected, label) {
  for (const [field, actualValue, expectedValue] of [
    ["question_ref", actual?.question_ref, expected.question_ref],
    ["question_hash", actual?.question_hash, expected.question_hash],
    ["artifact_ref", actual?.artifact_ref, expected.artifact_ref],
    ["artifact_hash", actual?.artifact_hash, expected.artifact_hash],
  ]) {
    if (actualValue !== expectedValue) throw new Error(`gate '${gateName}' ${label} ${field} is stale or mismatched`);
  }
  if (stringValue(expected.answer_ref) && actual?.answer_ref !== expected.answer_ref) throw new Error(`gate '${gateName}' ${label} answer_ref is stale or mismatched`);
  if (!stringValue(expected.answer_ref) && stringValue(actual?.answer_ref)) throw new Error(`gate '${gateName}' ${label} answer_ref is unexpected`);
  if (stringValue(actual?.answer_hash) && actual.answer_hash !== expected.answer_hash) throw new Error(`gate '${gateName}' ${label} answer_hash is stale or mismatched`);
  if (!stringValue(actual?.created_at)) throw new Error(`gate '${gateName}' ${label} created_at is missing`);
}

function readGateDecisionAnswer(runDir, gateName, gate) {
  if (stringValue(gate.answer)) return { answer: normalizeGateAnswer(gateName, String(gate.answer).trim()), archive: null };
  const answerRef = requireNonEmptyString(gate.answer_ref, "answer_ref");
  const answer = readGateDecisionAnswerRef(runDir, gateName, answerRef);
  return {
    answer: normalizeGateAnswer(gateName, answer.text),
    archive: nextConsumedGateAnswer(runDir, answerRef, answer.path),
  };
}

function readGateDecisionAnswerRef(runDir, gateName, answerRef) {
  if (!stringValue(answerRef)) throw new Error(`gate decision '${gateName}' requires answer_ref or answer`);
  const resolved = resolveGateRef(runDir, answerRef);
  return { text: readFileSync(resolved.path, "utf8").trim(), path: resolved.path };
}

function nextConsumedGateAnswer(runDir, answerRef, answerPath) {
  for (let index = 1; index < 1000; index += 1) {
    const toRef = `${answerRef}.consumed-${index}`;
    const to = resolveGateRef(runDir, toRef, { mustExist: false });
    if (!existsSync(to.path)) return { fromPath: answerPath, toPath: to.path, toRef };
  }
  throw new Error(`unable to allocate consumed answer ref for ${answerRef}`);
}

function nextConsumedSteeringRef(runDir, id, consumedAt) {
  const safeId = safeSteeringId(id);
  const base = `steering/consumed-${safeTimestamp(consumedAt)}-${safeId}`;
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `-${index}`;
    const ref = `${base}${suffix}.json`;
    const resolved = resolveSteeringRef(runDir, ref, { mustExist: false });
    if (!existsSync(resolved.path)) return ref;
  }
  throw new Error(`unable to allocate consumed steering ref for ${safeId}`);
}

function safeSteeringId(value) {
  const text = requireNonEmptyString(value, "steering id").trim();
  return text.replace(/[^A-Za-z0-9_-]/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "").slice(0, 80) || "steering";
}

function safeTimestamp(value) {
  return requireNonEmptyString(value, "timestamp").replace(/[^0-9A-Za-z]/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "");
}

async function archiveConsumedGateAnswer(archive) {
  await rename(archive.fromPath, archive.toPath);
}

function normalizeGateAnswer(gateName, answer) {
  const text = String(answer || "").trim();
  if (text === "approve" || text === "stop") return text;
  if (text.startsWith("changes:") && text.slice("changes:".length).trim().length > 0) return text;
  throw new Error(`gate decision '${gateName}' answer must be exactly approve, stop, or start with changes:`);
}

function assertGateAnswerMatchesStatus(gateName, status, answer) {
  if (status === "approved" && answer !== "approve") throw new Error(`gate decision '${gateName}' approved status requires approve answer`);
  if (status === "changes_requested" && !answer.startsWith("changes:")) throw new Error(`gate decision '${gateName}' changes_requested status requires changes: answer`);
  if (status === "stopped" && answer !== "stop") throw new Error(`gate decision '${gateName}' stopped status requires stop answer`);
}

function normalizeGateDecision(gateName, gate, options = {}) {
  if (!isRecord(gate)) throw new Error(`transitionGateDecision requires a gate object for '${gateName}'`);
  const next = cloneJson(gate);
  if (!stringValue(next.status)) throw new Error(`gate decision '${gateName}' requires status`);
  if (next.status !== "pending") {
    if (!stringValue(next.answer_ref) && !stringValue(next.answer)) throw new Error(`gate decision '${gateName}' requires answer_ref or answer`);
    next.approval_source ||= defaultApprovalSource(next, options);
    next.answered_at ||= timestamp(options.now);
  }
  return next;
}

function defaultApprovalSource(gate, options) {
  if (stringValue(options.approvalSource)) return options.approvalSource;
  if (stringValue(gate.answer_ref)) return "external-driver";
  if (stringValue(gate.answer)) return "human";
  return "human";
}

function assertGateDecisionTransitions(current, next, hooks = {}) {
  const authorizedGate = stringValue(hooks.authorizedGate) ? hooks.authorizedGate : null;
  const currentGates = isRecord(current.gates) ? current.gates : {};
  const nextGates = isRecord(next.gates) ? next.gates : {};
  const errors = [];
  for (const [gateName, gate] of Object.entries(nextGates)) {
    if (!isRecord(gate)) continue;
    const currentGate = currentGates[gateName];
    if (currentGate?.status === "pending" && GATE_DECISION_STATUSES.has(gate.status) && gateName !== authorizedGate) {
      errors.push({ path: `run.gates.${gateName}.status`, message: "pending gate decisions must use transitionGateDecision" });
    }
    if (gate.status === "approved" && currentGate?.status !== "approved" && gateName !== authorizedGate) {
      errors.push({ path: `run.gates.${gateName}.status`, message: "approved gate transitions must use transitionGateDecision" });
    }
  }
  for (const [gateName, gate] of Object.entries(currentGates)) {
    if (!isRecord(gate)) continue;
    const nextGate = nextGates[gateName];
    if (gate.status === "pending" && nextGate?.status !== "pending" && gateName !== authorizedGate) {
      errors.push({ path: `run.gates.${gateName}.status`, message: "pending gate decisions must use transitionGateDecision" });
    }
    if (gate.status !== "approved") continue;
    if (nextGate?.status !== "approved" && gateName !== authorizedGate) {
      errors.push({ path: `run.gates.${gateName}.status`, message: "approved gate transitions must use transitionGateDecision" });
    }
  }
  if (errors.length > 0) throw new Error(formatErrorItems(errors));
}

function assertTerminalTransition(current, next, hooks = {}) {
  if (TERMINAL_RUN_STATUSES.has(current.status)) throw new Error(`terminal run '${current.status}' cannot be mutated`);
  if (current.status === next.status) return;
  if (next.status !== "completed") return;
  if (hooks.prCreated === true) return;
  throw new Error("completed terminal transitions must use transitionPrCreated");
}

function assertPrCreatedPreconditions(run, request) {
  if (stringValue(run.pr_url)) throw new Error("pr-created requires run.pr_url to be unset");
  if (run.continuation?.kind === "blocked-run-continuation" && request.draft === false) throw new Error("pr-created requires draft PR for blocked-run-continuation runs");
  if (run.gates?.pre_pr?.status !== "approved") throw new Error("pr-created requires approved pre_pr gate");
  if (!PASSING_VALIDATOR_VERDICTS.has(run.validator?.verdict)) throw new Error("pr-created requires validator verdict GO or GO-WITH-NITS");
  if (!PASSING_SECURITY_VERDICTS.has(run.security_review?.verdict)) throw new Error("pr-created requires security_review verdict PASS");
  assertPrCreatedSliceState(run);
  assertPassingVerdictArtifacts(request.runDir, run);
  assertPrNumberMatchesUrl(request.pr_url, request.pr_number);
}

function assertPrCreatedSliceState(run) {
  const slices = Array.isArray(run.slices) ? run.slices : [];
  const unfinished = slices.filter((slice) => slice?.status !== "merged" && slice?.status !== "blocked").map((slice) => slice?.id || "<unknown>");
  if (unfinished.length > 0) throw new Error(`pr-created requires all slices to be merged or blocked; unfinished slices: ${unfinished.join(", ")}`);
  if (!slices.some((slice) => slice?.status === "merged")) throw new Error("pr-created requires at least one merged slice");
}

function assertPassingVerdictArtifacts(runDir, run) {
  if (!stringValue(runDir)) throw new Error("pr-created requires run directory context");
  if (!stringValue(run.validator?.report)) throw new Error("pr-created requires validator report ref");
  resolveArtifactRef(runDir, run.validator.report);
  const validatorReviewRef = stringValue(run.validator.review_ref) ? run.validator.review_ref : "reviews/implementation-validator.json";
  const validatorReview = resolveReviewRef(runDir, validatorReviewRef);
  const validatorJson = parseJsonObjectFile(validatorReview.path, "validator review_ref");
  if (!PASSING_VALIDATOR_VERDICTS.has(validatorJson.verdict)) throw new Error("pr-created requires validator review verdict GO or GO-WITH-NITS");
  if (validatorJson.verdict !== run.validator.verdict) throw new Error("pr-created requires validator review verdict to match run.validator.verdict");
  if (!stringValue(run.security_review?.review_ref)) throw new Error("pr-created requires security_review review_ref");
  const securityReview = resolveReviewRef(runDir, run.security_review.review_ref);
  const securityJson = parseJsonObjectFile(securityReview.path, "security_review.review_ref");
  if (securityJson.verdict !== "PASS") throw new Error("pr-created requires security_review review verdict PASS");
  if (securityJson.verdict !== run.security_review.verdict) throw new Error("pr-created requires security review verdict to match run.security_review.verdict");
}

function assertPrNumberMatchesUrl(prUrl, prNumber) {
  if (githubPrUrlParts(prUrl).number !== prNumber) throw new Error("pr-created requires pr_number to match the GitHub PR URL");
}

function normalizePrCreatedInput(input) {
  if (!isRecord(input)) throw new Error("transitionPrCreated requires an input object");
  const prUrl = canonicalizeGithubPrUrl(firstNonEmptyString(input.pr_url, input.prUrl));
  const repository = requireNonEmptyString(input.repository, "repository");
  const parts = githubPrUrlParts(prUrl);
  if (repository !== parts.repository) throw new Error("pr-created requires repository to match the GitHub PR URL");
  return {
    ...cloneJson(input),
    pr_url: prUrl,
    pr_number: normalizePrNumber(input.pr_number ?? input.prNumber),
    repository,
    draft: input.draft === undefined ? true : normalizeBoolean(input.draft, "draft"),
  };
}

function normalizeSliceMergedInput(input) {
  if (!isRecord(input)) throw new Error("transitionSliceMerged requires an input object");
  return { merge_commit: requireNonEmptyString(input.merge_commit ?? input.mergeCommit, "merge_commit") };
}

function assertSliceMergedPreconditions(runDir, sliceId, slice, options = {}) {
  if (!stringValue(slice.merge_commit)) throw new Error(`slice '${sliceId}' merge requires merge_commit`);
  const review = resolveReviewRef(runDir, requireNonEmptyString(slice.review_ref, "review_ref"));
  const reviewJson = parseJsonObjectFile(review.path, `slice '${sliceId}' review_ref`);
  if (reviewJson.verdict !== "APPROVE") throw new Error(`slice '${sliceId}' merge requires APPROVE review`);
  if (reviewJson.subject !== sliceId) throw new Error(`slice '${sliceId}' review subject must match slice id`);
  resolveEvidenceRef(runDir, requireNonEmptyString(slice.evidence_ref, "evidence_ref"));
  const branch = requireNonEmptyString(slice.branch, "branch");
  const branchResult = git(options.repoRoot || runDir, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (!branchResult.ok) throw new Error(`slice '${sliceId}' merge requires existing branch '${branch}'`);
}

function assertSliceReviewPreconditions(runDir, sliceId, slice) {
  if (slice.status !== "review") return;
  const evidence = resolveEvidenceRef(runDir, requireNonEmptyString(slice.evidence_ref, "evidence_ref"));
  const evidenceJson = parseJsonObjectFile(evidence.path, `slice '${sliceId}' evidence_ref`);
  if (stringValue(evidenceJson.subject) && evidenceJson.subject !== sliceId) throw new Error(`slice '${sliceId}' evidence subject must match slice id`);
}

function normalizePrCreatedTerminalResult(run, request) {
  const terminalResult = isRecord(request.terminal_result) ? cloneJson(request.terminal_result) : {};
  return {
    ...terminalResult,
    status: "completed",
    run_id: run.run_id,
    pr_url: request.pr_url,
    pr_number: request.pr_number,
    repository: request.repository,
    draft: request.draft,
    reason: terminalResult.reason ?? null,
    summary: terminalResult.summary ?? "Draft PR created.",
    artifacts: isRecord(terminalResult.artifacts) ? terminalResult.artifacts : {},
  };
}

function normalizeTerminalResult(terminalResult) {
  if (typeof terminalResult === "string") return { status: terminalResult };
  if (!isRecord(terminalResult)) throw new Error("transitionTerminalResult requires a terminal result object");
  return cloneJson(terminalResult);
}

export function normalizePrNumber(value) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : value;
  if (!Number.isInteger(number) || number < 1 || String(number) !== String(value).trim()) throw new Error("transitionPrCreated requires pr_number");
  return number;
}

function normalizeBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`transitionPrCreated requires boolean ${label}`);
  return value;
}

function normalizeGateMap(gates) {
  return isRecord(gates) ? gates : {};
}

function assertSafeGateName(gateName) {
  if (!SAFE_GATE_NAME_PATTERN.test(gateName)) throw new Error(`invalid gate name '${gateName}': must match safe pattern [a-z0-9][a-z0-9_-]*[a-z0-9]`);
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
  if (typeof updater === "function") nextValue = await updater(base, { current: hasExisting ? cloneJson(original) : null, index, selector });
  else nextValue = updater;
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
  const replacement = isRecord(base) && isRecord(nextValue) ? { ...base, ...cloneJson(nextValue) } : cloneJson(nextValue);
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

function collectionHasItem(items, selector, identityKey) {
  return selectCollectionItemIndex(items, selector, "collection selector", identityKey) >= 0;
}

function formatSelector(selector) {
  if (stringValue(selector)) return selector;
  if (isRecord(selector) && stringValue(selector.id)) return selector.id;
  if (isRecord(selector) && stringValue(selector.agent)) return selector.agent;
  return JSON.stringify(selector);
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

function formatLockTimeout(lockDir, owner) {
  if (!isRecord(owner)) return `timed out waiting for run.json lock at ${lockDir}`;
  const heldBy = [owner.hostname, owner.pid].filter((value) => value !== undefined && value !== null).join(":");
  const suffix = heldBy ? ` held by ${heldBy}` : "";
  const acquiredAt = stringValue(owner.acquired_at) ? ` since ${owner.acquired_at}` : "";
  return `timed out waiting for run.json lock at ${lockDir}${suffix}${acquiredAt}`;
}

function formatErrorItems(errors) {
  return errors.map((error) => `${error.path}: ${error.message}`).join("; ");
}

function firstNonEmptyString(...values) {
  for (const value of values) if (stringValue(value)) return String(value).trim();
  return null;
}

function parseJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

function parseJsonObjectFile(path, label) {
  const value = parseJsonFile(path, label);
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function normalizePositiveInteger(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error("lock timing options must be positive integers");
  return value;
}

function cloneJson(value) {
  // JSON cloning intentionally treats undefined as absent; use explicit null to clear fields.
  return JSON.parse(JSON.stringify(value));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
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
