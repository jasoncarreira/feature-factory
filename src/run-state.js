import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { appendCostAttributionEntry } from "./cost-attribution.js";
import { git, repoRoot } from "./git.js";
import { probeLegacyBooleanLiveness } from "./hardening/process-verification.js";
import { writeProtectedJsonAtomic } from "./hardening/atomic-write.js";
import { githubPrUrlParts, hashFile, hashValue, resolveArtifactRef, resolveEvidenceRef, resolveGateRef, resolveReviewRef, resolveSteeringRef } from "./refs.js";
import { createOwnershipIndex, normalizeRepositoryPath, validatePlanPath } from "./post-pr-ci.js";
import { buildSteeringConflictTerminalResult, collectProtectedSteeringState } from "./steering-conflicts.js";
import { computePrOperationId, observePullRequestOperation } from "./github.js";
import { PASSING_SECURITY_VERDICTS, PASSING_VALIDATOR_VERDICTS, POST_PR_TERMINAL_REASONS, assertIntegrationAmendmentConsistency, inspectIntegrationAmendmentInventory, integrationAmendmentId, isCanonicalConcreteRepositoryPath, parseSlicesPlanBytes, pendingProtectedGate, postPrConsistencyChecks, validateHeartbeatState, validateIntegrationAmendmentExecutionClaim, validateIntegrationAmendmentExecutionReceipt, validateIntegrationAmendmentReview, validateIntegrationAmendmentReviewDispatchClaim, validateIntegrationAmendmentReviewDispatchClosure, validateRun, validateRunDir, validateSliceReviewFeasibility, validateSliceReviewResult, validateSlicesPlan, validateTestExecutionReceipt, validateVerificationArtifactExecutionClaim, validateVerificationArtifactExecutionReceipt } from "./validate.js";
import { requireNonEmptyString, timestamp } from "./utils.js";
import { checkWorktreeIdentity, deriveExpectedWorktreePath } from "./worktrees.js";
import { directFactoryRoot } from "./factory-paths.js";
import { isPrivilegedControlPlanePath, privilegedControlPlanePathReason } from "./privileged-path-policy.js";
import { acquireLaunchFence, BASE_ADVANCE_LAUNCH_FENCE_OWNER_KIND, inspectLaunchClaim, inspectProcessEvidence, releaseLaunchFence } from "./process-evidence.js";
import { withCanonicalOriginMain } from "./canonical-origin/index.js";
import { BASE_ADVANCE_ERROR_CODES, evaluateBaseAdvanceState } from "./base-advance/state-model.js";
import { assertCanonicalTarget, assertRunDurableFilesEqual, assertRunWorktreePath, fastForwardBaseWorktree, observeBaseAdvanceGitState, snapshotRunDurableFiles } from "./base-advance-transition/git-state.js";
import { evaluateDeliveryEnvelopeAdmission } from "./delivery-envelope/admission-extension.js";
import { evaluateInvariantFamilyReview } from "./delivery-envelope/review-extension.js";
import { validateAdmissionExtensionResult, validateReviewExtensionResult } from "./delivery-envelope/extensions.js";
import { buildCheckpointRoutingManifest, buildDeliveryPlanAdmissionProbe, buildInvalidDeliveryPlanAdmissionProbe, checkpointRoutingArtifact, CHECKPOINT_ROUTING_KIND, CHECKPOINT_ROUTING_TERMINAL_REASON } from "./delivery-envelope/checkpoint-routing.js";
import { parseVerificationCommand } from "./delivery-envelope/verification-command.js";
import { verificationArtifactExecutionClaimRef, verificationArtifactExecutionReceiptRef } from "./verification-artifact-refs.js";
import { effectiveCheckedExecutionTimeoutMs } from "./checked-execution-timeout.js";

export const TERMINAL_RUN_STATUSES = new Set(["completed", "blocked", "partial", "needs-human"]);

const HEARTBEAT_STEP_IN_FLIGHT_STATUSES = new Set(["running"]);
const HEARTBEAT_SLICE_IN_FLIGHT_STATUSES = new Set(["running", "review"]);
const SAFE_GATE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const GATE_DECISION_STATUSES = new Set(["approved", "changes_requested", "stopped"]);
const DEFAULT_LOCK_TIMEOUT_MS = 1000;
const PLAN_SLICES_REF = "plan/slices.json";
const TEST_EXECUTION_UNKNOWN_REASONS = new Set(["process-outcome-indeterminate", "authority-changed", "receipt-publication-indeterminate"]);
const WHOLE_STORY_ROUTES = Object.freeze({
  SCHEMA_V2: "schema-v2",
  DELEGATED_CONFLICT: "delegated-conflict",
  COMBINED: "schema-v2+delegated-conflict",
  ORDINARY_FRESH: "ordinary-fresh-v1",
  LEGACY: "legacy-unselected",
});
const CHECKED_WHOLE_STORY_ROUTES = new Set([
  WHOLE_STORY_ROUTES.SCHEMA_V2,
  WHOLE_STORY_ROUTES.DELEGATED_CONFLICT,
  WHOLE_STORY_ROUTES.COMBINED,
  WHOLE_STORY_ROUTES.ORDINARY_FRESH,
]);
const WHOLE_STORY_ROUTE_SELECTION_SINKS = Object.freeze({
  SINK01: WHOLE_STORY_ROUTES.SCHEMA_V2,
  SINK02: WHOLE_STORY_ROUTES.DELEGATED_CONFLICT,
  SINK03: WHOLE_STORY_ROUTES.COMBINED,
  SINK04: WHOLE_STORY_ROUTES.ORDINARY_FRESH,
  SINK05: WHOLE_STORY_ROUTES.LEGACY,
  SINK06: WHOLE_STORY_ROUTES.LEGACY,
  SINK07: WHOLE_STORY_ROUTES.LEGACY,
  SINK08: WHOLE_STORY_ROUTES.LEGACY,
});
const WHOLE_STORY_SINKS = new Set(Array.from({ length: 26 }, (_unused, index) => `SINK${String(index + 1).padStart(2, "0")}`));
const WHOLE_STORY_STATE_VALUES = Object.freeze({
  continuation: new Set(["absent", "v1", "v2"]),
  checkpoint_source: new Set(["absent", "present"]),
  checkpoint_progress: new Set(["absent", "present"]),
  conflict: new Set(["absent", "present"]),
  slice_projection: new Set(["empty", "all-merged", "incomplete"]),
  claim: new Set(["absent", "active", "unknown", "completed-pass", "completed-fail"]),
  evidence: new Set(["absent", "exact-pass", "exact-fail", "legacy", "stale"]),
  base: new Set(["equal", "ancestor", "non-ancestor", "unavailable", "moving", "cleanup-failed"]),
  head: new Set(["equal", "dirty", "mismatch", "missing"]),
  review: new Set(["fresh", "stale", "absent"]),
});
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
const INTEGRATION_AMENDMENT_TRANSITION_AUTHORITY = Symbol("integration-amendment-transition-authority");
const INTEGRATION_AMENDMENT_DOWNSTREAM_MERGE_AUTHORITY = Symbol("integration-amendment-downstream-merge-authority");
const FAILED_PRE_REVIEW_RETRY_AUTHORITY = Symbol("failed-pre-review-retry-authority");
const SLICE_REVIEW_BINDING_KEYS = Object.freeze(["evidence_hash", "review_hash", "reviewed_commit"]);
const SLICE_DISPATCH_BINDING_KEYS = Object.freeze(["dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash"]);
const VALIDATOR_BINDING_KEYS = Object.freeze(["report_hash", "review_hash", "reviewed_head_sha"]);
const SECURITY_BINDING_KEYS = Object.freeze(["review_hash", "reviewed_head_sha"]);
const PR_FENCE_IDENTITY_KEYS = Object.freeze(["operation_id", "repository", "head_ref", "head_sha", "base_ref", "base_sha", "draft"]);
const CARRY_FORWARD_PLANNING_KINDS = new Set(["story", "research_map", "design_brief", "technical_brief"]);
const SLICE_BUILDER_AGENTS = new Set(["backend-builder", "frontend-builder"]);
const SAFE_TASK_DISPATCH_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
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

export async function transitionRunBaseAdvance(runDir, options = {}) {
  const hooks = isRecord(options.baseAdvanceHooks) ? options.baseAdvanceHooks : {};
  try {
    return await withRunJsonLock(runDir, async () => {
      let fence;
      try {
        fence = acquireLaunchFence(runDir, BASE_ADVANCE_LAUNCH_FENCE_OWNER_KIND, options.launchFenceOptions || {});
      } catch (error) {
        throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.lockContended, "base-advance launch fence could not be acquired", error);
      }
      if (!fence.acquired) throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.lockContended, "base-advance launch fence is held");

      try {
        await hooks.afterLaunchFenceAcquired?.({ fence: cloneJson(fence) });
        let current;
        try {
          current = await readRunJson(runDir);
        } catch (error) {
          throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.runInvalid, "run.json is invalid", error);
        }
        const repository = resolve(options.repoRoot || repoRoot(runDir, { noCache: true }));
        assertBaseAdvanceBaseRef(current);
        const durableSnapshot = snapshotBaseAdvanceDurableFiles(runDir, options);
        const eligibility = observeBaseAdvanceEligibility(runDir, current, options);
        assertBaseAdvanceAllowed(eligibility);

        return await withCanonicalOriginMain(repository, current.base_commit, async (origin) => {
          const target = origin.commit;
          let observed = observeBaseAdvanceGitState(repository, current, target, options);
          assertRunWorktreePath(repository, observed.worktree);
          const ancestry = target === current.base_commit ? "equal" : "ancestor";
          const decision = evaluateBaseAdvanceState({ ...eligibility, ancestry, crash_point: observed.crash_point });
          assertBaseAdvanceAllowed(decision);

          if (decision.action === "fast-forward-and-bind") {
            assertCanonicalTarget(repository, target, options);
            await hooks.beforeGit?.({ run: cloneJson(current), target });
            fastForwardBaseWorktree(observed, options);
            await hooks.afterGit?.({ run: cloneJson(current), target });
          }

          observed = observeBaseAdvanceGitState(repository, current, target, options);
          if (observed.branch_head !== target || !["git-advanced-unbound", "bound-current"].includes(observed.crash_point)) {
            throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.gitStateInvalid, "post-advance Git identity is not the canonical target");
          }
          assertCanonicalTarget(repository, target, options);
          assertRunDurableFilesEqual(snapshotBaseAdvanceDurableFiles(runDir, options), durableSnapshot);
          const beforePublication = await readRunJson(runDir);
          if (!sameJson(beforePublication, current)) throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.ineligible, "run state changed before base publication");
          assertBaseAdvanceAllowed(observeBaseAdvanceEligibility(runDir, beforePublication, options));

          if (decision.action === "replay") {
            await hooks.beforeFinalVerification?.({ run: cloneJson(current), target, replayed: true });
            assertBaseAdvanceFinalState(runDir, repository, current, target, durableSnapshot, options, false);
            return baseAdvanceSuccess(current, target, "already-current", false, true);
          }

          const next = validateRun({ ...cloneJson(current), base_commit: target, updated_at: timestamp(options.now) });
          await hooks.beforeBind?.({ run: cloneJson(current), target });
          try {
            await writeProtectedRunJson(runDir, next, { ...options, atomicWriteHooks: options.baseAdvanceAtomicWriteHooks }, async () => {
              const latest = await readRunJson(runDir);
              if (!sameJson(latest, current)) throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.ineligible, "run state changed before base publication");
              assertBaseAdvanceAllowed(observeBaseAdvanceEligibility(runDir, latest, options));
              assertRunDurableFilesEqual(snapshotBaseAdvanceDurableFiles(runDir, options), durableSnapshot);
              const latestGit = observeBaseAdvanceGitState(repository, latest, target, options);
              if (latestGit.crash_point !== "git-advanced-unbound") {
                throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.gitStateInvalid, "Git identity changed before base publication");
              }
              assertCanonicalTarget(repository, target, options);
            });
          } catch (error) {
            const checkedFailure = findBaseAdvanceFailure(error);
            if (checkedFailure) throw checkedFailure;
            throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.publishFailed, "base manifest publication failed", error);
          }
          await hooks.afterBind?.({ run: cloneJson(next), target });
          await hooks.beforeFinalVerification?.({ run: cloneJson(next), target, replayed: false });
          assertBaseAdvanceFinalState(runDir, repository, next, target, durableSnapshot, options, true);
          return baseAdvanceSuccess(current, target, "advanced", true, false);
        }, options.canonicalOriginOptions || {});
      } finally {
        if (!releaseLaunchFence(fence)) {
          throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.lockContended, "base-advance launch fence release could not be verified");
        }
        await hooks.afterLaunchFenceReleased?.();
      }
    }, options);
  } catch (error) {
    if (error?.code === "RUN_JSON_LOCK_CONTENDED" || /run\.json lock/u.test(String(error?.message || ""))) {
      throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.lockContended, "run.json lock is contended", error);
    }
    if (String(error?.code || "").startsWith("BASE_ADVANCE_")) throw error;
    throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.failed, "base advancement failed", error);
  }
}

function observeBaseAdvanceEligibility(runDir, run, options) {
  assertBaseAdvanceManifestEligibility(run);
  let ordinaryDispatch = "absent";
  let specialDispatch = "absent";
  let amendmentInventory;
  try {
    ordinaryDispatch = observeBaseAdvanceOrdinaryDispatchAuthority(runDir, run);
    specialDispatch = observeBaseAdvanceSpecialDispatchAuthority(runDir, run);
    amendmentInventory = inspectIntegrationAmendmentInventory(runDir, run);
    if (!run.integration_amendment && amendmentInventory.classification === "all-absent") observeIntegrationAmendmentWriterAuthority(runDir, run);
    if (run.integration_amendment?.status === "merged") observeIntegrationAmendmentWriterAuthority(runDir, run);
    assertBaseAdvanceBoundRefsCurrent(runDir, run);
    if ((run.steps || []).some((step) => step?.agent === "work-decomposer" && step.status === "accepted")) {
      observeAcceptedDecompositionAuthority(runDir, run, { requireApprovingReview: true });
    }
  } catch (error) {
    throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.runInvalid, "run authority is invalid", error);
  }

  const heartbeat = classifyBaseAdvanceHeartbeat(runDir, run, options);
  const processState = classifyBaseAdvanceProcess(runDir, run, options);
  const launchClaim = inspectLaunchClaim(runDir, { ...(options.launchClaimOptions || {}), runId: run.run_id });
  const sliceStatuses = new Set((run.slices || []).map((slice) => slice?.status));
  const steering = run.steering;
  const postPr = classifyBaseAdvancePostPr(run.post_pr);
  const testClaim = uniqueTestVerifierStep(run)?.execution_claim;
  const repair = run.merged_slice_repair;
  const amendment = run.integration_amendment;

  return {
    run_kind: run.continuation || run.checkpoint_source || run.checkpoint_progress ? "non-ordinary" : "ordinary",
    run_status: run.status === "running" ? (run.terminal_result == null ? "running-no-terminal" : "running-with-terminal") : run.status,
    continuation_checkpoint: run.continuation?.schema_version === 1 ? "continuation-v1"
      : run.continuation?.schema_version === 2 ? "continuation-v2"
        : run.checkpoint_source ? "checkpoint-child"
          : run.checkpoint_progress ? "checkpoint-parent" : "absent",
    steering_queue: isRecord(steering?.pending) ? "pending" : isRecord(steering?.uncheckpointed) ? "uncheckpointed" : "empty",
    steering_boundary: isRecord(steering?.boundary) ? "current" : "absent",
    steering_action: isRecord(steering?.action_claim) || steering?.last_action?.outcome === "started" ? "active"
      : isRecord(steering?.last_action) ? "historical-settled" : "absent",
    steering_fence: isRecord(steering?.pr_fence) ? "current" : "absent",
    pr_authority: stringValue(run.pr_url) ? "pr-url" : isRecord(run.post_pr?.pr_operation) ? "operation"
      : isRecord(steering?.pr_fence) ? "fence" : run.terminal_result != null ? "terminal" : "absent",
    post_pr: postPr,
    slices: sliceStatuses.has("merged") ? "merged" : sliceStatuses.has("blocked") ? "blocked"
      : sliceStatuses.size === 0 ? "empty" : sliceStatuses.size === 1 ? [...sliceStatuses][0] : "mixed-active",
    ordinary_dispatch: ordinaryDispatch,
    test_execution: isRecord(testClaim) && testClaim.state === "active" ? "active"
      : isRecord(testClaim) && testClaim.state === "unknown" ? "unknown"
        : isRecord(testClaim) ? "settled-historical" : "absent",
    special_dispatch: specialDispatch,
    amendment: classifyBaseAdvanceAmendment(amendment, amendmentInventory),
    repair: !repair ? "absent" : repair.status === "merged" ? "fully-merged-resolved" : repair.status,
    panels: isRecord(run.validator) && isRecord(run.security_review) ? "both"
      : isRecord(run.validator) ? "validator" : isRecord(run.security_review) ? "security" : "absent",
    heartbeat,
    process: processState,
    launch_claim: launchClaim.missing ? "absent" : launchClaim.ok && launchClaim.owner_status === "live" ? "live"
      : launchClaim.ok && launchClaim.owner_status === "indeterminate" ? "indeterminate"
        : launchClaim.ok ? "stale-unreconciled" : "malformed",
    run_lock: "acquired",
    launch_fence: "acquired-base-advance",
    git_identity: "registered-clean-attached",
    origin: "exact-stable",
    ancestry: "ancestor",
    crash_point: "old-eligible",
  };
}

function assertBaseAdvanceManifestEligibility(run) {
  if (run.continuation || run.checkpoint_source || run.checkpoint_progress) {
    throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.ineligible, "continuation and checkpoint runs cannot advance their base");
  }
  if (run.status !== "running" || run.terminal_result != null) throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.ineligible, "run is not active");
  if (stringValue(run.pr_url) || isRecord(run.post_pr?.pr_operation) || isRecord(run.steering?.pr_fence)) {
    throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.ineligible, "run already has PR authority");
  }
  if (classifyBaseAdvancePostPr(run.post_pr) === "active") throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.ineligible, "post-PR state is active");
  if (isRecord(run.steering?.pending) || isRecord(run.steering?.uncheckpointed) || isRecord(run.steering?.boundary)
    || isRecord(run.steering?.action_claim) || run.steering?.last_action?.outcome === "started") {
    throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.ineligible, "steering authority is active");
  }
  if ((run.slices || []).some((slice) => ["merged", "blocked"].includes(slice?.status))) {
    throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.ineligible, "run has a merged or blocked slice");
  }
  const testClaim = uniqueTestVerifierStep(run)?.execution_claim;
  if (isRecord(testClaim) && ["active", "unknown"].includes(testClaim.state)) {
    throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.ineligible, "checked test execution is active or unknown");
  }
  if (run.special_builder_dispatch) throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.ineligible, "special builder authority is unconsumed");
  if (run.integration_amendment && run.integration_amendment.status !== "merged") {
    throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.ineligible, "integration amendment authority is unresolved");
  }
  if (run.merged_slice_repair && run.merged_slice_repair.status !== "merged") {
    throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.ineligible, "merged-slice repair authority is unresolved");
  }
  if (isRecord(run.validator) || isRecord(run.security_review)) throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.ineligible, "panel authority already exists");
}

function observeBaseAdvanceSpecialDispatchAuthority(runDir, run) {
  const dispatchDir = join(runDir, "dispatch");
  if (!existsSync(dispatchDir)) {
    if (run.special_builder_dispatch) throw new Error("bound special dispatch directory is missing");
    return "absent";
  }
  const names = readdirSync(dispatchDir);
  const claimNames = new Set(names.filter((entry) => entry.endsWith(".special.json")));
  for (const name of names.filter((entry) => entry.endsWith(".special.closed.json"))) {
    const claimName = `${name.slice(0, -".special.closed.json".length)}.special.json`;
    if (!claimNames.has(claimName)) throw new Error(`special dispatch closure '${name}' has no claim`);
  }
  let classification = "absent";
  for (const name of claimNames) {
    const observed = observeSpecialDispatchClaim(runDir, `dispatch/${name}`);
    if (observed.claim.run_id !== run.run_id) throw new Error("special dispatch is cross-bound");
    if (!existsSync(resolve(runDir, observed.claim.closure_ref))) {
      classification = "active";
      continue;
    }
    const closed = observeClosedSpecialDispatch(runDir, observed);
    const binding = run.special_builder_dispatch;
    if (binding?.claim_ref === observed.ref) {
      if (binding.claim_hash !== observed.hash || binding.closure_ref !== closed.closure_ref
        || binding.closure_hash !== closed.closure_hash || binding.completion_head !== closed.completion_head) {
        throw new Error("special dispatch binding is stale");
      }
      classification = "closed-unconsumed";
    } else if (classification === "absent") classification = "consumed-historical";
  }
  if (run.special_builder_dispatch && classification === "absent") throw new Error("bound special dispatch is missing");
  return classification;
}

function classifyBaseAdvanceAmendment(amendment, inventory) {
  if (!amendment) {
    if (inventory.classification === "all-absent" || ["completed-pass-receipt-no-manifest", "completed-diagnostic-receipt-no-manifest"].includes(inventory.classification)) {
      return inventory.classification === "all-absent" ? "absent" : "settled-no-manifest";
    }
    if (inventory.classification === "active-claim-only") return "active";
    if (inventory.classification === "unknown-claim-optional-bound-receipt") return "unknown";
    return "unconsumed";
  }
  if (amendment.status === "merged") return "fully-merged-resolved";
  if (amendment.status === "blocked") return "blocked";
  if (["active", "unknown"].includes(inventory.verification_effect?.state)) return inventory.verification_effect.state;
  return "active";
}

function classifyBaseAdvanceHeartbeat(runDir, run, options) {
  const path = join(runDir, HEARTBEAT_FILE);
  if (!existsSync(path)) return "missing";
  let heartbeat;
  try {
    heartbeat = validateHeartbeatState(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.runInvalid, "heartbeat evidence is invalid", error);
  }
  if (heartbeat.run_id !== run.run_id) throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.runInvalid, "heartbeat evidence is cross-bound");
  if (heartbeat.pid === null) return "pid-null";
  const liveness = inspectHeartbeatLiveness(heartbeat, options);
  if (liveness.status === "indeterminate") return "indeterminate";
  if (liveness.status === "live") return "live-matching";
  return "inactive";
}

function classifyBaseAdvanceProcess(runDir, run, options) {
  const observed = inspectProcessEvidence(runDir, { ...(options.processEvidenceOptions || {}), runId: run.run_id });
  if (observed.missing) return "missing";
  if (!observed.ok) throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.runInvalid, "process evidence is invalid");
  if (observed.evidence.state === "exited") return "exited-matching";
  if (observed.evidence.state === "running" && observed.verification?.status === "live-and-matching") return "live-matching";
  if (observed.evidence.state === "running") return "running";
  return observed.evidence.state;
}

function classifyBaseAdvancePostPr(postPr) {
  if (postPr == null || postPr.policy?.enabled !== true) return "disabled";
  const pristine = postPr.phase === "awaiting-pr" && postPr.attempt === 0 && postPr.observation === null
    && postPr.remediation === null && Array.isArray(postPr.evidence_refs) && postPr.evidence_refs.length === 0
    && postPr.continuation_review === null && postPr.terminal_fact === null && postPr.pr_operation === null;
  return pristine ? "pristine-awaiting-pr" : "active";
}

function observeBaseAdvanceOrdinaryDispatchAuthority(runDir, run) {
  const slices = Array.isArray(run.slices) ? run.slices : [];
  const dispatchDir = join(runDir, "dispatch");
  const expectedNames = new Set();
  let classification = "absent";
  for (const slice of slices) {
    assertSliceAttemptHistoryCurrent(runDir, slice.id, slice);
    const currentAttempt = Number.isInteger(slice.attempts) ? slice.attempts : 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimName = sliceDispatchClaimName(run.run_id, slice.id, attempt);
      const closureName = `${claimName.slice(0, -5)}.closed.json`;
      expectedNames.add(claimName);
      expectedNames.add(closureName);
      const claimPath = join(dispatchDir, claimName);
      const closurePath = join(dispatchDir, closureName);
      const hasClaim = existsSync(claimPath);
      const hasClosure = existsSync(closurePath);
      if (hasClosure && !hasClaim) throw new Error(`slice '${slice.id}' attempt ${attempt} closure has no claim`);
      const historical = attempt === currentAttempt ? null : (slice.attempt_reviews || []).find((entry) => entry?.attempt === attempt);
      const binding = attempt === currentAttempt ? slice : historical;
      const bound = SLICE_DISPATCH_BINDING_KEYS.every((key) => binding?.[key] !== undefined);
      if (!hasClaim) {
        if (bound) throw new Error(`slice '${slice.id}' attempt ${attempt} bound claim is missing`);
        continue;
      }
      if (attempt > currentAttempt) throw new Error(`slice '${slice.id}' has a future dispatch claim`);
      const boundSlice = bound ? { ...slice, dispatch_required: true, ...pickBinding(binding, SLICE_DISPATCH_BINDING_KEYS) } : slice;
      const observed = observeSliceDispatchClaim(runDir, run.run_id, boundSlice, attempt, { requireRunBinding: bound });
      if (hasClosure) observeClosedSliceDispatch(runDir, observed, { slice: boundSlice, requireRunBinding: bound });
      if (attempt < currentAttempt && (!bound || !hasClosure)) throw new Error(`slice '${slice.id}' historical dispatch is unresolved`);
      classification = attempt === currentAttempt && !hasClosure ? "active-current-attempt" : "closed";
    }
  }
  if (existsSync(dispatchDir)) {
    assertNoSymlinkPath(runDir, dispatchDir, "slice builder dispatch directory");
    for (const name of readdirSync(dispatchDir)) {
      if (expectedNames.has(name) || name.endsWith(".special.json") || name.endsWith(".special.closed.json")
        || name.endsWith(".amendment-review.json") || name.endsWith(".amendment-review.closed.json")) continue;
      throw new Error(`unknown dispatch sidecar '${name}'`);
    }
  }
  return classification;
}

function assertBaseAdvanceBoundRefsCurrent(runDir, run) {
  visit(run);
  function visit(value) {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, ref] of Object.entries(value)) {
      if (key.endsWith("_ref") && typeof ref === "string") {
        const hashKey = `${key.slice(0, -4)}_hash`;
        if (typeof value[hashKey] === "string" && ref.includes("/")) {
          const path = resolve(runDir, ref);
          const rel = relative(resolve(runDir), path);
          if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error(`bound ref '${ref}' escapes the run directory`);
          assertNoSymlinkPath(runDir, path, `bound ref '${ref}'`);
          if (!existsSync(path) || !lstatSync(path).isFile() || hashFile(path, { mode: "raw" }) !== value[hashKey]) {
            throw new Error(`bound ref '${ref}' bytes are stale`);
          }
        }
      }
      visit(ref);
    }
  }
}

function assertBaseAdvanceBaseRef(run) {
  if (run.base_ref !== "main") throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.ineligible, "base advancement supports only canonical main");
}

function assertBaseAdvanceAllowed(observationOrDecision) {
  const decision = typeof observationOrDecision?.eligible === "boolean"
    ? observationOrDecision
    : evaluateBaseAdvanceState(observationOrDecision);
  if (decision.eligible) return decision;
  throw baseAdvanceFailure(decision.code || BASE_ADVANCE_ERROR_CODES.runInvalid,
    `base advancement rejected ${decision.dimension}:${decision.variant}`);
}

function snapshotBaseAdvanceDurableFiles(runDir, options) {
  return snapshotRunDurableFiles(runDir, options.baseAdvanceDurableFileSystem || {});
}

function assertBaseAdvanceFinalState(runDir, repository, expectedRun, target, durableSnapshot, options, publicationComplete) {
  try {
    const stored = validateRun(JSON.parse(readFileSync(join(runDir, RUN_FILE), "utf8")));
    if (!sameJson(stored, expectedRun) || stored.base_commit !== target) {
      throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.publishFailed, "published base manifest does not equal the checked target");
    }
    const gitState = observeBaseAdvanceGitState(repository, stored, target, options);
    if (gitState.crash_point !== "bound-current") {
      throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.gitStateInvalid, "final Git identity is not current");
    }
    assertCanonicalTarget(repository, target, options);
    assertRunDurableFilesEqual(snapshotBaseAdvanceDurableFiles(runDir, options), durableSnapshot);
  } catch (error) {
    if (publicationComplete) {
      throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.publishFailed, "final base publication verification failed");
    }
    if (String(error?.code || "").startsWith("BASE_ADVANCE_")) throw error;
    throw baseAdvanceFailure(BASE_ADVANCE_ERROR_CODES.runInvalid, "final base replay verification failed");
  }
}

function baseAdvanceSuccess(previous, target, disposition, updated, replayed) {
  return {
    ok: true,
    operation: "active-run-base-advance",
    run_id: previous.run_id,
    disposition,
    updated,
    replayed,
    base_ref: previous.base_ref,
    previous_base_commit: previous.base_commit,
    base_commit: target,
    branch: previous.branch,
    worktree: previous.worktree,
  };
}

function baseAdvanceFailure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function findBaseAdvanceFailure(error) {
  for (let current = error; current; current = current.cause) {
    if (String(current?.code || "").startsWith("BASE_ADVANCE_")) return current;
  }
  return null;
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
  let v2Authority = null;
  const result = await withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    if (gateName === "pre_pr" && ["pending", "approved"].includes(nextGate.status)) v2Authority = assertCheckedPrePrGateAuthority(runDir, current, `pre_pr ${nextGate.status}`);
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
        }, beforeReplace: v2Authority ? (_next, observed) => assertCheckedPrePrGateAuthority(runDir, observed, `pre_pr ${nextGate.status}`, v2Authority) : null },
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
    observeIntegrationAmendmentWriterAuthority(runDir, current);
    assertNoPendingSpecialBuilderDispatches(runDir, current);
    const v2Authority = assertV2LocalPublishedAuthority(runDir, current, options);
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
    const steeringDir = dirname(resolved.path);
    const steeringDirExisted = existsSync(steeringDir);
    await mkdir(steeringDir, { recursive: true });
    const createdDirectory = steeringDirExisted ? null : await observeCreatedDirectory(steeringDir);
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
    const assertPublicationAuthority = () => {
      const observed = validateRun(JSON.parse(readFileSync(join(runDir, RUN_FILE), "utf8")));
      if (!sameJson(observed, current)) throw new Error("steering queue run authority changed before publication");
      if (v2Authority) assertV2LocalPublishedAuthority(runDir, observed, options, v2Authority);
    };
    let publication = null;
    let fileHash = null;
    try {
      if (existsSync(resolved.path)) throw new Error(`steering ref already exists: ${ref}`);
      publication = await publishDispatchRecord(runDir, ref, steeringFile, {
        hooks: publicationBeforeCommitHooks(options.steeringQueueAtomicWriteHooks),
        beforeCommit: assertPublicationAuthority,
        existsMessage: `steering ref already exists: ${ref}`,
      });
      fileHash = hashFile(resolved.path, { mode: "raw" });
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
      await options.steeringQueueAtomicWriteHooks?.afterCommit?.();
      assertPublicationAuthority();
      await writeSemanticRunJson(runDir, next, options, v2Authority, () => {
        assertPublicationAuthority();
        if (hashFile(resolved.path, { mode: "raw" }) !== fileHash) throw new Error("steering queue sidecar changed before run binding");
      });
      return { updated: true, status: next.status, run: next, steering: metadata };
    } catch (error) {
      if (publication) {
        await removeOwnedFailedDispatchPublication(runDir, ref, publication, (observed) => {
          const pending = observed?.steering?.pending;
          return pending?.ref === ref && pending?.hash === fileHash;
        });
      }
      await removeOwnedEmptyDirectory(createdDirectory);
      throw error;
    }
  }, options);
}

export async function transitionSteeringConsumed(runDir, input, options = {}) {
  const requestedRef = requireNonEmptyString(input?.ref, "steering ref");
  const requestedHash = requireNonEmptyString(input?.hash, "steering hash");
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    assertNoPendingSpecialBuilderDispatches(runDir, current);
    const v2Authority = assertV2LocalPublishedAuthority(runDir, current, options);
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
    let moved = null;
    try {
      if (!source.consumedRef) {
        const consumedResolved = resolveSteeringRef(runDir, consumedRef, { mustExist: false });
        await options.steeringConsumeRenameHooks?.beforeRename?.();
        assertSteeringMutationAuthority(runDir, current, options, v2Authority);
        moved = await renameOwnedSteeringSidecar(source.path, consumedResolved.path, pending.hash);
        assertOwnedSteeringSidecarMove(moved);
        await options.steeringConsumeRenameHooks?.afterRename?.();
        assertSteeringMutationAuthority(runDir, current, options, v2Authority);
      }
      await writeSemanticRunJson(runDir, next, options, v2Authority, () => {
        assertSteeringMutationAuthority(runDir, current, options, v2Authority);
        if (moved) assertOwnedSteeringSidecarMove(moved);
      });
    } catch (error) {
      if (moved) await restoreOwnedSteeringSidecarMove(moved);
      throw error;
    }
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
    const v2Authority = assertV2LocalPublishedAuthority(runDir, current, options);
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
    await writeSemanticRunJson(runDir, next, options, v2Authority);
    return { updated: true, status: next.status, run: next, steering: { ref: requestedRef, hash: requestedHash, acknowledged_at: acknowledgedAt, outcome: "applied-prospectively" } };
  }, options);
}

export async function transitionSteeringConflict(runDir, input, options = {}) {
  const requestedRef = requireNonEmptyString(input?.ref, "steering ref");
  const requestedHash = requireNonEmptyString(input?.hash, "steering hash");
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    const v2Authority = assertV2LocalPublishedAuthority(runDir, current, options);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    if (TERMINAL_RUN_STATUSES.has(current.status)) throw new Error(`terminal run '${current.status}' cannot record steering conflict`);
    if (current.status !== "running") throw new Error(`steer-conflict requires a running run, found '${current.status}'`);
    assertNoCurrentSliceNonconvergence(runDir, current);
    assertNoUnreconciledTestExecution(current);
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
    await writeSemanticRunJson(runDir, next, options, v2Authority);
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
    if (boundaryKind === "gate") observeIntegrationAmendmentWriterAuthority(runDir, current);
    const v2Authority = assertV2LocalPublishedAuthority(runDir, current, options);
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
    await writeSemanticRunJson(runDir, next, options, v2Authority);
    return { updated: true, status: next.status, run: next, boundary: cloneJson(next.steering.boundary) };
  }, options);
}

export async function transitionSteeringBoundaryCrossed(runDir, kind, token, options = {}) {
  const boundaryKind = normalizeSteeringBoundaryKind(kind);
  if (!STEERING_ACTION_KINDS.has(boundaryKind)) throw new Error("boundary-cross supports dispatch, remediation, terminal, post-pr-observe, or post-pr-push");
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    const v2Authority = assertV2LocalPublishedAuthority(runDir, current, options);
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
    await writeSemanticRunJson(runDir, next, options, v2Authority);
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
    const v2Authority = assertV2LocalPublishedAuthority(runDir, current, options);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    assertSteeringBoundaryClear(current, "action-close");
    if (isRecord(current.steering?.boundary) || isRecord(current.steering?.pr_fence)) throw new Error("action-close requires no boundary or PR fence");
    assertNoFreshHeartbeat(runDir, options, "action-close requires inactive heartbeat");
    const action = current.steering?.last_action;
    const requestedToken = safeBoundaryToken(token);
    if (!isRecord(action) || action.kind !== actionKind || action.token !== requestedToken || action.outcome !== "started" || action.generation !== steeringGeneration(current)) throw new Error("origin action is missing, stale, or not started");
    const closedAt = timestamp(options.now);
    const next = validateRun({ ...cloneJson(current), updated_at: closedAt, steering: normalizedSteeringState(current, { last_action: { ...cloneJson(action), outcome: "closed", resolved_at: closedAt } }) });
    await writeSemanticRunJson(runDir, next, options, v2Authority);
    return { updated: true, status: next.status, run: next, action: cloneJson(next.steering.last_action) };
  }, options);
}

async function transitionSteeringActionResolved(runDir, kind, token, outcome, options = {}) {
  const actionKind = normalizeSteeringActionKind(kind);
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    const v2Authority = assertV2LocalPublishedAuthority(runDir, current, options);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    const claim = assertSteeringActionClaim(current, actionKind, token);
    if (outcome === "aborted") {
      const recoverable = inspectRecoverableHeartbeat(runDir, options);
      if (!recoverable.ok) throw new Error("action-abort requires inactive heartbeat: active-heartbeat");
      assertV2LocalPublishedAuthority(runDir, current, options, v2Authority);
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
    await writeSemanticRunJson(runDir, next, options, v2Authority);
    return { updated: true, status: next.status, run: next, action: cloneJson(next.steering.last_action) };
  }, options);
}

export async function transitionPrePrFenceEstablished(runDir, options = {}) {
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    assertNoPendingSpecialBuilderDispatches(runDir, current);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    if (current.continuation?.schema_version === 2) assertV2LocalPublishedAuthority(runDir, current, options);
    assertBoundaryClean(runDir, current, options, "pr-fence");
    const route = classifyWholeStoryTestRoute(runDir, current, options);
    if (route === WHOLE_STORY_ROUTES.ORDINARY_FRESH && current.pr_mode !== "ready") {
      throw new Error("pr-fence denied: ordinary-fresh-ready-required");
    }
    const authority = assertPrCreatedReadiness(runDir, current);
    const gitAuthority = await observePrOperationGitAuthority(runDir, current, options, "pr-fence");
    const baseRelationship = gitAuthority.base_sha === current.base_commit ? "equal" : "ancestor";
    if (route !== WHOLE_STORY_ROUTES.LEGACY) {
      const fenceDecision = evaluateWholeStoryRouteSink({ route, sink: "SINK18", base: baseRelationship, head: "equal", review: "fresh", pr_mode: current.pr_mode });
      if (!fenceDecision.allowed) throw new Error(`pr-fence denied: ${fenceDecision.reason}`);
      assertWholeStorySinkAllowed({ route, sink: "SINK19", base: baseRelationship, head: "equal", review: "fresh", pr_mode: current.pr_mode });
    }
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
      operation_id: computePrOperationId({ base_commit: current.base_commit, branch: gitAuthority.head_ref, created_at: createdAt, repository: gitAuthority.repository, run_id: current.run_id }),
      repository: gitAuthority.repository,
      head_ref: gitAuthority.head_ref,
      head_sha: gitAuthority.head_sha,
      base_ref: gitAuthority.base_ref,
      base_sha: gitAuthority.base_sha,
      draft: current.pr_mode === "draft",
    };
    const next = validateRun(base);
    await writeProtectedRunJson(runDir, next, options, async () => {
      assertPrCreatedAuthorityCurrent(runDir, current, authority);
      await assertSamePrOperationGitAuthority(runDir, current, options, gitAuthority, "pr-fence");
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
    assertNoPendingSpecialBuilderDispatches(runDir, current);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    if (current.continuation?.schema_version === 2) assertV2LocalPublishedAuthority(runDir, current, options);
    if (current.status !== "running") throw new Error(`${mode === "clear" ? "pr-fence clear" : "pr-created"} requires a running run`);
    assertNoCurrentSliceNonconvergence(runDir, current);
    if (mergedSliceRepairFence(current)) throw new Error("pr-created is fenced while a merged-slice repair is unresolved");
    if (mode === "record") assertCheckedFreshDownstreamAuthority(runDir, current, "PR creation");
    const fence = assertPrFence(current, token);
    if (!hasCompleteBinding(fence, PR_FENCE_IDENTITY_KEYS)) return terminalizeLegacyPrFenceLocked(runDir, current, options);

    const readiness = assertPrCreatedReadiness(runDir, current);
    const gitAuthority = await assertPrFenceGitAuthorityCurrent(runDir, current, fence, options);
    const observationIdentity = { ...fence, base_sha: gitAuthority.base_sha };
    const observation = await observeFencedPrOperation(current, observationIdentity, options, gitAuthority.head_sha);
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
  const authority = await assertPrFenceGitAuthorityCurrent(runDir, current, fence, options);
  const observed = await observeFencedPrOperation(current, { ...fence, base_sha: authority.base_sha }, options, authority.head_sha);
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
  assertNoCurrentSliceNonconvergence(runDir, current);
  const v2Authority = assertV2LocalPublishedAuthority(runDir, current, options);
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
  return writeSemanticRunJson(runDir, next, options, v2Authority).then(() => ({
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
    if (current.continuation?.schema_version === 2) assertV2LocalPublishedAuthority(runDir, current, options);
    return terminalizeLegacyPrFenceLocked(runDir, current, options);
  }, options);
}

/** Checked replacement used by the orchestration layer after external work is inactive. */
export async function transitionPostPrState(runDir, postPr, options = {}) {
  if (!isRecord(postPr)) throw new Error("transitionPostPrState requires post_pr state");
  const consumesSpecialDispatch = postPr.phase === "changes-observed";
  return withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, (draft, { current }) => {
    assertPostPrMutationReady(runDir, current, options, "post-PR transition");
    const nextPostPr = cloneJson(postPr);
    if (sameJson(current.post_pr, nextPostPr)) return;
    assertPostPrPhaseTransition(current.post_pr, nextPostPr);
    assertPostPrAttemptTransition(current, nextPostPr);
    assertPostPrMonotonicState(current.post_pr, nextPostPr);
    assertPostPrCandidateGitState(current, nextPostPr, options);
    if (current.post_pr?.phase === "remediation-running" && nextPostPr.phase === "changes-observed") {
      consumeSpecialBuilderDispatch(runDir, current, draft, "post-pr-remediation", nextPostPr.remediation?.candidate_head_sha);
    }
    draft.post_pr = nextPostPr;
    draft.updated_at = timestamp(options.now);
  }, options, { postPr: true, consumeSpecialDispatch: consumesSpecialDispatch, beforeWrite: (next) => assertPostPrRefsConsistent(runDir, next) }), options);
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
    assertNoUnreconciledTestExecution(current);
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
    assertNoUnreconciledTestExecution(draft);
    assertNoCurrentSliceNonconvergence(runDir, draft);
    if (draft.integration_amendment?.status === "blocked") {
      if (draft.steering?.boundary || draft.steering?.action_claim || options.boundaryToken !== undefined) {
        throw new Error("blocked integration amendment terminalization requires no competing steering boundary");
      }
    } else {
      assertSteeringBoundaryClear(draft, "terminal");
      consumeSteeringBoundary(draft, "terminal", options.boundaryToken);
    }
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
    const v2Authority = assertV2LocalPublishedAuthority(runDir, current, options);
    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    if (current.status !== "running") throw new Error(`recover requires a running run, found '${current.status}'`);
    assertNoCurrentSliceNonconvergence(runDir, current);
    assertNoUnreconciledTestExecution(current);
    assertSteeringBoundaryClear(current, "recover");
    if (isRecord(current.steering?.pr_fence)) {
      if (!hasCompleteBinding(current.steering.pr_fence, PR_FENCE_IDENTITY_KEYS)) return terminalizeLegacyPrFenceLocked(runDir, current, options);
      throw new Error("recover rejected: active pre-PR fence");
    }
    const recoverable = inspectRecoverableHeartbeat(runDir, options);
    if (!recoverable.ok) throw new Error(`recover requires terminal, missing, stale, or dead heartbeat: ${recoverable.reason}`);

    const now = timestamp(options.now);
    assertV2LocalPublishedAuthority(runDir, current, options, v2Authority);
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

    await writeSemanticRunJson(runDir, next, options, v2Authority);
    return { updated: true, status: next.status, run: next, recovery: recoverable };
  }, options);
}

export async function claimCheckedTestExecution(runDir, options = {}) {
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    const step = uniqueTestVerifierStep(current);
    if (!step) throw testExecutionError("TEST_EXECUTION_INELIGIBLE", "checked test execution requires exactly one test-verifier step");
    const existing = step.execution_claim;
    if (isRecord(existing)) {
      if (existing.state === "active") throw testExecutionError("TEST_EXECUTION_ACTIVE", "checked test execution claim is active; no supported factory command may clear, replace, terminalize, retry, or advance the claim; trusted out-of-band operator/process reconciliation is required");
      if (existing.state === "unknown") throw operatorReconciliationRequired("checked test execution outcome is unknown");
      if (existing.state === "completed") return replayCheckedTestExecutionLocked(runDir, current, step, options);
      throw operatorReconciliationRequired("checked test execution claim state is invalid");
    }
    requireRunningTestVerifierStep(current);
    const authority = observeCheckedTestExecutionAuthority(runDir, current, options);
    assertWholeStorySinkAllowed({ route: classifyWholeStoryTestRoute(runDir, current, options), sink: "SINK12", claim: "active", head: "equal" });
    const receiptRef = `evidence/test-verifier.attempt-${step.attempts}.json`;
    const receipt = resolveEvidenceRef(runDir, receiptRef, { mustExist: false });
    if (existsSync(receipt.path)) throw testExecutionError("TEST_EXECUTION_UNCLAIMED_RECEIPT", "fixed test execution receipt already exists without a claim");
    const claim = {
      schema_version: 1,
      kind: "checked-test-execution-claim",
      state: "active",
      nonce: options.nonce || randomUUID(),
      run_id: current.run_id,
      attempt: step.attempts,
      plan_ref: PLAN_SLICES_REF,
      plan_hash: authority.plan_hash,
      head_sha: authority.head_sha,
      timeout_ms: authority.timeout_ms,
      receipt_ref: receiptRef,
      claimed_at: timestamp(options.now),
    };
    const next = cloneJson(current);
    const nextStep = uniqueTestVerifierStep(next);
    nextStep.execution_claim = claim;
    nextStep.execution_claim_hash = hashValue(claim);
    validateRun(next);
    await writeProtectedRunJson(runDir, next, options, () => {
      const observed = validateRun(parseJsonObjectFile(join(runDir, RUN_FILE), "checked test execution claim run.json"));
      const observedStep = uniqueTestVerifierStep(observed);
      if (observedStep?.execution_claim !== undefined || observedStep?.execution_claim_hash !== undefined) throw new Error("checked test execution claim changed before publication");
      assertSameCheckedExecutionAuthority(observeCheckedTestExecutionAuthority(runDir, observed, options), authority);
    });
    return { replayed: false, run: next, step: cloneJson(uniqueTestVerifierStep(next)), claim: cloneJson(claim), authority };
  }, options);
}

export async function completeCheckedTestExecution(runDir, expectedClaim, expectedAuthority, receiptInput, options = {}) {
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    const step = uniqueTestVerifierStep(current);
    assertExactActiveExecutionClaim(step, expectedClaim);
    let authority;
    try {
      authority = observeCheckedTestExecutionAuthority(runDir, current, options);
      assertSameCheckedExecutionAuthority(authority, expectedAuthority);
      assertWholeStorySinkAllowed({ route: classifyWholeStoryTestRoute(runDir, current, options), sink: "SINK12", claim: "active", head: "equal" });
    } catch (error) {
      await persistUnknownTestExecutionLocked(runDir, current, step, expectedClaim, "authority-changed", options);
      throw operatorReconciliationRequired(`checked test execution authority changed before receipt publication: ${error.message}`);
    }
    const receipt = validateTestExecutionReceipt(cloneJson(receiptInput));
    assertReceiptMatchesExecution(receipt, expectedClaim, authority);
    const resolved = resolveEvidenceRef(runDir, expectedClaim.receipt_ref, { mustExist: false });
    try {
      await writeProtectedJsonAtomic(runDir, expectedClaim.receipt_ref, receipt, { commit: "create-only", hooks: options.receiptAtomicWriteHooks });
    } catch (error) {
      await persistUnknownTestExecutionLocked(runDir, current, step, expectedClaim, "receipt-publication-indeterminate", options);
      throw operatorReconciliationRequired(`checked test execution receipt publication is indeterminate: ${error.message}`);
    }
    const receiptHash = hashFile(resolved.path, { mode: "raw" });
    const next = cloneJson(current);
    const nextStep = uniqueTestVerifierStep(next);
    nextStep.evidence_ref = expectedClaim.receipt_ref;
    nextStep.execution_claim = {
      ...cloneJson(expectedClaim),
      state: "completed",
      completed_at: receipt.completed_at,
      status: receipt.status,
      receipt_hash: receiptHash,
    };
    nextStep.execution_claim_hash = hashValue(nextStep.execution_claim);
    if (receipt.status === "fail") nextStep.status = "rejected";
    validateRun(next);
    await writeProtectedRunJson(runDir, next, options, () => {
      const observed = validateRun(parseJsonObjectFile(join(runDir, RUN_FILE), "checked test execution completion run.json"));
      assertExactActiveExecutionClaim(uniqueTestVerifierStep(observed), expectedClaim);
      assertSameCheckedExecutionAuthority(observeCheckedTestExecutionAuthority(runDir, observed, options), expectedAuthority);
      const exactReceipt = validateTestExecutionReceipt(parseJsonObjectFile(resolved.path, "checked test execution receipt"));
      if (!sameJson(exactReceipt, receipt) || hashFile(resolved.path, { mode: "raw" }) !== receiptHash) throw new Error("checked test execution receipt changed before completion publication");
    });
    return checkedTestExecutionEnvelope(next, nextStep, receiptHash, false);
  }, options);
}

export async function claimCheckedVerificationArtifactExecution(runDir, sliceId, artifactId, options = {}) {
  return withRunJsonLock(runDir, async () => {
    const run = await readRunJson(runDir);
    observeIntegrationAmendmentWriterAuthority(runDir, run);
    const authority = observeVerificationArtifactExecutionAuthority(runDir, run, sliceId, artifactId, options);
    const claimRef = verificationArtifactExecutionClaimRef(authority.receipt_ref);
    const claimResolved = resolveEvidenceRef(runDir, claimRef, { mustExist: false });
    const receiptResolved = resolveEvidenceRef(runDir, authority.receipt_ref, { mustExist: false });
    if (existsSync(claimResolved.path)) {
      const claim = validateVerificationArtifactExecutionClaim(parseJsonObjectFile(claimResolved.path, "checked verification artifact claim"));
      assertVerificationArtifactClaimMatches(claim, authority);
      if (claim.state === "active") throw operatorReconciliationRequired("checked verification artifact execution claim is active");
      if (claim.state === "unknown") throw operatorReconciliationRequired("checked verification artifact execution outcome is unknown");
      const receipt = validateVerificationArtifactExecutionReceipt(parseJsonObjectFile(receiptResolved.path, "checked verification artifact receipt"));
      assertVerificationArtifactReceiptMatches(receipt, authority, claim);
      const receiptHash = hashFile(receiptResolved.path, { mode: "raw" });
      if (claim.receipt_hash !== receiptHash || claim.status !== receipt.status) throw new Error("completed checked verification artifact claim is stale");
      return { replayed: true, authority, claim, claim_ref: claimRef, receipt, receipt_hash: receiptHash };
    }
    if (existsSync(receiptResolved.path)) throw new Error("checked verification artifact unclaimed receipt already exists without a claim");
    const claim = validateVerificationArtifactExecutionClaim({
      schema_version: 1,
      kind: "checked-verification-artifact-execution-claim",
      state: "active",
      nonce: options.nonce || randomUUID(),
      run_id: authority.run_id,
      slice_id: authority.slice_id,
      attempt: authority.attempt,
      plan_ref: authority.plan_ref,
      plan_hash: authority.plan_hash,
      head_sha: authority.head_sha,
      timeout_ms: authority.timeout_ms,
      verification_artifact_id: authority.verification_artifact_id,
      probe: authority.probe,
      receipt_ref: authority.receipt_ref,
      claimed_at: timestamp(options.now),
    });
    await writeProtectedJsonAtomic(runDir, claimRef, claim, {
      commit: "create-only",
      hooks: {
        beforeCommit: () => {
          if (existsSync(receiptResolved.path)) throw new Error("checked verification artifact receipt appeared before claim publication");
          const observedRun = validateRun(parseJsonObjectFile(join(runDir, RUN_FILE), "verification artifact claim run.json"));
          const observed = observeVerificationArtifactExecutionAuthority(runDir, observedRun, sliceId, artifactId, options);
          if (!sameJson(observed, authority)) throw new Error("checked verification artifact authority changed before claim publication");
        },
      },
    });
    return { replayed: false, authority, claim, claim_ref: claimRef };
  }, options);
}

export async function completeCheckedVerificationArtifactExecution(runDir, expectedClaim, expectedAuthority, receiptInput, options = {}) {
  return withRunJsonLock(runDir, async () => {
    const run = await readRunJson(runDir);
    const current = observeVerificationArtifactExecutionAuthority(runDir, run, expectedAuthority.slice_id, expectedAuthority.verification_artifact_id, options);
    if (!sameJson(current, expectedAuthority)) throw new Error("checked verification artifact authority changed before receipt publication");
    const claimRef = verificationArtifactExecutionClaimRef(current.receipt_ref);
    assertExactActiveVerificationArtifactClaim(runDir, claimRef, expectedClaim, current);
    const receipt = validateVerificationArtifactExecutionReceipt(cloneJson(receiptInput));
    assertVerificationArtifactReceiptMatches(receipt, current, expectedClaim);
    const resolved = resolveEvidenceRef(runDir, current.receipt_ref, { mustExist: false });
    await writeProtectedJsonAtomic(runDir, current.receipt_ref, receipt, {
      commit: "create-only",
      hooks: {
        beforeCommit: () => {
          const observedRun = validateRun(parseJsonObjectFile(join(runDir, RUN_FILE), "verification artifact run.json"));
          const observed = observeVerificationArtifactExecutionAuthority(runDir, observedRun, current.slice_id, current.verification_artifact_id, options);
          if (!sameJson(observed, current)) throw new Error("checked verification artifact authority changed before receipt commit");
          assertExactActiveVerificationArtifactClaim(runDir, claimRef, expectedClaim, current);
        },
      },
    });
    const receiptHash = hashFile(resolved.path, { mode: "raw" });
    if (typeof options.afterArtifactReceiptPublication === "function") await options.afterArtifactReceiptPublication({ claim: cloneJson(expectedClaim), authority: current, receipt, receipt_hash: receiptHash });
    const completed = validateVerificationArtifactExecutionClaim({
      ...cloneJson(expectedClaim), state: "completed", completed_at: receipt.completed_at, status: receipt.status, receipt_hash: receiptHash,
    });
    await writeProtectedJsonAtomic(runDir, claimRef, completed, { hooks: { beforeCommit: () => {
      assertExactActiveVerificationArtifactClaim(runDir, claimRef, expectedClaim, current);
      const exactReceipt = validateVerificationArtifactExecutionReceipt(parseJsonObjectFile(resolved.path, "checked verification artifact receipt"));
      if (!sameJson(exactReceipt, receipt) || hashFile(resolved.path, { mode: "raw" }) !== receiptHash) throw new Error("checked verification artifact receipt changed before claim completion");
    } } });
    return { replayed: false, authority: current, claim: completed, claim_ref: claimRef, receipt, receipt_hash: receiptHash };
  }, options);
}

export async function markCheckedVerificationArtifactExecutionUnknown(runDir, expectedClaim, expectedAuthority, reason, options = {}) {
  if (!["process-outcome-indeterminate", "receipt-publication-indeterminate"].includes(reason)) throw new Error("checked verification artifact unknown reason is invalid");
  return withRunJsonLock(runDir, async () => {
    const claimRef = verificationArtifactExecutionClaimRef(expectedAuthority.receipt_ref);
    assertExactActiveVerificationArtifactClaim(runDir, claimRef, expectedClaim, expectedAuthority);
    const receiptResolved = resolveEvidenceRef(runDir, expectedAuthority.receipt_ref, { mustExist: false });
    let receiptBinding = {};
    if (existsSync(receiptResolved.path)) {
      const receipt = validateVerificationArtifactExecutionReceipt(parseJsonObjectFile(receiptResolved.path, "checked verification artifact receipt"));
      assertVerificationArtifactReceiptMatches(receipt, expectedAuthority, expectedClaim);
      receiptBinding = { status: receipt.status, receipt_hash: hashFile(receiptResolved.path, { mode: "raw" }) };
    }
    const unknown = validateVerificationArtifactExecutionClaim({
      ...cloneJson(expectedClaim), state: "unknown", failed_at: timestamp(options.now), reason, ...receiptBinding,
    });
    await writeProtectedJsonAtomic(runDir, claimRef, unknown, { hooks: { beforeCommit: () => {
      assertExactActiveVerificationArtifactClaim(runDir, claimRef, expectedClaim, expectedAuthority);
    } } });
    return { claim: unknown, claim_ref: claimRef };
  }, options);
}

function observeVerificationArtifactExecutionAuthority(runDir, run, sliceId, artifactId, options) {
  if (run.status !== "running") throw new Error("checked verification artifact execution requires a running run");
  const slice = (run.slices || []).find((candidate) => candidate?.id === sliceId);
  if (!slice || slice.status !== "running" || !Number.isInteger(slice.attempts) || slice.attempts < 1) {
    throw new Error(`checked verification artifact execution requires running slice '${sliceId}' at a positive attempt`);
  }
  const decomposition = observeAcceptedDecompositionAuthority(runDir, run, { ...options, requireIntegrationGate: true });
  const unit = decomposition.plan.delivery_envelope?.delivery_units.find((candidate) => candidate.slice_id === sliceId);
  const artifact = unit?.verification_artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) throw new Error(`verification artifact '${artifactId}' is not current for slice '${sliceId}'`);
  const gitAuthority = observeSliceHeadAuthority(runDir, run, sliceId, slice, options);
  const command = parseVerificationCommand(artifact.test_plan_entry);
  return {
    run_id: run.run_id,
    slice_id: sliceId,
    attempt: slice.attempts,
    plan_ref: PLAN_SLICES_REF,
    plan_hash: decomposition.plan_hash,
    head_sha: gitAuthority.head,
    timeout_ms: effectiveCheckedExecutionTimeoutMs(artifact.timeout_ms),
    verification_artifact_id: artifact.id,
    probe: {
      type: "verification-artifact",
      verification_artifact_id: artifact.id,
      test_plan_index: artifact.test_plan_index,
      test_plan_entry: artifact.test_plan_entry,
      program: command.program,
      args: command.args,
    },
    worktree: gitAuthority.worktree,
    receipt_ref: verificationArtifactExecutionReceiptRef(sliceId, artifact.id, slice.attempts),
  };
}

function assertVerificationArtifactReceiptMatches(receipt, authority, claim) {
  for (const key of ["run_id", "slice_id", "attempt", "plan_ref", "plan_hash", "head_sha", "verification_artifact_id"]) {
    if (receipt[key] !== authority[key]) throw new Error(`checked verification artifact receipt ${key} is stale`);
  }
  if (effectiveCheckedExecutionTimeoutMs(receipt.timeout_ms) !== authority.timeout_ms) throw new Error("checked verification artifact receipt timeout_ms is stale");
  if (receipt.subject !== authority.slice_id || !sameJson(receipt.probe, authority.probe)) {
    throw new Error("checked verification artifact receipt probe is stale");
  }
  const command = receipt.commands?.[0];
  if (receipt.status !== "skipped" && (!command || command.index !== 0 || command.program !== authority.probe.program || !sameJson(command.args, authority.probe.args))) {
    throw new Error("checked verification artifact receipt command does not match the exact authoritative probe");
  }
  if (!isRecord(claim) || receipt.claim_nonce !== claim.nonce) throw new Error("checked verification artifact receipt nonce does not match the exact active claim");
  if (receipt.status !== receipt.result.outcome) throw new Error("checked verification artifact receipt result is stale");
}

function assertVerificationArtifactClaimMatches(claim, authority) {
  for (const key of ["run_id", "slice_id", "attempt", "plan_ref", "plan_hash", "head_sha", "verification_artifact_id", "receipt_ref"]) {
    if (claim[key] !== authority[key]) throw new Error(`checked verification artifact claim ${key} is stale`);
  }
  if (effectiveCheckedExecutionTimeoutMs(claim.timeout_ms) !== authority.timeout_ms) throw new Error("checked verification artifact claim timeout_ms is stale");
  if (!sameJson(claim.probe, authority.probe)) throw new Error("checked verification artifact claim probe is stale");
}

function assertExactActiveVerificationArtifactClaim(runDir, claimRef, expectedClaim, authority) {
  const resolved = resolveEvidenceRef(runDir, claimRef);
  const observed = validateVerificationArtifactExecutionClaim(parseJsonObjectFile(resolved.path, "checked verification artifact claim"));
  assertVerificationArtifactClaimMatches(observed, authority);
  if (observed.state !== "active" || !sameJson(observed, expectedClaim)) throw operatorReconciliationRequired("active checked verification artifact execution claim changed or is missing");
  return observed;
}

export async function markCheckedTestExecutionUnknown(runDir, expectedClaim, reason, options = {}) {
  if (!TEST_EXECUTION_UNKNOWN_REASONS.has(reason)) throw new Error("unknown checked execution reason is invalid");
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    const step = uniqueTestVerifierStep(current);
    assertExactActiveExecutionClaim(step, expectedClaim);
    const next = await persistUnknownTestExecutionLocked(runDir, current, step, expectedClaim, reason, options);
    return { updated: true, status: next.status, run: next, claim: cloneJson(uniqueTestVerifierStep(next).execution_claim) };
  }, options);
}

async function persistUnknownTestExecutionLocked(runDir, current, step, expectedClaim, reason, options) {
  assertExactActiveExecutionClaim(step, expectedClaim);
  const next = cloneJson(current);
  const nextStep = uniqueTestVerifierStep(next);
  nextStep.execution_claim = {
    ...cloneJson(expectedClaim),
    state: "unknown",
    failed_at: timestamp(options.now),
    reason,
  };
  nextStep.execution_claim_hash = hashValue(nextStep.execution_claim);
  validateRun(next);
  await writeProtectedRunJson(runDir, next, options, () => {
    const observed = validateRun(parseJsonObjectFile(join(runDir, RUN_FILE), "checked test execution unknown run.json"));
    assertExactActiveExecutionClaim(uniqueTestVerifierStep(observed), expectedClaim);
  });
  return next;
}

function replayCheckedTestExecutionLocked(runDir, current, step, options) {
  const authority = observeCheckedTestExecutionAuthority(runDir, current, options, { allowCompleted: true });
  const observed = observeCompletedCheckedTestExecutionAuthority(runDir, current, step, authority);
  if (step.execution_claim.status === "fail") {
    assertWholeStorySinkAllowed({ route: classifyWholeStoryTestRoute(runDir, current, options), sink: "SINK13", claim: "completed-fail", evidence: "exact-fail", head: "equal" });
  }
  return { replayed: true, run: current, step: cloneJson(step), claim: cloneJson(step.execution_claim), authority, result: checkedTestExecutionEnvelope(current, step, observed.receipt_hash, true) };
}

function checkedTestExecutionEnvelope(run, step, receiptHash, replayed) {
  const claim = step.execution_claim;
  return {
    ok: claim.status === "pass",
    run_id: run.run_id,
    attempt: step.attempts,
    status: claim.status,
    step_status: step.status,
    head_sha: claim.head_sha,
    plan_hash: claim.plan_hash,
    receipt_ref: claim.receipt_ref,
    receipt_hash: receiptHash,
    replayed,
  };
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
    if (continuation?.schema_version === 2) throw new Error("schema-v2 carry-forward spec adoption is already canonical and immutable");
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
    bindStepAcceptance(runDir, steps[stepIndex], draft, options);
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
  const checkpointBound = Object.hasOwn(continuation, "checkpoint_source_hash");
  if (checkpointBound !== Object.hasOwn(continuation, "configuration_hash")) throw new Error("continuation checkpoint bindings are incomplete");
  if (checkpointBound) {
    if (!isRecord(parentRun.checkpoint_source) || hashValue(parentRun.checkpoint_source) !== continuation.checkpoint_source_hash) {
      throw new Error("continuation checkpoint_source binding is stale or cross-checkpoint");
    }
    if (hashValue(continuation.configuration) !== continuation.configuration_hash) throw new Error("continuation configuration hash is stale");
    assertRunMatchesContinuationConfiguration(parentRun, continuation.configuration, "continuation parent");
  } else if (parentRun.checkpoint_source !== undefined) {
    throw new Error("checkpoint-source parent requires checkpoint-bound continuation authority");
  }
  const branch = git(repo, ["rev-parse", "--verify", `refs/heads/${continuation.parent.branch}^{commit}`]);
  if (!branch.ok || branch.stdout.trim() !== continuation.parent.commit) throw new Error("continuation parent branch/commit binding is stale");

  const reviewSource = continuationReviewAuthority(parentRun, continuation.review.ref);
  if (!reviewSource || reviewSource.kind !== continuation.review.kind || reviewSource.source !== continuation.review.source) throw new Error("continuation selected review source is stale");
  const selectedReview = readBoundContinuationFile(parentRunDir(parentFile), continuation.review.ref, continuation.review.hash, resolveReviewRef, "selected review");
  if (reviewSource.hash && selectedReview.hash !== reviewSource.hash) throw new Error("continuation selected terminal review differs from its exact source binding");
  const selectedSubject = String(selectedReview.value.subject || "").trim();
  if (!reviewSource.subjects.has(selectedSubject)) throw new Error("continuation selected review subject is cross-bound");
  const selectedVerdict = stringValue(selectedReview.value.verdict) ? String(selectedReview.value.verdict).trim() : null;
  const selectedSummary = stringValue(selectedReview.value.summary)
    ? String(selectedReview.value.summary).trim()
    : selectedVerdict && APPROVING_CONTINUATION_REVIEW_VERDICTS.has(selectedVerdict.toUpperCase())
      ? `Review recorded ${selectedVerdict} for ${selectedSubject}.`
      : null;
  const currentReview = {
    kind: reviewSource.kind,
    ref: selectedReview.ref,
    hash: selectedReview.hash,
    subject: selectedSubject,
    summary: selectedSummary,
    required_fixes: Array.isArray(selectedReview.value.required_fixes) ? selectedReview.value.required_fixes.filter(stringValue).map((value) => String(value).trim()) : [],
  };
  if (selectedVerdict) currentReview.verdict = selectedVerdict;
  if (stringValue(reviewSource.source)) currentReview.source = reviewSource.source;
  if (!sameJson(currentReview, continuation.review)) throw new Error("continuation selected review identity is stale or cross-bound");
  const expectedSummary = `Continue blocked run '${parentRun.run_id}' from ${continuation.review.ref}.`;
  if (continuation.operator_summary !== expectedSummary) throw new Error("continuation operator_summary is stale or cross-bound");

  assertContinuationContext(parentFile, parentRun, continuation);
  assertContinuationPlanningReuse(parentFile, parentRun, continuation);
  assertContinuationPostPr(parentFile, parentRun, continuation);
  if (continuation.schema_version === 2) assertV2ContinuationPlanAuthority(parentFile, parentRun, continuation);
  assertContinuationTarget(repo, run, parentRun, continuation);
  return { parentRun, repo, parentFile };
}

function assertV2ContinuationPlanAuthority(parentFile, parentRun, continuation) {
  const parentDir = dirname(parentFile);
  let authority;
  try { authority = observeAcceptedDecompositionAuthority(parentDir, parentRun, { requireIntegrationGate: true }); }
  catch (error) { throw new Error(`schema-v2 continuation bound plan/decomposition authority is invalid: ${error.message}`); }
  if (authority.plan_hash !== continuation.carry_forward.plan_hash) {
    throw new Error("schema-v2 continuation bound plan bytes do not match carry_forward.plan_hash");
  }
}

export function observeCarryForwardAuthority(repoInput, parentRunDirInput, parentRun, targetBaseRef, targetBaseCommit, options = {}) {
  const repo = repoRoot(repoInput);
  const parentRunDir = resolve(parentRunDirInput);
  const planRef = PLAN_SLICES_REF;
  let decomposition;
  try { decomposition = observeAcceptedDecompositionAuthority(parentRunDir, parentRun, { requireIntegrationGate: true }); }
  catch (error) { throw new Error(`accepted work-decomposer plan authority for the bound plan is invalid: ${error.message}`); }
  const { plan, plan_bytes: planBytes } = decomposition;

  const runSlices = Array.isArray(parentRun.slices) ? parentRun.slices : [];
  const runById = new Map(runSlices.map((slice) => [slice?.id, slice]));
  if (runById.size !== runSlices.length || runSlices.length !== plan.slices.length) throw new Error("parent run slices must exactly classify the bound plan");
  const acceptedSlices = [];
  const remainingSliceIds = [];
  for (const planned of plan.slices) {
    const slice = runById.get(planned.id);
    if (!slice || slice.stack !== planned.stack || !sameJson(slice.depends_on, planned.depends_on)) throw new Error(`parent slice '${planned.id}' identity/dependencies do not match the bound plan`);
    if (!sameJson(slice.declared_paths, planned.paths)) throw new Error(`parent slice '${planned.id}' declared_paths do not match the bound plan`);
    if (slice.status !== "merged") { remainingSliceIds.push(planned.id); continue; }
    if (!Number.isInteger(slice.attempts) || slice.attempts < 1) throw new Error(`accepted slice '${planned.id}' attempts must be positive`);
    const observed = assertSliceReviewBindingCurrent(parentRunDir, planned.id, slice);
    if (observed.review.verdict !== "APPROVE") throw new Error(`accepted slice '${planned.id}' requires APPROVE review`);
    if (slice.integration_conflict) assertSliceIntegrationConflictCurrent(parentRunDir, parentRun, slice, { ...options, repoRoot: repo });
    acceptedSlices.push({
      id: planned.id, declared_paths: cloneJson(slice.declared_paths), effective_paths: cloneJson(slice.effective_paths),
      attempts: slice.attempts, evidence_ref: slice.evidence_ref, evidence_hash: slice.evidence_hash,
      review_ref: slice.review_ref, review_hash: slice.review_hash, reviewed_commit: slice.reviewed_commit, merge_commit: slice.merge_commit,
      attempt_reviews: cloneJson(slice.attempt_reviews),
      ...(slice.integration_conflict ? { integration_conflict: cloneJson(slice.integration_conflict) } : {}),
    });
  }
  if (remainingSliceIds.length === 0) throw new Error("v2 carry-forward requires at least one nonmerged slice");

  const branch = git(repo, ["rev-parse", "--verify", `refs/heads/${parentRun.branch}^{commit}`]);
  if (!branch.ok || !/^[0-9a-f]{40}$/u.test(branch.stdout.trim())) throw new Error("v2 carry-forward parent branch HEAD cannot be observed");
  const startCommit = branch.stdout.trim();
  assertObservedCarryForwardIntegration(repo, parentRunDir, parentRun, targetBaseCommit, startCommit, acceptedSlices, options);
  assertObservedCarryForwardPanels(parentRunDir, parentRun, startCommit);
  assertObservedOriginBase(repo, targetBaseRef, targetBaseCommit, startCommit, options);
  return {
    scope: "full-remaining-plan", plan_ref: planRef, plan_hash: decomposition.plan_hash,
    start_commit: startCommit, accepted_slices: acceptedSlices, remaining_slice_ids: remainingSliceIds,
  };
}

function assertObservedCarryForwardIntegration(repo, parentRunDir, parentRun, baseCommit, startCommit, acceptedSlices, options = {}) {
  if (!git(repo, ["merge-base", "--is-ancestor", baseCommit, startCommit]).ok) throw new Error("v2 carry-forward start_commit must descend from target.base_commit");
  if (acceptedSlices.length === 0) {
    if (startCommit !== baseCommit) throw new Error("v2 carry-forward with zero accepted slices requires start_commit equal target.base_commit");
    return;
  }
  const chainResult = git(repo, ["rev-list", "--first-parent", "--reverse", `${baseCommit}..${startCommit}`]);
  if (!chainResult.ok) throw new Error("v2 carry-forward first-parent merge chain cannot be observed");
  const chain = chainResult.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  const acceptedByMerge = new Map(acceptedSlices.map((slice) => [slice.merge_commit, slice]));
  if (chain.length !== acceptedSlices.length || acceptedByMerge.size !== acceptedSlices.length || chain.some((commit) => !acceptedByMerge.has(commit))) {
    throw new Error("v2 carry-forward first-parent range must contain all and only accepted merge commits exactly once");
  }
  for (const [index, mergeCommit] of chain.entries()) {
    const accepted = acceptedByMerge.get(mergeCommit);
    let firstParent;
    if (accepted.integration_conflict) {
      assertSliceIntegrationConflictCurrent(parentRunDir, parentRun, parentRun.slices.find((slice) => slice.id === accepted.id), { ...options, repoRoot: repo });
      firstParent = accepted.integration_conflict.integration_baseline;
    } else firstParent = observeReviewedMergeProof(repo, accepted.id, mergeCommit, accepted.reviewed_commit).first_parent;
    const expectedFirstParent = index === 0 ? baseCommit : chain[index - 1];
    if (firstParent !== expectedFirstParent) throw new Error(`accepted slice '${accepted.id}' merge first parent does not match the actual first-parent chain`);
  }
}

function assertObservedCarryForwardPanels(parentRunDir, parentRun, startCommit) {
  const validatorKeys = ["report_hash", "review_hash", "reviewed_head_sha"];
  const securityKeys = ["review_hash", "reviewed_head_sha"];
  const any = validatorKeys.some((key) => parentRun.validator?.[key] !== undefined) || securityKeys.some((key) => parentRun.security_review?.[key] !== undefined);
  if (!any) return;
  if (!validatorKeys.every((key) => parentRun.validator?.[key] != null) || !securityKeys.every((key) => parentRun.security_review?.[key] != null)) throw new Error("optional parent validator/security successor bindings must be all-or-none complete");
  if (parentRun.validator.reviewed_head_sha !== startCommit || parentRun.security_review.reviewed_head_sha !== startCommit) throw new Error("optional parent panel reviewed heads must equal carry_forward.start_commit");
  assertPanelReviewBindingsCurrent(parentRunDir, parentRun);
}

function assertObservedOriginBase(repo, targetBaseRef, targetBaseCommit, startCommit, options) {
  const prefix = "refs/remotes/origin/";
  if (!targetBaseRef.startsWith(prefix) || targetBaseRef.length === prefix.length) throw carryForwardOutcomeError("origin-base-invalid", "target.base_ref must identify one origin branch");
  const remoteRef = `refs/heads/${targetBaseRef.slice(prefix.length)}`;
  const gitOptions = { timeout: 30000, ...(typeof options.originSpawnSync === "function" ? { spawnSync: options.originSpawnSync } : {}) };
  const observed = git(repo, ["ls-remote", "--exit-code", "origin", remoteRef], gitOptions);
  const lines = observed.stdout.split(/\r?\n/u).filter(Boolean);
  const match = observed.ok && lines.length === 1 ? /^([0-9a-f]{40})\t(.+)$/u.exec(lines[0]) : null;
  if (!match || match[2] !== remoteRef) throw carryForwardOutcomeError("origin-base-unavailable", "configured origin base could not be observed unambiguously");
  const tip = match[1];
  if (typeof options.beforeOriginFetch === "function") options.beforeOriginFetch({ oid: tip, remote_ref: remoteRef });
  const fetched = git(repo, ["fetch", "--no-tags", "--quiet", "--no-write-fetch-head", "origin", tip], gitOptions);
  if (!fetched.ok) throw carryForwardOutcomeError("origin-base-unavailable", "captured origin base commit could not be fetched");
  const fetchedCommit = git(repo, ["rev-parse", "--verify", `${tip}^{commit}`]);
  if (!fetchedCommit.ok || fetchedCommit.stdout.trim() !== tip) throw carryForwardOutcomeError("origin-base-unavailable", "captured origin base commit is not an unambiguous commit");
  if (tip === targetBaseCommit) return;
  const contains = git(repo, ["merge-base", "--is-ancestor", startCommit, tip]);
  if (contains.ok) throw carryForwardOutcomeError("rebaseline-required", "configured origin base already contains carry_forward.start_commit");
  if (contains.status === 1) throw carryForwardOutcomeError("stale-parent-base-moved", "configured origin base moved without containing carry_forward.start_commit");
  throw carryForwardOutcomeError("origin-base-unavailable", "configured origin base ancestry could not be observed");
}

function carryForwardOutcomeError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

export function assertPublishedCarryForwardRun(repoInput, expectedContinuation, options = {}) {
  const repo = repoRoot(repoInput);
  if (expectedContinuation?.schema_version !== 2 || expectedContinuation?.kind !== "blocked-run-continuation") throw new Error("published carry-forward check requires schema-v2 continuation metadata");
  const runDir = resolve(directFactoryRoot(repo), expectedContinuation.target?.run_id || "invalid-carry-forward");
  const runFile = join(runDir, "run.json");
  assertNoSymlinkPath(repo, runFile, "published carry-forward run.json");
  if (!existsSync(runFile) || !lstatSync(runFile).isFile()) throw new Error("schema-v2 carry-forward payload requires an exact published child run");
  const run = validateRun(parseJsonObjectFile(runFile, "published carry-forward run.json"));
  if (!sameJson(run.continuation, expectedContinuation)) throw new Error("schema-v2 carry-forward payload does not match the published child continuation");
  const validation = validateRunDir(runDir);
  if (!validation.ok) throw new Error("published carry-forward child directory is invalid");
  const parent = assertContinuationAuthorityCurrent(runDir, run, { repoRoot: repo });
  const observedCarryForward = observeCarryForwardAuthority(repo, dirname(parent.parentFile), parent.parentRun, expectedContinuation.target.base_ref, expectedContinuation.target.base_commit, options);
  if (!sameJson(observedCarryForward, expectedContinuation.carry_forward)) throw new Error("continuation carry_forward authority changed after publication");
  assertPublishedCarryForwardConfiguration(run, options.expectedConfiguration);

  const planRef = expectedContinuation.carry_forward.plan_ref;
  const planPath = resolve(runDir, planRef);
  assertNoSymlinkPath(runDir, planPath, "published carry-forward plan");
  if (!existsSync(planPath) || !lstatSync(planPath).isFile() || hashFile(planPath) !== expectedContinuation.carry_forward.plan_hash) throw new Error("published carry-forward plan bytes do not match continuation authority");
  const plan = parseSlicesPlanBytes(readFileSync(planPath), { label: "published carry-forward plan", enforceDependencyDepth: false, requireIntegrationGate: true, allowLegacyExecutionTimeouts: true });
  assertPublishedCarryForwardSlices(runDir, run, plan, expectedContinuation.carry_forward);
  assertPublishedCarryForwardSpec(runDir, run, expectedContinuation);
  observeAcceptedDecompositionAuthority(runDir, run, { requireIntegrationGate: true });
  assertPublishedCarryForwardClaim(repo, expectedContinuation);

  const branchRef = `refs/heads/${run.branch}`;
  const branch = git(repo, ["rev-parse", "--verify", `${branchRef}^{commit}`]);
  if (!branch.ok || !git(repo, ["merge-base", "--is-ancestor", expectedContinuation.carry_forward.start_commit, branch.stdout.trim()]).ok) throw new Error("published carry-forward branch no longer descends from start_commit");
  const worktree = checkWorktreeIdentity(repo, run.worktree, { branch: run.branch, head: branch.stdout.trim() });
  if (!worktree.ok) throw new Error(`published carry-forward worktree identity is invalid: ${worktree.reason}`);
  if ((run.steps || []).some((step) => step?.agent === "test-verifier" && step.status === "accepted")) {
    assertCheckedFreshDownstreamAuthority(runDir, run, "published carry-forward authority");
  }
  if (options.driver) assertCarryForwardDriverProjection(run, options.driver);
  if (options.postPrPolicy !== undefined && !sameJson(run.post_pr?.policy, options.postPrPolicy)) throw new Error("schema-v2 resume policy does not match published child configuration");
  return run;
}

export function assertPublishedCarryForwardRunById(repoInput, runId, options = {}) {
  const repo = repoRoot(repoInput);
  const runFile = resolve(directFactoryRoot(repo), runId, "run.json");
  assertNoSymlinkPath(repo, runFile, "published carry-forward resume run.json");
  if (!existsSync(runFile)) throw new Error("schema-v2 resume requires a published carry-forward child");
  const run = validateRun(parseJsonObjectFile(runFile, "published carry-forward resume run.json"));
  if (run.continuation?.schema_version !== 2) throw new Error("schema-v2 resume requires a published carry-forward child");
  return assertPublishedCarryForwardRun(repo, run.continuation, options);
}

export function inspectContinuationRouteSchema(repoInput, runId, claimedSchema, options = {}) {
  const repo = repoRoot(repoInput);
  const claims = observePermanentContinuationClaims(repo, runId);
  const reservation = observeContinuationTargetReservation(repo, runId);
  if (reservation && reservation.route_schema !== claimedSchema) throw routeSchemaError(options.route === "resume" ? "resume-schema-route-mismatch" : "continuation-schema-route-mismatch");
  const runFile = resolve(directFactoryRoot(repo), runId, "run.json");
  assertNoSymlinkPath(repo, runFile, "continuation route run.json");
  if (!existsSync(runFile)) {
    if (claims.length > 0) throw routeSchemaError(options.route === "resume" ? "resume-schema-route-mismatch" : "continuation-schema-route-mismatch");
    return null;
  }
  if (!lstatSync(runFile).isFile()) throw routeSchemaError(options.route === "resume" ? "resume-schema-route-mismatch" : "continuation-schema-route-mismatch");
  const run = validateRun(parseJsonObjectFile(runFile, "continuation route run.json"));
  if (run.integration_amendment != null) throw new Error("integration-amendment-continuation-unsupported");
  const persistedSchema = options.route === "resume" && run.continuation === undefined ? options.ordinaryResumeSchema ?? 1 : run.continuation?.schema_version;
  if (persistedSchema !== claimedSchema) throw routeSchemaError(options.route === "resume" ? "resume-schema-route-mismatch" : "continuation-schema-route-mismatch");
  if ((persistedSchema === 2) !== (claims.length === 1)) throw routeSchemaError(options.route === "resume" ? "resume-schema-route-mismatch" : "continuation-schema-route-mismatch");
  if (claimedSchema === 2 && options.route === "resume" && !sameJson(run.post_pr?.policy, options.postPrPolicy)) throw routeSchemaError("resume-policy-route-mismatch");
  return run;
}

export function observeContinuationTargetReservation(repoInput, runId) {
  const repo = repoRoot(repoInput);
  const ref = `refs/opencode/continuation-targets/${createHash("sha256").update(runId, "utf8").digest("hex")}`;
  const observed = git(repo, ["show-ref", "--verify", "--hash", ref]);
  if (!observed.ok) return null;
  const oid = observed.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(oid)) throw new Error("continuation target reservation has an invalid object id");
  const type = git(repo, ["cat-file", "-t", oid]);
  const content = git(repo, ["cat-file", "blob", oid]);
  if (!type.ok || type.stdout.trim() !== "blob" || !content.ok) throw new Error("continuation target reservation is malformed");
  let reservation;
  try {
    reservation = JSON.parse(content.stdout);
  } catch {
    throw new Error("continuation target reservation is malformed");
  }
  if (!isRecord(reservation) || Object.keys(reservation).length !== 6 || reservation.schema_version !== 1
    || reservation.kind !== "continuation-target-reservation" || reservation.child_run_id !== runId
    || ![1, 2].includes(reservation.route_schema) || !/^sha256:[a-f0-9]{64}$/u.test(String(reservation.authority_hash || ""))
    || !stringValue(reservation.created_at) || !Number.isFinite(Date.parse(reservation.created_at))
    || !Buffer.from(content.stdout).equals(canonicalJsonBytes(reservation))) {
    throw new Error("continuation target reservation is malformed");
  }
  return { ref, oid, ...reservation };
}

export function assertContinuationReservationAuthority(repoInput, continuation) {
  const reservation = observeContinuationTargetReservation(repoInput, continuation.target.run_id);
  if (!reservation) throw routeSchemaError("continuation-schema-route-mismatch");
  if (reservation.route_schema !== continuation.schema_version || reservation.created_at !== continuation.created_at
    || reservation.authority_hash !== hashValue(continuation)) {
    throw routeSchemaError("continuation-schema-route-mismatch");
  }
  return reservation;
}

export function observePermanentContinuationClaims(repoInput, runId) {
  const repo = repoRoot(repoInput);
  const listed = git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/opencode/continuations"]);
  if (!listed.ok) {
    const repository = git(repo, ["rev-parse", "--git-dir"]);
    if (!repository.ok) return [];
    throw new Error("permanent continuation claims could not be inspected");
  }
  const matches = [];
  for (const line of listed.stdout.split("\n").filter(Boolean)) {
    const parsed = /^(refs\/opencode\/continuations\/[a-f0-9]{64}) ([0-9a-f]{40})$/u.exec(line);
    if (!parsed) throw new Error("continuation claim conflict: malformed permanent claim blocks routing");
    const [, ref, oid] = parsed;
    const type = git(repo, ["cat-file", "-t", oid]);
    const content = git(repo, ["cat-file", "blob", oid]);
    if (!type.ok || type.stdout.trim() !== "blob" || !content.ok) throw new Error(`continuation claim conflict: malformed permanent claim '${ref}' blocks routing`);
    let claim;
    try {
      claim = JSON.parse(content.stdout);
    } catch {
      throw new Error(`continuation claim conflict: malformed permanent claim '${ref}' blocks routing`);
    }
    const checkpointBound = Object.hasOwn(claim, "checkpoint_source_hash");
    if (!isRecord(claim) || claim.schema_version !== 2 || claim.kind !== "blocked-run-continuation-claim"
      || !isRecord(claim.parent_identity) || !stringValue(claim.child_run_id) || !stringValue(claim.child_branch_ref)
      || !/^[0-9a-f]{40}$/u.test(String(claim.start_commit || "")) || !content.stdout || !Buffer.from(content.stdout).equals(canonicalJsonBytes(claim))) {
      throw new Error(`continuation claim conflict: malformed permanent claim '${ref}' blocks routing`);
    }
    if (checkpointBound !== Object.hasOwn(claim, "configuration_hash")
      || checkpointBound && (!/^sha256:[a-f0-9]{64}$/u.test(claim.checkpoint_source_hash) || !/^sha256:[a-f0-9]{64}$/u.test(claim.configuration_hash))) {
      throw new Error(`continuation claim conflict: malformed permanent claim '${ref}' blocks routing`);
    }
    if (claim.child_run_id === runId) matches.push({ ref, oid, claim, bytes: content.stdout });
  }
  if (matches.length > 1) throw new Error(`multiple permanent continuation claims target run '${runId}'`);
  return matches;
}

function routeSchemaError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertPublishedCarryForwardConfiguration(run, expected) {
  const checkpointBound = Object.hasOwn(run.continuation, "checkpoint_source_hash");
  const actual = {
    mode: run.mode,
    github_account: run.github_account ?? null,
    pr_mode: run.pr_mode,
    max_parallel_slices: run.max_parallel_slices,
    max_retries: run.max_retries,
    policy: run.post_pr?.policy,
  };
  if (actual.max_parallel_slices !== 3 || actual.max_retries !== 3 || !actual.mode || !actual.pr_mode || !isRecord(actual.policy)) throw new Error("published carry-forward child configuration is incomplete");
  const persisted = run.continuation?.configuration;
  const bound = isRecord(persisted) ? {
    mode: persisted.mode,
    github_account: persisted.github_account ?? null,
    pr_mode: persisted.pr_mode,
    max_parallel_slices: persisted.max_parallel_slices,
    max_retries: persisted.max_retries,
    policy: persisted.post_pr_policy,
  } : null;
  if (!bound || (checkpointBound ? hashValue(actual) !== hashValue(bound) : !sameJson(actual, bound))) throw new Error("published carry-forward child configuration differs from immutable continuation configuration");
  assertRunMatchesContinuationConfiguration(run, persisted, "published carry-forward child");
  if (checkpointBound) {
    if (!isRecord(run.checkpoint_source) || hashValue(run.checkpoint_source) !== run.continuation.checkpoint_source_hash) throw new Error("published carry-forward child checkpoint_source is stale or cross-checkpoint");
    if (hashValue(persisted) !== run.continuation.configuration_hash) throw new Error("published carry-forward child configuration hash is stale");
  } else if (run.checkpoint_source !== undefined) throw new Error("non-checkpoint carry-forward child cannot introduce checkpoint_source");
  if (!expected) return;
  const wanted = { mode: expected.mode, github_account: expected.github_account ?? null, pr_mode: expected.pr_mode, max_parallel_slices: 3, max_retries: 3, policy: expected.post_pr?.policy };
  if (checkpointBound ? hashValue(actual) !== hashValue(wanted) : !sameJson(actual, wanted)) throw new Error("current carry-forward invocation conflicts with published immutable configuration");
  const expectedTier = Object.hasOwn(expected, "review_tier") ? expected.review_tier : undefined;
  const actualTier = Object.hasOwn(run, "review_tier") ? run.review_tier : null;
  if (expectedTier !== undefined && actualTier !== expectedTier) throw new Error("current carry-forward invocation conflicts with published immutable review_tier");
}

function assertRunMatchesContinuationConfiguration(run, configuration, label) {
  if (!isRecord(configuration)) throw new Error(`${label} configuration is missing`);
  const expectedTier = Object.hasOwn(configuration, "review_tier") ? configuration.review_tier : undefined;
  const tierMatches = expectedTier === null ? !Object.hasOwn(run, "review_tier") : run.review_tier === expectedTier;
  if (run.mode !== configuration.mode || (run.github_account ?? null) !== configuration.github_account || run.pr_mode !== configuration.pr_mode
    || run.max_parallel_slices !== configuration.max_parallel_slices || run.max_retries !== configuration.max_retries
    || (Object.hasOwn(run.continuation || {}, "checkpoint_source_hash") || run.checkpoint_source?.kind === "delivery-checkpoint-source"
      ? hashValue(run.post_pr?.policy) !== hashValue(configuration.post_pr_policy)
      : !sameJson(run.post_pr?.policy, configuration.post_pr_policy)) || !tierMatches) {
    throw new Error(`${label} differs from immutable continuation configuration`);
  }
}

function assertPublishedCarryForwardSlices(runDir, run, plan, carry) {
  const rows = Array.isArray(run.slices) ? run.slices : [];
  if (rows.length !== plan.slices.length || rows.some((row, index) => row.id !== plan.slices[index].id || row.stack !== plan.slices[index].stack || !sameJson(row.depends_on, plan.slices[index].depends_on))) {
    throw new Error("published carry-forward slices must remain in exact PLAN order with plan identity and dependencies");
  }
  const accepted = new Map(carry.accepted_slices.map((row) => [row.id, row]));
  for (const row of rows) {
    const adopted = accepted.get(row.id);
    if (!adopted) continue;
    const expected = {
      id: row.id, stack: row.stack, depends_on: row.depends_on, declared_paths: adopted.declared_paths, effective_paths: adopted.effective_paths,
      status: "merged", attempts: adopted.attempts,
      evidence_ref: adopted.evidence_ref, evidence_hash: adopted.evidence_hash, review_ref: adopted.review_ref, review_hash: adopted.review_hash,
      reviewed_commit: adopted.reviewed_commit, merge_commit: adopted.merge_commit, attempt_reviews: adopted.attempt_reviews,
      ...(adopted.integration_conflict ? { integration_conflict: adopted.integration_conflict } : {}),
    };
    if (!sameJson(row, expected)) throw new Error(`adopted carry-forward slice '${row.id}' is immutable`);
    for (const [ref, hash, label] of [[row.evidence_ref, row.evidence_hash, "evidence"], [row.review_ref, row.review_hash, "review"]]) {
      const path = resolve(runDir, ref);
      assertNoSymlinkPath(runDir, path, `adopted slice ${label}`);
      if (!existsSync(path) || !lstatSync(path).isFile() || hashFile(path) !== hash) throw new Error(`adopted carry-forward slice '${row.id}' ${label} sidecar changed`);
    }
    if (row.integration_conflict) assertSliceIntegrationConflictCurrent(runDir, run, row, { runDir });
  }
}

function assertPublishedCarryForwardSpec(runDir, run, continuation) {
  if (isCheckpointPlanningReuse(continuation)) {
    if ((run.steps || []).some((item) => item?.agent === "spec-writer")) {
      throw new Error("checkpoint carry-forward must not synthesize a spec-writer step");
    }
    for (const ref of ["artifacts/technical-brief.md", "reviews/spec-writer.json"]) {
      if (existsSync(resolve(runDir, ref))) throw new Error(`checkpoint carry-forward must not synthesize ${ref}`);
    }
    const reuse = continuation.planning_reuse;
    const authority = observeAcceptedDecompositionAuthority(runDir, run, { requireIntegrationGate: true, requireApprovingReview: true });
    if (authority.plan_ref !== reuse.plan_ref || authority.plan_hash !== reuse.plan_hash
      || authority.review_ref !== reuse.review_ref || authority.review_hash !== reuse.review_hash) {
      throw new Error("published checkpoint carry-forward work-decomposer authority is not exact");
    }
    return;
  }
  const step = (run.steps || []).find((item) => item?.agent === "spec-writer");
  const reuse = continuation.planning_reuse;
  const expected = canonicalCarryForwardSpecStep(continuation);
  if (!sameJson(step, expected)) throw new Error("published carry-forward spec acceptance is not the exact inherited acceptance");
  const copiedPlanning = continuation.parent_artifacts.filter((item) => CARRY_FORWARD_PLANNING_KINDS.has(item.kind));
  if (!copiedPlanning.some((item) => item.kind === "technical_brief" && item.ref === reuse.spec_artifact_ref && item.hash === reuse.spec_artifact_hash)) {
    throw new Error("published carry-forward technical brief is not bound by parent_artifacts and planning_reuse");
  }
  for (const { ref, hash } of copiedPlanning) {
    const path = resolve(runDir, ref);
    assertNoSymlinkPath(runDir, path, "published inherited planning file");
    if (!existsSync(path) || !lstatSync(path).isFile() || hashFile(path) !== hash) throw new Error("published inherited planning bytes changed");
  }
  const reviewPath = resolve(runDir, reuse.child_spec_review_ref);
  assertNoSymlinkPath(runDir, reviewPath, "published inherited spec review");
  if (!existsSync(reviewPath) || !lstatSync(reviewPath).isFile() || hashFile(reviewPath) !== reuse.spec_review_hash) throw new Error("published inherited spec review bytes changed");
}

function assertPublishedCarryForwardClaim(repo, continuation) {
  const parentIdentity = {
    schema_version: 2, kind: "blocked-run-continuation-parent", parent_run_id: continuation.parent.run_id,
    parent_run_ref: continuation.parent.run_ref, parent_run_hash: continuation.parent.run_hash,
    parent_branch_ref: `refs/heads/${continuation.parent.branch}`, target_base_ref: continuation.target.base_ref,
    target_base_commit: continuation.target.base_commit, plan_ref: continuation.carry_forward.plan_ref,
    plan_hash: continuation.carry_forward.plan_hash, start_commit: continuation.carry_forward.start_commit,
  };
  const claim = {
    schema_version: 2, kind: "blocked-run-continuation-claim", parent_identity: parentIdentity, child_run_id: continuation.target.run_id,
    child_branch_ref: `refs/heads/${continuation.target.branch}`, start_commit: continuation.carry_forward.start_commit,
    ...(Object.hasOwn(continuation, "checkpoint_source_hash") ? { checkpoint_source_hash: continuation.checkpoint_source_hash, configuration_hash: continuation.configuration_hash } : {}),
  };
  const parentBytes = canonicalJsonBytes(parentIdentity);
  const claimBytes = canonicalJsonBytes(claim);
  const claimRef = `refs/opencode/continuations/${createHash("sha256").update(parentBytes).digest("hex")}`;
  const claims = observePermanentContinuationClaims(repo, continuation.target.run_id);
  if (claims.length !== 1) throw new Error("published carry-forward permanent claim is missing");
  const [observed] = claims;
  if (observed.ref !== claimRef || observed.bytes !== claimBytes.toString("utf8")) throw new Error("published carry-forward permanent claim bytes mismatch");
  const reservation = observeContinuationTargetReservation(repo, continuation.target.run_id);
  if (!reservation || reservation.route_schema !== 2 || reservation.created_at !== continuation.created_at
    || reservation.authority_hash !== hashValue(continuation)) {
    throw new Error("published carry-forward target reservation is missing, stale, or cross-schema");
  }
}

function assertCarryForwardDriverProjection(run, driver) {
  const expected = {
    mode: run.mode,
    ready: run.pr_mode === "ready",
    pr_mode: run.pr_mode,
    reviewer: run.post_pr.policy.review.required ? run.post_pr.policy.review.reviewer_login : null,
    github_account: run.github_account ?? null,
    post_pr_ci: Object.fromEntries(Object.entries(cloneJson(run.post_pr.policy)).filter(([key]) => key !== "review")),
  };
  if (!sameJson(driver, expected)) throw new Error("schema-v2 payload driver does not exactly project published child configuration");
}

function canonicalJsonBytes(value) {
  const canonical = (input) => Array.isArray(input) ? input.map(canonical) : isRecord(input) ? Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])])) : input;
  return Buffer.from(JSON.stringify(canonical(value)), "utf8");
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

function resolveExactPlanSlicesFile(runDir, ref, label) {
  if (ref !== PLAN_SLICES_REF) throw new Error(`${label} must be exactly '${PLAN_SLICES_REF}'`);
  const path = join(resolve(runDir), "plan", "slices.json");
  assertNoSymlinkPath(runDir, path, label);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error(`${label} must be a regular non-symlink file contained in the run directory`);
  }
  return path;
}

function continuationReviewAuthority(parentRun, ref) {
  const terminalSource = terminalNonconvergenceReviewAuthority(parentRun);
  if (terminalSource) return terminalSource.ref === ref ? terminalSource : null;
  const subjects = new Set([parentRun.run_id, parentRun.branch, "feature-branch"].filter(stringValue).map((value) => String(value).trim()));
  const candidates = [];
  if (stringValue(parentRun.post_pr?.continuation_review?.ref)) candidates.push({ kind: "post_pr", source: "run.post_pr.continuation_review.ref", ref: normalizeContinuationRef(parentRun.post_pr.continuation_review.ref, "reviews"), subjects: new Set([parentRun.run_id]) });
  if (stringValue(parentRun.validator?.review_ref)) candidates.push({ kind: "validator", source: "run.validator.review_ref", ref: normalizeContinuationRef(parentRun.validator.review_ref, "reviews"), subjects });
  if (stringValue(parentRun.security_review?.review_ref)) candidates.push({ kind: "security_review", source: "run.security_review.review_ref", ref: normalizeContinuationRef(parentRun.security_review.review_ref, "reviews"), subjects });
  for (const step of parentRun.steps || []) if (stringValue(step?.review_ref) && stringValue(step?.agent)) candidates.push({ kind: "step", source: `run.steps.${step.agent}.review_ref`, ref: normalizeContinuationRef(step.review_ref, "reviews"), subjects: new Set([String(step.agent).trim()]) });
  for (const slice of parentRun.slices || []) if (stringValue(slice?.review_ref) && stringValue(slice?.id)) candidates.push({ kind: "slice", source: `run.slices.${slice.id}.review_ref`, ref: normalizeContinuationRef(slice.review_ref, "reviews"), subjects: new Set([String(slice.id).trim()]) });
  return candidates.find((candidate) => candidate.ref === ref) || null;
}

function terminalNonconvergenceReviewAuthority(parentRun) {
  const candidates = (parentRun.slices || []).flatMap((slice) => {
    const current = Array.isArray(slice?.attempt_reviews) ? slice.attempt_reviews.at(-1) : null;
    return current?.attempt === slice?.attempts && current.verdict === "REJECT" && current.convergence === "nonconvergent" ? [{ slice, current }] : [];
  });
  const terminalReason = parentRun.terminal_result?.reason === "slice-review-nonconvergent";
  if (candidates.length === 0) {
    if (terminalReason) throw new Error("terminal nonconvergence source review has no current nonconvergent slice attempt");
    return null;
  }
  if (candidates.length !== 1) throw new Error("continuation has multiple current nonconvergent slice reviews");
  const [{ slice, current }] = candidates;
  const terminal = parentRun.terminal_result?.nonconvergence;
  const source = terminalReason ? terminal?.source_review : current;
  if (terminalReason && (terminal?.slice_id !== slice.id || source?.attempt !== slice.attempts || !sameJson(source, current))) {
    throw new Error("terminal nonconvergence source review must equal the current latest slice attempt");
  }
  return {
    kind: "slice",
    source: "run.terminal_result.nonconvergence.source_review.review_ref",
    ref: normalizeContinuationRef(source.review_ref, "reviews"),
    hash: source.review_hash,
    subjects: new Set([String(slice.id).trim()]),
  };
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
  for (const slice of parentRun.slices || []) for (const review of slice?.attempt_reviews || []) if (stringValue(review?.evidence_ref)) evidenceRefs.push(review.evidence_ref);
  const sliceReviewRefs = (parentRun.slices || []).flatMap((slice) => [slice?.review_ref, ...(slice?.attempt_reviews || []).map((review) => review?.review_ref)]);
  for (const reviewRef of new Set(sliceReviewRefs.filter(stringValue))) {
    const review = parseJsonObjectFile(resolveReviewRef(parentDir, reviewRef).path, "continuation slice review");
    for (const disposition of review.invariant_family_ledger?.dispositions || []) {
      if (stringValue(disposition?.evidence_ref)) evidenceRefs.push(disposition.evidence_ref, verificationArtifactExecutionClaimRef(disposition.evidence_ref));
    }
  }
  if (stringValue(parentRun.post_pr?.remediation?.failure_evidence_ref)) evidenceRefs.push(parentRun.post_pr.remediation.failure_evidence_ref);
  for (const binding of parentRun.post_pr?.evidence_refs || []) if (stringValue(binding?.ref)) evidenceRefs.push(binding.ref);
  const expectedEvidence = bindUniqueContinuationRefs(parentDir, evidenceRefs, "evidence", "evidence", resolveEvidenceRef);
  const reviewRefs = [];
  for (const value of [parentRun.post_pr?.continuation_review?.ref, parentRun.validator?.review_ref, parentRun.security_review?.review_ref]) if (stringValue(value)) reviewRefs.push(value);
  for (const step of parentRun.steps || []) if (stringValue(step?.review_ref)) reviewRefs.push(step.review_ref);
  for (const slice of parentRun.slices || []) if (stringValue(slice?.review_ref)) reviewRefs.push(slice.review_ref);
  for (const slice of parentRun.slices || []) for (const review of slice?.attempt_reviews || []) if (stringValue(review?.review_ref)) reviewRefs.push(review.review_ref);
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
  const reuse = continuation.planning_reuse;
  if (isCheckpointPlanningReuse(continuation)) {
    const source = parentRun.checkpoint_source;
    let authority;
    try {
      authority = observeAcceptedDecompositionAuthority(parentDir, parentRun, { requireIntegrationGate: true, requireApprovingReview: true });
    } catch (error) {
      throw new Error(`checkpoint continuation planning_reuse authority is stale: ${error.message}`);
    }
    if (reuse.eligible !== true || reuse.plan_ref !== authority.plan_ref || reuse.plan_hash !== authority.plan_hash
      || reuse.review_ref !== authority.review_ref || reuse.review_hash !== authority.review_hash
      || source?.child_plan_hash !== reuse.plan_hash || source?.child_disposition_hash !== reuse.review_hash) {
      throw new Error("checkpoint continuation planning_reuse binding is stale or cross-checkpoint");
    }
    if (continuation.draft_spec_reuse !== undefined) throw new Error("checkpoint continuation cannot carry draft_spec_reuse");
    return;
  }
  const step = (parentRun.steps || []).find((entry) => stringValue(entry?.agent) && String(entry.agent).trim() === "spec-writer");
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
  let decompositionAuthority = null;
  let selectedTestRoute = null;
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
      selectedTestRoute = assertTestVerifierIntegrationGate(runDir, draft, steps[stepIndex], priorStep, options) || selectedTestRoute;
      if (steps[stepIndex]?.agent === "test-verifier" && steps[stepIndex].status === "running" && !isSchemaV2WholeStoryRoute(selectedTestRoute)) {
        decompositionAuthority = observeAcceptedDecompositionAuthority(runDir, draft, { requireForIntegrationGatePlan: true });
      }
      assertDraftSpecReuseAttempt(draft, steps[stepIndex], priorStep);
      decompositionAuthority = bindStepAcceptance(runDir, steps[stepIndex], draft, options) || decompositionAuthority;
      if (steps[stepIndex]?.agent === "test-verifier" && steps[stepIndex].status === "accepted") {
        const pending = integrationConflictSlices(draft).filter(({ conflict }) => conflict.status === "pending-integrated-review");
        for (const { slice, conflict } of pending) {
          assertSliceIntegrationConflictCurrent(runDir, draft, slice, options);
          const snapshot = await snapshotIntegrationConflictTestArtifact(runDir, slice, conflict, steps[stepIndex].acceptance);
          conflict.status = "accepted";
          conflict.test_acceptance = cloneJson(steps[stepIndex].acceptance);
          conflict.test_artifact_snapshot = snapshot;
          conflict.test_execution_claim = cloneJson(steps[stepIndex].execution_claim);
          conflict.test_execution_claim_hash = steps[stepIndex].execution_claim_hash;
        }
      }
    }
  }, options, {
    authorizedStep: stepIdentityForSelector(stepSelector),
    allowInheritedAcceptance: authority.allowInheritedAcceptance,
    integrationConflicts: "test-acceptance",
    beforeReplace: (next) => {
      if (decompositionAuthority) assertAcceptedDecompositionAuthorityCurrent(runDir, next, decompositionAuthority);
      if (selectedTestRoute && classifyWholeStoryTestRoute(runDir, next, options) !== selectedTestRoute) throw new Error("whole-story test route changed before step publication");
      assertSliceIntegrationConflictsCurrent(runDir, next, options);
    },
  }), options);
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
  if (!sameJson(priorStep?.execution_claim ?? null, step.execution_claim ?? null)) {
    throw new Error("execution_claim can only be changed by checked test execution transitions");
  }
  if (priorStep?.execution_claim_hash !== step.execution_claim_hash) throw new Error("execution_claim_hash can only be changed by checked test execution transitions");
  if (["active", "unknown"].includes(priorStep?.execution_claim?.state) && step.status !== priorStep.status) {
    throw new Error("active or unknown checked test execution cannot change step status through a generic transition");
  }
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

function assertTestVerifierIntegrationGate(runDir, run, step, priorStep, options = {}) {
  if (step?.agent !== "test-verifier") return;
  const route = classifyWholeStoryTestRoute(runDir, run, options);
  if (step.status === "accepted" && route !== WHOLE_STORY_ROUTES.LEGACY) {
    if (priorStep?.status !== "running" || !Number.isInteger(step.attempts) || step.attempts < 1 || step.attempts !== priorStep.attempts) {
      throw new Error(route === WHOLE_STORY_ROUTES.ORDINARY_FRESH
        ? "checked test-verifier acceptance must transition from running at the same positive attempt"
        : "schema-v2 test-verifier acceptance must transition from running at the same positive attempt");
    }
    return route;
  }
  if (step.status !== "running") return null;
  if (route !== WHOLE_STORY_ROUTES.LEGACY) assertWholeStorySinkAllowed({ route, sink: "SINK09", head: "equal" });
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
  return route;
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
function bindStepAcceptance(runDir, step, run = null, options = {}) {
  if (!step) return null;
  delete step.acceptance;
  if (step.status !== "accepted") return null;
  if (step.agent === "test-verifier" && classifyWholeStoryTestRoute(runDir, run, options) !== WHOLE_STORY_ROUTES.LEGACY) {
    step.acceptance = observeCheckedTestVerifierAuthority(runDir, run, step, options).acceptance;
    return null;
  }
  if (step.agent === "work-decomposer") {
    if (step.artifact_ref !== PLAN_SLICES_REF) throw new Error(`accepted work-decomposer step requires artifact_ref exactly '${PLAN_SLICES_REF}'`);
    if (!stringValue(step.review_ref)) throw new Error("accepted work-decomposer step requires review_ref");
    const unprojectedAuthority = observePlanSourceAuthority(runDir, PLAN_SLICES_REF, null, { ...options, requireIntegrationGate: true, enforceDependencyDepth: false });
    const checkpoint = unprojectedAuthority.admission_extension.decision === "checkpoint";
    if (checkpoint && Array.isArray(run?.slices) && run.slices.length > 0) {
      throw new Error("checkpoint work-decomposer acceptance requires an unseeded slice projection");
    }
    const planAuthority = checkpoint
      ? unprojectedAuthority
      : observePlanSourceAuthority(runDir, PLAN_SLICES_REF, run?.slices, { ...options, requireIntegrationGate: true, enforceDependencyDepth: false });
    const review = resolveReviewRef(runDir, step.review_ref, { mustExist: true });
    const reviewHash = hashFile(review.path);
    const reviewValue = parseJsonObjectFile(review.path, "accepted work-decomposer review");
    if (checkpoint && (reviewValue.subject !== "work-decomposer" || reviewValue.attempt !== step.attempts || reviewValue.verdict !== "APPROVE-CHECKPOINT")) {
      throw new Error("checkpoint work-decomposer acceptance requires an exact same-attempt APPROVE-CHECKPOINT decomposition review");
    }
    step.acceptance = {
      artifact_ref: PLAN_SLICES_REF,
      artifact_hash: planAuthority.plan_hash,
      review_ref: step.review_ref,
      review_hash: reviewHash,
    };
    return {
      plan_hash: planAuthority.plan_hash,
      review_ref: step.review_ref,
      review_hash: reviewHash,
      attempt: step.attempts,
      review: reviewValue,
      admission_extension: planAuthority.admission_extension,
      admission_probe: planAuthority.admission_probe,
      allow_unseeded_checkpoint: checkpoint,
    };
  }
  const artifactRef = typeof step.artifact_ref === "string" ? step.artifact_ref.trim() : "";
  if (!artifactRef) {
    if (step.agent === "spec-writer") throw new Error("accepted spec-writer step requires artifact_ref");
    return null;
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
  return null;
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
  let priorDispatchAuthority = null;
  let reviewPlanAuthority = null;
  let sliceStartAuthority = null;
  const result = await withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, async (draft, { current }) => {
    const slices = Array.isArray(draft.slices) ? draft.slices : [];
    if (!collectionHasItem(slices, sliceId, "id")) throw new Error(`slice '${formatSelector(sliceId)}' not found`);
    const priorIndex = selectCollectionItemIndex(slices, sliceId, "slice selector", "id");
    const priorSlice = cloneJson(current.slices[priorIndex]);
    const update = await applyCollectionItemUpdate({ items: slices, selector: sliceId, updater, selectorLabel: "slice selector", seed: seedRunSlice(sliceId), identityKey: "id" });
    sliceIndex = update.index;
    if (!update.changed) {
      if (priorSlice.status !== "review") return;
      priorDispatchAuthority = observeClosedSliceDispatchIfClaimed(runDir, current.run_id, priorSlice, { required: priorSlice.dispatch_required === true });
      assertSliceReviewBindingCurrent(runDir, priorSlice.id, priorSlice);
      return;
    }
    if (sliceIndex >= 0 && slices[sliceIndex].status === "merged") {
      throw new Error(`slice '${slices[sliceIndex].id || formatSelector(sliceId)}' merges must use transitionSliceMerged`);
    }
    if (sliceIndex >= 0 && slices[sliceIndex].status === "running" && mergedSliceRepairFence(draft)) {
      throw new Error(`slice '${slices[sliceIndex].id || formatSelector(sliceId)}' cannot start while a merged-slice repair is unresolved`);
    }
    if (sliceIndex >= 0) {
      if (update.changed) {
        if (["running", "review"].includes(priorSlice.status)) {
          priorDispatchAuthority = observeClosedSliceDispatchIfClaimed(runDir, current.run_id, priorSlice, { required: priorSlice.dispatch_required === true });
        }
        if (priorSlice.status === "review" && slices[sliceIndex].status !== "review") {
          priorReviewAuthority = assertSliceReviewBindingCurrent(runDir, priorSlice.id, priorSlice);
          if (priorReviewAuthority.review.verdict === "REJECT" && priorReviewAuthority.review.convergence === "nonconvergent") {
            if (slices[sliceIndex].status !== "running") throw new Error(`slice '${priorSlice.id}' current nonconvergent review cannot transition to ordinary blocked state`);
            terminalizeSliceNonconvergence(draft, priorSlice, sliceIndex, options);
            return;
          }
          if (slices[sliceIndex].status === "running") {
            reviewPlanAuthority = observeAcceptedDecompositionAuthority(runDir, current, { ...options, requireIntegrationGate: true });
            validateSliceReviewFeasibility(priorReviewAuthority.review, reviewPlanAuthority.plan, { sliceId: priorSlice.id });
            assertReviewedSliceRetryRoute(priorReviewAuthority.review, priorSlice.id, current);
          }
        }
        if (!sameJson(priorSlice.effective_paths, slices[sliceIndex].effective_paths)) {
          throw new Error(`slice '${priorSlice.id}' effective_paths is managed by checked review publication`);
        }
        normalizeSliceTransition(priorSlice, slices[sliceIndex]);
        const priorAttempts = Number.isInteger(priorSlice.attempts) ? priorSlice.attempts : 0;
        if (slices[sliceIndex].status === "running" && slices[sliceIndex].attempts === priorAttempts + 1) slices[sliceIndex].dispatch_required = true;
        if (draft.continuation?.schema_version === 2 && priorSlice.status === "pending" && slices[sliceIndex].status === "running") {
          const byId = new Map(slices.map((slice) => [slice.id, slice]));
          const unmet = (priorSlice.depends_on || []).filter((id) => byId.get(id)?.status !== "merged");
          if (unmet.length) throw new Error(`slice '${priorSlice.id}' is not dependency-ready: ${unmet.join(", ")}`);
        }
        assertSliceTransition(runDir, priorSlice, slices[sliceIndex]);
        if (priorSlice.status === "pending" && slices[sliceIndex].status === "running" && current.integration_amendment?.status === "merged") {
          sliceStartAuthority = observeAuthorizedSliceStartAuthority(runDir, current, slices[sliceIndex], options);
          slices[sliceIndex].authorized_baseline_commit = sliceStartAuthority.baseline_commit;
        }
        if (priorSlice.status === "review") priorReviewAuthority = assertSliceReviewBindingCurrent(runDir, priorSlice.id, priorSlice);
        if (slices[sliceIndex].status === "review") {
          if (priorSlice.status === "review") throw new Error(`slice '${priorSlice.id}' review binding is write-once; return to running before publishing another review`);
          assertNoBindingFields(slices[sliceIndex], SLICE_REVIEW_BINDING_KEYS, `slice '${priorSlice.id}' review binding`);
          reviewPlanAuthority = observeAcceptedDecompositionAuthority(runDir, draft, { ...options, requireIntegrationGate: true });
          assertSliceAttemptHistoryCurrent(runDir, priorSlice.id, priorSlice);
          nextReviewAuthority = observeSliceReviewPublicationAuthority(runDir, draft, slices[sliceIndex].id, slices[sliceIndex], reviewPlanAuthority, options);
          validateSliceReviewFeasibility(nextReviewAuthority.review, reviewPlanAuthority.plan, { sliceId: slices[sliceIndex].id });
          Object.assign(slices[sliceIndex], nextReviewAuthority.binding);
          slices[sliceIndex].effective_paths = cloneJson(nextReviewAuthority.ownership.effective_paths);
          if (nextReviewAuthority.history_entry) appendSliceAttemptReview(slices[sliceIndex], nextReviewAuthority);
        }
      }
    }
  }, options, {
    sliceTransition: true,
    terminal: true,
    beforeReplace: (next, current) => {
      const prior = current.slices?.[sliceIndex];
      const slice = next.slices?.[sliceIndex];
      if (prior) assertSliceAttemptHistoryCurrent(runDir, prior.id, prior);
      if (slice) assertSliceAttemptHistoryCurrent(runDir, slice.id, slice);
      if (prior && ["running", "review"].includes(prior.status)) {
        const currentDispatch = observeClosedSliceDispatchIfClaimed(runDir, current.run_id, prior, { required: prior.dispatch_required === true });
        if (!sameJson(currentDispatch, priorDispatchAuthority)) throw new Error(`slice '${prior.id}' dispatch authority changed before publication`);
      }
      if (priorReviewAuthority) assertSliceReviewAuthorityCurrent(runDir, prior.id, prior, priorReviewAuthority);
      if (nextReviewAuthority) assertSliceReviewPublicationAuthorityCurrent(runDir, next, slice.id, slice, nextReviewAuthority, reviewPlanAuthority, options);
      if (reviewPlanAuthority) assertAcceptedDecompositionAuthorityCurrent(runDir, next, reviewPlanAuthority);
      if (sliceStartAuthority) assertAuthorizedSliceStartAuthorityCurrent(runDir, current, slice, sliceStartAuthority, options);
    },
  }), options);
  return { ...result, slice_index: sliceIndex, slice: sliceIndex >= 0 ? result.run.slices?.[sliceIndex] ?? null : null };
}

export async function retrySliceAfterFailedVerification(runDir, sliceId, input = {}, options = {}) {
  if (!isRecord(input) || !sameStringSet(new Set(Object.keys(input)), new Set(["evidence_ref", "review_ref"]))) {
    throw new Error("failed verification retry requires exactly evidence_ref and review_ref");
  }
  const evidenceRef = requireNonEmptyString(input.evidence_ref, "failed verification retry evidence_ref");
  const reviewRef = requireNonEmptyString(input.review_ref, "failed verification retry review_ref");
  let run = await readRunJson(runDir);
  let slice = (run.slices || []).find((candidate) => candidate?.id === sliceId);
  let publishedReview = false;
  if (!slice) throw new Error(`slice '${sliceId}' not found`);

  const latest = slice.attempt_reviews?.at(-1);
  if (slice.status === "running" && latest?.evidence_ref === evidenceRef && latest?.review_ref === reviewRef && slice.attempts === latest.attempt + 1) {
    assertSliceAttemptHistoryCurrent(runDir, sliceId, slice);
    const observed = observeSliceReviewSidecars(runDir, sliceId, { ...slice, attempts: latest.attempt, evidence_ref: evidenceRef, review_ref: reviewRef });
    if (observed.evidence.status !== "fail" || observed.review.verdict !== "REJECT") throw new Error(`slice '${sliceId}' retry replay authority is not a failed REJECT`);
    return { updated: false, replayed: true, status: run.status, run, slice_index: run.slices.indexOf(slice), slice };
  }

  if (slice.status === "running") {
    await transitionRunSlice(runDir, sliceId, {
      status: "review",
      attempts: slice.attempts,
      evidence_ref: evidenceRef,
      review_ref: reviewRef,
    }, { ...options, failedPreReviewRetryAuthority: FAILED_PRE_REVIEW_RETRY_AUTHORITY });
    publishedReview = true;
    run = await readRunJson(runDir);
    slice = (run.slices || []).find((candidate) => candidate?.id === sliceId);
  }
  if (slice?.status !== "review" || slice.evidence_ref !== evidenceRef || slice.review_ref !== reviewRef) {
    throw new Error(`slice '${sliceId}' failed verification retry requires its exact durable review state`);
  }
  const observed = assertSliceReviewBindingCurrent(runDir, sliceId, slice);
  if (observed.evidence.status !== "fail" || observed.review.verdict !== "REJECT") {
    throw new Error(`slice '${sliceId}' failed verification retry requires a failed receipt and REJECT review`);
  }
  if (publishedReview && typeof options.afterFailedReviewPublication === "function") await options.afterFailedReviewPublication({ run, slice, evidence: observed.evidence, review: observed.review });
  const failedAttempt = slice.attempts;
  const advanced = await transitionRunSlice(runDir, sliceId, { status: "running", attempts: failedAttempt + 1 }, options);
  return { ...advanced, replayed: false, failed_attempt: failedAttempt };
}

export async function transitionSliceMerged(runDir, sliceId, input = {}, options = {}) {
  if (!stringValue(sliceId)) throw new Error("transitionSliceMerged requires a slice id");
  const request = normalizeSliceMergedInput(input);
  const transitionOptions = {
    ...options,
    integrationAmendmentDownstreamMergeAuthority: INTEGRATION_AMENDMENT_DOWNSTREAM_MERGE_AUTHORITY,
    integrationAmendmentPendingSliceMerge: { slice_id: sliceId, merge_commit: request.merge_commit },
  };
  let sliceIndex = -1;
  let mergeAuthority = null;
  const result = await withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, (draft) => {
    const slices = Array.isArray(draft.slices) ? draft.slices : [];
    sliceIndex = slices.findIndex((slice) => slice?.id === sliceId);
    if (sliceIndex < 0) throw new Error(`slice '${sliceId}' not found`);
    const currentSlice = slices[sliceIndex];
    if (draft.special_builder_dispatch && draft.special_builder_dispatch.route !== "integration-conflict") {
      throw new Error(`slice '${sliceId}' merge cannot consume special route '${draft.special_builder_dispatch.route}'`);
    }
    if (mergedSliceRepairFence(draft)) throw new Error(`slice '${sliceId}' cannot merge while a merged-slice repair is unresolved`);
    if (currentSlice.status === "merged") {
      assertSliceReviewBindingCurrent(runDir, sliceId, currentSlice);
      throw new Error(`slice '${sliceId}' is already merged`);
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
    if (mergeAuthority.integration_conflict) {
      const conflict = mergeAuthority.integration_conflict;
      if (currentSlice.integration_conflict !== undefined) throw new Error(`slice '${sliceId}' already carries immutable integration-conflict authority`);
      slices[sliceIndex].integration_conflict = {
        schema_version: 1,
        status: "pending-integrated-review",
        slice_id: sliceId,
        owner_slice_id: conflict.owner_slice_id,
        agent: conflict.agent,
        integration_baseline: conflict.integration_baseline,
        resolution_commit: conflict.completion_head,
        conflict_paths: cloneJson(conflict.conflict_paths),
        claim_ref: conflict.claim_ref,
        claim_hash: conflict.claim_hash,
        closure_ref: conflict.closure_ref,
        closure_hash: conflict.closure_hash,
        integration_proof: cloneJson(conflict.integration_proof),
      };
      delete draft.special_builder_dispatch;
    }
    draft.updated_at = updatedAt;
  }, transitionOptions, {
    sliceTransition: true,
    consumeSpecialDispatch: true,
    beforeReplace: (next, current) => {
      if (mergeAuthority.integration_conflict) {
        const observed = observeSliceMergeAuthority(runDir, current, sliceId, current.slices[sliceIndex], mergeAuthority.merge_commit, options);
        if (!sameJson(observed, mergeAuthority)) throw new Error(`slice '${sliceId}' integration-conflict merge authority changed before publication`);
        return;
      }
      return assertSliceMergeAuthorityCurrent(runDir, next, sliceId, next.slices[sliceIndex], mergeAuthority, options);
    },
  }), options);
  return { ...result, slice_index: sliceIndex, slice: sliceIndex >= 0 ? result.run.slices?.[sliceIndex] ?? null : null };
}

function observeAuthorizedSliceStartAuthority(runDir, run, slice, options = {}) {
  const feature = observeIntegrationHeadAuthority(run, { ...options, runDir }, "slice start baseline authority");
  const branch = requireNonEmptyString(slice.branch, `slice '${slice.id}' start branch`);
  const worktree = resolve(feature.repository, requireNonEmptyString(slice.worktree, `slice '${slice.id}' start worktree`));
  const branchResult = authorityGit(options, feature.repository, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  const head = branchResult.ok ? branchResult.stdout.trim() : "";
  const identity = checkWorktreeIdentity(feature.repository, worktree, { branch, head: feature.head });
  const cleanliness = authorityGit(options, worktree, gitCleanlinessArgs());
  if (head !== feature.head || !identity.ok || !cleanliness.ok || cleanliness.stdout !== "") {
    throw new Error(`slice '${slice.id}' first attempt must start from an exact clean worktree at the authorized feature baseline`);
  }
  return {
    baseline_commit: feature.head,
    feature_branch: feature.branch,
    feature_worktree: feature.worktree,
    slice_branch: branch,
    slice_worktree: worktree,
  };
}

function assertAuthorizedSliceStartAuthorityCurrent(runDir, run, slice, expected, options = {}) {
  const current = observeAuthorizedSliceStartAuthority(runDir, run, slice, options);
  if (!sameJson(current, expected) || slice.authorized_baseline_commit !== expected.baseline_commit) {
    throw new Error(`slice '${slice.id}' authorized feature baseline changed before start publication`);
  }
  return current;
}

export async function transitionSlicesSeed(runDir, slices, options = {}) {
  const requestedProjection = normalizePendingSliceProjection(slices);
  const seedPlanAuthority = observePlanSourceAuthority(runDir, options.from, requestedProjection, { ...options, enforceDependencyDepth: false, requireIntegrationGate: true, requirePendingProjection: true });
  if (seedPlanAuthority.admission_extension.decision === "checkpoint") {
    return transitionCheckpointRouting(runDir, seedPlanAuthority, options);
  }
  const projection = requestedProjection.map((slice, index) => ({
    ...slice,
    declared_paths: cloneJson(seedPlanAuthority.plan.slices[index].paths),
    effective_paths: cloneJson(seedPlanAuthority.plan.slices[index].paths),
  }));
  return withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, (draft, { current }) => {
    assertSeedPlanAuthorityCurrent(runDir, requestedProjection, options, seedPlanAuthority);
    const existing = Array.isArray(current.slices) ? current.slices : [];
    if (sameJson(existing, projection)) return;
    if (existing.some(hasSliceProgress)) {
      throw new Error("factory slices-seed refuses to replace non-pending slice progress after work has started");
    }
    draft.slices = cloneJson(projection);
  }, options, {
    slicesSeed: true,
    beforeReplace: () => assertSeedPlanAuthorityCurrent(runDir, requestedProjection, options, seedPlanAuthority),
  }), options);
}

export function readSlicesSeedPlan(runDir, from, options = {}) {
  return observePlanSourceAuthority(runDir, from, null, { ...options, enforceDependencyDepth: false, requireIntegrationGate: true }).plan;
}

export function probeSlicesPlanAdmission(runDir, options = {}) {
  const observed = observePlanSourceBytes(runDir, options.from, options, "slice probe plan source");
  try {
    return validateObservedPlanSource(observed, null, {
      ...options,
      enforceDependencyDepth: false,
      requireIntegrationGate: true,
    }).admission_probe;
  } catch (error) {
    return buildInvalidDeliveryPlanAdmissionProbe({
      planHash: observed.plan_hash,
      errors: normalizeSlicesProbeErrors(error),
    });
  }
}

async function transitionCheckpointRouting(runDir, seedPlanAuthority, options = {}) {
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    const decompositionAuthority = observeAcceptedDecompositionAuthority(runDir, current, { ...options, requireIntegrationGate: true, allowUnseededCheckpoint: true, requireApprovingReview: true });
    if (decompositionAuthority.plan_hash !== seedPlanAuthority.plan_hash) {
      throw new Error("checkpoint routing accepted decomposition does not bind the exact requested plan bytes");
    }
    const manifest = buildCheckpointRoutingManifest({
      plan: seedPlanAuthority.plan,
      planHash: seedPlanAuthority.plan_hash,
      admissionResult: seedPlanAuthority.admission_extension,
      admissionProbe: seedPlanAuthority.admission_probe,
      decompositionAuthority,
    });
    const artifact = checkpointRoutingArtifact(manifest);
    const replay = current.status === "blocked" && current.terminal_result?.reason === CHECKPOINT_ROUTING_TERMINAL_REASON;
    if (replay) {
      assertCheckpointRoutingReplay(runDir, current, decompositionAuthority, manifest, artifact, options);
      return checkpointRoutingResult(current, manifest, artifact, false);
    }

    assertExpectedCurrentHash(current, options.expectedCurrentHash);
    assertRunJsonWriterAllowed(current, "checkpoint routing");
    if (current.status !== "running") throw new Error(`checkpoint routing requires a running run, found '${current.status}'`);
    assertNoPendingSpecialBuilderDispatches(runDir, current);
    assertNoUnresolvedSliceDispatches(runDir, current);
    assertCheckpointRoutingPreImplementation(current);
    assertCheckpointRoutingAuthorityCurrent(runDir, current, decompositionAuthority, manifest, artifact, options);
    assertWholeStorySinkAllowed({ route: WHOLE_STORY_ROUTES.LEGACY, sink: "SINK26" });
    const terminalBoundaryAuthority = observeCheckpointTerminalBoundaryAuthority(runDir, current, options);
    await publishCheckpointRoutingArtifact(runDir, current, manifest, artifact, decompositionAuthority, options);

    const terminalDraft = cloneJson(current);
    consumeSteeringBoundary(terminalDraft, "terminal", options.boundaryToken);
    const next = validateRun({
      ...terminalDraft,
      status: "blocked",
      updated_at: timestamp(options.now),
      checkpoint_progress: initialCheckpointProgress(artifact),
      terminal_result: {
        status: "blocked",
        run_id: current.run_id,
        pr_url: null,
        reason: CHECKPOINT_ROUTING_TERMINAL_REASON,
        summary: `Oversized plan routed to ${manifest.checkpoints.length} sequential independently shippable checkpoints.`,
        artifacts: { checkpoint_routing: artifact.ref },
      },
    });
    await writeSemanticRunJson(runDir, next, options, null, () => {
      const observedRun = validateRun(JSON.parse(readFileSync(join(runDir, RUN_FILE), "utf8")));
      assertCheckpointTerminalBoundaryAuthorityCurrent(runDir, observedRun, terminalBoundaryAuthority, options);
      assertCheckpointRoutingPreImplementation(observedRun);
      assertCheckpointRoutingAuthorityCurrent(runDir, observedRun, decompositionAuthority, manifest, artifact, options);
      assertCheckpointRoutingArtifactCurrent(runDir, artifact);
    });
    return checkpointRoutingResult(next, manifest, artifact, true);
  }, options);
}

function assertCheckpointRoutingPreImplementation(run) {
  if (Array.isArray(run.slices) && run.slices.length > 0) throw new Error("checkpoint routing must occur before slice seeding");
  const decompositionSteps = (run.steps || []).filter((step) => step?.agent === "work-decomposer");
  if (decompositionSteps.length !== 1 || decompositionSteps[0].status !== "accepted") throw new Error("checkpoint routing requires accepted work-decomposer state");
  if (run.gates?.brief !== undefined && run.gates?.brief !== null) {
    throw new Error("checkpoint routing must occur before Gate 2 brief state is present");
  }
  const testVerifierSteps = (run.steps || []).filter((step) => step?.agent === "test-verifier");
  const standardPlaceholder = { agent: "test-verifier", status: "blocked", attempts: 0 };
  if (testVerifierSteps.length > 1 || (testVerifierSteps.length === 1 && !sameJson(testVerifierSteps[0], standardPlaceholder))) {
    throw new Error("checkpoint routing permits only the repository-standard zero-attempt blocked test-verifier placeholder");
  }
  if (run.validator != null || run.security_review != null || run.gates?.pre_pr != null || run.merged_slice_repair != null || run.integration_amendment != null || run.special_builder_dispatch != null) {
    throw new Error("checkpoint routing must occur before implementation, panel, or pre-PR state");
  }
}

function observeCheckpointTerminalBoundaryAuthority(runDir, run, options) {
  assertNoFreshHeartbeat(runDir, options, "checkpoint routing requires inactive heartbeat");
  const draft = cloneJson(run);
  consumeSteeringBoundary(draft, "terminal", options.boundaryToken);
  const boundary = run.steering?.boundary;
  return {
    kind: boundary.kind,
    token: boundary.token,
    generation: boundary.generation,
    state_hash: boundary.state_hash,
    created_at: boundary.created_at,
  };
}

function assertCheckpointTerminalBoundaryAuthorityCurrent(runDir, run, expected, options) {
  const current = observeCheckpointTerminalBoundaryAuthority(runDir, run, options);
  if (!sameJson(current, expected)) throw new Error("checkpoint terminal boundary authority changed before publication");
}

async function publishCheckpointRoutingArtifact(runDir, run, manifest, artifact, authority, options) {
  const path = join(runDir, artifact.ref);
  if (existsSync(path)) {
    assertCheckpointRoutingArtifactCurrent(runDir, artifact);
    return;
  }
  await writeProtectedJsonAtomic(runDir, artifact.ref, manifest, {
    commit: "create-only",
    hooks: {
      beforeCommit: async () => {
        await options.checkpointRoutingHooks?.beforeArtifactCommit?.();
        assertCheckpointRoutingAuthorityCurrent(runDir, run, authority, manifest, artifact, options);
      },
    },
  });
  assertCheckpointRoutingArtifactCurrent(runDir, artifact);
}

function assertCheckpointRoutingReplay(runDir, run, authority, manifest, artifact, options) {
  if (run.terminal_result?.status !== "blocked" || run.terminal_result?.pr_url !== null
    || !sameJson(run.terminal_result?.artifacts, { checkpoint_routing: artifact.ref })) {
    throw new Error("checkpoint routing terminal result does not match exact routing artifact");
  }
  if (run.steering?.pending != null || run.steering?.uncheckpointed != null || run.steering?.boundary != null
    || run.steering?.action_claim != null || run.steering?.pr_fence != null) {
    throw new Error("checkpoint routing terminal result retained incompatible steering authority");
  }
  assertCheckpointRoutingAuthorityCurrent(runDir, run, authority, manifest, artifact, options);
  assertCheckpointRoutingArtifactCurrent(runDir, artifact);
  assertCheckpointProgressManifestBinding(run, artifact);
}

function assertCheckpointRoutingAuthorityCurrent(runDir, run, expected, manifest, artifact, options) {
  const current = observeAcceptedDecompositionAuthority(runDir, run, { ...options, requireIntegrationGate: true, allowUnseededCheckpoint: true, requireApprovingReview: true });
  if (current.path !== expected.path || current.plan_hash !== expected.plan_hash || current.review_ref !== expected.review_ref
    || current.review_hash !== expected.review_hash || current.attempt !== expected.attempt
    || !sameJson(current.review, expected.review) || !sameJson(current.admission_extension, expected.admission_extension)
    || !sameJson(current.admission_probe, expected.admission_probe)) {
    throw new Error("checkpoint routing plan authority changed before publication");
  }
  const rebuilt = buildCheckpointRoutingManifest({
    plan: current.plan,
    planHash: current.plan_hash,
    admissionResult: current.admission_extension,
    admissionProbe: current.admission_probe,
    decompositionAuthority: current,
  });
  const rebuiltArtifact = checkpointRoutingArtifact(rebuilt);
  if (!sameJson(rebuilt, manifest) || !sameJson(rebuiltArtifact, artifact)) {
    throw new Error("checkpoint routing manifest changed before publication");
  }
}

function assertCheckpointRoutingArtifactCurrent(runDir, artifact) {
  const path = join(runDir, artifact.ref);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || hashFile(path, { mode: "raw" }) !== artifact.hash) {
    throw new Error("checkpoint routing artifact bytes do not match their content-addressed ref");
  }
}

function checkpointRoutingResult(run, manifest, artifact, updated) {
  return {
    updated,
    route: "checkpoint",
    status: run.status,
    run,
    admission_extension: cloneJson(manifest.source.admission_result),
    checkpoint_routing: { ref: artifact.ref, hash: artifact.hash, checkpoint_count: manifest.checkpoints.length },
    terminal_result: run.terminal_result,
  };
}

function initialCheckpointProgress(artifact) {
  return {
    schema_version: 1,
    kind: "delivery-checkpoint-progress",
    manifest_ref: artifact.ref,
    manifest_hash: artifact.hash,
    status: "active",
    entries: [],
    final_closure: null,
  };
}

export function transitionCheckpointProgressReserved(runDir, entry, options = {}) {
  return transitionCheckpointProgressEntry(runDir, entry, "reserved", null, options);
}

export function transitionCheckpointProgressChildPublished(runDir, entry, options = {}) {
  return transitionCheckpointProgressEntry(runDir, entry, "child-published", "reserved", options);
}

export function transitionCheckpointProgressLaunched(runDir, entry, options = {}) {
  return transitionCheckpointProgressEntry(runDir, entry, "launched", "child-published", options);
}

export function transitionCheckpointProgressMerged(runDir, entry, options = {}) {
  return transitionCheckpointProgressEntry(runDir, entry, "merged", "launched", options);
}

export async function transitionCheckpointProgressClosed(runDir, finalClosure, options = {}) {
  const requested = cloneJson(finalClosure);
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    const authority = observeCheckpointProgressParentAuthority(runDir, current);
    const progress = current.checkpoint_progress;
    if (progress.status === "closed") {
      if (!sameJson(progress.final_closure, requested)) throw new Error("checkpoint progress closure conflicts with the already closed parent");
      return checkpointProgressTransitionResult(current, false, "closed");
    }
    if (progress.status !== "active" || progress.final_closure !== null) throw new Error("checkpoint progress can close only from active state");
    if (progress.entries.length !== authority.manifest.checkpoints.length
      || progress.entries.some((entry) => entry.state !== "merged")) {
      throw new Error("checkpoint progress closure requires every manifest checkpoint to be merged");
    }
    const next = validateRun({
      ...cloneJson(current),
      updated_at: timestamp(options.now),
      checkpoint_progress: { ...cloneJson(progress), status: "closed", final_closure: requested },
    });
    await writeCheckpointProgressRun(runDir, current, next, authority, options);
    return checkpointProgressTransitionResult(next, true, "closed");
  }, options);
}

async function transitionCheckpointProgressEntry(runDir, input, targetState, priorState, options) {
  const requested = cloneJson(input);
  if (!isRecord(requested) || requested.state !== targetState) {
    throw new Error(`checkpoint progress ${targetState} transition requires a complete '${targetState}' entry`);
  }
  return withRunJsonLock(runDir, async () => {
    const current = await readRunJson(runDir);
    const authority = observeCheckpointProgressParentAuthority(runDir, current);
    const progress = current.checkpoint_progress;
    if (progress.status !== "active" || progress.final_closure !== null) throw new Error("closed checkpoint progress cannot be mutated");
    const ordinal = requested.ordinal;
    if (!Number.isInteger(ordinal) || ordinal < 1) throw new Error("checkpoint progress entry ordinal must be a positive integer");
    const manifestCheckpoint = authority.manifest.checkpoints[ordinal - 1];
    if (!manifestCheckpoint || manifestCheckpoint.id !== requested.checkpoint_id || manifestCheckpoint.ordinal !== ordinal) {
      throw new Error("checkpoint progress entry does not match its manifest checkpoint");
    }
    if (["child-published", "launched", "merged"].includes(targetState)
      && (requested.child_plan_hash !== manifestCheckpoint.child_plan_hash || requested.brief_scope_hash !== manifestCheckpoint.brief_scope_hash)) {
      throw new Error("checkpoint progress entry plan facts do not match the manifest checkpoint");
    }

    const existing = progress.entries[ordinal - 1];
    if (targetState === "reserved") {
      if (existing) {
        if (existing.state === targetState && sameJson(existing, requested)) return checkpointProgressTransitionResult(current, false, targetState, ordinal);
        throw new Error(`checkpoint progress '${requested.checkpoint_id}' reservation conflicts with existing state '${existing.state}'`);
      }
      if (ordinal !== progress.entries.length + 1 || progress.entries.some((entry) => entry.state !== "merged")) {
        throw new Error("checkpoint progress reservations must be contiguous after merged predecessors");
      }
    } else {
      if (!existing) throw new Error(`checkpoint progress cannot skip directly to '${targetState}'`);
      if (existing.state === targetState) {
        if (sameJson(existing, requested)) return checkpointProgressTransitionResult(current, false, targetState, ordinal);
        throw new Error(`checkpoint progress '${requested.checkpoint_id}' ${targetState} replay conflicts with persisted facts`);
      }
      if (existing.state !== priorState) {
        throw new Error(`checkpoint progress cannot transition '${existing.state}' -> '${targetState}'`);
      }
      assertCheckpointProgressFactsRetained(existing, requested);
    }

    const entries = cloneJson(progress.entries);
    if (targetState === "reserved") entries.push(requested);
    else entries[ordinal - 1] = requested;
    const next = validateRun({
      ...cloneJson(current),
      updated_at: timestamp(options.now),
      checkpoint_progress: { ...cloneJson(progress), entries },
    });
    await writeCheckpointProgressRun(runDir, current, next, authority, options);
    return checkpointProgressTransitionResult(next, true, targetState, ordinal);
  }, options);
}

function assertCheckpointProgressFactsRetained(current, requested) {
  for (const [key, value] of Object.entries(current)) {
    if (key !== "state" && !sameJson(value, requested[key])) {
      throw new Error(`checkpoint progress field '${key}' is immutable once recorded`);
    }
  }
}

function observeCheckpointProgressParentAuthority(runDir, run) {
  const terminal = run.terminal_result;
  const artifactKeys = isRecord(terminal?.artifacts) ? Object.keys(terminal.artifacts) : [];
  if (run.status !== "blocked" || terminal?.status !== "blocked" || terminal?.run_id !== run.run_id
    || terminal?.reason !== CHECKPOINT_ROUTING_TERMINAL_REASON || run.pr_url != null || terminal.pr_url !== null
    || artifactKeys.length !== 1 || artifactKeys[0] !== "checkpoint_routing") {
    throw new Error("checkpoint progress requires the exact blocked routing parent terminal authority");
  }
  const progress = run.checkpoint_progress;
  const manifestRef = terminal.artifacts.checkpoint_routing;
  if (!isRecord(progress) || progress.manifest_ref !== manifestRef) throw new Error("checkpoint progress manifest binding is stale");
  const resolved = resolveArtifactRef(runDir, manifestRef);
  const identity = lstatSync(resolved.path);
  if (identity.isSymbolicLink() || !identity.isFile()) throw new Error("checkpoint progress manifest must be a regular file");
  const manifestHash = hashFile(resolved.path, { mode: "raw" });
  const artifact = { ref: manifestRef, hash: manifestHash };
  assertCheckpointProgressManifestBinding(run, artifact);
  const manifest = parseJsonObjectFile(resolved.path, "checkpoint progress manifest");
  if (manifest.kind !== CHECKPOINT_ROUTING_KIND || !Array.isArray(manifest.checkpoints) || manifest.checkpoints.length === 0) {
    throw new Error("checkpoint progress manifest is not a checkpoint routing manifest");
  }
  return { run: cloneJson(run), artifact, manifest: cloneJson(manifest) };
}

function assertCheckpointProgressManifestBinding(run, artifact) {
  const progress = run.checkpoint_progress;
  if (!isRecord(progress) || progress.manifest_ref !== artifact.ref || progress.manifest_hash !== artifact.hash) {
    throw new Error("checkpoint progress does not bind the exact routing manifest");
  }
}

async function writeCheckpointProgressRun(runDir, current, next, authority, options) {
  await writeProtectedRunJson(runDir, next, options, async () => {
    await options.checkpointProgressHooks?.beforeReplace?.({ current: cloneJson(current), next: cloneJson(next) });
    const observed = validateRun(JSON.parse(readFileSync(join(runDir, RUN_FILE), "utf8")));
    if (!sameJson(observed, current)) throw new Error("checkpoint parent authority changed before progress publication");
    const observedAuthority = observeCheckpointProgressParentAuthority(runDir, observed);
    if (!sameJson(observedAuthority.artifact, authority.artifact) || !sameJson(observedAuthority.manifest, authority.manifest)) {
      throw new Error("checkpoint parent manifest authority changed before progress publication");
    }
  });
}

function checkpointProgressTransitionResult(run, updated, state, ordinal = null) {
  return {
    updated,
    status: run.status,
    progress_status: run.checkpoint_progress.status,
    state,
    ordinal,
    run,
    checkpoint_progress: cloneJson(run.checkpoint_progress),
  };
}

function observePlanSourceAuthority(runDir, from, slices, options = {}) {
  return validateObservedPlanSource(observePlanSourceBytes(runDir, from, options, "slice seed plan source"), slices, options);
}

function observePlanSourceBytes(runDir, from, options, label) {
  if (from !== PLAN_SLICES_REF) throw new Error(`exact run-relative plan source '${PLAN_SLICES_REF}' is required`);
  const expectedRepo = resolve(runDir, "../../..");
  if (stringValue(options.repoRoot) && resolve(options.repoRoot) !== expectedRepo) throw new Error("slice seed repoRoot does not own the target run directory");
  const planPath = resolveExactPlanSlicesFile(runDir, from, label);
  const bytes = readFileSync(planPath);
  return { path: planPath, plan_bytes: bytes, plan_hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

function validateObservedPlanSource(source, slices, options = {}) {
  const bytes = source.plan_bytes;
  const plan = parseSlicesPlanBytes(bytes, {
    label: PLAN_SLICES_REF,
    enforceDependencyDepth: options.enforceDependencyDepth !== false,
    requireIntegrationGate: options.requireIntegrationGate === true,
    allowLegacyExecutionTimeouts: options.allowLegacyExecutionTimeouts === true,
  });
  const admissionExtension = validateAdmissionExtensionResult(evaluateDeliveryEnvelopeAdmission({ plan }));
  const admissionProbe = buildDeliveryPlanAdmissionProbe({ plan, planHash: source.plan_hash, admissionResult: admissionExtension });
  if (slices) assertPlanSlicesMatch(plan, slices, { requirePendingProjection: options.requirePendingProjection === true });
  return { ...source, plan, admission_extension: admissionExtension, admission_probe: admissionProbe };
}

function normalizeSlicesProbeErrors(error) {
  const source = Array.isArray(error?.errors) && error.errors.length > 0
    ? error.errors
    : [slicesProbeError(error)];
  const normalized = source.map((item) => ({ path: String(item.path), message: String(item.message) }));
  normalized.sort((left, right) => compareProbeErrorText(left.path, right.path) || compareProbeErrorText(left.message, right.message));
  return normalized.filter((item, index) => index === 0
    || item.path !== normalized[index - 1].path || item.message !== normalized[index - 1].message);
}

function compareProbeErrorText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function slicesProbeError(error) {
  const message = typeof error?.message === "string" && error.message.length > 0 ? error.message : "plan validation failed";
  if (message.startsWith(`${PLAN_SLICES_REF} must be valid JSON:`)) {
    return { path: PLAN_SLICES_REF, message: "must be valid JSON" };
  }
  if (message === `${PLAN_SLICES_REF} must contain valid UTF-8`) {
    return { path: PLAN_SLICES_REF, message: "must contain valid UTF-8" };
  }
  return {
    path: /checkpoint/iu.test(message) ? "plan.delivery_envelope.checkpoint_plan" : "plan",
    message,
  };
}

function assertSeedPlanAuthorityCurrent(runDir, projection, options, expected) {
  const current = observePlanSourceAuthority(runDir, options.from, projection, { ...options, enforceDependencyDepth: false, requireIntegrationGate: true, requirePendingProjection: true });
  if (current.path !== expected.path || current.plan_hash !== expected.plan_hash
    || !sameJson(current.admission_extension, expected.admission_extension) || !sameJson(current.admission_probe, expected.admission_probe)) {
    throw new Error("slice seed plan authority changed before run.json publication");
  }
}

export function observeAcceptedDecompositionAuthority(runDir, run, options = {}) {
  if (options.requireForIntegrationGatePlan === true && !existsSync(join(resolve(runDir), "plan", "slices.json"))) return null;
  const source = observePlanSourceAuthority(runDir, PLAN_SLICES_REF, options.allowUnseededCheckpoint === true ? null : run.slices, {
    ...options,
    enforceDependencyDepth: false,
    requireIntegrationGate: options.requireIntegrationGate === true,
    allowLegacyExecutionTimeouts: true,
  });
  if (source.plan.integration_gate === undefined && options.requireForIntegrationGatePlan === true) return null;
  const matches = (run.steps || []).filter((step) => step?.agent === "work-decomposer");
  if (matches.length !== 1) throw new Error("accepted work-decomposer plan authority requires exactly one work-decomposer step");
  const step = matches[0];
  if (step.status !== "accepted" || !isRecord(step.acceptance)) throw new Error("accepted work-decomposer plan authority is required");
  if (!Number.isInteger(step.attempts) || step.attempts < 1) throw new Error("accepted work-decomposer plan authority requires a positive attempt");
  if (step.artifact_ref !== PLAN_SLICES_REF || step.acceptance.artifact_ref !== PLAN_SLICES_REF || step.acceptance.artifact_hash !== source.plan_hash) {
    throw new Error("accepted work-decomposer plan ref/hash does not match exact plan bytes");
  }
  if (!stringValue(step.review_ref) || step.acceptance.review_ref !== step.review_ref || !stringValue(step.acceptance.review_hash)) {
    throw new Error("accepted work-decomposer review ref/hash binding is incomplete");
  }
  const review = resolveReviewRef(runDir, step.review_ref, { mustExist: true });
  const reviewHash = hashFile(review.path);
  if (reviewHash !== step.acceptance.review_hash) throw new Error("accepted work-decomposer review bytes changed after acceptance");
  const reviewValue = parseJsonObjectFile(review.path, "accepted work-decomposer review");
  const approvingVerdicts = source.admission_extension.decision === "checkpoint"
    ? new Set(["APPROVE", "APPROVE-CHECKPOINT"])
    : new Set(["APPROVE"]);
  if (options.requireApprovingReview === true
    && (reviewValue.subject !== "work-decomposer" || reviewValue.attempt !== step.attempts || !approvingVerdicts.has(reviewValue.verdict))) {
    throw new Error("accepted work-decomposer review must be an exact same-attempt APPROVE decomposition review");
  }
  return { ...source, plan_ref: PLAN_SLICES_REF, attempt: step.attempts, attempts: step.attempts, review_ref: step.review_ref, review_hash: reviewHash, review: reviewValue };
}

function assertAcceptedDecompositionAuthorityCurrent(runDir, run, expected) {
  const current = observeAcceptedDecompositionAuthority(runDir, run, {
    requireIntegrationGate: true,
    allowUnseededCheckpoint: expected.allow_unseeded_checkpoint === true,
  });
  if (current.plan_hash !== expected.plan_hash || current.review_ref !== expected.review_ref || current.review_hash !== expected.review_hash
    || current.attempt !== expected.attempt || !sameJson(current.review, expected.review)
    || !sameJson(current.admission_extension, expected.admission_extension) || !sameJson(current.admission_probe, expected.admission_probe)) {
    throw new Error("accepted work-decomposer plan authority changed before run.json publication");
  }
}

function assertPlanSlicesMatch(plan, slices, { requirePendingProjection = false } = {}) {
  if (!Array.isArray(slices) || slices.length !== plan.slices.length) throw new Error("parent run slices must exactly classify the bound plan");
  for (const [index, planned] of plan.slices.entries()) {
    const slice = slices[index];
    if (!slice || slice.id !== planned.id || slice.stack !== planned.stack || !sameJson(slice.depends_on, planned.depends_on)
      || (slice.declared_paths !== undefined && !sameJson(slice.declared_paths, planned.paths))) {
      throw new Error("parent run slices must exactly classify the bound plan");
    }
    if (requirePendingProjection && (slice.status !== "pending" || slice.attempts !== 0 || hasSliceProgress(slice))) {
      throw new Error("slice seed projection does not match the required-command plan source");
    }
  }
}

function hasSliceProgress(slice) {
  if (slice?.status !== "pending" || slice?.attempts !== 0) return true;
  return ["branch", "worktree", "evidence_ref", "review_ref", "merge_commit", "blocked_reason", "updated_at"]
    .some((key) => slice?.[key] !== undefined && slice?.[key] !== null);
}

export async function transitionPanelVerdicts(runDir, input, options = {}) {
  const request = normalizePanelVerdictInput(input);
  let authority = null;
  let v2Authority = null;
  return withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, (draft, { current }) => {
    if (mergedSliceRepairFence(current)) throw new Error("panel verdicts are fenced while a merged-slice repair is unresolved");
    if (integrationConflictSlices(current).length > 0) {
      if (integrationConflictSlices(current).some(({ conflict }) => conflict.status !== "accepted")) throw new Error("panel verdicts require fresh integrated conflict tests and review");
      assertSliceIntegrationConflictsCurrent(runDir, current, options);
    }
    v2Authority = assertCheckedFreshDownstreamAuthority(runDir, current, "panel publication");
    const route = classifyWholeStoryTestRoute(runDir, current, options);
    if (route !== WHOLE_STORY_ROUTES.LEGACY) assertWholeStorySinkAllowed({ route, sink: "SINK16", claim: "completed-pass", evidence: "exact-pass", head: "equal", review: "fresh" });
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
    const hasCurrentPanels = isRecord(current.validator) || isRecord(current.security_review);
    if (hasCurrentPanels && !exactReplay
      && PASSING_VALIDATOR_VERDICTS.has(current.validator?.verdict)
      && PASSING_SECURITY_VERDICTS.has(current.security_review?.verdict)) {
      throw new Error("passing panel authority is immutable except exact verified replay");
    }
    const validator = { ...cloneJson(request.validator), ...(exactReplay && current.validator?.loops !== undefined ? { loops: current.validator.loops } : {}), ...authority.validator_binding };
    const securityReview = { ...cloneJson(request.security_review), ...(exactReplay && current.security_review?.loops !== undefined ? { loops: current.security_review.loops } : {}), ...authority.security_binding };
    if (sameJson(current.validator, validator) && sameJson(current.security_review, securityReview)) return;
    if (hasCurrentPanels && !exactReplay) {
      consumeSpecialBuilderDispatch(runDir, current, draft, "panel-remediation", authority.integration.head);
    }
    draft.validator = validator;
    draft.security_review = securityReview;
  }, options, {
    panelVerdicts: true,
    consumeSpecialDispatch: true,
    beforeReplace: (_next, current) => {
      assertCheckedFreshDownstreamAuthority(runDir, current, "panel publication", v2Authority);
      assertSliceIntegrationConflictsCurrent(runDir, current, options);
      assertPanelVerdictAuthorityCurrent(runDir, current, request, authority, options);
    },
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
    const v2Authority = assertV2LocalPublishedAuthority(runDir, current, options);
    if (isRecord(current.steering?.pr_fence)) throw new Error("heartbeat tick rejected: active pre-PR fence");
    if (TERMINAL_RUN_STATUSES.has(current.status)) return { updated: false, reason: "terminal-status", status: current.status, run: current };
    if (current.status !== "running") return { updated: false, reason: "run-not-running", status: current.status, run: current };
    const protectedGate = pendingProtectedGate(current);
    if (protectedGate) return { updated: false, reason: "protected-gate-pending", gate: protectedGate, status: current.status, run: current };
    if (!hasInFlightHeartbeatWork(current)) return { updated: false, reason: "no-in-flight-work", status: current.status, run: current };

    const next = validateRun({ ...current, heartbeat_at: heartbeatAt });
    await writeSemanticRunJson(runDir, next, options, v2Authority);
    return { updated: true, status: next.status, heartbeat_at: heartbeatAt, run: next };
  }, options);
}

export function hasInFlightHeartbeatWork(run) {
  if (Array.isArray(run.steps) && run.steps.some((step) => HEARTBEAT_STEP_IN_FLIGHT_STATUSES.has(step?.status))) return true;
  if (Array.isArray(run.slices) && run.slices.some((slice) => HEARTBEAT_SLICE_IN_FLIGHT_STATUSES.has(slice?.status))) return true;
  if (["repairing", "review"].includes(run?.merged_slice_repair?.status)) return true;
  if (["building", "reviewed", "integrated", "verified"].includes(run?.integration_amendment?.status)) return true;
  if (run?.status === "running" && run?.post_pr?.policy?.enabled === true && POST_PR_HEARTBEAT_PHASES.has(run.post_pr.phase)) return true;
  return false;
}

async function transitionRunJsonLocked(runDir, mutator, options = {}, hooks = {}) {
  const current = await readRunJson(runDir);
  assertExpectedCurrentHash(current, options.expectedCurrentHash);
  assertRunJsonWriterAllowed(current, "run.json transition", { allowPrePrFence: hooks.prCreated === true });
  const amendmentAuthority = observeIntegrationAmendmentWriterAuthority(runDir, current, {
    dedicated: hooks.integrationAmendment === INTEGRATION_AMENDMENT_TRANSITION_AUTHORITY,
    blockedTerminal: hooks.terminal === true,
    action: hooks.integrationAmendmentAction,
    integrationAmendmentDownstreamMergeAuthority: options.integrationAmendmentDownstreamMergeAuthority,
    integrationAmendmentPendingSliceMerge: options.integrationAmendmentPendingSliceMerge,
  });
  const v2AdmissionAuthority = assertV2LocalPublishedAuthority(runDir, current, options);
  const assertSpecialDispatches = hooks.consumeSpecialDispatch === true
    ? () => assertNoUnresolvedSpecialBuilderDispatches(runDir, current)
    : () => assertNoPendingSpecialBuilderDispatches(runDir, current);
  assertSpecialDispatches();

  const draft = cloneJson(current);
  let nextValue = await mutator(draft, { current, runDir });
  if (nextValue === undefined) {
    if (sameJson(current, draft)) return { updated: false, reason: "mutator-skip", status: current.status, run: current };
    nextValue = draft;
  }
  assertSpecialDispatches();

  assertV2ImmutablePublicationTransition(current, nextValue);
  assertPostPrGenericMutation(current, nextValue, hooks);
  assertScopedAuthorityTransitions(current, nextValue, hooks);
  assertGateDecisionTransitions(current, nextValue, hooks);
  assertStepTransitions(current, nextValue, hooks);
  const next = validateRun(nextValue);
  assertWholeStorySinkAllowed({ route: WHOLE_STORY_ROUTES.LEGACY, sink: "SINK25" });
  assertRunIdentityTransition(current, next);
  assertV2ImmutablePublicationTransition(current, next);
  assertScopedAuthorityTransitions(current, next, hooks);
  assertGateDecisionTransitions(current, next, hooks);
  assertStepTransitions(current, next, hooks);
  assertTerminalTransition(current, next, hooks);
  assertIntegrationAmendmentTransition(current, next, hooks);
  const terminalizing = current.status !== next.status && TERMINAL_RUN_STATUSES.has(next.status);
  if (terminalizing) assertNoUnresolvedSliceDispatches(runDir, current);
  const v2PublicationAuthority = assertV2LocalPublishedAuthority(runDir, next, options);
  assertV2AuthorityExtends(v2PublicationAuthority, v2AdmissionAuthority);
  if (typeof hooks.beforeWrite === "function") await hooks.beforeWrite(next, current);
  const postPrPublicationAuthority = hooks.postPr === true ? observePostPrPublicationAuthority(runDir, next, options) : null;
  const repairPublicationAuthority = hooks.mergedSliceRepair === MERGED_SLICE_REPAIR_TRANSITION_AUTHORITY ? observeRepairPublicationAuthority(runDir, next, options) : null;
  const beforeReplace = hooks.beforeReplace || postPrPublicationAuthority || repairPublicationAuthority || v2PublicationAuthority || amendmentAuthority || terminalizing || existsSync(join(runDir, "dispatch"))
    ? async () => {
        if (hooks.beforeReplace) await hooks.beforeReplace(next, current);
        assertSpecialDispatches();
        if (v2PublicationAuthority) assertV2LocalPublishedAuthority(runDir, next, options, v2PublicationAuthority);
        if (postPrPublicationAuthority) assertPostPrPublicationAuthorityCurrent(runDir, next, options, postPrPublicationAuthority);
        if (repairPublicationAuthority) assertRepairPublicationAuthorityCurrent(runDir, next, options, repairPublicationAuthority);
        assertIntegrationAmendmentWriterAuthorityCurrent(runDir, current, amendmentAuthority, {
          dedicated: hooks.integrationAmendment === INTEGRATION_AMENDMENT_TRANSITION_AUTHORITY,
          blockedTerminal: hooks.terminal === true,
          action: hooks.integrationAmendmentAction,
          integrationAmendmentDownstreamMergeAuthority: options.integrationAmendmentDownstreamMergeAuthority,
          integrationAmendmentPendingSliceMerge: options.integrationAmendmentPendingSliceMerge,
        });
        if (terminalizing) assertNoUnresolvedSliceDispatches(runDir, current);
      }
    : null;
  const protectedOptions = {
    ...options,
    ...(hooks.consumeSpecialDispatch === true ? { allowPendingSpecialDispatch: true } : {}),
    ...(hooks.integrationAmendment === INTEGRATION_AMENDMENT_TRANSITION_AUTHORITY ? { integrationAmendmentAuthority: INTEGRATION_AMENDMENT_TRANSITION_AUTHORITY } : {}),
    ...(hooks.integrationAmendmentAction ? { integrationAmendmentAction: hooks.integrationAmendmentAction } : {}),
    ...(hooks.terminal === true && current.integration_amendment?.status === "blocked" ? { blockedAmendmentTerminal: true } : {}),
  };
  await writeProtectedRunJson(runDir, next, protectedOptions, beforeReplace);
  return { updated: true, status: next.status, run: next };
}

export function assertV2LocalPublishedAuthority(runDir, run, options = {}, expected = null) {
  if (run.continuation?.schema_version !== 2) return null;
  assertPublishedCarryForwardConfiguration(run);
  const planPath = resolve(runDir, run.continuation.carry_forward.plan_ref);
  assertNoSymlinkPath(runDir, planPath, "published carry-forward plan");
  if (!existsSync(planPath) || !lstatSync(planPath).isFile() || hashFile(planPath) !== run.continuation.carry_forward.plan_hash) throw new Error("published carry-forward plan bytes do not match continuation authority");
  const plan = parseSlicesPlanBytes(readFileSync(planPath), { label: "published carry-forward plan", enforceDependencyDepth: false, requireIntegrationGate: true, allowLegacyExecutionTimeouts: true });
  assertPublishedCarryForwardSlices(runDir, run, plan, run.continuation.carry_forward);
  assertPublishedCarryForwardSpec(runDir, run, run.continuation);
  observeAcceptedDecompositionAuthority(runDir, run, { requireIntegrationGate: true });
  const parent = observeV2ParentAuthority(runDir, run, options);
  const integration = observeIntegrationHeadAuthority(run, { ...options, runDir }, "schema-v2 local publication");
  const repository = integration.repository;
  const merged = (run.slices || []).filter((slice) => slice?.status === "merged").map((slice) => {
    if (!stringValue(slice.merge_commit)) throw new Error(`schema-v2 merged slice '${slice.id}' has no merge_commit`);
    const resolvedCommit = authorityGit(options, repository, ["rev-parse", "--verify", `${slice.merge_commit}^{commit}`]);
    const resolvedSha = resolvedCommit.ok ? resolvedCommit.stdout.trim() : "";
    if (!/^[0-9a-f]{40}$/u.test(resolvedSha)) throw new Error(`schema-v2 merged slice '${slice.id}' merge_commit does not resolve`);
    if (!authorityGit(options, repository, ["merge-base", "--is-ancestor", resolvedSha, integration.head]).ok) {
      throw new Error(`schema-v2 merged slice '${slice.id}' merge_commit is not an ancestor of exact clean child HEAD`);
    }
    return { id: slice.id, merge_commit: slice.merge_commit, resolved_sha: resolvedSha };
  });
  const testStep = (run.steps || []).find((step) => step?.agent === "test-verifier");
  if (testStep?.status === "accepted") assertCheckedFreshDownstreamAuthority(runDir, run, "checked v2 mutation");
  const observed = {
    continuation_hash: hashValue(run.continuation),
    plan_hash: run.continuation.carry_forward.plan_hash,
    parent,
    integration,
    merged,
  };
  if (expected && !sameJson(observed, expected)) throw new Error("schema-v2 local publication authority changed before mutation");
  return observed;
}

function assertV2AuthorityExtends(actual, expected) {
  if (!expected) return;
  if (!actual || actual.continuation_hash !== expected.continuation_hash || actual.plan_hash !== expected.plan_hash
    || !sameJson(actual.parent, expected.parent) || !sameJson(actual.integration, expected.integration)) {
    throw new Error("schema-v2 local publication authority changed before mutation");
  }
  const merged = new Map(actual.merged.map((entry) => [entry.id, entry]));
  if (expected.merged.some((entry) => !sameJson(merged.get(entry.id), entry))) {
    throw new Error("schema-v2 local publication authority changed before mutation");
  }
}

function observeIntegrationAmendmentWriterAuthority(runDir, run, options = {}) {
  const inventory = inspectIntegrationAmendmentInventory(runDir, run);
  const amendment = run.integration_amendment;
  if (amendment?.status === "merged") assertIntegrationAmendmentConsistency(runDir, run, {
    pending_slice_merge: options.integrationAmendmentDownstreamMergeAuthority === INTEGRATION_AMENDMENT_DOWNSTREAM_MERGE_AUTHORITY
      ? options.integrationAmendmentPendingSliceMerge
      : null,
  });
  const activeEffect = ["active", "unknown"].includes(inventory.verification_effect?.state);
  const reviewState = inventory.review_effect?.classification || "absent";
  const unresolvedReview = ["active-claim-only", "review-published-without-closure", "closed-unconsumed"].includes(reviewState);
  if (options.dedicated !== true) {
    if (["active-claim-only", "unknown-claim-optional-bound-receipt", "completed-nonzero-receipt-no-manifest"].includes(inventory.classification)) {
      throw new Error(`run.json writer rejected: integration amendment authority is ${inventory.classification}`);
    }
    if (amendment && amendment.status !== "merged") {
      if (!(options.blockedTerminal === true && amendment.status === "blocked" && !activeEffect && !unresolvedReview)) {
        throw new Error(`run.json writer rejected: integration amendment is ${amendment.status}`);
      }
    }
  } else if (["active-claim-only", "unknown-claim-optional-bound-receipt"].includes(inventory.classification) || activeEffect) {
    throw new Error("integration amendment transition rejected: an execution effect is active or unknown");
  } else if (options.reviewCallback !== true && unresolvedReview
    && !(options.action === "review" && reviewState === "closed-unconsumed")) {
    throw new Error(`integration amendment transition rejected: reviewer effect is ${reviewState}`);
  } else if (options.action === "review" && !["closed-unconsumed", "consumed"].includes(reviewState)) {
    throw new Error(`integration amendment review requires closed-unconsumed reviewer authority; observed ${reviewState}`);
  }
  return {
    classification: inventory.classification,
    verification_state: inventory.verification_effect?.state ?? null,
    verification_claim_hash: inventory.verification_effect?.claim_hash ?? null,
    verification_receipt_hash: inventory.verification_effect?.receipt_hash ?? null,
    report_claim_hash: inventory.report_claim_hash ?? null,
    report_receipt_hash: inventory.report_receipt_hash ?? null,
    review_state: reviewState,
    review_claim_hash: inventory.review_effect?.claim_hash ?? null,
    review_hash: inventory.review_effect?.review_hash ?? null,
    review_closure_hash: inventory.review_effect?.closure_hash ?? null,
    amendment_hash: amendment ? hashValue(amendment) : null,
  };
}

function assertIntegrationAmendmentWriterAuthorityCurrent(runDir, run, expected, options = {}) {
  if (!expected) return;
  const current = observeIntegrationAmendmentWriterAuthority(runDir, run, options);
  if (!sameJson(current, expected)) throw new Error("integration amendment authority changed before protected run.json replacement");
}

function observeIntegrationAmendmentCoreAuthority(runDir, run, options = {}) {
  const amendment = run.integration_amendment;
  if (!amendment) throw new Error("integration amendment special dispatch requires a manifest");
  const admission = observeIntegrationAmendmentAdmission(runDir, run, {
    owner_slice_id: amendment.owner_slice_id,
    consumer_slice_id: amendment.consumer_slice_id,
    defect_path: amendment.defect_path,
    verification_artifact_id: amendment.verification_artifact_id,
  }, { ...options, repoRoot: resolve(runDir, "../../..") });
  if (!sameJson(admission, amendment.admission)) throw new Error("integration amendment core admission authority is stale");
  return { amendment_hash: hashValue(amendment), admission };
}

function assertIntegrationAmendmentTransition(current, next, hooks) {
  const dedicated = hooks.integrationAmendment === INTEGRATION_AMENDMENT_TRANSITION_AUTHORITY;
  if (!dedicated && !sameJson(current.integration_amendment, next.integration_amendment)) {
    throw new Error("generic run writer cannot create, change, or remove integration amendment authority");
  }
  if (next.integration_amendment != null && next.merged_slice_repair != null) {
    throw new Error("generic and legacy repair authority may never coexist");
  }
}

function observeV2ParentAuthority(runDir, run, options = {}) {
  const repository = resolve(options.repoRoot || runDir, options.repoRoot ? "." : "../../..");
  const continuation = run.continuation;
  const parentFile = resolve(repository, continuation.parent.run_ref);
  assertNoSymlinkPath(repository, parentFile, "schema-v2 parent run.json");
  const runHash = hashFile(parentFile);
  if (runHash !== continuation.parent.run_hash) throw new Error("schema-v2 parent run.json hash is stale");
  const parentRun = validateRun(JSON.parse(readFileSync(parentFile, "utf8")));
  if (parentRun.run_id !== continuation.parent.run_id || parentRun.status !== "blocked" || parentRun.branch !== continuation.parent.branch) {
    throw new Error("schema-v2 parent run identity is stale");
  }
  const parentBranch = authorityGit(options, repository, ["rev-parse", "--verify", `refs/heads/${continuation.parent.branch}^{commit}`]);
  const parentBranchCommit = parentBranch.ok ? parentBranch.stdout.trim() : "";
  if (parentBranchCommit !== continuation.parent.commit) throw new Error("schema-v2 parent branch no longer matches continuation parent commit");
  const parentDir = dirname(parentFile);
  assertNoUnresolvedSliceDispatches(parentDir, parentRun);
  for (const slice of parentRun.slices || []) assertSliceAttemptHistoryCurrent(parentDir, slice.id, slice);
  const bindings = [];
  for (const [collection, resolver, label] of [
    [continuation.parent_artifacts || [], resolveArtifactRef, "artifact"],
    [continuation.parent_evidence || [], resolveEvidenceRef, "evidence"],
    [continuation.parent_reviews || [], resolveReviewRef, "review"],
  ]) {
    for (const binding of collection) {
      const resolved = resolver(parentDir, binding.ref);
      const hash = hashFile(resolved.path);
      if (hash !== binding.hash) throw new Error(`schema-v2 parent ${label} '${binding.ref}' bytes are stale`);
      bindings.push({ kind: label, ref: binding.ref, hash });
    }
  }
  if (continuation.review?.source === "run.terminal_result.nonconvergence.source_review.review_ref") {
    const terminal = parentRun.terminal_result?.nonconvergence;
    const source = terminal?.source_review;
    const parentSlice = (parentRun.slices || []).find((slice) => slice?.id === terminal?.slice_id);
    if (parentRun.terminal_result?.reason !== "slice-review-nonconvergent" || !source || !parentSlice
      || !sameJson(source, parentSlice.attempt_reviews?.at(-1)) || source.review_ref !== continuation.review.ref || source.review_hash !== continuation.review.hash) {
      throw new Error("schema-v2 parent terminal nonconvergence authority is stale");
    }
  }
  return { run_hash: runHash, branch_commit: parentBranchCommit, bindings_hash: hashValue(bindings) };
}

function canonicalCarryForwardSpecStep(continuation) {
  if (isCheckpointPlanningReuse(continuation)) return null;
  const reuse = continuation.planning_reuse;
  return {
    agent: "spec-writer", status: "accepted", attempts: 0, artifact_ref: "artifacts/technical-brief.md", review_ref: "reviews/spec-writer.json",
    acceptance: { artifact_ref: "artifacts/technical-brief.md", artifact_hash: reuse.spec_artifact_hash, review_ref: "reviews/spec-writer.json", review_hash: reuse.spec_review_hash },
    inherited_acceptance: { from_run_id: continuation.parent.run_id, parent_spec_review_ref: reuse.spec_review_ref, artifact_hash: reuse.spec_artifact_hash, review_hash: reuse.spec_review_hash },
  };
}

function assertV2ImmutablePublicationTransition(current, next) {
  if (current.continuation?.schema_version !== 2) return;
  for (const key of ["continuation", "mode", "github_account", "pr_mode", "max_parallel_slices", "max_retries", "review_tier", "checkpoint_source"]) {
    if (!sameJson(current[key], next[key])) throw new Error(`schema-v2 publication field '${key}' is immutable`);
  }
  if (!sameJson(current.post_pr?.policy, next.post_pr?.policy)) throw new Error("schema-v2 publication field 'post_pr.policy' is immutable");
  const canonical = canonicalCarryForwardSpecStep(current.continuation);
  const currentSpec = (current.steps || []).find((step) => step?.agent === "spec-writer");
  const nextSpec = (next.steps || []).find((step) => step?.agent === "spec-writer");
  if (canonical === null) {
    if (currentSpec !== undefined || nextSpec !== undefined) throw new Error("checkpoint schema-v2 carry-forward cannot fabricate a spec-writer projection");
  } else if (!sameJson(currentSpec, canonical) || !sameJson(nextSpec, canonical)) throw new Error("schema-v2 carry-forward spec-writer projection is immutable");
  const currentDecomposition = (current.steps || []).find((step) => step?.agent === "work-decomposer");
  const nextDecomposition = (next.steps || []).find((step) => step?.agent === "work-decomposer");
  if (!isRecord(currentDecomposition) || !sameJson(currentDecomposition, nextDecomposition)) throw new Error("schema-v2 accepted work-decomposer projection is immutable");
}

function isCheckpointPlanningReuse(continuation) {
  return Object.hasOwn(continuation || {}, "checkpoint_source_hash") && Object.hasOwn(continuation?.planning_reuse || {}, "plan_ref");
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
  if (hooks.integrationAmendment !== INTEGRATION_AMENDMENT_TRANSITION_AUTHORITY && !sameJson(current.integration_amendment, next.integration_amendment)) {
    throw new Error("run integration_amendment can only be changed by transitionIntegrationAmendment");
  }
  if (!sameJson(current.special_builder_dispatch, next.special_builder_dispatch)) {
    if (hooks.consumeSpecialDispatch !== true || next.special_builder_dispatch !== undefined) {
      throw new Error("run special_builder_dispatch can only be changed by checked special Task dispatch transitions");
    }
  }
  const acceptedIntegrationConflicts = hooks.integrationConflicts === "test-acceptance" && isExactIntegrationConflictAcceptanceTransition(current.slices, next.slices);
  if (hooks.slicesSeed !== true && hooks.sliceTransition !== true && !acceptedIntegrationConflicts && !sameJson(current.slices, next.slices)) {
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
  const currentAmendmentRun = validateRun(JSON.parse(readFileSync(join(runDir, RUN_FILE), "utf8")));
  const unboundAmendmentDispatch = options.allowUnboundIntegrationAmendmentDispatch === true
    && options.integrationAmendmentAuthority === INTEGRATION_AMENDMENT_TRANSITION_AUTHORITY;
  const amendmentAuthority = unboundAmendmentDispatch
    ? observeIntegrationAmendmentCoreAuthority(runDir, currentAmendmentRun, options)
    : observeIntegrationAmendmentWriterAuthority(runDir, currentAmendmentRun, {
        dedicated: options.integrationAmendmentAuthority === INTEGRATION_AMENDMENT_TRANSITION_AUTHORITY,
        blockedTerminal: options.blockedAmendmentTerminal === true,
        action: options.integrationAmendmentAction,
        integrationAmendmentDownstreamMergeAuthority: options.integrationAmendmentDownstreamMergeAuthority,
        integrationAmendmentPendingSliceMerge: options.integrationAmendmentPendingSliceMerge,
      });
  if (options.integrationAmendmentAuthority !== INTEGRATION_AMENDMENT_TRANSITION_AUTHORITY && !sameJson(currentAmendmentRun.integration_amendment, next.integration_amendment)) {
    throw new Error("generic run writer cannot create, change, or remove integration amendment authority");
  }
  const assertSpecialDispatches = options.allowUnresolvedSpecialDispatch === true ? null : () => {
    const current = validateRun(JSON.parse(readFileSync(join(runDir, RUN_FILE), "utf8")));
    if (options.allowPendingSpecialDispatch === true) assertNoUnresolvedSpecialBuilderDispatches(runDir, current);
    else assertNoPendingSpecialBuilderDispatches(runDir, current);
  };
  if (assertSpecialDispatches) assertSpecialDispatches();
  const protectedBeforeReplace = beforeReplace || assertSpecialDispatches || amendmentAuthority ? async () => {
    if (beforeReplace) await beforeReplace();
    if (assertSpecialDispatches) assertSpecialDispatches();
    if (unboundAmendmentDispatch) {
      const current = validateRun(JSON.parse(readFileSync(join(runDir, RUN_FILE), "utf8")));
      if (!sameJson(observeIntegrationAmendmentCoreAuthority(runDir, current, options), amendmentAuthority)) {
        throw new Error("integration amendment core authority changed before special dispatch binding");
      }
    } else {
      assertIntegrationAmendmentWriterAuthorityCurrent(runDir, currentAmendmentRun, amendmentAuthority, {
        dedicated: options.integrationAmendmentAuthority === INTEGRATION_AMENDMENT_TRANSITION_AUTHORITY,
        blockedTerminal: options.blockedAmendmentTerminal === true,
        action: options.integrationAmendmentAction,
        integrationAmendmentDownstreamMergeAuthority: options.integrationAmendmentDownstreamMergeAuthority,
        integrationAmendmentPendingSliceMerge: options.integrationAmendmentPendingSliceMerge,
      });
    }
  } : null;
  const fsOps = typeof protectedBeforeReplace === "function"
    ? {
        rename: (source, destination) => {
          const observed = protectedBeforeReplace();
          if (observed && typeof observed.then === "function") return Promise.resolve(observed).then(() => rename(source, destination));
          return rename(source, destination);
        },
      }
    : undefined;
  await writeProtectedJsonAtomic(runDir, RUN_FILE, next, { hooks: options.atomicWriteHooks, fsOps });
}

async function writeSemanticRunJson(runDir, next, options = {}, expected = null, beforeReplace = null) {
  const authority = assertV2LocalPublishedAuthority(runDir, next, options, expected);
  const assertTerminalDispatches = TERMINAL_RUN_STATUSES.has(next.status) ? () => {
    const current = validateRun(JSON.parse(readFileSync(join(runDir, RUN_FILE), "utf8")));
    if (!TERMINAL_RUN_STATUSES.has(current.status)) assertNoUnresolvedSliceDispatches(runDir, current);
  } : null;
  if (assertTerminalDispatches) assertTerminalDispatches();
  await writeProtectedRunJson(
    runDir,
    next,
    options,
    authority || beforeReplace || assertTerminalDispatches ? () => {
      if (beforeReplace) beforeReplace();
      if (authority) assertV2LocalPublishedAuthority(runDir, next, options, authority);
      if (assertTerminalDispatches) assertTerminalDispatches();
    } : null,
  );
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
  const authority = await observePrOperationGitAuthority(runDir, run, options, "post-PR completion");
  const route = classifyWholeStoryTestRoute(runDir, run, options);
  if (route !== WHOLE_STORY_ROUTES.LEGACY) {
    const decision = evaluateWholeStoryRouteSink({
      route,
      sink: "SINK23",
      base: authority.base_sha === run.base_commit ? "equal" : "ancestor",
      head: "equal",
      review: "fresh",
      pr_mode: run.pr_mode,
    });
    if (!decision.allowed) throw new Error(`post-PR completion denied: ${decision.reason}`);
  }
  for (const [key, value] of Object.entries({ repository: authority.repository, head_ref: authority.head_ref, base_ref: authority.base_ref, draft: authority.draft })) {
    if (operation[key] !== value) throw new Error(`post-PR PR operation ${key} no longer matches local/origin authority`);
  }
  if (authority.head_sha !== expectedHeadSha) throw new Error("post-PR completion requires local, worktree, origin, and expected remediation head equality");
  const stableOperationId = computePrOperationId({ base_commit: run.base_commit, branch: operation.head_ref, created_at: operation.created_at, repository: operation.repository, run_id: run.run_id });
  if (operation.operation_id !== stableOperationId) throw new Error("post-PR operation_id is stale or malformed");
  if (route !== WHOLE_STORY_ROUTES.LEGACY) assertWholeStorySinkAllowed({ route, sink: "SINK24", base: authority.base_sha === run.base_commit ? "equal" : "ancestor", head: "equal", review: "fresh", pr_mode: run.pr_mode });
  const observation = await observeFencedPrOperation(run, { ...operation, base_sha: authority.base_sha }, options, expectedHeadSha);
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
  if (run.continuation?.schema_version === 2) assertV2LocalPublishedAuthority(runDir, run, { runDir });
  assertNoUnresolvedSliceDispatches(runDir, run);
  if (stringValue(run.pr_url)) throw new Error("pr-created requires run.pr_url to be unset");
  if (run.gates?.pre_pr?.status !== "approved") throw new Error("pr-created requires approved pre_pr gate");
  if (!PASSING_VALIDATOR_VERDICTS.has(run.validator?.verdict)) throw new Error("pr-created requires validator verdict GO or GO-WITH-NITS");
  if (!PASSING_SECURITY_VERDICTS.has(run.security_review?.verdict)) throw new Error("pr-created requires security_review verdict PASS");
  const freshTestAuthority = assertCheckedFreshDownstreamAuthority(runDir, run, "pre-PR admission");
  const route = classifyWholeStoryTestRoute(runDir, run, { runDir });
  if (route !== WHOLE_STORY_ROUTES.LEGACY) assertWholeStorySinkAllowed({ route, sink: "SINK20", claim: "completed-pass", evidence: "exact-pass", base: "equal", head: "equal", review: "fresh", pr_mode: run.pr_mode });
  return {
    fresh_test_authority: freshTestAuthority,
    slices: assertPrCreatedSliceState(runDir, run),
    panels: assertPanelReviewBindingsCurrent(runDir, run),
  };
}

function assertPrCreatedSliceState(runDir, run) {
  const slices = Array.isArray(run.slices) ? run.slices : [];
  const allowed = run.continuation?.schema_version === 2 ? new Set(["merged"]) : new Set(["merged", "blocked"]);
  const unfinished = slices.filter((slice) => !allowed.has(slice?.status)).map((slice) => slice?.id || "<unknown>");
  if (unfinished.length > 0) throw new Error(`pr-created requires all slices to be merged or blocked; unfinished slices: ${unfinished.join(", ")}`);
  if (!slices.some((slice) => slice?.status === "merged")) throw new Error("pr-created requires at least one merged slice");
  return slices.filter((candidate) => candidate?.status === "merged").map((slice) => {
    if (!hasCompleteBinding(slice, SLICE_REVIEW_BINDING_KEYS)) throw new Error(`pr-created requires successor review binding for merged slice '${slice.id}'`);
    const dispatch = observeClosedSliceDispatchIfClaimed(runDir, run.run_id, slice, { required: slice.dispatch_required === true });
    const observed = assertSliceReviewBindingCurrent(runDir, slice.id, slice);
    if (observed.review.verdict !== "APPROVE") throw new Error(`pr-created requires merged slice '${slice.id}' review verdict APPROVE`);
    return { id: slice.id, dispatch, authority: observed };
  });
}

export function observeCheckedTestExecutionAuthority(runDir, run, options = {}, policy = {}) {
  const route = classifyWholeStoryTestRoute(runDir, run, options);
  const continuationEligible = isSchemaV2WholeStoryRoute(route);
  const conflictEligible = isDelegatedConflictWholeStoryRoute(route);
  const ordinaryEligible = route === WHOLE_STORY_ROUTES.ORDINARY_FRESH;
  if (!continuationEligible && !conflictEligible && !ordinaryEligible) {
    throw testExecutionError("TEST_EXECUTION_INELIGIBLE", "checked test execution requires an exact published schema-v2 child or delegated integration conflict");
  }
  assertWholeStorySinkAllowed({ route, sink: "SINK10", head: "equal" });
  const repository = resolve(runDir, "../../..");
  const target = run.continuation?.target;
  if (resolve(runDir) !== resolve(directFactoryRoot(repository), run.run_id)
    || (continuationEligible && (target?.run_id !== run.run_id || target?.branch !== run.branch || resolve(target?.worktree || "") !== resolve(run.worktree || "")))) {
    throw testExecutionError("TEST_EXECUTION_INELIGIBLE", continuationEligible
      ? "checked test execution run identity does not match the published schema-v2 target"
      : "checked test execution run identity does not match its selected route authority");
  }
  if (run.status !== "running" && !(policy.allowTerminalCompleted === true && run.status === "completed")) throw testExecutionError("TEST_EXECUTION_INELIGIBLE", "checked test execution requires a running run");
  if (policy.skipLocalAuthority !== true) {
    if (continuationEligible) assertV2LocalPublishedAuthority(runDir, run, options);
    if (conflictEligible) assertSliceIntegrationConflictsCurrent(runDir, run, options);
  }
  const step = uniqueTestVerifierStep(run);
  if (!step || !Number.isInteger(step.attempts) || step.attempts < 1) throw testExecutionError("TEST_EXECUTION_INELIGIBLE", "checked test execution requires exactly one positive-attempt test-verifier step");
  if (policy.allowCompleted !== true && step.status !== "running") throw testExecutionError("TEST_EXECUTION_INELIGIBLE", "checked test execution requires test-verifier running at its current attempt");
  if (policy.allowCompleted === true && !["running", "rejected", "accepted"].includes(step.status)) throw testExecutionError("TEST_EXECUTION_INELIGIBLE", "completed checked test execution has an invalid step status");
  const decomposition = observeAcceptedDecompositionAuthority(runDir, run, { ...options, requireIntegrationGate: true });
  const integration = observeIntegrationHeadAuthority(run, { ...options, runDir }, "checked test execution");
  const slices = Array.isArray(run.slices) ? run.slices : [];
  if (slices.length === 0 || slices.some((slice) => slice?.status !== "merged")) {
    const incomplete = slices.filter((slice) => slice?.status !== "merged").map((slice) => slice?.id || "<unknown>");
    throw testExecutionError("TEST_EXECUTION_INELIGIBLE", `checked test execution requires every slice merged${incomplete.length ? `: ${incomplete.join(", ")}` : ""}`);
  }
  const merged = slices.map((slice) => {
    if (!stringValue(slice.merge_commit)) throw testExecutionError("TEST_EXECUTION_INELIGIBLE", `merged slice '${slice.id}' has no merge_commit`);
    const resolvedCommit = authorityGit(options, repository, ["rev-parse", "--verify", `${slice.merge_commit}^{commit}`]);
    const resolvedSha = resolvedCommit.ok ? resolvedCommit.stdout.trim() : "";
    if (!/^[0-9a-f]{40}$/u.test(resolvedSha)) throw testExecutionError("TEST_EXECUTION_INELIGIBLE", `merged slice '${slice.id}' merge_commit does not resolve`);
    const ancestry = authorityGit(options, repository, ["merge-base", "--is-ancestor", resolvedSha, integration.head]);
    if (!ancestry.ok) throw testExecutionError("TEST_EXECUTION_INELIGIBLE", `merged slice '${slice.id}' merge_commit is not an ancestor of exact child HEAD`);
    return { id: slice.id, merge_commit: slice.merge_commit, resolved_sha: resolvedSha };
  });
  assertWholeStorySinkAllowed({ route, sink: "SINK11", head: "equal" });
  return {
    run_id: run.run_id,
    attempt: step.attempts,
    plan_ref: PLAN_SLICES_REF,
    plan_hash: decomposition.plan_hash,
    plan_bytes: decomposition.plan_bytes.toString("base64"),
    commands: cloneJson(decomposition.plan.integration_gate.required_commands),
    timeout_ms: effectiveCheckedExecutionTimeoutMs(decomposition.plan.integration_gate.timeout_ms),
    decomposition_review_ref: decomposition.review_ref,
    decomposition_review_hash: decomposition.review_hash,
    branch: integration.branch,
    worktree: integration.worktree,
    head_sha: integration.head,
    merged,
  };
}

export function classifyWholeStoryTestRoute(runDir, run, options = {}) {
  const conflicts = integrationConflictSlices(run);
  const schemaV2 = run?.continuation?.schema_version === 2 && run.continuation.kind === "blocked-run-continuation";
  const slices = Array.isArray(run?.slices) ? run.slices : [];
  const state = {
    continuation: schemaV2 ? "v2" : run?.continuation ? "v1" : "absent",
    checkpoint_source: run?.checkpoint_source ? "present" : "absent",
    checkpoint_progress: run?.checkpoint_progress ? "present" : "absent",
    conflict: conflicts.length > 0 ? "present" : "absent",
    slice_projection: slices.length === 0 ? "empty" : slices.some((slice) => slice?.status !== "merged") ? "incomplete" : "all-merged",
  };
  let route = deriveWholeStoryRoute(state);
  if (route === WHOLE_STORY_ROUTES.ORDINARY_FRESH) {
    const decompositionSteps = (run.steps || []).filter((step) => step?.agent === "work-decomposer");
    if (!existsSync(join(resolve(runDir), "plan", "slices.json")) || decompositionSteps.length !== 1
      || decompositionSteps[0].status !== "accepted" || !isRecord(decompositionSteps[0].acceptance)) {
      state.slice_projection = "incomplete";
      route = deriveWholeStoryRoute(state);
    } else {
      const decomposition = observeAcceptedDecompositionAuthority(runDir, run, { ...options, requireIntegrationGate: true });
      if (!Array.isArray(decomposition.plan.slices) || decomposition.plan.slices.length === 0 || !isRecord(decomposition.plan.integration_gate)) {
        state.slice_projection = "incomplete";
        route = deriveWholeStoryRoute(state);
      }
    }
  }
  const sink = wholeStorySelectionSink(state, route);
  const decision = evaluateWholeStoryRouteSink({ ...state, route, sink });
  if (!decision.allowed) throw new Error(`whole-story route selection denied: ${decision.reason}`);
  return decision.route;
}

export function evaluateWholeStoryRouteSink(input) {
  if (!isRecord(input)) throw new Error("whole-story route-and-sink state must be an object");
  const routeState = wholeStoryRouteState(input);
  const derivedRoute = routeState ? deriveWholeStoryRoute(routeState) : null;
  const route = input.route === undefined
    ? derivedRoute
    : requireEnumValue(input.route, new Set(Object.values(WHOLE_STORY_ROUTES)), "whole-story route");
  if (!route) throw new Error("whole-story route or complete route state is required");
  if (derivedRoute && route !== derivedRoute) throw new Error("whole-story route does not match derived route state");
  const sink = requireEnumValue(input.sink, WHOLE_STORY_SINKS, "whole-story sink");
  const state = {
    claim: requireEnumValue(input.claim ?? "absent", WHOLE_STORY_STATE_VALUES.claim, "whole-story claim state"),
    evidence: requireEnumValue(input.evidence ?? "absent", WHOLE_STORY_STATE_VALUES.evidence, "whole-story evidence state"),
    base: requireEnumValue(input.base ?? "equal", WHOLE_STORY_STATE_VALUES.base, "whole-story base relationship"),
    head: requireEnumValue(input.head ?? "equal", WHOLE_STORY_STATE_VALUES.head, "whole-story head state"),
    review: requireEnumValue(input.review ?? "fresh", WHOLE_STORY_STATE_VALUES.review, "whole-story review state"),
    pr_mode: input.pr_mode ?? "ready",
  };
  if (!["ready", "draft"].includes(state.pr_mode)) throw new Error("whole-story pr_mode must be ready or draft");

  const selectedRoute = WHOLE_STORY_ROUTE_SELECTION_SINKS[sink];
  if (selectedRoute) {
    const selected = routeState ? sink === wholeStorySelectionSink(routeState, route) : route === selectedRoute;
    return wholeStorySinkDecision(route, sink, selected, selected ? "selected-route" : "route-mismatch");
  }
  if (sink === "SINK25" || sink === "SINK26") return wholeStorySinkDecision(route, sink, true, "independent-contract");
  if (!CHECKED_WHOLE_STORY_ROUTES.has(route)) return wholeStorySinkDecision(route, sink, false, "checked-route-required");
  if (state.head !== "equal") return wholeStorySinkDecision(route, sink, false, `head-${state.head}`);
  if (sink === "SINK12" && state.claim !== "active") return wholeStorySinkDecision(route, sink, false, "active-claim-required");
  if (sink === "SINK13" && (state.claim !== "completed-fail" || state.evidence !== "exact-fail")) return wholeStorySinkDecision(route, sink, false, "failed-replay-required");
  if (sink === "SINK14" && (state.claim !== "completed-pass" || state.evidence !== "exact-pass")) return wholeStorySinkDecision(route, sink, false, "checked-evidence-required");
  if (["SINK15", "SINK16", "SINK17"].includes(sink)
    && (state.claim !== "completed-pass" || state.evidence !== "exact-pass" || state.review !== "fresh")) {
    return wholeStorySinkDecision(route, sink, false, "fresh-passing-authority-required");
  }
  if (["SINK18", "SINK19", "SINK20", "SINK21", "SINK22", "SINK23", "SINK24"].includes(sink)) {
    if (!["equal", "ancestor"].includes(state.base)) return wholeStorySinkDecision(route, sink, false, `base-${state.base}`);
    if (state.review !== "fresh") return wholeStorySinkDecision(route, sink, false, `review-${state.review}`);
    if (route === WHOLE_STORY_ROUTES.ORDINARY_FRESH && state.pr_mode !== "ready") return wholeStorySinkDecision(route, sink, false, "ordinary-fresh-ready-required");
  }
  return wholeStorySinkDecision(route, sink, true, "allowed");
}

function wholeStoryRouteState(input) {
  const keys = ["continuation", "checkpoint_source", "checkpoint_progress", "conflict", "slice_projection"];
  if (!keys.some((key) => Object.hasOwn(input, key))) return null;
  return {
    continuation: requireEnumValue(input.continuation, WHOLE_STORY_STATE_VALUES.continuation, "whole-story continuation state"),
    checkpoint_source: requireEnumValue(input.checkpoint_source, WHOLE_STORY_STATE_VALUES.checkpoint_source, "whole-story checkpoint_source state"),
    checkpoint_progress: requireEnumValue(input.checkpoint_progress, WHOLE_STORY_STATE_VALUES.checkpoint_progress, "whole-story checkpoint_progress state"),
    conflict: requireEnumValue(input.conflict, WHOLE_STORY_STATE_VALUES.conflict, "whole-story conflict state"),
    slice_projection: requireEnumValue(input.slice_projection, WHOLE_STORY_STATE_VALUES.slice_projection, "whole-story slice_projection state"),
  };
}

function deriveWholeStoryRoute(state) {
  if (state.continuation === "v2" && state.conflict === "present") return WHOLE_STORY_ROUTES.COMBINED;
  if (state.continuation === "v2") return WHOLE_STORY_ROUTES.SCHEMA_V2;
  if (state.conflict === "present") return WHOLE_STORY_ROUTES.DELEGATED_CONFLICT;
  if (state.continuation === "v1" || state.checkpoint_source === "present" || state.checkpoint_progress === "present") return WHOLE_STORY_ROUTES.LEGACY;
  return state.slice_projection === "all-merged" ? WHOLE_STORY_ROUTES.ORDINARY_FRESH : WHOLE_STORY_ROUTES.LEGACY;
}

function wholeStorySelectionSink(state, route) {
  if (route === WHOLE_STORY_ROUTES.SCHEMA_V2) return "SINK01";
  if (route === WHOLE_STORY_ROUTES.DELEGATED_CONFLICT) return "SINK02";
  if (route === WHOLE_STORY_ROUTES.COMBINED) return "SINK03";
  if (route === WHOLE_STORY_ROUTES.ORDINARY_FRESH) return "SINK04";
  if (state.continuation === "v1") return "SINK05";
  if (state.checkpoint_source === "present") return "SINK06";
  if (state.checkpoint_progress === "present") return "SINK07";
  return "SINK08";
}

function requireEnumValue(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`${label} is invalid`);
  return value;
}

function wholeStorySinkDecision(route, sink, allowed, reason) {
  return Object.freeze({ route, sink, allowed, reason });
}

function assertWholeStorySinkAllowed(input) {
  const decision = evaluateWholeStoryRouteSink(input);
  if (!decision.allowed) throw testExecutionError("TEST_EXECUTION_INELIGIBLE", `whole-story ${decision.sink} denied: ${decision.reason}`);
  return decision;
}

function isSchemaV2WholeStoryRoute(route) {
  return route === WHOLE_STORY_ROUTES.SCHEMA_V2 || route === WHOLE_STORY_ROUTES.COMBINED;
}

function isDelegatedConflictWholeStoryRoute(route) {
  return route === WHOLE_STORY_ROUTES.DELEGATED_CONFLICT || route === WHOLE_STORY_ROUTES.COMBINED;
}

export function observeCompletedCheckedTestExecutionAuthority(runDir, run, step = uniqueTestVerifierStep(run), authority = null, options = {}) {
  const route = classifyWholeStoryTestRoute(runDir, run, options);
  const authorityLabel = route === WHOLE_STORY_ROUTES.ORDINARY_FRESH ? "checked" : "schema-v2";
  const claim = step?.execution_claim;
  if (!isRecord(claim) || claim.state !== "completed") throw new Error(`${authorityLabel} test authority requires a completed checked execution claim`);
  if (step.execution_claim_hash !== hashValue(claim)) throw new Error("completed checked execution claim hash is stale");
  const currentAuthority = authority || observeCheckedTestExecutionAuthority(runDir, run, { ...options, runDir }, { allowCompleted: true, skipLocalAuthority: true, allowTerminalCompleted: options.allowTerminalCompleted === true });
  if (claim.run_id !== run.run_id || claim.attempt !== step.attempts || claim.plan_ref !== currentAuthority.plan_ref
    || claim.plan_hash !== currentAuthority.plan_hash || claim.head_sha !== currentAuthority.head_sha
    || effectiveCheckedExecutionTimeoutMs(claim.timeout_ms) !== currentAuthority.timeout_ms) throw new Error("completed checked execution claim no longer matches current authority");
  const receipt = resolveEvidenceRef(runDir, claim.receipt_ref);
  const receiptValue = validateTestExecutionReceipt(parseJsonObjectFile(receipt.path, "checked test execution receipt"));
  const receiptHash = hashFile(receipt.path, { mode: "raw" });
  if (receiptHash !== claim.receipt_hash) throw new Error("completed checked execution receipt hash is stale");
  assertReceiptMatchesExecution(receiptValue, claim, currentAuthority);
  if (receiptValue.status !== claim.status || receiptValue.review_ready !== (claim.status === "pass")) throw new Error("completed checked execution receipt status is cross-bound");
  if (claim.status === "fail" && step.status !== "rejected") throw new Error("completed failed checked execution must leave test-verifier rejected");
  if (claim.status === "pass" && !["running", "accepted"].includes(step.status)) throw new Error("completed passing checked execution must leave test-verifier running or accepted");
  if (claim.status === "pass") assertWholeStorySinkAllowed({ route, sink: "SINK14", claim: "completed-pass", evidence: "exact-pass", head: "equal" });
  return { claim: cloneJson(claim), receipt: receiptValue, receipt_hash: receiptHash, authority: currentAuthority };
}

function assertReceiptMatchesExecution(receipt, claim, authority) {
  const expected = {
    run_id: claim.run_id,
    attempt: claim.attempt,
    claim_nonce: claim.nonce,
    plan_ref: claim.plan_ref,
    plan_hash: claim.plan_hash,
    head_sha: claim.head_sha,
  };
  for (const [key, value] of Object.entries(expected)) if (receipt[key] !== value) throw new Error(`checked test execution receipt ${key} is cross-bound`);
  if (effectiveCheckedExecutionTimeoutMs(receipt.timeout_ms) !== authority.timeout_ms) throw new Error("checked test execution receipt timeout_ms is cross-bound");
  if (receipt.commands.length !== authority.commands.length) throw new Error("checked test execution receipt command count differs from accepted plan");
  for (const [index, command] of authority.commands.entries()) {
    const result = receipt.commands[index];
    if (result.index !== index || result.program !== command.program || !sameJson(result.args, command.args)) throw new Error("checked test execution receipt commands differ from accepted plan order");
  }
}

function assertSameCheckedExecutionAuthority(actual, expected) {
  if (!sameJson(actual, expected)) throw new Error("checked test execution authority changed");
}

function uniqueTestVerifierStep(run) {
  const matches = (Array.isArray(run?.steps) ? run.steps : []).filter((step) => step?.agent === "test-verifier");
  return matches.length === 1 ? matches[0] : null;
}

function requireRunningTestVerifierStep(run) {
  const step = uniqueTestVerifierStep(run);
  if (!step || step.status !== "running" || !Number.isInteger(step.attempts) || step.attempts < 1) {
    throw testExecutionError("TEST_EXECUTION_INELIGIBLE", "checked test execution requires test-verifier running at a positive current attempt");
  }
  return step;
}

function assertExactActiveExecutionClaim(step, expected) {
  if (!isRecord(expected) || !isRecord(step?.execution_claim) || step.execution_claim.state !== "active" || !sameJson(step.execution_claim, expected)
    || step.execution_claim_hash !== hashValue(expected)) {
    throw operatorReconciliationRequired("active checked test execution claim changed or is missing");
  }
}

export function assertNoUnreconciledTestExecution(run) {
  const claim = uniqueTestVerifierStep(run)?.execution_claim;
  if (isRecord(claim) && ["active", "unknown"].includes(claim.state)) {
    throw operatorReconciliationRequired("active or unknown checked test execution cannot be changed by any supported factory command");
  }
}

function operatorReconciliationRequired(message) {
  return testExecutionError(
    "TEST_EXECUTION_OPERATOR_RECONCILIATION_REQUIRED",
    `${message}; no supported factory command may clear, replace, terminalize, retry, or advance the claim; trusted out-of-band operator/process reconciliation is required`,
  );
}

function testExecutionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertCheckedFreshDownstreamAuthority(runDir, run, sink, expected = null) {
  const route = classifyWholeStoryTestRoute(runDir, run, { runDir });
  if (route === WHOLE_STORY_ROUTES.LEGACY) return null;
  const authorityLabel = isSchemaV2WholeStoryRoute(route) ? "schema-v2" : route;
  const incomplete = (run.slices || []).filter((slice) => slice?.status !== "merged").map((slice) => slice?.id || "<unknown>");
  if (incomplete.length) throw new Error(`${authorityLabel} downstream authority requires all child slices merged before ${sink}: ${incomplete.join(", ")}`);
  const step = (run.steps || []).find((candidate) => candidate?.agent === "test-verifier");
  if (!step || step.status !== "accepted" || !Number.isInteger(step.attempts) || step.attempts < 1 || !isRecord(step.acceptance)) {
    throw new Error(`${authorityLabel} downstream authority requires fresh accepted test-verifier authority before ${sink}`);
  }
  const authority = observeCheckedTestVerifierAuthority(runDir, run, step, { runDir });
  if (!sameJson(step.acceptance, authority.acceptance)) throw new Error(`${authorityLabel} test-verifier acceptance bytes or head are stale`);
  const observed = { step: cloneJson(step), ...authority };
  if (expected && !sameJson(observed, expected)) throw new Error(`${authorityLabel} downstream authority changed before ${sink} publication`);
  return observed;
}

function observeCheckedTestVerifierAuthority(runDir, run, step, options = {}) {
  const route = classifyWholeStoryTestRoute(runDir, run, options);
  if (route === WHOLE_STORY_ROUTES.LEGACY) throw new Error("checked test-verifier acceptance requires a selected checked route");
  const authorityLabel = route === WHOLE_STORY_ROUTES.ORDINARY_FRESH ? "checked" : "schema-v2";
  assertWholeStorySinkAllowed({ route, sink: "SINK15", claim: "completed-pass", evidence: "exact-pass", head: "equal", review: "fresh" });
  for (const [key, label] of [["artifact_ref", "artifact"], ["evidence_ref", "evidence"], ["review_ref", "review"]]) {
    if (!stringValue(step?.[key])) throw new Error(`${authorityLabel} test-verifier acceptance requires ${label}_ref`);
  }
  if (step.artifact_ref !== "artifacts/test-report.md") throw new Error(`${authorityLabel} test-verifier acceptance requires artifacts/test-report.md`);
  const artifact = resolveArtifactRef(runDir, step.artifact_ref);
  const evidence = resolveEvidenceRef(runDir, step.evidence_ref);
  const review = resolveReviewRef(runDir, step.review_ref);
  const checked = observeCompletedCheckedTestExecutionAuthority(runDir, run, step, null, options);
  const evidenceValue = validateTestExecutionReceipt(parseJsonObjectFile(evidence.path, `${authorityLabel} test-verifier receipt`));
  const reviewValue = parseJsonObjectFile(review.path, `${authorityLabel} test-verifier review`);
  const integration = observeIntegrationHeadAuthority(run, { ...options, runDir }, `${authorityLabel} test-verifier acceptance`);
  if (step.evidence_ref !== checked.claim.receipt_ref || hashFile(evidence.path, { mode: "raw" }) !== checked.receipt_hash || !sameJson(evidenceValue, checked.receipt)) throw new Error(`${authorityLabel} test-verifier evidence must be the exact completed checked receipt`);
  if (checked.claim.status !== "pass" || evidenceValue.status !== "pass" || evidenceValue.review_ready !== true) throw new Error(`${authorityLabel} test-verifier acceptance requires a completed passing checked receipt`);
  const planAuthority = observeAcceptedDecompositionAuthority(runDir, run, { requireIntegrationGate: true });
  const expectedCommands = planAuthority.plan.integration_gate.required_commands;
  if (evidenceValue.commands.length !== expectedCommands.length || evidenceValue.commands.some((result, index) => result.program !== expectedCommands[index].program || !sameJson(result.args, expectedCommands[index].args) || result.status !== "pass")) throw new Error(`${authorityLabel} test-verifier receipt commands must exactly pass every accepted plan command in order`);
  if (evidenceValue.head_sha !== integration.head) throw new Error(`${authorityLabel} test-verifier evidence head_sha must equal the current clean child branch/worktree HEAD`);
  if (reviewValue.subject !== "test-verifier" || reviewValue.attempt !== step.attempts || String(reviewValue.verdict || "").toUpperCase() !== "APPROVE") {
    throw new Error(`${authorityLabel} test-verifier review must bind subject, attempt, and APPROVE verdict`);
  }
  if (reviewValue.reviewed_head_sha !== integration.head) throw new Error(`${authorityLabel} test-verifier review reviewed_head_sha must equal the current clean child branch/worktree HEAD`);
  return {
    acceptance: {
      artifact_ref: step.artifact_ref, artifact_hash: hashFile(artifact.path),
      evidence_ref: step.evidence_ref, evidence_hash: hashFile(evidence.path),
      review_ref: step.review_ref, review_hash: hashFile(review.path), reviewed_head_sha: integration.head,
    },
    evidence: evidenceValue,
    plan: { ref: PLAN_SLICES_REF, hash: planAuthority.plan_hash, commands: cloneJson(expectedCommands) },
    review: reviewValue,
    integration: { branch: integration.branch, worktree: integration.worktree, head: integration.head, clean: true },
  };
}

function assertCheckedPrePrGateAuthority(runDir, run, sink, expected = null) {
  const route = classifyWholeStoryTestRoute(runDir, run, { runDir });
  if (route === WHOLE_STORY_ROUTES.LEGACY) return null;
  const freshTestAuthority = assertCheckedFreshDownstreamAuthority(runDir, run, sink);
  if (!PASSING_VALIDATOR_VERDICTS.has(run.validator?.verdict) || !PASSING_SECURITY_VERDICTS.has(run.security_review?.verdict)) {
    throw new Error(`${route === WHOLE_STORY_ROUTES.ORDINARY_FRESH ? "checked" : "schema-v2"} pre-PR gate requires fresh passing child panels before ${sink}`);
  }
  assertWholeStorySinkAllowed({ route, sink: "SINK17", claim: "completed-pass", evidence: "exact-pass", head: "equal", review: "fresh" });
  const observed = {
    fresh_test_authority: freshTestAuthority,
    panels: assertPanelReviewBindingsCurrent(runDir, run),
  };
  if (expected && !sameJson(observed, expected)) throw new Error(`${route === WHOLE_STORY_ROUTES.ORDINARY_FRESH ? "checked" : "schema-v2"} downstream authority changed before ${sink} publication`);
  return observed;
}

export function assertPanelReviewBindingsCurrent(runDir, run) {
  if (!stringValue(runDir)) throw new Error("pr-created requires run directory context");
  if (!hasCompleteBinding(run.validator, VALIDATOR_BINDING_KEYS) || !hasCompleteBinding(run.security_review, SECURITY_BINDING_KEYS)) {
    throw new Error("pr-created requires successor validator and security reviewed-head bindings");
  }
  if (integrationConflictSlices(run).length > 0) {
    if (integrationConflictSlices(run).some(({ conflict }) => conflict.status !== "accepted")) throw new Error("panel bindings require accepted integrated conflict authority");
    assertSliceIntegrationConflictsCurrent(runDir, run, {});
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
  if (!hasCompleteBinding(slice, SLICE_REVIEW_BINDING_KEYS)) throw new Error(`slice '${sliceId}' merge requires a complete successor review binding`);
  const observed = assertSliceReviewBindingCurrent(runDir, sliceId, slice);
  const dispatch = observeClosedSliceDispatchIfClaimed(runDir, run.run_id, slice, { required: slice.dispatch_required === true });
  if (observed.review.verdict !== "APPROVE") throw new Error(`slice '${sliceId}' merge requires APPROVE review`);
  const sliceGit = observeSliceHeadAuthority(runDir, run, sliceId, slice, options);
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
  const decomposition = observeAcceptedDecompositionAuthority(runDir, run, { ...options, requireIntegrationGate: true });
  const reviewExtension = observeInvariantFamilyReviewAuthority(runDir, run, decomposition, sliceId, observed.review);
  assertApprovingInvariantFamilyReviewAuthority(decomposition.plan, sliceId, observed.review, reviewExtension, "merge");
  const ownership = observeSliceOwnershipAuthority(runDir, run, sliceId, slice, observed.review, observed.evidence, sliceGit, decomposition, options);
  if (!sameJson(slice.effective_paths, ownership.effective_paths)) throw new Error(`slice '${sliceId}' effective ownership changed after review`);
  const integrationConflict = run.special_builder_dispatch?.route === "integration-conflict"
    ? observeClosedIntegrationConflictForSlice(runDir, run, sliceId, canonicalCommit, repository, options)
    : null;
  const proof = integrationConflict?.integration_proof || observeExactSliceMergeProof(repository, run, sliceId, canonicalCommit, reviewedCommit, options);
  const coverage = integrationConflict
    ? observeSliceMergePathCoverage(repository, sliceId, canonicalCommit, reviewedCommit, options)
    : { merge_base: proof.merge_base, paths: proof.paths };
  if (slice.authorized_baseline_commit !== undefined) {
    if (coverage.merge_base !== slice.authorized_baseline_commit) throw new Error(`slice '${sliceId}' merge base must equal its authorized baseline`);
    if (!sameStringSet(new Set(coverage.paths), new Set(ownership.changed_paths))) {
      throw new Error(`slice '${sliceId}' merge path set must exactly equal its ownership-reviewed path set`);
    }
  }
  return {
    merge_commit: canonicalCommit,
    integration_branch: integrationBranch,
    integration_branch_head: integrationBranchResult.stdout.trim(),
    worktree_head: worktreeHead.stdout.trim(),
    integration_clean: true,
    slice_branch: slice.branch,
    slice_branch_head: reviewedCommit,
    proof,
    integration_conflict: integrationConflict,
    ownership,
    dispatch,
    review_extension: reviewExtension,
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
  observeInvariantFamilyLedgerEvidence(runDir, sliceId, reviewJson);
  if (evidenceJson.subject !== sliceId) throw new Error(`slice '${sliceId}' evidence subject must match slice id`);
  if (reviewJson.subject !== sliceId) throw new Error(`slice '${sliceId}' review subject must match slice id`);
  if (!["APPROVE", "REJECT"].includes(reviewJson.verdict)) throw new Error(`slice '${sliceId}' review verdict must be APPROVE or REJECT`);
  if (evidenceJson.status === "fail" && evidenceJson.review_ready === false && reviewJson.verdict === "REJECT") {
    assertFailedPreReviewEvidence(runDir, sliceId, slice, evidenceJson, evidenceBytes, reviewJson);
  } else if (evidenceJson.status !== "pass" || evidenceJson.review_ready !== true) {
    throw new Error(`slice '${sliceId}' evidence must be pass and review_ready`);
  }
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

function observeAttemptReviewResult(sliceId, review, { priorReviews = [] } = {}) {
  const { task_context: _taskContext, ...result } = validateSliceReviewResult(review, { sliceId, priorReviews });
  return result;
}

function assertSliceReviewAuthorityCurrent(runDir, sliceId, slice, expected) {
  const current = observeSliceReviewSidecars(runDir, sliceId, slice);
  if (!sameJson(current, expected)) throw new Error(`slice '${sliceId}' review authority bytes changed before publication`);
  return current;
}

function observeSliceReviewPublicationAuthority(runDir, run, sliceId, slice, decomposition, options = {}) {
  const observed = observeSliceReviewSidecars(runDir, sliceId, slice);
  if (observed.evidence.status === "fail" && options.failedPreReviewRetryAuthority !== FAILED_PRE_REVIEW_RETRY_AUTHORITY) {
    throw new Error(`slice '${sliceId}' failed pre-review evidence requires the checked verification retry transition`);
  }
  const dispatch = observeClosedSliceDispatchIfClaimed(runDir, run.run_id, slice, { required: true });
  const attempt = slice.attempts;
  if (!Number.isInteger(attempt) || attempt < 1 || observed.evidence.attempt !== attempt || observed.review.attempt !== attempt) {
    throw new Error(`slice '${sliceId}' successor evidence and review attempts must equal the positive slice attempt`);
  }
  const result = observeAttemptReviewResult(sliceId, observed.review, {
    priorReviews: (Array.isArray(slice.attempt_reviews) ? slice.attempt_reviews : []).filter((entry) => entry?.attempt < attempt),
  });
  const gitAuthority = observeSliceHeadAuthority(runDir, run, sliceId, slice, options);
  if (observed.evidence.head_sha !== gitAuthority.head) throw new Error(`slice '${sliceId}' evidence head_sha must equal the current slice head`);
  if (observed.review.reviewed_commit !== gitAuthority.head) throw new Error(`slice '${sliceId}' review reviewed_commit must equal the current slice head`);
  if (dispatch && dispatch.completion_head !== gitAuthority.head) throw new Error(`slice '${sliceId}' reviewed head must equal the checked Task completion head`);
  const reviewExtension = observeInvariantFamilyReviewAuthority(runDir, run, decomposition, sliceId, observed.review);
  assertPublishingInvariantFamilyReviewAuthority(decomposition.plan, sliceId, observed.review, reviewExtension);
  const ownership = observeSliceOwnershipAuthority(runDir, run, sliceId, slice, observed.review, observed.evidence, gitAuthority, decomposition, options);
  return {
    ...observed,
    binding: { ...observed.binding, reviewed_commit: gitAuthority.head },
    history_entry: {
      attempt,
      evidence_ref: slice.evidence_ref,
      evidence_hash: observed.binding.evidence_hash,
      review_ref: slice.review_ref,
      review_hash: observed.binding.review_hash,
      reviewed_commit: gitAuthority.head,
      diff_base_commit: ownership.diff_base_commit,
      ratified_paths: ownership.ratified_paths,
      ...result,
      ...(dispatch ? {
        dispatch_claim_ref: dispatch.claim_ref,
        dispatch_claim_hash: dispatch.claim_hash,
        dispatch_closure_ref: dispatch.closure_ref,
        dispatch_closure_hash: dispatch.closure_hash,
      } : {}),
    },
    git: gitAuthority,
    dispatch,
    ownership,
    review_extension: reviewExtension,
  };
}

function assertFailedPreReviewEvidence(runDir, sliceId, slice, evidence, evidenceBytes, review) {
  let receipt;
  try {
    receipt = validateVerificationArtifactExecutionReceipt(evidence);
  } catch (error) {
    throw new Error(`slice '${sliceId}' failed pre-review evidence must be a checked verification artifact receipt: ${error.message}`);
  }
  const hash = sha256Bytes(evidenceBytes);
  const claimRef = verificationArtifactExecutionClaimRef(slice.evidence_ref);
  const claim = validateVerificationArtifactExecutionClaim(parseJsonObjectFile(resolveEvidenceRef(runDir, claimRef).path, `slice '${sliceId}' failed verification claim`));
  if (receipt.status !== "fail" || receipt.review_ready !== false || receipt.slice_id !== sliceId || receipt.subject !== sliceId
    || claim.state !== "completed" || claim.status !== "fail" || claim.receipt_ref !== slice.evidence_ref || claim.receipt_hash !== hash
    || claim.nonce !== receipt.claim_nonce || claim.run_id !== receipt.run_id || claim.slice_id !== receipt.slice_id || claim.attempt !== receipt.attempt
    || claim.plan_ref !== receipt.plan_ref || claim.plan_hash !== receipt.plan_hash || claim.head_sha !== receipt.head_sha
    || effectiveCheckedExecutionTimeoutMs(claim.timeout_ms) !== effectiveCheckedExecutionTimeoutMs(receipt.timeout_ms)
    || claim.verification_artifact_id !== receipt.verification_artifact_id || !sameJson(claim.probe, receipt.probe)) {
    throw new Error(`slice '${sliceId}' failed pre-review evidence is not bound to its exact completed checked claim`);
  }
  const disposition = review.invariant_family_ledger?.dispositions?.find((entry) => entry?.evidence_ref === slice.evidence_ref);
  if (!disposition || disposition.evidence_hash !== hash || disposition.verification_artifact_id !== receipt.verification_artifact_id
    || disposition.result?.outcome !== "fail" || !sameJson(disposition.result, receipt.result)) {
    throw new Error(`slice '${sliceId}' failed pre-review evidence must be retained by the REJECT invariant-family ledger`);
  }
}

function observeReviewExtensionEvidence(runDir, ref, expectedHash) {
  const resolved = resolveEvidenceRef(runDir, ref, { mustExist: true });
  const bytes = readRegularNonEmptyFile(resolved.path, `invariant family ledger evidence '${ref}'`);
  const hash = sha256Bytes(bytes);
  if (expectedHash !== undefined && hash !== expectedHash) throw new Error(`invariant family ledger evidence hash is stale for '${ref}'`);
  const receipt = validateVerificationArtifactExecutionReceipt(parseJsonObjectBytes(bytes, `invariant family ledger evidence '${ref}'`));
  const claimRef = verificationArtifactExecutionClaimRef(ref);
  const claimResolved = resolveEvidenceRef(runDir, claimRef);
  const claim = validateVerificationArtifactExecutionClaim(parseJsonObjectFile(claimResolved.path, `invariant family ledger claim '${claimRef}'`));
  return { ref, hash, receipt, claim_ref: claimRef, claim };
}

function observeInvariantFamilyLedgerEvidence(runDir, sliceId, review) {
  const dispositions = review?.invariant_family_ledger?.dispositions;
  if (!Array.isArray(dispositions)) return;
  for (const disposition of dispositions) {
    const ref = requireNonEmptyString(disposition?.evidence_ref, `slice '${sliceId}' invariant family ledger evidence_ref`);
    const observed = observeReviewExtensionEvidence(runDir, ref, disposition.evidence_hash);
    if (observed.hash !== disposition.evidence_hash) {
      throw new Error(`slice '${sliceId}' invariant family ledger evidence hash is stale for '${ref}'`);
    }
  }
}

function observeInvariantFamilyReviewAuthority(runDir, run, decomposition, sliceId, review) {
  return validateReviewExtensionResult(evaluateInvariantFamilyReview({
    plan: decomposition.plan,
    sliceId,
    review,
    observeEvidence: (ref) => {
      const observed = observeReviewExtensionEvidence(runDir, ref);
      if (observed.receipt.run_id !== run.run_id) throw new Error("invariant family ledger checked receipt run id is stale");
      if (observed.receipt.plan_hash !== decomposition.plan_hash) throw new Error("invariant family ledger checked receipt plan hash is stale");
      return observed;
    },
  }));
}

function assertApprovingInvariantFamilyReviewAuthority(plan, sliceId, review, extension, boundary) {
  if (plan?.delivery_envelope === undefined || review?.verdict !== "APPROVE") return;
  if (extension.status !== "active" || extension.decision !== "approve" || extension.grants_b4_authority !== true) {
    throw new Error(`slice '${sliceId}' ${boundary} requires active approving invariant-family review authority: ${extension.reasons?.join(", ") || "authority-not-granted"}`);
  }
}

function assertPublishingInvariantFamilyReviewAuthority(plan, sliceId, review, extension) {
  if (plan?.delivery_envelope === undefined) return;
  if (review?.verdict === "APPROVE") {
    assertApprovingInvariantFamilyReviewAuthority(plan, sliceId, review, extension, "publication");
    return;
  }
  if (review?.verdict !== "REJECT") return;
  const reasons = Array.isArray(extension.reasons) ? extension.reasons : [];
  const incompleteReasons = reasons.filter((reason) => reason !== "review-verdict-reject"
    && !reason.startsWith("invariant-family-result-not-pass:")
    && !reason.startsWith("invariant-family-unresolved-findings:"));
  const completeReject = extension.status === "active"
    && extension.decision === "reject"
    && extension.grants_b4_authority === false
    && reasons.includes("review-verdict-reject")
    && incompleteReasons.length === 0;
  if (!completeReject) {
    throw new Error(`slice '${sliceId}' publication requires complete current invariant-family review ledger: ${incompleteReasons.join(", ") || "reject-authority-invalid"}`);
  }
}

function assertSliceReviewPublicationAuthorityCurrent(runDir, run, sliceId, slice, expected, decomposition, options = {}) {
  const current = observeSliceReviewPublicationAuthority(runDir, run, sliceId, slice, decomposition, options);
  if (!sameJson(current, expected)) throw new Error(`slice '${sliceId}' review authority changed before publication`);
  return current;
}

function assertSliceDispatchBaseline(run, slice, head) {
  const baseline = slice.authorized_baseline_commit;
  if (run.integration_amendment?.status === "merged" && !/^[0-9a-f]{40}$/u.test(baseline || "")) {
    throw new Error(`slice '${slice.id}' checked dispatch requires its authorized feature baseline`);
  }
  if (baseline === undefined) return;
  if (!/^[0-9a-f]{40}$/u.test(baseline)) throw new Error(`slice '${slice.id}' authorized feature baseline is invalid`);
  const history = Array.isArray(slice.attempt_reviews) ? slice.attempt_reviews : [];
  if (history[0] && history[0].diff_base_commit !== baseline) {
    throw new Error(`slice '${slice.id}' first review baseline differs from its authorized feature baseline`);
  }
  if (slice.attempts === 1) {
    if (history.length !== 0 || head !== baseline) throw new Error(`slice '${slice.id}' first dispatch head must equal its authorized feature baseline`);
    return;
  }
  const previous = history.find((entry) => entry?.attempt === slice.attempts - 1);
  if (!previous || head !== previous.reviewed_commit) {
    throw new Error(`slice '${slice.id}' retry dispatch head must equal the immediately prior reviewed commit`);
  }
}

function observeSliceOwnershipAuthority(runDir, run, sliceId, slice, review, evidence, gitAuthority, decomposition, options = {}) {
  const planned = decomposition?.plan?.slices?.find((candidate) => candidate?.id === sliceId);
  if (!planned || !sameJson(slice.declared_paths, planned.paths)) throw new Error(`slice '${sliceId}' declared_paths must equal the exact accepted plan paths`);
  const claim = observeSliceDispatchClaim(runDir, run.run_id, slice, slice.attempts, { requireRunBinding: true });
  if (!claim) throw new Error(`slice '${sliceId}' ownership review requires the exact checked dispatch baseline`);
  const history = Array.isArray(slice.attempt_reviews) ? slice.attempt_reviews : [];
  const diffBaseCommit = slice.authorized_baseline_commit || history[0]?.diff_base_commit || claim.claim.head;
  if (!/^[0-9a-f]{40}$/u.test(diffBaseCommit)) throw new Error(`slice '${sliceId}' first checked dispatch baseline is invalid`);
  if (slice.authorized_baseline_commit !== undefined && claim.claim.attempt === 1 && claim.claim.head !== slice.authorized_baseline_commit) {
    throw new Error(`slice '${sliceId}' first checked dispatch must equal its authorized baseline`);
  }
  if (history.length > 0) {
    const first = history[0];
    if (first.diff_base_commit !== diffBaseCommit) throw new Error(`slice '${sliceId}' stored diff baseline must equal its authorized baseline`);
    const boundFirst = { ...slice, attempts: first.attempt, dispatch_required: true, ...pickBinding(first, SLICE_DISPATCH_BINDING_KEYS) };
    const firstClaim = observeSliceDispatchClaim(runDir, run.run_id, boundFirst, first.attempt, { requireRunBinding: true });
    if (!firstClaim || firstClaim.claim.head !== diffBaseCommit) throw new Error(`slice '${sliceId}' stored diff baseline must equal the first checked dispatch commit`);
  }
  if (!authorityGit(options, gitAuthority.repository, ["merge-base", "--is-ancestor", diffBaseCommit, gitAuthority.head]).ok) {
    throw new Error(`slice '${sliceId}' reviewed commit must descend from the first checked dispatch baseline`);
  }
  const changedPaths = [...observeNoRenamePathSet(gitAuthority.repository, diffBaseCommit, gitAuthority.head, options, `slice '${sliceId}' full reviewed diff`)].sort();
  for (const path of changedPaths) {
    if (normalizeRepositoryPath(path) !== path || path.normalize("NFC") !== path || !isCanonicalConcreteRepositoryPath(path)) {
      throw new Error(`slice '${sliceId}' full reviewed diff contains an invalid ownership path`);
    }
  }
  const declaredLanes = planned.paths.map(ownershipLane);
  const unexpected = changedPaths.filter((path) => !declaredLanes.some((lane) => ownershipLaneContains(lane, path)));
  const ownershipDisclosure = normalizeOwnershipDisclosure(evidence?.ownership_disclosure, sliceId, unexpected);
  const { ratified_paths: ratifiedPaths, verdict } = validateSliceReviewResult(review, { sliceId });
  const expectedRatified = verdict === "APPROVE" ? unexpected : [];
  if (!sameJson(ratifiedPaths, expectedRatified)) {
    throw new Error(`slice '${sliceId}' ownership ratification must exactly equal every changed path outside declared ownership`);
  }
  if (verdict === "APPROVE") {
    const planLanes = decomposition.plan.slices.map((candidate) => ({ id: candidate.id, lanes: candidate.paths.map(ownershipLane) }));
    const changeKinds = observeChangedPathKinds(gitAuthority.repository, diffBaseCommit, gitAuthority.head, options);
    for (const path of ratifiedPaths) {
      const owners = planLanes.filter((candidate) => candidate.lanes.some((lane) => ownershipLaneContains(lane, path))).map((candidate) => candidate.id);
      if (owners.length > 1) throw new Error(`slice '${sliceId}' cannot ratify path '${path}' because it has ambiguous plan ownership: ${owners.join(", ")}`);
      if (owners.length !== 0) throw new Error(`slice '${sliceId}' cannot ratify path '${path}' because it has declared plan ownership`);
      const privilegedReason = privilegedControlPlanePathReason(path);
      if (privilegedReason) throw new Error(`slice '${sliceId}' cannot ratify privileged control-plane path '${path}' (${privilegedReason}); it requires explicit declared plan ownership`);
      if (changeKinds.get(path) !== "added") throw new Error(`slice '${sliceId}' unowned extension '${path}' must be a newly added private regular file`);
      const baselineEntry = authorityGit(options, gitAuthority.repository, ["ls-tree", "-z", diffBaseCommit, "--", `:(literal)${path}`]);
      const reviewedEntry = authorityGit(options, gitAuthority.repository, ["ls-tree", "-z", gitAuthority.head, "--", `:(literal)${path}`]);
      if (!baselineEntry.ok || !reviewedEntry.ok) throw new Error(`slice '${sliceId}' cannot observe ratification tree entry '${path}'`);
      if (baselineEntry.stdout !== "") throw new Error(`slice '${sliceId}' unowned extension '${path}' must be absent at the first checked dispatch baseline`);
      if (!/^(100644|100755) blob [0-9a-f]{40}\t/u.test(reviewedEntry.stdout)) {
        throw new Error(`slice '${sliceId}' cannot ratify symlink or submodule path '${path}'; unowned extensions must be private regular files`);
      }
    }
  }
  return {
    diff_base_commit: diffBaseCommit,
    ratified_paths: [...ratifiedPaths],
    effective_paths: [...slice.declared_paths, ...ratifiedPaths],
    changed_paths: changedPaths,
    ownership_disclosure: ownershipDisclosure,
    plan_hash: decomposition.plan_hash,
  };
}

function observeChangedPathKinds(repository, from, to, options = {}) {
  const result = authorityGit(options, repository, ["diff", "--name-status", "-z", "--find-renames", "--find-copies-harder", from, to]);
  if (!result.ok) throw new Error("slice ownership change kinds cannot be observed");
  if (result.stdout === "") return new Map();
  const records = parseNulRecords(result.stdout, "slice ownership change kinds");
  const kinds = new Map();
  for (let index = 0; index < records.length;) {
    const status = records[index++];
    if (!/^(?:[AMDTUXB]|[RC][0-9]{1,3})$/u.test(status)) throw new Error("slice ownership change kinds contain an invalid status");
    const first = records[index++];
    if (!first) throw new Error("slice ownership change kinds contain an invalid path");
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = records[index++];
      if (!second) throw new Error("slice ownership change kinds contain an invalid paired path");
      kinds.set(first, status.startsWith("R") ? "renamed" : "copied");
      kinds.set(second, status.startsWith("R") ? "renamed" : "copied");
    } else kinds.set(first, status === "D" ? "deleted" : status === "T" ? "type-changed" : status === "A" ? "added" : "modified");
  }
  return kinds;
}

function normalizeOwnershipDisclosure(value, sliceId, unexpectedPaths) {
  if (unexpectedPaths.length === 0) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length !== 0) throw new Error(`slice '${sliceId}' ownership_disclosure must be empty when every changed path is declared`);
    return [];
  }
  if (!Array.isArray(value)) throw new Error(`slice '${sliceId}' evidence must include ownership_disclosure for every changed path outside declared ownership`);
  const normalized = value.map((entry, index) => {
    if (!isRecord(entry) || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, "path") || !Object.hasOwn(entry, "rationale")) {
      throw new Error(`slice '${sliceId}' ownership_disclosure[${index}] must contain exactly path and rationale`);
    }
    if (!isCanonicalConcreteRepositoryPath(entry.path) || normalizeRepositoryPath(entry.path) !== entry.path || entry.path.normalize("NFC") !== entry.path) {
      throw new Error(`slice '${sliceId}' ownership_disclosure[${index}].path must be a canonical concrete repository path`);
    }
    const rationale = typeof entry.rationale === "string" ? entry.rationale : "";
    if (!rationale || rationale !== rationale.trim() || rationale !== rationale.normalize("NFC") || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(rationale)) {
      throw new Error(`slice '${sliceId}' ownership_disclosure[${index}].rationale must be nonempty normalized text`);
    }
    return { path: entry.path, rationale };
  });
  const disclosedPaths = normalized.map((entry) => entry.path);
  if (!sameJson(disclosedPaths, [...disclosedPaths].sort()) || new Set(disclosedPaths).size !== disclosedPaths.length) {
    throw new Error(`slice '${sliceId}' ownership_disclosure paths must be sorted and unique`);
  }
  if (!sameJson(disclosedPaths, unexpectedPaths)) {
    throw new Error(`slice '${sliceId}' ownership_disclosure paths must exactly equal every changed path outside declared ownership`);
  }
  return normalized;
}

function ownershipLane(path) {
  const canonical = validatePlanPath(path);
  if (canonical !== path) throw new Error("accepted plan contains an invalid ownership lane");
  return canonical.endsWith("/**") ? { base: canonical.slice(0, -3), recursive: true } : { base: canonical, recursive: false };
}

function ownershipLaneContains(lane, path) {
  return lane.recursive ? path.startsWith(`${lane.base}/`) : path === lane.base;
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
  const history = Array.isArray(slice.attempt_reviews) ? slice.attempt_reviews : [];
  if (history.length === 0) throw new Error(`slice '${sliceId}' current review is missing append-only attempt history`);
  assertSliceAttemptHistoryCurrent(runDir, sliceId, slice);
  const current = history.find((entry) => entry?.attempt === slice.attempts);
  if (!current) throw new Error(`slice '${sliceId}' current review is missing from append-only attempt history`);
  const result = observeAttemptReviewResult(sliceId, observed.review);
  const dispatch = observeAttemptReviewDispatch(runDir, sliceId, slice, current);
  const expected = {
    attempt: slice.attempts,
    evidence_ref: slice.evidence_ref,
    evidence_hash: slice.evidence_hash,
    review_ref: slice.review_ref,
    review_hash: slice.review_hash,
    reviewed_commit: slice.reviewed_commit,
    diff_base_commit: current.diff_base_commit,
    ratified_paths: result.ratified_paths,
    ...result,
    ...dispatch,
  };
  if (!sameJson(current, expected)) throw new Error(`slice '${sliceId}' current review differs from append-only attempt history`);
  return { ...observed, binding: pickBinding(slice, SLICE_REVIEW_BINDING_KEYS) };
}

export async function prepareSliceBuilderTaskDispatch(repoInput, request, options = {}) {
  if (!isRecord(request)) throw new Error("slice builder Task dispatch marker must be an object");
  const allowed = new Set(["run_id", "slice_id", "attempt", "agent"]);
  const extra = Object.keys(request).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`slice builder Task dispatch marker has unsupported field '${extra[0]}'`);
  if (!stringValue(request.run_id) || !SAFE_TASK_DISPATCH_ID_PATTERN.test(request.run_id) || request.run_id.includes("..") || request.run_id.endsWith(".lock")
    || !stringValue(request.slice_id) || !SLICE_BUILDER_AGENTS.has(request.agent)
    || !Number.isInteger(request.attempt) || request.attempt < 1 || request.attempt > 3) {
    throw new Error("slice builder Task dispatch marker requires safe run_id, slice_id, backend-builder|frontend-builder agent, and attempt 1..3");
  }

  const repository = repoRoot(repoInput);
  const factoryRoot = directFactoryRoot(repository);
  const runDir = resolve(factoryRoot, request.run_id);
  if (dirname(runDir) !== factoryRoot) throw new Error("slice builder Task dispatch run_id must identify one direct factory run");
  return withRunJsonLock(runDir, async () => {
    const run = await readRunJson(runDir);
    observeIntegrationAmendmentWriterAuthority(runDir, run);
    const v2Authority = assertV2LocalPublishedAuthority(runDir, run, { ...options, repoRoot: repository });
    if (run.run_id !== request.run_id || run.status !== "running") throw new Error("slice builder Task dispatch requires the exact current running run");
    const slice = (run.slices || []).find((candidate) => candidate?.id === request.slice_id);
    if (!slice || slice.status !== "running" || slice.attempts !== request.attempt) throw new Error("slice builder Task dispatch requires the exact current running slice attempt");
    if (`${slice.stack}-builder` !== request.agent) throw new Error("slice builder Task dispatch agent does not match the current slice stack");
    if (!stringValue(slice.branch) || !stringValue(slice.worktree)) throw new Error("slice builder Task dispatch requires bound branch and worktree identity");

    const branch = git(repository, ["rev-parse", "--verify", `refs/heads/${slice.branch}^{commit}`]);
    const head = branch.ok ? branch.stdout.trim() : "";
    if (!/^[0-9a-f]{40}$/u.test(head)) throw new Error("slice builder Task dispatch branch head cannot be observed");
    const worktree = resolve(repository, slice.worktree);
    const identity = checkWorktreeIdentity(repository, worktree, { branch: slice.branch, head });
    if (!identity.ok) throw new Error(`slice builder Task dispatch worktree identity is invalid: ${identity.reason}`);
    const cleanliness = git(worktree, gitCleanlinessArgs());
    if (!cleanliness.ok || cleanliness.stdout !== "") throw new Error("slice builder Task dispatch requires a clean current slice worktree");
    assertSliceDispatchBaseline(run, slice, head);

    const decomposition = observeAcceptedDecompositionAuthority(runDir, run, { requireIntegrationGate: true });
    const planBytes = decomposition.plan_bytes;
    const plan = decomposition.plan;
    const planned = plan.slices.find((candidate) => candidate.id === slice.id);
    if (!planned || planned.stack !== slice.stack || !sameJson(planned.depends_on, slice.depends_on)) throw new Error("slice builder Task dispatch plan identity is stale");
    assertPriorSliceDispatchesClosed(runDir, run.run_id, slice, slice.attempts, options.claimDispatch === true);

    const history = Array.isArray(slice.attempt_reviews) ? slice.attempt_reviews : [];
    const previous = history.at(-1) || null;
    let prior = null;
    let taskContext = "fresh";
    let forecastUnownedExtensionPaths = [];
    if (previous) {
      if (previous.attempt !== slice.attempts - 1 || previous.verdict !== "REJECT") throw new Error("slice builder Task dispatch requires the immediately prior rejected review");
      const observed = assertSliceReviewBindingCurrent(runDir, slice.id, {
        ...slice,
        attempts: previous.attempt,
        evidence_ref: previous.evidence_ref,
        evidence_hash: previous.evidence_hash,
        review_ref: previous.review_ref,
        review_hash: previous.review_hash,
        reviewed_commit: previous.reviewed_commit,
      });
      if (head !== previous.reviewed_commit) throw new Error("slice builder remediation head must equal the immediately prior reviewed_commit");
      taskContext = validateSliceReviewResult(observed.review, { sliceId: slice.id }).task_context;
      validateSliceReviewFeasibility(observed.review, plan, { sliceId: slice.id });
      assertReviewedSliceRetryRoute(observed.review, slice.id, run);
      forecastUnownedExtensionPaths = observed.review.remediation_context.fixes
        .filter((fix) => fix.scope_effect === "unowned-extension")
        .flatMap((fix) => cloneJson(fix.likely_paths));
      prior = {
        binding: cloneJson(previous),
        evidence: { encoding: "base64", bytes: observed.evidence_bytes },
        review: { encoding: "base64", bytes: observed.review_bytes },
      };
    } else {
      prior = observeCarryForwardNonconvergencePrior(repository, runDir, run, slice);
    }

    const acceptedInputs = new Map((run.steps || []).filter((step) => step?.status === "accepted" && ["artifacts/research-map.md", "artifacts/technical-brief.md"].includes(step.artifact_ref)).map((step) => [step.artifact_ref, step]));
    if (!acceptedInputs.has("artifacts/technical-brief.md")) throw new Error("slice builder dispatch requires exact accepted technical-brief authority");
    const authorizedInputs = [...acceptedInputs].map(([ref, step]) => {
      const artifact = resolveArtifactRef(runDir, ref);
      const artifactBytes = readRegularNonEmptyFile(artifact.path, `slice builder input '${ref}'`);
      const review = resolveReviewRef(runDir, requireNonEmptyString(step.review_ref, `slice builder input '${ref}' review_ref`));
      const reviewBytes = readRegularNonEmptyFile(review.path, `slice builder input '${ref}' review`);
      if (!isRecord(step.acceptance) || step.acceptance.artifact_ref !== ref || step.acceptance.artifact_hash !== sha256Bytes(artifactBytes)
        || step.acceptance.review_ref !== step.review_ref || step.acceptance.review_hash !== sha256Bytes(reviewBytes)) {
        throw new Error(`slice builder input '${ref}' is not bound by exact accepted authority`);
      }
      return {
        ref,
        hash: step.acceptance.artifact_hash,
        content: { encoding: "base64", bytes: artifactBytes.toString("base64") },
        review_ref: step.review_ref,
        review_hash: step.acceptance.review_hash,
        review: { encoding: "base64", bytes: reviewBytes.toString("base64") },
      };
    });
    const context = {
      schema_version: 1,
      kind: "checked-slice-builder-task-dispatch",
      task_context: taskContext,
      run: { id: run.run_id, branch: run.branch, worktree: run.worktree },
      slice: {
        id: slice.id,
        stack: slice.stack,
        attempt: slice.attempts,
        branch: slice.branch,
        worktree: slice.worktree,
        head,
        authorized_baseline_commit: slice.authorized_baseline_commit || null,
        contract: cloneJson(planned),
        ownership: {
          declared_paths: cloneJson(slice.declared_paths),
          effective_paths: cloneJson(slice.effective_paths),
          forecast_unowned_extension_paths: forecastUnownedExtensionPaths,
          disclosure_required_for_actual_unexpected_paths: true,
        },
      },
      plan: { ref: PLAN_SLICES_REF, hash: decomposition.plan_hash, bytes: { encoding: "base64", bytes: planBytes.toString("base64") }, review_ref: decomposition.review_ref, review_hash: decomposition.review_hash },
      prior,
      authorized_inputs: authorizedInputs,
      observed: { worktree_identity: "verified", clean: true },
    };
    if (options.claimDispatch === true) {
      const completionToken = requireNonEmptyString(options.completionToken, "slice builder dispatch completion token");
      if (completionToken.length > 256) throw new Error("slice builder dispatch completion token is too long");
      const dispatchDir = join(runDir, "dispatch");
      await mkdir(dispatchDir, { recursive: true });
      assertNoSymlinkPath(runDir, dispatchDir, "slice builder dispatch claim directory");
      const claimName = sliceDispatchClaimName(run.run_id, slice.id, slice.attempts);
      const claimRef = `dispatch/${claimName}`;
      const claimPath = join(runDir, claimRef);
      const closureRef = `dispatch/${claimName.slice(0, -5)}.closed.json`;
      const claim = {
        schema_version: 1,
        kind: "checked-slice-builder-dispatch-claim",
        run_id: run.run_id,
        slice_id: slice.id,
        attempt: slice.attempts,
        agent: request.agent,
        branch: slice.branch,
        worktree: slice.worktree,
        head,
        context_hash: hashValue(context),
        completion_token_hash: sha256Bytes(Buffer.from(completionToken, "utf8")),
        claimed_at: timestamp(options.now),
        closure_ref: closureRef,
      };
      const publication = await publishDispatchRecord(runDir, claimRef, claim, {
        hooks: options.sliceDispatchClaimAtomicWriteHooks,
        beforeCommit: () => {
          assertSliceBuilderTaskDispatchContextCurrent(repository, runDir, run, context, options);
        },
        existsMessage: "slice builder Task dispatch is already claimed for this exact run/slice/attempt",
      });
      const claimHash = hashFile(claimPath);
      const next = cloneJson(run);
      const nextSlice = next.slices.find((candidate) => candidate?.id === slice.id);
      nextSlice.dispatch_required = true;
      nextSlice.dispatch_claim_ref = claimRef;
      nextSlice.dispatch_claim_hash = claimHash;
      delete nextSlice.dispatch_closure_ref;
      delete nextSlice.dispatch_closure_hash;
      next.updated_at = timestamp(options.now);
      const assertPublicationAuthority = () => {
        assertSliceBuilderTaskDispatchContextCurrent(repository, runDir, run, context, options);
        const currentClaim = observeSliceDispatchClaim(runDir, run.run_id, nextSlice, nextSlice.attempts);
        if (!currentClaim || currentClaim.ref !== claimRef || currentClaim.hash !== claimHash) throw new Error("slice builder Task dispatch claim changed before run binding");
      };
      try {
        assertPublicationAuthority();
        await writeSemanticRunJson(runDir, validateRun(next), options, v2Authority, assertPublicationAuthority);
      } catch (error) {
        await removeOwnedFailedDispatchPublication(runDir, claimRef, publication, (current) => {
          const currentSlice = current.slices?.find((candidate) => candidate?.id === slice.id);
          return currentSlice?.dispatch_claim_ref === claimRef && currentSlice?.dispatch_claim_hash === claimHash;
        });
        throw error;
      }
      context.dispatch_claim = { ref: claimRef, hash: claimHash, closure_ref: closureRef, head };
    }
    return context;
  }, options);
}

export async function prepareSpecialBuilderTaskDispatch(repoInput, request, options = {}) {
  if (!isRecord(request)) throw new Error("special builder Task dispatch marker must be an object");
  const allowed = new Set(["run_id", "route", "agent"]);
  const extra = Object.keys(request).filter((key) => !allowed.has(key));
  const routes = new Set(["merged-slice-repair", "integration-amendment", "panel-remediation", "post-pr-remediation", "integration-conflict"]);
  if (extra.length || !stringValue(request.run_id) || !SAFE_TASK_DISPATCH_ID_PATTERN.test(request.run_id) || request.run_id.includes("..")
    || !routes.has(request.route) || !SLICE_BUILDER_AGENTS.has(request.agent)) {
    throw new Error("special builder Task dispatch marker requires safe run_id, recognized route, and backend-builder|frontend-builder agent");
  }
  const repository = repoRoot(repoInput);
  const factoryRoot = directFactoryRoot(repository);
  const runDir = resolve(factoryRoot, request.run_id);
  if (dirname(runDir) !== factoryRoot) throw new Error("special builder Task dispatch run_id must identify one direct factory run");
  return withRunJsonLock(runDir, async () => {
    const run = await readRunJson(runDir);
    observeIntegrationAmendmentWriterAuthority(runDir, run, { dedicated: request.route === "integration-amendment" });
    const v2Authority = assertV2LocalPublishedAuthority(runDir, run, { ...options, repoRoot: repository });
    assertNoPendingSpecialBuilderDispatches(runDir, run);
    if (run.run_id !== request.run_id || run.status !== "running") throw new Error("special builder Task dispatch requires the exact current running run");
    if (request.route !== "integration-conflict" && (run.slices || []).some((slice) => ["running", "review"].includes(slice?.status))) {
      throw new Error("special builder Task dispatch cannot overlap ordinary slice work");
    }
    let authority;
    let branch;
    let worktreeRef;
    let instance;
    if (request.route === "merged-slice-repair") {
      const repair = run.merged_slice_repair;
      const owner = (run.slices || []).find((slice) => slice?.id === repair?.owner_slice_id);
      if (repair?.status !== "repairing" || !owner || `${owner.stack}-builder` !== request.agent) {
        throw new Error("special merged-slice repair dispatch authority is not current");
      }
      branch = repair.branch || run.branch;
      worktreeRef = repair.worktree || run.worktree;
      instance = `attempt-${repair.attempts}`;
      authority = {
        repair: cloneJson(repair),
        owner: cloneJson(owner),
        publication: observeRepairPublicationAuthority(runDir, run, { ...options, repoRoot: repository }),
      };
    } else if (request.route === "integration-amendment") {
      const observed = integrationAmendmentDispatchAuthority(runDir, run, request.agent, options);
      branch = observed.attempt.branch_ref.slice("refs/heads/".length);
      worktreeRef = observed.attempt.worktree;
      instance = `${observed.amendment_id}:attempt-${observed.attempt.attempt}`;
      authority = observed;
    } else if (request.route === "panel-remediation") {
      const allMerged = (run.slices || []).length > 0 && run.slices.every((slice) => slice?.status === "merged");
      const panelRejected = run.validator?.verdict === "NO-GO" || run.security_review?.verdict === "BLOCK";
      if (!allMerged || !panelRejected || stringValue(run.pr_url) || run.terminal_result) throw new Error("special panel remediation dispatch authority is not current");
      branch = run.branch;
      worktreeRef = run.worktree;
      const panels = assertPanelReviewBindingsCurrent(runDir, run);
      instance = `${run.validator.review_hash}-${run.security_review.review_hash}`;
      authority = {
        validator: cloneJson(run.validator),
        security_review: cloneJson(run.security_review),
        panels,
        ownership: observePanelRemediationOwnership(runDir, run, request.agent),
      };
    } else if (request.route === "post-pr-remediation") {
      const remediation = run.post_pr?.remediation;
      if (run.post_pr?.phase !== "remediation-running" || remediation?.route !== request.agent || remediation?.dispatch?.status !== "running") {
        throw new Error("special post-PR remediation dispatch authority is not current");
      }
      branch = run.branch;
      worktreeRef = run.worktree;
      instance = remediation.dispatch.id;
      authority = {
        remediation: cloneJson(remediation),
        publication: observePostPrPublicationAuthority(runDir, run, { ...options, repoRoot: repository }),
      };
    } else {
      const conflict = observeIntegrationConflictAuthority(repository, runDir, run, options);
      if (`${conflict.effective_owner.stack}-builder` !== request.agent) {
        throw new Error("integration-conflict agent must match the effective conflict owner stack");
      }
      branch = run.branch;
      worktreeRef = run.worktree;
      instance = `${conflict.current_slice.id}-${conflict.integration_baseline}-${hashValue(conflict.conflict_paths)}`;
      authority = { conflict };
    }
    if (!stringValue(branch) || !stringValue(worktreeRef)) throw new Error("special builder Task dispatch requires exact branch and worktree authority");
    const branchResult = git(repository, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    const head = branchResult.ok ? branchResult.stdout.trim() : "";
    const worktree = resolve(repository, worktreeRef);
    const identity = checkWorktreeIdentity(repository, worktree, { branch, head });
    const cleanliness = git(worktree, gitCleanlinessArgs());
    const expectedConflict = request.route === "integration-conflict";
    if (!/^[0-9a-f]{40}$/u.test(head) || !identity.ok || !cleanliness.ok || (!expectedConflict && cleanliness.stdout !== "")) {
      throw new Error("special builder Task dispatch requires the exact clean current branch/worktree HEAD");
    }
    const context = {
      schema_version: 1,
      kind: "checked-special-builder-task-dispatch",
      route: request.route,
      agent: request.agent,
      run: { id: run.run_id, branch: run.branch, worktree: run.worktree },
      authority,
      target: { branch, worktree: worktreeRef, head, clean: !expectedConflict, ...(expectedConflict ? { integration_conflict: true } : {}) },
    };
    assertSpecialBuilderTaskDispatchContextCurrent(repository, runDir, run, context, options);
    if (options.claimDispatch === true) {
      const completionToken = requireNonEmptyString(options.completionToken, "special builder dispatch completion token");
      if (completionToken.length > 256) throw new Error("special builder dispatch completion token is too long");
      const claimName = specialDispatchClaimName(run.run_id, request.route, instance);
      const dispatchDir = join(runDir, "dispatch");
      await mkdir(dispatchDir, { recursive: true });
      assertNoSymlinkPath(runDir, dispatchDir, "special builder dispatch claim directory");
      const claimRef = `dispatch/${claimName}`;
      const claimPath = join(runDir, claimRef);
      const closureRef = `dispatch/${claimName.slice(0, -5)}.closed.json`;
      const claim = {
        schema_version: 1,
        kind: "checked-special-builder-dispatch-claim",
        run_id: run.run_id,
        route: request.route,
        instance,
        agent: request.agent,
        branch,
        worktree: worktreeRef,
        head,
        run_hash: specialDispatchAuthorityHash(run),
        context_hash: hashValue(context),
        completion_token_hash: sha256Bytes(Buffer.from(completionToken, "utf8")),
        claimed_at: timestamp(options.now),
        closure_ref: closureRef,
        ...(request.route === "integration-conflict" ? integrationConflictClaimFields(authority.conflict) : {}),
      };
      const assertPublicationAuthority = () => {
        assertSpecialBuilderTaskDispatchContextCurrent(repository, runDir, run, context, options);
      };
      const publication = await publishDispatchRecord(runDir, claimRef, claim, {
        hooks: publicationBeforeCommitHooks(options.specialDispatchClaimAtomicWriteHooks),
        beforeCommit: assertPublicationAuthority,
        existsMessage: "special builder Task dispatch is already claimed for this exact route instance",
      });
      let claimHash = null;
      try {
        claimHash = hashFile(claimPath);
        const next = cloneJson(run);
        next.special_builder_dispatch = {
          schema_version: 1, route: request.route, instance, agent: request.agent, claim_ref: claimRef, claim_hash: claimHash,
          ...(request.route === "integration-conflict" ? { owner_slice_id: authority.conflict.effective_owner.slice_id } : {}),
        };
        next.updated_at = timestamp(options.now);
        const assertClaimAuthority = () => {
          assertPublicationAuthority();
          const currentClaim = observeSpecialDispatchClaim(runDir, claimRef);
          if (currentClaim.hash !== claimHash) throw new Error("special builder Task dispatch claim changed before run binding");
        };
        await options.specialDispatchClaimAtomicWriteHooks?.afterCommit?.();
        assertClaimAuthority();
        await writeSemanticRunJson(runDir, validateRun(next), {
          ...options,
          allowUnresolvedSpecialDispatch: true,
          ...(request.route === "integration-amendment" ? {
            integrationAmendmentAuthority: INTEGRATION_AMENDMENT_TRANSITION_AUTHORITY,
            allowUnboundIntegrationAmendmentDispatch: true,
          } : {}),
        }, v2Authority, assertClaimAuthority);
        context.dispatch_claim = { ref: claimRef, hash: claimHash, closure_ref: closureRef };
      } catch (error) {
        await removeOwnedFailedDispatchPublication(runDir, claimRef, publication, (current) => {
          const binding = current?.special_builder_dispatch;
          return binding?.claim_ref === claimRef && binding?.claim_hash === claimHash;
        });
        throw error;
      }
    }
    return context;
  }, options);
}

export async function completeSpecialBuilderTaskDispatch(repoInput, request, options = {}) {
  if (!isRecord(request) || !stringValue(request.run_id) || !stringValue(request.route) || !SLICE_BUILDER_AGENTS.has(request.agent)
    || !stringValue(request.claim_ref) || !stringValue(request.claim_hash) || !stringValue(request.completion_token)) {
    throw new Error("special builder Task completion requires exact route, agent, claim binding, and completion token");
  }
  const repository = repoRoot(repoInput);
  const runDir = resolve(directFactoryRoot(repository), request.run_id);
  return withRunJsonLock(runDir, async () => {
    const run = await readRunJson(runDir);
    const v2Authority = assertV2LocalPublishedAuthority(runDir, run, { ...options, repoRoot: repository });
    const observed = observeSpecialDispatchClaim(runDir, request.claim_ref);
    if (observed.hash !== request.claim_hash || observed.claim.run_id !== run.run_id || observed.claim.route !== request.route || observed.claim.agent !== request.agent) {
      throw new Error("special builder Task completion claim binding is stale");
    }
    const binding = run.special_builder_dispatch;
    if (binding?.claim_ref !== observed.ref || binding?.claim_hash !== observed.hash || binding.route !== observed.claim.route
      || binding.instance !== observed.claim.instance || binding.agent !== observed.claim.agent || binding.closure_ref !== undefined) {
      throw new Error("special builder Task completion claim is not bound by current run state");
    }
    if (specialDispatchAuthorityHash(run) !== observed.claim.run_hash) throw new Error("special builder Task completion run authority changed during dispatch");
    if (sha256Bytes(Buffer.from(request.completion_token, "utf8")) !== observed.claim.completion_token_hash) throw new Error("special builder Task completion capability is invalid");
    const currentContext = specialBuilderContextFromClaim(repository, runDir, run, observed.claim, options);
    if (hashValue(currentContext) !== observed.claim.context_hash) throw new Error("special builder Task completion route authority changed during dispatch");
    const branchResult = git(repository, ["rev-parse", "--verify", `refs/heads/${observed.claim.branch}^{commit}`]);
    const completionHead = branchResult.ok ? branchResult.stdout.trim() : "";
    const worktree = resolve(repository, observed.claim.worktree);
    const identity = checkWorktreeIdentity(repository, worktree, { branch: observed.claim.branch, head: completionHead });
    const cleanliness = git(worktree, gitCleanlinessArgs());
    if (!/^[0-9a-f]{40}$/u.test(completionHead) || completionHead === observed.claim.head || !identity.ok || !cleanliness.ok || cleanliness.stdout !== ""
      || !git(repository, ["merge-base", "--is-ancestor", observed.claim.head, completionHead]).ok) {
      throw new Error("special builder Task completion requires a new clean descendant branch/worktree HEAD");
    }
    const panelOwnerSliceId = observed.claim.route === "panel-remediation"
      ? derivePanelRemediationOwner(repository, observed.claim, completionHead, currentContext.authority.ownership)
      : null;
    const conflictProof = observed.claim.route === "integration-conflict"
      ? observeIntegrationConflictCompletionProof(repository, run, observed.claim, completionHead, options)
      : null;
    const closure = {
      schema_version: 1,
      kind: "checked-special-builder-dispatch-closure",
      claim_ref: observed.ref,
      claim_hash: observed.hash,
      run_id: observed.claim.run_id,
      route: observed.claim.route,
      instance: observed.claim.instance,
      agent: observed.claim.agent,
      branch: observed.claim.branch,
      worktree: observed.claim.worktree,
      head: observed.claim.head,
      completion_head: completionHead,
      run_hash: observed.claim.run_hash,
      context_hash: observed.claim.context_hash,
      completion_token: request.completion_token,
      returned_at: timestamp(options.now),
      ...(panelOwnerSliceId ? { owner_slice_id: panelOwnerSliceId } : {}),
      ...(conflictProof ? { owner_slice_id: observed.claim.effective_owner.slice_id, integration_proof: conflictProof } : {}),
    };
    const publication = await publishDispatchRecord(runDir, observed.claim.closure_ref, closure, {
      hooks: publicationBeforeCommitHooks(options.specialDispatchClosureAtomicWriteHooks),
      beforeCommit: () => {
        const currentRun = validateRun(JSON.parse(readFileSync(join(runDir, RUN_FILE), "utf8")));
        if (!sameJson(currentRun, run)) throw new Error("special builder Task completion run authority changed before closure publication");
        const currentClaim = observeSpecialDispatchClaim(runDir, observed.ref);
        if (!sameJson(currentClaim, observed)) throw new Error("special builder Task completion claim changed before closure publication");
      },
      allowExisting: true,
    });
    await options.specialDispatchClosureAtomicWriteHooks?.afterCommit?.();
    const closed = observeClosedSpecialDispatch(runDir, observed);
    if (closed.completion_head !== completionHead) throw new Error("special builder Task completion conflicts with a closure for another HEAD");
    const next = cloneJson(run);
    Object.assign(next.special_builder_dispatch, {
      closure_ref: closed.closure_ref,
      closure_hash: closed.closure_hash,
      completion_head: closed.completion_head,
      ...(closed.owner_slice_id ? { owner_slice_id: closed.owner_slice_id } : {}),
    });
    next.updated_at = timestamp(options.now);
    const assertClosureAuthority = () => {
      const currentRun = validateRun(JSON.parse(readFileSync(join(runDir, RUN_FILE), "utf8")));
      if (!sameJson(currentRun, run)) throw new Error("special builder Task completion run authority changed before closure binding");
      const currentClaim = observeSpecialDispatchClaim(runDir, observed.ref);
      const currentClosed = observeClosedSpecialDispatch(runDir, currentClaim);
      if (!sameJson(currentClosed, closed)) throw new Error("special builder Task completion closure changed before run binding");
    };
    try {
      await writeSemanticRunJson(runDir, validateRun(next), {
        ...options,
        allowUnresolvedSpecialDispatch: true,
        ...(request.route === "integration-amendment" ? {
          integrationAmendmentAuthority: INTEGRATION_AMENDMENT_TRANSITION_AUTHORITY,
          allowUnboundIntegrationAmendmentDispatch: true,
        } : {}),
      }, v2Authority, assertClosureAuthority);
    } catch (error) {
      await removeOwnedFailedDispatchPublication(runDir, observed.claim.closure_ref, publication, (current) => {
        const binding = current.special_builder_dispatch;
        return binding?.closure_ref === closed.closure_ref && binding?.closure_hash === closed.closure_hash;
      });
      throw error;
    }
    return closed;
  }, options);
}

function specialDispatchClaimName(runId, route, instance) {
  return `${createHash("sha256").update(`${runId}\0special\0${route}\0${instance}`, "utf8").digest("hex")}.special.json`;
}

function specialDispatchAuthorityHash(run) {
  const copy = cloneJson(run);
  delete copy.special_builder_dispatch;
  delete copy.updated_at;
  return hashValue(copy);
}

function assertSpecialBuilderTaskDispatchContextCurrent(repository, runDir, expectedRun, context, options = {}) {
  const currentRun = validateRun(JSON.parse(readFileSync(join(runDir, RUN_FILE), "utf8")));
  if (!sameJson(currentRun, expectedRun)) throw new Error("special builder Task dispatch run authority changed before claim publication");
  const branch = git(repository, ["rev-parse", "--verify", `refs/heads/${context.target.branch}^{commit}`]);
  const head = branch.ok ? branch.stdout.trim() : "";
  const worktree = resolve(repository, context.target.worktree);
  const identity = checkWorktreeIdentity(repository, worktree, { branch: context.target.branch, head: context.target.head });
  const cleanliness = git(worktree, gitCleanlinessArgs());
  if (head !== context.target.head || !identity.ok || !cleanliness.ok || (!context.target.integration_conflict && cleanliness.stdout !== "")) {
    throw new Error("special builder Task dispatch Git authority changed before claim publication");
  }
  let authority;
  if (context.route === "merged-slice-repair") {
    const repair = currentRun.merged_slice_repair;
    const owner = currentRun.slices?.find((slice) => slice?.id === repair?.owner_slice_id);
    authority = { repair: cloneJson(repair), owner: cloneJson(owner), publication: observeRepairPublicationAuthority(runDir, currentRun, { ...options, repoRoot: repository }) };
  } else if (context.route === "integration-amendment") {
    authority = integrationAmendmentDispatchAuthority(runDir, currentRun, context.agent, options);
  } else if (context.route === "panel-remediation") {
    authority = {
      validator: cloneJson(currentRun.validator),
      security_review: cloneJson(currentRun.security_review),
      panels: assertPanelReviewBindingsCurrent(runDir, currentRun),
      ownership: observePanelRemediationOwnership(runDir, currentRun, context.agent),
    };
  } else if (context.route === "post-pr-remediation") {
    authority = { remediation: cloneJson(currentRun.post_pr?.remediation), publication: observePostPrPublicationAuthority(runDir, currentRun, { ...options, repoRoot: repository }) };
  } else {
    authority = { conflict: observeIntegrationConflictAuthority(repository, runDir, currentRun, options) };
  }
  if (!sameJson(authority, context.authority)) throw new Error("special builder Task dispatch route authority changed before claim publication");
}

function specialBuilderContextFromClaim(repository, runDir, run, claim, options = {}) {
  let authority;
  if (claim.route === "merged-slice-repair") {
    const repair = run.merged_slice_repair;
    const owner = (run.slices || []).find((slice) => slice?.id === repair?.owner_slice_id);
    const publication = observeRepairPublicationAuthority(runDir, run, { ...options, repoRoot: repository });
    if (publication?.git?.["feature-head"]) publication.git["feature-head"] = { ok: true, status: 0, stdout: `${claim.head}\n` };
    if (publication?.git?.cleanliness) publication.git.cleanliness = { ok: true, status: 0, stdout: "" };
    authority = { repair: cloneJson(repair), owner: cloneJson(owner), publication };
  } else if (claim.route === "integration-amendment") {
    authority = integrationAmendmentDispatchAuthority(runDir, run, claim.agent, options);
    const expectedInstance = `${authority.amendment_id}:attempt-${authority.attempt.attempt}`;
    if (claim.instance !== expectedInstance || claim.branch !== authority.attempt.branch_ref.slice("refs/heads/".length)
      || resolve(claim.worktree) !== resolve(authority.attempt.worktree) || claim.head !== authority.attempt.build_base_commit) {
      throw new Error("integration amendment dispatch claim authority is stale");
    }
  } else if (claim.route === "panel-remediation") {
    authority = {
      validator: cloneJson(run.validator),
      security_review: cloneJson(run.security_review),
      panels: observePriorPanelDispatchAuthority(repository, runDir, run, claim.head),
      ownership: observePanelRemediationOwnership(runDir, run, claim.agent),
    };
  } else if (claim.route === "post-pr-remediation") {
    authority = { remediation: cloneJson(run.post_pr?.remediation), publication: observePostPrPublicationAuthority(runDir, run, { ...options, repoRoot: repository }) };
  } else {
    const slice = (run.slices || []).find((candidate) => candidate?.id === claim.current_slice_id);
    const owner = (run.slices || []).find((candidate) => candidate?.id === claim.effective_owner?.slice_id);
    if (!slice || slice.status !== "review" || slice.reviewed_commit !== claim.merge_head || !owner || owner.stack !== claim.effective_owner.stack) {
      throw new Error("integration-conflict claim slice authority is stale");
    }
    authority = {
      conflict: {
        schema_version: 1,
        integration_baseline: claim.integration_baseline,
        feature_head: claim.feature_head,
        merge_head: claim.merge_head,
        conflict_paths: cloneJson(claim.conflict_paths),
        conflict_index_hash: claim.conflict_index_hash,
        current_slice: { id: slice.id, stack: slice.stack, reviewed_commit: slice.reviewed_commit, effective_paths: cloneJson(slice.effective_paths) },
        effective_owner: cloneJson(claim.effective_owner),
      },
    };
  }
  return {
    schema_version: 1,
    kind: "checked-special-builder-task-dispatch",
    route: claim.route,
    agent: claim.agent,
    run: { id: run.run_id, branch: run.branch, worktree: run.worktree },
    authority,
    target: { branch: claim.branch, worktree: claim.worktree, head: claim.head, clean: claim.route !== "integration-conflict", ...(claim.route === "integration-conflict" ? { integration_conflict: true } : {}) },
  };
}

function observePriorPanelDispatchAuthority(repository, runDir, run, priorHead) {
  const report = resolveArtifactRef(runDir, run.validator.report);
  const validatorReview = resolveReviewRef(runDir, run.validator.review_ref);
  const securityReview = resolveReviewRef(runDir, run.security_review.review_ref);
  const reportBytes = readRegularNonEmptyFile(report.path, "validator report");
  const validatorBytes = readRegularNonEmptyFile(validatorReview.path, "validator review");
  const securityBytes = readRegularNonEmptyFile(securityReview.path, "security review");
  if (sha256Bytes(reportBytes) !== run.validator.report_hash || sha256Bytes(validatorBytes) !== run.validator.review_hash
    || sha256Bytes(securityBytes) !== run.security_review.review_hash) throw new Error("special panel remediation prior review bytes changed during dispatch");
  const validatorJson = parseJsonObjectBytes(validatorBytes, "validator review");
  const securityJson = parseJsonObjectBytes(securityBytes, "security review");
  assertPanelReviewIdentity(run, validatorJson, securityJson, priorHead);
  const worktree = resolve(repository, run.worktree);
  return {
    ...authorityBytes({ report: reportBytes, validator: validatorBytes, security: securityBytes }),
    integration: { repository, branch: run.branch, worktree, head: priorHead, clean: true },
    validator_binding: { report_hash: run.validator.report_hash, review_hash: run.validator.review_hash, reviewed_head_sha: priorHead },
    security_binding: { review_hash: run.security_review.review_hash, reviewed_head_sha: priorHead },
  };
}

function observePanelRemediationOwnership(runDir, run, agent) {
  const planPath = join(runDir, PLAN_SLICES_REF);
  const plan = parseSlicesPlanBytes(readFileSync(planPath), { label: PLAN_SLICES_REF, enforceDependencyDepth: false });
  const durableById = new Map((run.slices || []).map((slice) => [slice?.id, slice]));
  for (const planned of plan.slices) {
    const slice = durableById.get(planned.id);
    if (!slice || slice.status !== "merged") throw new Error("panel remediation ownership requires every planned slice to be merged");
  }
  const slices = (run.slices || []).map((slice) => ({ id: slice?.id, stack: slice?.stack, effective_paths: cloneJson(slice?.effective_paths) }));
  const ownership = createOwnershipIndex(slices);
  if (!ownership.slices.some((slice) => `${slice.stack}-builder` === agent)) throw new Error("panel remediation agent has no eligible merged slice owner");
  return { plan: exactAuthorityFile(planPath), slices: cloneJson(ownership.slices), effective_lanes: cloneJson(ownership.effectiveLanes) };
}

function derivePanelRemediationOwner(repository, claim, completionHead, ownership) {
  const result = git(repository, ["diff", "--name-only", "-z", "--no-renames", claim.head, completionHead]);
  if (!result.ok) throw new Error("panel remediation changed paths are not observable");
  const paths = result.stdout.split("\0").filter(Boolean).map((path) => normalizeRepositoryPath(path));
  if (paths.length === 0) throw new Error("panel remediation must commit an observable change");
  const index = createOwnershipIndex(ownership.slices);
  const pathOwners = paths.map((path) => index.owners(path));
  if (pathOwners.some((owners) => owners.length !== 1)) throw new Error("panel remediation changes must derive exactly one unambiguous slice owner");
  const ownerIds = new Set(pathOwners.map(([owner]) => owner.id));
  if (ownerIds.size !== 1) throw new Error("panel remediation changes must derive exactly one unambiguous slice owner");
  const owner = index.slices.find((slice) => slice.id === [...ownerIds][0]);
  if (`${owner.stack}-builder` !== claim.agent) throw new Error("panel remediation agent must match the derived slice owner stack");
  return owner.id;
}

function observeIntegrationConflictAuthority(repository, runDir, run, options = {}) {
  const branch = requireNonEmptyString(run.branch, "run.branch");
  const worktreeRef = requireNonEmptyString(run.worktree, "run.worktree");
  const worktree = resolve(repository, worktreeRef);
  const branchHead = git(repository, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  const worktreeHead = git(worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const mergeHead = git(worktree, ["rev-parse", "--verify", "MERGE_HEAD^{commit}"]);
  const checkedOut = git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const integrationBaseline = branchHead.ok ? branchHead.stdout.trim() : "";
  const featureHead = worktreeHead.ok ? worktreeHead.stdout.trim() : "";
  const reviewedCommit = mergeHead.ok ? mergeHead.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/u.test(integrationBaseline) || featureHead !== integrationBaseline || !/^[0-9a-f]{40}$/u.test(reviewedCommit)
    || !checkedOut.ok || checkedOut.stdout.trim() !== branch) {
    throw new Error("integration-conflict dispatch requires an exact in-progress merge on the feature branch HEAD");
  }
  const candidates = (run.slices || []).filter((slice) => slice?.status === "review" && slice.reviewed_commit === reviewedCommit);
  if (candidates.length !== 1) throw new Error("integration-conflict dispatch requires exactly one reviewed current slice matching MERGE_HEAD");
  const currentSlice = candidates[0];
  const currentReview = assertSliceReviewBindingCurrent(runDir, currentSlice.id, currentSlice);
  if (currentReview.review.verdict !== "APPROVE") throw new Error("integration-conflict dispatch requires an APPROVE current-slice review");
  const mergeBases = authorityGit(options, repository, ["merge-base", "--all", integrationBaseline, reviewedCommit]);
  const bases = mergeBases.ok ? mergeBases.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean) : [];
  if (bases.length !== 1 || !/^[0-9a-f]{40}$/u.test(bases[0])) throw new Error("integration-conflict dispatch requires one unique merge base");
  const renameCopyEndpoints = new Set([
    ...observeRenameCopyEndpoints(repository, bases[0], integrationBaseline, options, "integration-conflict integration parent diff"),
    ...observeRenameCopyEndpoints(repository, bases[0], reviewedCommit, options, "integration-conflict reviewed parent diff"),
  ]);

  const status = git(worktree, gitIntegrationConflictStatusArgs());
  const unmerged = git(worktree, ["ls-files", "-u", "-z"]);
  const untracked = git(worktree, gitIntegrationConflictUntrackedArgs());
  if (!status.ok || !unmerged.ok || !untracked.ok || status.stdout === "" || unmerged.stdout === "") throw new Error("integration-conflict paths cannot be observed");
  if (untracked.stdout !== "") throw new Error("integration-conflict dispatch rejects unrelated unstaged or untracked edits");
  const statusRecords = parseNulRecords(status.stdout, "integration-conflict status");
  const conflictPaths = [];
  let unsupportedConflictCode = false;
  for (const record of statusRecords) {
    if (record.length < 4 || record[2] !== " ") throw new Error("integration-conflict status contains an invalid path record");
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (code.includes("U") || code === "AA" || code === "DD") {
      if (!new Set(["UU", "AA"]).has(code)) unsupportedConflictCode = true;
      const canonical = normalizeRepositoryPath(path);
      if (canonical !== path || path.normalize("NFC") !== path || !isCanonicalConcreteRepositoryPath(path)) throw new Error("integration-conflict path is invalid");
      conflictPaths.push(path);
    } else if (code[1] !== " ") {
      throw new Error("integration-conflict dispatch rejects unrelated unstaged or untracked edits");
    }
  }
  conflictPaths.sort();
  if (conflictPaths.length === 0 || new Set(conflictPaths).size !== conflictPaths.length) throw new Error("integration-conflict paths must be nonempty and unique");
  if (conflictPaths.some((path) => renameCopyEndpoints.has(path))) {
    throw new Error("integration-conflict path is a rename or copy endpoint on a merge parent diff and cannot dispatch");
  }
  if (unsupportedConflictCode) throw new Error("integration-conflict delete or non-textual conflict cannot dispatch");
  const unmergedEntries = parseNulRecords(unmerged.stdout, "integration-conflict index");
  const indexedPaths = new Set();
  for (const record of unmergedEntries) {
    const match = /^(\d{6}) [0-9a-f]{40} [123]\t(.+)$/u.exec(record);
    if (!match) throw new Error("integration-conflict index contains an invalid entry");
    const [, mode, path] = match;
    if (mode === "120000" || mode === "160000") throw new Error("integration-conflict symlink or submodule conflict cannot dispatch");
    indexedPaths.add(path);
  }
  if (!sameJson([...indexedPaths].sort(), conflictPaths)) throw new Error("integration-conflict status and index path sets differ");
  for (const path of conflictPaths) {
    for (const stage of [2, 3]) {
      const blob = git(worktree, ["show", `:${stage}:${path}`]);
      if (!blob.ok || blob.stdout.includes("\0")) throw new Error("integration-conflict binary or unreadable conflict cannot dispatch");
    }
  }
  const ownership = createOwnershipIndex((run.slices || []).map((slice) => ({ id: slice.id, stack: slice.stack, effective_paths: slice.effective_paths })));
  const declaredOwnership = createOwnershipIndex((run.slices || []).map((slice) => ({ id: slice.id, stack: slice.stack, effective_paths: slice.declared_paths })));
  if (conflictPaths.some((path) => isPrivilegedControlPlanePath(path) && declaredOwnership.owners(path).length !== 1)) {
    throw new Error("integration-conflict privileged control-plane conflict path requires explicit declared plan ownership");
  }
  const owners = conflictPaths.map((path) => ownership.owners(path));
  if (owners.some((matches) => matches.length > 1)) throw new Error("integration-conflict ambiguous effective ownership cannot dispatch");
  const soleOwnerIds = new Set(owners.filter((matches) => matches.length === 1).map(([owner]) => owner.id));
  const oneOwner = owners.every((matches) => matches.length === 1) && soleOwnerIds.size === 1;
  const assignedOwner = oneOwner
    ? ownership.slices.find((slice) => slice.id === [...soleOwnerIds][0])
    : ownership.slices.find((slice) => slice.id === currentSlice.id);
  if (!assignedOwner) throw new Error("integration-conflict effective owner is unavailable");
  return {
    schema_version: 1,
    integration_baseline: integrationBaseline,
    feature_head: featureHead,
    merge_head: reviewedCommit,
    conflict_paths: conflictPaths,
    conflict_index_hash: sha256Bytes(Buffer.from(unmerged.stdout, "utf8")),
    current_slice: { id: currentSlice.id, stack: currentSlice.stack, reviewed_commit: currentSlice.reviewed_commit, effective_paths: cloneJson(currentSlice.effective_paths) },
    effective_owner: { slice_id: assignedOwner.id, stack: assignedOwner.stack, kind: oneOwner ? "sole-owner" : "current-slice-integration" },
  };
}

function integrationConflictClaimFields(conflict) {
  return {
    integration_baseline: conflict.integration_baseline,
    feature_head: conflict.feature_head,
    merge_head: conflict.merge_head,
    conflict_paths: cloneJson(conflict.conflict_paths),
    conflict_index_hash: conflict.conflict_index_hash,
    current_slice_id: conflict.current_slice.id,
    effective_owner: cloneJson(conflict.effective_owner),
  };
}

function parseNulRecords(value, label) {
  if (typeof value !== "string" || !value.endsWith("\0")) throw new Error(`${label} must be NUL-delimited`);
  const records = value.slice(0, -1).split("\0");
  if (records.some((record) => record === "")) throw new Error(`${label} contains an empty record`);
  return records;
}

function observeRenameCopyEndpoints(repository, from, to, options, label) {
  const result = authorityGit(options, repository, ["diff", "--name-status", "-z", "--find-renames", "--find-copies-harder", from, to]);
  if (!result.ok) throw new Error(`${label} cannot be observed`);
  if (result.stdout === "") return new Set();
  const records = parseNulRecords(result.stdout, label);
  const endpoints = new Set();
  for (let index = 0; index < records.length;) {
    const status = records[index++];
    const first = records[index++];
    if (!/^(?:[AMDTUXB]|[RC][0-9]{1,3})$/u.test(status) || !first) throw new Error(`${label} contains an invalid change record`);
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = records[index++];
      if (!second) throw new Error(`${label} contains an invalid rename or copy record`);
      endpoints.add(first);
      endpoints.add(second);
    }
  }
  return endpoints;
}

function observeIntegrationConflictCompletionProof(repository, run, claim, completionHead, options = {}) {
  const currentSlice = (run.slices || []).find((slice) => slice?.id === claim.current_slice_id);
  const owner = (run.slices || []).find((slice) => slice?.id === claim.effective_owner?.slice_id);
  if (!currentSlice || !["review", "merged"].includes(currentSlice.status) || currentSlice.reviewed_commit !== claim.merge_head
    || !owner || owner.stack !== claim.effective_owner.stack || `${owner.stack}-builder` !== claim.agent) {
    throw new Error("integration-conflict completion effective owner or current slice is stale");
  }
  const parentsResult = authorityGit(options, repository, ["rev-list", "--parents", "-n", "1", completionHead]);
  if (!parentsResult.ok) throw new Error("integration-conflict completion parents cannot be observed");
  const parents = parentsResult.stdout.trim().split(/\s+/u);
  if (parents.length !== 3 || parents[0] !== completionHead || parents[1] !== claim.integration_baseline || parents[2] !== claim.merge_head) {
    throw new Error("integration-conflict completion must be a new merge commit with exact baseline and reviewed-slice parents");
  }
  const mergeBases = authorityGit(options, repository, ["merge-base", "--all", claim.integration_baseline, claim.merge_head]);
  const bases = mergeBases.ok ? mergeBases.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean) : [];
  if (bases.length !== 1 || !/^[0-9a-f]{40}$/u.test(bases[0])) throw new Error("integration-conflict completion requires one exact merge base");
  const reviewedPaths = observeNoRenamePathSet(repository, bases[0], claim.merge_head, options, "integration-conflict reviewed diff");
  const integratedPaths = observeNoRenamePathSet(repository, claim.integration_baseline, completionHead, options, "integration-conflict integrated diff");
  if (!sameStringSet(reviewedPaths, integratedPaths)) throw new Error("integration-conflict integrated path set must exactly equal the reviewed slice path set");
  const conflicts = new Set(claim.conflict_paths);
  if ([...conflicts].some((path) => !reviewedPaths.has(path))) throw new Error("integration-conflict path must belong to the exact reviewed slice diff");
  const integratedEntries = [];
  for (const path of reviewedPaths) {
    const literal = `:(literal)${path}`;
    const reviewed = authorityGit(options, repository, ["ls-tree", "-z", claim.merge_head, "--", literal]);
    const integrated = authorityGit(options, repository, ["ls-tree", "-z", completionHead, "--", literal]);
    if (!reviewed.ok || !integrated.ok) throw new Error("integration-conflict tree entries cannot be observed");
    if (!conflicts.has(path) && reviewed.stdout !== integrated.stdout) throw new Error(`integration-conflict non-conflict path '${path}' differs from reviewed bytes`);
    if (conflicts.has(path)) {
      if (!/^(100644|100755) blob [0-9a-f]{40}\t/u.test(integrated.stdout)) throw new Error(`integration-conflict path '${path}' must resolve to a regular integrated file`);
      integratedEntries.push({ path, entry_hash: sha256Bytes(Buffer.from(integrated.stdout, "utf8")) });
    }
  }
  integratedEntries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const tree = authorityGit(options, repository, ["rev-parse", "--verify", `${completionHead}^{tree}`]);
  if (!tree.ok || !/^[0-9a-f]{40}$/u.test(tree.stdout.trim())) throw new Error("integration-conflict integrated tree cannot be observed");
  return {
    schema_version: 1,
    integration_baseline: claim.integration_baseline,
    merge_head: claim.merge_head,
    resolution_commit: completionHead,
    merge_base: bases[0],
    conflict_paths: cloneJson(claim.conflict_paths),
    integrated_entries: integratedEntries,
    integrated_tree: tree.stdout.trim(),
  };
}

function integrationConflictSlices(run) {
  return (Array.isArray(run?.slices) ? run.slices : [])
    .filter((slice) => isRecord(slice?.integration_conflict))
    .map((slice) => ({ slice, conflict: slice.integration_conflict }));
}

function assertSliceIntegrationConflictsCurrent(runDir, run, options = {}) {
  return integrationConflictSlices(run).map(({ slice }) => assertSliceIntegrationConflictCurrent(runDir, run, slice, options));
}

function assertSliceIntegrationConflictCurrent(runDir, run, slice, options = {}) {
  const conflict = slice?.integration_conflict;
  if (!conflict) return null;
  const repository = resolveAuthorityRepository(runDir, run, options);
  if (!stringValue(repository)) throw new Error("integration-conflict review binding requires a local repository");
  const observed = observeSpecialDispatchClaim(runDir, conflict.claim_ref);
  const closed = observeClosedSpecialDispatch(runDir, observed);
  if (observed.hash !== conflict.claim_hash || observed.claim.route !== "integration-conflict" || closed.closure_ref !== conflict.closure_ref
    || closed.closure_hash !== conflict.closure_hash || closed.completion_head !== conflict.resolution_commit
    || observed.claim.current_slice_id !== conflict.slice_id || observed.claim.effective_owner.slice_id !== conflict.owner_slice_id
    || observed.claim.agent !== conflict.agent || observed.claim.integration_baseline !== conflict.integration_baseline
    || !sameJson(observed.claim.conflict_paths, conflict.conflict_paths)) {
    throw new Error("integration-conflict durable dispatch binding is stale");
  }
  const proof = observeIntegrationConflictCompletionProof(repository, run, observed.claim, conflict.resolution_commit, options);
  if (!sameJson(proof, conflict.integration_proof) || !sameJson(proof, closed.integration_proof)) {
    throw new Error("integration-conflict integrated bytes changed after resolution");
  }
  const integration = observeIntegrationHeadAuthority(run, { ...options, runDir }, "integration-conflict integrated review");
  if (!authorityGit(options, repository, ["merge-base", "--is-ancestor", conflict.resolution_commit, integration.head]).ok) {
    throw new Error("integration-conflict resolution commit must be an ancestor of the exact integrated review head");
  }
  if (conflict.status === "accepted") {
    assertHistoricalIntegrationConflictTestAcceptance(runDir, run, conflict, integration, options);
  }
  return { observed, closed, proof, integration };
}

async function snapshotIntegrationConflictTestArtifact(runDir, slice, conflict, acceptance) {
  const source = resolveArtifactRef(runDir, acceptance.artifact_ref);
  const bytes = readRegularNonEmptyFile(source.path, "integration-conflict test artifact");
  if (sha256Bytes(bytes) !== acceptance.artifact_hash) throw new Error("integration-conflict test artifact hash is stale before snapshot");
  const digest = createHash("sha256").update(`${slice.id}\0${conflict.resolution_commit}`, "utf8").digest("hex");
  const ref = `artifacts/integration-conflicts/${digest}.test-report.md`;
  const path = resolve(runDir, ref);
  await mkdir(dirname(path), { recursive: true });
  assertNoSymlinkPath(runDir, dirname(path), "integration-conflict test artifact snapshot directory");
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    assertNoSymlinkPath(runDir, path, "integration-conflict test artifact snapshot");
    if (!readFileSync(path).equals(bytes)) throw new Error("integration-conflict test artifact snapshot conflicts with existing bytes");
  }
  return { ref, hash: acceptance.artifact_hash };
}

function assertHistoricalIntegrationConflictTestAcceptance(runDir, run, conflict, integration, options = {}) {
  const acceptance = conflict.test_acceptance;
  const executionClaim = conflict.test_execution_claim;
  if (!isRecord(acceptance) || !isRecord(executionClaim) || conflict.test_execution_claim_hash !== hashValue(executionClaim)) {
    throw new Error("integration-conflict accepted test execution claim is stale");
  }
  const artifact = resolveArtifactRef(runDir, conflict.test_artifact_snapshot?.ref);
  const evidence = resolveEvidenceRef(runDir, acceptance.evidence_ref);
  const review = resolveReviewRef(runDir, acceptance.review_ref);
  if (hashFile(artifact.path) !== conflict.test_artifact_snapshot.hash || conflict.test_artifact_snapshot.hash !== acceptance.artifact_hash
    || hashFile(evidence.path) !== acceptance.evidence_hash || hashFile(review.path) !== acceptance.review_hash) {
    throw new Error("integration-conflict accepted test sidecar bytes are stale");
  }
  const receipt = validateTestExecutionReceipt(parseJsonObjectFile(evidence.path, "integration-conflict checked test receipt"));
  const reviewValue = parseJsonObjectFile(review.path, "integration-conflict test review");
  if (executionClaim.state !== "completed" || executionClaim.status !== "pass" || executionClaim.receipt_ref !== acceptance.evidence_ref
    || executionClaim.receipt_hash !== acceptance.evidence_hash || executionClaim.head_sha !== acceptance.reviewed_head_sha
    || receipt.run_id !== executionClaim.run_id || receipt.attempt !== executionClaim.attempt || receipt.claim_nonce !== executionClaim.nonce
    || receipt.plan_ref !== executionClaim.plan_ref || receipt.plan_hash !== executionClaim.plan_hash || receipt.head_sha !== executionClaim.head_sha
    || receipt.status !== "pass" || receipt.review_ready !== true) {
    throw new Error("integration-conflict accepted checked test receipt is stale or cross-bound");
  }
  const decomposition = observeAcceptedDecompositionAuthority(runDir, run, { requireIntegrationGate: true });
  const commands = decomposition.plan.integration_gate.required_commands;
  if (executionClaim.plan_ref !== PLAN_SLICES_REF || executionClaim.plan_hash !== decomposition.plan_hash || receipt.commands.length !== commands.length
    || receipt.commands.some((result, index) => result.index !== index || result.program !== commands[index].program || !sameJson(result.args, commands[index].args) || result.status !== "pass")) {
    throw new Error("integration-conflict accepted checked test commands differ from the exact plan");
  }
  if (reviewValue.subject !== "test-verifier" || reviewValue.attempt !== executionClaim.attempt || String(reviewValue.verdict || "").toUpperCase() !== "APPROVE"
    || reviewValue.reviewed_head_sha !== acceptance.reviewed_head_sha) {
    throw new Error("integration-conflict accepted test review is stale or cross-bound");
  }
  if (!authorityGit(options, integration.repository, ["merge-base", "--is-ancestor", conflict.resolution_commit, acceptance.reviewed_head_sha]).ok
    || !authorityGit(options, integration.repository, ["merge-base", "--is-ancestor", acceptance.reviewed_head_sha, integration.head]).ok) {
    throw new Error("integration-conflict accepted test head is outside the exact integrated ancestry");
  }
}

function isExactIntegrationConflictAcceptanceTransition(currentSlices, nextSlices) {
  if (!Array.isArray(currentSlices) || !Array.isArray(nextSlices) || currentSlices.length !== nextSlices.length) return false;
  let accepted = 0;
  for (const [index, current] of currentSlices.entries()) {
    const next = nextSlices[index];
    if (current?.id !== next?.id) return false;
    const priorConflict = current.integration_conflict;
    const nextConflict = next.integration_conflict;
    if (priorConflict?.status === "pending-integrated-review") {
      if (nextConflict?.status !== "accepted") return false;
      const stripped = cloneJson(nextConflict);
      delete stripped.test_acceptance;
      delete stripped.test_artifact_snapshot;
      delete stripped.test_execution_claim;
      delete stripped.test_execution_claim_hash;
      stripped.status = "pending-integrated-review";
      if (!sameJson(stripped, priorConflict)) return false;
      accepted += 1;
    } else if (!sameJson(priorConflict, nextConflict)) return false;
    if (!sameJson({ ...current, integration_conflict: nextConflict }, next)) return false;
  }
  return accepted > 0;
}

function observeClosedIntegrationConflictForSlice(runDir, run, sliceId, mergeCommit, repository, options = {}) {
  const binding = run.special_builder_dispatch;
  if (!binding || binding.route !== "integration-conflict" || binding.owner_slice_id === undefined) {
    throw new Error("integration-conflict slice merge requires the exact closed delegated conflict dispatch");
  }
  const observed = observeSpecialDispatchClaim(runDir, binding.claim_ref);
  const closed = observeClosedSpecialDispatch(runDir, observed);
  if (observed.hash !== binding.claim_hash || binding.closure_ref !== closed.closure_ref || binding.closure_hash !== closed.closure_hash
    || binding.completion_head !== closed.completion_head || closed.completion_head !== mergeCommit || observed.claim.current_slice_id !== sliceId
    || binding.owner_slice_id !== observed.claim.effective_owner.slice_id || specialDispatchAuthorityHash(run) !== observed.claim.run_hash) {
    throw new Error("integration-conflict checked dispatch binding is stale or targets another merge");
  }
  const integrationProof = observeIntegrationConflictCompletionProof(repository, run, observed.claim, mergeCommit, options);
  if (!sameJson(integrationProof, closed.integration_proof)) throw new Error("integration-conflict integrated bytes changed after delegated completion");
  return {
    claim_ref: observed.ref,
    claim_hash: observed.hash,
    closure_ref: closed.closure_ref,
    closure_hash: closed.closure_hash,
    completion_head: closed.completion_head,
    owner_slice_id: closed.owner_slice_id,
    agent: observed.claim.agent,
    integration_baseline: observed.claim.integration_baseline,
    conflict_paths: cloneJson(observed.claim.conflict_paths),
    integration_proof: integrationProof,
  };
}

function observeCarryForwardNonconvergencePrior(repository, runDir, run, slice) {
  const continuation = run.continuation;
  if (!continuation || continuation.review?.subject !== slice.id || slice.attempts !== 1) return null;
  if (continuation.review?.kind === "slice" && continuation.review.source === `run.slices.${slice.id}.review_ref`) {
    return observeContinuationSliceReviewPrior(repository, continuation, slice);
  }
  if (continuation.schema_version !== 2
    || continuation.review?.source !== "run.terminal_result.nonconvergence.source_review.review_ref") return null;
  const parentFile = resolve(repository, continuation.parent.run_ref);
  assertNoSymlinkPath(repository, parentFile, "carry-forward parent run.json");
  if (hashFile(parentFile) !== continuation.parent.run_hash) throw new Error("carry-forward parent run.json hash is stale");
  const parentRun = validateRun(JSON.parse(readFileSync(parentFile, "utf8")));
  const terminal = parentRun.terminal_result?.nonconvergence;
  const source = terminal?.source_review;
  const parentSlice = (parentRun.slices || []).find((candidate) => candidate?.id === slice.id);
  if (parentRun.status !== "blocked" || parentRun.terminal_result?.reason !== "slice-review-nonconvergent"
    || terminal?.slice_id !== slice.id || !parentSlice || !source
    || source.attempt !== parentSlice.attempts || !sameJson(source, parentSlice.attempt_reviews?.at(-1))
    || source.review_ref !== continuation.review.ref || source.review_hash !== continuation.review.hash) {
    throw new Error("carry-forward builder dispatch requires the exact terminal nonconvergence source");
  }
  const parentDir = dirname(parentFile);
  assertSliceAttemptHistoryCurrent(parentDir, parentSlice.id, parentSlice);
  const evidenceBinding = continuation.parent_evidence?.find((item) => item?.ref === source.evidence_ref);
  const reviewBinding = continuation.parent_reviews?.find((item) => item?.ref === source.review_ref);
  if (evidenceBinding?.hash !== source.evidence_hash || reviewBinding?.hash !== source.review_hash) {
    throw new Error("carry-forward builder dispatch source sidecars are not bound by continuation authority");
  }
  const evidence = resolveEvidenceRef(parentDir, source.evidence_ref);
  const review = resolveReviewRef(parentDir, source.review_ref);
  const evidenceBytes = readRegularNonEmptyFile(evidence.path, "carry-forward builder prior evidence");
  const reviewBytes = readRegularNonEmptyFile(review.path, "carry-forward builder prior review");
  if (sha256Bytes(evidenceBytes) !== source.evidence_hash || sha256Bytes(reviewBytes) !== source.review_hash) {
    throw new Error("carry-forward builder dispatch source sidecar bytes are stale");
  }
  const reviewValue = JSON.parse(reviewBytes.toString("utf8"));
  if (validateSliceReviewResult(reviewValue, { sliceId: slice.id }).task_context !== "fresh") {
    throw new Error("carry-forward nonconvergence must select fresh builder context");
  }
  return {
    origin: { kind: "carry-forward-nonconvergence", parent_run_id: parentRun.run_id },
    binding: cloneJson(source),
    evidence: { encoding: "base64", bytes: evidenceBytes.toString("base64") },
    review: { encoding: "base64", bytes: reviewBytes.toString("base64") },
  };
}

function observeContinuationSliceReviewPrior(repository, continuation, slice) {
  const parentFile = resolve(repository, continuation.parent.run_ref);
  assertNoSymlinkPath(repository, parentFile, "continuation slice-review parent run.json");
  if (hashFile(parentFile) !== continuation.parent.run_hash) throw new Error("continuation slice-review parent run.json hash is stale");
  const parentRun = validateRun(JSON.parse(readFileSync(parentFile, "utf8")));
  const parentSlice = (parentRun.slices || []).find((candidate) => candidate?.id === slice.id);
  const source = parentSlice?.attempt_reviews?.find((entry) => entry?.attempt === parentSlice.attempts);
  if (parentRun.status !== "blocked" || !parentSlice || parentSlice.review_ref !== continuation.review.ref || !source
    || source.review_ref !== continuation.review.ref || source.review_hash !== continuation.review.hash || source.verdict !== "REJECT") {
    throw new Error("continuation builder dispatch requires the exact selected parent slice REJECT");
  }
  const parentDir = dirname(parentFile);
  assertSliceAttemptHistoryCurrent(parentDir, parentSlice.id, parentSlice);
  const evidenceBinding = continuation.parent_evidence?.find((item) => item?.ref === source.evidence_ref);
  const reviewBinding = continuation.parent_reviews?.find((item) => item?.ref === source.review_ref);
  if (evidenceBinding?.hash !== source.evidence_hash || reviewBinding?.hash !== source.review_hash) {
    throw new Error("continuation selected slice sidecars are not bound by parent context");
  }
  const evidenceBytes = readRegularNonEmptyFile(resolveEvidenceRef(parentDir, source.evidence_ref).path, "continuation selected slice evidence");
  const reviewBytes = readRegularNonEmptyFile(resolveReviewRef(parentDir, source.review_ref).path, "continuation selected slice review");
  if (sha256Bytes(evidenceBytes) !== source.evidence_hash || sha256Bytes(reviewBytes) !== source.review_hash) {
    throw new Error("continuation selected slice sidecar bytes are stale");
  }
  return {
    origin: { kind: "continuation-slice-review", parent_run_id: parentRun.run_id },
    binding: cloneJson(source),
    evidence: { encoding: "base64", bytes: evidenceBytes.toString("base64") },
    review: { encoding: "base64", bytes: reviewBytes.toString("base64") },
  };
}

export async function completeSliceBuilderTaskDispatch(repoInput, request, options = {}) {
  if (!isRecord(request) || !stringValue(request.run_id) || !stringValue(request.slice_id)
    || !Number.isInteger(request.attempt) || !SLICE_BUILDER_AGENTS.has(request.agent)
    || !stringValue(request.claim_ref) || !stringValue(request.claim_hash) || !stringValue(request.completion_token)) {
    throw new Error("slice builder Task completion requires exact run, slice, attempt, agent, claim binding, and completion token");
  }
  const repository = repoRoot(repoInput);
  const factoryRoot = directFactoryRoot(repository);
  const runDir = resolve(factoryRoot, request.run_id);
  if (dirname(runDir) !== factoryRoot) throw new Error("slice builder Task completion run_id must identify one direct factory run");
  return withRunJsonLock(runDir, async () => {
    const run = await readRunJson(runDir);
    const v2Authority = assertV2LocalPublishedAuthority(runDir, run, { ...options, repoRoot: repository });
    if (run.status !== "running" || run.run_id !== request.run_id) throw new Error("slice builder Task completion requires the exact running run");
    const slice = (run.slices || []).find((candidate) => candidate?.id === request.slice_id);
    if (!slice || slice.status !== "running" || slice.attempts !== request.attempt || `${slice.stack}-builder` !== request.agent) {
      throw new Error("slice builder Task completion requires the exact current running slice attempt");
    }
    const observed = observeSliceDispatchClaim(runDir, run.run_id, slice, request.attempt, { requireRunBinding: true });
    if (!observed || observed.ref !== request.claim_ref || observed.hash !== request.claim_hash) throw new Error("slice builder Task completion claim binding is stale");
    if (sha256Bytes(Buffer.from(request.completion_token, "utf8")) !== observed.claim.completion_token_hash) throw new Error("slice builder Task completion capability is invalid");
    const branch = git(repository, ["rev-parse", "--verify", `refs/heads/${slice.branch}^{commit}`]);
    const completionHead = branch.ok ? branch.stdout.trim() : "";
    const worktree = resolve(repository, slice.worktree);
    const identity = checkWorktreeIdentity(repository, worktree, { branch: slice.branch, head: completionHead });
    const cleanliness = git(worktree, gitCleanlinessArgs());
    if (!/^[0-9a-f]{40}$/u.test(completionHead) || !identity.ok || !cleanliness.ok || cleanliness.stdout !== "") {
      throw new Error("slice builder Task completion requires the exact clean current slice branch/worktree HEAD");
    }
    if (!git(repository, ["merge-base", "--is-ancestor", observed.claim.head, completionHead]).ok) {
      throw new Error("slice builder Task completion HEAD must descend from the dispatch claim HEAD");
    }
    const closure = {
      schema_version: 1,
      kind: "checked-slice-builder-dispatch-closure",
      claim_ref: observed.ref,
      claim_hash: observed.hash,
      run_id: observed.claim.run_id,
      slice_id: observed.claim.slice_id,
      attempt: observed.claim.attempt,
      agent: observed.claim.agent,
      branch: observed.claim.branch,
      worktree: observed.claim.worktree,
      head: observed.claim.head,
      completion_head: completionHead,
      context_hash: observed.claim.context_hash,
      completion_token: request.completion_token,
      returned_at: timestamp(options.now),
    };
    const publication = await publishDispatchRecord(runDir, observed.claim.closure_ref, closure, {
      hooks: options.sliceDispatchClosureAtomicWriteHooks,
      allowExisting: true,
    });
    if (!publication.created) {
      const existing = observeClosedSliceDispatch(runDir, observed);
      if (!existing || existing.claim_ref !== observed.ref || existing.claim_hash !== observed.hash) throw new Error("slice builder Task completion conflicts with an existing closure");
    }
    const closed = observeClosedSliceDispatch(runDir, observed);
    if (closed.completion_kind !== "callback") throw new Error("slice builder Task completion was already resolved by candidate adoption");
    if (closed.completion_head !== completionHead) throw new Error("slice builder Task completion conflicts with a closure for another HEAD");
    const next = cloneJson(run);
    const nextSlice = next.slices.find((candidate) => candidate?.id === slice.id);
    nextSlice.dispatch_closure_ref = closed.closure_ref;
    nextSlice.dispatch_closure_hash = closed.closure_hash;
    next.updated_at = timestamp(options.now);
    const assertClosureAuthority = () => {
      const currentRun = validateRun(JSON.parse(readFileSync(join(runDir, RUN_FILE), "utf8")));
      if (!sameJson(currentRun, run)) throw new Error("slice builder Task completion run authority changed before closure binding");
      const currentClaim = observeSliceDispatchClaim(runDir, run.run_id, slice, slice.attempts, { requireRunBinding: true });
      if (!currentClaim) throw new Error("slice builder Task completion claim disappeared before closure binding");
      const currentClosed = observeClosedSliceDispatch(runDir, currentClaim);
      if (!sameJson(currentClosed, closed)) throw new Error("slice builder Task completion closure changed before run binding");
      const currentBranch = git(repository, ["rev-parse", "--verify", `refs/heads/${slice.branch}^{commit}`]);
      const currentHead = currentBranch.ok ? currentBranch.stdout.trim() : "";
      const currentIdentity = checkWorktreeIdentity(repository, worktree, { branch: slice.branch, head: completionHead });
      const currentCleanliness = git(worktree, gitCleanlinessArgs());
      if (currentHead !== completionHead || !currentIdentity.ok || !currentCleanliness.ok || currentCleanliness.stdout !== "") {
        throw new Error("slice builder Task completion Git authority changed before closure binding");
      }
    };
    try {
      assertClosureAuthority();
      await writeSemanticRunJson(runDir, validateRun(next), options, v2Authority, assertClosureAuthority);
    } catch (error) {
      await removeOwnedFailedDispatchPublication(runDir, observed.claim.closure_ref, publication, (current) => {
        const currentSlice = current.slices?.find((candidate) => candidate?.id === slice.id);
        return currentSlice?.dispatch_closure_ref === closed.closure_ref && currentSlice?.dispatch_closure_hash === closed.closure_hash;
      });
      throw error;
    }
    return observeClosedSliceDispatchIfClaimed(runDir, run.run_id, nextSlice, { required: true });
  }, options);
}

export async function revalidateSliceBuilderTaskDispatchContext(repoInput, context, options = {}) {
  if (!isRecord(context) || context.schema_version !== 1 || context.kind !== "checked-slice-builder-task-dispatch"
    || !isRecord(context.run) || !stringValue(context.run.id) || !isRecord(context.slice)
    || !stringValue(context.slice.id) || !Number.isInteger(context.slice.attempt) || !isRecord(context.dispatch_claim)) {
    throw new Error("slice builder compaction continuation requires exact checked dispatch context");
  }
  const repository = repoRoot(repoInput);
  const factoryRoot = directFactoryRoot(repository);
  const runDir = resolve(factoryRoot, context.run.id);
  if (dirname(runDir) !== factoryRoot) throw new Error("slice builder compaction continuation run_id must identify one direct factory run");
  return withRunJsonLock(runDir, async () => {
    const run = await readRunJson(runDir);
    if (run.status !== "running" || run.run_id !== context.run.id) throw new Error("slice builder compaction continuation requires the exact running run");
    const slice = (run.slices || []).find((candidate) => candidate?.id === context.slice.id);
    if (!slice || slice.status !== "running" || slice.attempts !== context.slice.attempt
      || slice.stack !== context.slice.stack || slice.branch !== context.slice.branch || slice.worktree !== context.slice.worktree) {
      throw new Error("slice builder compaction continuation requires the exact current running slice attempt");
    }
    const observed = observeSliceDispatchClaim(runDir, run.run_id, slice, slice.attempts, { requireRunBinding: true });
    if (!observed || context.dispatch_claim.ref !== observed.ref || context.dispatch_claim.hash !== observed.hash
      || context.dispatch_claim.closure_ref !== observed.claim.closure_ref || context.dispatch_claim.head !== observed.claim.head) {
      throw new Error("slice builder compaction continuation claim binding is stale");
    }
    if (existsSync(resolve(runDir, observed.claim.closure_ref))) throw new Error("slice builder compaction continuation is already completed");
    const originalContext = cloneJson(context);
    delete originalContext.dispatch_claim;
    if (hashValue(originalContext) !== observed.claim.context_hash) throw new Error("slice builder compaction continuation context hash is stale");

    const branch = git(repository, ["rev-parse", "--verify", `refs/heads/${slice.branch}^{commit}`]);
    const head = branch.ok ? branch.stdout.trim() : "";
    const worktree = resolve(repository, slice.worktree);
    const identity = checkWorktreeIdentity(repository, worktree, { branch: slice.branch, head });
    if (!/^[0-9a-f]{40}$/u.test(head) || !identity.ok
      || !git(repository, ["merge-base", "--is-ancestor", observed.claim.head, head]).ok) {
      throw new Error("slice builder compaction continuation Git authority is stale");
    }
    const decomposition = observeAcceptedDecompositionAuthority(runDir, run, { requireIntegrationGate: true });
    if (decomposition.plan_hash !== context.plan?.hash || decomposition.review_ref !== context.plan?.review_ref
      || decomposition.review_hash !== context.plan?.review_hash) {
      throw new Error("slice builder compaction continuation plan authority is stale");
    }
    for (const input of context.authorized_inputs || []) {
      if (hashFile(resolveArtifactRef(runDir, input.ref).path) !== input.hash
        || hashFile(resolveReviewRef(runDir, input.review_ref).path) !== input.review_hash) {
        throw new Error(`slice builder compaction continuation input '${input.ref}' is stale`);
      }
    }
    assertSliceAttemptHistoryCurrent(runDir, slice.id, slice);
    assertV2LocalPublishedAuthority(runDir, run, { ...options, repoRoot: repository });
    return cloneJson(context);
  }, options);
}

export async function adoptSliceBuilderTaskDispatchCandidate(repoInput, request, options = {}) {
  if (!isRecord(request)) throw new Error("slice builder dispatch adoption request must be an object");
  const allowed = new Set(["run_id", "slice_id", "attempt"]);
  const extra = Object.keys(request).filter((key) => !allowed.has(key));
  if (extra.length || !stringValue(request.run_id) || !SAFE_TASK_DISPATCH_ID_PATTERN.test(request.run_id)
    || request.run_id.includes("..") || request.run_id.endsWith(".lock") || !stringValue(request.slice_id)
    || !Number.isInteger(request.attempt) || request.attempt < 1 || request.attempt > 3) {
    throw new Error("slice builder dispatch adoption requires exact run, slice, and attempt");
  }
  const repository = repoRoot(repoInput);
  const factoryRoot = directFactoryRoot(repository);
  const runDir = resolve(factoryRoot, request.run_id);
  if (dirname(runDir) !== factoryRoot) throw new Error("slice builder dispatch adoption run_id must identify one direct factory run");
  return withRunJsonLock(runDir, async () => {
    const run = await readRunJson(runDir);
    const v2Authority = assertV2LocalPublishedAuthority(runDir, run, { ...options, repoRoot: repository });
    if (run.status !== "running" || run.run_id !== request.run_id) throw new Error("slice builder dispatch adoption requires the exact running run");
    const slice = (run.slices || []).find((candidate) => candidate?.id === request.slice_id);
    if (!slice || slice.status !== "running" || slice.attempts !== request.attempt) {
      throw new Error("slice builder dispatch adoption requires the exact current running slice attempt");
    }
    const observed = observeSliceDispatchClaim(runDir, run.run_id, slice, slice.attempts, { requireRunBinding: true });
    if (!observed) throw new Error("slice builder dispatch adoption requires the exact bound claim");
    const completionPath = resolve(runDir, observed.claim.closure_ref);
    if (existsSync(completionPath)) {
      const existing = observeClosedSliceDispatch(runDir, observed);
      if (existing.completion_kind !== "candidate-adoption") {
        throw new Error("slice builder dispatch adoption refuses an already completed callback closure");
      }
      const bound = slice.dispatch_closure_ref === existing.closure_ref && slice.dispatch_closure_hash === existing.closure_hash;
      if (bound) return { updated: false, status: run.status, adoption: existing, run };
      if (slice.dispatch_closure_ref !== undefined || slice.dispatch_closure_hash !== undefined) {
        throw new Error("slice builder dispatch adoption completion binding is stale");
      }
    }

    const branch = git(repository, ["rev-parse", "--verify", `refs/heads/${slice.branch}^{commit}`]);
    const completionHead = branch.ok ? branch.stdout.trim() : "";
    const worktree = resolve(repository, slice.worktree);
    const identity = checkWorktreeIdentity(repository, worktree, { branch: slice.branch, head: completionHead });
    const cleanliness = git(worktree, gitCleanlinessArgs());
    if (!/^[0-9a-f]{40}$/u.test(completionHead) || completionHead === observed.claim.head || !identity.ok
      || !cleanliness.ok || cleanliness.stdout !== "") {
      throw new Error("slice builder dispatch adoption requires a new clean current slice branch/worktree HEAD");
    }
    if (!git(repository, ["merge-base", "--is-ancestor", observed.claim.head, completionHead]).ok) {
      throw new Error("slice builder dispatch adoption HEAD must descend from the dispatch claim HEAD");
    }
    const adoption = {
      schema_version: 1,
      kind: "checked-slice-builder-dispatch-adoption",
      claim_ref: observed.ref,
      claim_hash: observed.hash,
      run_id: observed.claim.run_id,
      slice_id: observed.claim.slice_id,
      attempt: observed.claim.attempt,
      agent: observed.claim.agent,
      branch: observed.claim.branch,
      worktree: observed.claim.worktree,
      head: observed.claim.head,
      completion_head: completionHead,
      context_hash: observed.claim.context_hash,
      adopted_at: timestamp(options.now),
    };
    const publication = await publishDispatchRecord(runDir, observed.claim.closure_ref, adoption, {
      hooks: options.sliceDispatchAdoptionAtomicWriteHooks,
      allowExisting: true,
    });
    const closed = observeClosedSliceDispatch(runDir, observed);
    if (closed.completion_kind === "callback") {
      throw new Error("slice builder dispatch adoption refuses an already completed callback closure");
    }
    if (closed.completion_head !== completionHead) {
      throw new Error("slice builder dispatch adoption publication is stale");
    }
    const next = cloneJson(run);
    const nextSlice = next.slices.find((candidate) => candidate?.id === slice.id);
    nextSlice.dispatch_closure_ref = closed.closure_ref;
    nextSlice.dispatch_closure_hash = closed.closure_hash;
    next.updated_at = timestamp(options.now);
    const assertAdoptionAuthority = () => {
      const currentRun = validateRun(JSON.parse(readFileSync(join(runDir, RUN_FILE), "utf8")));
      if (!sameJson(currentRun, run)) throw new Error("slice builder dispatch adoption run authority changed before binding");
      const currentClaim = observeSliceDispatchClaim(runDir, run.run_id, slice, slice.attempts, { requireRunBinding: true });
      const currentClosed = observeClosedSliceDispatch(runDir, currentClaim);
      const currentBranch = git(repository, ["rev-parse", "--verify", `refs/heads/${slice.branch}^{commit}`]);
      const currentIdentity = checkWorktreeIdentity(repository, worktree, { branch: slice.branch, head: completionHead });
      const currentCleanliness = git(worktree, gitCleanlinessArgs());
      if (!sameJson(currentClosed, closed) || currentBranch.stdout.trim() !== completionHead || !currentIdentity.ok
        || !currentCleanliness.ok || currentCleanliness.stdout !== "") {
        throw new Error("slice builder dispatch adoption authority changed before binding");
      }
    };
    try {
      assertAdoptionAuthority();
      await writeSemanticRunJson(runDir, validateRun(next), options, v2Authority, assertAdoptionAuthority);
    } catch (error) {
      await removeOwnedFailedDispatchPublication(runDir, observed.claim.closure_ref, publication, (current) => {
        const currentSlice = current.slices?.find((candidate) => candidate?.id === slice.id);
        return currentSlice?.dispatch_closure_ref === closed.closure_ref && currentSlice?.dispatch_closure_hash === closed.closure_hash;
      });
      throw error;
    }
    return { updated: true, status: next.status, adoption: closed, run: next };
  }, options);
}

async function publishDispatchRecord(runDir, ref, value, options = {}) {
  const externalHooks = isRecord(options.hooks) ? options.hooks : {};
  const externalBeforeCommit = externalHooks.beforeCommit;
  try {
    await writeProtectedJsonAtomic(runDir, ref, value, {
      commit: "create-only",
      hooks: {
        ...externalHooks,
        beforeCommit: async () => {
          if (typeof externalBeforeCommit === "function") await externalBeforeCommit();
          if (typeof options.beforeCommit === "function") await options.beforeCommit();
        },
      },
    });
  } catch (error) {
    if (/checkpoint child (?:mutation|reservation|local authority)/u.test(error?.cause?.message || "")) throw error.cause;
    if (error?.code !== "TARGET_EXISTS") throw error;
    if (!options.allowExisting) throw new Error(options.existsMessage || "dispatch publication already exists");
    return { created: false, ref };
  }
  const path = resolve(runDir, ref);
  const identity = await lstat(path);
  if (identity.isSymbolicLink() || !identity.isFile()) throw new Error("dispatch publication target is not a regular file");
  return { created: true, ref, path, dev: identity.dev, ino: identity.ino, hash: hashFile(path) };
}

async function removeOwnedFailedDispatchPublication(runDir, ref, publication, isBound) {
  if (!publication?.created) return;
  let current = null;
  try {
    current = await readRunJson(runDir);
  } catch {
    // The run may be the failed authority source; filesystem ownership below
    // remains sufficient to remove only this operation's unbound publication.
  }
  if (current && typeof isBound === "function" && isBound(current)) return;
  const path = resolve(runDir, ref);
  let identity;
  try {
    identity = await lstat(path);
  } catch {
    return;
  }
  if (identity.isSymbolicLink() || !identity.isFile() || identity.dev !== publication.dev || identity.ino !== publication.ino
    || hashFile(path) !== publication.hash) return;
  await rm(path, { force: true });
}

async function observeCreatedDirectory(path) {
  const identity = await lstat(path);
  if (identity.isSymbolicLink() || !identity.isDirectory()) throw new Error("created sidecar directory is not a regular directory");
  return { path, dev: identity.dev, ino: identity.ino };
}

async function removeOwnedEmptyDirectory(owned) {
  if (!owned) return;
  let identity;
  try {
    identity = await lstat(owned.path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (identity.isSymbolicLink() || !identity.isDirectory() || identity.dev !== owned.dev || identity.ino !== owned.ino) return;
  try {
    await rmdir(owned.path);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
  }
}

function publicationBeforeCommitHooks(value) {
  if (!isRecord(value)) return undefined;
  const { afterCommit: _afterCommit, ...hooks } = value;
  return hooks;
}

function assertSteeringMutationAuthority(runDir, expectedRun, options, v2Authority) {
  const current = validateRun(JSON.parse(readFileSync(join(runDir, RUN_FILE), "utf8")));
  if (!sameJson(current, expectedRun)) throw new Error("steering run authority changed during sidecar mutation");
  if (v2Authority) assertV2LocalPublishedAuthority(runDir, current, options, v2Authority);
}

async function renameOwnedSteeringSidecar(sourcePath, destinationPath, expectedHash) {
  if (existsSync(destinationPath)) throw new Error("consumed steering destination already exists");
  const source = await lstat(sourcePath);
  if (source.isSymbolicLink() || !source.isFile() || hashFile(sourcePath, { mode: "raw" }) !== expectedHash) {
    throw new Error("pending steering source changed before rename");
  }
  const moved = { sourcePath, destinationPath, dev: source.dev, ino: source.ino, hash: expectedHash };
  await rename(sourcePath, destinationPath);
  return moved;
}

function assertOwnedSteeringSidecarMove(moved) {
  if (existsSync(moved.sourcePath)) throw new Error("pending steering source reappeared during rename");
  const destination = lstatSync(moved.destinationPath);
  if (destination.isSymbolicLink() || !destination.isFile() || destination.dev !== moved.dev || destination.ino !== moved.ino
    || hashFile(moved.destinationPath, { mode: "raw" }) !== moved.hash) {
    throw new Error("consumed steering destination changed during rename");
  }
}

async function restoreOwnedSteeringSidecarMove(moved) {
  if (existsSync(moved.sourcePath)) {
    const source = lstatSync(moved.sourcePath);
    if (!source.isSymbolicLink() && source.isFile() && source.dev === moved.dev && source.ino === moved.ino
      && hashFile(moved.sourcePath, { mode: "raw" }) === moved.hash && !existsSync(moved.destinationPath)) return;
    throw new Error("steering rollback refused to replace a successor pending sidecar");
  }
  const destination = lstatSync(moved.destinationPath);
  if (destination.isSymbolicLink() || !destination.isFile() || destination.dev !== moved.dev || destination.ino !== moved.ino
    || hashFile(moved.destinationPath, { mode: "raw" }) !== moved.hash) {
    throw new Error("steering rollback refused to move a successor consumed sidecar");
  }
  await rename(moved.destinationPath, moved.sourcePath);
  const restored = lstatSync(moved.sourcePath);
  if (restored.dev !== moved.dev || restored.ino !== moved.ino || hashFile(moved.sourcePath, { mode: "raw" }) !== moved.hash) {
    throw new Error("steering rollback could not verify the restored pending sidecar");
  }
}

function assertSliceBuilderTaskDispatchContextCurrent(repository, runDir, expectedRun, expectedContext, options = {}) {
  const currentRun = validateRun(JSON.parse(readFileSync(join(runDir, RUN_FILE), "utf8")));
  if (!sameJson(currentRun, expectedRun)) throw new Error("slice builder Task dispatch run authority changed before claim publication");
  const slice = (currentRun.slices || []).find((candidate) => candidate?.id === expectedContext.slice.id);
  if (!slice || slice.status !== "running" || slice.attempts !== expectedContext.slice.attempt || slice.branch !== expectedContext.slice.branch
    || slice.worktree !== expectedContext.slice.worktree || slice.stack !== expectedContext.slice.stack
    || (slice.authorized_baseline_commit || null) !== expectedContext.slice.authorized_baseline_commit) {
    throw new Error("slice builder Task dispatch slice authority changed before claim publication");
  }
  const branch = git(repository, ["rev-parse", "--verify", `refs/heads/${slice.branch}^{commit}`]);
  const head = branch.ok ? branch.stdout.trim() : "";
  const worktree = resolve(repository, slice.worktree);
  const identity = checkWorktreeIdentity(repository, worktree, { branch: slice.branch, head: expectedContext.slice.head });
  const cleanliness = git(worktree, gitCleanlinessArgs());
  if (head !== expectedContext.slice.head || !identity.ok || !cleanliness.ok || cleanliness.stdout !== "") {
    throw new Error("slice builder Task dispatch Git authority changed before claim publication");
  }
  assertSliceDispatchBaseline(currentRun, slice, head);

  const decomposition = observeAcceptedDecompositionAuthority(runDir, currentRun, { requireIntegrationGate: true });
  if (decomposition.plan_hash !== expectedContext.plan.hash || decomposition.review_ref !== expectedContext.plan.review_ref
    || decomposition.review_hash !== expectedContext.plan.review_hash) {
    throw new Error("slice builder Task dispatch plan authority changed before claim publication");
  }
  assertSliceAttemptHistoryCurrent(runDir, slice.id, slice);
  const history = Array.isArray(slice.attempt_reviews) ? slice.attempt_reviews : [];
  const previous = history.at(-1) || null;
  let prior = null;
  if (previous) {
    const observed = assertSliceReviewBindingCurrent(runDir, slice.id, {
      ...slice,
      attempts: previous.attempt,
      evidence_ref: previous.evidence_ref,
      evidence_hash: previous.evidence_hash,
      review_ref: previous.review_ref,
      review_hash: previous.review_hash,
      reviewed_commit: previous.reviewed_commit,
    });
    validateSliceReviewFeasibility(observed.review, decomposition.plan, { sliceId: slice.id });
    assertReviewedSliceRetryRoute(observed.review, slice.id, currentRun);
    prior = {
      binding: cloneJson(previous),
      evidence: { encoding: "base64", bytes: observed.evidence_bytes },
      review: { encoding: "base64", bytes: observed.review_bytes },
    };
  } else {
    prior = observeCarryForwardNonconvergencePrior(repository, runDir, currentRun, slice);
  }
  if (!sameJson(prior, expectedContext.prior)) throw new Error("slice builder Task dispatch prior authority changed before claim publication");
  for (const input of expectedContext.authorized_inputs) {
    if (hashFile(resolveArtifactRef(runDir, input.ref).path) !== input.hash
      || hashFile(resolveReviewRef(runDir, input.review_ref).path) !== input.review_hash) {
      throw new Error(`slice builder Task dispatch input '${input.ref}' changed before claim publication`);
    }
  }
  assertV2LocalPublishedAuthority(runDir, currentRun, { ...options, repoRoot: repository });
}

function sliceDispatchClaimName(runId, sliceId, attempt) {
  return `${createHash("sha256").update(`${runId}\0${sliceId}\0${attempt}`, "utf8").digest("hex")}.json`;
}

function assertReviewedSliceRetryRoute(review, sliceId, run) {
  const rerouted = review.remediation_context.fixes.filter((fix) => ["sibling-owned", "contract-change"].includes(fix.scope_effect));
  if (rerouted.length === 0) return;
  const routes = rerouted.map((fix) => `${fix.required_fix_index}:${fix.scope_effect}:${fix.fix_owner}`).join(", ");
  const first = rerouted[0];
  if (first.scope_effect === "contract-change") {
    throw new Error(`slice '${sliceId}' retry cannot consume another attempt; contract-change requires plan/brief amendment (${routes})`);
  }
  const owner = (run?.slices || []).find((slice) => slice?.id === first.fix_owner);
  const consumer = (run?.slices || []).find((slice) => slice?.id === sliceId);
  if (owner && ["pending", "running", "review"].includes(owner.status)) {
    throw new Error(`slice '${sliceId}' retry cannot consume another attempt; sibling-owned work is assigned to active owner '${first.fix_owner}' before current-slice dispatch (${routes})`);
  }
  if (owner?.status === "merged" && consumer?.status !== "merged" && consumer?.depends_on?.includes(owner.id) && !run?.merged_slice_repair) {
    throw new Error(`slice '${sliceId}' retry cannot consume another attempt; sibling-owned work must use existing merged-slice-repair for owner '${first.fix_owner}' (${routes})`);
  }
  throw new Error(`slice '${sliceId}' retry cannot consume another attempt; sibling-owned route is ineligible and requires plan/brief amendment (${routes})`);
}

function assertPriorSliceDispatchesClosed(runDir, runId, slice, attempt, includeCurrent) {
  for (let priorAttempt = 1; priorAttempt < attempt; priorAttempt += 1) {
    const history = (slice.attempt_reviews || []).find((entry) => entry?.attempt === priorAttempt);
    const hasBinding = SLICE_DISPATCH_BINDING_KEYS.every((key) => history?.[key] !== undefined);
    const observed = observeSliceDispatchClaim(runDir, runId, hasBinding ? { ...slice, dispatch_required: true, ...pickBinding(history, SLICE_DISPATCH_BINDING_KEYS) } : slice, priorAttempt, { requireRunBinding: hasBinding });
    if (hasBinding && !observed) throw new Error(`slice builder Task dispatch attempt ${priorAttempt} claim disappeared`);
    if (observed && !hasBinding) {
      observeClosedSliceDispatch(runDir, observed);
      throw new Error(`slice builder Task dispatch attempt ${priorAttempt} is not retained in append-only history`);
    }
    if (observed) observeClosedSliceDispatch(runDir, observed, { slice: { ...slice, ...history }, requireRunBinding: true });
  }
  if (includeCurrent && observeSliceDispatchClaim(runDir, runId, slice, attempt)) {
    throw new Error("slice builder Task dispatch is already claimed for this exact run/slice/attempt");
  }
}

export function assertNoUnresolvedSliceDispatches(runDir, run) {
  const slices = Array.isArray(run?.slices) ? run.slices : [];
  const dispatchDir = join(runDir, "dispatch");
  const expectedNames = new Set();
  for (const slice of slices) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimName = sliceDispatchClaimName(run.run_id, slice.id, attempt);
      expectedNames.add(claimName);
      expectedNames.add(`${claimName.slice(0, -5)}.closed.json`);
    }
  }
  if (existsSync(dispatchDir)) {
    assertNoSymlinkPath(runDir, dispatchDir, "slice builder dispatch directory");
    const entry = lstatSync(dispatchDir);
    if (!entry.isDirectory()) throw new Error("unresolved checked slice builder Task dispatch: dispatch path is not a directory");
    const specialNames = new Set();
    for (const name of readdirSync(dispatchDir)) {
      if (name.endsWith(".special.json")) {
        specialNames.add(name);
        specialNames.add(`${name.slice(0, -5)}.closed.json`);
      } else if (name.endsWith(".amendment-review.json")) {
        specialNames.add(name);
        specialNames.add(`${name.slice(0, -5)}.closed.json`);
      }
    }
    for (const name of readdirSync(dispatchDir)) {
      if (!expectedNames.has(name) && !specialNames.has(name)) throw new Error(`unresolved checked slice builder Task dispatch: unknown sidecar '${name}'`);
    }
  }

  for (const slice of slices) {
    const currentAttempt = Number.isInteger(slice.attempts) ? slice.attempts : 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimName = sliceDispatchClaimName(run.run_id, slice.id, attempt);
      const claimPath = join(dispatchDir, claimName);
      const closurePath = join(dispatchDir, `${claimName.slice(0, -5)}.closed.json`);
      const hasClaim = existsSync(claimPath);
      const hasClosure = existsSync(closurePath);
      const historical = attempt === currentAttempt ? null : (slice.attempt_reviews || []).find((entry) => entry?.attempt === attempt);
      const binding = attempt === currentAttempt ? slice : historical;
      const hasBinding = SLICE_DISPATCH_BINDING_KEYS.every((key) => binding?.[key] !== undefined);
      if (hasClosure && !hasClaim) throw new Error(`unresolved checked slice builder Task dispatch: slice '${slice.id}' attempt ${attempt} closure has no claim`);
      if (!hasClaim) {
        if (hasBinding) throw new Error(`unresolved checked slice builder Task dispatch: slice '${slice.id}' attempt ${attempt} bound claim is missing`);
        continue;
      }
      if (attempt > currentAttempt) throw new Error(`unresolved checked slice builder Task dispatch: slice '${slice.id}' has a future attempt ${attempt} claim`);
      if (!hasBinding) throw new Error(`unresolved checked slice builder Task dispatch: slice '${slice.id}' attempt ${attempt} sidecars are not bound by run state`);
      const boundSlice = { ...slice, dispatch_required: true, ...pickBinding(binding, SLICE_DISPATCH_BINDING_KEYS) };
      const observed = observeSliceDispatchClaim(runDir, run.run_id, boundSlice, attempt, { requireRunBinding: true });
      let closed;
      try {
        closed = observeClosedSliceDispatch(runDir, observed, { slice: boundSlice, requireRunBinding: true });
      } catch (error) {
        throw new Error(`unresolved checked slice builder Task dispatch: slice '${slice.id}' attempt ${attempt} is not exactly closed`, { cause: error });
      }
      if (attempt === currentAttempt) {
        if (slice.dispatch_required !== true || slice.dispatch_claim_ref !== observed.ref || slice.dispatch_claim_hash !== observed.hash
          || slice.dispatch_closure_ref !== closed.closure_ref || slice.dispatch_closure_hash !== closed.closure_hash) {
          throw new Error(`unresolved checked slice builder Task dispatch: slice '${slice.id}' attempt ${attempt} sidecars are not bound by run state`);
        }
      }
    }
    const hasCurrentBinding = ["dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash"]
      .some((key) => slice[key] !== undefined);
    if (slice.dispatch_required === true || hasCurrentBinding) {
      const observed = observeClosedSliceDispatchIfClaimed(runDir, run.run_id, slice, { required: true });
      if (!observed) throw new Error(`unresolved checked slice builder Task dispatch: slice '${slice.id}' current binding has no sidecars`);
    }
  }
  assertNoPendingSpecialBuilderDispatches(runDir, run);
}

export function assertNoUnresolvedSpecialBuilderDispatches(runDir, run) {
  const dispatchDir = join(runDir, "dispatch");
  const binding = run.special_builder_dispatch;
  if (!existsSync(dispatchDir)) {
    if (binding) throw new Error("unresolved checked special builder Task dispatch: bound dispatch directory is missing");
    return;
  }
  assertNoSymlinkPath(runDir, dispatchDir, "special builder dispatch directory");
  if (binding) {
    let observed;
    try { observed = observeSpecialDispatchClaim(runDir, binding.claim_ref); }
    catch (error) { throw new Error("unresolved checked special builder Task dispatch: bound claim is missing or invalid", { cause: error }); }
    if (observed.hash !== binding.claim_hash || observed.claim.run_id !== run.run_id || observed.claim.route !== binding.route
      || observed.claim.instance !== binding.instance || observed.claim.agent !== binding.agent
      || (binding.route === "integration-conflict" && binding.owner_slice_id !== observed.claim.effective_owner?.slice_id)) {
      throw new Error("unresolved checked special builder Task dispatch: bound claim identity is stale");
    }
    if (!binding.closure_ref) throw new Error(`unresolved checked special builder Task dispatch: route '${binding.route}' instance '${binding.instance}' remains active or has an unknown outcome`);
    const closed = observeClosedSpecialDispatch(runDir, observed);
    if (closed.closure_ref !== binding.closure_ref || closed.closure_hash !== binding.closure_hash || closed.completion_head !== binding.completion_head) {
      throw new Error("unresolved checked special builder Task dispatch: bound closure identity is stale");
    }
  }
  const names = readdirSync(dispatchDir);
  const claims = names.filter((name) => name.endsWith(".special.json"));
  for (const name of names.filter((candidate) => candidate.endsWith(".special.closed.json"))) {
    const claimName = `${name.slice(0, -".closed.json".length)}.json`;
    if (!claims.includes(claimName)) throw new Error(`unresolved checked special builder Task dispatch: closure '${name}' has no claim`);
  }
  for (const name of claims) {
    const observed = observeSpecialDispatchClaim(runDir, `dispatch/${name}`);
    if (observed.claim.run_id !== run.run_id) throw new Error("unresolved checked special builder Task dispatch: run identity is stale");
    try {
      observeClosedSpecialDispatch(runDir, observed);
    } catch (error) {
      throw new Error(`unresolved checked special builder Task dispatch: route '${observed.claim.route}' instance '${observed.claim.instance}' is not exactly closed`, { cause: error });
    }
  }
}

export function assertNoPendingSpecialBuilderDispatches(runDir, run) {
  assertNoUnresolvedSpecialBuilderDispatches(runDir, run);
  if (run.special_builder_dispatch) {
    throw new Error(`checked special builder Task dispatch for route '${run.special_builder_dispatch.route}' is closed but awaits exact route consumption`);
  }
}

function consumeSpecialBuilderDispatch(runDir, current, draft, route, expectedHead) {
  const binding = current.special_builder_dispatch;
  if (!binding || binding.route !== route) throw new Error(`${route} requires the exact closed checked special builder Task dispatch`);
  const observed = observeSpecialDispatchClaim(runDir, binding.claim_ref);
  const closed = observeClosedSpecialDispatch(runDir, observed);
  if (observed.hash !== binding.claim_hash || binding.closure_ref !== closed.closure_ref || binding.closure_hash !== closed.closure_hash
    || binding.completion_head !== closed.completion_head || closed.completion_head !== expectedHead) {
    throw new Error(`${route} checked special builder Task dispatch binding is stale or targets another HEAD`);
  }
  delete draft.special_builder_dispatch;
}

function observeClosedSliceDispatchIfClaimed(runDir, runId, slice, options = {}) {
  if (!Number.isInteger(slice?.attempts) || slice.attempts < 1) return null;
  const claim = observeSliceDispatchClaim(runDir, runId, slice, slice.attempts, { requireRunBinding: true });
  if (!claim) {
    if (options.required === true) throw new Error("slice attempt requires exact closed checked Task dispatch authority");
    return null;
  }
  return observeClosedSliceDispatch(runDir, claim, { slice, requireRunBinding: true });
}

function observeSliceDispatchClaim(runDir, runId, slice, attempt, options = {}) {
  const ref = `dispatch/${sliceDispatchClaimName(runId, slice.id, attempt)}`;
  const path = resolve(runDir, ref);
  if (!existsSync(path)) return null;
  assertNoSymlinkPath(runDir, path, "slice builder dispatch claim");
  const bytes = readRegularNonEmptyFile(path, "slice builder dispatch claim");
  const claim = parseJsonObjectBytes(bytes, "slice builder dispatch claim");
  const closureRef = `dispatch/${sliceDispatchClaimName(runId, slice.id, attempt).slice(0, -5)}.closed.json`;
  if (claim.schema_version !== 1 || claim.kind !== "checked-slice-builder-dispatch-claim"
    || claim.run_id !== runId || claim.slice_id !== slice.id || claim.attempt !== attempt
    || claim.agent !== `${slice.stack}-builder` || claim.branch !== slice.branch || claim.worktree !== slice.worktree
    || !/^[0-9a-f]{40}$/u.test(claim.head || "") || !/^sha256:[0-9a-f]{64}$/u.test(claim.context_hash || "")
    || !/^sha256:[0-9a-f]{64}$/u.test(claim.completion_token_hash || "")
    || claim.closure_ref !== closureRef) throw new Error("slice builder dispatch claim identity is invalid");
  if (slice.authorized_baseline_commit !== undefined) {
    const expectedHead = attempt === 1
      ? slice.authorized_baseline_commit
      : slice.attempt_reviews?.find((entry) => entry?.attempt === attempt - 1)?.reviewed_commit;
    if (!/^[0-9a-f]{40}$/u.test(expectedHead || "") || claim.head !== expectedHead) {
      throw new Error("slice builder dispatch claim head differs from its authorized attempt baseline");
    }
  }
  const hash = sha256Bytes(bytes);
  if (options.requireRunBinding === true && (slice.dispatch_required !== true || slice.dispatch_claim_ref !== ref || slice.dispatch_claim_hash !== hash)) {
    throw new Error("slice builder dispatch claim is not bound by current run state");
  }
  return { ref, path, hash, claim };
}

function observeClosedSliceDispatch(runDir, observed, options = {}) {
  const closurePath = resolve(runDir, observed.claim.closure_ref);
  if (!existsSync(closurePath)) throw new Error("slice builder Task dispatch remains active or has an unknown outcome");
  assertNoSymlinkPath(runDir, closurePath, "slice builder dispatch closure");
  const bytes = readRegularNonEmptyFile(closurePath, "slice builder dispatch closure");
  const closure = parseJsonObjectBytes(bytes, "slice builder dispatch closure");
  for (const key of ["run_id", "slice_id", "attempt", "agent", "branch", "worktree", "head", "context_hash"]) {
    if (closure[key] !== observed.claim[key]) throw new Error("slice builder dispatch closure identity is invalid");
  }
  const commonKeys = ["schema_version", "kind", "claim_ref", "claim_hash", "run_id", "slice_id", "attempt", "agent", "branch", "worktree", "head", "completion_head", "context_hash"];
  const callbackKeys = new Set([...commonKeys, "completion_token", "returned_at"]);
  const adoptionKeys = new Set([...commonKeys, "adopted_at"]);
  const legacyReconciliationKeys = new Set([...commonKeys, "disposition", "authorized_at"]);
  const callback = closure.kind === "checked-slice-builder-dispatch-closure";
  const adoption = closure.kind === "checked-slice-builder-dispatch-adoption";
  const legacyReconciliation = closure.kind === "checked-slice-builder-dispatch-reconciliation";
  const expectedKeys = callback ? callbackKeys : adoption ? adoptionKeys : legacyReconciliationKeys;
  if (closure.schema_version !== 1 || ![callback, adoption, legacyReconciliation].some(Boolean)
    || !sameStringSet(new Set(Object.keys(closure)), expectedKeys)
    || closure.claim_ref !== observed.ref || closure.claim_hash !== observed.hash
    || !/^[0-9a-f]{40}$/u.test(closure.completion_head || "")
    || callback && (!stringValue(closure.completion_token) || sha256Bytes(Buffer.from(closure.completion_token, "utf8")) !== observed.claim.completion_token_hash
      || !Number.isFinite(Date.parse(closure.returned_at || "")))
    || adoption && !Number.isFinite(Date.parse(closure.adopted_at || ""))
    || legacyReconciliation && (closure.disposition !== "operator-authorized-callback-returned-without-closure"
      || !Number.isFinite(Date.parse(closure.authorized_at || "")))) {
    throw new Error("slice builder dispatch completion binding is invalid");
  }
  const result = {
    claim_ref: observed.ref,
    claim_hash: observed.hash,
    closure_ref: observed.claim.closure_ref,
    closure_hash: sha256Bytes(bytes),
    completion_head: closure.completion_head,
    completion_kind: callback ? "callback" : "candidate-adoption",
  };
  if (options.requireRunBinding === true && (options.slice?.dispatch_closure_ref !== result.closure_ref || options.slice?.dispatch_closure_hash !== result.closure_hash)) {
    throw new Error("slice builder dispatch closure is not bound by current run state");
  }
  return result;
}

function observeSpecialDispatchClaim(runDir, ref) {
  if (!/^dispatch\/[0-9a-f]{64}\.special\.json$/u.test(ref || "")) throw new Error("special builder dispatch claim ref is invalid");
  const path = resolve(runDir, ref);
  assertNoSymlinkPath(runDir, path, "special builder dispatch claim");
  const bytes = readRegularNonEmptyFile(path, "special builder dispatch claim");
  const claim = parseJsonObjectBytes(bytes, "special builder dispatch claim");
  const conflictKeys = claim.route === "integration-conflict"
    ? ["integration_baseline", "feature_head", "merge_head", "conflict_paths", "conflict_index_hash", "current_slice_id", "effective_owner"]
    : [];
  const expectedKeys = ["schema_version", "kind", "run_id", "route", "instance", "agent", "branch", "worktree", "head", "run_hash", "context_hash", "completion_token_hash", "claimed_at", "closure_ref", ...conflictKeys];
  if (!sameStringSet(new Set(Object.keys(claim)), new Set(expectedKeys))
    || claim.schema_version !== 1 || claim.kind !== "checked-special-builder-dispatch-claim"
    || !stringValue(claim.run_id) || !["merged-slice-repair", "integration-amendment", "panel-remediation", "post-pr-remediation", "integration-conflict"].includes(claim.route)
    || !stringValue(claim.instance) || !SLICE_BUILDER_AGENTS.has(claim.agent) || !stringValue(claim.branch) || !stringValue(claim.worktree)
    || !/^[0-9a-f]{40}$/u.test(claim.head || "") || !/^sha256:[0-9a-f]{64}$/u.test(claim.run_hash || "")
    || !/^sha256:[0-9a-f]{64}$/u.test(claim.context_hash || "") || !/^sha256:[0-9a-f]{64}$/u.test(claim.completion_token_hash || "")
    || !Number.isFinite(Date.parse(claim.claimed_at || "")) || claim.closure_ref !== `${ref.slice(0, -5)}.closed.json`
    || (claim.route === "integration-conflict" && !validIntegrationConflictClaim(claim))) {
    throw new Error("special builder dispatch claim identity is invalid");
  }
  return { ref, path, hash: sha256Bytes(bytes), claim };
}

function observeClosedSpecialDispatch(runDir, observed) {
  const path = resolve(runDir, observed.claim.closure_ref);
  if (!existsSync(path)) throw new Error("special builder Task dispatch remains active or has an unknown outcome");
  assertNoSymlinkPath(runDir, path, "special builder dispatch closure");
  const bytes = readRegularNonEmptyFile(path, "special builder dispatch closure");
  const closure = parseJsonObjectBytes(bytes, "special builder dispatch closure");
  const expectedKeys = ["schema_version", "kind", "claim_ref", "claim_hash", "run_id", "route", "instance", "agent", "branch", "worktree", "head", "completion_head", "run_hash", "context_hash", "completion_token", "returned_at", ...(["panel-remediation", "integration-conflict"].includes(observed.claim.route) ? ["owner_slice_id"] : []), ...(observed.claim.route === "integration-conflict" ? ["integration_proof"] : [])];
  for (const key of ["run_id", "route", "instance", "agent", "branch", "worktree", "head", "run_hash", "context_hash"]) {
    if (closure[key] !== observed.claim[key]) throw new Error("special builder dispatch closure identity is invalid");
  }
  if (!sameStringSet(new Set(Object.keys(closure)), new Set(expectedKeys))
    || closure.schema_version !== 1 || closure.kind !== "checked-special-builder-dispatch-closure"
    || closure.claim_ref !== observed.ref || closure.claim_hash !== observed.hash || !/^[0-9a-f]{40}$/u.test(closure.completion_head || "")
    || !stringValue(closure.completion_token) || sha256Bytes(Buffer.from(closure.completion_token, "utf8")) !== observed.claim.completion_token_hash
    || (["panel-remediation", "integration-conflict"].includes(observed.claim.route) && !stringValue(closure.owner_slice_id))
    || (observed.claim.route === "integration-conflict" && (closure.owner_slice_id !== observed.claim.effective_owner.slice_id || !validIntegrationConflictProof(closure.integration_proof, observed.claim, closure.completion_head)))
    || !Number.isFinite(Date.parse(closure.returned_at || ""))) throw new Error("special builder dispatch closure binding is invalid");
  return { claim_ref: observed.ref, claim_hash: observed.hash, closure_ref: observed.claim.closure_ref, closure_hash: sha256Bytes(bytes), completion_head: closure.completion_head, ...(closure.owner_slice_id ? { owner_slice_id: closure.owner_slice_id } : {}), ...(closure.integration_proof ? { integration_proof: cloneJson(closure.integration_proof) } : {}) };
}

function validIntegrationConflictClaim(claim) {
  if (claim.integration_baseline !== claim.head || claim.feature_head !== claim.head || !/^[0-9a-f]{40}$/u.test(claim.merge_head || "")
    || !/^sha256:[0-9a-f]{64}$/u.test(claim.conflict_index_hash || "") || !stringValue(claim.current_slice_id)
    || !Array.isArray(claim.conflict_paths) || claim.conflict_paths.length < 1 || !sameJson(claim.conflict_paths, [...claim.conflict_paths].sort())
    || new Set(claim.conflict_paths).size !== claim.conflict_paths.length || claim.conflict_paths.some((path) => !isCanonicalConcreteRepositoryPath(path))) return false;
  const owner = claim.effective_owner;
  return isRecord(owner) && sameStringSet(new Set(Object.keys(owner)), new Set(["slice_id", "stack", "kind"])) && stringValue(owner.slice_id)
    && ["backend", "frontend"].includes(owner.stack) && ["sole-owner", "current-slice-integration"].includes(owner.kind);
}

function validIntegrationConflictProof(proof, claim, completionHead) {
  if (!isRecord(proof) || !sameStringSet(new Set(Object.keys(proof)), new Set(["schema_version", "integration_baseline", "merge_head", "resolution_commit", "merge_base", "conflict_paths", "integrated_entries", "integrated_tree"]))) return false;
  if (proof.schema_version !== 1 || proof.integration_baseline !== claim.integration_baseline || proof.merge_head !== claim.merge_head
    || proof.resolution_commit !== completionHead || !/^[0-9a-f]{40}$/u.test(proof.merge_base || "") || !/^[0-9a-f]{40}$/u.test(proof.integrated_tree || "")
    || !sameJson(proof.conflict_paths, claim.conflict_paths) || !Array.isArray(proof.integrated_entries) || proof.integrated_entries.length !== claim.conflict_paths.length) return false;
  return proof.integrated_entries.every((entry, index) => isRecord(entry) && sameStringSet(new Set(Object.keys(entry)), new Set(["path", "entry_hash"]))
    && entry.path === claim.conflict_paths[index] && /^sha256:[0-9a-f]{64}$/u.test(entry.entry_hash || ""));
}

export function assertNoCurrentSliceNonconvergence(runDir, run) {
  for (const slice of run.slices || []) {
    const current = Array.isArray(slice?.attempt_reviews) ? slice.attempt_reviews.at(-1) : null;
    if (slice?.status !== "review" || current?.attempt !== slice.attempts || current.verdict !== "REJECT" || current.convergence !== "nonconvergent") continue;
    assertSliceReviewBindingCurrent(runDir, slice.id, slice);
    throw new Error(`slice '${slice.id}' current nonconvergent review must terminalize through the checked next-attempt transition`);
  }
}

export function assertSliceAttemptHistoryCurrent(runDir, sliceId, slice) {
  if (slice.authorized_baseline_commit !== undefined && slice.attempt_reviews?.[0]
    && slice.attempt_reviews[0].diff_base_commit !== slice.authorized_baseline_commit) {
    throw new Error(`slice '${sliceId}' first review baseline differs from its authorized baseline`);
  }
  const priorReviews = [];
  for (const entry of Array.isArray(slice.attempt_reviews) ? slice.attempt_reviews : []) {
    const observed = observeSliceReviewSidecars(runDir, sliceId, {
      ...slice,
      attempts: entry.attempt,
      evidence_ref: entry.evidence_ref,
      review_ref: entry.review_ref,
    });
    const result = observeAttemptReviewResult(sliceId, observed.review, { priorReviews });
    const dispatch = observeAttemptReviewDispatch(runDir, sliceId, slice, entry);
    const current = {
      attempt: entry.attempt,
      evidence_ref: entry.evidence_ref,
      evidence_hash: observed.binding.evidence_hash,
      review_ref: entry.review_ref,
      review_hash: observed.binding.review_hash,
      reviewed_commit: observed.review.reviewed_commit,
      diff_base_commit: entry.diff_base_commit,
      ratified_paths: result.ratified_paths,
      ...result,
      ...dispatch,
    };
    if (observed.evidence.head_sha !== current.reviewed_commit || !sameJson(current, entry)) {
      throw new Error(`slice '${sliceId}' attempt ${entry.attempt} review history is stale`);
    }
    priorReviews.push(current);
  }
}

function observeAttemptReviewDispatch(runDir, sliceId, slice, entry) {
  const present = SLICE_DISPATCH_BINDING_KEYS.filter((key) => entry?.[key] !== undefined);
  if (present.length === 0) return {};
  if (present.length !== SLICE_DISPATCH_BINDING_KEYS.length) throw new Error(`slice '${sliceId}' attempt ${entry.attempt} dispatch history is incomplete`);
  const run = validateRun(JSON.parse(readFileSync(join(runDir, RUN_FILE), "utf8")));
  const boundSlice = { ...slice, dispatch_required: true, ...pickBinding(entry, SLICE_DISPATCH_BINDING_KEYS) };
  const claim = observeSliceDispatchClaim(runDir, run.run_id, boundSlice, entry.attempt, { requireRunBinding: true });
  if (!claim) throw new Error(`slice '${sliceId}' attempt ${entry.attempt} dispatch claim is missing`);
  const closed = observeClosedSliceDispatch(runDir, claim, { slice: boundSlice, requireRunBinding: true });
  return {
    dispatch_claim_ref: claim.ref,
    dispatch_claim_hash: claim.hash,
    dispatch_closure_ref: closed.closure_ref,
    dispatch_closure_hash: closed.closure_hash,
  };
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

function observeSliceMergePathCoverage(repository, sliceId, mergeCommit, reviewedCommit, options = {}) {
  const parentsResult = authorityGit(options, repository, ["rev-list", "--parents", "-n", "1", mergeCommit]);
  const parents = parentsResult.ok ? parentsResult.stdout.trim().split(/\s+/u) : [];
  if (parents.length !== 3 || parents[0] !== mergeCommit || parents[2] !== reviewedCommit) {
    throw new Error(`slice '${sliceId}' merge path coverage requires exact ordered parents`);
  }
  const basesResult = authorityGit(options, repository, ["merge-base", "--all", parents[1], reviewedCommit]);
  const bases = basesResult.ok ? basesResult.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean) : [];
  if (bases.length !== 1 || !/^[0-9a-f]{40}$/u.test(bases[0])) throw new Error(`slice '${sliceId}' merge path coverage requires one full merge base`);
  const reviewedPaths = observeNoRenamePathSet(repository, bases[0], reviewedCommit, options, `slice '${sliceId}' ownership-reviewed diff`);
  const mergedPaths = observeNoRenamePathSet(repository, parents[1], mergeCommit, options, `slice '${sliceId}' integrated diff`);
  if (!sameStringSet(reviewedPaths, mergedPaths)) throw new Error(`slice '${sliceId}' integrated path set must equal its ownership-reviewed path set`);
  return { merge_base: bases[0], paths: [...reviewedPaths].sort() };
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
  assertSliceAttemptHistoryCurrent(runDir, prior.id, prior);
  for (const key of ["id", "stack", "depends_on", "declared_paths"]) {
    if (!sameJson(prior?.[key], next?.[key])) throw new Error(`slice ${key} is immutable`);
  }
  const checkedOwnershipReset = ["running", "blocked"].includes(next.status) && sameJson(next.effective_paths, next.declared_paths);
  if (!sameJson(prior.effective_paths, next.effective_paths) && !checkedOwnershipReset) {
    throw new Error(`slice '${prior.id}' effective_paths is managed by checked review publication`);
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
  if (prior.authorized_baseline_commit !== undefined && prior.authorized_baseline_commit !== next.authorized_baseline_commit) {
    throw new Error(`slice '${prior.id}' authorized_baseline_commit is immutable once bound`);
  }
  if (prior.authorized_baseline_commit === undefined && next.authorized_baseline_commit !== undefined) {
    throw new Error(`slice '${prior.id}' authorized_baseline_commit is managed by checked start admission`);
  }
  if (next.status === "running" || next.status === "review" || prior.status !== "pending") {
    if (!Number.isInteger(next.attempts) || next.attempts < 1) throw new Error(`slice '${prior.id}' attempts must be positive once running`);
  } else if (!Number.isInteger(next.attempts) || next.attempts < 0) {
    throw new Error(`slice '${prior.id}' attempts must be non-negative`);
  }
  const priorAttempts = Number.isInteger(prior.attempts) ? prior.attempts : 0;
  if (next.attempts < priorAttempts || next.attempts > priorAttempts + 1) throw new Error(`slice '${prior.id}' attempt must stay at ${priorAttempts} or advance exactly to ${priorAttempts + 1}`);
  if (next.attempts === priorAttempts + 1 && !["pending", "review"].includes(prior.status)) throw new Error(`slice '${prior.id}' attempt advancement requires pending start or a reviewed REJECT`);
  if (next.attempts > 3) throw new Error(`slice '${prior.id}' attempts must not exceed 3`);
  if (prior.status === "pending" && next.status === "running" && next.attempts !== 1) throw new Error(`slice '${prior.id}' first running transition must start at attempt 1`);
  if (next.status === "review" && next.attempts !== priorAttempts) throw new Error(`slice '${prior.id}' review requires the current running attempt ${priorAttempts}`);
  if (next.status === "blocked" && next.attempts !== priorAttempts) throw new Error(`slice '${prior.id}' blocked transition cannot change attempts`);
  if (!sameJson(prior.attempt_reviews || [], next.attempt_reviews || [])) throw new Error(`slice '${prior.id}' attempt review history is managed by checked review publication`);
  if (!sameJson(prior.integration_conflict, next.integration_conflict)) throw new Error(`slice '${prior.id}' integration_conflict is managed by checked delegated merge and test acceptance`);
  if (prior.dispatch_required === true && next.dispatch_required !== true) throw new Error(`slice '${prior.id}' dispatch_required is immutable once enabled`);
  const advancingAttempt = next.attempts === priorAttempts + 1;
  for (const key of SLICE_DISPATCH_BINDING_KEYS) {
    if (advancingAttempt) {
      const retained = prior.attempt_reviews?.find((entry) => entry?.attempt === priorAttempts);
      if (prior[key] !== undefined && retained?.[key] !== prior[key]) throw new Error(`slice '${prior.id}' prior ${key} must be retained in append-only history`);
      if (next[key] !== undefined) throw new Error(`slice '${prior.id}' next-attempt ${key} must start unbound`);
    } else {
      if (prior[key] !== undefined && next[key] !== prior[key]) throw new Error(`slice '${prior.id}' ${key} is managed by checked Task dispatch`);
      if (prior[key] === undefined && next[key] !== undefined) throw new Error(`slice '${prior.id}' ${key} is managed by checked Task dispatch`);
    }
  }
  if (prior.status === "review") {
    const currentReview = observeSliceReviewSidecars(runDir, prior.id, prior).review;
    const retry = next.status === "running" || next.status === "review" && !sameJson(prior, next);
    if (retry && currentReview.verdict !== "REJECT") throw new Error(`slice '${prior.id}' retry requires a REJECT review`);
    if (retry && next.attempts !== priorAttempts + 1) throw new Error(`slice '${prior.id}' retry after REJECT must advance exactly to attempt ${priorAttempts + 1}`);
  }
  if (next.status === "review") observeSliceReviewSidecars(runDir, next.id, next);
  if (next.status === "blocked") {
    requireNonEmptyString(next.blocked_reason, "blocked_reason");
    for (const key of ["evidence_ref", "review_ref"]) {
      if (prior[key] !== next[key]) throw new Error(`blocked slice cannot create or change retained ${key}`);
    }
  }
}

function appendSliceAttemptReview(slice, authority) {
  const history = Array.isArray(slice.attempt_reviews) ? slice.attempt_reviews : [];
  const existing = history.find((entry) => entry?.attempt === authority.history_entry.attempt);
  if (existing) {
    if (!sameJson(existing, authority.history_entry)) throw new Error(`slice '${slice.id}' attempt ${authority.history_entry.attempt} review history conflicts with checked authority`);
    return;
  }
  if (history.some((entry) => entry?.attempt >= authority.history_entry.attempt)) throw new Error(`slice '${slice.id}' attempt review history must be append-only`);
  slice.attempt_reviews = [...history, authority.history_entry];
}

function terminalizeSliceNonconvergence(run, slice, sliceIndex, options = {}) {
  const sourceReview = (Array.isArray(slice.attempt_reviews) ? slice.attempt_reviews : []).find((entry) => entry?.attempt === slice.attempts);
  if (!sourceReview || sourceReview.verdict !== "REJECT" || sourceReview.convergence !== "nonconvergent") {
    throw new Error(`slice '${slice.id}' nonconvergence terminalization requires its exact append-only review entry`);
  }
  const updatedAt = timestamp(options.now);
  const blocked = {
    ...slice,
    status: "blocked",
    blocked_reason: "slice-review-nonconvergent",
    updated_at: updatedAt,
  };
  for (const key of ["evidence_hash", "review_hash", "reviewed_commit", "merge_commit"]) delete blocked[key];
  run.slices[sliceIndex] = blocked;
  run.status = "blocked";
  run.updated_at = updatedAt;
  run.terminal_result = {
    status: "blocked",
    run_id: run.run_id,
    pr_url: null,
    reason: "slice-review-nonconvergent",
    summary: `Slice '${slice.id}' review marked attempt ${slice.attempts} nonconvergent; continue from the reviewed integration state.`,
    artifacts: {},
    nonconvergence: {
      schema_version: 1,
      kind: "slice-review-nonconvergence",
      slice_id: slice.id,
      source_review: cloneJson(sourceReview),
      continuation: {
        program: "feature-factory",
        args: ["factory", "continue", run.run_id, "--review", sourceReview.review_ref, "--run-id", "<new-run-id>", "--carry-forward", "--json"],
      },
    },
  };
}

function normalizeSliceTransition(prior, next) {
  if (next.status === "running") {
    next.effective_paths = cloneJson(next.declared_paths);
    delete next.evidence_ref;
    delete next.evidence_hash;
    delete next.review_ref;
    delete next.review_hash;
    delete next.reviewed_commit;
    delete next.merge_commit;
    if (next.attempts > prior.attempts) for (const key of SLICE_DISPATCH_BINDING_KEYS) delete next[key];
    delete next.blocked_reason;
    delete next.updated_at;
  } else if (next.status === "review") {
    delete next.merge_commit;
    delete next.blocked_reason;
    delete next.updated_at;
  } else if (next.status === "blocked") {
    next.effective_paths = cloneJson(next.declared_paths);
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
// Generic integration amendment state and the checked execution/Task authority
// observers used by the factory-owned B5.3 effects.
// ---------------------------------------------------------------------------

const INTEGRATION_AMENDMENT_ACTIONS = new Set(["report", "build", "review", "integrate", "verify", "merge", "block"]);
const INTEGRATION_AMENDMENT_DISPOSITIONS = Object.freeze(["accepted_contract", "public_contract", "persisted_contract", "product_scope", "security_boundary", "generated_ownership", "decomposition"]);
const INTEGRATION_AMENDMENT_REVIEW_AGENT = "work-reviewer";
const INTEGRATION_AMENDMENT_REVIEW_REPLAYABLE_ERROR = "INTEGRATION_AMENDMENT_REVIEW_REPLAYABLE_AMBIGUITY";

export function isReplayableIntegrationAmendmentReviewCompletionError(error) {
  return error?.code === INTEGRATION_AMENDMENT_REVIEW_REPLAYABLE_ERROR;
}

export async function prepareIntegrationAmendmentReviewTaskDispatch(repoInput, request, options = {}) {
  const marker = normalizeIntegrationAmendmentReviewMarker(request);
  const repository = repoRoot(repoInput);
  const runDir = resolve(directFactoryRoot(repository), marker.run_id);
  return withRunJsonLock(runDir, async () => {
    const run = await readRunJson(runDir);
    observeIntegrationAmendmentWriterAuthority(runDir, run, { dedicated: true });
    const context = integrationAmendmentReviewContext(repository, runDir, run, marker, options);
    if (existsSync(resolve(runDir, context.review_ref))) throw new Error("integration amendment review already exists before checked reviewer dispatch");
    if (options.claimDispatch !== true) return context;
    const completionToken = requireNonEmptyString(options.completionToken, "integration amendment reviewer completion token");
    if (completionToken.length > 256) throw new Error("integration amendment reviewer completion token is too long");
    const claimRef = integrationAmendmentReviewClaimRef(marker.run_id, marker.amendment_id, marker.attempt);
    const closureRef = `${claimRef.slice(0, -5)}.closed.json`;
    const claim = validateIntegrationAmendmentReviewDispatchClaim({
      schema_version: 1,
      kind: "checked-integration-amendment-review-dispatch-claim",
      run_id: marker.run_id,
      amendment_id: marker.amendment_id,
      attempt: marker.attempt,
      agent: INTEGRATION_AMENDMENT_REVIEW_AGENT,
      baseline_commit: context.baseline_commit,
      candidate_commit: context.candidate_commit,
      candidate_tree: context.candidate_tree,
      review_ref: context.review_ref,
      context_hash: hashValue(context),
      completion_token_hash: sha256Bytes(Buffer.from(completionToken, "utf8")),
      claimed_at: timestamp(options.now),
      closure_ref: closureRef,
    }, { claim_ref: claimRef });
    const assertCurrent = () => {
      if (existsSync(resolve(runDir, context.review_ref))) throw new Error("integration amendment review appeared before checked reviewer dispatch publication");
      assertIntegrationAmendmentReviewContextCurrent(repository, runDir, run, marker, context, options);
    };
    await publishDispatchRecord(runDir, claimRef, claim, {
      hooks: publicationBeforeCommitHooks(options.amendmentReviewClaimAtomicWriteHooks),
      beforeCommit: assertCurrent,
      existsMessage: "integration amendment reviewer dispatch is already claimed for this attempt",
    });
    await options.amendmentReviewClaimAtomicWriteHooks?.afterCommit?.();
    const observed = observeIntegrationAmendmentReviewClaim(runDir, claimRef);
    if (!sameJson(observed.claim, claim)) throw new Error("integration amendment reviewer claim changed after publication");
    context.dispatch_claim = { ref: observed.ref, hash: observed.hash, closure_ref: closureRef };
    return context;
  }, options);
}

export async function completeIntegrationAmendmentReviewTaskDispatch(repoInput, request, options = {}) {
  if (!isRecord(request) || !stringValue(request.run_id) || !stringValue(request.amendment_id) || !Number.isInteger(request.attempt)
    || request.agent !== INTEGRATION_AMENDMENT_REVIEW_AGENT || !stringValue(request.claim_ref) || !stringValue(request.claim_hash)
    || !stringValue(request.completion_token) || typeof request.output !== "string") {
    throw new Error("integration amendment reviewer completion requires exact marker, claim, capability, and synchronous output");
  }
  const marker = normalizeIntegrationAmendmentReviewMarker(request);
  const repository = repoRoot(repoInput);
  const runDir = resolve(directFactoryRoot(repository), marker.run_id);
  return withRunJsonLock(runDir, async () => {
    const run = await readRunJson(runDir);
    observeIntegrationAmendmentWriterAuthority(runDir, run, { dedicated: true, reviewCallback: true });
    const observed = observeIntegrationAmendmentReviewClaim(runDir, request.claim_ref);
    if (observed.hash !== request.claim_hash || observed.claim.run_id !== marker.run_id || observed.claim.amendment_id !== marker.amendment_id
      || observed.claim.attempt !== marker.attempt || observed.claim.agent !== marker.agent) throw new Error("integration amendment reviewer completion claim is stale or cross-bound");
    if (sha256Bytes(Buffer.from(request.completion_token, "utf8")) !== observed.claim.completion_token_hash) throw new Error("integration amendment reviewer completion capability is invalid");
    const context = integrationAmendmentReviewContext(repository, runDir, run, marker, options);
    if (hashValue(context) !== observed.claim.context_hash || context.baseline_commit !== observed.claim.baseline_commit
      || context.candidate_commit !== observed.claim.candidate_commit || context.candidate_tree !== observed.claim.candidate_tree
      || context.review_ref !== observed.claim.review_ref) throw new Error("integration amendment reviewer context changed during dispatch");
    const review = parseIntegrationAmendmentReviewCallback(request.output, context);
    const reviewPath = resolve(runDir, context.review_ref);
    let reviewPublication;
    try {
      reviewPublication = await publishDispatchRecord(runDir, context.review_ref, review, {
        hooks: publicationBeforeCommitHooks(options.amendmentReviewPublicationAtomicWriteHooks),
        beforeCommit: () => assertIntegrationAmendmentReviewContextCurrent(repository, runDir, run, marker, context, options),
        allowExisting: true,
      });
      if (reviewPublication.created) await options.amendmentReviewPublicationAtomicWriteHooks?.afterCommit?.();
    } catch (error) {
      if (hasExactIntegrationAmendmentReviewPublication(runDir, reviewPath, review)) {
        throw integrationAmendmentReviewReplayableError(error, "review");
      }
      throw error;
    }
    const publishedReview = validateIntegrationAmendmentReview(parseJsonObjectFile(reviewPath, "integration amendment checked review"));
    if (!sameJson(publishedReview, review)) throw new Error("integration amendment checked review publication conflicts with preexisting bytes");
    const reviewHash = hashFile(reviewPath);
    const closure = validateIntegrationAmendmentReviewDispatchClosure({
      schema_version: 1,
      kind: "checked-integration-amendment-review-dispatch-closure",
      claim_ref: observed.ref,
      claim_hash: observed.hash,
      run_id: marker.run_id,
      amendment_id: marker.amendment_id,
      attempt: marker.attempt,
      agent: marker.agent,
      context_hash: observed.claim.context_hash,
      review_ref: context.review_ref,
      review_hash: reviewHash,
      completion_token: request.completion_token,
      returned_at: review.reviewed_at,
    }, {
      claim_ref: observed.ref, claim_hash: observed.hash, run_id: marker.run_id, amendment_id: marker.amendment_id,
      attempt: marker.attempt, agent: marker.agent, context_hash: observed.claim.context_hash,
      review_ref: context.review_ref, review_hash: reviewHash, completion_token: request.completion_token,
      completion_token_hash: observed.claim.completion_token_hash,
    });
    let closurePublication;
    try {
      closurePublication = await publishDispatchRecord(runDir, observed.claim.closure_ref, closure, {
        hooks: publicationBeforeCommitHooks(options.amendmentReviewClosureAtomicWriteHooks),
        beforeCommit: () => {
          assertIntegrationAmendmentReviewContextCurrent(repository, runDir, run, marker, context, options);
          if (hashFile(reviewPath) !== reviewHash) throw new Error("integration amendment review changed before callback closure publication");
        },
        allowExisting: true,
      });
      if (closurePublication.created) await options.amendmentReviewClosureAtomicWriteHooks?.afterCommit?.();
    } catch (error) {
      if (hasExactIntegrationAmendmentReviewClosure(runDir, observed, closure)) {
        throw integrationAmendmentReviewReplayableError(error, "closure");
      }
      throw error;
    }
    const closed = observeClosedIntegrationAmendmentReview(runDir, observed);
    if (!sameJson(closed.closure, closure)) throw new Error("integration amendment reviewer callback conflicts with an existing closure");
    return { ...closed, review: publishedReview, replayed: !reviewPublication.created || !closurePublication.created };
  }, options);
}

function hasExactIntegrationAmendmentReviewPublication(runDir, path, expected) {
  try {
    assertNoSymlinkPath(runDir, path, "integration amendment checked review");
    const expectedBytes = Buffer.from(`${JSON.stringify(expected, null, 2)}\n`, "utf8");
    if (!readFileSync(path).equals(expectedBytes)) return false;
    return sameJson(validateIntegrationAmendmentReview(parseJsonObjectFile(path, "integration amendment checked review")), expected);
  } catch {
    return false;
  }
}

function hasExactIntegrationAmendmentReviewClosure(runDir, observed, expected) {
  try {
    const path = resolve(runDir, observed.claim.closure_ref);
    assertNoSymlinkPath(runDir, path, "integration amendment reviewer closure");
    const expectedBytes = Buffer.from(`${JSON.stringify(expected, null, 2)}\n`, "utf8");
    if (!readFileSync(path).equals(expectedBytes)) return false;
    return sameJson(observeClosedIntegrationAmendmentReview(runDir, observed).closure, expected);
  } catch {
    return false;
  }
}

function integrationAmendmentReviewReplayableError(error, publication) {
  const replayable = new Error(error?.message || `integration amendment reviewer ${publication} publication outcome is ambiguous`, { cause: error });
  replayable.code = INTEGRATION_AMENDMENT_REVIEW_REPLAYABLE_ERROR;
  replayable.publication = publication;
  return replayable;
}

function normalizeIntegrationAmendmentReviewMarker(request) {
  if (!isRecord(request)) throw new Error("integration amendment reviewer marker must be an object");
  const allowed = new Set(["run_id", "amendment_id", "attempt", "agent", "claim_ref", "claim_hash", "completion_token", "output"]);
  const extra = Object.keys(request).filter((key) => !allowed.has(key));
  if (extra.length || !stringValue(request.run_id) || !SAFE_TASK_DISPATCH_ID_PATTERN.test(request.run_id) || request.run_id.includes("..")
    || !/^[A-Za-z0-9_-]{43}$/u.test(request.amendment_id || "") || ![1, 2].includes(request.attempt) || request.agent !== INTEGRATION_AMENDMENT_REVIEW_AGENT) {
    throw new Error("integration amendment reviewer marker requires exact run, amendment, attempt, and work-reviewer agent");
  }
  return { run_id: request.run_id, amendment_id: request.amendment_id, attempt: request.attempt, agent: request.agent };
}

function integrationAmendmentReviewContext(repository, runDir, run, marker, options = {}) {
  const amendment = run.integration_amendment;
  const attempt = amendment?.attempts?.at(-1);
  if (run.run_id !== marker.run_id || amendment?.amendment_id !== marker.amendment_id || amendment.status !== "building"
    || attempt?.state !== "building" || attempt.attempt !== marker.attempt) throw new Error("integration amendment reviewer authority is not current");
  const binding = run.special_builder_dispatch;
  const instance = `${amendment.amendment_id}:attempt-${attempt.attempt}`;
  if (!binding || binding.route !== "integration-amendment" || binding.instance !== instance || !binding.closure_ref) {
    throw new Error("integration amendment reviewer requires the exact closed builder dispatch");
  }
  const builderClaim = observeSpecialDispatchClaim(runDir, binding.claim_ref);
  const builderClosure = observeClosedSpecialDispatch(runDir, builderClaim);
  if (builderClaim.claim.route !== binding.route || builderClaim.claim.instance !== binding.instance || builderClaim.claim.agent !== binding.agent
    || builderClaim.ref !== binding.claim_ref || builderClaim.hash !== binding.claim_hash || builderClosure.closure_ref !== binding.closure_ref
    || builderClosure.closure_hash !== binding.closure_hash || builderClosure.completion_head !== binding.completion_head) {
    throw new Error("integration amendment reviewer builder dispatch binding is stale");
  }
  const candidate = builderClosure.completion_head;
  const gitAuthority = assertAmendmentAttemptWorktree(runDir, run, { ...attempt, reviewed_commit: candidate }, { ...options, repoRoot: repository }, true);
  const changedPaths = [...observeNoRenamePathSet(repository, amendment.admission.baseline_commit, candidate, options, "integration amendment reviewer diff")].sort();
  if (changedPaths.length === 0) throw new Error("integration amendment reviewer requires a nonempty observed change set");
  assertIntegrationAmendmentChangedPathOwnership(run, amendment, changedPaths);
  const failureReceiptPath = resolveEvidenceRef(runDir, amendment.failure_execution.receipt_ref).path;
  const failureReceipt = validateIntegrationAmendmentExecutionReceipt(parseJsonObjectFile(failureReceiptPath, "integration amendment failure receipt"));
  if (hashFile(failureReceiptPath) !== amendment.failure_execution.receipt_hash) throw new Error("integration amendment reviewer failure context is stale");
  let prior_reject = null;
  if (attempt.attempt === 2) {
    const priorAttempt = amendment.attempts[0];
    const priorReview = readBoundIntegrationAmendmentReview(runDir, run, priorAttempt);
    if (priorReview.verdict !== "REJECT") throw new Error("integration amendment attempt 2 reviewer requires the exact prior REJECT");
    prior_reject = { review_ref: priorAttempt.review_ref, review_hash: priorAttempt.review_hash, required_fixes: cloneJson(priorReview.required_fixes) };
  }
  return {
    schema_version: 1,
    kind: "checked-integration-amendment-review-task-dispatch",
    agent: INTEGRATION_AMENDMENT_REVIEW_AGENT,
    run_id: run.run_id,
    amendment_id: amendment.amendment_id,
    attempt: attempt.attempt,
    build_base_commit: attempt.build_base_commit,
    baseline_commit: amendment.admission.baseline_commit,
    candidate_commit: candidate,
    candidate_tree: gitAuthority.tree,
    changed_paths: changedPaths,
    ownership: (run.slices || []).map((slice) => ({ id: slice.id, stack: slice.stack, effective_paths: cloneJson(slice.effective_paths) })),
    probe: cloneJson(amendment.admission.probe),
    failure_context: { binding: cloneJson(amendment.failure_execution), receipt: cloneJson(failureReceipt) },
    prior_reject,
    review_ref: `reviews/integration-amendment-${amendment.amendment_id}.attempt-${attempt.attempt}.json`,
  };
}

function assertIntegrationAmendmentReviewContextCurrent(repository, runDir, expectedRun, marker, context, options) {
  const current = validateRun(JSON.parse(readFileSync(join(runDir, RUN_FILE), "utf8")));
  if (!sameJson(current, expectedRun)) throw new Error("integration amendment reviewer run authority changed during callback");
  const observed = integrationAmendmentReviewContext(repository, runDir, current, marker, options);
  if (!sameJson(observed, context)) throw new Error("integration amendment reviewer context changed during callback");
}

function parseIntegrationAmendmentReviewCallback(output, context) {
  let value;
  try { value = JSON.parse(output.trim()); }
  catch { throw new Error("integration amendment reviewer callback must be exactly one JSON object"); }
  const review = validateIntegrationAmendmentReview(value);
  if (review.subject !== `integration-amendment:${context.amendment_id}` || review.amendment_id !== context.amendment_id || review.attempt !== context.attempt
    || review.build_base_commit !== context.build_base_commit || review.reviewed_commit !== context.candidate_commit
    || review.reviewed_tree !== context.candidate_tree || !sameJson(review.changed_paths, context.changed_paths)) {
    throw new Error("integration amendment reviewer callback is stale or cross-bound");
  }
  return review;
}

function integrationAmendmentReviewClaimRef(runId, amendmentId, attempt) {
  const name = createHash("sha256").update(`${runId}\0integration-amendment-review\0${amendmentId}\0${attempt}`, "utf8").digest("hex");
  return `dispatch/${name}.amendment-review.json`;
}

function observeIntegrationAmendmentReviewClaim(runDir, ref) {
  if (!/^dispatch\/[0-9a-f]{64}\.amendment-review\.json$/u.test(ref || "")) throw new Error("integration amendment reviewer claim ref is invalid");
  const path = resolve(runDir, ref);
  assertNoSymlinkPath(runDir, path, "integration amendment reviewer claim");
  const claim = validateIntegrationAmendmentReviewDispatchClaim(parseJsonObjectFile(path, "integration amendment reviewer claim"), { claim_ref: ref });
  return { ref, path, hash: hashFile(path), claim };
}

function observeClosedIntegrationAmendmentReview(runDir, observed) {
  const path = resolve(runDir, observed.claim.closure_ref);
  assertNoSymlinkPath(runDir, path, "integration amendment reviewer closure");
  const closure = validateIntegrationAmendmentReviewDispatchClosure(parseJsonObjectFile(path, "integration amendment reviewer closure"), {
    claim_ref: observed.ref, claim_hash: observed.hash, run_id: observed.claim.run_id, amendment_id: observed.claim.amendment_id,
    attempt: observed.claim.attempt, agent: observed.claim.agent, context_hash: observed.claim.context_hash,
    review_ref: observed.claim.review_ref, completion_token_hash: observed.claim.completion_token_hash,
  });
  const reviewPath = resolveReviewRef(runDir, closure.review_ref).path;
  if (hashFile(reviewPath) !== closure.review_hash) throw new Error("integration amendment reviewer closure review binding is stale");
  return { closure_ref: observed.claim.closure_ref, closure_hash: hashFile(path), closure };
}

export async function transitionIntegrationAmendment(runDir, input = {}, options = {}) {
  const request = normalizeIntegrationAmendmentRequest(input);
  const result = await withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, (draft, { current }) => {
    if (current.merged_slice_repair != null) throw new Error("generic and legacy repair authority may never coexist");
    const stampedAt = timestamp(options.now);
    if (request.action === "report") return transitionAmendmentReport(runDir, draft, current, request, stampedAt, options);
    const amendment = current.integration_amendment;
    if (!amendment) throw new Error("integration amendment must be reported before this action");
    if (request.action === "merge" && amendment.status === "verified") assertIntegrationAmendmentConsistency(runDir, current);
    else observeCurrentIntegrationAmendmentAuthority(runDir, current, options);
    if (request.action === "build") transitionAmendmentBuild(runDir, draft, request, stampedAt, options);
    else if (request.action === "review") transitionAmendmentReview(runDir, draft, stampedAt, options);
    else if (request.action === "integrate") transitionAmendmentIntegrate(runDir, draft, stampedAt, options);
    else if (request.action === "verify") transitionAmendmentVerify(runDir, draft, stampedAt, options);
    else if (request.action === "merge") transitionAmendmentMerge(runDir, draft, stampedAt, options);
    else transitionAmendmentBlock(runDir, draft, request.reason, stampedAt);
  }, options, {
    integrationAmendment: INTEGRATION_AMENDMENT_TRANSITION_AUTHORITY,
    integrationAmendmentAction: request.action,
    consumeSpecialDispatch: request.action === "review",
    beforeReplace: (next) => observeCurrentIntegrationAmendmentAuthority(runDir, next, options),
  }), options);
  return { ...result, integration_amendment: result.run.integration_amendment ?? null };
}

function normalizeIntegrationAmendmentRequest(input) {
  if (!isRecord(input)) throw new Error("integration amendment request must be an object");
  const action = String(input.action || "").trim();
  if (!INTEGRATION_AMENDMENT_ACTIONS.has(action)) throw new Error(`integration amendment action must be one of ${[...INTEGRATION_AMENDMENT_ACTIONS].join(", ")}`);
  const allowed = action === "report" ? new Set(["action", "owner_slice_id", "consumer_slice_id", "defect_path", "verification_artifact_id"])
    : action === "build" ? new Set(["action", "attempt"])
      : action === "block" ? new Set(["action", "reason"])
        : new Set(["action"]);
  const extra = Object.keys(input).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`integration amendment ${action} does not accept caller authority field '${extra[0]}'`);
  const request = { action };
  if (action === "report") {
    request.owner_slice_id = requireNonEmptyString(input.owner_slice_id, "amendment owner slice id");
    request.consumer_slice_id = requireNonEmptyString(input.consumer_slice_id, "amendment consumer slice id");
    request.defect_path = normalizeRepairDefectPath(input.defect_path);
    request.verification_artifact_id = requireNonEmptyString(input.verification_artifact_id, "amendment verification artifact id");
  }
  if (action === "build") {
    if (![1, 2].includes(input.attempt)) throw new Error("integration amendment build attempt must be exactly 1 or 2");
    request.attempt = input.attempt;
  }
  if (action === "block") request.reason = requireNonEmptyString(input.reason, "amendment blocked reason");
  return request;
}

function transitionAmendmentReport(runDir, draft, current, request, stampedAt, options) {
  if (current.integration_amendment) {
    const amendment = current.integration_amendment;
    if (amendment.owner_slice_id === request.owner_slice_id && amendment.consumer_slice_id === request.consumer_slice_id
      && amendment.defect_path === request.defect_path && amendment.verification_artifact_id === request.verification_artifact_id) return;
    throw new Error("only one generic integration amendment is allowed per run");
  }
  const inventory = inspectIntegrationAmendmentInventory(runDir, current);
  if (["completed-pass-receipt-no-manifest", "completed-diagnostic-receipt-no-manifest"].includes(inventory.classification)) return;
  if (inventory.classification !== "completed-nonzero-receipt-no-manifest") throw new Error(`integration amendment report cannot consume ${inventory.classification}`);
  const admission = observeIntegrationAmendmentAdmission(runDir, current, request, options, { initial: true });
  const identity = { schema_version: 1, kind: "integration-amendment-identity", run_id: current.run_id, defect_path: request.defect_path, admission };
  const amendmentId = integrationAmendmentId(identity);
  const claim = inventory.report_claim;
  const receipt = inventory.report_receipt;
  if (claim.amendment_id !== amendmentId || !sameJson(claim.identity, identity) || claim.run_id !== current.run_id || !sameJson(claim.probe, admission.probe)
    || claim.head_sha !== admission.baseline_commit || claim.tree_sha !== admission.baseline_tree || resolve(claim.cwd) !== resolve(admission.worktree)
    || receipt.review_ready !== true || receipt.commands[0].outcome !== "exited" || receipt.commands[0].exit_code === 0) {
    throw new Error("integration amendment report claim/receipt does not match the exact derived admission authority");
  }
  draft.integration_amendment = {
    schema_version: 1,
    kind: "integration-amendment",
    amendment_id: amendmentId,
    status: "reported",
    owner_slice_id: request.owner_slice_id,
    consumer_slice_id: request.consumer_slice_id,
    defect_path: request.defect_path,
    verification_artifact_id: request.verification_artifact_id,
    admission,
    failure_execution: {
      claim_ref: "evidence/integration-amendment.report.claim.json",
      claim_hash: inventory.report_claim_hash,
      receipt_ref: claim.receipt_ref,
      receipt_hash: inventory.report_receipt_hash,
    },
    max_attempts: 2,
    attempts: [],
    created_at: stampedAt,
    updated_at: stampedAt,
  };
  draft.updated_at = stampedAt;
}

function observeIntegrationAmendmentAdmission(runDir, run, request, options = {}, mode = {}) {
  if (run.status !== "running") throw new Error("integration amendment requires a running run");
  if (run.continuation || run.checkpoint_source || run.checkpoint_progress) throw new Error("integration-amendment-continuation-unsupported");
  if (mode.initial && run.merged_slice_repair != null) throw new Error("generic and legacy repair authority may never coexist");
  const decomposition = observeAcceptedDecompositionAuthority(runDir, run, { ...options, requireIntegrationGate: true, requireApprovingReview: true });
  const owner = (run.slices || []).find((slice) => slice?.id === request.owner_slice_id);
  const consumer = (run.slices || []).find((slice) => slice?.id === request.consumer_slice_id);
  if (!owner || owner.status !== "merged") throw new Error("integration amendment owner must be a current merged slice");
  if (!consumer || consumer.id === owner.id || !(consumer.depends_on || []).includes(owner.id)) throw new Error("integration amendment consumer must be a different direct dependent of the owner");
  const consumerKeys = new Set(["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts"]);
  if (consumer.status !== "pending" || consumer.attempts !== 0 || Object.keys(consumer).some((key) => !consumerKeys.has(key))) {
    throw new Error("integration-amendment-consumer-not-pristine-pending");
  }
  if ((run.slices || []).some((slice) => ["running", "review"].includes(slice?.status))) throw new Error("integration amendment requires quiescent slice work");
  const testVerifier = (run.steps || []).find((step) => step?.agent === "test-verifier");
  if (testVerifier && (testVerifier.attempts !== 0 || !["running", "blocked"].includes(testVerifier.status)
    || Object.keys(testVerifier).some((key) => !["agent", "status", "attempts"].includes(key)))) throw new Error("integration amendment requires an absent or pristine attempt-zero test-verifier");
  if (run.validator != null || run.security_review != null || run.gates?.pre_pr != null || isRecord(run.steering?.pr_fence)
    || stringValue(run.pr_url) || run.terminal_result != null || postPrAuthorityExists(run.post_pr)) throw new Error("integration amendment is excluded after panel, pre-PR, PR, or post-PR authority");
  if (mode.initial) assertNoUnresolvedSliceDispatches(runDir, run);
  assertSliceAttemptHistoryCurrent(runDir, owner.id, owner);
  const currentOwnerAttempt = owner.attempt_reviews?.at(-1);
  if (!["dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash"].every((key) => stringValue(currentOwnerAttempt?.[key]))) {
    throw new Error("integration amendment owner must retain complete current dispatch authority");
  }
  const ownerReview = parseJsonObjectFile(resolveReviewRef(runDir, owner.review_ref).path, "integration amendment owner review");
  if (ownerReview.verdict !== "APPROVE" || (ownerReview.required_fixes || []).length !== 0
    || (ownerReview.invariant_family_ledger?.dispositions || []).some((entry) => (entry.unresolved_findings || []).length > 0)) throw new Error("integration amendment owner must retain complete APPROVE authority with no unresolved finding");
  const repository = resolveAuthorityRepository(runDir, run, options);
  observeReviewedMergeProof(repository, owner.id, owner.merge_commit, owner.reviewed_commit, options);
  const ownership = createOwnershipIndex((run.slices || []).map((slice) => ({ id: slice.id, stack: slice.stack, effective_paths: slice.effective_paths })));
  const owners = ownership.owners(request.defect_path);
  if (owners.length !== 1 || owners[0].id !== owner.id || isPrivilegedControlPlanePath(request.defect_path)) throw new Error("integration amendment defect path must have the merged owner as its sole non-privileged effective owner");
  const unit = decomposition.plan.delivery_envelope?.delivery_units?.find((candidate) => candidate.slice_id === consumer.id);
  const artifact = unit?.verification_artifacts?.find((candidate) => candidate.id === request.verification_artifact_id);
  if (!unit || !artifact) throw new Error("integration amendment artifact must belong to the consumer current accepted delivery unit");
  const command = parseVerificationCommand(artifact.test_plan_entry);
  const integration = observeIntegrationHeadAuthority(run, { ...options, runDir }, "integration amendment baseline");
  const baselineTree = authorityGit(options, repository, ["rev-parse", "--verify", `${integration.head}^{tree}`]);
  if (!baselineTree.ok || !/^[0-9a-f]{40}$/u.test(baselineTree.stdout.trim())) throw new Error("integration amendment baseline tree cannot be observed");
  const ownerSnapshot = pickExactObject(owner, ["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts", "attempt_reviews", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "merge_commit"]);
  const consumerSnapshot = pickExactObject(consumer, [...consumerKeys]);
  return {
    baseline_ref: `refs/heads/${run.branch}`,
    baseline_commit: integration.head,
    baseline_tree: baselineTree.stdout.trim(),
    worktree: resolve(integration.worktree),
    probe: {
      schema_version: 1, kind: "integration-amendment-probe", delivery_unit_id: unit.id, consumer_slice_id: consumer.id,
      verification_artifact_id: artifact.id, test_plan_index: artifact.test_plan_index, test_plan_entry: artifact.test_plan_entry,
      program: command.program, args: command.args, ...(artifact.timeout_ms === undefined ? {} : { timeout_ms: artifact.timeout_ms }), substrate: "feature-baseline",
    },
    owner: ownerSnapshot,
    consumer: consumerSnapshot,
  };
}

function observeCurrentIntegrationAmendmentAuthority(runDir, run, options = {}) {
  const amendment = run.integration_amendment;
  if (!amendment) return inspectIntegrationAmendmentInventory(runDir, run);
  if (amendment.status === "merged") {
    assertIntegrationAmendmentConsistency(runDir, run);
    return { merged: true, amendment_hash: hashValue(amendment) };
  }
  const request = {
    owner_slice_id: amendment.owner_slice_id,
    consumer_slice_id: amendment.consumer_slice_id,
    defect_path: amendment.defect_path,
    verification_artifact_id: amendment.verification_artifact_id,
  };
  const admission = observeIntegrationAmendmentAdmission(runDir, run, request, options);
  if (!sameJson(admission, amendment.admission)) throw new Error("integration amendment accepted plan, owner, consumer, branch, or worktree authority is stale");
  const inventory = inspectIntegrationAmendmentInventory(runDir, run);
  if (inventory.classification !== "completed-nonzero-receipt-matching-manifest") throw new Error("integration amendment sidecar inventory is not exactly consumed");
  return { admission, inventory };
}

export function observeIntegrationAmendmentExecutionAuthority(runDir, run, phase, input = {}, options = {}) {
  if (!isRecord(run) || !["report", "verify"].includes(phase)) throw new Error("integration amendment execution phase is invalid");
  if (phase === "report") {
    const request = normalizeIntegrationAmendmentRequest({ ...input, action: "report" });
    if (run.integration_amendment != null) throw new Error("integration amendment report execution requires no manifest");
    const admission = observeIntegrationAmendmentAdmission(runDir, run, request, options, { initial: true });
    const identity = { schema_version: 1, kind: "integration-amendment-identity", run_id: run.run_id, defect_path: request.defect_path, admission };
    const amendmentId = integrationAmendmentId(identity);
    return {
      phase,
      run_id: run.run_id,
      amendment_id: amendmentId,
      identity,
      probe: cloneJson(admission.probe),
      head_sha: admission.baseline_commit,
      tree_sha: admission.baseline_tree,
      cwd: resolve(admission.worktree),
      timeout_ms: effectiveCheckedExecutionTimeoutMs(admission.probe.timeout_ms),
      claim_ref: "evidence/integration-amendment.report.claim.json",
      receipt_ref: `evidence/integration-amendment-${amendmentId}.report.receipt.json`,
      request,
    };
  }
  const amendment = run.integration_amendment;
  if (!amendment || !["integrated", "verified"].includes(amendment.status)) throw new Error("integration amendment verification execution requires integrated state");
  const request = {
    owner_slice_id: amendment.owner_slice_id,
    consumer_slice_id: amendment.consumer_slice_id,
    defect_path: amendment.defect_path,
    verification_artifact_id: amendment.verification_artifact_id,
  };
  const admission = observeIntegrationAmendmentAdmission(runDir, run, request, options);
  if (!sameJson(admission, amendment.admission)) throw new Error("integration amendment accepted authority changed before verification execution");
  assertAmendmentIntegration(run, options);
  const identity = { schema_version: 1, kind: "integration-amendment-identity", run_id: run.run_id, defect_path: amendment.defect_path, admission: cloneJson(amendment.admission) };
  return {
    phase,
    run_id: run.run_id,
    amendment_id: amendment.amendment_id,
    identity,
    probe: cloneJson(amendment.admission.probe),
    head_sha: amendment.integration.commit,
    tree_sha: amendment.integration.tree,
    cwd: resolve(amendment.integration.worktree),
    timeout_ms: effectiveCheckedExecutionTimeoutMs(amendment.admission.probe.timeout_ms),
    claim_ref: `evidence/integration-amendment-${amendment.amendment_id}.verify.claim.json`,
    receipt_ref: `evidence/integration-amendment-${amendment.amendment_id}.verify.receipt.json`,
  };
}

function integrationAmendmentDispatchAuthority(runDir, run, agent, options = {}) {
  const amendment = run.integration_amendment;
  const attempt = amendment?.attempts?.at(-1);
  if (amendment?.status !== "building" || attempt?.state !== "building" || agent !== `${amendment.admission.owner.stack}-builder`) {
    throw new Error("special integration amendment dispatch authority is not current");
  }
  const admission = observeIntegrationAmendmentAdmission(runDir, run, {
    owner_slice_id: amendment.owner_slice_id,
    consumer_slice_id: amendment.consumer_slice_id,
    defect_path: amendment.defect_path,
    verification_artifact_id: amendment.verification_artifact_id,
  }, { ...options, repoRoot: resolve(runDir, "../../..") });
  if (!sameJson(admission, amendment.admission)) throw new Error("integration amendment dispatch accepted authority is stale");
  return {
    amendment_id: amendment.amendment_id,
    defect_path: amendment.defect_path,
    verification_artifact_id: amendment.verification_artifact_id,
    owner: cloneJson(amendment.admission.owner),
    consumer: cloneJson(amendment.admission.consumer),
    probe: cloneJson(amendment.admission.probe),
    attempt: cloneJson(attempt),
    path_policy: { effective_paths: cloneJson(amendment.admission.owner.effective_paths), expansion_allowed: false },
  };
}

function transitionAmendmentBuild(runDir, draft, request, stampedAt, options) {
  const amendment = draft.integration_amendment;
  if (amendment.status === "building" && amendment.attempts.at(-1)?.attempt === request.attempt) {
    assertAmendmentAttemptWorktree(runDir, draft, amendment.attempts.at(-1), options, false);
    return;
  }
  if (request.attempt === 1) {
    if (amendment.status !== "reported" || amendment.attempts.length !== 0) throw new Error("integration amendment attempt 1 starts only from reported");
  } else {
    if (amendment.status !== "reviewed" || amendment.attempts.length !== 1) throw new Error("integration amendment attempt 2 requires reviewed attempt 1");
    const prior = readBoundIntegrationAmendmentReview(runDir, draft, amendment.attempts[0]);
    if (prior.verdict !== "REJECT" || !INTEGRATION_AMENDMENT_DISPOSITIONS.every((key) => prior.dispositions[key] === "preserved")) throw new Error("integration amendment attempt 2 requires an all-preserved attempt-1 REJECT");
  }
  const repository = resolveAuthorityRepository(runDir, draft, options);
  const buildBase = request.attempt === 1 ? amendment.admission.baseline_commit : amendment.attempts[0].reviewed_commit;
  const shortBranch = `${draft.branch}--amend-${amendment.amendment_id}-a${request.attempt}`;
  const branchRef = `refs/heads/${shortBranch}`;
  const worktree = resolve(repository, ".opencode", "worktrees", shortBranch);
  createOrReplayAmendmentBranch(repository, branchRef, buildBase, options);
  createOrReplayAmendmentWorktree(repository, worktree, shortBranch, buildBase, options);
  amendment.attempts.push({ attempt: request.attempt, state: "building", build_base_commit: buildBase, branch_ref: branchRef, worktree });
  amendment.status = "building";
  amendment.updated_at = stampedAt;
  draft.updated_at = stampedAt;
}

function transitionAmendmentReview(runDir, draft, stampedAt, options) {
  const amendment = draft.integration_amendment;
  const attempt = amendment.attempts.at(-1);
  if (amendment.status === "reviewed" && attempt?.state === "reviewed") {
    readBoundIntegrationAmendmentReview(runDir, draft, attempt);
    assertAmendmentAttemptWorktree(runDir, draft, attempt, options, true);
    return;
  }
  if (amendment.status !== "building" || attempt?.state !== "building") throw new Error("integration amendment review requires a building attempt");
  const binding = draft.special_builder_dispatch;
  const expectedInstance = `${amendment.amendment_id}:attempt-${attempt.attempt}`;
  if (!binding || binding.route !== "integration-amendment" || binding.instance !== expectedInstance || binding.agent !== `${amendment.admission.owner.stack}-builder`) throw new Error("integration amendment review requires the exact immutable dispatch fixture binding");
  const observedClaim = observeSpecialDispatchClaim(runDir, binding.claim_ref);
  const observedClosure = observeClosedSpecialDispatch(runDir, observedClaim);
  if (observedClaim.hash !== binding.claim_hash || observedClaim.claim.run_id !== draft.run_id || observedClaim.claim.route !== "integration-amendment"
    || observedClaim.claim.instance !== expectedInstance || observedClaim.claim.branch !== attempt.branch_ref.slice("refs/heads/".length)
    || resolve(observedClaim.claim.worktree) !== resolve(attempt.worktree) || observedClaim.claim.head !== attempt.build_base_commit
    || observedClaim.claim.run_hash !== specialDispatchAuthorityHash(draft)
    || observedClosure.closure_ref !== binding.closure_ref || observedClosure.closure_hash !== binding.closure_hash || observedClosure.completion_head !== binding.completion_head) {
    throw new Error("integration amendment dispatch fixture is stale or cross-bound");
  }
  const candidate = observedClosure.completion_head;
  const gitAuthority = assertAmendmentAttemptWorktree(runDir, draft, { ...attempt, reviewed_commit: candidate }, options, true);
  const tree = gitAuthority.tree;
  const changedPaths = [...observeNoRenamePathSet(gitAuthority.repository, amendment.admission.baseline_commit, candidate, options, "integration amendment reviewed diff")].sort();
  if (changedPaths.length === 0) throw new Error("integration amendment review requires a nonempty observed change set");
  assertIntegrationAmendmentChangedPathOwnership(draft, amendment, changedPaths);
  const reviewRef = `reviews/integration-amendment-${amendment.amendment_id}.attempt-${attempt.attempt}.json`;
  const reviewPath = resolveReviewRef(runDir, reviewRef).path;
  assertBoundIntegrationAmendmentReviewPublication(runDir, draft, amendment, attempt, reviewRef);
  const review = validateIntegrationAmendmentReview(parseJsonObjectFile(reviewPath, "integration amendment review"));
  if (review.subject !== `integration-amendment:${amendment.amendment_id}` || review.amendment_id !== amendment.amendment_id || review.attempt !== attempt.attempt
    || review.build_base_commit !== attempt.build_base_commit || review.reviewed_commit !== candidate || review.reviewed_tree !== tree || !sameJson(review.changed_paths, changedPaths)) {
    throw new Error("integration amendment review is stale or cross-bound");
  }
  Object.assign(attempt, {
    state: "reviewed",
    dispatch_claim_ref: observedClaim.ref,
    dispatch_claim_hash: observedClaim.hash,
    dispatch_closure_ref: observedClosure.closure_ref,
    dispatch_closure_hash: observedClosure.closure_hash,
    candidate_commit: candidate,
    candidate_tree: tree,
    changed_paths: changedPaths,
    review_ref: reviewRef,
    review_hash: hashFile(reviewPath),
    reviewed_commit: candidate,
    reviewed_tree: tree,
  });
  delete draft.special_builder_dispatch;
  amendment.status = "reviewed";
  amendment.updated_at = stampedAt;
  draft.updated_at = stampedAt;
}

function transitionAmendmentIntegrate(runDir, draft, stampedAt, options) {
  const amendment = draft.integration_amendment;
  if (amendment.status === "integrated") { assertAmendmentIntegration(draft, options); return; }
  if (amendment.status !== "reviewed") throw new Error("integration amendment integrate requires reviewed state");
  const attempt = amendment.attempts.at(-1);
  const review = readBoundIntegrationAmendmentReview(runDir, draft, attempt);
  if (review.verdict !== "APPROVE") throw new Error("integration amendment integrate requires APPROVE review");
  const repository = resolveAuthorityRepository(runDir, draft, options);
  const ref = `refs/opencode/integration-amendments/${amendment.amendment_id}/staged`;
  const worktree = resolve(repository, ".opencode", "worktrees", `${draft.branch}--amend-${amendment.amendment_id}-staged`);
  let commit = resolveOptionalCommit(repository, ref, options);
  if (!commit) {
    options.integrationAmendmentHooks?.beforeStagingRef?.();
    const created = git(repository, ["commit-tree", attempt.reviewed_tree, "-p", amendment.admission.baseline_commit, "-p", attempt.reviewed_commit, "-m", `integration amendment ${amendment.amendment_id}`], {
      env: { GIT_AUTHOR_NAME: "feature-factory", GIT_AUTHOR_EMAIL: "feature-factory@localhost", GIT_COMMITTER_NAME: "feature-factory", GIT_COMMITTER_EMAIL: "feature-factory@localhost", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" },
    });
    if (!created.ok || !/^[0-9a-f]{40}$/u.test(created.stdout.trim())) throw new Error("integration amendment staging commit could not be created");
    commit = created.stdout.trim();
    const published = git(repository, ["update-ref", ref, commit, "0".repeat(40)]);
    if (!published.ok) {
      const replay = resolveOptionalCommit(repository, ref, options);
      if (replay !== commit) throw new Error("integration amendment staging ref conflicts with existing authority");
    }
    options.integrationAmendmentHooks?.afterStagingRef?.();
  }
  createOrReplayDetachedAmendmentWorktree(repository, worktree, commit, options);
  amendment.integration = { ref, worktree, commit, tree: attempt.reviewed_tree };
  amendment.status = "integrated";
  assertAmendmentIntegration(draft, options);
  amendment.updated_at = stampedAt;
  draft.updated_at = stampedAt;
}

function transitionAmendmentVerify(runDir, draft, stampedAt, options) {
  const amendment = draft.integration_amendment;
  if (amendment.status === "verified") { assertBoundAmendmentVerification(runDir, draft); return; }
  if (amendment.status !== "integrated") throw new Error("integration amendment verify requires integrated state");
  assertAmendmentIntegration(draft, options);
  const binding = observeCompletedAmendmentExecution(runDir, draft, "verify");
  if (binding.claim.state === "unknown" || binding.claim.state === "active") throw new Error("integration amendment verification remains active or unknown");
  if (binding.receipt.status !== "pass" || binding.receipt.review_ready !== true) {
    amendment.status = "blocked";
    amendment.blocked = { origin: "integrated", reason: "verification-failed", blocked_at: stampedAt };
  } else {
    amendment.status = "verified";
    amendment.verification = binding.binding;
  }
  amendment.updated_at = stampedAt;
  draft.updated_at = stampedAt;
}

function transitionAmendmentMerge(runDir, draft, stampedAt, options) {
  const amendment = draft.integration_amendment;
  if (amendment.status === "merged") { assertPublishedAmendment(draft, options); return; }
  if (amendment.status !== "verified") throw new Error("integration amendment merge requires verified state");
  assertBoundAmendmentVerification(runDir, draft);
  assertAmendmentIntegration(draft, options);
  const repository = resolveAuthorityRepository(runDir, draft, options);
  const featureRef = amendment.admission.baseline_ref;
  const featureBranch = featureRef.slice("refs/heads/".length);
  const baseline = amendment.admission.baseline_commit;
  const integrated = amendment.integration.commit;
  const refHead = resolveRequiredCommit(repository, featureRef, options, "integration amendment feature ref");
  const snapshot = observeFeatureWorktreeSnapshot(repository, amendment.admission.worktree, featureBranch, amendment.admission.baseline_tree, amendment.integration.tree, refHead, baseline, integrated, options);
  if (refHead === baseline && snapshot.case === "baseline") {
    options.integrationAmendmentHooks?.beforeFeatureCas?.();
    const updated = git(repository, ["update-ref", featureRef, integrated, baseline]);
    if (!updated.ok) throw new Error("integration amendment feature ref CAS failed");
    options.integrationAmendmentHooks?.afterFeatureCas?.();
  } else if (!(refHead === integrated && ["integration", "pre-cas-baseline"].includes(snapshot.case))) {
    throw new Error("integration amendment feature ref/worktree is outside the three recoverable publication cases");
  }
  const afterRef = resolveRequiredCommit(repository, featureRef, options, "integration amendment feature ref");
  if (afterRef !== integrated) throw new Error("integration amendment feature ref does not equal staged integration");
  const afterSnapshot = observeFeatureWorktreeSnapshot(repository, amendment.admission.worktree, featureBranch, amendment.admission.baseline_tree, amendment.integration.tree, afterRef, baseline, integrated, options);
  if (afterSnapshot.case === "pre-cas-baseline") {
    options.integrationAmendmentHooks?.beforeWorktreeReconcile?.();
    const reset = git(amendment.admission.worktree, ["reset", "--hard", integrated]);
    if (!reset.ok) throw new Error("integration amendment worktree reconciliation failed");
    options.integrationAmendmentHooks?.afterWorktreeReconcile?.();
  } else if (afterSnapshot.case !== "integration") throw new Error("integration amendment worktree cannot be reconciled safely");
  amendment.publication = { branch_ref: featureRef, previous_commit: baseline, commit: integrated, published_at: stampedAt };
  amendment.status = "merged";
  assertPublishedAmendment(draft, options);
  amendment.updated_at = stampedAt;
  draft.updated_at = stampedAt;
}

function transitionAmendmentBlock(runDir, draft, reason, stampedAt) {
  const amendment = draft.integration_amendment;
  if (amendment.status === "blocked") {
    if (amendment.blocked.reason === reason) return;
    throw new Error("blocked integration amendment is terminal");
  }
  if (amendment.status === "merged") throw new Error("merged integration amendment is terminal");
  const inventory = inspectIntegrationAmendmentInventory(runDir, draft);
  if (["active", "unknown"].includes(inventory.verification_effect?.state) || draft.special_builder_dispatch) throw new Error("integration amendment cannot block while an effect is active, unknown, or unconsumed");
  let origin = amendment.status;
  if (origin === "reviewed") {
    const review = readBoundIntegrationAmendmentReview(runDir, draft, amendment.attempts.at(-1));
    origin = review.verdict === "APPROVE" ? "reviewed-approve" : "reviewed-reject";
  }
  amendment.status = "blocked";
  amendment.blocked = { origin, reason, blocked_at: stampedAt };
  amendment.updated_at = stampedAt;
  draft.updated_at = stampedAt;
}

function pickExactObject(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, cloneJson(value[key])]));
}

function createOrReplayAmendmentBranch(repository, ref, commit, options) {
  const existing = resolveOptionalCommit(repository, ref, options);
  if (existing) {
    if (existing !== commit) throw new Error(`integration amendment branch '${ref}' conflicts with another commit`);
    return;
  }
  options.integrationAmendmentHooks?.beforeBuildBranch?.();
  const created = git(repository, ["update-ref", ref, commit, "0".repeat(40)]);
  if (!created.ok && resolveOptionalCommit(repository, ref, options) !== commit) throw new Error("integration amendment build branch could not be create-published");
  options.integrationAmendmentHooks?.afterBuildBranch?.();
}

function createOrReplayAmendmentWorktree(repository, worktree, branch, head, options) {
  if (!existsSync(worktree)) {
    options.integrationAmendmentHooks?.beforeBuildWorktree?.();
    const parent = dirname(worktree);
    mkdirSync(parent, { recursive: true });
    const added = git(repository, ["worktree", "add", worktree, branch]);
    if (!added.ok && !existsSync(worktree)) throw new Error("integration amendment build worktree could not be created");
    options.integrationAmendmentHooks?.afterBuildWorktree?.();
  }
  const identity = checkWorktreeIdentity(repository, worktree, { branch, head });
  const clean = authorityGit(options, worktree, gitCleanlinessArgs());
  if (!identity.ok || !clean.ok || clean.stdout !== "") throw new Error("integration amendment build worktree is stale, foreign, or dirty");
}

function createOrReplayDetachedAmendmentWorktree(repository, worktree, head, options) {
  if (!existsSync(worktree)) {
    const parent = dirname(worktree);
    mkdirSync(parent, { recursive: true });
    options.integrationAmendmentHooks?.beforeStagingWorktree?.();
    const added = git(repository, ["worktree", "add", "--detach", worktree, head]);
    if (!added.ok && !existsSync(worktree)) throw new Error("integration amendment staging worktree could not be created");
    options.integrationAmendmentHooks?.afterStagingWorktree?.();
  }
  const identity = checkWorktreeIdentity(repository, worktree, { head });
  const symbolic = authorityGit(options, worktree, ["symbolic-ref", "--quiet", "HEAD"]);
  const clean = authorityGit(options, worktree, gitCleanlinessArgs());
  if (!identity.ok || symbolic.ok || !clean.ok || clean.stdout !== "") throw new Error("integration amendment staging worktree is stale, foreign, attached, or dirty");
}

function resolveOptionalCommit(repository, ref, options) {
  const result = authorityGit(options, repository, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!result.ok) return null;
  if (!/^[0-9a-f]{40}$/u.test(result.stdout.trim())) throw new Error(`integration amendment ref '${ref}' does not resolve to one full commit`);
  return result.stdout.trim();
}

function resolveRequiredCommit(repository, ref, options, label) {
  const commit = resolveOptionalCommit(repository, ref, options);
  if (!commit) throw new Error(`${label} does not resolve`);
  return commit;
}

function assertAmendmentAttemptWorktree(runDir, run, attempt, options, reviewed) {
  const repository = resolveAuthorityRepository(runDir, run, options);
  const branch = attempt.branch_ref.slice("refs/heads/".length);
  const head = resolveRequiredCommit(repository, attempt.branch_ref, options, "integration amendment build branch");
  const expectedHead = reviewed ? attempt.reviewed_commit : attempt.build_base_commit;
  const identity = checkWorktreeIdentity(repository, attempt.worktree, { branch, head: expectedHead });
  const clean = authorityGit(options, attempt.worktree, gitCleanlinessArgs());
  if (head !== expectedHead || !identity.ok || !clean.ok || clean.stdout !== "") throw new Error("integration amendment attempt branch/worktree authority is stale or dirty");
  const tree = authorityGit(options, repository, ["rev-parse", "--verify", `${head}^{tree}`]);
  if (!tree.ok || !/^[0-9a-f]{40}$/u.test(tree.stdout.trim())) throw new Error("integration amendment attempt tree cannot be observed");
  return { repository, head, tree: tree.stdout.trim() };
}

function readBoundIntegrationAmendmentReview(runDir, run, attempt) {
  const amendment = run.integration_amendment;
  const expectedRef = `reviews/integration-amendment-${amendment.amendment_id}.attempt-${attempt.attempt}.json`;
  if (attempt.review_ref !== expectedRef) throw new Error("integration amendment review ref is stale");
  assertBoundIntegrationAmendmentReviewPublication(runDir, run, amendment, attempt, expectedRef);
  const path = resolveReviewRef(runDir, expectedRef).path;
  if (hashFile(path) !== attempt.review_hash) throw new Error("integration amendment review bytes changed after binding");
  const review = validateIntegrationAmendmentReview(parseJsonObjectFile(path, "integration amendment review"));
  if (review.subject !== `integration-amendment:${amendment.amendment_id}` || review.amendment_id !== amendment.amendment_id
    || review.attempt !== attempt.attempt || review.build_base_commit !== attempt.build_base_commit || review.reviewed_commit !== attempt.reviewed_commit
    || review.reviewed_tree !== attempt.reviewed_tree || !sameJson(review.changed_paths, attempt.changed_paths)) throw new Error("integration amendment review binding is stale or cross-bound");
  assertIntegrationAmendmentChangedPathOwnership(run, amendment, attempt.changed_paths);
  return review;
}

function assertBoundIntegrationAmendmentReviewPublication(runDir, run, amendment, attempt, reviewRef) {
  const claimRef = integrationAmendmentReviewClaimRef(run.run_id, amendment.amendment_id, attempt.attempt);
  const observed = observeIntegrationAmendmentReviewClaim(runDir, claimRef);
  const closed = observeClosedIntegrationAmendmentReview(runDir, observed);
  if (observed.claim.run_id !== run.run_id || observed.claim.amendment_id !== amendment.amendment_id || observed.claim.attempt !== attempt.attempt
    || observed.claim.baseline_commit !== amendment.admission.baseline_commit || observed.claim.candidate_commit !== (attempt.candidate_commit || run.special_builder_dispatch?.completion_head)
    || observed.claim.candidate_tree !== (attempt.candidate_tree || resolveAttemptCandidateTree(runDir, run, attempt)) || observed.claim.review_ref !== reviewRef
    || closed.closure.review_ref !== reviewRef || attempt.review_hash && closed.closure.review_hash !== attempt.review_hash) {
    throw new Error("integration amendment review publication provenance is stale or cross-bound");
  }
}

function resolveAttemptCandidateTree(runDir, run, attempt) {
  const repository = resolveAuthorityRepository(runDir, run, { repoRoot: resolve(runDir, "../../..") });
  const candidate = run.special_builder_dispatch?.completion_head;
  const tree = candidate && git(repository, ["rev-parse", "--verify", `${candidate}^{tree}`]);
  return tree?.ok ? tree.stdout.trim() : "";
}

function assertIntegrationAmendmentChangedPathOwnership(run, amendment, changedPaths) {
  const ownership = createOwnershipIndex((run.slices || []).map((slice) => ({ id: slice.id, stack: slice.stack, effective_paths: slice.effective_paths })));
  for (const path of changedPaths) {
    const owners = ownership.owners(path);
    if (owners.length !== 1 || owners[0].id !== amendment.owner_slice_id || isPrivilegedControlPlanePath(path)) {
      throw new Error(`integration amendment changed path '${path}' is not solely owned by admitted owner '${amendment.owner_slice_id}'`);
    }
  }
}

function assertAmendmentIntegration(run, options) {
  const amendment = run.integration_amendment;
  const integration = amendment.integration;
  const attempt = amendment.attempts.at(-1);
  const repository = resolveAuthorityRepository(null, run, options);
  if (resolveRequiredCommit(repository, integration.ref, options, "integration amendment staging ref") !== integration.commit) throw new Error("integration amendment staging ref is stale");
  const parents = authorityGit(options, repository, ["rev-list", "--parents", "-n", "1", integration.commit]);
  const values = parents.ok ? parents.stdout.trim().split(/\s+/u) : [];
  if (values.length !== 3 || values[1] !== amendment.admission.baseline_commit || values[2] !== attempt.reviewed_commit) throw new Error("integration amendment staging commit must have exact ordered baseline/reviewed parents");
  const bases = authorityGit(options, repository, ["merge-base", "--all", amendment.admission.baseline_commit, attempt.reviewed_commit]);
  if (!bases.ok || bases.stdout.trim() !== amendment.admission.baseline_commit) throw new Error("integration amendment reviewed tree must have the unique admission baseline merge base");
  const tree = authorityGit(options, repository, ["rev-parse", "--verify", `${integration.commit}^{tree}`]);
  if (!tree.ok || tree.stdout.trim() !== attempt.reviewed_tree || integration.tree !== attempt.reviewed_tree) throw new Error("integration amendment staged tree differs from reviewed tree");
  const reviewedPaths = observeNoRenamePathSet(repository, amendment.admission.baseline_commit, attempt.reviewed_commit, options, "integration amendment reviewed diff");
  const integratedPaths = observeNoRenamePathSet(repository, amendment.admission.baseline_commit, integration.commit, options, "integration amendment staged diff");
  if (!sameStringSet(reviewedPaths, integratedPaths)) throw new Error("integration amendment staged changed paths differ from reviewed paths");
  assertIntegrationAmendmentChangedPathOwnership(run, amendment, [...reviewedPaths]);
  for (const path of reviewedPaths) {
    const literal = `:(literal)${path}`;
    const reviewedEntry = authorityGit(options, repository, ["ls-tree", "-z", attempt.reviewed_commit, "--", literal]);
    const integratedEntry = authorityGit(options, repository, ["ls-tree", "-z", integration.commit, "--", literal]);
    if (!reviewedEntry.ok || !integratedEntry.ok || reviewedEntry.stdout !== integratedEntry.stdout) throw new Error(`integration amendment staged path '${path}' differs from reviewed identity`);
  }
  createOrReplayDetachedAmendmentWorktree(repository, integration.worktree, integration.commit, options);
  const feature = resolveRequiredCommit(repository, amendment.admission.baseline_ref, options, "integration amendment feature ref");
  const allowedFeatureHeads = amendment.status === "verified" ? [amendment.admission.baseline_commit, integration.commit]
    : amendment.status === "merged" ? [integration.commit]
      : [amendment.admission.baseline_commit];
  if (!allowedFeatureHeads.includes(feature)) throw new Error("integration amendment feature ref is stale");
}

function observeCompletedAmendmentExecution(runDir, run, phase) {
  const amendment = run.integration_amendment;
  const claimRef = `evidence/integration-amendment-${amendment.amendment_id}.${phase}.claim.json`;
  const receiptRef = `evidence/integration-amendment-${amendment.amendment_id}.${phase}.receipt.json`;
  const claimPath = resolveEvidenceRef(runDir, claimRef).path;
  const receiptPath = resolveEvidenceRef(runDir, receiptRef).path;
  const claim = validateIntegrationAmendmentExecutionClaim(parseJsonObjectFile(claimPath, "integration amendment execution claim"));
  const receipt = validateIntegrationAmendmentExecutionReceipt(parseJsonObjectFile(receiptPath, "integration amendment execution receipt"));
  const receiptHash = hashFile(receiptPath);
  if (claim.phase !== phase || claim.state !== "completed" || claim.receipt_ref !== receiptRef || claim.receipt_hash !== receiptHash || claim.status !== receipt.status
    || receipt.claim_nonce !== claim.nonce || claim.run_id !== run.run_id || claim.amendment_id !== amendment.amendment_id
    || !sameJson(claim.probe, amendment.admission.probe) || !sameJson(receipt.probe, amendment.admission.probe)
    || claim.head_sha !== amendment.integration.commit || receipt.head_sha !== amendment.integration.commit
    || claim.tree_sha !== amendment.integration.tree || receipt.tree_sha !== amendment.integration.tree
    || resolve(claim.cwd) !== resolve(amendment.integration.worktree) || resolve(receipt.cwd) !== resolve(amendment.integration.worktree)) throw new Error("integration amendment execution claim/receipt is stale or cross-bound");
  return { claim, receipt, binding: { claim_ref: claimRef, claim_hash: hashFile(claimPath), receipt_ref: receiptRef, receipt_hash: receiptHash } };
}

function assertBoundAmendmentVerification(runDir, run) {
  const observed = observeCompletedAmendmentExecution(runDir, run, "verify");
  if (observed.claim.status !== "pass" || observed.receipt.review_ready !== true || !sameJson(observed.binding, run.integration_amendment.verification)) throw new Error("integration amendment passing verification binding is stale");
}

function observeFeatureWorktreeSnapshot(repository, worktree, featureBranch, baselineTree, integrationTree, featureHead, baselineCommit, integrationCommit, options) {
  const identity = checkWorktreeIdentity(repository, worktree, { branch: featureBranch, head: featureHead });
  const index = authorityGit(options, worktree, ["write-tree"]);
  const files = authorityGit(options, worktree, ["diff-files", "--quiet"]);
  const untracked = authorityGit(options, worktree, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const merge = authorityGit(options, worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  const rebase = existsSync(join(worktree, ".git", "rebase-merge")) || existsSync(join(worktree, ".git", "rebase-apply"));
  if (!identity.ok || !index.ok || !files.ok || !untracked.ok || untracked.stdout !== "" || merge.ok || rebase) return { case: "foreign-or-dirty" };
  if (index.stdout.trim() === integrationTree && featureHead === integrationCommit) return { case: "integration" };
  if (index.stdout.trim() === baselineTree && featureHead === baselineCommit) return { case: "baseline" };
  if (index.stdout.trim() === baselineTree && featureHead === integrationCommit) return { case: "pre-cas-baseline" };
  return { case: "foreign-or-dirty" };
}

function assertPublishedAmendment(run, options) {
  const amendment = run.integration_amendment;
  const repository = resolveAuthorityRepository(null, run, options);
  assertIntegrationAmendmentChangedPathOwnership(run, amendment, amendment.attempts.at(-1).changed_paths);
  if (resolveRequiredCommit(repository, amendment.publication.branch_ref, options, "integration amendment publication ref") !== amendment.integration.commit) throw new Error("integration amendment publication ref is stale");
  const featureHead = resolveRequiredCommit(repository, amendment.publication.branch_ref, options, "integration amendment publication ref");
  const featureBranch = amendment.admission.baseline_ref.slice("refs/heads/".length);
  const snapshot = observeFeatureWorktreeSnapshot(repository, amendment.admission.worktree, featureBranch, amendment.admission.baseline_tree, amendment.integration.tree, featureHead, amendment.admission.baseline_commit, amendment.integration.commit, options);
  if (snapshot.case !== "integration") throw new Error("integration amendment published worktree is stale or dirty");
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
  const result = await withRunJsonLock(runDir, async () => transitionRunJsonLocked(runDir, (draft, { current }) => {
    if (request.status === "reported" && current.merged_slice_repair == null) {
      const inventory = inspectIntegrationAmendmentInventory(runDir, current);
      if (inventory.classification !== "all-absent") throw new Error("legacy repair admission rejects an existing generic amendment tombstone");
    }
    const nextRepair = nextMergedSliceRepair(runDir, draft, draft.merged_slice_repair, request, options);
    if (request.status === "review" && current.merged_slice_repair?.status === "repairing") {
      consumeSpecialBuilderDispatch(runDir, current, draft, "merged-slice-repair", nextRepair.reviewed_commit);
    }
    draft.merged_slice_repair = nextRepair;
  }, options, { mergedSliceRepair: MERGED_SLICE_REPAIR_TRANSITION_AUTHORITY, consumeSpecialDispatch: request.status === "review" }), options);
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
  const amendment = run?.integration_amendment;
  if (amendment && typeof amendment === "object" && !Array.isArray(amendment) && amendment.status !== "merged") return amendment;
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
  if (request.status === "reported") return reportedMergedSliceRepair(runDir, run, current, request, stampedAt, options);
  if (!current) throw new Error("merged-slice repair must be reported before any other transition");
  if (request.status === "repairing") return repairingMergedSliceRepair(runDir, run, current, request, stampedAt, options);
  if (request.status === "review") return reviewMergedSliceRepair(runDir, run, current, request, stampedAt, options);
  if (request.status === "merged") return mergedMergedSliceRepair(runDir, run, current, request, stampedAt, options);
  return { ...current, status: "blocked", reason: request.reason, updated_at: stampedAt };
}

function reportedMergedSliceRepair(runDir, run, current, request, stampedAt, options = {}) {
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
  // The accepted plan remains freshness-bound at report time while lane
  // authority comes only from the owner's durable effective paths.
  const planHash = hashFile(join(runDir, "plan", "slices.json"));
  assertRepairPathInOwnerLane(runDir, run, owner.id, request.defect_path, planHash);
  const evidence = resolveEvidenceRef(runDir, request.evidence_ref);
  const evidenceJson = parseJsonObjectFile(evidence.path, "repair evidence_ref");
  if (evidenceJson.subject !== consumer.id) {
    throw new Error("repair evidence subject must equal the consumer slice id");
  }
  if (evidenceJson.status !== "fail") {
    throw new Error("repair reproduction evidence must record an observed failing consumer run (status \"fail\")");
  }
  rejectGenericEligibleLegacyRepairAdmission(runDir, run, request, options);
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

function rejectGenericEligibleLegacyRepairAdmission(runDir, run, request, options = {}) {
  const consumer = (run.slices || []).find((slice) => slice?.id === request.consumer_slice_id);
  const consumerKeys = new Set(["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts"]);
  if (consumer?.status !== "pending" || consumer.attempts !== 0 || Object.keys(consumer).some((key) => !consumerKeys.has(key))) return;
  let decomposition;
  try {
    decomposition = observeAcceptedDecompositionAuthority(runDir, run, { ...options, requireIntegrationGate: true, requireApprovingReview: true });
  } catch {
    return;
  }
  const artifacts = decomposition.plan.delivery_envelope?.delivery_units
    ?.find((unit) => unit.slice_id === consumer.id)?.verification_artifacts || [];
  for (const artifact of artifacts) {
    try {
      observeIntegrationAmendmentAdmission(runDir, run, {
        owner_slice_id: request.owner_slice_id,
        consumer_slice_id: request.consumer_slice_id,
        defect_path: request.defect_path,
        verification_artifact_id: artifact.id,
      }, options, { initial: true });
    } catch {
      continue;
    }
    throw new Error(`legacy merged-slice repair report is retired for this generic-eligible incident; use factory amendment ${run.run_id} report --owner-slice ${request.owner_slice_id} --consumer-slice ${request.consumer_slice_id} --defect-path ${request.defect_path} --artifact-id ${artifact.id} --json`);
  }
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

function reviewMergedSliceRepair(runDir, run, current, request, stampedAt, options = {}) {
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
    assertRepairPathInOwnerLane(runDir, run, current.owner_slice_id, normalizeRepairDefectPath(observedPath), current.plan_hash);
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
  const repairEvidence = assertRepairChangedPathsInOwnerLane(runDir, run, current, request.repair_evidence_ref, observedPaths);
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
// inside the owner's bound durable lane, and the recorded list must equal the
// git-observed diff — a claim that diverges from git is rejected outright.
function assertRepairChangedPathsInOwnerLane(runDir, run, current, evidenceRef, observedPaths) {
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
    assertRepairPathInOwnerLane(runDir, run, current.owner_slice_id, normalizeRepairDefectPath(changedPath), current.plan_hash);
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
    assertRepairPathInOwnerLane(runDir, run, current.owner_slice_id, normalizeRepairDefectPath(mergedPath), current.plan_hash);
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

function assertRepairPathInOwnerLane(runDir, run, ownerSliceId, defectPath, expectedPlanHash) {
  const planPath = join(runDir, "plan", "slices.json");
  if (requireNonEmptyString(expectedPlanHash, "repair plan_hash") !== hashFile(planPath)) {
    throw new Error("plan/slices.json no longer matches the lane authority bound when the repair was reported");
  }
  const plan = parseSlicesPlanBytes(readFileSync(planPath), { label: PLAN_SLICES_REF, enforceDependencyDepth: false });
  const planned = (Array.isArray(plan.slices) ? plan.slices : []).find((slice) => slice?.id === ownerSliceId);
  if (!planned) throw new Error(`repair owner slice '${ownerSliceId}' is missing from plan/slices.json`);
  const durable = (Array.isArray(run.slices) ? run.slices : []).map((slice) => ({ id: slice?.id, stack: slice?.stack, effective_paths: slice?.effective_paths }));
  const owner = (run.slices || []).find((slice) => slice?.id === ownerSliceId);
  if (!owner || owner.status !== "merged") throw new Error(`repair owner slice '${ownerSliceId}' must retain merged ownership authority`);
  const owners = createOwnershipIndex(durable).owners(defectPath);
  if (owners.length !== 1 || owners[0].id !== ownerSliceId) {
    throw new Error(`repair defect path '${defectPath}' is outside owner slice '${ownerSliceId}' lanes`);
  }
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
    base_sha: operation.base_sha,
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

async function observePrOperationGitAuthority(runDir, run, options = {}, label = "PR operation") {
  const integration = observeIntegrationHeadAuthority(run, { ...options, runDir }, `${label} authority`);
  const headRef = requireNonEmptyString(run.branch, "run.branch");
  const baseRef = localPrBaseRef(run);
  if (baseRef !== "main") throw new Error(`${label} requires canonical origin/main as the PR base`);
  if (!run.pr_mode || !["draft", "ready"].includes(run.pr_mode)) throw new Error(`${label} requires persisted run.pr_mode`);
  const recordedBase = requireNonEmptyString(run.base_commit, "run.base_commit");
  return withCanonicalOriginMain(integration.repository, recordedBase, (canonical) => {
    const headSha = observeExactRemoteHead(options, integration.repository, headRef, label);
    if (headSha !== integration.head) throw new Error(`${label} requires local, worktree, and origin head equality`);
    if (!authorityGit(options, integration.repository, ["merge-base", "--is-ancestor", recordedBase, headSha]).ok) throw new Error(`${label} requires run.base_commit to be an ancestor of the origin head`);
    return {
      repository: canonical.repository,
      origin: canonical.origin,
      head_ref: headRef,
      head_sha: headSha,
      base_ref: baseRef,
      base_sha: canonical.commit,
      draft: run.pr_mode === "draft",
      integration,
    };
  }, canonicalOriginOptions(options));
}

function canonicalOriginOptions(options) {
  const configured = isRecord(options.canonicalOriginOptions) ? { ...options.canonicalOriginOptions } : {};
  if (configured.gitOptions === undefined) {
    if (isRecord(options.gitOptions)) configured.gitOptions = options.gitOptions;
    else if (typeof options.gitFn === "function") configured.gitOptions = { spawnSync: gitFnSpawnAdapter(options.gitFn) };
  }
  return configured;
}

function gitFnSpawnAdapter(gitFn) {
  return (_file, args, spawnOptions = {}) => {
    const result = gitFn(spawnOptions.cwd, args);
    if (!isRecord(result) || typeof result.ok !== "boolean" || typeof result.stdout !== "string") {
      return { status: 128, stdout: "", stderr: "git authority observer returned an invalid result" };
    }
    return {
      status: Number.isInteger(result.status) ? result.status : result.ok ? 0 : 1,
      stdout: result.stdout,
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  };
}

function localPrBaseRef(run) {
  const ref = requireNonEmptyString(run.base_ref, "run.base_ref");
  for (const originPrefix of ["refs/remotes/origin/", "origin/"]) {
    if (ref.startsWith(originPrefix)) return ref.slice(originPrefix.length);
  }
  return ref;
}

function observeExactRemoteHead(options, repository, ref, label) {
  const result = authorityGit(options, repository, ["ls-remote", "--exit-code", "origin", `refs/heads/${ref}`]);
  if (!result.ok) throw new Error(`${label} requires exact origin head refs`);
  const lines = result.stdout.split("\n").filter(Boolean);
  const match = lines.length === 1 ? /^([0-9a-f]{40})\trefs\/heads\/(.+)$/u.exec(lines[0]) : null;
  if (!match || match[2] !== ref) throw new Error(`${label} requires one exact origin head ref for '${ref}'`);
  return match[1];
}

async function assertSamePrOperationGitAuthority(runDir, run, options, expected, label) {
  const current = await observePrOperationGitAuthority(runDir, run, options, label);
  if (!sameJson(current, expected)) throw new Error(`${label} Git authority changed before publication`);
  return current;
}

async function assertPrFenceGitAuthorityCurrent(runDir, run, fence, options = {}) {
  const authority = await observePrOperationGitAuthority(runDir, run, options, "PR operation reconciliation");
  const route = classifyWholeStoryTestRoute(runDir, run, options);
  if (route !== WHOLE_STORY_ROUTES.LEGACY) {
    const decision = evaluateWholeStoryRouteSink({
      route,
      sink: "SINK21",
      base: authority.base_sha === run.base_commit ? "equal" : "ancestor",
      head: "equal",
      review: "fresh",
      pr_mode: run.pr_mode,
    });
    if (!decision.allowed) throw new Error(`PR operation reconciliation denied: ${decision.reason}`);
  }
  const expected = {
    repository: authority.repository,
    head_ref: authority.head_ref,
    head_sha: authority.head_sha,
    base_ref: authority.base_ref,
    draft: authority.draft,
  };
  for (const [key, value] of Object.entries(expected)) if (fence[key] !== value) throw new Error(`pre-PR fence ${key} no longer matches local/origin authority`);
  const operationId = computePrOperationId({ base_commit: run.base_commit, branch: fence.head_ref, created_at: fence.created_at, repository: fence.repository, run_id: run.run_id });
  if (fence.operation_id !== operationId) throw new Error("pre-PR fence operation_id is stale or malformed");
  if (route !== WHOLE_STORY_ROUTES.LEGACY) assertWholeStorySinkAllowed({ route, sink: "SINK22", base: authority.base_sha === run.base_commit ? "equal" : "ancestor", head: "equal", review: "fresh", pr_mode: run.pr_mode });
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

function gitIntegrationConflictStatusArgs() {
  return ["status", "--porcelain=v1", "-z", "--untracked-files=no"];
}

function gitIntegrationConflictUntrackedArgs() {
  return [
    "ls-files", "--others", "--exclude-standard", "-z", "--", ".",
    ":(exclude,top,glob).opencode/factory/**",
    ":(exclude,top,glob).opencode/worktrees/**",
  ];
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
