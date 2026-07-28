export const BASE_ADVANCE_ERROR_CODES = Object.freeze({
  usage: "BASE_ADVANCE_USAGE",
  runInvalid: "BASE_ADVANCE_RUN_INVALID",
  ineligible: "BASE_ADVANCE_INELIGIBLE",
  lockContended: "BASE_ADVANCE_LOCK_CONTENDED",
  originUnavailable: "BASE_ADVANCE_ORIGIN_UNAVAILABLE",
  originAmbiguous: "BASE_ADVANCE_ORIGIN_AMBIGUOUS",
  nonFastForward: "BASE_ADVANCE_NON_FAST_FORWARD",
  gitStateInvalid: "BASE_ADVANCE_GIT_STATE_INVALID",
  targetMoved: "BASE_ADVANCE_TARGET_MOVED",
  publishFailed: "BASE_ADVANCE_PUBLISH_FAILED",
  tempRefCleanupFailed: "BASE_ADVANCE_TEMP_REF_CLEANUP_FAILED",
  failed: "BASE_ADVANCE_FAILED",
});

const ALLOW = Object.freeze({ disposition: "allow", code: null });
const INELIGIBLE = rejected(BASE_ADVANCE_ERROR_CODES.ineligible);
const RUN_INVALID = rejected(BASE_ADVANCE_ERROR_CODES.runInvalid);
const LOCK_CONTENDED = rejected(BASE_ADVANCE_ERROR_CODES.lockContended);
const GIT_STATE_INVALID = rejected(BASE_ADVANCE_ERROR_CODES.gitStateInvalid);
const ORIGIN_UNAVAILABLE = rejected(BASE_ADVANCE_ERROR_CODES.originUnavailable);
const ORIGIN_AMBIGUOUS = rejected(BASE_ADVANCE_ERROR_CODES.originAmbiguous);
const NON_FAST_FORWARD = rejected(BASE_ADVANCE_ERROR_CODES.nonFastForward);
const TARGET_MOVED = rejected(BASE_ADVANCE_ERROR_CODES.targetMoved);

/**
 * Closed model consumed by the checked transition after repository state has
 * been normalized. It deliberately contains no filesystem, process, or Git
 * observation logic: those adapters must classify every observation into one
 * of these variants before this model can grant movement or publication.
 */
export const BASE_ADVANCE_STATE_MODEL = Object.freeze({
  run_kind: dimension({
    ordinary: ALLOW,
    "non-ordinary": INELIGIBLE,
    malformed: RUN_INVALID,
  }),
  run_status: dimension({
    "running-no-terminal": ALLOW,
    "running-with-terminal": INELIGIBLE,
    completed: INELIGIBLE,
    blocked: INELIGIBLE,
    partial: INELIGIBLE,
    "needs-human": INELIGIBLE,
    malformed: RUN_INVALID,
  }),
  continuation_checkpoint: dimension({
    absent: ALLOW,
    "continuation-v2": INELIGIBLE,
    "checkpoint-child": INELIGIBLE,
    "checkpoint-parent": INELIGIBLE,
    contradictory: RUN_INVALID,
    malformed: RUN_INVALID,
  }),
  steering_queue: dimension({
    empty: ALLOW,
    pending: INELIGIBLE,
    uncheckpointed: INELIGIBLE,
    malformed: RUN_INVALID,
  }),
  steering_boundary: dimension({
    absent: ALLOW,
    current: INELIGIBLE,
    malformed: RUN_INVALID,
  }),
  steering_action: dimension({
    absent: ALLOW,
    "historical-settled": ALLOW,
    active: INELIGIBLE,
    malformed: RUN_INVALID,
  }),
  steering_fence: dimension({
    absent: ALLOW,
    current: INELIGIBLE,
    malformed: RUN_INVALID,
  }),
  pr_authority: dimension({
    absent: ALLOW,
    "pr-url": INELIGIBLE,
    operation: INELIGIBLE,
    fence: INELIGIBLE,
    terminal: INELIGIBLE,
    "closed-unmerged": INELIGIBLE,
    contradictory: RUN_INVALID,
    malformed: RUN_INVALID,
  }),
  post_pr: dimension({
    disabled: ALLOW,
    "pristine-awaiting-pr": ALLOW,
    active: INELIGIBLE,
    completed: INELIGIBLE,
    blocked: INELIGIBLE,
    bound: INELIGIBLE,
    contradictory: RUN_INVALID,
    malformed: RUN_INVALID,
  }),
  slices: dimension({
    empty: ALLOW,
    pending: ALLOW,
    running: ALLOW,
    review: ALLOW,
    "mixed-active": ALLOW,
    merged: INELIGIBLE,
    blocked: INELIGIBLE,
    malformed: RUN_INVALID,
  }),
  ordinary_dispatch: dimension({
    absent: ALLOW,
    "active-current-attempt": ALLOW,
    closed: ALLOW,
    historical: ALLOW,
    adopted: ALLOW,
    malformed: RUN_INVALID,
    orphaned: RUN_INVALID,
    "cross-bound": RUN_INVALID,
    contradictory: RUN_INVALID,
  }),
  test_execution: dimension({
    absent: ALLOW,
    "settled-historical": ALLOW,
    active: INELIGIBLE,
    unknown: INELIGIBLE,
    malformed: RUN_INVALID,
    "cross-bound": RUN_INVALID,
  }),
  special_dispatch: dimension({
    absent: ALLOW,
    "consumed-historical": ALLOW,
    active: INELIGIBLE,
    "closed-unconsumed": INELIGIBLE,
    unknown: INELIGIBLE,
    malformed: RUN_INVALID,
    orphaned: RUN_INVALID,
    "cross-bound": RUN_INVALID,
  }),
  amendment: dimension({
    absent: ALLOW,
    "settled-no-manifest": ALLOW,
    "fully-merged-resolved": ALLOW,
    active: INELIGIBLE,
    unknown: INELIGIBLE,
    unconsumed: INELIGIBLE,
    unresolved: INELIGIBLE,
    blocked: INELIGIBLE,
    malformed: RUN_INVALID,
    "cross-bound": RUN_INVALID,
  }),
  panels: dimension({
    absent: ALLOW,
    validator: INELIGIBLE,
    security: INELIGIBLE,
    both: INELIGIBLE,
    malformed: RUN_INVALID,
  }),
  heartbeat: dimension({
    missing: ALLOW,
    inactive: ALLOW,
    "pid-null": ALLOW,
    "live-matching": INELIGIBLE,
    indeterminate: RUN_INVALID,
    invalid: RUN_INVALID,
    uninspectable: RUN_INVALID,
    mismatched: RUN_INVALID,
  }),
  process: dimension({
    missing: ALLOW,
    "exited-matching": ALLOW,
    "live-matching": INELIGIBLE,
    running: INELIGIBLE,
    cancelled: INELIGIBLE,
    "failed-closed": INELIGIBLE,
    invalid: RUN_INVALID,
    mismatched: RUN_INVALID,
    indeterminate: RUN_INVALID,
  }),
  launch_claim: dimension({
    absent: ALLOW,
    live: LOCK_CONTENDED,
    "stale-unreconciled": LOCK_CONTENDED,
    malformed: LOCK_CONTENDED,
    changed: LOCK_CONTENDED,
    indeterminate: LOCK_CONTENDED,
  }),
  run_lock: dimension({
    acquired: ALLOW,
    contended: LOCK_CONTENDED,
    "live-owner": LOCK_CONTENDED,
    "indeterminate-owner": LOCK_CONTENDED,
    timeout: LOCK_CONTENDED,
    "changed-identity": LOCK_CONTENDED,
    "release-unprovable": LOCK_CONTENDED,
  }),
  launch_fence: dimension({
    "acquired-base-advance": ALLOW,
    "dead-base-advance-reclaimed": ALLOW,
    live: LOCK_CONTENDED,
    foreign: LOCK_CONTENDED,
    ownerless: LOCK_CONTENDED,
    malformed: LOCK_CONTENDED,
    changed: LOCK_CONTENDED,
    "mismatched-kind": LOCK_CONTENDED,
    indeterminate: LOCK_CONTENDED,
    "release-unprovable": LOCK_CONTENDED,
  }),
  git_identity: dimension({
    "registered-clean-attached": ALLOW,
    "dirty-tracked": GIT_STATE_INVALID,
    "dirty-untracked": GIT_STATE_INVALID,
    detached: GIT_STATE_INVALID,
    "wrong-branch": GIT_STATE_INVALID,
    "branch-worktree-mismatch": GIT_STATE_INVALID,
    "missing-worktree": GIT_STATE_INVALID,
    "outside-worktree-root": GIT_STATE_INVALID,
    "symlink-worktree": GIT_STATE_INVALID,
    "duplicate-registration": GIT_STATE_INVALID,
    "in-progress-operation": GIT_STATE_INVALID,
    "invalid-commit": GIT_STATE_INVALID,
    unprovable: GIT_STATE_INVALID,
  }),
  origin: dimension({
    "exact-stable": ALLOW,
    unavailable: ORIGIN_UNAVAILABLE,
    "missing-origin": ORIGIN_UNAVAILABLE,
    "missing-main": ORIGIN_UNAVAILABLE,
    "multiple-origin": ORIGIN_AMBIGUOUS,
    "noncanonical-origin": ORIGIN_AMBIGUOUS,
    "malformed-remote-row": ORIGIN_AMBIGUOUS,
    "multiple-remote-rows": ORIGIN_AMBIGUOUS,
    "fetched-advertised-mismatch": ORIGIN_AMBIGUOUS,
    "foreign-temp-ref": ORIGIN_AMBIGUOUS,
    "ambiguous-ref": ORIGIN_AMBIGUOUS,
    "target-moved": TARGET_MOVED,
  }),
  ancestry: dimension({
    ancestor: ALLOW,
    equal: ALLOW,
    "non-descendant": NON_FAST_FORWARD,
    unprovable: GIT_STATE_INVALID,
  }),
  crash_point: dimension({
    "old-eligible": allowedCrash("fast-forward-and-bind", "advanced", true, false),
    "git-advanced-unbound": allowedCrash("bind", "advanced", true, false),
    "bound-current": allowedCrash("replay", "already-current", false, true),
    split: GIT_STATE_INVALID,
    unknown: GIT_STATE_INVALID,
    "target-moved-after-git": TARGET_MOVED,
  }),
});

export const BASE_ADVANCE_STATE_DIMENSIONS = Object.freeze(Object.keys(BASE_ADVANCE_STATE_MODEL));

export function evaluateBaseAdvanceState(observation) {
  if (!isPlainRecord(observation)) return invalidModelResult("invalid-observation");

  const observedKeys = Object.keys(observation);
  if (observedKeys.some((key) => !Object.hasOwn(BASE_ADVANCE_STATE_MODEL, key))) {
    return invalidModelResult("unknown-dimension");
  }

  for (const dimensionName of BASE_ADVANCE_STATE_DIMENSIONS) {
    if (!Object.hasOwn(observation, dimensionName)) {
      return rejectedResult(dimensionName, "missing", BASE_ADVANCE_ERROR_CODES.runInvalid);
    }
    const variant = observation[dimensionName];
    const rule = typeof variant === "string" ? BASE_ADVANCE_STATE_MODEL[dimensionName][variant] : undefined;
    if (!rule) return rejectedResult(dimensionName, "unknown-variant", BASE_ADVANCE_ERROR_CODES.runInvalid);
    if (rule.disposition === "reject") return rejectedResult(dimensionName, variant, rule.code);
  }

  if (!isValidCrashAncestryPair(observation.ancestry, observation.crash_point)) {
    return rejectedResult(
      "crash_point",
      observation.crash_point,
      BASE_ADVANCE_ERROR_CODES.gitStateInvalid,
    );
  }

  const crash = BASE_ADVANCE_STATE_MODEL.crash_point[observation.crash_point];
  return {
    eligible: true,
    disposition: "allow",
    code: null,
    action: crash.action,
    success_disposition: crash.success_disposition,
    updated: crash.updated,
    replayed: crash.replayed,
  };
}

function isValidCrashAncestryPair(ancestry, crashPoint) {
  return (ancestry === "ancestor"
      && (crashPoint === "old-eligible" || crashPoint === "git-advanced-unbound"))
    || (ancestry === "equal" && crashPoint === "bound-current");
}

function dimension(variants) {
  return Object.freeze(variants);
}

function rejected(code) {
  return Object.freeze({ disposition: "reject", code });
}

function allowedCrash(action, successDisposition, updated, replayed) {
  return Object.freeze({
    disposition: "allow",
    code: null,
    action,
    success_disposition: successDisposition,
    updated,
    replayed,
  });
}

function rejectedResult(dimensionName, variant, code) {
  return { eligible: false, disposition: "reject", dimension: dimensionName, variant, code };
}

function invalidModelResult(variant) {
  return rejectedResult("model", variant, BASE_ADVANCE_ERROR_CODES.runInvalid);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
