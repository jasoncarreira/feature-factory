import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { lstat, open, readFile, rename, rm, mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { appendCostAttributionEntry } from "./cost-attribution.js";
import { git } from "./git.js";
import { probeLegacyBooleanLiveness } from "./hardening/process-verification.js";
import { canonicalizeGithubPrUrl, githubPrUrlParts, hashFile, hashValue, resolveArtifactRef, resolveEvidenceRef, resolveGateRef, resolveReviewRef, resolveSteeringRef } from "./refs.js";
import { buildSteeringConflictTerminalResult, collectProtectedSteeringState } from "./steering-conflicts.js";
import { PASSING_SECURITY_VERDICTS, PASSING_VALIDATOR_VERDICTS, pendingProtectedGate, validateHeartbeatState, validateRun } from "./validate.js";
import { requireNonEmptyString, timestamp } from "./utils.js";

export const TERMINAL_RUN_STATUSES = new Set(["completed", "blocked", "partial", "needs-human"]);

const HEARTBEAT_STEP_IN_FLIGHT_STATUSES = new Set(["running"]);
const HEARTBEAT_SLICE_IN_FLIGHT_STATUSES = new Set(["running", "review"]);
const SAFE_GATE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
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
const STEERING_BOUNDARY_KINDS = new Set(["gate", "dispatch", "remediation", "terminal"]);
const STEERING_ACTION_KINDS = new Set(["dispatch", "remediation"]);

export async function withRunJsonLock(runDir, fn, options = {}) {
  if (typeof fn !== "function") throw new Error("withRunJsonLock requires a callback");
  const lockHooks = validateRunJsonLockHooks(options.lockHooks);
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const retryDelayMs = normalizePositiveInteger(options.retryDelayMs, DEFAULT_LOCK_RETRY_DELAY_MS);
  normalizePositiveInteger(options.staleLockMs, DEFAULT_STALE_LOCK_MS);
  normalizePositiveInteger(options.missingOwnerStealMs, DEFAULT_MISSING_OWNER_STEAL_MS);
  const lockDir = join(runDir, LOCK_DIR);
  const ownerPath = join(lockDir, LOCK_OWNER_FILE);
  const deadline = Date.now() + timeoutMs;
  let stolenFrom = null;
  let stealAttempted = false;
  let contentionReported = false;
  let createdIdentity = null;
  let owner = null;
  let ownerPublished = false;
  let publishedEvidence = null;

  while (true) {
    try {
      await mkdir(lockDir);
      createdIdentity = await lockDirectoryIdentity(lockDir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (!contentionReported && lockHooks.onContended) {
        contentionReported = true;
        await runContendedLockHook(lockHooks.onContended, { runDir, lockDir }, deadline, ownerPath);
      }
      if (!stealAttempted) {
        const observedIdentity = await lockDirectoryIdentity(lockDir);
        const observedEvidence = await readLockOwnerEvidence(ownerPath);
        if (canStealRunJsonLock(observedEvidence?.owner, options)) {
          stealAttempted = true;
          const reclaimed = await reclaimRunJsonLock(runDir, lockDir, observedIdentity, observedEvidence, options, lockHooks, deadline);
          if (reclaimed) {
            stolenFrom = reclaimed;
            continue;
          }
        } else if (!observedEvidence && await canReclaimOwnerlessRunJsonLock(observedIdentity, ownerPath, options)) {
          stealAttempted = true;
          if (await reclaimOwnerlessRunJsonLock(runDir, lockDir, observedIdentity, options, lockHooks, deadline)) continue;
        }
      }
      if (Date.now() >= deadline) {
        const observedOwner = await readLockOwner(ownerPath);
        throw new Error(formatLockTimeout(lockDir, observedOwner));
      }
      await delay(Math.min(retryDelayMs, Math.max(1, deadline - Date.now())));
    }
  }

  owner = { pid: process.pid, hostname: hostname(), acquired_at: new Date().toISOString(), nonce: randomUUID() };
  if (stolenFrom) owner.stolen_from = sanitizeLockOwner(stolenFrom);

  try {
    if (lockHooks.onLockCreated) {
      await runRunJsonLockHook(lockHooks.onLockCreated, { runDir, lockDir }, deadline, ownerPath);
    }
    if (!sameLockDirectoryIdentity(createdIdentity, await lockDirectoryIdentity(lockDir))) {
      throw new Error(`run.json lock ownership changed before owner publication at ${lockDir}`);
    }
    await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    publishedEvidence = await readLockOwnerEvidence(ownerPath);
    if (!sameLockOwner(owner, publishedEvidence?.owner)) throw new Error(`run.json lock owner publication failed at ${lockDir}`);
    ownerPublished = true;
    return await fn({ lock_dir: lockDir, owner });
  } finally {
    if (ownerPublished) {
      if (lockHooks.onBeforeCleanup) await lockHooks.onBeforeCleanup({ runDir, lockDir });
      await releaseOwnedRunJsonLock(runDir, lockDir, createdIdentity, publishedEvidence);
    } else if (!ownerPublished && !(await lockOwnerEntryExists(ownerPath))) {
      await quarantineAndRemoveOwnedLock(runDir, lockDir, createdIdentity);
    }
  }
}

function validateRunJsonLockHooks(lockHooks) {
  if (lockHooks === undefined) return {};
  if (!isRecord(lockHooks)) throw new Error("lockHooks must be an object");
  if (lockHooks.onContended !== undefined && typeof lockHooks.onContended !== "function") {
    throw new Error("lockHooks.onContended must be a function");
  }
  if (lockHooks.onLockCreated !== undefined && typeof lockHooks.onLockCreated !== "function") {
    throw new Error("lockHooks.onLockCreated must be a function");
  }
  for (const name of ["onBeforeReclaimClaim", "onReclaimClaimed", "onReclaimAbandoned", "onReclaimRenamed", "onReclaimRemoved", "onBeforeCleanup"]) {
    if (lockHooks[name] !== undefined && typeof lockHooks[name] !== "function") {
      throw new Error(`lockHooks.${name} must be a function`);
    }
  }
  return lockHooks;
}

async function runContendedLockHook(onContended, context, deadline, ownerPath) {
  return runRunJsonLockHook(onContended, context, deadline, ownerPath);
}

async function runRunJsonLockHook(hook, context, deadline, ownerPath) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error(formatLockTimeout(context.lockDir, await readLockOwner(ownerPath)));
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => hook(context)),
      new Promise((_, reject) => {
        timer = setTimeout(async () => {
          reject(new Error(formatLockTimeout(context.lockDir, await readLockOwner(ownerPath))));
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function canStealRunJsonLock(owner, options = {}) {
  return isDurableLockOwner(owner) && inspectLockOwnerLiveness(owner, options) === "dead";
}

async function readLockOwnerEvidence(ownerPath) {
  let handle;
  try {
    handle = await open(ownerPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const parsed = JSON.parse(await handle.readFile("utf8"));
    if (!isDurableLockOwner(parsed)) return null;
    const value = await handle.stat();
    return { owner: parsed, identity: { dev: value.dev, ino: value.ino } };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function readLockOwner(ownerPath) {
  return (await readLockOwnerEvidence(ownerPath))?.owner ?? null;
}

async function reclaimRunJsonLock(runDir, lockDir, observedIdentity, observedEvidence, options, lockHooks, deadline) {
  if (!observedIdentity || !observedEvidence) return null;
  const claimPath = reclaimClaimPath(runDir, observedIdentity, observedEvidence.owner.nonce);
  const claim = { owner_nonce: observedEvidence.owner.nonce, reclaim_nonce: randomUUID() };
  if (lockHooks.onBeforeReclaimClaim) {
    await runRunJsonLockHook(lockHooks.onBeforeReclaimClaim, { runDir, lockDir }, deadline, join(lockDir, LOCK_OWNER_FILE));
  }
  try {
    await writeFile(claimPath, `${JSON.stringify(claim)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOENT") return null;
    throw error;
  }
  if (lockHooks.onReclaimClaimed) {
    await runRunJsonLockHook(lockHooks.onReclaimClaimed, { runDir, lockDir }, deadline, join(lockDir, LOCK_OWNER_FILE));
  }
  const confirmedIdentity = await lockDirectoryIdentity(lockDir);
  const confirmedEvidence = await readLockOwnerEvidence(join(lockDir, LOCK_OWNER_FILE));
  if (!sameLockDirectoryIdentity(observedIdentity, confirmedIdentity)
    || !sameLockOwnerEvidence(observedEvidence, confirmedEvidence)
    || !canStealRunJsonLock(confirmedEvidence?.owner, options)
    || !sameReclaimClaim(claim, await readJsonNoFollow(claimPath))) {
    await removeOwnedReclaimClaim(claimPath, claim);
    if (lockHooks.onReclaimAbandoned) await lockHooks.onReclaimAbandoned({ runDir, lockDir });
    return null;
  }

  const quarantine = await renameOwnedLockToQuarantine(runDir, lockDir, observedIdentity);
  const movedOwnerPath = join(quarantine, LOCK_OWNER_FILE);
  if (!sameLockOwnerEvidence(observedEvidence, await readLockOwnerEvidence(movedOwnerPath))
    || !sameReclaimClaim(claim, await readJsonNoFollow(claimPath))) {
    throw new Error(`run.json lock reclamation identity changed at ${quarantine}`);
  }
  if (lockHooks.onReclaimRenamed) await lockHooks.onReclaimRenamed({ runDir, lockDir, quarantine });
  if (!sameLockDirectoryIdentity(observedIdentity, await lockDirectoryIdentity(quarantine))
    || !sameLockOwnerEvidence(observedEvidence, await readLockOwnerEvidence(movedOwnerPath))
    || !sameReclaimClaim(claim, await readJsonNoFollow(claimPath))) {
    throw new Error(`run.json lock reclamation identity changed before removal at ${quarantine}`);
  }
  if (!canStealRunJsonLock(observedEvidence.owner, options)) {
    throw new Error(`run.json lock owner is no longer definitively dead before removal at ${quarantine}`);
  }
  await rm(quarantine, { recursive: true, force: true });
  await removeOwnedReclaimClaim(claimPath, claim);
  if (lockHooks.onReclaimRemoved) await lockHooks.onReclaimRemoved({ runDir, lockDir });
  return observedEvidence.owner;
}

async function canReclaimOwnerlessRunJsonLock(identity, ownerPath, options = {}) {
  if (!identity || await lockOwnerEntryExists(ownerPath)) return false;
  const ageMs = Date.now() - identity.mtimeMs;
  return Number.isFinite(ageMs) && ageMs >= normalizePositiveInteger(options.missingOwnerStealMs, DEFAULT_MISSING_OWNER_STEAL_MS);
}

async function reclaimOwnerlessRunJsonLock(runDir, lockDir, observedIdentity, options, lockHooks, deadline) {
  if (!observedIdentity) return false;
  const claimPath = reclaimClaimPath(runDir, observedIdentity, "ownerless");
  const claim = { owner_nonce: "ownerless", reclaim_nonce: randomUUID() };
  if (lockHooks.onBeforeReclaimClaim) {
    await runRunJsonLockHook(lockHooks.onBeforeReclaimClaim, { runDir, lockDir }, deadline, join(lockDir, LOCK_OWNER_FILE));
  }
  try {
    await writeFile(claimPath, `${JSON.stringify(claim)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOENT") return false;
    throw error;
  }
  if (lockHooks.onReclaimClaimed) {
    await runRunJsonLockHook(lockHooks.onReclaimClaimed, { runDir, lockDir }, deadline, join(lockDir, LOCK_OWNER_FILE));
  }
  const ownerPath = join(lockDir, LOCK_OWNER_FILE);
  if (!sameLockDirectoryIdentity(observedIdentity, await lockDirectoryIdentity(lockDir))
    || !sameReclaimClaim(claim, await readJsonNoFollow(claimPath))
    || !await canReclaimOwnerlessRunJsonLock(observedIdentity, ownerPath, options)) {
    await removeOwnedReclaimClaim(claimPath, claim);
    if (lockHooks.onReclaimAbandoned) await lockHooks.onReclaimAbandoned({ runDir, lockDir });
    return false;
  }

  const quarantine = await renameOwnedLockToQuarantine(runDir, lockDir, observedIdentity);
  const movedOwnerPath = join(quarantine, LOCK_OWNER_FILE);
  if (lockHooks.onReclaimRenamed) await lockHooks.onReclaimRenamed({ runDir, lockDir, quarantine });
  if (!sameLockDirectoryIdentity(observedIdentity, await lockDirectoryIdentity(quarantine))
    || await lockOwnerEntryExists(movedOwnerPath)
    || !sameReclaimClaim(claim, await readJsonNoFollow(claimPath))) {
    throw new Error(`ownerless run.json lock reclamation identity changed at ${quarantine}`);
  }
  await rm(quarantine, { recursive: true, force: true });
  await removeOwnedReclaimClaim(claimPath, claim);
  if (lockHooks.onReclaimRemoved) await lockHooks.onReclaimRemoved({ runDir, lockDir });
  return true;
}

function reclaimClaimPath(runDir, identity, ownerNonce) {
  const key = createHash("sha256").update(`${identity.dev}:${identity.ino}:${ownerNonce}`).digest("hex");
  return join(runDir, `.run-json.lock-reclaim-${key}.json`);
}

async function removeOwnedReclaimClaim(claimPath, claim) {
  if (!sameReclaimClaim(claim, await readJsonNoFollow(claimPath))) return;
  await rm(claimPath, { force: true });
}

async function releaseOwnedRunJsonLock(runDir, lockDir, expectedIdentity, expectedEvidence) {
  if (!sameLockDirectoryIdentity(expectedIdentity, await lockDirectoryIdentity(lockDir))) return;
  if (!sameLockOwnerEvidence(expectedEvidence, await readLockOwnerEvidence(join(lockDir, LOCK_OWNER_FILE)))) return;
  const quarantine = await renameOwnedLockToQuarantine(runDir, lockDir, expectedIdentity);
  if (!sameLockOwnerEvidence(expectedEvidence, await readLockOwnerEvidence(join(quarantine, LOCK_OWNER_FILE)))) {
    throw new Error(`run.json lock cleanup identity changed at ${quarantine}`);
  }
  if (!sameLockDirectoryIdentity(expectedIdentity, await lockDirectoryIdentity(quarantine))
    || !sameLockOwnerEvidence(expectedEvidence, await readLockOwnerEvidence(join(quarantine, LOCK_OWNER_FILE)))) return;
  await rm(quarantine, { recursive: true, force: true });
}

async function quarantineAndRemoveOwnedLock(runDir, lockDir, expectedIdentity) {
  if (!sameLockDirectoryIdentity(expectedIdentity, await lockDirectoryIdentity(lockDir))) return;
  const quarantine = await renameOwnedLockToQuarantine(runDir, lockDir, expectedIdentity);
  if (!sameLockDirectoryIdentity(expectedIdentity, await lockDirectoryIdentity(quarantine))) return;
  await rm(quarantine, { recursive: true, force: true });
}

async function renameOwnedLockToQuarantine(runDir, lockDir, expectedIdentity) {
  if (!sameLockDirectoryIdentity(expectedIdentity, await lockDirectoryIdentity(lockDir))) {
    throw new Error(`run.json lock directory identity changed at ${lockDir}`);
  }
  const quarantine = join(runDir, `.run-json.lock-quarantine-${randomUUID()}`);
  await rename(lockDir, quarantine);
  if (!sameLockDirectoryIdentity(expectedIdentity, await lockDirectoryIdentity(quarantine))) {
    throw new Error(`run.json lock quarantine identity changed at ${quarantine}`);
  }
  return quarantine;
}

async function readJsonNoFollow(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    return JSON.parse(await handle.readFile("utf8"));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function sameReclaimClaim(left, right) {
  return isRecord(left) && isRecord(right)
    && left.owner_nonce === right.owner_nonce
    && left.reclaim_nonce === right.reclaim_nonce;
}

function inspectLockOwnerLiveness(owner, options = {}) {
  if (!isDurableLockOwner(owner) || owner.hostname !== hostname()) return "indeterminate";
  if (typeof options.processAliveFn === "function") {
    const status = probeLegacyBooleanLiveness(options.processAliveFn, owner.pid);
    if (status === "live") return "alive";
    if (status === "absent") return "dead";
    return "indeterminate";
  }
  try {
    process.kill(owner.pid, 0);
    return "alive";
  } catch (error) {
    return error?.code === "ESRCH" ? "dead" : "indeterminate";
  }
}

async function lockOwnerEntryExists(ownerPath) {
  try {
    await lstat(ownerPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return true;
  }
}

function sanitizeLockOwner(owner) {
  if (!isRecord(owner)) return owner;
  return Object.fromEntries(Object.entries(owner).filter(([key]) => key !== "stolen_from" && key !== "nonce"));
}

function isDurableLockOwner(owner) {
  return isRecord(owner)
    && Number.isInteger(owner.pid)
    && owner.pid > 0
    && stringValue(owner.hostname)
    && Number.isFinite(Date.parse(owner.acquired_at || ""))
    && typeof owner.nonce === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(owner.nonce);
}

function sameLockOwner(left, right) {
  return isDurableLockOwner(left) && isDurableLockOwner(right) && left.nonce === right.nonce;
}

function sameLockOwnerEvidence(left, right) {
  return Boolean(left && right
    && sameLockOwner(left.owner, right.owner)
    && left.identity.dev === right.identity.dev
    && left.identity.ino === right.identity.ino);
}

async function lockDirectoryIdentity(lockDir) {
  try {
    const value = await lstat(lockDir);
    if (!value.isDirectory() || value.isSymbolicLink()) return null;
    return { dev: value.dev, ino: value.ino, mtimeMs: value.mtimeMs };
  } catch {
    return null;
  }
}

function sameLockDirectoryIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

export function hashRunState(run) {
  return hashValue(validateRun(cloneJson(run)));
}

export function assertRunJsonWriterAllowed(run, label, options = {}) {
  const operation = stringValue(label) ? label : "run.json writer";
  if (!options.allowPrePrFence && isRecord(run?.steering?.pr_fence)) throw new Error(`${operation} rejected: active pre-PR fence`);
  if (!options.allowActionClaim && isRecord(run?.steering?.action_claim)) throw new Error(`${operation} rejected: action start acknowledgement is pending`);
  if (!options.allowUncheckpointed && isRecord(run?.steering?.uncheckpointed)) throw new Error(`${operation} rejected: consumed steering acknowledgement is pending`);
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
        if (nextGate.status === "approved") consumeSteeringBoundary(draft, "gate", options.boundaryToken);
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
    if (isRecord(current.steering?.uncheckpointed)) throw new Error("run has consumed steering awaiting acknowledgement");
    if (isRecord(current.steering?.action_claim)) throw new Error("run has an action awaiting start acknowledgement");
    if (isRecord(current.steering?.pr_fence)) throw new Error("run has an active pre-PR fence and cannot be steered");

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
        generation: steeringGeneration(current) + 1,
        pending: metadata,
        uncheckpointed: null,
        boundary: null,
        action_claim: null,
        last_action: cloneJson(current.steering?.last_action ?? null),
        pr_fence: null,
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
    if (isRecord(current.steering?.pr_fence)) throw new Error("steer-consume rejected: active pre-PR fence");
    if (isRecord(current.steering?.action_claim)) throw new Error("steer-consume rejected: action start acknowledgement is pending");
    const uncheckpointed = current.steering?.uncheckpointed;
    if (isRecord(uncheckpointed)) {
      if (uncheckpointed.ref !== requestedRef || uncheckpointed.hash !== requestedHash) throw new Error("uncheckpointed steering ref/hash mismatch");
      const steering = readConsumedSteeringEnvelope(runDir, current, uncheckpointed);
      return { updated: false, reason: "redelivered-uncheckpointed", status: current.status, run: current, steering };
    }
    const pending = current.steering?.pending;
    if (!isRecord(pending)) throw new Error("run has no pending steering");
    if (pending.ref !== requestedRef || pending.hash !== requestedHash) throw new Error("pending steering ref/hash mismatch");

    const source = resolvePendingSteeringSource(runDir, pending);
    const actualHash = hashFile(source.path, { mode: "raw" });
    if (actualHash !== pending.hash) throw new Error("pending steering file hash mismatch");
    const steeringFile = parseJsonObjectFile(source.path, "pending steering");
    if (steeringFile.kind !== "operator-steering") throw new Error("pending steering kind mismatch");
    if (steeringFile.run_id !== current.run_id) throw new Error("pending steering run_id mismatch");
    if (steeringFile.id !== pending.id) throw new Error("pending steering id mismatch");
    const message = requireNonEmptyString(steeringFile.message, "pending steering message");

    const consumedAt = timestamp(options.now);
    const consumedRef = source.consumedRef ?? nextConsumedSteeringRef(runDir, pending.id, consumedAt);
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
        generation: steeringGeneration(current) + 1,
        pending: null,
        uncheckpointed: {
          id: pending.id,
          ref: consumedRef,
          hash: pending.hash,
          message_chars: pending.message_chars,
          created_at: pending.created_at,
          consumed_at: consumedAt,
        },
        boundary: null,
        action_claim: null,
        last_action: cloneJson(current.steering?.last_action ?? null),
        pr_fence: null,
        history,
      },
    });
    if (!source.consumedRef) {
      const consumedResolved = resolveSteeringRef(runDir, consumedRef, { mustExist: false });
      await rename(source.path, consumedResolved.path);
    }
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

export async function transitionSteeringAcknowledged(runDir, input, options = {}) {
  const requestedRef = requireNonEmptyString(input?.ref, "steering ref");
  const requestedHash = requireNonEmptyString(input?.hash, "steering hash");
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    if (TERMINAL_RUN_STATUSES.has(current.status)) throw new Error(`terminal run '${current.status}' cannot acknowledge steering`);
    if (current.status !== "running") throw new Error(`steer-ack requires a running run, found '${current.status}'`);
    assertNoFreshHeartbeatForSteeringConflict(runDir, options);
    const uncheckpointed = current.steering?.uncheckpointed;
    if (!isRecord(uncheckpointed)) throw new Error("run has no uncheckpointed steering");
    if (uncheckpointed.ref !== requestedRef || uncheckpointed.hash !== requestedHash) throw new Error("uncheckpointed steering ref/hash mismatch");
    readConsumedSteeringEnvelope(runDir, current, uncheckpointed);

    const acknowledgedAt = timestamp(options.now);
    const history = Array.isArray(current.steering?.history) ? cloneJson(current.steering.history) : [];
    history.push({
      event: "acknowledged",
      id: uncheckpointed.id,
      ref: uncheckpointed.ref,
      hash: uncheckpointed.hash,
      message_chars: uncheckpointed.message_chars,
      created_at: uncheckpointed.created_at,
      consumed_at: uncheckpointed.consumed_at,
      acknowledged_at: acknowledgedAt,
      outcome: "applied-prospectively",
    });
    const next = validateRun({
      ...cloneJson(current),
      updated_at: acknowledgedAt,
      steering: {
        ...cloneJson(current.steering),
        schema_version: 1,
        generation: steeringGeneration(current) + 1,
        pending: null,
        uncheckpointed: null,
        boundary: null,
        action_claim: null,
        pr_fence: null,
        history,
      },
    });
    await writeJsonAtomically(join(runDir, RUN_FILE), next);
    return { updated: true, status: next.status, run: next, steering: { ref: requestedRef, hash: requestedHash, acknowledged_at: acknowledgedAt, outcome: "applied-prospectively" } };
  }, options);
}

export async function transitionSteeringConflict(runDir, input, options = {}) {
  const requestedRef = requireNonEmptyString(input?.ref, "steering ref");
  const requestedHash = requireNonEmptyString(input?.hash, "steering hash");
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    if (TERMINAL_RUN_STATUSES.has(current.status)) throw new Error(`terminal run '${current.status}' cannot record steering conflict`);
    if (current.status !== "running") throw new Error(`steer-conflict requires a running run, found '${current.status}'`);
    assertNoFreshHeartbeatForSteeringConflict(runDir, options);

    const consumed = current.steering?.uncheckpointed;
    if (!isRecord(consumed)) throw new Error("run has no uncheckpointed steering");
    if (consumed.ref !== requestedRef || consumed.hash !== requestedHash) throw new Error("uncheckpointed steering ref/hash mismatch");

    const consumedResolved = resolveSteeringRef(runDir, consumed.ref);
    const actualHash = hashFile(consumedResolved.path, { mode: "raw" });
    if (actualHash !== consumed.hash) throw new Error("consumed steering file hash mismatch");

    const protectedState = collectProtectedSteeringState(runDir, current);
    const terminalResult = buildSteeringConflictTerminalResult(current, { ref: consumed.ref, hash: consumed.hash }, protectedState, input);
    const next = validateRun({
      ...cloneJson(current),
      status: "needs-human",
      terminal_result: terminalResult,
      steering: {
        ...cloneJson(current.steering),
        generation: steeringGeneration(current) + 1,
        uncheckpointed: null,
        boundary: null,
        action_claim: null,
        pr_fence: null,
      },
    });
    await writeJsonAtomically(join(runDir, RUN_FILE), next);
    return {
      ok: false,
      conflict: true,
      run_id: next.run_id,
      updated: true,
      status: next.status,
      run: next,
      steering: { ref: consumed.ref, hash: consumed.hash },
      protected_state: protectedState,
      terminal_result: next.terminal_result,
    };
  }, options);
}

export async function transitionSteeringBoundaryOpened(runDir, kind, options = {}) {
  const boundaryKind = normalizeSteeringBoundaryKind(kind);
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    assertBoundaryClean(runDir, current, options, `boundary-open ${boundaryKind}`);
    const createdAt = timestamp(options.now);
    const token = safeBoundaryToken(options.token || randomUUID());
    const base = {
      ...cloneJson(current),
      updated_at: createdAt,
      steering: normalizedSteeringState(current, { boundary: null }),
    };
    base.steering.boundary = {
      kind: boundaryKind,
      token,
      generation: steeringGeneration(current),
      state_hash: steeringBoundaryStateHash(base),
      created_at: createdAt,
    };
    const next = validateRun(base);
    await writeJsonAtomically(join(runDir, RUN_FILE), next);
    return { updated: true, status: next.status, run: next, boundary: cloneJson(next.steering.boundary) };
  }, options);
}

export async function transitionSteeringBoundaryCrossed(runDir, kind, token, options = {}) {
  const boundaryKind = normalizeSteeringBoundaryKind(kind);
  if (!STEERING_ACTION_KINDS.has(boundaryKind)) throw new Error("boundary-cross supports dispatch or remediation");
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    assertBoundaryClean(runDir, current, options, `boundary-cross ${boundaryKind}`);
    const draft = cloneJson(current);
    consumeSteeringBoundary(draft, boundaryKind, token);
    const claimedAt = timestamp(options.now);
    draft.updated_at = claimedAt;
    draft.steering = normalizedSteeringState(draft, {
      boundary: null,
      action_claim: {
        kind: boundaryKind,
        token: safeBoundaryToken(token),
        generation: steeringGeneration(draft),
        claimed_at: claimedAt,
      },
    });
    const next = validateRun(draft);
    await writeJsonAtomically(join(runDir, RUN_FILE), next);
    return { updated: true, status: next.status, run: next, action_claim: cloneJson(next.steering.action_claim) };
  }, options);
}

export async function transitionSteeringActionStarted(runDir, kind, token, options = {}) {
  return transitionSteeringActionResolved(runDir, kind, token, "started", options);
}

export async function transitionSteeringActionAborted(runDir, kind, token, options = {}) {
  return transitionSteeringActionResolved(runDir, kind, token, "aborted", options);
}

async function transitionSteeringActionResolved(runDir, kind, token, outcome, options = {}) {
  const actionKind = normalizeSteeringActionKind(kind);
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    const claim = assertSteeringActionClaim(current, actionKind, token);
    if (outcome === "aborted") {
      const recoverable = inspectRecoverableHeartbeat(runDir, options);
      if (!recoverable.ok) throw new Error("action-abort requires inactive heartbeat: active-heartbeat");
      await stopHeartbeatForRecovery(runDir, recoverable.heartbeat, timestamp(options.now));
    }
    const resolvedAt = timestamp(options.now);
    const next = validateRun({
      ...cloneJson(current),
      updated_at: resolvedAt,
      steering: normalizedSteeringState(current, {
        action_claim: null,
        last_action: {
          kind: actionKind,
          token: claim.token,
          generation: claim.generation,
          outcome,
          claimed_at: claim.claimed_at,
          resolved_at: resolvedAt,
        },
      }),
    });
    await writeJsonAtomically(join(runDir, RUN_FILE), next);
    return { updated: true, status: next.status, run: next, action: cloneJson(next.steering.last_action) };
  }, options);
}

export async function transitionPrePrFenceEstablished(runDir, options = {}) {
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    assertBoundaryClean(runDir, current, options, "pr-fence");
    assertPrCreatedReadiness(runDir, current);
    const createdAt = timestamp(options.now);
    const token = safeBoundaryToken(options.token || randomUUID());
    const base = {
      ...cloneJson(current),
      updated_at: createdAt,
      steering: normalizedSteeringState(current, { boundary: null, pr_fence: null }),
    };
    base.steering.pr_fence = {
      token,
      generation: steeringGeneration(current),
      state_hash: steeringBoundaryStateHash(base),
      created_at: createdAt,
    };
    const next = validateRun(base);
    await writeJsonAtomically(join(runDir, RUN_FILE), next);
    return { updated: true, status: next.status, run: next, fence: cloneJson(next.steering.pr_fence) };
  }, options);
}

export async function transitionPrePrFenceCleared(runDir, token, options = {}) {
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    assertPrFenceToken(current, token);
    const next = validateRun({
      ...cloneJson(current),
      updated_at: timestamp(options.now),
      steering: normalizedSteeringState(current, { pr_fence: null }),
    });
    await writeJsonAtomically(join(runDir, RUN_FILE), next);
    return { updated: true, status: next.status, run: next, fence: null };
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
      assertSteeringBoundaryClear(draft, "pr-created");
      assertPrFence(draft, options.fenceToken);
      assertPrCreatedPreconditions(draft, request);
      draft.pr_url = request.pr_url;
      draft.status = "completed";
      draft.terminal_result = normalizePrCreatedTerminalResult(draft, request);
      draft.steering = normalizedSteeringState(draft, { boundary: null, pr_fence: null });
    },
    options,
    { prCreated: true },
  ), options);
  return { ...result, pr_url: result.run.pr_url, terminal_result: result.run.terminal_result };
}

export async function transitionTerminalResult(runDir, terminalResult, options = {}) {
  const nextTerminalResult = normalizeTerminalResult(terminalResult);
  const result = await withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, (draft) => {
    assertSteeringBoundaryClear(draft, "terminal");
    consumeSteeringBoundary(draft, "terminal", options.boundaryToken);
    const next = { ...cloneJson(nextTerminalResult), run_id: draft.run_id, status: nextTerminalResult.status };
    draft.status = next.status;
    draft.terminal_result = next;
  }, options, { terminal: true }), options);
  return { ...result, terminal_result: result.run.terminal_result };
}

export async function transitionCostUsage(runDir, input, options = {}) {
  const result = await transitionRunJson(runDir, (draft, { current }) => {
    if (TERMINAL_RUN_STATUSES.has(current.status)) throw new Error(`terminal run '${current.status}' cannot be mutated`);
    assertNoFreshHeartbeatForCostRecord(runDir, options);
    draft.cost_attribution = appendCostAttributionEntry(draft.cost_attribution, input, {
      runId: draft.run_id,
      now: options.now,
      id: options.id,
    });
    draft.updated_at = draft.cost_attribution.updated_at;
  }, options);
  return { ...result, cost_attribution: result.run.cost_attribution };
}

export async function transitionRecoverOrphan(runDir, reason = "orphaned factory run", options = {}) {
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    if (current.status !== "running") throw new Error(`recover requires a running run, found '${current.status}'`);
    assertSteeringBoundaryClear(current, "recover");
    if (isRecord(current.steering?.pr_fence)) throw new Error("recover rejected: active pre-PR fence");
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
    if (stepIndex >= 0) bindStepAcceptance(runDir, steps[stepIndex]);
  }, options);
  return { ...result, step_index: stepIndex, step: stepIndex >= 0 ? result.run.steps?.[stepIndex] ?? null : null };
}

// Bind the exact accepted bytes to the step at the acceptance transition, so a
// later blocked-run continuation can prove the artifact/review it reuses are the
// ones that were accepted — not whatever the mutable files happen to contain when
// the continuation is built. Best-effort: only binds refs that currently resolve
// (present, in-run, non-symlink). An accepted step whose artifact is absent stays
// unbound, and any continuation reuse of it fails closed.
//
// Any transition that does not successfully bind the CURRENT accepted artifact/
// review must not leave a prior binding behind — otherwise accepted(A) → rejected
// → accepted(missing B) would keep A's binding while the step points at B, a stale
// provenance claim. So clear first, then re-bind only when this transition's own
// accepted refs resolve.
function bindStepAcceptance(runDir, step) {
  if (!step) return;
  delete step.acceptance;
  if (step.status !== "accepted") return;
  const artifactRef = typeof step.artifact_ref === "string" ? step.artifact_ref.trim() : "";
  if (!artifactRef) return;
  const artifactHash = tryHashDurableRef(() => resolveArtifactRef(runDir, artifactRef, { mustExist: true }));
  if (!artifactHash) return;
  const acceptance = { artifact_ref: artifactRef, artifact_hash: artifactHash };
  const reviewRef = typeof step.review_ref === "string" ? step.review_ref.trim() : "";
  if (reviewRef) {
    const reviewHash = tryHashDurableRef(() => resolveReviewRef(runDir, reviewRef, { mustExist: true }));
    if (reviewHash) {
      acceptance.review_ref = reviewRef;
      acceptance.review_hash = reviewHash;
    }
  }
  step.acceptance = acceptance;
}

function tryHashDurableRef(resolveFn) {
  try {
    return hashFile(resolveFn().path);
  } catch {
    return null;
  }
}

export async function transitionRunSlice(runDir, sliceId, updater, options = {}) {
  assertCollectionUpdater(updater, "transitionRunSlice");
  let sliceIndex = -1;
  const result = await transitionRunJson(runDir, async (draft) => {
    const hadSlices = Array.isArray(draft.slices);
    const slices = hadSlices ? draft.slices : [];
    if (options.mustExist && !collectionHasItem(slices, sliceId, "id")) throw new Error(`slice '${formatSelector(sliceId)}' not found`);
    // `merged` is a one-way state owned by transitionSliceMerged. Reject any
    // generic mutation of an already-merged slice so its durable merged state
    // (merge_commit, review_ref) cannot be rolled back to running/review/blocked
    // through the public slice-status path.
    const priorIndex = selectCollectionItemIndex(slices, sliceId, "slice selector", "id");
    if (priorIndex >= 0 && slices[priorIndex]?.status === "merged") {
      throw new Error(`slice '${slices[priorIndex].id || formatSelector(sliceId)}' is already merged; merged slices are immutable via transitionRunSlice`);
    }
    const update = await applyCollectionItemUpdate({ items: slices, selector: sliceId, updater, selectorLabel: "slice selector", seed: seedRunSlice(sliceId), identityKey: "id" });
    sliceIndex = update.index;
    if (!update.changed) return;
    if (!hadSlices) draft.slices = slices;
    if (sliceIndex >= 0 && slices[sliceIndex].status === "merged") {
      throw new Error(`slice '${slices[sliceIndex].id || formatSelector(sliceId)}' merges must use transitionSliceMerged`);
    }
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
    if (isRecord(current.steering?.pr_fence)) throw new Error("heartbeat tick rejected: active pre-PR fence");
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
  assertRunJsonWriterAllowed(current, "run.json transition", { allowPrePrFence: hooks.prCreated === true });

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
  if (liveness.status === "absent") return { ok: true, reason: liveness.reason, heartbeat };
  return { ok: false, reason: liveness.reason, heartbeat };
}

function assertNoFreshHeartbeatForSteeringConsume(runDir, options = {}) {
  assertNoFreshHeartbeat(runDir, options, "steer-consume requires resumable run");
}

function assertNoFreshHeartbeatForSteeringConflict(runDir, options = {}) {
  assertNoFreshHeartbeat(runDir, options, "steer-conflict requires inactive heartbeat");
}

function assertNoFreshHeartbeatForCostRecord(runDir, options = {}) {
  assertNoFreshHeartbeat(runDir, options, "cost-record requires inactive heartbeat");
}

function assertNoFreshHeartbeat(runDir, options = {}, prefix) {
  const heartbeatPath = join(runDir, HEARTBEAT_FILE);
  if (!existsSync(heartbeatPath)) return;
  let heartbeat;
  try {
    heartbeat = validateHeartbeatState(JSON.parse(readFileSync(heartbeatPath, "utf8")));
  } catch (error) {
    throw new Error(`${prefix}: invalid-run-state (${error.message})`);
  }
  if (inspectHeartbeatLiveness(heartbeat, options).status !== "absent") {
    throw new Error(`${prefix}: active-heartbeat`);
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
  const status = inspectProcessLiveness(heartbeat.pid, options);
  if (status === "absent") return { status, fresh: false, reason: "dead-heartbeat-process" };
  if (status === "indeterminate") return { status, fresh: false, reason: "indeterminate-heartbeat-process" };
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastTickMs)) return { status, fresh: false, reason: "invalid-heartbeat-time" };
  if (nowMs - lastTickMs > staleMs) return { status, fresh: false, reason: "stale-heartbeat" };
  return { status, fresh: true, reason: "fresh-heartbeat" };
}

function inspectProcessLiveness(pid, options = {}) {
  if (typeof options.processAliveFn === "function") return probeLegacyBooleanLiveness(options.processAliveFn, pid);
  if (!Number.isInteger(pid) || pid <= 0) return "absent";
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    if (error?.code === "ESRCH") return "absent";
    return "indeterminate";
  }
}

function assertExpectedCurrentHash(run, expectedCurrentHash) {
  if (expectedCurrentHash === undefined || expectedCurrentHash === null) return;
  if (!stringValue(expectedCurrentHash)) throw new Error("expectedCurrentHash must be a non-empty string");
  const actualCurrentHash = hashValue(run);
  if (actualCurrentHash !== expectedCurrentHash) throw new Error(`stale run.json transition: expected current hash ${expectedCurrentHash}, found ${actualCurrentHash}`);
}

function steeringGeneration(run) {
  const value = run?.steering?.generation;
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizedSteeringState(run, overrides = {}) {
  const current = isRecord(run?.steering) ? cloneJson(run.steering) : {};
  return {
    ...current,
    schema_version: 1,
    generation: steeringGeneration(run),
    pending: current.pending ?? null,
    uncheckpointed: current.uncheckpointed ?? null,
    boundary: current.boundary ?? null,
    action_claim: current.action_claim ?? null,
    last_action: current.last_action ?? null,
    pr_fence: current.pr_fence ?? null,
    history: Array.isArray(current.history) ? current.history : [],
    ...cloneJson(overrides),
  };
}

function assertSteeringBoundaryClear(run, label) {
  if (isRecord(run?.steering?.pending)) throw new Error(`${label} rejected: pending steering`);
  if (isRecord(run?.steering?.uncheckpointed)) throw new Error(`${label} rejected: consumed steering acknowledgement is pending`);
  if (isRecord(run?.steering?.action_claim)) throw new Error(`${label} rejected: action start acknowledgement is pending`);
}

function assertBoundaryClean(runDir, run, options, label) {
  if (TERMINAL_RUN_STATUSES.has(run.status)) throw new Error(`${label} rejected: terminal run '${run.status}'`);
  if (run.status !== "running") throw new Error(`${label} requires a running run, found '${run.status}'`);
  assertSteeringBoundaryClear(run, label);
  if (isRecord(run.steering?.pr_fence)) throw new Error(`${label} rejected: active pre-PR fence`);
  assertNoFreshHeartbeat(runDir, options, `${label} requires inactive heartbeat`);
}

function normalizeSteeringBoundaryKind(kind) {
  const value = requireNonEmptyString(kind, "boundary kind").trim();
  if (!STEERING_BOUNDARY_KINDS.has(value)) throw new Error(`boundary kind must be one of ${[...STEERING_BOUNDARY_KINDS].join(", ")}`);
  return value;
}

function normalizeSteeringActionKind(kind) {
  const value = requireNonEmptyString(kind, "action kind").trim();
  if (!STEERING_ACTION_KINDS.has(value)) throw new Error("action kind must be dispatch or remediation");
  return value;
}

function safeBoundaryToken(value) {
  const token = requireNonEmptyString(value, "boundary token").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(token)) throw new Error("boundary token must use 8-128 safe characters");
  return token;
}

function steeringBoundaryStateHash(run) {
  const copy = cloneJson(run);
  copy.steering = normalizedSteeringState(copy, { boundary: null, pr_fence: null });
  return hashValue(validateRun(copy));
}

function assertSteeringActionClaim(run, kind, token) {
  if (TERMINAL_RUN_STATUSES.has(run.status)) throw new Error(`action acknowledgement rejected: terminal run '${run.status}'`);
  if (run.status !== "running") throw new Error(`action acknowledgement requires a running run, found '${run.status}'`);
  if (isRecord(run.steering?.pending)) throw new Error("action acknowledgement rejected: pending steering");
  if (isRecord(run.steering?.uncheckpointed)) throw new Error("action acknowledgement rejected: consumed steering acknowledgement is pending");
  if (isRecord(run.steering?.pr_fence)) throw new Error("action acknowledgement rejected: active pre-PR fence");
  const claim = run.steering?.action_claim;
  if (!isRecord(claim)) throw new Error("run has no action start claim");
  const requestedToken = safeBoundaryToken(token);
  if (claim.kind !== kind || claim.token !== requestedToken) throw new Error("action start claim token mismatch");
  if (claim.generation !== steeringGeneration(run)) throw new Error("action start claim is stale");
  return claim;
}

function consumeSteeringBoundary(draft, kind, token) {
  assertSteeringBoundaryClear(draft, kind);
  if (isRecord(draft.steering?.pr_fence)) throw new Error(`${kind} rejected: active pre-PR fence`);
  const boundary = draft.steering?.boundary;
  if (!isRecord(boundary)) throw new Error(`${kind} requires a lock-protected boundary observation`);
  const requestedToken = safeBoundaryToken(token);
  if (boundary.kind !== kind || boundary.token !== requestedToken) throw new Error(`${kind} boundary token mismatch`);
  if (boundary.generation !== steeringGeneration(draft)) throw new Error(`${kind} boundary observation is stale`);
  if (boundary.state_hash !== steeringBoundaryStateHash(draft)) throw new Error(`${kind} boundary observation is stale`);
  draft.steering = normalizedSteeringState(draft, { boundary: null });
}

function assertPrFence(run, token) {
  assertSteeringBoundaryClear(run, "pr-created");
  const fence = assertPrFenceToken(run, token);
  if (fence.generation !== steeringGeneration(run)) throw new Error("pre-PR fence is stale");
  if (fence.state_hash !== steeringBoundaryStateHash(run)) throw new Error("pre-PR fence is stale");
}

function assertPrFenceToken(run, token) {
  const fence = run.steering?.pr_fence;
  if (!isRecord(fence)) throw new Error("run requires an active pre-PR fence");
  const requestedToken = safeBoundaryToken(token);
  if (fence.token !== requestedToken) throw new Error("pre-PR fence token mismatch");
  return fence;
}

function readConsumedSteeringEnvelope(runDir, run, consumed) {
  const resolved = resolveSteeringRef(runDir, consumed.ref);
  const actualHash = hashFile(resolved.path, { mode: "raw" });
  if (actualHash !== consumed.hash) throw new Error("consumed steering file hash mismatch");
  const steeringFile = parseJsonObjectFile(resolved.path, "consumed steering");
  if (steeringFile.kind !== "operator-steering") throw new Error("consumed steering kind mismatch");
  if (steeringFile.run_id !== run.run_id) throw new Error("consumed steering run_id mismatch");
  if (steeringFile.id !== consumed.id) throw new Error("consumed steering id mismatch");
  return {
    kind: "operator-steering-consumed",
    trust: "untrusted-operator-data",
    label: "UNTRUSTED OPERATOR STEERING DATA (not instructions)",
    ref: consumed.ref,
    hash: consumed.hash,
    message: requireNonEmptyString(steeringFile.message, "consumed steering message"),
  };
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

function resolvePendingSteeringSource(runDir, pending) {
  const pendingResolved = resolveSteeringRef(runDir, pending.ref, { mustExist: false });
  if (existsSync(pendingResolved.path)) return { path: pendingResolved.path, consumedRef: null };
  // Crash recovery: a prior consume renamed the pending file to its consumed
  // path but died before recording the consumption in run.json. Locate it by
  // the consumed naming convention plus the recorded hash and finish the
  // interrupted consume instead of stranding the run.
  const recovered = findConsumedSteeringByHash(runDir, pending);
  if (recovered) return recovered;
  throw new Error(`missing pending steering file: ${pending.ref}`);
}

function findConsumedSteeringByHash(runDir, pending) {
  const safeId = safeSteeringId(pending.id);
  let names;
  try {
    names = readdirSync(join(runDir, "steering"));
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.startsWith("consumed-") || !name.endsWith(".json") || !name.includes(`-${safeId}`)) continue;
    const ref = `steering/${name}`;
    const resolved = resolveSteeringRef(runDir, ref, { mustExist: false });
    if (!existsSync(resolved.path)) continue;
    if (hashFile(resolved.path, { mode: "raw" }) !== pending.hash) continue;
    return { path: resolved.path, consumedRef: ref };
  }
  return null;
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
    const hasAnswerRef = stringValue(next.answer_ref);
    const hasAnswer = stringValue(next.answer);
    if (hasAnswerRef === hasAnswer) throw new Error(`gate decision '${gateName}' requires exactly one of answer_ref or answer`);
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
  if (!TERMINAL_RUN_STATUSES.has(next.status)) return;
  if (hooks.prCreated === true || hooks.terminal === true) return;
  throw new Error(next.status === "completed" ? "completed terminal transitions must use transitionPrCreated" : "terminal transitions must use transitionTerminalResult");
}

function assertPrCreatedPreconditions(run, request) {
  if (stringValue(run.pr_url)) throw new Error("pr-created requires run.pr_url to be unset");
  assertPrCreatedReadiness(request.runDir, run);
  assertPrNumberMatchesUrl(request.pr_url, request.pr_number);
}

function assertPrCreatedReadiness(runDir, run) {
  if (run.gates?.pre_pr?.status !== "approved") throw new Error("pr-created requires approved pre_pr gate");
  if (!PASSING_VALIDATOR_VERDICTS.has(run.validator?.verdict)) throw new Error("pr-created requires validator verdict GO or GO-WITH-NITS");
  if (!PASSING_SECURITY_VERDICTS.has(run.security_review?.verdict)) throw new Error("pr-created requires security_review verdict PASS");
  assertPrCreatedSliceState(run);
  assertPassingVerdictArtifacts(runDir, run);
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
    draft: input.draft === undefined ? false : normalizeBoolean(input.draft, "draft"),
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
    summary: terminalResult.summary ?? (request.draft ? "Draft PR created." : "PR created."),
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
