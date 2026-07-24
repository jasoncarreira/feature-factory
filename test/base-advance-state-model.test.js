import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BASE_ADVANCE_ERROR_CODES,
  BASE_ADVANCE_STATE_DIMENSIONS,
  BASE_ADVANCE_STATE_MODEL,
  evaluateBaseAdvanceState,
} from "../src/base-advance/state-model.js";
import { eligibleBaseAdvanceState } from "./helpers/base-advance-state-model/state-fixture.js";

const CODES = BASE_ADVANCE_ERROR_CODES;
const ALLOW = Object.freeze({ disposition: "allow", code: null });
const EXPECTED_MODEL = Object.freeze({
  run_kind: rules(["ordinary"], { [CODES.ineligible]: ["non-ordinary"], [CODES.runInvalid]: ["malformed"] }),
  run_status: rules(["running-no-terminal"], {
    [CODES.ineligible]: ["running-with-terminal", "completed", "blocked", "partial", "needs-human"],
    [CODES.runInvalid]: ["malformed"],
  }),
  continuation_checkpoint: rules(["absent"], {
    [CODES.ineligible]: ["continuation-v1", "continuation-v2", "checkpoint-child", "checkpoint-parent"],
    [CODES.runInvalid]: ["contradictory", "malformed"],
  }),
  steering_queue: rules(["empty"], { [CODES.ineligible]: ["pending", "uncheckpointed"], [CODES.runInvalid]: ["malformed"] }),
  steering_boundary: rules(["absent"], { [CODES.ineligible]: ["current"], [CODES.runInvalid]: ["malformed"] }),
  steering_action: rules(["absent", "historical-settled"], { [CODES.ineligible]: ["active"], [CODES.runInvalid]: ["malformed"] }),
  steering_fence: rules(["absent"], { [CODES.ineligible]: ["current"], [CODES.runInvalid]: ["malformed"] }),
  pr_authority: rules(["absent"], {
    [CODES.ineligible]: ["pr-url", "operation", "fence", "terminal", "closed-unmerged"],
    [CODES.runInvalid]: ["contradictory", "malformed"],
  }),
  post_pr: rules(["disabled", "pristine-awaiting-pr"], {
    [CODES.ineligible]: ["active", "completed", "blocked", "bound"],
    [CODES.runInvalid]: ["contradictory", "malformed"],
  }),
  slices: rules(["empty", "pending", "running", "review", "mixed-active"], {
    [CODES.ineligible]: ["merged", "blocked"],
    [CODES.runInvalid]: ["malformed"],
  }),
  ordinary_dispatch: rules(["absent", "active-current-attempt", "closed", "historical", "adopted"], {
    [CODES.runInvalid]: ["malformed", "orphaned", "cross-bound", "contradictory"],
  }),
  test_execution: rules(["absent", "settled-historical"], {
    [CODES.ineligible]: ["active", "unknown"],
    [CODES.runInvalid]: ["malformed", "cross-bound"],
  }),
  special_dispatch: rules(["absent", "consumed-historical"], {
    [CODES.ineligible]: ["active", "closed-unconsumed", "unknown"],
    [CODES.runInvalid]: ["malformed", "orphaned", "cross-bound"],
  }),
  amendment: rules(["absent", "settled-no-manifest", "fully-merged-resolved"], {
    [CODES.ineligible]: ["active", "unknown", "unconsumed", "unresolved", "blocked"],
    [CODES.runInvalid]: ["malformed", "cross-bound"],
  }),
  repair: rules(["absent", "fully-merged-resolved"], {
    [CODES.ineligible]: ["reported", "repairing", "review", "blocked"],
    [CODES.runInvalid]: ["malformed", "cross-bound"],
  }),
  panels: rules(["absent"], { [CODES.ineligible]: ["validator", "security", "both"], [CODES.runInvalid]: ["malformed"] }),
  heartbeat: rules(["missing", "inactive", "pid-null"], {
    [CODES.ineligible]: ["live-matching"],
    [CODES.runInvalid]: ["indeterminate", "invalid", "uninspectable", "mismatched"],
  }),
  process: rules(["missing", "exited-matching"], {
    [CODES.ineligible]: ["live-matching", "running", "cancelled", "failed-closed"],
    [CODES.runInvalid]: ["invalid", "mismatched", "indeterminate"],
  }),
  launch_claim: rules(["absent"], {
    [CODES.lockContended]: ["live", "stale-unreconciled", "malformed", "changed", "indeterminate"],
  }),
  run_lock: rules(["acquired"], {
    [CODES.lockContended]: ["contended", "live-owner", "indeterminate-owner", "timeout", "changed-identity", "release-unprovable"],
  }),
  launch_fence: rules(["acquired-base-advance", "dead-base-advance-reclaimed"], {
    [CODES.lockContended]: ["live", "foreign", "ownerless", "malformed", "changed", "mismatched-kind", "indeterminate", "release-unprovable"],
  }),
  git_identity: rules(["registered-clean-attached"], {
    [CODES.gitStateInvalid]: [
      "dirty-tracked", "dirty-untracked", "detached", "wrong-branch", "branch-worktree-mismatch", "missing-worktree",
      "outside-worktree-root", "symlink-worktree", "duplicate-registration", "in-progress-operation", "invalid-commit", "unprovable",
    ],
  }),
  origin: rules(["exact-stable"], {
    [CODES.originUnavailable]: ["unavailable", "missing-origin", "missing-main"],
    [CODES.originAmbiguous]: [
      "multiple-origin", "noncanonical-origin", "malformed-remote-row", "multiple-remote-rows", "fetched-advertised-mismatch",
      "foreign-temp-ref", "ambiguous-ref",
    ],
    [CODES.targetMoved]: ["target-moved"],
  }),
  ancestry: rules(["ancestor", "equal"], { [CODES.nonFastForward]: ["non-descendant"], [CODES.gitStateInvalid]: ["unprovable"] }),
  crash_point: Object.freeze({
    "old-eligible": crashRule("fast-forward-and-bind", "advanced", true, false),
    "git-advanced-unbound": crashRule("bind", "advanced", true, false),
    "bound-current": crashRule("replay", "already-current", false, true),
    split: rejectRule(CODES.gitStateInvalid),
    unknown: rejectRule(CODES.gitStateInvalid),
    "target-moved-after-git": rejectRule(CODES.targetMoved),
  }),
});

describe("active-run base-advance eligibility state model", () => {
  it("pins every stable public error code to its documented literal", () => {
    assert.deepEqual(BASE_ADVANCE_ERROR_CODES, {
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
  });

  it("accepts the exact ordinary running pre-PR old-base state", () => {
    assert.deepEqual(evaluateBaseAdvanceState(eligibleBaseAdvanceState()), allowedResult(
      "fast-forward-and-bind",
      "advanced",
      true,
      false,
    ));
  });

  it("enumerates every required authority, process, Git, origin, and crash variant with an exact stable disposition", () => {
    assert.deepEqual(BASE_ADVANCE_STATE_DIMENSIONS, Object.keys(EXPECTED_MODEL));
    assert.equal(Object.isFrozen(BASE_ADVANCE_STATE_MODEL), true);

    for (const dimensionName of BASE_ADVANCE_STATE_DIMENSIONS) {
      const expectedDimension = EXPECTED_MODEL[dimensionName];
      assert.deepEqual(Object.keys(BASE_ADVANCE_STATE_MODEL[dimensionName]), Object.keys(expectedDimension), dimensionName);
      assert.equal(Object.isFrozen(BASE_ADVANCE_STATE_MODEL[dimensionName]), true, dimensionName);

      for (const [variant, expectedRule] of Object.entries(expectedDimension)) {
        assert.deepEqual(BASE_ADVANCE_STATE_MODEL[dimensionName][variant], expectedRule, `${dimensionName}:${variant}:rule`);
        const actual = evaluateBaseAdvanceState(eligibleBaseAdvanceState(
          compatibleOverrides(dimensionName, variant),
        ));
        const expected = expectedRule.disposition === "reject"
          ? rejectedResult(dimensionName, variant, expectedRule.code)
          : dimensionName === "ancestry" && variant === "equal"
            ? allowedResult("replay", "already-current", false, true)
            : dimensionName === "crash_point"
            ? allowedResult(expectedRule.action, expectedRule.success_disposition, expectedRule.updated, expectedRule.replayed)
            : allowedResult("fast-forward-and-bind", "advanced", true, false);
        assert.deepEqual(actual, expected, `${dimensionName}:${variant}:evaluation`);
      }
    }
  });

  it("requires zero merged or blocked slices and preserves the exact three crash actions", () => {
    assert.deepEqual(evaluateBaseAdvanceState(eligibleBaseAdvanceState({ slices: "merged" })),
      rejectedResult("slices", "merged", CODES.ineligible));
    assert.deepEqual(evaluateBaseAdvanceState(eligibleBaseAdvanceState({ slices: "blocked" })),
      rejectedResult("slices", "blocked", CODES.ineligible));
    assert.deepEqual(evaluateBaseAdvanceState(eligibleBaseAdvanceState({ crash_point: "git-advanced-unbound" })),
      allowedResult("bind", "advanced", true, false));
    assert.deepEqual(evaluateBaseAdvanceState(eligibleBaseAdvanceState({ ancestry: "equal", crash_point: "bound-current" })),
      allowedResult("replay", "already-current", false, true));
  });

  it("accepts only the three canonical ancestry and crash-point pairs", () => {
    const cases = [
      ["ancestor", "old-eligible", allowedResult("fast-forward-and-bind", "advanced", true, false)],
      ["ancestor", "git-advanced-unbound", allowedResult("bind", "advanced", true, false)],
      ["ancestor", "bound-current", rejectedResult("crash_point", "bound-current", "BASE_ADVANCE_GIT_STATE_INVALID")],
      ["equal", "old-eligible", rejectedResult("crash_point", "old-eligible", "BASE_ADVANCE_GIT_STATE_INVALID")],
      ["equal", "git-advanced-unbound", rejectedResult("crash_point", "git-advanced-unbound", "BASE_ADVANCE_GIT_STATE_INVALID")],
      ["equal", "bound-current", allowedResult("replay", "already-current", false, true)],
    ];

    for (const [ancestry, crashPoint, expected] of cases) {
      assert.deepEqual(
        evaluateBaseAdvanceState(eligibleBaseAdvanceState({ ancestry, crash_point: crashPoint })),
        expected,
        `${ancestry}:${crashPoint}`,
      );
    }
  });

  it("fails closed for missing, unknown, extra, and non-record observations", () => {
    const missing = eligibleBaseAdvanceState();
    delete missing.origin;
    assert.deepEqual(evaluateBaseAdvanceState(missing), rejectedResult("origin", "missing", CODES.runInvalid));
    assert.deepEqual(evaluateBaseAdvanceState(eligibleBaseAdvanceState({ origin: "tracking-ref" })),
      rejectedResult("origin", "unknown-variant", CODES.runInvalid));
    assert.deepEqual(evaluateBaseAdvanceState({ ...eligibleBaseAdvanceState(), target_sha: "caller-value" }),
      rejectedResult("model", "unknown-dimension", CODES.runInvalid));
    for (const value of [null, [], "ordinary", 1]) {
      assert.deepEqual(evaluateBaseAdvanceState(value), rejectedResult("model", "invalid-observation", CODES.runInvalid));
    }
  });

  it("uses deterministic dimension order when multiple observations reject", () => {
    assert.deepEqual(evaluateBaseAdvanceState(eligibleBaseAdvanceState({
      run_status: "blocked",
      process: "live-matching",
      origin: "unavailable",
    })), rejectedResult("run_status", "blocked", CODES.ineligible));
  });
});

function compatibleOverrides(dimensionName, variant) {
  if (dimensionName === "ancestry" && variant === "equal") {
    return { ancestry: variant, crash_point: "bound-current" };
  }
  if (dimensionName === "crash_point" && variant === "bound-current") {
    return { ancestry: "equal", crash_point: variant };
  }
  return { [dimensionName]: variant };
}

function rules(allowed, rejectedByCode = {}) {
  const result = {};
  for (const variant of allowed) result[variant] = ALLOW;
  for (const [code, variants] of Object.entries(rejectedByCode)) {
    for (const variant of variants) result[variant] = rejectRule(code);
  }
  return Object.freeze(result);
}

function rejectRule(code) {
  return Object.freeze({ disposition: "reject", code });
}

function crashRule(action, successDisposition, updated, replayed) {
  return Object.freeze({ disposition: "allow", code: null, action, success_disposition: successDisposition, updated, replayed });
}

function allowedResult(action, successDisposition, updated, replayed) {
  return { eligible: true, disposition: "allow", code: null, action, success_disposition: successDisposition, updated, replayed };
}

function rejectedResult(dimension, variant, code) {
  return { eligible: false, disposition: "reject", dimension, variant, code };
}
