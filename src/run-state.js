import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { lstat, open, readFile, rename, rm, mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { appendCostAttributionEntry } from "./cost-attribution.js";
import { git } from "./git.js";
import { probeLegacyBooleanLiveness } from "./hardening/process-verification.js";
import { writeProtectedJsonAtomic } from "./hardening/atomic-write.js";
import { githubPrUrlParts, hashFile, hashValue, resolveArtifactRef, resolveEvidenceRef, resolveGateRef, resolveReviewRef, resolveSteeringRef } from "./refs.js";
import { normalizeRepositoryPath, validatePlanPath } from "./post-pr-ci.js";
import { buildSteeringConflictTerminalResult, collectProtectedSteeringState } from "./steering-conflicts.js";
import { canonicalGithubRepositoryFromOrigin, computePrOperationId, observePullRequestOperation } from "./github.js";
import { PASSING_SECURITY_VERDICTS, PASSING_VALIDATOR_VERDICTS, POST_PR_TERMINAL_REASONS, pendingProtectedGate, postPrConsistencyChecks, validateHeartbeatState, validateRun } from "./validate.js";
import { requireNonEmptyString, timestamp } from "./utils.js";
import { deriveExpectedWorktreePath } from "./worktrees.js";

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
const STEERING_BOUNDARY_KINDS = new Set(["gate", "dispatch", "remediation", "terminal", "post-pr-observe", "post-pr-push"]);
const STEERING_ACTION_KINDS = new Set(["dispatch", "remediation", "terminal", "post-pr-observe", "post-pr-push"]);
const POST_PR_HEARTBEAT_PHASES = new Set(["observing", "remediation-running", "revalidating"]);
const POST_PR_TERMINAL_PHASE = Object.freeze({ completed: "succeeded", blocked: "blocked", "needs-human": "needs-human" });
const MERGED_SLICE_REPAIR_TRANSITION_AUTHORITY = Symbol("merged-slice-repair-transition-authority");
const SLICE_REVIEW_BINDING_KEYS = Object.freeze(["evidence_hash", "review_hash", "reviewed_commit"]);
const VALIDATOR_BINDING_KEYS = Object.freeze(["report_hash", "review_hash", "reviewed_head_sha"]);
const SECURITY_BINDING_KEYS = Object.freeze(["review_hash", "reviewed_head_sha"]);
const PR_FENCE_IDENTITY_KEYS = Object.freeze(["operation_id", "repository", "head_ref", "head_sha", "base_ref", "base_sha", "draft"]);
const LEGACY_MERGED_UPGRADE_ERROR = "legacy merged slice authority upgrade failed";
const CONTINUATION_PARENT_ARTIFACTS = Object.freeze([
  ["story", "artifacts/story.md"],
  ["research_map", "artifacts/research-map.md"],
  ["design_brief", "artifacts/design-brief.md"],
  ["technical_brief", "artifacts/technical-brief.md"],
  ["test_report", "artifacts/test-report.md"],
  ["validation_report", "artifacts/validation-report.md"],
  ["pr_body", "artifacts/pr-body.md"],
]);
const APPROVING_CONTINUATION_REVIEW_VERDICTS = new Set(["APPROVE", "APPROVED", "ACCEPT", "ACCEPTED", "GO", "PASS"]);
const POST_PR_TRANSITIONS = new Map([
  ["awaiting-pr", new Set(["observing"])],
  ["observing", new Set(["observing", "failure-recording", "succeeded", "blocked", "needs-human"])],
  ["failure-recording", new Set(["failure-recording", "remediation-planned", "blocked", "needs-human"])],
  ["remediation-planned", new Set(["remediation-planned", "remediation-running", "needs-human"])],
  ["remediation-running", new Set(["remediation-running", "changes-observed", "needs-human"])],
  ["changes-observed", new Set(["changes-observed", "committed", "needs-human"])],
  ["committed", new Set(["committed", "revalidating", "needs-human"])],
  ["revalidating", new Set(["revalidating", "failure-recording", "validated", "blocked", "needs-human"])],
  ["validated", new Set(["validated", "push-pending", "needs-human"])],
  ["push-pending", new Set(["push-pending", "remote-confirmed", "needs-human"])],
  ["remote-confirmed", new Set(["remote-confirmed", "observing", "needs-human"])],
]);

export class RunJsonLockContendedError extends Error {
  constructor(lockDir) {
    super(`run.json lock is contended at ${lockDir}`);
    this.name = "RunJsonLockContendedError";
    this.code = "RUN_JSON_LOCK_CONTENDED";
    this.lockDir = lockDir;
  }
}

export async function withRunJsonLock(runDir, fn, options = {}) {
  if (typeof fn !== "function") throw new Error("withRunJsonLock requires a callback");
  const reclaimMode = normalizeReclaimMode(options.reclaimMode);
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
      if (reclaimMode === "never") throw new RunJsonLockContendedError(lockDir);
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

function normalizeReclaimMode(value) {
  if (value === undefined || value === "dead-owner") return "dead-owner";
  if (value === "never") return value;
  throw new Error("reclaimMode must be dead-owner or never");
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

export function createPostPrState(policy) {
  const postPr = { schema_version: 1, policy: cloneJson(policy), phase: policy?.enabled === true ? "awaiting-pr" : "disabled", attempt: 0, observation: null, remediation: null, evidence_refs: [], continuation_review: null, terminal_fact: null, pr_operation: null };
  validateRun({ schema_version: 1, run_id: "post-pr-policy-check", status: "running", max_retries: 3, gates: {}, post_pr: postPr });
  return postPr;
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
  const redeliveryInput = {
    answeredAtExplicit: Object.prototype.hasOwnProperty.call(gate || {}, "answered_at") || stringValue(options.answeredAt),
    rawAnswer: typeof gate?.answer === "string" ? gate.answer : null,
  };
  const nextGate = normalizeGateDecision(gateName, gate, options);
  const answerArchives = [];
  const publishedArchives = [];
  const result = await withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    if (nextGate.status === "approved" && mergedSliceRepairFence(current)) {
      throw new Error(`gate '${gateName}' cannot be approved while a merged-slice repair is unresolved`);
    }
    if (nextGate.status === "approved" && current.gates?.[gateName]?.status === "approved") {
      return reconcileApprovedGateRedelivery(runDir, current, gateName, nextGate, redeliveryInput);
    }
    try {
      return await transitionRunJsonLocked(
        runDir,
        (draft) => {
          if (nextGate.status === "approved") consumeSteeringBoundary(draft, "gate", options.boundaryToken);
          draft.gates = normalizeGateMap(draft.gates);
          const prepared = prepareGateDecisionTransition(runDir, gateName, draft.gates[gateName], nextGate, (archive) => answerArchives.push(archive));
          if (nextGate.status === "approved" && draft.mode === "interactive") {
            prepared.handoff_receipt = createApprovalHandoffReceipt(runDir, gateName, prepared, draft);
          }
          delete prepared._handoff_answer_hash;
          draft.gates[gateName] = prepared;
        },
        options,
        { authorizedGate: gateName, beforeWrite: async () => {
          for (const archive of answerArchives) {
            await archiveConsumedGateAnswer(archive);
            publishedArchives.push(archive);
          }
        } },
      );
    } catch (error) {
      await restoreConsumedGateAnswers(publishedArchives);
      throw error;
    }
  }, options);
  return { ...result, gate: gateName };
}

export function inspectApprovalHandoffReceipt(runDir, run, gateName) {
  try {
    validateRun(run);
  } catch {
    return { ok: false, reason_code: "approval-receipt-missing" };
  }
  const gate = run?.gates?.[gateName];
  if (run.mode !== "interactive" || gate?.status !== "approved") return { ok: false, reason_code: "approval-receipt-missing" };
  if (!isRecord(gate?.handoff_receipt)) return { ok: false, reason_code: "approval-receipt-missing" };
  const receipt = gate.handoff_receipt;
  try {
    validateApprovalReceiptMaterial(receipt, gateName);
  } catch {
    return { ok: false, reason_code: "approval-receipt-missing" };
  }
  if (!isRecord(gate.pending_snapshot) || receipt.pending_snapshot_hash !== hashValue(gate.pending_snapshot)) {
    return { ok: false, reason_code: "approval-snapshot-mismatch" };
  }
  try {
    const fresh = createPendingGateSnapshot(
      runDir,
      gateName,
      gate.pending_snapshot.artifact_ref,
      gate.pending_snapshot.question_ref,
      gate.pending_snapshot.created_at,
      gate.pending_snapshot.answer_ref,
    );
    // The pending answer was archived on acceptance, so only immutable question
    // and artifact fields are refreshed here.
    for (const field of ["question_ref", "question_hash", "artifact_ref", "artifact_hash", "created_at"]) {
      if (fresh[field] !== gate.pending_snapshot[field]) return { ok: false, reason_code: "approval-snapshot-mismatch" };
    }
  } catch {
    return { ok: false, reason_code: "approval-snapshot-mismatch" };
  }
  if (receipt.answer_hash !== approvedAnswerHash(runDir, gate)) return { ok: false, reason_code: "approval-snapshot-mismatch" };
  if (receipt.approval_fingerprint !== approvalFingerprint(gateName, gate, receipt)) return { ok: false, reason_code: "approval-snapshot-mismatch" };
  if (receipt.steering_generation !== steeringGeneration(run)) return { ok: false, reason_code: "steering-generation-mismatch" };
  if (!cleanSteeringForHandoff(run.steering)) return { ok: false, reason_code: "steering-state-not-clean" };
  return { ok: true, receipt: cloneJson(receipt) };
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
    if (boundaryKind === "gate" && mergedSliceRepairFence(current)) throw new Error("gate boundary cannot open while a merged-slice repair is unresolved");
    if (boundaryKind === "terminal" && current.post_pr?.policy?.enabled === true && current.steering?.last_action?.outcome !== "closed") throw new Error("post-PR terminal boundary requires a closed origin action");
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
  if (!STEERING_ACTION_KINDS.has(boundaryKind)) throw new Error("boundary-cross supports dispatch, remediation, terminal, post-pr-observe, or post-pr-push");
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

export async function transitionSteeringActionClosed(runDir, kind, token, options = {}) {
  const actionKind = normalizeSteeringActionKind(kind);
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    assertSteeringBoundaryClear(current, "action-close");
    if (isRecord(current.steering?.boundary) || isRecord(current.steering?.pr_fence)) throw new Error("action-close requires no boundary or PR fence");
    assertNoFreshHeartbeat(runDir, options, "action-close requires inactive heartbeat");
    const action = current.steering?.last_action;
    const requestedToken = safeBoundaryToken(token);
    if (!isRecord(action) || action.kind !== actionKind || action.token !== requestedToken || action.outcome !== "started" || action.generation !== steeringGeneration(current)) throw new Error("origin action is missing, stale, or not started");
    const closedAt = timestamp(options.now);
    const next = validateRun({ ...cloneJson(current), updated_at: closedAt, steering: normalizedSteeringState(current, { last_action: { ...cloneJson(action), outcome: "closed", resolved_at: closedAt } }) });
    await writeJsonAtomically(join(runDir, RUN_FILE), next);
    return { updated: true, status: next.status, run: next, action: cloneJson(next.steering.last_action) };
  }, options);
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
    const authority = assertPrCreatedReadiness(runDir, current);
    const gitAuthority = observePrOperationGitAuthority(runDir, current, options, "pr-fence");
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
      operation_id: computePrOperationId({ base_commit: gitAuthority.base_sha, branch: gitAuthority.head_ref, created_at: createdAt, repository: gitAuthority.repository, run_id: current.run_id }),
      repository: gitAuthority.repository,
      head_ref: gitAuthority.head_ref,
      head_sha: gitAuthority.head_sha,
      base_ref: gitAuthority.base_ref,
      base_sha: gitAuthority.base_sha,
      draft: current.pr_mode === "draft",
    };
    const next = validateRun(base);
    await writeProtectedRunJson(runDir, next, options, () => {
      assertPrCreatedAuthorityCurrent(runDir, current, authority);
      assertSamePrOperationGitAuthority(runDir, current, options, gitAuthority, "pr-fence");
    });
    return { updated: true, status: next.status, run: next, fence: cloneJson(next.steering.pr_fence) };
  }, options);
}

export async function transitionPrePrFenceCleared(runDir, token, options = {}) {
  return reconcilePrOperation(runDir, token, "clear", options);
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

export async function transitionPrCreated(runDir, input = {}, options = {}) {
  if (!isRecord(input) || Object.keys(input).length !== 0) throw new Error("transitionPrCreated derives PR metadata from checked GitHub observation and accepts no caller PR fields");
  return reconcilePrOperation(runDir, options.fenceToken, "record", options);
}

async function reconcilePrOperation(runDir, token, mode, options = {}) {
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    if (current.status !== "running") throw new Error(`${mode === "clear" ? "pr-fence clear" : "pr-created"} requires a running run`);
    if (mergedSliceRepairFence(current)) throw new Error("pr-created is fenced while a merged-slice repair is unresolved");
    const fence = assertPrFence(current, token);
    if (!hasCompleteBinding(fence, PR_FENCE_IDENTITY_KEYS)) return terminalizeLegacyPrFenceLocked(runDir, current, options);

    const readiness = assertPrCreatedReadiness(runDir, current);
    const gitAuthority = assertPrFenceGitAuthorityCurrent(runDir, current, fence, options);
    const observation = await observeFencedPrOperation(current, fence, options, gitAuthority.head_sha);
    if (["unknown", "ambiguous"].includes(observation.disposition) || observation.disposition === "absent" && mode === "record") {
      return { ok: false, updated: false, disposition: observation.disposition, reason: observation.reason, status: current.status, run: current, fence: cloneJson(fence), pr_url: null, terminal_result: null };
    }

    if (observation.disposition === "absent") {
      const next = validateRun({ ...cloneJson(current), updated_at: timestamp(options.now), steering: normalizedSteeringState(current, { pr_fence: null }) });
      await writeProtectedRunJson(runDir, next, options, () => assertPrReconciliationCurrent(runDir, current, fence, readiness, observation, options));
      return { ok: true, updated: true, disposition: "absent", status: next.status, run: next, fence: null, pr_url: null, terminal_result: null };
    }

    const pullRequest = observation.pull_request;
    const draft = cloneJson(current);
    draft.pr_url = pullRequest.pr_url;
    if (observation.disposition === "closed") {
      draft.status = "needs-human";
      draft.terminal_result = {
        status: "needs-human",
        run_id: current.run_id,
        pr_url: pullRequest.pr_url,
        reason: "pr-operation-closed-unmerged",
        summary: "The fenced PR operation resolved to a closed, unmerged pull request and requires human reconciliation.",
        artifacts: {},
      };
    } else if (observation.disposition === "merged") {
      draft.status = "completed";
      if (draft.post_pr?.policy?.enabled === true) {
        draft.post_pr = initializePostPrObservation(draft.post_pr, pullRequest, options.now, fence);
        draft.post_pr.phase = "succeeded";
        draft.post_pr.observation.last_observed_at = timestamp(options.now);
        draft.post_pr.observation.last_verdict = "external-merge";
      }
      draft.terminal_result = normalizePrCreatedTerminalResult(draft, pullRequest, fence, { reason: draft.post_pr?.policy?.enabled === true ? "post-pr-external-merge" : null });
      draft.steering = normalizedSteeringState(draft, { boundary: null, pr_fence: null });
    } else {
      if (draft.post_pr?.policy?.enabled === true) {
        draft.status = "running";
        draft.terminal_result = null;
        draft.post_pr = initializePostPrObservation(draft.post_pr, pullRequest, options.now, fence);
      } else {
        draft.status = "completed";
        draft.terminal_result = normalizePrCreatedTerminalResult(draft, pullRequest, fence);
      }
      draft.steering = normalizedSteeringState(draft, { boundary: null, pr_fence: null });
    }
    draft.updated_at = timestamp(options.now);
    const next = validateRun(draft);
    await writeProtectedRunJson(runDir, next, options, () => assertPrReconciliationCurrent(runDir, current, fence, readiness, observation, options));
    return {
      ok: observation.disposition !== "closed",
      updated: true,
      disposition: observation.disposition,
      reason: next.terminal_result?.reason ?? null,
      status: next.status,
      run: next,
      fence: cloneJson(next.steering?.pr_fence ?? null),
      pr_url: next.pr_url,
      terminal_result: next.terminal_result,
    };
  }, options);
}

async function assertPrReconciliationCurrent(runDir, current, fence, readiness, expectedObservation, options) {
  assertPrCreatedAuthorityCurrent(runDir, current, readiness);
  const authority = assertPrFenceGitAuthorityCurrent(runDir, current, fence, options);
  const observed = await observeFencedPrOperation(current, fence, options, authority.head_sha);
  if (!sameJson(observed, expectedObservation)) throw new Error("PR operation GitHub observation changed before publication");
}

async function observeFencedPrOperation(run, fence, options, expectedHeadSha) {
  const observer = typeof options.observePrOperation === "function" ? options.observePrOperation : observePullRequestOperation;
  let result;
  try {
    result = await observer({
      repositoryRoot: resolveAuthorityRepository(options.runDir, run, options),
      cwd: resolveAuthorityRepository(options.runDir, run, options),
      account: run.github_account,
      repository: fence.repository,
      operation_id: fence.operation_id,
      head_ref: fence.head_ref,
      head_sha: expectedHeadSha,
      base_ref: fence.base_ref,
      base_sha: fence.base_sha,
      draft: fence.draft,
      executable: options.ghExecutable,
      execute: options.executeGithub,
      spawnImpl: options.spawnImpl,
      lockOptions: options.githubLockOptions,
      observePage: options.observePrOperationPage,
    });
  } catch (error) {
    return { disposition: "unknown", reason: error instanceof Error ? error.message : "observer-threw", pull_request: null };
  }
  if (!isRecord(result) || !["open", "merged", "closed", "absent", "ambiguous", "unknown"].includes(result.disposition)) {
    return { disposition: "unknown", reason: "observer-result-malformed", pull_request: null };
  }
  if (["open", "merged", "closed"].includes(result.disposition)) assertObservedPrTuple(result.pull_request, fence, expectedHeadSha);
  return result;
}

function assertObservedPrTuple(pullRequest, fence, expectedHeadSha) {
  if (!isRecord(pullRequest)) throw new Error("checked GitHub observation returned no pull-request tuple");
  const expected = {
    repository: fence.repository,
    head_ref: fence.head_ref,
    head_sha: expectedHeadSha,
    base_ref: fence.base_ref,
    base_sha: fence.base_sha,
    draft: fence.draft,
  };
  for (const [key, value] of Object.entries(expected)) if (pullRequest[key] !== value) throw new Error(`checked GitHub pull-request ${key} does not match the fenced operation`);
  for (const key of ["pr_url", "pr_node_id"]) requireNonEmptyString(pullRequest[key], `checked GitHub pull-request ${key}`);
  normalizePrNumber(pullRequest.pr_number);
}

function terminalizeLegacyPrFenceLocked(runDir, current, options = {}) {
  const now = timestamp(options.now);
  const next = validateRun({
    ...cloneJson(current),
    status: "needs-human",
    updated_at: now,
    terminal_result: {
      status: "needs-human",
      run_id: current.run_id,
      pr_url: current.pr_url || null,
      reason: "legacy-pr-fence-operation-identity-missing",
      summary: "The active legacy PR fence has no operation identity and requires human reconciliation.",
      artifacts: {},
    },
  });
  return writeJsonAtomically(join(runDir, RUN_FILE), next).then(() => ({
    ok: false,
    updated: true,
    disposition: "legacy",
    reason: next.terminal_result.reason,
    status: next.status,
    run: next,
    fence: cloneJson(next.steering.pr_fence),
    pr_url: next.pr_url ?? null,
    terminal_result: next.terminal_result,
  }));
}

export async function transitionLegacyPrFenceNeedsHuman(runDir, options = {}) {
  const observed = await readRunJson(runDir);
  const observedFence = observed.steering?.pr_fence;
  if (!isRecord(observedFence) || hasCompleteBinding(observedFence, PR_FENCE_IDENTITY_KEYS) || observed.status !== "running") return null;
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    const fence = current.steering?.pr_fence;
    if (!isRecord(fence) || hasCompleteBinding(fence, PR_FENCE_IDENTITY_KEYS)) return null;
    if (current.status !== "running") return null;
    return terminalizeLegacyPrFenceLocked(runDir, current, options);
  }, options);
}

/** Checked replacement used by the orchestration layer after external work is inactive. */
export async function transitionPostPrState(runDir, postPr, options = {}) {
  if (!isRecord(postPr)) throw new Error("transitionPostPrState requires post_pr state");
  return withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, (draft, { current }) => {
    assertPostPrMutationReady(runDir, current, options, "post-PR transition");
    const nextPostPr = cloneJson(postPr);
    if (sameJson(current.post_pr, nextPostPr)) return;
    assertPostPrPhaseTransition(current.post_pr, nextPostPr);
    assertPostPrAttemptTransition(current, nextPostPr);
    assertPostPrMonotonicState(current.post_pr, nextPostPr);
    assertPostPrCandidateGitState(current, nextPostPr, options);
    draft.post_pr = nextPostPr;
    draft.updated_at = timestamp(options.now);
  }, options, { postPr: true, beforeWrite: (next) => assertPostPrRefsConsistent(runDir, next) }), options);
}

/** Reserve exactly one routable check-red attempt. Matching replay is a no-op. */
export async function transitionPostPrFailure(runDir, input, options = {}) {
  if (!isRecord(input?.remediation)) throw new Error("post-PR failure requires remediation state");
  return withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, (draft, { current }) => {
    assertPostPrMutationReady(runDir, current, options, "post-PR failure");
    const remediation = cloneJson(input.remediation);
    const replay = current.post_pr.remediation;
    if (isRecord(replay) && replay.attempt === remediation.attempt) {
      assertPostPrFailureEvidence(runDir, current, remediation);
      if (sameJson(replay, remediation)) {
        assertPostPrFailureReplayContext(current, remediation);
        return;
      }
      throw new Error("conflicting post-PR failure replay");
    }
    assertPostPrFailureSource(current, remediation);
    assertPostPrFailureEvidence(runDir, current, remediation);
    const expectedAttempt = current.post_pr.attempt + 1;
    if (remediation.attempt !== expectedAttempt) throw new Error(`post-PR attempt must advance exactly from ${current.post_pr.attempt} to ${expectedAttempt}`);
    if (expectedAttempt > (Number.isInteger(current.max_retries) ? current.max_retries : 3)) throw new Error(`post-PR attempt ${expectedAttempt} exceeds max_retries`);
    const evidenceRefs = Array.isArray(current.post_pr.evidence_refs) ? cloneJson(current.post_pr.evidence_refs) : [];
    const failureBinding = { ref: remediation.failure_evidence_ref, hash: remediation.failure_evidence_hash };
    if (!evidenceRefs.some((item) => sameJson(item, failureBinding))) evidenceRefs.push(failureBinding);
    draft.post_pr = { ...cloneJson(current.post_pr), phase: "failure-recording", attempt: expectedAttempt, remediation, evidence_refs: evidenceRefs };
    draft.updated_at = timestamp(options.now);
  }, options, { postPr: true, beforeWrite: (next) => assertPostPrRefsConsistent(runDir, next) }), options);
}

export async function transitionPostPrTerminal(runDir, input, options = {}) {
  if (!isRecord(input)) throw new Error("transitionPostPrTerminal requires an input object");
  const status = requireNonEmptyString(input.status, "post-PR terminal status");
  const reason = requireNonEmptyString(input.reason, "post-PR terminal reason");
  if (!POST_PR_TERMINAL_PHASE[status] || !POST_PR_TERMINAL_REASONS[status]?.includes(reason)) throw new Error(`invalid closed post-PR terminal reason '${reason}' for ${status}`);
  let completedPrAuthority = null;
  return withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, async (draft, { current }) => {
    assertPostPrMutationReady(runDir, current, options, "post-PR terminal transition");
    const phase = POST_PR_TERMINAL_PHASE[status];
    if (current.post_pr?.phase === phase && current.status === status && current.terminal_result?.reason === reason) return;
    if (!current.post_pr?.policy?.enabled) throw new Error("post-PR terminal transition requires enabled persisted policy");
    assertPostPrTerminalPreconditions(current, status, reason, input, options);
    const completedPr = status === "completed" ? await observePostPrCompletedIdentity(runDir, current, reason, options) : null;
    completedPrAuthority = completedPr;
    assertPostPrPhaseTransition(current.post_pr, { ...current.post_pr, phase });
    draft.status = status;
    draft.post_pr = { ...cloneJson(current.post_pr), phase, terminal_fact: normalizedPostPrTerminalFact(reason, input.trigger_fact) };
    if (reason === "post-pr-retry-exhausted") draft.post_pr.continuation_review = bindPostPrContinuationReview(runDir, current, input.continuation_review);
    draft.terminal_result = completedPr
      ? normalizePrCreatedTerminalResult(draft, completedPr, current.post_pr.pr_operation, { reason, summary: stringValue(input.summary) ? input.summary : reason, artifacts: input.artifacts })
      : {
          status,
          run_id: current.run_id,
          pr_url: current.pr_url,
          reason,
          summary: stringValue(input.summary) ? input.summary : reason,
          artifacts: isRecord(input.artifacts) ? cloneJson(input.artifacts) : {},
        };
    validateRun(draft);
    const terminalAction = current.steering?.last_action;
    if (!stringValue(options.terminalActionToken) || !Number.isInteger(options.terminalActionGeneration)
      || terminalAction?.kind !== "terminal" || terminalAction?.token !== options.terminalActionToken || terminalAction?.generation !== options.terminalActionGeneration || terminalAction?.outcome !== "started") {
      throw new Error("post-PR terminal transition requires the exact fresh started terminal action");
    }
    draft.updated_at = timestamp(options.now);
  }, options, {
    postPr: true,
    postPrTerminal: true,
    beforeWrite: (next) => assertPostPrRefsConsistent(runDir, next),
    beforeReplace: status === "completed" ? async (_next, current) => {
      const observed = await observePostPrCompletedIdentity(runDir, current, reason, options);
      if (!sameJson(observed, completedPrAuthority)) throw new Error("post-PR completion GitHub observation changed before publication");
    } : undefined,
  }), options);
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
    if (isRecord(current.steering?.pr_fence)) {
      if (!hasCompleteBinding(current.steering.pr_fence, PR_FENCE_IDENTITY_KEYS)) return terminalizeLegacyPrFenceLocked(runDir, current, options);
      throw new Error("recover rejected: active pre-PR fence");
    }
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
  return transitionRunStepChecked(runDir, stepSelector, updater, options, { allowInheritedAcceptance: false });
}

export async function transitionContinuationAdoption(runDir, options = {}) {
  let stepIndex = -1;
  let adoptionAuthority = null;
  const result = await withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, async (draft) => {
    const continuation = draft.continuation;
    const reuse = continuation?.planning_reuse;
    if (continuation?.kind !== "blocked-run-continuation" || reuse?.eligible !== true) throw new Error("checked continuation adoption requires reuse-eligible continuation metadata");
    adoptionAuthority = observeContinuationAdoptionAuthority(runDir, draft, options);
    const hadSteps = Array.isArray(draft.steps);
    const steps = hadSteps ? draft.steps : [];
    const priorIndex = selectCollectionItemIndex(steps, "spec-writer", "step selector", "agent");
    const priorStep = priorIndex >= 0 ? cloneJson(steps[priorIndex]) : null;
    const update = await applyCollectionItemUpdate({
      items: steps,
      selector: "spec-writer",
      selectorLabel: "step selector",
      seed: seedRunStep("spec-writer"),
      identityKey: "agent",
      updater(step) {
        step.status = "accepted";
        step.artifact_ref = "artifacts/technical-brief.md";
        step.review_ref = "reviews/spec-writer.json";
        if (!Number.isInteger(step.attempts)) step.attempts = 0;
        step.inherited_acceptance = {
          from_run_id: continuation.parent.run_id,
          parent_spec_review_ref: reuse.spec_review_ref,
          artifact_hash: reuse.spec_artifact_hash,
          review_hash: reuse.spec_review_hash,
        };
      },
    });
    stepIndex = update.index;
    if (!update.changed) return;
    if (!hadSteps) draft.steps = steps;
    assertStepIdentityAndAttempts("spec-writer", priorStep, steps[stepIndex]);
    prepareStepAcceptanceAuthority(priorStep, steps[stepIndex], { allowInheritedAcceptance: true });
    bindStepAcceptance(runDir, steps[stepIndex]);
  }, options, {
    authorizedStep: "spec-writer",
    allowInheritedAcceptance: true,
    beforeReplace: (_next, current) => assertContinuationAdoptionAuthorityCurrent(runDir, current, options, adoptionAuthority),
  }), options);
  return { ...result, step_index: stepIndex, step: stepIndex >= 0 ? result.run.steps?.[stepIndex] ?? null : null };
}

export function assertContinuationAuthorityCurrent(runDir, run, options = {}) {
  validateRun(run);
  const continuation = run.continuation;
  if (continuation?.kind !== "blocked-run-continuation") throw new Error("continuation authority requires blocked-run-continuation metadata");
  const repo = resolve(options.repoRoot || resolve(runDir, "../../.."));
  const parentFile = resolve(repo, continuation.parent.run_ref);
  assertNoSymlinkPath(repo, parentFile, "continuation parent run.json");
  if (!existsSync(parentFile)) throw new Error("continuation parent run.json is missing");
  if (hashFile(parentFile) !== continuation.parent.run_hash) throw new Error("continuation parent run.json changed since observation");
  const parentRun = validateRun(parseJsonObjectFile(parentFile, "continuation parent run.json"));
  for (const key of ["run_id", "status", "branch", "worktree"]) {
    if (continuation.parent[key] !== parentRun[key]) throw new Error(`continuation parent ${key} binding is stale`);
  }
  const branch = git(repo, ["rev-parse", "--verify", `refs/heads/${continuation.parent.branch}^{commit}`]);
  if (!branch.ok || branch.stdout.trim() !== continuation.parent.commit) throw new Error("continuation parent branch/commit binding is stale");

  const reviewSource = continuationReviewAuthority(parentRun, continuation.review.ref);
  if (!reviewSource || reviewSource.kind !== continuation.review.kind || reviewSource.source !== continuation.review.source) throw new Error("continuation selected review source is stale");
  const selectedReview = readBoundContinuationFile(parentRunDir(parentFile), continuation.review.ref, continuation.review.hash, resolveReviewRef, "selected review");
  const selectedSubject = String(selectedReview.value.subject || "").trim();
  if (!reviewSource.subjects.has(selectedSubject)) throw new Error("continuation selected review subject is cross-bound");
  const currentReview = {
    kind: reviewSource.kind,
    ref: selectedReview.ref,
    hash: selectedReview.hash,
    subject: selectedSubject,
    summary: stringValue(selectedReview.value.summary) ? String(selectedReview.value.summary).trim() : null,
    required_fixes: Array.isArray(selectedReview.value.required_fixes) ? selectedReview.value.required_fixes.filter(stringValue).map((value) => String(value).trim()) : [],
  };
  if (stringValue(selectedReview.value.verdict)) currentReview.verdict = String(selectedReview.value.verdict).trim();
  if (stringValue(reviewSource.source)) currentReview.source = reviewSource.source;
  if (!sameJson(currentReview, continuation.review)) throw new Error("continuation selected review identity is stale or cross-bound");
  const expectedSummary = `Continue blocked run '${parentRun.run_id}' from ${continuation.review.ref}.`;
  if (continuation.operator_summary !== expectedSummary) throw new Error("continuation operator_summary is stale or cross-bound");

  assertContinuationContext(parentFile, parentRun, continuation);
  assertContinuationPlanningReuse(parentFile, parentRun, continuation);
  assertContinuationPostPr(parentFile, parentRun, continuation);
  assertContinuationTarget(repo, run, parentRun, continuation);
  return { parentRun, repo, parentFile };
}

function observeContinuationAdoptionAuthority(runDir, run, options) {
  const first = assertContinuationAuthorityCurrent(runDir, run, options);
  const firstSnapshot = continuationAdoptionAuthoritySnapshot(runDir, run, first);
  const second = assertContinuationAuthorityCurrent(runDir, run, options);
  const secondSnapshot = continuationAdoptionAuthoritySnapshot(runDir, run, second);
  if (!sameJson(firstSnapshot, secondSnapshot)) throw new Error("continuation adoption authority changed during observation");
  return secondSnapshot;
}

function assertContinuationAdoptionAuthorityCurrent(runDir, run, options, observed) {
  if (!observed) throw new Error("continuation adoption authority was not observed");
  const current = observeContinuationAdoptionAuthority(runDir, run, options);
  if (!sameJson(current, observed)) throw new Error("continuation adoption authority changed before run.json replacement");
}

function continuationAdoptionAuthoritySnapshot(runDir, run, authority) {
  const continuation = run.continuation;
  const parentDir = parentRunDir(authority.parentFile);
  const reuse = continuation.planning_reuse;
  const branch = git(authority.repo, ["rev-parse", "--verify", `refs/heads/${continuation.parent.branch}^{commit}`]);
  if (!branch.ok) throw new Error("continuation parent branch/commit binding is stale");
  return {
    parent_manifest: { ref: continuation.parent.run_ref, hash: hashFile(authority.parentFile) },
    parent_branch_commit: branch.stdout.trim(),
    selected_review: hashContinuationRef(parentDir, continuation.review.ref, resolveReviewRef),
    parent_artifacts: hashContinuationRefs(parentDir, continuation.parent_artifacts, resolveArtifactRef),
    parent_evidence: hashContinuationRefs(parentDir, continuation.parent_evidence, resolveEvidenceRef),
    parent_reviews: hashContinuationRefs(parentDir, continuation.parent_reviews, resolveReviewRef),
    planning_artifact: hashContinuationRef(parentDir, reuse.spec_artifact_ref, resolveArtifactRef),
    planning_review: hashContinuationRef(parentDir, reuse.spec_review_ref, resolveReviewRef),
    child_artifact: hashContinuationRef(runDir, "artifacts/technical-brief.md", resolveArtifactRef),
    child_review: hashContinuationRef(runDir, "reviews/spec-writer.json", resolveReviewRef),
  };
}

function hashContinuationRefs(runDir, bindings, resolver) {
  return bindings.map(({ ref }) => hashContinuationRef(runDir, ref, resolver));
}

function hashContinuationRef(runDir, ref, resolver) {
  const resolved = resolver(runDir, ref);
  return { ref: resolved.ref, hash: hashFile(resolved.path) };
}

function parentRunDir(parentFile) {
  return dirname(parentFile);
}

function assertNoSymlinkPath(rootDir, targetPath, label) {
  const root = resolve(rootDir);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith("../")) throw new Error(`${label} escapes repository`);
  let current = root;
  for (const segment of rel.split("/").filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) throw new Error(`${label} must not contain symlinks`);
  }
}

function continuationReviewAuthority(parentRun, ref) {
  const subjects = new Set([parentRun.run_id, parentRun.branch, "feature-branch"].filter(stringValue).map((value) => String(value).trim()));
  const candidates = [];
  if (stringValue(parentRun.post_pr?.continuation_review?.ref)) candidates.push({ kind: "post_pr", source: "run.post_pr.continuation_review.ref", ref: normalizeContinuationRef(parentRun.post_pr.continuation_review.ref, "reviews"), subjects: new Set([parentRun.run_id]) });
  if (stringValue(parentRun.validator?.review_ref)) candidates.push({ kind: "validator", source: "run.validator.review_ref", ref: normalizeContinuationRef(parentRun.validator.review_ref, "reviews"), subjects });
  if (stringValue(parentRun.security_review?.review_ref)) candidates.push({ kind: "security_review", source: "run.security_review.review_ref", ref: normalizeContinuationRef(parentRun.security_review.review_ref, "reviews"), subjects });
  for (const step of parentRun.steps || []) if (stringValue(step?.review_ref) && stringValue(step?.agent)) candidates.push({ kind: "step", source: `run.steps.${step.agent}.review_ref`, ref: normalizeContinuationRef(step.review_ref, "reviews"), subjects: new Set([String(step.agent).trim()]) });
  for (const slice of parentRun.slices || []) if (stringValue(slice?.review_ref) && stringValue(slice?.id)) candidates.push({ kind: "slice", source: `run.slices.${slice.id}.review_ref`, ref: normalizeContinuationRef(slice.review_ref, "reviews"), subjects: new Set([String(slice.id).trim()]) });
  return candidates.find((candidate) => candidate.ref === ref) || null;
}

function readBoundContinuationFile(runDir, ref, expectedHash, resolver, label) {
  const resolved = resolver(runDir, ref);
  const actualHash = hashFile(resolved.path);
  if (actualHash !== expectedHash) throw new Error(`continuation ${label} hash mismatch`);
  return { ref, hash: actualHash, value: parseJsonObjectFile(resolved.path, `continuation ${label}`) };
}

function assertContinuationContext(parentFile, parentRun, continuation) {
  const parentDir = parentRunDir(parentFile);
  const expectedArtifacts = CONTINUATION_PARENT_ARTIFACTS.flatMap(([kind, ref]) => {
    const candidate = resolveArtifactRef(parentDir, ref, { mustExist: false });
    if (!existsSync(candidate.path)) return [];
    const resolved = resolveArtifactRef(parentDir, ref);
    return [{ kind, ref, hash: hashFile(resolved.path) }];
  }).sort((left, right) => left.ref.localeCompare(right.ref));
  const evidenceRefs = [];
  for (const step of parentRun.steps || []) if (stringValue(step?.evidence_ref)) evidenceRefs.push(step.evidence_ref);
  for (const slice of parentRun.slices || []) if (stringValue(slice?.evidence_ref)) evidenceRefs.push(slice.evidence_ref);
  if (stringValue(parentRun.post_pr?.remediation?.failure_evidence_ref)) evidenceRefs.push(parentRun.post_pr.remediation.failure_evidence_ref);
  for (const binding of parentRun.post_pr?.evidence_refs || []) if (stringValue(binding?.ref)) evidenceRefs.push(binding.ref);
  const expectedEvidence = bindUniqueContinuationRefs(parentDir, evidenceRefs, "evidence", "evidence", resolveEvidenceRef);
  const reviewRefs = [];
  for (const value of [parentRun.post_pr?.continuation_review?.ref, parentRun.validator?.review_ref, parentRun.security_review?.review_ref]) if (stringValue(value)) reviewRefs.push(value);
  for (const step of parentRun.steps || []) if (stringValue(step?.review_ref)) reviewRefs.push(step.review_ref);
  for (const slice of parentRun.slices || []) if (stringValue(slice?.review_ref)) reviewRefs.push(slice.review_ref);
  const expectedReviews = bindUniqueContinuationRefs(parentDir, reviewRefs, "reviews", "review", resolveReviewRef);
  for (const [label, expected, actual] of [
    ["parent_artifacts", expectedArtifacts, continuation.parent_artifacts],
    ["parent_evidence", expectedEvidence, continuation.parent_evidence],
    ["parent_reviews", expectedReviews, continuation.parent_reviews],
  ]) if (!sameJson(expected, actual)) throw new Error(`continuation ${label} binding is stale`);
}

function bindUniqueContinuationRefs(runDir, refs, rootName, kind, resolver) {
  return [...new Set(refs.map((ref) => normalizeContinuationRef(ref, rootName)))].sort((left, right) => left.localeCompare(right)).map((ref) => {
    const resolved = resolver(runDir, ref);
    return { kind, ref, hash: hashFile(resolved.path) };
  });
}

function normalizeContinuationRef(ref, rootName) {
  const value = String(ref).trim();
  return value.startsWith(`${rootName}/`) ? value : `${rootName}/${value}`;
}

function assertContinuationPlanningReuse(parentFile, parentRun, continuation) {
  const parentDir = parentRunDir(parentFile);
  const step = (parentRun.steps || []).find((entry) => stringValue(entry?.agent) && String(entry.agent).trim() === "spec-writer");
  const reuse = continuation.planning_reuse;
  if (reuse?.eligible === true) {
    if (step?.status !== "accepted" || !isRecord(step.acceptance)) throw new Error("continuation planning_reuse parent acceptance is stale");
    if (reuse.spec_artifact_ref !== "artifacts/technical-brief.md" || (reuse.child_spec_review_ref && reuse.child_spec_review_ref !== "reviews/spec-writer.json")) throw new Error("continuation planning_reuse target refs are stale");
    if (step.acceptance.artifact_ref !== reuse.spec_artifact_ref || step.acceptance.artifact_hash !== reuse.spec_artifact_hash
      || normalizeContinuationRef(step.acceptance.review_ref, "reviews") !== reuse.spec_review_ref || step.acceptance.review_hash !== reuse.spec_review_hash) throw new Error("continuation planning_reuse binding is stale");
    const artifact = resolveArtifactRef(parentDir, reuse.spec_artifact_ref);
    if (hashFile(artifact.path) !== reuse.spec_artifact_hash) throw new Error("continuation planning_reuse artifact bytes changed");
    const review = readBoundContinuationFile(parentDir, reuse.spec_review_ref, reuse.spec_review_hash, resolveReviewRef, "planning review");
    if (String(review.value.subject || "").trim() !== "spec-writer" || !APPROVING_CONTINUATION_REVIEW_VERDICTS.has(String(review.value.verdict || "").trim().toUpperCase())) throw new Error("continuation planning_reuse review is not approving");
  } else if (currentParentPlanningReuseEligible(parentDir, step)) {
    throw new Error("continuation planning_reuse eligibility is stale");
  }
  const draft = continuation.draft_spec_reuse;
  if (draft) {
    if (!step || step.status !== draft.parent_step_status || step.attempts !== draft.parent_step_attempts || parentRun.max_retries !== draft.max_retries || step.acceptance || step.inherited_acceptance) throw new Error("continuation draft_spec_reuse binding is stale");
    const artifact = resolveArtifactRef(parentDir, draft.artifact_ref);
    if (hashFile(artifact.path) !== draft.artifact_hash) throw new Error("continuation draft_spec_reuse artifact bytes changed");
  }
}

function currentParentPlanningReuseEligible(parentDir, step) {
  if (step?.status !== "accepted" || !isRecord(step.acceptance) || step.acceptance.artifact_ref !== "artifacts/technical-brief.md" || !stringValue(step.acceptance.review_ref)) return false;
  try {
    const artifact = resolveArtifactRef(parentDir, step.acceptance.artifact_ref);
    const review = resolveReviewRef(parentDir, step.acceptance.review_ref);
    if (hashFile(artifact.path) !== step.acceptance.artifact_hash || hashFile(review.path) !== step.acceptance.review_hash) return false;
    const reviewValue = parseJsonObjectFile(review.path, "continuation planning review");
    return String(reviewValue.subject || "").trim() === "spec-writer" && APPROVING_CONTINUATION_REVIEW_VERDICTS.has(String(reviewValue.verdict || "").trim().toUpperCase());
  } catch {
    return false;
  }
}

function assertContinuationPostPr(parentFile, parentRun, continuation) {
  const binding = continuation.post_pr;
  if (!binding) {
    if (stringValue(parentRun.pr_url)) throw new Error("continuation post_pr binding is missing");
    return;
  }
  const parentDir = parentRunDir(parentFile);
  const identity = githubPrUrlParts(parentRun.pr_url);
  if (binding.pr_url !== identity.url || binding.repository !== identity.repository || binding.pr_number !== identity.number) throw new Error("continuation post_pr PR identity is stale");
  if (binding.disposition !== "leave-unchanged" || !sameJson(binding.policy, parentRun.post_pr?.policy)) throw new Error("continuation post_pr policy binding is stale");
  const postPr = cloneJson(parentRun.post_pr);
  delete postPr.continuation_review;
  if (binding.post_pr_hash !== hashValue(postPr)) throw new Error("continuation post_pr state hash is stale");
  const evidence = readBoundContinuationFile(parentDir, binding.evidence_ref, binding.evidence_hash, resolveEvidenceRef, "post-PR evidence");
  const review = readBoundContinuationFile(parentDir, binding.continuation_review_ref, binding.continuation_review_hash, resolveReviewRef, "post-PR review");
  const latestEvidence = parentRun.post_pr?.evidence_refs?.at(-1) || { ref: parentRun.post_pr?.remediation?.failure_evidence_ref, hash: parentRun.post_pr?.remediation?.failure_evidence_hash };
  if (latestEvidence?.ref !== binding.evidence_ref || latestEvidence?.hash !== binding.evidence_hash) throw new Error("continuation post_pr latest evidence binding is stale");
  if (evidence.value.failed_head_sha !== binding.head_sha || review.value.head_sha !== binding.head_sha) throw new Error("continuation post_pr failed head binding is stale");
  if (parentRun.post_pr?.continuation_review?.ref !== binding.continuation_review_ref || parentRun.post_pr.continuation_review.hash !== binding.continuation_review_hash) throw new Error("continuation post_pr review binding is stale");
}

function assertContinuationTarget(repo, run, parentRun, continuation) {
  const target = continuation.target;
  if (run.run_id !== target.run_id || run.branch !== target.branch || run.worktree !== target.worktree || target.run_id === parentRun.run_id || target.branch !== target.run_id) throw new Error("continuation target binding is stale");
  if (target.worktree !== resolve(repo, ".opencode", "worktrees", target.run_id)) throw new Error("continuation target worktree binding is stale");
  let expectedBase;
  if (stringValue(parentRun.base_commit)) {
    const resolved = git(repo, ["rev-parse", "--verify", `${parentRun.base_commit}^{commit}`]);
    if (!resolved.ok) throw new Error("continuation target parent base commit is missing");
    expectedBase = resolved.stdout.trim();
    if (!git(repo, ["merge-base", "--is-ancestor", expectedBase, parentRun.branch]).ok) throw new Error("continuation target parent base commit is not on the parent branch");
  } else {
    const resolved = git(repo, ["rev-parse", "--verify", `${target.base_ref}^{commit}`]);
    if (!resolved.ok) throw new Error("continuation target base ref is missing");
    expectedBase = resolved.stdout.trim();
  }
  if (target.base_commit !== expectedBase) throw new Error("continuation target base binding is stale");
}

async function transitionRunStepChecked(runDir, stepSelector, updater, options, authority) {
  assertCollectionUpdater(updater, "transitionRunStep");
  let stepIndex = -1;
  const result = await withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, async (draft) => {
    const hadSteps = Array.isArray(draft.steps);
    const steps = hadSteps ? draft.steps : [];
    if (options.mustExist && !collectionHasItem(steps, stepSelector, "agent")) throw new Error(`step '${formatSelector(stepSelector)}' not found`);
    const priorIndex = selectCollectionItemIndex(steps, stepSelector, "step selector", "agent");
    const priorStep = priorIndex >= 0 ? cloneJson(steps[priorIndex]) : null;
    const update = await applyCollectionItemUpdate({ items: steps, selector: stepSelector, updater, selectorLabel: "step selector", seed: seedRunStep(stepSelector), identityKey: "agent" });
    stepIndex = update.index;
    if (!update.changed) return;
    if (!hadSteps) draft.steps = steps;
    if (stepIndex >= 0) {
      assertStepIdentityAndAttempts(stepSelector, priorStep, steps[stepIndex]);
      prepareStepAcceptanceAuthority(priorStep, steps[stepIndex], authority);
      if (["running", "accepted"].includes(steps[stepIndex]?.status) && mergedSliceRepairFence(draft)) {
        throw new Error(`step '${steps[stepIndex].agent || formatSelector(stepSelector)}' cannot advance while a merged-slice repair is unresolved`);
      }
      assertTestVerifierIntegrationGate(draft, steps[stepIndex], priorStep);
      assertDraftSpecReuseAttempt(draft, steps[stepIndex], priorStep);
      bindStepAcceptance(runDir, steps[stepIndex]);
    }
  }, options, { authorizedStep: stepIdentityForSelector(stepSelector), allowInheritedAcceptance: authority.allowInheritedAcceptance }), options);
  return { ...result, step_index: stepIndex, step: stepIndex >= 0 ? result.run.steps?.[stepIndex] ?? null : null };
}

function assertStepIdentityAndAttempts(selector, priorStep, step) {
  const expectedAgent = priorStep?.agent || stepIdentityForSelector(selector);
  if (stringValue(expectedAgent) && step?.agent !== expectedAgent) throw new Error(`step agent identity is immutable; expected '${expectedAgent}'`);
  if (Number.isInteger(priorStep?.attempts) && Number.isInteger(step?.attempts) && step.attempts < priorStep.attempts) {
    throw new Error(`step '${expectedAgent}' attempts cannot regress from ${priorStep.attempts} to ${step.attempts}`);
  }
}

function prepareStepAcceptanceAuthority(priorStep, step, authority) {
  if (step.status !== "accepted") {
    delete step.acceptance;
    delete step.inherited_acceptance;
    return;
  }
  if (!authority.allowInheritedAcceptance && !sameJson(priorStep?.inherited_acceptance ?? null, step.inherited_acceptance ?? null)) {
    throw new Error("inherited_acceptance can only be created by checked continuation adoption");
  }
  if (authority.allowInheritedAcceptance && !isRecord(step.inherited_acceptance)) {
    throw new Error("checked continuation adoption requires inherited_acceptance");
  }
}

function stepIdentityForSelector(selector) {
  if (stringValue(selector)) return selector;
  if (isRecord(selector) && stringValue(selector.agent)) return selector.agent;
  return null;
}

function assertDraftSpecReuseAttempt(run, step, priorStep) {
  const draftReuse = run.continuation?.draft_spec_reuse;
  if (!draftReuse || step?.agent !== "spec-writer" || step.status !== "running") return;
  if (run.max_retries !== draftReuse.max_retries) {
    throw new Error(`draft spec continuation must inherit max_retries ${draftReuse.max_retries}`);
  }
  if (!Number.isInteger(step.attempts) || step.attempts < 1) {
    throw new Error("draft spec continuation requires a positive spec-writer attempt number");
  }
  if (step.attempts > draftReuse.max_retries) {
    throw new Error(`draft spec continuation attempt ${step.attempts} exceeds inherited max_retries ${draftReuse.max_retries}`);
  }
  const inheritedAttempts = draftReuse.parent_step_attempts;
  const priorAttempts = Number.isInteger(priorStep?.attempts) && priorStep.attempts > inheritedAttempts
    ? priorStep.attempts
    : inheritedAttempts;
  const expectedAttempts = priorStep?.status === "running" && priorAttempts > inheritedAttempts
    ? priorAttempts
    : priorAttempts + 1;
  if (step.attempts !== expectedAttempts) {
    throw new Error(`draft spec continuation must advance from inherited attempt ${priorAttempts} to ${expectedAttempts}`);
  }
}

function assertTestVerifierIntegrationGate(run, step, priorStep) {
  if (step?.agent !== "test-verifier" || step.status !== "running") return;
  const incomplete = Array.isArray(run.slices) ? run.slices.filter((slice) => slice?.status !== "merged") : [];
  if (incomplete.length > 0) {
    throw new Error(`test-verifier integration gate requires all slices merged: ${incomplete.map((slice) => slice?.id || "unknown").join(", ")}`);
  }
  if (!Number.isInteger(step.attempts) || step.attempts < 1) {
    throw new Error("test-verifier integration gate requires a positive attempt number");
  }
  const maxAttempts = Number.isInteger(run.max_retries) ? run.max_retries : 3;
  if (step.attempts > maxAttempts) {
    throw new Error(`test-verifier integration gate attempt ${step.attempts} exceeds max_retries ${maxAttempts}`);
  }
  const priorAttempts = Number.isInteger(priorStep?.attempts) ? priorStep.attempts : 0;
  const expectedAttempts = priorStep?.status === "running" ? priorAttempts : priorAttempts + 1;
  if (step.attempts !== expectedAttempts) {
    throw new Error(`test-verifier integration gate must advance from attempt ${priorAttempts} to ${expectedAttempts}`);
  }
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
  if (!artifactRef) {
    if (step.agent === "spec-writer") throw new Error("accepted spec-writer step requires artifact_ref");
    return;
  }
  const artifactHash = tryHashDurableRef(() => resolveArtifactRef(runDir, artifactRef, { mustExist: true }));
  if (!artifactHash) throw new Error(`accepted step artifact_ref '${artifactRef}' must resolve to current bytes`);
  const acceptance = { artifact_ref: artifactRef, artifact_hash: artifactHash };
  const reviewRef = typeof step.review_ref === "string" ? step.review_ref.trim() : "";
  if (reviewRef) {
    const reviewHash = tryHashDurableRef(() => resolveReviewRef(runDir, reviewRef, { mustExist: true }));
    if (!reviewHash) throw new Error(`accepted step review_ref '${reviewRef}' must resolve to current bytes`);
    acceptance.review_ref = reviewRef;
    acceptance.review_hash = reviewHash;
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
  let priorReviewAuthority = null;
  let nextReviewAuthority = null;
  const result = await withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, async (draft, { current }) => {
    const slices = Array.isArray(draft.slices) ? draft.slices : [];
    if (!collectionHasItem(slices, sliceId, "id")) throw new Error(`slice '${formatSelector(sliceId)}' not found`);
    const priorIndex = selectCollectionItemIndex(slices, sliceId, "slice selector", "id");
    const priorSlice = cloneJson(current.slices[priorIndex]);
    const update = await applyCollectionItemUpdate({ items: slices, selector: sliceId, updater, selectorLabel: "slice selector", seed: seedRunSlice(sliceId), identityKey: "id" });
    sliceIndex = update.index;
    if (!update.changed) {
      if (priorSlice.status !== "review") return;
      if (hasCompleteBinding(priorSlice, SLICE_REVIEW_BINDING_KEYS)) {
        assertSliceReviewBindingCurrent(runDir, priorSlice.id, priorSlice);
        return;
      }
      if (TERMINAL_RUN_STATUSES.has(current.status)) return;
      nextReviewAuthority = observeSliceReviewPublicationAuthority(runDir, draft, priorSlice.id, priorSlice, options);
      Object.assign(slices[priorIndex], nextReviewAuthority.binding);
      sliceIndex = priorIndex;
    }
    if (sliceIndex >= 0 && slices[sliceIndex].status === "merged") {
      throw new Error(`slice '${slices[sliceIndex].id || formatSelector(sliceId)}' merges must use transitionSliceMerged`);
    }
    if (sliceIndex >= 0 && slices[sliceIndex].status === "running" && mergedSliceRepairFence(draft)) {
      throw new Error(`slice '${slices[sliceIndex].id || formatSelector(sliceId)}' cannot start while a merged-slice repair is unresolved`);
    }
    if (sliceIndex >= 0) {
      if (update.changed) {
        normalizeSliceTransition(priorSlice, slices[sliceIndex]);
        assertSliceTransition(runDir, priorSlice, slices[sliceIndex]);
        if (priorSlice.status === "review") priorReviewAuthority = hasCompleteBinding(priorSlice, SLICE_REVIEW_BINDING_KEYS)
          ? assertSliceReviewBindingCurrent(runDir, priorSlice.id, priorSlice)
          : observeSliceReviewSidecars(runDir, priorSlice.id, priorSlice);
        if (slices[sliceIndex].status === "review") {
          if (priorSlice.status === "review" && !hasCompleteBinding(priorSlice, SLICE_REVIEW_BINDING_KEYS)) {
            throw new Error(`legacy slice '${priorSlice.id}' review upgrade requires an exact same-status replay`);
          }
          if (priorSlice.status === "review") throw new Error(`slice '${priorSlice.id}' review binding is write-once; return to running before publishing another review`);
          assertNoBindingFields(slices[sliceIndex], SLICE_REVIEW_BINDING_KEYS, `slice '${priorSlice.id}' review binding`);
          nextReviewAuthority = observeSliceReviewPublicationAuthority(runDir, draft, slices[sliceIndex].id, slices[sliceIndex], options);
          Object.assign(slices[sliceIndex], nextReviewAuthority.binding);
        }
      }
    }
  }, options, {
    sliceTransition: true,
    beforeReplace: (next, current) => {
      const prior = current.slices?.[sliceIndex];
      const slice = next.slices?.[sliceIndex];
      if (priorReviewAuthority) assertSliceReviewAuthorityCurrent(runDir, prior.id, prior, priorReviewAuthority);
      if (nextReviewAuthority) assertSliceReviewPublicationAuthorityCurrent(runDir, next, slice.id, slice, nextReviewAuthority, options);
    },
  }), options);
  return { ...result, slice_index: sliceIndex, slice: sliceIndex >= 0 ? result.run.slices?.[sliceIndex] ?? null : null };
}

export async function transitionSliceMerged(runDir, sliceId, input = {}, options = {}) {
  if (!stringValue(sliceId)) throw new Error("transitionSliceMerged requires a slice id");
  const request = normalizeSliceMergedInput(input);
  let sliceIndex = -1;
  let mergeAuthority = null;
  let legacyUpgrade = false;
  const result = await withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, (draft) => {
    const slices = Array.isArray(draft.slices) ? draft.slices : [];
    sliceIndex = slices.findIndex((slice) => slice?.id === sliceId);
    if (sliceIndex < 0) throw new Error(`slice '${sliceId}' not found`);
    const currentSlice = slices[sliceIndex];
    if (mergedSliceRepairFence(draft)) throw new Error(`slice '${sliceId}' cannot merge while a merged-slice repair is unresolved`);
    if (currentSlice.status === "merged") {
      if (hasCompleteBinding(currentSlice, SLICE_REVIEW_BINDING_KEYS)) {
        if (!TERMINAL_RUN_STATUSES.has(draft.status) && request.merge_commit === currentSlice.merge_commit) {
          observeSliceMergeAuthority(runDir, draft, sliceId, currentSlice, request.merge_commit, options);
        }
        throw new Error(`slice '${sliceId}' is already merged`);
      }
      if (TERMINAL_RUN_STATUSES.has(draft.status)) throw new Error("legacy completed run is read-only");
      if (request.merge_commit !== currentSlice.merge_commit) throw new Error(LEGACY_MERGED_UPGRADE_ERROR);
      legacyUpgrade = true;
      try {
        mergeAuthority = observeSliceMergeAuthority(runDir, draft, sliceId, currentSlice, request.merge_commit, { ...options, allowLegacyMergedUpgrade: true });
      } catch (error) {
        throw new Error(LEGACY_MERGED_UPGRADE_ERROR, { cause: error });
      }
      Object.assign(currentSlice, mergeAuthority.review_authority.binding);
      return;
    }
    if (currentSlice.status !== "review") throw new Error(`slice '${sliceId}' can merge only from review`);
    const updatedAt = timestamp(options.now);
    mergeAuthority = observeSliceMergeAuthority(runDir, draft, sliceId, currentSlice, request.merge_commit, options);
    const nextSlice = { ...currentSlice, merge_commit: mergeAuthority.merge_commit };
    slices[sliceIndex] = {
      ...nextSlice,
      status: "merged",
      merge_commit: mergeAuthority.merge_commit,
      updated_at: updatedAt,
    };
    draft.slices = slices;
    draft.updated_at = updatedAt;
  }, options, {
    sliceTransition: true,
    beforeReplace: (next) => {
      try {
        return assertSliceMergeAuthorityCurrent(runDir, next, sliceId, next.slices[sliceIndex], mergeAuthority, options);
      } catch (error) {
        if (legacyUpgrade) throw new Error(LEGACY_MERGED_UPGRADE_ERROR, { cause: error });
        throw error;
      }
    },
  }), options);
  return { ...result, slice_index: sliceIndex, slice: sliceIndex >= 0 ? result.run.slices?.[sliceIndex] ?? null : null };
}

export async function transitionSlicesSeed(runDir, slices, options = {}) {
  const projection = normalizePendingSliceProjection(slices);
  return withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, (draft, { current }) => {
    const existing = Array.isArray(current.slices) ? current.slices : [];
    if (sameJson(existing, projection)) return;
    if (existing.some(hasSliceProgress)) {
      throw new Error("factory slices-seed refuses to replace non-pending slice progress after work has started");
    }
    draft.slices = cloneJson(projection);
  }, options, { slicesSeed: true }), options);
}

function hasSliceProgress(slice) {
  if (slice?.status !== "pending" || slice?.attempts !== 0) return true;
  return ["branch", "worktree", "evidence_ref", "review_ref", "merge_commit", "blocked_reason", "updated_at"]
    .some((key) => slice?.[key] !== undefined && slice?.[key] !== null);
}

export async function transitionPanelVerdicts(runDir, input, options = {}) {
  const request = normalizePanelVerdictInput(input);
  let authority = null;
  return withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, (draft, { current }) => {
    if (mergedSliceRepairFence(current)) throw new Error("panel verdicts are fenced while a merged-slice repair is unresolved");
    const exactReplay = panelBaseEquals(current.validator, request.validator) && panelBaseEquals(current.security_review, request.security_review);
    const legacyValidator = isRecord(current.validator) && !hasCompleteBinding(current.validator, VALIDATOR_BINDING_KEYS);
    const legacySecurity = isRecord(current.security_review) && !hasCompleteBinding(current.security_review, SECURITY_BINDING_KEYS);
    if (TERMINAL_RUN_STATUSES.has(current.status) && (legacyValidator || legacySecurity)) {
      throw new Error("legacy completed run is read-only");
    }
    if ((legacyValidator || legacySecurity)
      && (!legacyValidator || !legacySecurity || !exactReplay)) {
      throw new Error("legacy panel upgrade requires both existing rows and an exact replay");
    }
    authority = observePanelVerdictSources(runDir, current, request, options);
    if (exactReplay && hasCompleteBinding(current.validator, VALIDATOR_BINDING_KEYS)) {
      if (!sameJson(pickBinding(current.validator, VALIDATOR_BINDING_KEYS), authority.validator_binding)
        || !sameJson(pickBinding(current.security_review, SECURITY_BINDING_KEYS), authority.security_binding)) {
        throw new Error("persisted panel successor binding is stale");
      }
      if (TERMINAL_RUN_STATUSES.has(current.status)) return;
    }
    const validator = { ...cloneJson(request.validator), ...(exactReplay && current.validator?.loops !== undefined ? { loops: current.validator.loops } : {}), ...authority.validator_binding };
    const securityReview = { ...cloneJson(request.security_review), ...(exactReplay && current.security_review?.loops !== undefined ? { loops: current.security_review.loops } : {}), ...authority.security_binding };
    if (sameJson(current.validator, validator) && sameJson(current.security_review, securityReview)) return;
    draft.validator = validator;
    draft.security_review = securityReview;
  }, options, {
    panelVerdicts: true,
    beforeReplace: (_next, current) => assertPanelVerdictAuthorityCurrent(runDir, current, request, authority, options),
  }), options);
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
  if (["repairing", "review"].includes(run?.merged_slice_repair?.status)) return true;
  if (run?.status === "running" && run?.post_pr?.policy?.enabled === true && POST_PR_HEARTBEAT_PHASES.has(run.post_pr.phase)) return true;
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

  assertPostPrGenericMutation(current, nextValue, hooks);
  assertScopedAuthorityTransitions(current, nextValue, hooks);
  assertGateDecisionTransitions(current, nextValue, hooks);
  assertStepTransitions(current, nextValue, hooks);
  const next = validateRun(nextValue);
  assertRunIdentityTransition(current, next);
  assertScopedAuthorityTransitions(current, next, hooks);
  assertGateDecisionTransitions(current, next, hooks);
  assertStepTransitions(current, next, hooks);
  assertTerminalTransition(current, next, hooks);
  if (typeof hooks.beforeWrite === "function") await hooks.beforeWrite(next, current);
  const postPrPublicationAuthority = hooks.postPr === true ? observePostPrPublicationAuthority(runDir, next, options) : null;
  const repairPublicationAuthority = hooks.mergedSliceRepair === MERGED_SLICE_REPAIR_TRANSITION_AUTHORITY ? observeRepairPublicationAuthority(runDir, next, options) : null;
  const beforeReplace = hooks.beforeReplace || postPrPublicationAuthority || repairPublicationAuthority
    ? async () => {
        if (hooks.beforeReplace) await hooks.beforeReplace(next, current);
        if (postPrPublicationAuthority) assertPostPrPublicationAuthorityCurrent(runDir, next, options, postPrPublicationAuthority);
        if (repairPublicationAuthority) assertRepairPublicationAuthorityCurrent(runDir, next, options, repairPublicationAuthority);
      }
    : null;
  await writeProtectedRunJson(runDir, next, options, beforeReplace);
  return { updated: true, status: next.status, run: next };
}

function assertRunIdentityTransition(current, next) {
  for (const key of ["run_id", "base_commit", "branch"]) {
    if (current[key] !== next[key]) throw new Error(`run identity field '${key}' is immutable`);
  }
  if (current.worktree !== next.worktree) {
    throw new Error("run identity field 'worktree' is immutable outside disrupted-run recovery");
  }
}

function assertScopedAuthorityTransitions(current, next, hooks = {}) {
  if (hooks.slicesSeed !== true && hooks.sliceTransition !== true && !sameJson(current.slices, next.slices)) {
    throw new Error("run slices can only be changed by checked slice transitions");
  }
  if (hooks.panelVerdicts !== true) {
    if (!sameJson(current.validator, next.validator)) throw new Error("run validator can only be changed by the checked panel verdict transition");
    if (!sameJson(current.security_review, next.security_review)) throw new Error("run security_review can only be changed by the checked panel verdict transition");
  }
  if (hooks.mergedSliceRepair !== MERGED_SLICE_REPAIR_TRANSITION_AUTHORITY && !sameJson(current.merged_slice_repair, next.merged_slice_repair)) {
    throw new Error("run merged_slice_repair can only be changed by transitionMergedSliceRepair");
  }
  const checkedBoundaryWriter = hooks.authorizedGate !== undefined || hooks.terminal === true || hooks.prCreated === true;
  for (const key of ["boundary", "action_claim", "last_action"]) {
    if (!(key === "boundary" && checkedBoundaryWriter) && !sameJson(current.steering?.[key], next.steering?.[key])) {
      throw new Error(`run steering.${key} can only be changed by checked steering transitions`);
    }
  }
  if (hooks.prCreated !== true && current.pr_url !== next.pr_url) {
    throw new Error("run pr_url can only be changed by transitionPrCreated");
  }
  const completedAuthority = current.status === "completed" || next.status === "completed"
    || current.terminal_result?.status === "completed" || next.terminal_result?.status === "completed";
  if (hooks.prCreated !== true && hooks.postPrTerminal !== true && completedAuthority
    && (current.status !== next.status || !sameJson(current.terminal_result, next.terminal_result))) {
    throw new Error("completed status and terminal_result can only be changed by transitionPrCreated");
  }
}

async function writeProtectedRunJson(runDir, next, options = {}, beforeReplace = null) {
  const fsOps = typeof beforeReplace === "function"
    ? {
        rename: (source, destination) => {
          const observed = beforeReplace();
          if (observed && typeof observed.then === "function") return Promise.resolve(observed).then(() => rename(source, destination));
          return rename(source, destination);
        },
      }
    : undefined;
  await writeProtectedJsonAtomic(runDir, RUN_FILE, next, { hooks: options.atomicWriteHooks, fsOps });
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
  const liveness = inspectHeartbeatLiveness(heartbeat, options);
  // A live PID is not by itself proof that a long-wait heartbeat is still
  // active. Once its tick evidence is stale, the lock winner may establish a
  // fence; a queued heartbeat tick will then observe that fence and stop.
  // Other ambiguous evidence remains fail-closed.
  if (liveness.status === "absent" || liveness.reason === "stale-heartbeat") return;
  throw new Error(`${prefix}: active-heartbeat`);
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
  if (!STEERING_ACTION_KINDS.has(value)) throw new Error("action kind must be dispatch, remediation, terminal, post-pr-observe, or post-pr-push");
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
  return fence;
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
  return { ...nextGate, answer: decision.answer, pending_snapshot: cloneJson(currentGate.pending_snapshot), _handoff_answer_hash: decision.answerHash };
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

function createApprovalHandoffReceipt(_runDir, gateName, gate, run) {
  const acceptedAt = gate.answered_at;
  const receipt = {
    schema_version: 1,
    kind: "interactive-approval-handoff",
    gate: gateName,
    approval_fingerprint: "",
    pending_snapshot_hash: hashValue(gate.pending_snapshot),
    answer_hash: stringValue(gate.answer_ref) ? gate._handoff_answer_hash : hashValue(gate.answer),
    steering_generation: steeringGeneration(run),
    accepted_at: acceptedAt,
  };
  receipt.approval_fingerprint = approvalFingerprint(gateName, gate, receipt);
  return receipt;
}

function approvalFingerprint(gateName, gate, receipt) {
  return hashValue({
    gate: gateName,
    status: gate.status,
    artifact: gate.artifact,
    question_ref: gate.question_ref,
    answer_ref: gate.answer_ref || null,
    answer: gate.answer,
    approval_source: gate.approval_source,
    decision_note: gate.decision_note || null,
    answered_at: gate.answered_at,
    pending_snapshot_hash: receipt.pending_snapshot_hash,
    answer_hash: receipt.answer_hash,
    steering_generation: receipt.steering_generation,
    accepted_at: receipt.accepted_at,
  });
}

function approvedAnswerHash(runDir, gate) {
  if (stringValue(gate.answer_ref)) {
    try { return hashFile(resolveGateRef(runDir, gate.answer_ref).path, { mode: "raw" }); } catch { return null; }
  }
  return hashValue(gate.answer);
}

function validateApprovalReceiptMaterial(receipt, gateName) {
  if (receipt.schema_version !== 1 || receipt.kind !== "interactive-approval-handoff" || receipt.gate !== gateName) throw new Error("invalid receipt identity");
  for (const field of ["approval_fingerprint", "pending_snapshot_hash", "answer_hash"]) {
    if (typeof receipt[field] !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(receipt[field])) throw new Error(`invalid receipt ${field}`);
  }
  if (!Number.isInteger(receipt.steering_generation) || receipt.steering_generation < 0) throw new Error("invalid receipt steering generation");
  if (!stringValue(receipt.accepted_at) || !Number.isFinite(Date.parse(receipt.accepted_at))) throw new Error("invalid receipt accepted_at");
}

function cleanSteeringForHandoff(steering) {
  if (steering === undefined || steering === null) return true;
  if (!isRecord(steering)) return false;
  return !isRecord(steering.pending)
    && !isRecord(steering.uncheckpointed)
    && !isRecord(steering.boundary)
    && !isRecord(steering.action_claim)
    && !isRecord(steering.pr_fence);
}

function reconcileApprovedGateRedelivery(runDir, run, gateName, requested, input = {}) {
  const approved = run.gates[gateName];
  const interactive = run.mode === "interactive";
  const receiptCheck = interactive ? inspectApprovalHandoffReceipt(runDir, run, gateName) : { ok: true, receipt: null };
  if (!receiptCheck.ok) throw handoffReceiptError(receiptCheck.reason_code);
  const same = requested.status === "approved"
    && requested.artifact === approved.artifact
    && requested.question_ref === approved.question_ref
    && requested.approval_source === approved.approval_source
    && (requested.decision_note || null) === (approved.decision_note || null)
    && (!input.answeredAtExplicit || requested.answered_at === approved.answered_at)
    && (interactive
      ? exactRedeliveredAnswer(runDir, requested, approved, receiptCheck.receipt, input)
      : exactReceiptFreeRedeliveredAnswer(runDir, requested, approved, input));
  if (!same) throw handoffReceiptError("approval-snapshot-mismatch");
  return { updated: false, reason: "redelivered-approved", status: run.status, run };
}

function exactReceiptFreeRedeliveredAnswer(runDir, requested, approved, input = {}) {
  if (stringValue(requested.answer)) return input.rawAnswer === approved.answer;
  if (!stringValue(requested.answer_ref) || requested.answer_ref !== approved.pending_snapshot?.answer_ref) return false;
  try {
    return readFileSync(resolveGateRef(runDir, approved.answer_ref).path, "utf8").trim() === approved.answer;
  } catch {
    return false;
  }
}

function exactRedeliveredAnswer(runDir, requested, approved, receipt, input = {}) {
  if (stringValue(requested.answer)) return normalizeGateAnswer(receipt.gate, requested.answer) === approved.answer && hashValue(input.rawAnswer ?? requested.answer) === receipt.answer_hash;
  if (!stringValue(requested.answer_ref) || requested.answer_ref !== approved.pending_snapshot?.answer_ref) return false;
  // The ingress file is expected to have moved to the archived approved ref.
  return approvedAnswerHash(runDir, approved) === receipt.answer_hash;
}

function handoffReceiptError(code) {
  const error = new Error(code);
  error.handoffCode = code;
  return error;
}

function readGateDecisionAnswer(runDir, gateName, gate) {
  if (stringValue(gate.answer)) {
    const answer = normalizeGateAnswer(gateName, String(gate.answer).trim());
    return { answer, answerHash: hashValue(String(gate.answer)), archive: null };
  }
  const answerRef = requireNonEmptyString(gate.answer_ref, "answer_ref");
  const answer = readGateDecisionAnswerRef(runDir, gateName, answerRef);
  return {
    answer: normalizeGateAnswer(gateName, answer.text),
    answerHash: hashFile(answer.path, { mode: "raw" }),
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

async function restoreConsumedGateAnswers(archives) {
  for (const archive of [...archives].reverse()) {
    if (!existsSync(archive.toPath)) continue;
    if (existsSync(archive.fromPath)) throw new Error(`gate answer archival rollback target already exists: ${archive.fromPath}`);
    await rename(archive.toPath, archive.fromPath);
  }
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
  for (const gateName of new Set([...Object.keys(currentGates), ...Object.keys(nextGates)])) {
    if (gateName !== authorizedGate && !sameJson(currentGates[gateName] ?? null, nextGates[gateName] ?? null)) {
      errors.push({ path: `run.gates.${gateName}`, message: "gate changes must use transitionGateDecision" });
    }
  }
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

function assertStepTransitions(current, next, hooks = {}) {
  const currentSteps = Array.isArray(current.steps) ? current.steps : [];
  const nextSteps = Array.isArray(next.steps) ? next.steps : [];
  if (sameJson(currentSteps, nextSteps)) return;
  const authorizedAgent = stringValue(hooks.authorizedStep) ? hooks.authorizedStep : null;
  if (!authorizedAgent) throw new Error("step transitions must use transitionRunStep");
  const currentByAgent = new Map(currentSteps.map((step) => [step?.agent, step]));
  const nextByAgent = new Map(nextSteps.map((step) => [step?.agent, step]));
  for (const [agent, step] of currentByAgent) {
    if (agent === authorizedAgent) continue;
    if (!sameJson(step, nextByAgent.get(agent))) throw new Error(`step '${agent}' cannot be changed by transition for '${authorizedAgent}'`);
  }
  for (const agent of nextByAgent.keys()) {
    if (agent !== authorizedAgent && !currentByAgent.has(agent)) throw new Error(`step '${agent}' cannot be created by transition for '${authorizedAgent}'`);
  }
}

function initializePostPrObservation(postPr, request, now, fence) {
  if (postPr.phase !== "awaiting-pr") throw new Error(`enabled pr-created requires post_pr phase awaiting-pr, found '${postPr.phase}'`);
  if (!stringValue(request.head_sha) || !/^[0-9a-f]{40}$/u.test(request.head_sha)) throw new Error("enabled pr-created requires a full 40-character lowercase head SHA");
  const startedAt = timestamp(now);
  const deadlineAt = new Date(Date.parse(startedAt) + postPr.policy.wait_ms).toISOString();
  return {
    ...cloneJson(postPr),
    phase: "observing",
    attempt: 0,
    observation: {
      epoch: 1,
      expected_head_sha: request.head_sha,
      started_at: startedAt,
      deadline_at: deadlineAt,
      next_poll_at: startedAt,
      poll_count: 0,
      unchanged_count: 0,
      current_interval_ms: postPr.policy.initial_poll_ms,
      consecutive_transient_errors: 0,
      last_observed_at: null,
      last_fingerprint: null,
      last_check_verdict: "not_started",
      last_review_verdict: postPr.policy.review.required ? "pending" : "not_required",
      last_verdict: "pending",
      last_error: null,
      review_request: postPr.policy.review.required ? { status: "pending", attempts: 0, requested_at: null } : null,
      snapshot: null,
    },
    remediation: null,
    evidence_refs: Array.isArray(postPr.evidence_refs) ? cloneJson(postPr.evidence_refs) : [],
    continuation_review: null,
    terminal_fact: null,
    pr_operation: {
      operation_id: fence.operation_id,
      repository: fence.repository,
      created_at: fence.created_at,
      head_ref: fence.head_ref,
      head_sha: fence.head_sha,
      base_ref: fence.base_ref,
      base_sha: fence.base_sha,
      draft: fence.draft,
      pr_url: request.pr_url,
      pr_number: request.pr_number,
      pr_node_id: request.pr_node_id,
    },
  };
}

function assertPostPrMutationReady(runDir, run, options, label) {
  if (TERMINAL_RUN_STATUSES.has(run.status)) throw new Error(`${label} rejected: terminal run '${run.status}'`);
  if (run.status !== "running") throw new Error(`${label} requires a running run`);
  if (!run.post_pr?.policy?.enabled) throw new Error(`${label} requires enabled persisted post-PR policy`);
  assertSteeringBoundaryClear(run, label);
  if (isRecord(run.steering?.boundary) && !(stringValue(options.boundaryToken) && run.steering.boundary.kind === "terminal")) throw new Error(`${label} rejected: open steering boundary`);
  if (isRecord(run.steering?.pr_fence)) throw new Error(`${label} rejected: active pre-PR fence`);
  assertNoFreshHeartbeat(runDir, options, `${label} requires inactive heartbeat`);
}

function assertPostPrPhaseTransition(current, next) {
  if (!isRecord(current) || !isRecord(next)) throw new Error("post-PR transition requires current and next state");
  if (current.schema_version !== next.schema_version || !sameJson(current.policy, next.policy)) throw new Error("persisted post-PR schema and policy are immutable");
  if (current.phase === next.phase) return;
  if (!POST_PR_TRANSITIONS.get(current.phase)?.has(next.phase)) throw new Error(`invalid post-PR phase transition '${current.phase}' -> '${next.phase}'`);
  if (current.phase === "remote-confirmed" && next.phase === "observing") {
    if (next.observation?.epoch !== current.observation?.epoch + 1) throw new Error("new post-PR observation must advance epoch exactly once");
    if (next.observation?.expected_head_sha !== current.remediation?.candidate_head_sha) throw new Error("new post-PR observation must bind the confirmed candidate head");
  }
}

function assertPostPrAttemptTransition(currentRun, nextPostPr) {
  const current = currentRun.post_pr;
  if (nextPostPr.attempt !== current.attempt) throw new Error("post-PR attempt changes must use transitionPostPrFailure");
  if (nextPostPr.attempt > (Number.isInteger(currentRun.max_retries) ? currentRun.max_retries : 3)) throw new Error("post-PR attempt exceeds max_retries");
  if (isRecord(current.remediation) && nextPostPr.attempt === current.attempt && isRecord(nextPostPr.remediation)
    && current.remediation.failure_fingerprint !== nextPostPr.remediation.failure_fingerprint) throw new Error("post-PR failure fingerprint is immutable within an attempt");
}

function assertPostPrMonotonicState(current, next) {
  if (isRecord(current.pr_operation) && !sameJson(current.pr_operation, next.pr_operation)) throw new Error("post-PR PR operation identity is immutable");
  if (!isRecord(current.pr_operation) && isRecord(next.pr_operation) && current.phase !== "awaiting-pr") throw new Error("post-PR PR operation identity can be bound only at PR recording");
  const currentObservation = current.observation;
  const nextObservation = next.observation;
  if (isRecord(currentObservation) && !isRecord(nextObservation)) throw new Error("post-PR observation state cannot be removed");
  if (isRecord(currentObservation) && isRecord(nextObservation)) {
    if (nextObservation.epoch < currentObservation.epoch) throw new Error("post-PR observation epoch cannot decrease");
    if (nextObservation.epoch > currentObservation.epoch && current.phase !== "remote-confirmed") throw new Error("post-PR observation epoch can advance only after remote confirmation");
    if (nextObservation.epoch === currentObservation.epoch) {
      for (const key of ["expected_head_sha", "started_at", "deadline_at"]) {
        if (nextObservation[key] !== currentObservation[key]) throw new Error(`post-PR observation ${key} is immutable within an epoch`);
      }
      if (nextObservation.poll_count < currentObservation.poll_count) throw new Error("post-PR observation poll_count cannot decrease");
      if (dateBefore(nextObservation.last_observed_at, currentObservation.last_observed_at)) throw new Error("post-PR last_observed_at cannot move backwards");
      if (nextObservation.last_fingerprint === currentObservation.last_fingerprint && nextObservation.unchanged_count < currentObservation.unchanged_count) throw new Error("post-PR unchanged_count cannot decrease for the same fingerprint");
      if (nextObservation.last_fingerprint === currentObservation.last_fingerprint && nextObservation.current_interval_ms < currentObservation.current_interval_ms) throw new Error("post-PR poll interval cannot decrease for the same fingerprint");
      if (Date.parse(nextObservation.next_poll_at) < Date.parse(currentObservation.next_poll_at)) throw new Error("post-PR next_poll_at cannot move backwards within an epoch");
      const resultChanged = !sameJson(observationResultIdentity(currentObservation), observationResultIdentity(nextObservation));
      if (resultChanged && nextObservation.poll_count <= currentObservation.poll_count) throw new Error("post-PR observation result changes must advance poll_count");
      if (nextObservation.consecutive_transient_errors < currentObservation.consecutive_transient_errors
        && !(nextObservation.consecutive_transient_errors === 0 && nextObservation.last_error === null && resultChanged)) throw new Error("post-PR transient error counter can reset only after a valid observation");
      assertMonotonicReviewerRequest(currentObservation.review_request, nextObservation.review_request);
    }
  }
  const currentRemediation = current.remediation;
  const nextRemediation = next.remediation;
  if (isRecord(currentRemediation) && !isRecord(nextRemediation)) throw new Error("post-PR remediation identity cannot be removed");
  if (isRecord(currentRemediation) && isRecord(nextRemediation) && currentRemediation.attempt === nextRemediation.attempt) {
    for (const key of ["schema_version", "attempt", "reason_code", "failure_fingerprint", "failed_head_sha", "failure_evidence_ref", "failure_evidence_hash", "owner", "route", "lane", "baseline_head_sha"]) {
      if (!sameJson(currentRemediation[key], nextRemediation[key])) throw new Error(`post-PR remediation ${key} is immutable within an attempt`);
    }
    for (const key of ["id", "role", "subject"]) if (currentRemediation.dispatch?.[key] !== nextRemediation.dispatch?.[key]) throw new Error(`post-PR remediation dispatch.${key} is immutable within an attempt`);
    assertRankDoesNotDecrease(currentRemediation.stage, nextRemediation.stage, ["planned", "running", "changes-observed", "committed", "revalidating", "validated", "push-pending", "remote-confirmed"], "post-PR remediation stage");
    assertRankDoesNotDecrease(currentRemediation.dispatch?.status, nextRemediation.dispatch?.status, ["planned", "running", "returned"], "post-PR remediation dispatch status");
    for (const key of ["candidate_head_sha", "remediation_evidence_ref", "remediation_evidence_hash"]) assertOnceBound(currentRemediation, nextRemediation, key, `post-PR remediation ${key}`);
    for (const key of ["canonical_evidence_ref", "canonical_evidence_hash", "canonical_verdict", "validator_review_ref", "validator_review_hash", "validator_verdict", "security_review_ref", "security_review_hash", "security_verdict"]) assertOnceBound(currentRemediation.revalidation, nextRemediation.revalidation, key, `post-PR remediation revalidation.${key}`);
    if (currentRemediation.revalidation?.canonical_verdict !== "fail" && nextRemediation.revalidation?.canonical_verdict === "fail") throw new Error("new canonical verdicts must use pass or red; fail is legacy read-only state");
    for (const activity of ["canonical", "validator", "security"]) assertPostPrJobMonotonic(currentRemediation.revalidation?.jobs?.[activity], nextRemediation.revalidation?.jobs?.[activity], activity);
    for (const key of ["remote_before_sha", "local_head_sha", "remote_after_sha", "pushed_at"]) assertOnceBound(currentRemediation.push, nextRemediation.push, key, `post-PR remediation push.${key}`);
    assertRankDoesNotDecrease(currentRemediation.push?.status, nextRemediation.push?.status, ["not-ready", "pending", "confirmed"], "post-PR remediation push status");
    if (["changes-observed", "committed", "revalidating", "validated", "push-pending", "remote-confirmed"].includes(currentRemediation.stage) && !sameJson(currentRemediation.changes, nextRemediation.changes)) throw new Error("post-PR observed remediation changes are immutable");
  }
  const currentRefs = new Map((current.evidence_refs || []).map((item) => [item.ref, item.hash]));
  const nextRefs = new Map((next.evidence_refs || []).map((item) => [item.ref, item.hash]));
  for (const [ref, hash] of currentRefs) if (nextRefs.get(ref) !== hash) throw new Error("post-PR evidence bindings are append-only and immutable");
}

function assertPostPrJobMonotonic(current, next, activity) {
  if (!isRecord(current)) return;
  if (!isRecord(next)) throw new Error(`post-PR ${activity} job cannot be removed`);
  if (current.dispatch_id !== next.dispatch_id) throw new Error(`post-PR ${activity} dispatch id is immutable`);
  const transitions = { planned: new Set(["planned", "running"]), running: new Set(["running", "retry-wait", "bound"]), "retry-wait": new Set(["retry-wait", "running"]), bound: new Set(["bound"]) };
  if (!transitions[current.status]?.has(next.status)) throw new Error(`invalid post-PR ${activity} job transition '${current.status}' -> '${next.status}'`);
  for (const key of ["result_ref", "result_hash", "verdict", "returned_at"]) assertOnceBound(current, next, key, `post-PR ${activity} job ${key}`);
  assertOnceBound(current, next, "steering_generation", `post-PR ${activity} job steering_generation`);
  if (next.transient_error_count < current.transient_error_count) throw new Error(`post-PR ${activity} transient error count cannot decrease`);
}

function observationResultIdentity(observation) {
  return Object.fromEntries(["last_observed_at", "last_fingerprint", "last_check_verdict", "last_review_verdict", "last_verdict", "last_error", "snapshot"].map((key) => [key, observation?.[key] ?? null]));
}

function assertMonotonicReviewerRequest(current, next) {
  if (!isRecord(current)) return;
  if (!isRecord(next)) throw new Error("post-PR reviewer request state cannot be removed");
  assertRankDoesNotDecrease(current.status, next.status, ["pending", "requested"], "post-PR reviewer request status");
  if (next.attempts < current.attempts) throw new Error("post-PR reviewer request attempts cannot decrease");
  assertOnceBound(current, next, "requested_at", "post-PR reviewer requested_at");
}

function assertRankDoesNotDecrease(current, next, order, label) {
  const currentRank = order.indexOf(current);
  const nextRank = order.indexOf(next);
  if (currentRank >= 0 && nextRank >= 0 && nextRank < currentRank) throw new Error(`${label} cannot move backwards`);
}

function assertOnceBound(current, next, key, label) {
  if (current?.[key] !== undefined && current?.[key] !== null && next?.[key] !== current[key]) throw new Error(`${label} cannot change once bound`);
}

function dateBefore(next, current) {
  if (!stringValue(current)) return false;
  if (!stringValue(next)) return true;
  return Date.parse(next) < Date.parse(current);
}

function assertPostPrFailureSource(run, remediation) {
  const reason = remediation.reason_code;
  if (reason === "check-red") {
    if (run.post_pr.phase !== "observing") throw new Error("check-red failure requires observing phase");
    if (remediation.failed_head_sha !== run.post_pr.observation?.expected_head_sha) throw new Error("check-red failure must bind the current expected observation head");
    if (run.post_pr.observation?.last_verdict !== "red" || run.post_pr.observation?.last_check_verdict !== "red") throw new Error("check-red failure requires an explicit red check observation");
    return;
  }
  if (reason === "local-red") {
    if (run.post_pr.phase !== "revalidating") throw new Error("local-red failure requires revalidating phase");
    if (remediation.failed_head_sha !== run.post_pr.remediation?.candidate_head_sha) throw new Error("local-red failure must bind the current remediation candidate head");
    return;
  }
  throw new Error(`unsupported post-PR failure source '${reason}'`);
}

function assertPostPrFailureEvidence(runDir, run, remediation) {
  const resolved = resolveEvidenceRef(runDir, remediation.failure_evidence_ref);
  const actualHash = hashFile(resolved.path, { mode: "raw" });
  if (actualHash !== remediation.failure_evidence_hash) throw new Error("post-PR failure evidence exact-byte hash mismatch");
  const evidence = parseJsonObjectFile(resolved.path, "post-PR failure evidence");
  const expected = {
    run_id: run.run_id,
    attempt: remediation.attempt,
    source: remediation.reason_code,
    verdict: "red",
    failed_head_sha: remediation.failed_head_sha,
    failure_fingerprint: remediation.failure_fingerprint,
  };
  for (const [key, value] of Object.entries(expected)) if (evidence[key] !== value) throw new Error(`post-PR failure evidence ${key} mismatch`);
}

function assertPostPrFailureReplayContext(run, remediation) {
  if (run.post_pr.phase !== "observing") return;
  const observation = run.post_pr.observation;
  if (remediation.reason_code !== "check-red" || observation?.last_check_verdict !== "red" || observation?.expected_head_sha !== remediation.failed_head_sha) {
    throw new Error("stale post-PR failure replay does not match the current observation phase/head/source");
  }
}

function assertPostPrTerminalPreconditions(run, status, reason, input, options) {
  const postPr = run.post_pr;
  const observation = postPr.observation;
  const remediation = postPr.remediation;
  const requireObservation = (verdict) => {
    if (postPr.phase !== "observing" || observation?.last_verdict !== verdict) throw new Error(`${reason} requires observing phase with '${verdict}' verdict`);
  };
  if (reason === "post-pr-ci-green" || reason === "post-pr-draft-ci-green") {
    requireObservation("green");
    if (reason === "post-pr-draft-ci-green" && run.pr_mode !== "draft") throw new Error("post-pr-draft-ci-green requires draft PR mode");
    if (reason === "post-pr-ci-green" && run.pr_mode === "draft") throw new Error("draft PR success must use post-pr-draft-ci-green");
    return;
  }
  if (reason === "post-pr-external-merge") return requireObservation("external-merge");
  if (reason === "post-pr-pr-closed") return requireObservation("closed");
  if (reason === "post-pr-head-mismatch") return requireObservation("head-mismatch");
  if (reason === "post-pr-review-changes-requested") {
    if (postPr.phase !== "observing" || observation?.last_review_verdict !== "red") throw new Error(`${reason} requires current-head red review observation`);
    return;
  }
  if (reason === "post-pr-observation-timeout") {
    if (postPr.phase !== "observing" || Date.parse(timestamp(options.now)) < Date.parse(observation?.deadline_at || "")) throw new Error(`${reason} requires an expired observing deadline`);
    return;
  }
  if (reason === "post-pr-observer-infrastructure") {
    if (postPr.phase !== "observing" || observation?.last_verdict !== "infrastructure") throw new Error(`${reason} requires observing infrastructure verdict`);
    return;
  }
  if (reason === "post-pr-account-switch-failed") {
    if (!["observing", "push-pending"].includes(postPr.phase)) throw new Error(`${reason} requires observing or push-pending phase`);
    requirePostPrTerminalFact(reason, input.trigger_fact, "account-switch-failed");
    return;
  }
  if (reason === "post-pr-owner-ambiguous" || reason === "post-pr-metadata-unsafe") {
    const malformed = input.trigger_fact?.kind === "panel-runner-result-malformed" && postPr.phase === "revalidating";
    if (!malformed && (!['observing', 'failure-recording', 'revalidating'].includes(postPr.phase) || postPr.phase !== "revalidating" && observation?.last_verdict !== "red")) throw new Error(`${reason} requires an explicit red observation or unsafe revalidation metadata`);
    if (malformed) requirePostPrTerminalFact(reason, input.trigger_fact, "panel-runner-result-malformed");
    return;
  }
  if (reason === "post-pr-dispatch-start-unknown") {
    const activity = input.trigger_fact?.activity || "remediation";
    const running = activity === "remediation" ? postPr.phase === "remediation-running" && remediation?.dispatch?.status === "running" : postPr.phase === "revalidating" && remediation?.revalidation?.jobs?.[activity]?.status === "running";
    if (!running) throw new Error(`${reason} requires a running remediation or revalidation dispatch`);
    requirePostPrTerminalFact(reason, input.trigger_fact, "dispatch-start-unknown");
    return;
  }
  if (reason === "post-pr-path-lane-violation") {
    if (!["remediation-running", "changes-observed", "committed"].includes(postPr.phase)) throw new Error(`${reason} requires active remediation changes`);
    requirePostPrTerminalFact(reason, input.trigger_fact, "path-lane-violation");
    return;
  }
  if (reason === "post-pr-remote-head-diverged") {
    if (postPr.phase !== "push-pending" || remediation?.stage !== "push-pending") throw new Error(`${reason} requires push-pending remediation`);
    requirePostPrTerminalFact(reason, input.trigger_fact, "remote-head-diverged");
    return;
  }
  if (reason === "post-pr-push-failed") {
    if (postPr.phase !== "push-pending") throw new Error(`${reason} requires push-pending remediation`);
    requirePostPrTerminalFact(reason, input.trigger_fact, "push-failed");
    return;
  }
  if (reason === "post-pr-panel-attribution-unsafe") {
    if (postPr.phase !== "revalidating") throw new Error(`${reason} requires revalidating remediation`);
    requirePostPrTerminalFact(reason, input.trigger_fact, "panel-attribution-unsafe");
    return;
  }
  if (reason === "post-pr-retry-exhausted") {
    const max = Number.isInteger(run.max_retries) ? run.max_retries : 3;
    if (postPr.attempt !== max || !isRecord(remediation) || remediation.attempt !== max) throw new Error(`${reason} requires attempt equal to max_retries`);
    if (!["observing", "failure-recording", "revalidating"].includes(postPr.phase)) throw new Error(`${reason} requires an explicit red failure phase`);
    if (postPr.phase === "observing" && (observation?.last_check_verdict !== "red" || observation?.expected_head_sha !== remediation.candidate_head_sha)) throw new Error(`${reason} observing exhaustion requires red checks on the current candidate head`);
    if (postPr.phase === "revalidating" && !stringValue(remediation.candidate_head_sha)) throw new Error(`${reason} revalidation exhaustion requires a current candidate head`);
    if (postPr.phase === "failure-recording" && remediation.reason_code === "check-red" && (observation?.last_check_verdict !== "red" || remediation.failed_head_sha !== observation?.expected_head_sha)) throw new Error(`${reason} check exhaustion requires red checks on the expected head`);
    if (postPr.phase === "failure-recording" && remediation.reason_code === "local-red" && remediation.failed_head_sha !== remediation.baseline_head_sha) throw new Error(`${reason} local exhaustion requires the failed candidate head`);
    if (!input.continuation_review) throw new Error(`${reason} requires a continuation review binding`);
  }
}

async function observePostPrCompletedIdentity(runDir, run, reason, options = {}) {
  const operation = run.post_pr?.pr_operation;
  if (!isRecord(operation)) throw new Error("post-PR completion requires the successor PR operation identity");
  const expectedHeadSha = requireNonEmptyString(run.post_pr?.observation?.expected_head_sha, "post-PR expected head");
  const authority = observePrOperationGitAuthority(runDir, run, options, "post-PR completion");
  for (const [key, value] of Object.entries({ repository: authority.repository, head_ref: authority.head_ref, base_ref: authority.base_ref, base_sha: authority.base_sha, draft: authority.draft })) {
    if (operation[key] !== value) throw new Error(`post-PR PR operation ${key} no longer matches local/origin authority`);
  }
  if (authority.head_sha !== expectedHeadSha) throw new Error("post-PR completion requires local, worktree, origin, and expected remediation head equality");
  const stableOperationId = computePrOperationId({ base_commit: operation.base_sha, branch: operation.head_ref, created_at: operation.created_at, repository: operation.repository, run_id: run.run_id });
  if (operation.operation_id !== stableOperationId) throw new Error("post-PR operation_id is stale or malformed");
  const observation = await observeFencedPrOperation(run, operation, options, expectedHeadSha);
  const requiredDisposition = reason === "post-pr-external-merge" ? "merged" : "open";
  if (observation.disposition !== requiredDisposition) throw new Error(`post-PR completion GitHub observation is ${observation.disposition}, expected ${requiredDisposition}`);
  if (observation.pull_request.pr_url !== operation.pr_url || observation.pull_request.pr_number !== operation.pr_number || observation.pull_request.pr_node_id !== operation.pr_node_id) {
    throw new Error("post-PR completion GitHub PR identity differs from the recorded operation");
  }
  return observation.pull_request;
}

function requirePostPrTerminalFact(reason, fact, kind) {
  if (!isRecord(fact) || fact.kind !== kind) throw new Error(`${reason} requires persisted ${kind} trigger fact`);
}

function normalizedPostPrTerminalFact(reason, fact) {
  const factReasons = new Set(["post-pr-account-switch-failed", "post-pr-dispatch-start-unknown", "post-pr-path-lane-violation", "post-pr-remote-head-diverged", "post-pr-push-failed", "post-pr-panel-attribution-unsafe"]);
  if (reason === "post-pr-metadata-unsafe" && fact?.kind === "panel-runner-result-malformed") return cloneJson(fact);
  if (!factReasons.has(reason)) {
    if (fact !== undefined && fact !== null) throw new Error(`${reason} does not accept a terminal trigger fact`);
    return null;
  }
  if (!isRecord(fact)) throw new Error(`${reason} requires a terminal trigger fact`);
  return cloneJson(fact);
}

function bindPostPrContinuationReview(runDir, run, binding) {
  if (!isRecord(binding) || !stringValue(binding.ref) || !stringValue(binding.hash)) throw new Error("retry exhaustion requires continuation_review ref/hash");
  const resolved = resolveReviewRef(runDir, binding.ref);
  const actualHash = hashFile(resolved.path, { mode: "raw" });
  if (actualHash !== binding.hash) throw new Error("post-PR continuation review exact-byte hash mismatch");
  const review = parseJsonObjectFile(resolved.path, "post-PR continuation review");
  const remediation = run.post_pr.remediation;
  const latestFailure = run.post_pr.evidence_refs?.at(-1) || { ref: remediation.failure_evidence_ref, hash: remediation.failure_evidence_hash };
  const failurePath = resolveEvidenceRef(runDir, latestFailure.ref).path;
  if (hashFile(failurePath, { mode: "raw" }) !== latestFailure.hash) throw new Error("latest post-PR failure evidence hash mismatch");
  const failure = parseJsonObjectFile(failurePath, "latest post-PR failure evidence");
  if (!/^[0-9a-f]{40}$/u.test(failure.failed_head_sha || "")) throw new Error("latest post-PR failure evidence head is invalid");
  const postPrForHash = cloneJson(run.post_pr);
  delete postPrForHash.continuation_review;
  const pr = githubPrUrlParts(run.pr_url);
  const expected = {
    kind: "post-pr-continuation",
    subject: run.run_id,
    verdict: "BLOCKED",
    attempt: run.post_pr.attempt,
    reason: "post-pr-retry-exhausted",
    route: remediation.route,
    evidence_ref: remediation.failure_evidence_ref,
    evidence_hash: remediation.failure_evidence_hash,
    post_pr_hash: hashValue(postPrForHash),
    pr_url: run.pr_url,
    repository: pr.repository,
    pr_number: pr.number,
    head_sha: failure.failed_head_sha,
    pr_disposition: "leave-unchanged",
  };
  for (const [key, value] of Object.entries(expected)) if (review[key] !== value) throw new Error(`post-PR continuation review ${key} mismatch`);
  if (!stringValue(review.summary) && !(Array.isArray(review.required_fixes) && review.required_fixes.some(stringValue))) throw new Error("post-PR continuation review requires summary or required_fixes");
  return { ref: binding.ref, hash: actualHash };
}

function assertPostPrCandidateGitState(currentRun, nextPostPr, options = {}) {
  const remediation = nextPostPr.remediation;
  if (!isRecord(remediation) || !stringValue(remediation.candidate_head_sha)) return;
  if (!["committed", "revalidating", "validated", "push-pending", "remote-confirmed"].includes(remediation.stage)) return;
  const cwd = options.worktree || currentRun.worktree;
  if (!stringValue(cwd)) throw new Error("post-PR candidate verification requires run.worktree");
  const head = git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!head.ok || head.stdout.trim() !== remediation.candidate_head_sha) throw new Error("post-PR candidate head must equal local branch HEAD");
  const ancestor = git(cwd, ["merge-base", "--is-ancestor", remediation.baseline_head_sha, remediation.candidate_head_sha]);
  if (!ancestor.ok) throw new Error("post-PR candidate head must descend from baseline_head_sha");
}

function assertPostPrRefsConsistent(runDir, run) {
  const failed = postPrConsistencyChecks(runDir, run).filter((check) => !check.ok);
  if (failed.length) throw new Error(`post-PR ref/hash invariant failed: ${failed.flatMap((check) => check.errors).map((error) => error.message).join("; ")}`);
}

function assertPostPrGenericMutation(current, next, hooks = {}) {
  if (hooks.postPr === true || hooks.prCreated === true) return;
  const persisted = isRecord(current.post_pr);
  const active = current.post_pr?.policy?.enabled === true && !["disabled", "awaiting-pr", "succeeded", "blocked", "needs-human"].includes(current.post_pr.phase);
  if (persisted && !sameJson(current.post_pr, next.post_pr)) throw new Error("persisted post-PR state can only be changed by checked post-PR transitions");
  for (const key of ["pr_url", "github_account", "max_retries"]) {
    if (persisted && current[key] !== next[key]) throw new Error(`persisted post-PR ${key} can only be changed by checked lifecycle transitions`);
  }
  if (active && current.status !== next.status) throw new Error("active post-PR runs can only terminalize through transitionPostPrTerminal");
}

function assertTerminalTransition(current, next, hooks = {}) {
  if (TERMINAL_RUN_STATUSES.has(current.status)) throw new Error(`terminal run '${current.status}' cannot be mutated`);
  if (current.status === next.status) return;
  if (!TERMINAL_RUN_STATUSES.has(next.status)) return;
  if (hooks.prCreated === true || hooks.terminal === true || hooks.postPrTerminal === true) return;
  throw new Error(next.status === "completed" ? "completed terminal transitions must use transitionPrCreated" : "terminal transitions must use transitionTerminalResult");
}

function assertPrCreatedReadiness(runDir, run) {
  if (stringValue(run.pr_url)) throw new Error("pr-created requires run.pr_url to be unset");
  if (run.gates?.pre_pr?.status !== "approved") throw new Error("pr-created requires approved pre_pr gate");
  if (!PASSING_VALIDATOR_VERDICTS.has(run.validator?.verdict)) throw new Error("pr-created requires validator verdict GO or GO-WITH-NITS");
  if (!PASSING_SECURITY_VERDICTS.has(run.security_review?.verdict)) throw new Error("pr-created requires security_review verdict PASS");
  return {
    slices: assertPrCreatedSliceState(runDir, run),
    panels: assertPanelReviewBindingsCurrent(runDir, run),
  };
}

function assertPrCreatedSliceState(runDir, run) {
  const slices = Array.isArray(run.slices) ? run.slices : [];
  const unfinished = slices.filter((slice) => slice?.status !== "merged" && slice?.status !== "blocked").map((slice) => slice?.id || "<unknown>");
  if (unfinished.length > 0) throw new Error(`pr-created requires all slices to be merged or blocked; unfinished slices: ${unfinished.join(", ")}`);
  if (!slices.some((slice) => slice?.status === "merged")) throw new Error("pr-created requires at least one merged slice");
  return slices.filter((candidate) => candidate?.status === "merged").map((slice) => {
    if (!hasCompleteBinding(slice, SLICE_REVIEW_BINDING_KEYS)) throw new Error(`pr-created requires successor review binding for merged slice '${slice.id}'`);
    const observed = assertSliceReviewBindingCurrent(runDir, slice.id, slice);
    if (observed.review.verdict !== "APPROVE") throw new Error(`pr-created requires merged slice '${slice.id}' review verdict APPROVE`);
    return { id: slice.id, authority: observed };
  });
}

export function assertPanelReviewBindingsCurrent(runDir, run) {
  if (!stringValue(runDir)) throw new Error("pr-created requires run directory context");
  if (!hasCompleteBinding(run.validator, VALIDATOR_BINDING_KEYS) || !hasCompleteBinding(run.security_review, SECURITY_BINDING_KEYS)) {
    throw new Error("pr-created requires successor validator and security reviewed-head bindings");
  }
  const request = {
    validator: panelBaseRecord(run.validator, true),
    security_review: panelBaseRecord(run.security_review, false),
  };
  const observed = observePanelVerdictSources(runDir, run, request, {});
  if (!sameJson(observed.validator_binding, pickBinding(run.validator, VALIDATOR_BINDING_KEYS))) throw new Error("validator panel binding is stale");
  if (!sameJson(observed.security_binding, pickBinding(run.security_review, SECURITY_BINDING_KEYS))) throw new Error("security panel binding is stale");
  return observed;
}

function assertPrCreatedAuthorityCurrent(runDir, run, expected) {
  const current = assertPrCreatedReadiness(runDir, run);
  if (!sameJson(current, expected)) throw new Error("PR admission authority bytes changed before publication");
  return current;
}

function normalizePanelVerdictInput(input) {
  if (!isRecord(input)) throw new Error("transitionPanelVerdicts requires an input object");
  const validatorInput = input.validator;
  const securityInput = input.security_review ?? input.securityReview;
  if (!isRecord(validatorInput) || !isRecord(securityInput)) throw new Error("panel verdict transition requires validator and security_review records");
  if (Object.keys(validatorInput).some((key) => !["verdict", "report", "review_ref"].includes(key))) throw new Error("validator panel input contains unsupported fields");
  if (Object.keys(securityInput).some((key) => !["verdict", "review_ref"].includes(key))) throw new Error("security panel input contains unsupported fields");
  const validatorVerdict = requireNonEmptyString(validatorInput.verdict, "validator verdict");
  if (!["GO", "GO-WITH-NITS", "NO-GO"].includes(validatorVerdict)) throw new Error("validator verdict must be GO, GO-WITH-NITS, or NO-GO");
  const securityVerdict = requireNonEmptyString(securityInput.verdict, "security verdict");
  if (!["PASS", "BLOCK"].includes(securityVerdict)) throw new Error("security verdict must be PASS or BLOCK");
  const validatorReviewRef = validatorInput.review_ref ?? "reviews/implementation-validator.json";
  if (validatorReviewRef !== "reviews/implementation-validator.json") throw new Error("validator review_ref must be reviews/implementation-validator.json");
  return {
    validator: {
      verdict: validatorVerdict,
      report: requireNonEmptyString(validatorInput.report, "validator report"),
      review_ref: validatorReviewRef,
    },
    security_review: {
      verdict: securityVerdict,
      review_ref: requireNonEmptyString(securityInput.review_ref, "security review_ref"),
    },
  };
}

function observePanelVerdictSources(runDir, run, request, options = {}) {
  const report = resolveArtifactRef(runDir, request.validator.report);
  const reportBytes = readRegularNonEmptyFile(report.path, "validator report");
  const validatorReview = resolveReviewRef(runDir, request.validator.review_ref);
  const securityReview = resolveReviewRef(runDir, request.security_review.review_ref);
  const validatorBytes = readRegularNonEmptyFile(validatorReview.path, "validator review");
  const securityBytes = readRegularNonEmptyFile(securityReview.path, "security review");
  const validatorJson = parseJsonObjectBytes(validatorBytes, "validator review");
  const securityJson = parseJsonObjectBytes(securityBytes, "security review");
  if (validatorJson.verdict !== request.validator.verdict) throw new Error("validator review verdict must exactly match caller verdict");
  if (securityJson.verdict !== request.security_review.verdict) throw new Error("security review verdict must exactly match caller verdict");
  const integration = observeIntegrationHeadAuthority(run, { ...options, runDir }, "panel verdict publication");
  assertPanelReviewIdentity(run, validatorJson, securityJson, integration.head);
  const reportHash = sha256Bytes(reportBytes);
  const validatorHash = sha256Bytes(validatorBytes);
  const securityHash = sha256Bytes(securityBytes);
  return {
    ...authorityBytes({ report: reportBytes, validator: validatorBytes, security: securityBytes }),
    integration,
    validator_binding: { report_hash: reportHash, review_hash: validatorHash, reviewed_head_sha: integration.head },
    security_binding: { review_hash: securityHash, reviewed_head_sha: integration.head },
  };
}

function assertPanelVerdictAuthorityCurrent(runDir, run, request, expected, options = {}) {
  const current = observePanelVerdictSources(runDir, run, request, options);
  if (!sameJson(current, expected)) throw new Error("panel authority bytes changed before publication");
  return current;
}

function assertPanelReviewIdentity(run, validatorReview, securityReview, reviewedHead) {
  const validatorSubject = requireNonEmptyString(validatorReview.subject, "validator review subject");
  const securitySubject = requireNonEmptyString(securityReview.subject, "security review subject");
  if (stringValue(run.branch)) {
    if (validatorSubject !== run.branch || securitySubject !== run.branch) throw new Error("panel review subjects must equal run.branch");
  } else if (validatorSubject !== securitySubject) {
    throw new Error("branchless panel review subjects must be the same nonempty subject");
  }
  const validatorAttempt = validatorReview.attempt;
  const securityAttempt = securityReview.attempt;
  const bothMatchingPositive = Number.isInteger(validatorAttempt) && validatorAttempt > 0 && validatorAttempt === securityAttempt;
  if (!bothMatchingPositive) throw new Error("panel review attempts must be the same positive integer");
  if (validatorReview.reviewed_head_sha !== reviewedHead || securityReview.reviewed_head_sha !== reviewedHead) {
    throw new Error("panel review reviewed_head_sha values must equal the current integration head");
  }
}

function readRegularNonEmptyFile(path, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  const bytes = readFileSync(path);
  if (bytes.length === 0) throw new Error(`${label} must be nonempty`);
  return bytes;
}

function normalizeSliceMergedInput(input) {
  if (!isRecord(input)) throw new Error("transitionSliceMerged requires an input object");
  return { merge_commit: requireNonEmptyString(input.merge_commit ?? input.mergeCommit, "merge_commit") };
}

function observeSliceMergeAuthority(runDir, run, sliceId, slice, mergeCommit, options = {}) {
  const legacyUpgrade = options.allowLegacyMergedUpgrade === true;
  if (!legacyUpgrade && !hasCompleteBinding(slice, SLICE_REVIEW_BINDING_KEYS)) {
    throw new Error(`slice '${sliceId}' merge requires a successor review binding; replay the legacy review first`);
  }
  const observed = legacyUpgrade
    ? observeSliceReviewPublicationAuthority(runDir, run, sliceId, slice, options)
    : assertSliceReviewBindingCurrent(runDir, sliceId, slice);
  if (observed.review.verdict !== "APPROVE") throw new Error(`slice '${sliceId}' merge requires APPROVE review`);
  const sliceGit = legacyUpgrade ? observed.git : observeSliceHeadAuthority(runDir, run, sliceId, slice, options);
  if (sliceGit.head !== observed.binding.reviewed_commit) throw new Error(`slice '${sliceId}' current branch/worktree head differs from reviewed_commit`);
  const repository = resolveAuthorityRepository(runDir, run, options);
  if (!stringValue(repository)) throw new Error(`slice '${sliceId}' merge requires a local git repository`);
  const commitResult = authorityGit(options, repository, ["rev-parse", "--verify", `${requireNonEmptyString(mergeCommit, "merge_commit")}^{commit}`]);
  if (!commitResult.ok || !/^[0-9a-f]{40}$/u.test(commitResult.stdout.trim())) throw new Error(`slice '${sliceId}' merge commit does not resolve`);
  const canonicalCommit = commitResult.stdout.trim();
  const integrationBranch = requireNonEmptyString(run.branch, "run.branch");
  const integrationBranchResult = authorityGit(options, repository, ["rev-parse", "--verify", `refs/heads/${integrationBranch}^{commit}`]);
  if (!integrationBranchResult.ok || integrationBranchResult.stdout.trim() !== canonicalCommit) {
    throw new Error(`slice '${sliceId}' merge commit must equal current run.branch head`);
  }
  const worktree = resolve(repository, requireNonEmptyString(run.worktree, "run.worktree"));
  const checkedOut = authorityGit(options, worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!checkedOut.ok || checkedOut.stdout.trim() !== integrationBranch) throw new Error("run.worktree must be checked out on run.branch for slice merge");
  const worktreeHead = authorityGit(options, worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!worktreeHead.ok || worktreeHead.stdout.trim() !== canonicalCommit) throw new Error(`slice '${sliceId}' merge commit must equal run.worktree HEAD`);
  const cleanliness = authorityGit(options, worktree, gitCleanlinessArgs());
  if (!cleanliness.ok || cleanliness.stdout !== "") throw new Error(`slice '${sliceId}' merge requires a clean integration worktree`);
  const reviewedCommit = observed.binding.reviewed_commit;
  const proof = observeExactSliceMergeProof(repository, run, sliceId, canonicalCommit, reviewedCommit, options);
  return {
    merge_commit: canonicalCommit,
    integration_branch: integrationBranch,
    integration_branch_head: integrationBranchResult.stdout.trim(),
    worktree_head: worktreeHead.stdout.trim(),
    integration_clean: true,
    slice_branch: slice.branch,
    slice_branch_head: reviewedCommit,
    proof,
    review_authority: { ...observed, git: sliceGit },
  };
}

function assertSliceMergeAuthorityCurrent(runDir, run, sliceId, slice, expected, options = {}) {
  const current = observeSliceMergeAuthority(runDir, run, sliceId, slice, expected.merge_commit, options);
  if (!sameJson(current, expected)) throw new Error(`slice '${sliceId}' merge authority changed before publication`);
  return current;
}

function observeSliceReviewSidecars(runDir, sliceId, slice) {
  const evidence = resolveEvidenceRef(runDir, requireNonEmptyString(slice.evidence_ref, "evidence_ref"));
  const evidenceBytes = readRegularNonEmptyFile(evidence.path, `slice '${sliceId}' evidence_ref`);
  const evidenceJson = parseJsonObjectBytes(evidenceBytes, `slice '${sliceId}' evidence_ref`);
  const review = resolveReviewRef(runDir, requireNonEmptyString(slice.review_ref, "review_ref"));
  const reviewBytes = readRegularNonEmptyFile(review.path, `slice '${sliceId}' review_ref`);
  const reviewJson = parseJsonObjectBytes(reviewBytes, `slice '${sliceId}' review_ref`);
  if (evidenceJson.subject !== sliceId) throw new Error(`slice '${sliceId}' evidence subject must match slice id`);
  if (evidenceJson.status !== "pass" || evidenceJson.review_ready !== true) throw new Error(`slice '${sliceId}' evidence must be pass and review_ready`);
  if (reviewJson.subject !== sliceId) throw new Error(`slice '${sliceId}' review subject must match slice id`);
  if (!["APPROVE", "REJECT"].includes(reviewJson.verdict)) throw new Error(`slice '${sliceId}' review verdict must be APPROVE or REJECT`);
  const evidenceAttempt = evidenceJson.attempt;
  const reviewAttempt = reviewJson.attempt;
  const bothAbsent = evidenceAttempt === undefined && reviewAttempt === undefined;
  const bothMatching = Number.isInteger(evidenceAttempt) && evidenceAttempt > 0 && evidenceAttempt === reviewAttempt && evidenceAttempt === slice.attempts;
  if (!bothAbsent && !bothMatching) throw new Error(`slice '${sliceId}' evidence and review attempts must both be absent or equal slice.attempts`);
  return {
    evidence: evidenceJson,
    review: reviewJson,
    binding: {
      evidence_hash: sha256Bytes(evidenceBytes),
      review_hash: sha256Bytes(reviewBytes),
      reviewed_commit: stringValue(reviewJson.reviewed_commit) ? reviewJson.reviewed_commit : null,
    },
    ...authorityBytes({ evidence: evidenceBytes, review: reviewBytes }),
  };
}

function assertSliceReviewAuthorityCurrent(runDir, sliceId, slice, expected) {
  const current = observeSliceReviewSidecars(runDir, sliceId, slice);
  if (!sameJson(current, expected)) throw new Error(`slice '${sliceId}' review authority bytes changed before publication`);
  return current;
}

function observeSliceReviewPublicationAuthority(runDir, run, sliceId, slice, options = {}) {
  const observed = observeSliceReviewSidecars(runDir, sliceId, slice);
  const attempt = slice.attempts;
  if (!Number.isInteger(attempt) || attempt < 1 || observed.evidence.attempt !== attempt || observed.review.attempt !== attempt) {
    throw new Error(`slice '${sliceId}' successor evidence and review attempts must equal the positive slice attempt`);
  }
  const gitAuthority = observeSliceHeadAuthority(runDir, run, sliceId, slice, options);
  if (observed.evidence.head_sha !== gitAuthority.head) throw new Error(`slice '${sliceId}' evidence head_sha must equal the current slice head`);
  if (observed.review.reviewed_commit !== gitAuthority.head) throw new Error(`slice '${sliceId}' review reviewed_commit must equal the current slice head`);
  return {
    ...observed,
    binding: { ...observed.binding, reviewed_commit: gitAuthority.head },
    git: gitAuthority,
  };
}

function assertSliceReviewPublicationAuthorityCurrent(runDir, run, sliceId, slice, expected, options = {}) {
  const current = observeSliceReviewPublicationAuthority(runDir, run, sliceId, slice, options);
  if (!sameJson(current, expected)) throw new Error(`slice '${sliceId}' review authority changed before publication`);
  return current;
}

export function assertSliceReviewBindingCurrent(runDir, sliceId, slice) {
  const observed = observeSliceReviewSidecars(runDir, sliceId, slice);
  if (!hasCompleteBinding(slice, SLICE_REVIEW_BINDING_KEYS)) throw new Error(`slice '${sliceId}' successor review binding is missing`);
  if (!Number.isInteger(slice.attempts) || slice.attempts < 1 || observed.evidence.attempt !== slice.attempts || observed.review.attempt !== slice.attempts) {
    throw new Error(`slice '${sliceId}' successor sidecar attempts must equal the positive slice attempt`);
  }
  if (observed.evidence.head_sha !== slice.reviewed_commit || observed.review.reviewed_commit !== slice.reviewed_commit) {
    throw new Error(`slice '${sliceId}' successor sidecar heads must equal reviewed_commit`);
  }
  if (observed.binding.evidence_hash !== slice.evidence_hash || observed.binding.review_hash !== slice.review_hash) {
    throw new Error(`slice '${sliceId}' successor review hashes are stale`);
  }
  return { ...observed, binding: pickBinding(slice, SLICE_REVIEW_BINDING_KEYS) };
}

function observeSliceHeadAuthority(runDir, run, sliceId, slice, options = {}) {
  const repository = resolveAuthorityRepository(runDir, run, options);
  const branch = requireNonEmptyString(slice.branch, `slice '${sliceId}' branch`);
  const worktree = resolve(repository, requireNonEmptyString(slice.worktree, `slice '${sliceId}' worktree`));
  const branchResult = authorityGit(options, repository, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  if (!branchResult.ok || !/^[0-9a-f]{40}$/u.test(branchResult.stdout.trim())) throw new Error(`slice '${sliceId}' requires existing branch '${branch}'`);
  const head = branchResult.stdout.trim();
  const checkedOut = authorityGit(options, worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!checkedOut.ok || checkedOut.stdout.trim() !== branch) throw new Error(`slice '${sliceId}' worktree must be checked out on slice.branch`);
  const worktreeHead = authorityGit(options, worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!worktreeHead.ok || worktreeHead.stdout.trim() !== head) throw new Error(`slice '${sliceId}' branch and worktree heads must match`);
  const cleanliness = authorityGit(options, worktree, gitCleanlinessArgs());
  if (!cleanliness.ok || cleanliness.stdout !== "") throw new Error(`slice '${sliceId}' review requires a clean slice worktree`);
  return { repository, branch, worktree, head, clean: true };
}

function observeExactSliceMergeProof(repository, run, sliceId, mergeCommit, reviewedCommit, options = {}) {
  const proof = observeReviewedMergeProof(repository, sliceId, mergeCommit, reviewedCommit, options);
  const firstParent = proof.first_parent;
  for (const prior of Array.isArray(run.slices) ? run.slices : []) {
    if (prior?.id === sliceId || prior?.status !== "merged") continue;
    const priorMerge = requireNonEmptyString(prior.merge_commit, `prior merged slice '${prior?.id || "unknown"}' merge_commit`);
    if (!authorityGit(options, repository, ["merge-base", "--is-ancestor", priorMerge, firstParent]).ok) {
      throw new Error(`prior merged slice '${prior.id}' must be an ancestor of the new merge first parent`);
    }
  }
  return proof;
}

// Shared B0MR proof used by continuation carry-forward. The ordinary merge
// transition adds its own "all previously merged slices are ancestors" rule;
// carry-forward instead validates the already-recorded first-parent chain, whose
// actual merge order is intentionally independent of PLAN order.
export function observeReviewedMergeProof(repository, sliceId, mergeCommit, reviewedCommit, options = {}) {
  const parentsResult = authorityGit(options, repository, ["rev-list", "--parents", "-n", "1", mergeCommit]);
  if (!parentsResult.ok) throw new Error(`slice '${sliceId}' merge parents cannot be observed`);
  const parents = parentsResult.stdout.trim().split(/\s+/u);
  if (parents.length !== 3 || parents[0] !== mergeCommit) throw new Error(`slice '${sliceId}' merge commit must have exactly two ordered parents`);
  const firstParent = parents[1];
  const secondParent = parents[2];
  if (secondParent !== reviewedCommit) throw new Error(`slice '${sliceId}' merge second parent must equal reviewed_commit`);

  const basesResult = authorityGit(options, repository, ["merge-base", "--all", firstParent, reviewedCommit]);
  if (!basesResult.ok) throw new Error(`slice '${sliceId}' merge base cannot be observed`);
  const bases = basesResult.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (bases.length !== 1 || !/^[0-9a-f]{40}$/u.test(bases[0])) throw new Error(`slice '${sliceId}' merge requires exactly one full merge base`);
  const base = bases[0];
  if (base === reviewedCommit) throw new Error(`slice '${sliceId}' reviewed_commit must not be an ancestor of the merge first parent`);
  for (const commit of [firstParent, reviewedCommit]) {
    if (!authorityGit(options, repository, ["merge-base", "--is-ancestor", base, commit]).ok) {
      throw new Error(`slice '${sliceId}' merge base must be an ancestor of both parents`);
    }
  }

  const reviewedPaths = observeNoRenamePathSet(repository, base, reviewedCommit, options, `slice '${sliceId}' reviewed diff`);
  const mergedPaths = observeNoRenamePathSet(repository, firstParent, mergeCommit, options, `slice '${sliceId}' merged diff`);
  if (!sameStringSet(reviewedPaths, mergedPaths)) throw new Error(`slice '${sliceId}' merged path set must exactly equal the reviewed path set`);
  for (const path of reviewedPaths) {
    const literalPathspec = `:(literal)${path}`;
    const reviewedEntry = authorityGit(options, repository, ["ls-tree", "-z", reviewedCommit, "--", literalPathspec]);
    const mergedEntry = authorityGit(options, repository, ["ls-tree", "-z", mergeCommit, "--", literalPathspec]);
    if (!reviewedEntry.ok || !mergedEntry.ok) throw new Error(`slice '${sliceId}' tree identity cannot be observed for a reviewed path`);
    if (reviewedEntry.stdout !== mergedEntry.stdout) throw new Error(`slice '${sliceId}' merged path '${path}' differs in presence, mode, type, or object identity`);
  }

  return { first_parent: firstParent, second_parent: secondParent, merge_base: base, paths: [...reviewedPaths].sort() };
}

function observeNoRenamePathSet(repository, from, to, options, label) {
  const result = authorityGit(options, repository, ["diff", "--name-only", "-z", "--no-renames", from, to]);
  if (!result.ok) throw new Error(`${label} cannot be observed`);
  if (result.stdout === "") return new Set();
  if (!result.stdout.endsWith("\0")) throw new Error(`${label} must be NUL-delimited`);
  const paths = result.stdout.slice(0, -1).split("\0");
  if (paths.some((path) => path.length === 0) || new Set(paths).size !== paths.length) throw new Error(`${label} contains an invalid path set`);
  return new Set(paths);
}

function sameStringSet(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function assertSliceTransition(runDir, prior, next) {
  for (const key of ["id", "stack", "depends_on"]) {
    if (!sameJson(prior?.[key], next?.[key])) throw new Error(`slice ${key} is immutable`);
  }
  const transitions = {
    pending: new Set(["running", "blocked"]),
    running: new Set(["running", "review", "blocked"]),
    review: new Set(["running", "review", "blocked"]),
    merged: new Set(),
    blocked: new Set(),
  };
  if (!transitions[prior.status]?.has(next.status)) throw new Error(`slice '${prior.id}' cannot transition from ${prior.status} to ${next.status}`);
  for (const key of ["branch", "worktree"]) {
    if (stringValue(prior[key]) && prior[key] !== next[key]) throw new Error(`slice ${key} is immutable once bound`);
    if (next[key] !== undefined && !stringValue(next[key])) throw new Error(`slice ${key} must be nonempty when bound`);
  }
  if (next.status === "running" || next.status === "review" || prior.status !== "pending") {
    if (!Number.isInteger(next.attempts) || next.attempts < 1) throw new Error(`slice '${prior.id}' attempts must be positive once running`);
  } else if (!Number.isInteger(next.attempts) || next.attempts < 0) {
    throw new Error(`slice '${prior.id}' attempts must be non-negative`);
  }
  if (Number.isInteger(prior.attempts) && next.attempts < prior.attempts) throw new Error(`slice '${prior.id}' attempts cannot regress from ${prior.attempts} to ${next.attempts}`);
  if (prior.status === "review") {
    const currentReview = observeSliceReviewSidecars(runDir, prior.id, prior).review;
    const retry = next.status === "running" || next.status === "review" && !sameJson(prior, next);
    if (retry && currentReview.verdict === "REJECT" && next.attempts <= prior.attempts) throw new Error(`slice '${prior.id}' retry after REJECT requires a greater attempt`);
  }
  if (next.status === "review") observeSliceReviewSidecars(runDir, next.id, next);
  if (next.status === "blocked") {
    requireNonEmptyString(next.blocked_reason, "blocked_reason");
    for (const key of ["evidence_ref", "review_ref"]) {
      if (prior[key] !== next[key]) throw new Error(`blocked slice cannot create or change retained ${key}`);
    }
  }
}

function normalizeSliceTransition(prior, next) {
  if (next.status === "running") {
    delete next.evidence_ref;
    delete next.evidence_hash;
    delete next.review_ref;
    delete next.review_hash;
    delete next.reviewed_commit;
    delete next.merge_commit;
    delete next.blocked_reason;
    delete next.updated_at;
  } else if (next.status === "review") {
    delete next.merge_commit;
    delete next.blocked_reason;
    delete next.updated_at;
  } else if (next.status === "blocked") {
    delete next.merge_commit;
    delete next.evidence_hash;
    delete next.review_hash;
    delete next.reviewed_commit;
    delete next.updated_at;
  }
  if (prior.status === "pending" && next.status === "blocked") {
    delete next.branch;
    delete next.worktree;
  }
}

function normalizePendingSliceProjection(slices) {
  if (!Array.isArray(slices)) throw new Error("slice seed requires an array");
  const allowed = new Set(["id", "stack", "depends_on", "status", "attempts"]);
  return slices.map((slice, index) => {
    if (!isRecord(slice) || Object.keys(slice).some((key) => !allowed.has(key))) throw new Error(`slice seed entry ${index} must use the canonical pending shape`);
    requireNonEmptyString(slice.id, `slice seed entry ${index} id`);
    if (slice.status !== "pending" || slice.attempts !== 0) throw new Error(`slice seed entry ${index} must be pending with attempts=0`);
    if (!stringValue(slice.stack) || !Array.isArray(slice.depends_on)) throw new Error(`slice seed entry ${index} requires stack and depends_on`);
    return cloneJson(slice);
  });
}

// ---------------------------------------------------------------------------
// Merged-sibling repair: a bounded, first-class owner route for an integration
// defect that a consumer slice exposes in an ALREADY MERGED dependency before
// the post-merge integration gate. The merged slice's durable history stays
// immutable — the repair is its own singleton record with its own two-attempt
// budget, so it can never become a backdoor around an exhausted slice review.
// ---------------------------------------------------------------------------

const MERGED_SLICE_REPAIR_STATUSES = new Set(["reported", "repairing", "review", "merged", "blocked"]);
const MERGED_SLICE_REPAIR_MAX_ATTEMPTS = 2;
const MERGED_SLICE_REPAIR_COMMIT_PATTERN = /^[0-9a-f]{7,40}$/u;

export async function transitionMergedSliceRepair(runDir, input = {}, options = {}) {
  const request = normalizeMergedSliceRepairInput(input);
  const result = await withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, (draft) => {
    draft.merged_slice_repair = nextMergedSliceRepair(runDir, draft, draft.merged_slice_repair, request, options);
  }, options, { mergedSliceRepair: MERGED_SLICE_REPAIR_TRANSITION_AUTHORITY }), options);
  return { ...result, merged_slice_repair: result.run.merged_slice_repair ?? null };
}

function observeRepairPublicationAuthority(runDir, run, options = {}) {
  const repair = run.merged_slice_repair;
  if (!isRecord(repair)) return null;
  const files = new Map();
  const addPath = (name, path) => files.set(name, exactAuthorityFile(path));
  const addRef = (name, ref, resolver) => {
    if (stringValue(ref)) addPath(name, resolver(runDir, ref).path);
  };
  addPath("plan/slices.json", join(runDir, "plan", "slices.json"));
  addRef("original-evidence", repair.evidence_ref, resolveEvidenceRef);
  addRef("repair-evidence", repair.repair_evidence_ref, resolveEvidenceRef);
  addRef("review", repair.review_ref, resolveReviewRef);
  addRef("verification", repair.verification_ref, resolveEvidenceRef);
  const repoRoot = options.repoRoot || runDir;
  const commands = [];
  if (stringValue(run.branch) && ["repairing", "review", "merged"].includes(repair.status)) {
    commands.push(["feature-head", ["rev-parse", "--verify", `refs/heads/${run.branch}^{commit}`]]);
    commands.push(["cleanliness", gitCleanlinessArgs()]);
  }
  if (stringValue(repair.baseline_commit) && stringValue(repair.reviewed_commit)) {
    commands.push(["reviewed-ancestry", ["merge-base", "--is-ancestor", repair.baseline_commit, repair.reviewed_commit]]);
    commands.push(["reviewed-tree", ["rev-parse", "--verify", `${repair.reviewed_commit}^{tree}`]]);
    commands.push(["reviewed-diff", ["diff", "--name-only", "-z", "--no-renames", repair.baseline_commit, repair.reviewed_commit]]);
  }
  if (stringValue(repair.merge_commit)) {
    commands.push(["merge-ancestry", ["merge-base", "--is-ancestor", repair.baseline_commit, repair.merge_commit]]);
    commands.push(["merge-tree", ["rev-parse", "--verify", `${repair.merge_commit}^{tree}`]]);
    commands.push(["merge-diff", ["diff", "--name-only", "-z", "--no-renames", repair.baseline_commit, repair.merge_commit]]);
  }
  return { files: Object.fromEntries(files), git: commands.length ? observeGitPublicationAuthority(repoRoot, commands) : null };
}

function assertRepairPublicationAuthorityCurrent(runDir, run, options, expected) {
  const current = observeRepairPublicationAuthority(runDir, run, options);
  if (!sameJson(current, expected)) throw new Error("merged-slice repair authority changed before run.json publication");
}

export function activeMergedSliceRepair(run) {
  const repair = run?.merged_slice_repair;
  if (!repair || typeof repair !== "object" || Array.isArray(repair)) return null;
  return ["reported", "repairing", "review"].includes(repair.status) ? repair : null;
}

// An unresolved repair fences ALL downstream authority: slice starts and
// merges, step starts and acceptances, panel verdicts, and PR creation. Only
// a merged repair releases the fence; a blocked repair keeps it until the run
// is terminalized through the checked terminal transition, so a failed repair
// can never be bypassed by simply continuing the run.
export function mergedSliceRepairFence(run) {
  const repair = run?.merged_slice_repair;
  if (!repair || typeof repair !== "object" || Array.isArray(repair)) return null;
  return repair.status !== "merged" ? repair : null;
}

function normalizeMergedSliceRepairInput(input) {
  const status = String(input?.status || "").trim();
  if (!MERGED_SLICE_REPAIR_STATUSES.has(status)) {
    throw new Error(`merged-slice repair status must be one of ${[...MERGED_SLICE_REPAIR_STATUSES].join(", ")}`);
  }
  const request = { status };
  if (status === "reported") {
    request.owner_slice_id = requireNonEmptyString(input.owner_slice_id, "repair owner slice id");
    request.consumer_slice_id = requireNonEmptyString(input.consumer_slice_id, "repair consumer slice id");
    request.defect_path = normalizeRepairDefectPath(input.defect_path);
    request.evidence_ref = requireNonEmptyString(input.evidence_ref, "repair evidence ref");
  }
  if (status === "repairing") {
    if (!Number.isInteger(input.attempts) || input.attempts < 1) throw new Error("repair repairing requires a positive --attempts value");
    request.attempts = input.attempts;
    if (stringValue(input.branch)) request.branch = String(input.branch).trim();
    if (stringValue(input.worktree)) request.worktree = String(input.worktree).trim();
  }
  if (status === "review") {
    request.review_ref = requireNonEmptyString(input.review_ref, "repair review ref");
    request.repair_evidence_ref = requireNonEmptyString(input.repair_evidence_ref, "repair evidence ref (observed changed paths)");
    const reviewedCommit = String(input.reviewed_commit || "").trim().toLowerCase();
    if (!MERGED_SLICE_REPAIR_COMMIT_PATTERN.test(reviewedCommit)) throw new Error("repair review requires --commit with the exact repair commit under review");
    request.reviewed_commit = reviewedCommit;
  }
  if (status === "merged") {
    const commit = String(input.merge_commit || "").trim().toLowerCase();
    if (!MERGED_SLICE_REPAIR_COMMIT_PATTERN.test(commit)) throw new Error("repair merged requires --merge-commit with a git commit sha");
    request.merge_commit = commit;
    request.verification_ref = requireNonEmptyString(input.verification_ref, "repair verification ref (passing consumer reproduction)");
  }
  if (status === "blocked") request.reason = requireNonEmptyString(input.reason, "repair blocked reason");
  return request;
}

function normalizeRepairDefectPath(value) {
  const path = requireNonEmptyString(value, "repair defect path");
  try {
    return normalizeRepositoryPath(path);
  } catch {
    throw new Error("repair defect path must be a safe repository-relative path");
  }
}

function nextMergedSliceRepair(runDir, run, current, request, options = {}) {
  if (current && !["reported", "repairing", "review", "merged", "blocked"].includes(current.status)) {
    throw new Error("existing merged-slice repair record is invalid");
  }
  if (current && ["merged", "blocked"].includes(current.status)) {
    throw new Error(`merged-slice repair is terminal ('${current.status}'); a further defect requires a recovery run`);
  }
  const stampedAt = timestamp(options.now);
  if (request.status === "reported") return reportedMergedSliceRepair(runDir, run, current, request, stampedAt);
  if (!current) throw new Error("merged-slice repair must be reported before any other transition");
  if (request.status === "repairing") return repairingMergedSliceRepair(runDir, run, current, request, stampedAt, options);
  if (request.status === "review") return reviewMergedSliceRepair(runDir, current, request, stampedAt, options);
  if (request.status === "merged") return mergedMergedSliceRepair(runDir, run, current, request, stampedAt, options);
  return { ...current, status: "blocked", reason: request.reason, updated_at: stampedAt };
}

function reportedMergedSliceRepair(runDir, run, current, request, stampedAt) {
  if (current) throw new Error("only one merged-slice repair incident is allowed per run");
  assertRepairAdmissionWindow(run);
  const slices = Array.isArray(run.slices) ? run.slices : [];
  const owner = slices.find((slice) => slice?.id === request.owner_slice_id);
  if (!owner) throw new Error(`repair owner slice '${request.owner_slice_id}' not found`);
  if (owner.status !== "merged") throw new Error(`repair owner slice '${request.owner_slice_id}' must be merged; it is '${owner.status}'`);
  const consumer = slices.find((slice) => slice?.id === request.consumer_slice_id);
  if (!consumer) throw new Error(`repair consumer slice '${request.consumer_slice_id}' not found`);
  if (consumer.status === "merged") {
    throw new Error(`repair consumer slice '${consumer.id}' is already merged; a post-merge defect belongs to the integration gate, not a repair`);
  }
  if (consumer.id === owner.id) throw new Error("repair consumer and owner must be different slices");
  const consumerDeps = Array.isArray(consumer.depends_on) ? consumer.depends_on : [];
  if (!consumerDeps.includes(owner.id)) {
    throw new Error(`repair consumer '${consumer.id}' must directly depend on owner '${owner.id}'`);
  }
  // Owner-lane authority is bound at report time: every later transition
  // re-verifies plan/slices.json against this hash, so the lane can never be
  // widened, narrowed, or replaced mid-incident.
  const planHash = hashFile(join(runDir, "plan", "slices.json"));
  assertRepairPathInOwnerLane(runDir, owner.id, request.defect_path, planHash);
  const evidence = resolveEvidenceRef(runDir, request.evidence_ref);
  const evidenceJson = parseJsonObjectFile(evidence.path, "repair evidence_ref");
  if (evidenceJson.subject !== consumer.id) {
    throw new Error("repair evidence subject must equal the consumer slice id");
  }
  if (evidenceJson.status !== "fail") {
    throw new Error("repair reproduction evidence must record an observed failing consumer run (status \"fail\")");
  }
  return {
    schema_version: 1,
    plan_hash: planHash,
    owner_slice_id: owner.id,
    consumer_slice_id: consumer.id,
    defect_path: request.defect_path,
    evidence_ref: request.evidence_ref,
    evidence_hash: hashFile(evidence.path),
    status: "reported",
    attempts: 0,
    max_attempts: MERGED_SLICE_REPAIR_MAX_ATTEMPTS,
    created_at: stampedAt,
    updated_at: stampedAt,
  };
}

function repairingMergedSliceRepair(runDir, run, current, request, stampedAt, options = {}) {
  if (!["reported", "review"].includes(current.status)) {
    throw new Error(`repair cannot start an attempt from status '${current.status}'`);
  }
  assertRepairQuiescence(run, "start a repair attempt");
  if (request.attempts !== current.attempts + 1) {
    throw new Error(`repair attempt must advance from ${current.attempts} to ${current.attempts + 1}`);
  }
  if (request.attempts > MERGED_SLICE_REPAIR_MAX_ATTEMPTS) {
    throw new Error(`repair attempt ${request.attempts} exceeds max_attempts ${MERGED_SLICE_REPAIR_MAX_ATTEMPTS}; block and require a recovery run`);
  }
  if (current.status === "review") {
    const review = readBoundRepairReview(runDir, current);
    if (review.verdict !== "REJECT") throw new Error("a further repair attempt requires a REJECT verdict on the prior repair review");
    const reviewedCommit = requireNonEmptyString(current.reviewed_commit, "repair reviewed_commit");
    assertRepairReviewBinding(review, current.attempts, reviewedCommit);
    const baseline = requireNonEmptyString(current.baseline_commit, "repair baseline_commit");
    if (baseline === reviewedCommit) throw new Error("rejected repair review must bind work after the observed attempt baseline");
    const repoRoot = options.repoRoot || runDir;
    if (!git(repoRoot, ["merge-base", "--is-ancestor", baseline, reviewedCommit]).ok) throw new Error("rejected repair review no longer contains its observed attempt baseline");
  }
  assertRepairOriginalEvidenceIntact(runDir, current);
  // Observe the feature head as the attempt baseline: the eventual merge must
  // prove it contains new work on top of exactly this commit.
  const repoRoot = options.repoRoot || runDir;
  const featureBranch = requireNonEmptyString(run.branch, "run branch");
  const baselineResult = git(repoRoot, ["rev-parse", "--verify", `refs/heads/${featureBranch}^{commit}`]);
  if (!baselineResult.ok) {
    throw new Error(`feature branch '${featureBranch}' head does not resolve; a repair attempt requires an observed baseline`);
  }
  const next = { ...current, status: "repairing", attempts: request.attempts, baseline_commit: baselineResult.stdout.trim(), updated_at: stampedAt };
  // A fresh attempt has no bound review yet; the commit binding is per-attempt.
  delete next.reviewed_commit;
  if (request.branch) next.branch = request.branch;
  if (request.worktree) next.worktree = request.worktree;
  return next;
}

function assertRepairOriginalEvidenceIntact(runDir, current) {
  const evidence = resolveEvidenceRef(runDir, requireNonEmptyString(current.evidence_ref, "repair evidence_ref"));
  if (hashFile(evidence.path) !== current.evidence_hash) {
    throw new Error("repair reproduction evidence no longer matches its hash-bound record");
  }
}

function reviewMergedSliceRepair(runDir, current, request, stampedAt, options = {}) {
  // Recording a review from `review` again is allowed ONLY as a byte-identical
  // idempotent re-record (crash recovery). The binding is write-once per
  // attempt: a bound REJECT can never be replaced by a different review — a
  // corrected verdict requires the next repair attempt.
  if (!["repairing", "review"].includes(current.status)) throw new Error(`repair review requires status 'repairing'; it is '${current.status}'`);
  assertRepairOriginalEvidenceIntact(runDir, current);
  const repoRoot = options.repoRoot || runDir;
  const commitResult = git(repoRoot, ["rev-parse", "--verify", `${request.reviewed_commit}^{commit}`]);
  if (!commitResult.ok) throw new Error(`repair reviewed commit '${request.reviewed_commit}' does not resolve in the repository`);
  const reviewedSha = commitResult.stdout.trim();
  const review = resolveReviewRef(runDir, request.review_ref);
  const reviewHash = hashFile(review.path);
  if (current.status === "review") {
    if (request.review_ref !== current.review_ref || reviewHash !== current.review_hash || reviewedSha !== current.reviewed_commit) {
      throw new Error("repair review binding is write-once per attempt; a different review requires the next repair attempt");
    }
    return { ...current, updated_at: stampedAt };
  }
  // The review binds the exact commit whose bytes the reviewer saw: the
  // baseline must be a proper ancestor, and the observed diff — with both
  // sides of any rename visible — must stay inside the owner's bound lane.
  const baseline = requireNonEmptyString(current.baseline_commit, "repair baseline_commit");
  if (reviewedSha === baseline) throw new Error("repair reviewed commit must contain new work on top of the observed attempt baseline");
  const baselineContained = git(repoRoot, ["merge-base", "--is-ancestor", baseline, reviewedSha]);
  if (!baselineContained.ok) throw new Error("repair reviewed commit must contain the observed attempt baseline");
  const observedPaths = observeRepairChangedPaths(repoRoot, baseline, reviewedSha);
  for (const observedPath of observedPaths) {
    assertRepairPathInOwnerLane(runDir, current.owner_slice_id, normalizeRepairDefectPath(observedPath), current.plan_hash);
  }
  const reviewJson = parseJsonObjectFile(review.path, "repair review_ref");
  if (reviewJson.subject !== `repair:${current.owner_slice_id}`) {
    throw new Error(`repair review subject must be 'repair:${current.owner_slice_id}'`);
  }
  if (!["APPROVE", "REJECT"].includes(reviewJson.verdict)) throw new Error("repair review verdict must be APPROVE or REJECT");
  if (reviewJson.verdict === "REJECT") {
    const fixes = Array.isArray(reviewJson.required_fixes) ? reviewJson.required_fixes.filter(stringValue) : [];
    if (fixes.length < 1) throw new Error("a rejecting repair review must enumerate finite required_fixes");
  }
  // The independent review artifact must itself bind what was reviewed: a
  // stale verdict written for another attempt or commit can never be
  // re-paired with code the reviewer did not see.
  assertRepairReviewBinding(reviewJson, current.attempts, reviewedSha);
  const repairEvidence = assertRepairChangedPathsInOwnerLane(runDir, current, request.repair_evidence_ref, observedPaths);
  return {
    ...current,
    status: "review",
    review_ref: request.review_ref,
    review_hash: reviewHash,
    reviewed_commit: reviewedSha,
    repair_evidence_ref: request.repair_evidence_ref,
    repair_evidence_hash: repairEvidence.hash,
    updated_at: stampedAt,
  };
}

function assertRepairReviewBinding(reviewJson, attempts, reviewedSha) {
  if (reviewJson.attempt !== attempts) {
    throw new Error(`repair review must bind attempt ${attempts}; it records ${Number.isInteger(reviewJson.attempt) ? reviewJson.attempt : "no attempt"}`);
  }
  if (String(reviewJson.commit || "").trim().toLowerCase() !== reviewedSha) {
    throw new Error("repair review must bind the exact reviewed commit; the recorded commit does not match the observed repair");
  }
}

// Diffs are observed with rename detection disabled so a rename's out-of-lane
// source stays visible as a deletion instead of hiding behind an in-lane
// destination.
function observeRepairChangedPaths(repoRoot, fromCommit, toCommit) {
  const diffResult = git(repoRoot, ["diff", "--name-only", "-z", "--no-renames", fromCommit, toCommit]);
  if (!diffResult.ok) throw new Error("repair diff against the attempt baseline is not observable");
  const paths = diffResult.stdout.split("\0").filter((path) => path !== "");
  if (paths.length < 1) throw new Error("repair must contain observable changes on top of the attempt baseline");
  return paths;
}

// Lane confinement is observed, not declared: the orchestrator records the
// repair diff's actual changed paths as evidence, every one of them must fall
// inside the owner's bound plan lane, and the recorded list must equal the
// git-observed diff — a claim that diverges from git is rejected outright.
function assertRepairChangedPathsInOwnerLane(runDir, current, evidenceRef, observedPaths) {
  const evidence = resolveEvidenceRef(runDir, evidenceRef);
  const evidenceJson = parseJsonObjectFile(evidence.path, "repair evidence_ref");
  if (evidenceJson.subject !== `repair:${current.owner_slice_id}`) {
    throw new Error(`repair attempt evidence subject must be 'repair:${current.owner_slice_id}'`);
  }
  const changedPaths = Array.isArray(evidenceJson.changed_paths) ? evidenceJson.changed_paths.filter(stringValue) : [];
  if (changedPaths.length < 1 || changedPaths.length !== (evidenceJson.changed_paths || []).length) {
    throw new Error("repair attempt evidence must record the observed non-empty changed_paths list");
  }
  for (const changedPath of changedPaths) {
    assertRepairPathInOwnerLane(runDir, current.owner_slice_id, normalizeRepairDefectPath(changedPath), current.plan_hash);
  }
  const recorded = [...new Set(changedPaths.map((path) => normalizeRepairDefectPath(path)))].sort();
  const observed = [...new Set(observedPaths)].sort();
  if (recorded.length !== observed.length || recorded.some((path, index) => path !== observed[index])) {
    throw new Error("repair attempt evidence changed_paths must equal the git-observed diff against the attempt baseline");
  }
  return { hash: hashFile(evidence.path) };
}

function mergedMergedSliceRepair(runDir, run, current, request, stampedAt, options = {}) {
  if (current.status !== "review") throw new Error(`repair merge requires status 'review'; it is '${current.status}'`);
  assertRepairQuiescence(run, "merge a repair");
  assertRepairOriginalEvidenceIntact(runDir, current);
  const review = readBoundRepairReview(runDir, current);
  if (review.verdict !== "APPROVE") throw new Error("repair merge requires an APPROVE verdict on the bound repair review");
  assertRepairReviewBinding(review, current.attempts, requireNonEmptyString(current.reviewed_commit, "repair reviewed_commit"));
  const repairEvidence = resolveEvidenceRef(runDir, requireNonEmptyString(current.repair_evidence_ref, "repair_evidence_ref"));
  if (hashFile(repairEvidence.path) !== current.repair_evidence_hash) {
    throw new Error("repair attempt evidence no longer matches its hash-bound record");
  }
  // The merge commit must actually exist in this repository, be contained in
  // the feature branch, BE the resulting feature head, and prove it contains
  // the repair: new work on top of the baseline observed when the attempt
  // started, whose entire observed diff stays inside the owner's lane.
  const repoRoot = options.repoRoot || runDir;
  const featureBranch = requireNonEmptyString(run.branch, "run branch");
  const commitResult = git(repoRoot, ["rev-parse", "--verify", `${request.merge_commit}^{commit}`]);
  if (!commitResult.ok) throw new Error(`repair merge commit '${request.merge_commit}' does not resolve in the repository`);
  const mergeSha = commitResult.stdout.trim();
  const ancestryResult = git(repoRoot, ["merge-base", "--is-ancestor", mergeSha, `refs/heads/${featureBranch}`]);
  if (!ancestryResult.ok) throw new Error(`repair merge commit '${request.merge_commit}' is not contained in feature branch '${featureBranch}'`);
  const headResult = git(repoRoot, ["rev-parse", "--verify", `refs/heads/${featureBranch}^{commit}`]);
  if (!headResult.ok) throw new Error(`feature branch '${featureBranch}' head does not resolve in the repository`);
  if (headResult.stdout.trim() !== mergeSha) {
    throw new Error(`repair merge commit '${request.merge_commit}' must be the resulting head of feature branch '${featureBranch}'`);
  }
  const baseline = requireNonEmptyString(current.baseline_commit, "repair baseline_commit");
  if (mergeSha === baseline) {
    throw new Error("repair merge commit must contain new work on top of the observed attempt baseline");
  }
  const baselineContained = git(repoRoot, ["merge-base", "--is-ancestor", baseline, mergeSha]);
  if (!baselineContained.ok) {
    throw new Error("repair merge commit must contain the observed attempt baseline; the feature branch history no longer matches it");
  }
  // The bytes merged must be exactly the bytes reviewed: the resulting tree
  // must equal the bound reviewed commit's tree, so nothing can be appended
  // between APPROVE and merge.
  const reviewedSha = requireNonEmptyString(current.reviewed_commit, "repair reviewed_commit");
  const mergeTree = git(repoRoot, ["rev-parse", "--verify", `${mergeSha}^{tree}`]);
  const reviewedTree = git(repoRoot, ["rev-parse", "--verify", `${reviewedSha}^{tree}`]);
  if (!mergeTree.ok || !reviewedTree.ok || mergeTree.stdout.trim() !== reviewedTree.stdout.trim()) {
    throw new Error("repair merge must carry exactly the reviewed tree; changes after the bound review require the next attempt");
  }
  const mergedPaths = observeRepairChangedPaths(repoRoot, baseline, mergeSha);
  for (const mergedPath of mergedPaths) {
    assertRepairPathInOwnerLane(runDir, current.owner_slice_id, normalizeRepairDefectPath(mergedPath), current.plan_hash);
  }
  // The original consumer reproduction must now pass, on observed evidence.
  const verification = resolveEvidenceRef(runDir, request.verification_ref);
  const verificationJson = parseJsonObjectFile(verification.path, "repair verification_ref");
  if (verificationJson.subject !== current.consumer_slice_id) {
    throw new Error("repair verification evidence subject must equal the consumer slice id");
  }
  if (verificationJson.status !== "pass") {
    throw new Error("repair verification evidence must record the consumer reproduction passing after the repair");
  }
  return {
    ...current,
    status: "merged",
    merge_commit: mergeSha,
    verification_ref: request.verification_ref,
    verification_hash: hashFile(verification.path),
    updated_at: stampedAt,
  };
}

function readBoundRepairReview(runDir, current) {
  const review = resolveReviewRef(runDir, requireNonEmptyString(current.review_ref, "repair review_ref"));
  if (hashFile(review.path) !== current.review_hash) {
    throw new Error("repair review no longer matches its hash-bound record");
  }
  return parseJsonObjectFile(review.path, "repair review_ref");
}

// A repair is admissible only in the documented pre-integration window: once
// any downstream authority exists (integration gate started or decided, panel
// verdicts, Gate 3, a created PR, or post-PR state), stale acceptance could be
// silently reused after the repair, so reporting fails closed instead.
function assertRepairAdmissionWindow(run) {
  if (run?.status !== "running") throw new Error(`repair can be reported only on a running run; it is '${run?.status}'`);
  const testVerifier = (Array.isArray(run.steps) ? run.steps : []).find((step) => step?.agent === "test-verifier");
  const verifierStarted = testVerifier && (["running", "accepted"].includes(testVerifier.status) || (Number.isInteger(testVerifier.attempts) && testVerifier.attempts > 0));
  if (verifierStarted) throw new Error("repair cannot be reported after the test-verifier integration gate has started; its authority would go stale");
  if (run.validator || run.security_review) throw new Error("repair cannot be reported after panel verdicts exist; their authority would go stale");
  if (run.gates && typeof run.gates === "object" && run.gates.pre_pr) throw new Error("repair cannot be reported after Gate 3 state exists; its authority would go stale");
  if (stringValue(run.pr_url)) throw new Error("repair cannot be reported after a PR exists");
  if (postPrAuthorityExists(run.post_pr)) throw new Error("repair cannot be reported after post-PR authority exists");
}

// The plugin persists the effective post-PR policy on every run, so a bare
// pre-PR record (phase disabled/awaiting-pr, no attempts, no observation or
// remediation or terminal fact) is normal state, not downstream authority.
function postPrAuthorityExists(postPr) {
  if (!postPr || typeof postPr !== "object" || Array.isArray(postPr)) return false;
  if (!["disabled", "awaiting-pr"].includes(postPr.phase)) return true;
  if (Number.isInteger(postPr.attempt) && postPr.attempt > 0) return true;
  if (Array.isArray(postPr.evidence_refs) && postPr.evidence_refs.length > 0) return true;
  return Boolean(postPr.observation || postPr.remediation || postPr.terminal_fact || postPr.continuation_review);
}

function assertRepairQuiescence(run, action) {
  const busy = (Array.isArray(run.slices) ? run.slices : []).find((slice) => ["running", "review"].includes(slice?.status));
  if (busy) throw new Error(`cannot ${action} while slice '${busy.id}' is ${busy.status}; quiesce slice work first`);
}

function assertRepairPathInOwnerLane(runDir, ownerSliceId, defectPath, expectedPlanHash) {
  const planPath = join(runDir, "plan", "slices.json");
  if (requireNonEmptyString(expectedPlanHash, "repair plan_hash") !== hashFile(planPath)) {
    throw new Error("plan/slices.json no longer matches the lane authority bound when the repair was reported");
  }
  const plan = parseJsonObjectFile(planPath, "plan/slices.json");
  const planned = (Array.isArray(plan.slices) ? plan.slices : []).find((slice) => slice?.id === ownerSliceId);
  if (!planned) throw new Error(`repair owner slice '${ownerSliceId}' is missing from plan/slices.json`);
  let lanes;
  try {
    lanes = (Array.isArray(planned.paths) ? planned.paths : []).map((lane) => validatePlanPath(lane));
  } catch {
    throw new Error(`repair owner slice '${ownerSliceId}' plan lanes are not valid repository paths`);
  }
  if (!lanes.filter(Boolean).some((lane) => repairPathWithinLane(defectPath, lane))) {
    throw new Error(`repair defect path '${defectPath}' is outside owner slice '${ownerSliceId}' lanes`);
  }
}

// Lane matching reuses the canonical plan-path grammar (post-pr-ci
// validatePlanPath/sliceOwnsPath): a lane is either `<dir>/**` or an exact
// file path, lane text is never locally normalized, and any other shape
// matches nothing.
function repairPathWithinLane(path, lane) {
  return lane.endsWith("/**") ? path.startsWith(lane.slice(0, -2)) : path === lane;
}

function normalizePrCreatedTerminalResult(run, request, operation, overrides = {}) {
  return {
    status: "completed",
    run_id: run.run_id,
    pr_url: request.pr_url,
    pr_number: request.pr_number,
    pr_node_id: request.pr_node_id,
    repository: request.repository,
    operation_id: operation.operation_id,
    head_ref: request.head_ref,
    head_sha: request.head_sha,
    base_ref: request.base_ref,
    base_sha: request.base_sha,
    draft: request.draft,
    reason: overrides.reason ?? null,
    summary: overrides.summary ?? (request.draft ? "Draft PR created." : "PR created."),
    artifacts: isRecord(overrides.artifacts) ? cloneJson(overrides.artifacts) : {},
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

function parseJsonObjectBytes(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function authorityBytes(entries) {
  return Object.fromEntries(Object.entries(entries).map(([key, bytes]) => [`${key}_bytes`, bytes.toString("base64")]));
}

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hasCompleteBinding(value, keys) {
  return keys.every((key) => value?.[key] !== undefined && value?.[key] !== null);
}

function pickBinding(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function assertNoBindingFields(value, keys, label) {
  if (keys.some((key) => value?.[key] !== undefined && value?.[key] !== null)) throw new Error(`${label} is computed by the checked transition`);
}

function panelBaseRecord(value, validator) {
  return validator
    ? { verdict: value.verdict, report: value.report, review_ref: value.review_ref }
    : { verdict: value.verdict, review_ref: value.review_ref };
}

function panelBaseEquals(left, right) {
  if (!isRecord(left) || !isRecord(right)) return false;
  return left.verdict === right.verdict && left.report === right.report && left.review_ref === right.review_ref;
}

function resolveAuthorityRepository(runDir, run, options = {}) {
  if (stringValue(options.repoRoot)) return resolve(options.repoRoot);
  const probeCwd = stringValue(runDir) ? runDir : run?.worktree;
  const result = authorityGit(options, probeCwd, ["rev-parse", "--show-toplevel"]);
  if (!result.ok || !stringValue(result.stdout)) throw new Error("reviewed-code authority requires a local git repository");
  return result.stdout.trim();
}

function observePrOperationGitAuthority(runDir, run, options = {}, label = "PR operation") {
  const integration = observeIntegrationHeadAuthority(run, { ...options, runDir }, `${label} authority`);
  const origin = authorityGit(options, integration.repository, ["config", "--get", "remote.origin.url"]);
  if (!origin.ok || !stringValue(origin.stdout) || origin.stdout.trim().includes("\n")) throw new Error(`${label} requires exactly one canonical GitHub origin`);
  const repository = canonicalGithubRepositoryFromOrigin(origin.stdout.trim());
  const headRef = requireNonEmptyString(run.branch, "run.branch");
  const baseRef = requireNonEmptyString(run.base_ref, "run.base_ref");
  if (!run.pr_mode || !["draft", "ready"].includes(run.pr_mode)) throw new Error(`${label} requires persisted run.pr_mode`);
  const headSha = observeExactRemoteHead(options, integration.repository, headRef, label);
  const baseSha = observeExactRemoteHead(options, integration.repository, baseRef, label);
  if (headSha !== integration.head) throw new Error(`${label} requires local, worktree, and origin head equality`);
  if (requireNonEmptyString(run.base_commit, "run.base_commit") !== baseSha) throw new Error(`${label} requires run.base_commit equal to the exact origin base head`);
  if (!authorityGit(options, integration.repository, ["merge-base", "--is-ancestor", baseSha, headSha]).ok) throw new Error(`${label} requires the origin base to be an ancestor of the origin head`);
  return { repository, origin: origin.stdout.trim(), head_ref: headRef, head_sha: headSha, base_ref: baseRef, base_sha: baseSha, draft: run.pr_mode === "draft", integration };
}

function observeExactRemoteHead(options, repository, ref, label) {
  const result = authorityGit(options, repository, ["ls-remote", "--exit-code", "origin", `refs/heads/${ref}`]);
  if (!result.ok) throw new Error(`${label} requires exact origin head refs`);
  const lines = result.stdout.split("\n").filter(Boolean);
  const match = lines.length === 1 ? /^([0-9a-f]{40})\trefs\/heads\/(.+)$/u.exec(lines[0]) : null;
  if (!match || match[2] !== ref) throw new Error(`${label} requires one exact origin head ref for '${ref}'`);
  return match[1];
}

function assertSamePrOperationGitAuthority(runDir, run, options, expected, label) {
  const current = observePrOperationGitAuthority(runDir, run, options, label);
  if (!sameJson(current, expected)) throw new Error(`${label} Git authority changed before publication`);
  return current;
}

function assertPrFenceGitAuthorityCurrent(runDir, run, fence, options = {}) {
  const authority = observePrOperationGitAuthority(runDir, run, options, "PR operation reconciliation");
  const expected = {
    repository: authority.repository,
    head_ref: authority.head_ref,
    head_sha: authority.head_sha,
    base_ref: authority.base_ref,
    base_sha: authority.base_sha,
    draft: authority.draft,
  };
  for (const [key, value] of Object.entries(expected)) if (fence[key] !== value) throw new Error(`pre-PR fence ${key} no longer matches local/origin authority`);
  const operationId = computePrOperationId({ base_commit: fence.base_sha, branch: fence.head_ref, created_at: fence.created_at, repository: fence.repository, run_id: run.run_id });
  if (fence.operation_id !== operationId) throw new Error("pre-PR fence operation_id is stale or malformed");
  if (run.validator?.reviewed_head_sha !== fence.head_sha || run.security_review?.reviewed_head_sha !== fence.head_sha) throw new Error("pre-PR fence head no longer equals both reviewed panel heads");
  return authority;
}

function authorityGit(options, cwd, args) {
  const runner = typeof options.gitFn === "function" ? options.gitFn : git;
  const result = runner(cwd, args);
  if (!isRecord(result) || typeof result.ok !== "boolean" || typeof result.stdout !== "string") {
    throw new Error("git authority observer returned an invalid result");
  }
  return result;
}

function observeIntegrationHeadAuthority(run, options = {}, label = "reviewed-code authority") {
  const repository = resolveAuthorityRepository(options.runDir, run, options);
  const branch = requireNonEmptyString(run.branch, "run.branch");
  const worktree = stringValue(run.worktree) ? resolve(repository, run.worktree) : deriveExpectedWorktreePath(repository, branch);
  const branchResult = authorityGit(options, repository, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  if (!branchResult.ok || !/^[0-9a-f]{40}$/u.test(branchResult.stdout.trim())) throw new Error(`${label} requires an existing integration branch`);
  const head = branchResult.stdout.trim();
  const checkedOut = authorityGit(options, worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!checkedOut.ok || checkedOut.stdout.trim() !== branch) throw new Error(`${label} requires run.worktree checked out on run.branch`);
  const worktreeHead = authorityGit(options, worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!worktreeHead.ok || worktreeHead.stdout.trim() !== head) throw new Error(`${label} requires integration branch and worktree HEAD equality`);
  const cleanliness = authorityGit(options, worktree, gitCleanlinessArgs());
  if (!cleanliness.ok || cleanliness.stdout !== "") throw new Error(`${label} requires a clean integration worktree`);
  return { repository, branch, worktree, head, clean: true };
}

function observePostPrPublicationAuthority(runDir, run, options = {}) {
  assertPostPrRefsConsistent(runDir, run);
  const postPr = run.post_pr;
  const remediation = postPr?.remediation;
  const files = new Map();
  const add = (ref, resolver) => {
    if (!stringValue(ref) || files.has(ref)) return;
    files.set(ref, exactAuthorityFile(resolver(runDir, ref).path));
  };
  for (const binding of postPr?.evidence_refs || []) add(binding?.ref, resolveEvidenceRef);
  add(remediation?.failure_evidence_ref, resolveEvidenceRef);
  add(remediation?.remediation_evidence_ref, resolveEvidenceRef);
  add(remediation?.revalidation?.canonical_evidence_ref, resolveEvidenceRef);
  add(remediation?.revalidation?.validator_review_ref, resolveReviewRef);
  add(remediation?.revalidation?.security_review_ref, resolveReviewRef);
  add(postPr?.continuation_review?.ref, resolveReviewRef);
  for (const [activity, resolver] of [["canonical", resolveEvidenceRef], ["validator", resolveReviewRef], ["security", resolveReviewRef]]) {
    const job = remediation?.revalidation?.jobs?.[activity];
    if (job?.status === "bound") add(job.result_ref, resolver);
  }
  const planPath = join(runDir, "plan", "slices.json");
  if (isRecord(remediation) && existsSync(planPath)) files.set("plan/slices.json", exactAuthorityFile(planPath));
  return { files: Object.fromEntries([...files.entries()].sort(([left], [right]) => left.localeCompare(right))), git: observePostPrGitPublicationAuthority(run, options) };
}

function assertPostPrPublicationAuthorityCurrent(runDir, run, options, expected) {
  if (!sameJson(observePostPrPublicationAuthority(runDir, run, options), expected)) throw new Error("post-PR authority changed before run.json publication");
}

function observePostPrGitPublicationAuthority(run, options = {}) {
  const remediation = run.post_pr?.remediation;
  if (!isRecord(remediation) || !stringValue(remediation.candidate_head_sha)
    || !["changes-observed", "committed", "revalidating", "validated", "push-pending", "remote-confirmed"].includes(remediation.stage)) return null;
  const worktree = options.worktree || run.worktree;
  if (!stringValue(worktree)) return null;
  const authority = observeGitPublicationAuthority(worktree, [
    ["head", ["rev-parse", "--verify", "HEAD^{commit}"]],
    ["candidate-tree", ["rev-parse", "--verify", `${remediation.candidate_head_sha}^{tree}`]],
    ["baseline-tree", ["rev-parse", "--verify", `${remediation.baseline_head_sha}^{tree}`]],
    ["ancestry", ["merge-base", "--is-ancestor", remediation.baseline_head_sha, remediation.candidate_head_sha]],
    ["cleanliness", gitCleanlinessArgs()],
    ["diff", ["diff", "--name-status", "-z", "--find-renames", "--find-copies", `${remediation.baseline_head_sha}..${remediation.candidate_head_sha}`]],
  ]);
  assertPostPrGitPublicationAuthority(authority, remediation.candidate_head_sha);
  return authority;
}

function assertPostPrGitPublicationAuthority(authority, candidateHead) {
  for (const [name, result] of Object.entries(authority)) {
    if (!result.ok) throw new Error(`post-PR candidate Git authority '${name}' is invalid`);
  }
  if (authority.head.stdout.trim() !== candidateHead) throw new Error("post-PR candidate Git authority HEAD does not equal candidate_head_sha");
  if (authority.cleanliness.stdout !== "") throw new Error("post-PR candidate Git authority requires a clean worktree");
}

function exactAuthorityFile(path) {
  const bytes = readFileSync(path);
  return { hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, bytes: bytes.toString("base64") };
}

function observeGitPublicationAuthority(repoRoot, commands) {
  return Object.fromEntries(commands.map(([name, args]) => {
    const result = git(repoRoot, args);
    return [name, { ok: result.ok, status: result.status, stdout: result.stdout }];
  }));
}

function gitCleanlinessArgs() {
  return ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", ":(exclude,top,glob).opencode/**"];
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
