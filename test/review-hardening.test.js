import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "./helpers/git-fixture.js";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { transitionRunSlice, transitionSteeringQueued, transitionSteeringConsumed } from "../src/run-state.js";
import { normalizeCostAttribution } from "../src/cost-attribution.js";
import { runAttributes, sanitizeOtlpEnv, validateTracestate } from "../src/telemetry.js";
import { collectProtectedSteeringState } from "../src/steering-conflicts.js";
import { cancelFactoryRun, cleanupRun, continueFactory, recordCostUsage, startFactory } from "../src/factory.js";
import { SLICE_FIX_CLASSIFICATIONS, SLICE_FIX_SCOPE_EFFECTS, sliceReviewTaskContext, validateSliceReviewFeasibility, validateSliceReviewResult } from "../src/validate.js";
import { withDeliveryEnvelope } from "./helpers/delivery-envelope-fixture.js";

const NOW = "2026-07-09T15:00:00.000Z";

function classifiedReview(classifications, { attempt = 1, convergence = "converging", lateDiscoveryStrike = false, schemaVersion = 2, scopeEffect = "in-lane", likelyPaths = ["src/fix.js"], fixOwner = "slice" } = {}) {
  return {
    attempt,
    verdict: "REJECT",
    convergence,
    late_discovery_strike: lateDiscoveryStrike,
    required_fixes: classifications.map((_, index) => `fix-${index + 1}`),
    remaining_fix_count: classifications.length,
    ownership_ratification: { schema_version: 1, paths: [] },
    remediation_context: {
      schema_version: schemaVersion,
      fixes: classifications.map((classification, required_fix_index) => ({
        required_fix_index,
        classification,
        ...(schemaVersion === 2 ? { scope_effect: scopeEffect, likely_paths: likelyPaths, fix_owner: fixOwner } : {}),
      })),
    },
  };
}

describe("steering consume crash recovery", () => {
  it("finishes an interrupted consume whose pending file was already renamed", async () => {
    const runDir = createRunDir("steer-crash");
    try {
      await transitionSteeringQueued(runDir, "resume after the crash", { now: NOW });
      const run = readJson(join(runDir, "run.json"));
      const pending = run.steering.pending;

      // Simulate a crash between the consume's rename and its run.json write:
      // the file sits at a consumed path while run.json still says pending.
      const consumedName = basename(pending.ref).replace(/^pending-/u, "consumed-");
      renameSync(join(runDir, pending.ref), join(runDir, "steering", consumedName));

      const consumed = await transitionSteeringConsumed(runDir, { ref: pending.ref, hash: pending.hash }, { now: NOW });

      assert.equal(consumed.steering.message, "resume after the crash");
      assert.equal(consumed.steering.trust, "untrusted-operator-data");
      assert.equal(consumed.steering.ref, `steering/${consumedName}`);
      const after = readJson(join(runDir, "run.json"));
      assert.equal(after.steering.pending, null);
      assert.equal(after.steering.history.at(-1).event, "consumed");
      assert.equal(after.steering.history.at(-1).ref, `steering/${consumedName}`);
    } finally {
      cleanupDir(runDir);
    }
  });
});

describe("slice merge transition guard", () => {
  it("rejects direct status merged writes through transitionRunSlice", async () => {
    const runDir = createRunDir("slice-merged-guard", {
      slices: [{ id: "s1", declared_paths: ["s1.txt"], effective_paths: ["s1.txt"], status: "running", attempts: 1 }],
    });
    try {
      await assert.rejects(
        transitionRunSlice(runDir, "s1", { status: "merged", merge_commit: "abc1234" }),
        /merges must use transitionSliceMerged/u,
      );
      assert.equal(readJson(join(runDir, "run.json")).slices[0].status, "running");
    } finally {
      cleanupDir(runDir);
    }
  });

  it("refuses to roll a merged slice back to running/review/blocked via transitionRunSlice", async () => {
    const reviewedCommit = "c".repeat(40);
    const evidence = { subject: "s1", attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommit };
    const review = { subject: "s1", attempt: 1, reviewed_commit: reviewedCommit, verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0, required_fixes: [], ownership_ratification: { schema_version: 1, paths: [] }, remediation_context: { schema_version: 2, fixes: [] } };
    const evidenceHash = jsonHash(evidence);
    const reviewHash = jsonHash(review);
    const runDir = createRunDir("slice-merged-immutable", {
      slices: [{
        id: "s1", declared_paths: ["s1.txt"], effective_paths: ["s1.txt"], status: "merged", merge_commit: "abc1234", review_ref: "reviews/s1.json", review_hash: reviewHash,
        evidence_ref: "evidence/s1.json", evidence_hash: evidenceHash, reviewed_commit: reviewedCommit, attempts: 1,
        attempt_reviews: [{ attempt: 1, evidence_ref: "evidence/s1.json", evidence_hash: evidenceHash, review_ref: "reviews/s1.json", review_hash: reviewHash, reviewed_commit: reviewedCommit, diff_base_commit: reviewedCommit, ratified_paths: [], verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0 }],
      }],
    });
    try {
      mkdirSync(join(runDir, "evidence"), { recursive: true });
      mkdirSync(join(runDir, "reviews"), { recursive: true });
      writeJson(join(runDir, "evidence", "s1.json"), evidence);
      writeJson(join(runDir, "reviews", "s1.json"), review);
      for (const status of ["running", "review", "blocked"]) {
        await assert.rejects(
          transitionRunSlice(runDir, "s1", { status }, { mustExist: true }),
          new RegExp(`slice 's1' cannot transition from merged to ${status}`, "u"),
          `status=${status}`,
        );
      }
      assert.equal(readJson(join(runDir, "run.json")).slices[0].status, "merged");
    } finally {
      cleanupDir(runDir);
    }
  });
});

describe("slice remediation task context", () => {
  it("reuses context only for an all-narrow fix list", () => {
    for (const classification of SLICE_FIX_CLASSIFICATIONS) {
      const review = classifiedReview([classification], { convergence: classification === "nonconvergent" ? "nonconvergent" : "converging" });
      assert.equal(sliceReviewTaskContext(review, { sliceId: "slice" }), classification === "narrow-correction" ? "reuse" : "fresh", classification);
    }
    assert.equal(sliceReviewTaskContext(classifiedReview(["narrow-correction", "schema-redesign"])), "fresh");
  });

  it("requires one ordered closed classification for every required fix", () => {
    const missing = classifiedReview(["narrow-correction"]);
    delete missing.remediation_context;
    assert.throws(() => validateSliceReviewResult(missing), /remediation_context.*required/u);

    const unknown = classifiedReview(["unknown"]);
    assert.throws(() => validateSliceReviewResult(unknown), /classification.*one of/u);

    // A miscounted required_fix_index is absorbed: the index is the fix's
    // position in the array, so the echoed value is accepted and ignored rather
    // than burning an attempt over bookkeeping. The republished context carries
    // the derived positions.
    const miscounted = classifiedReview(["narrow-correction", "narrow-correction"]);
    miscounted.remediation_context.fixes[1].required_fix_index = 0;
    assert.equal(validateSliceReviewResult(miscounted).verdict, "REJECT");

    const incomplete = classifiedReview(["narrow-correction", "narrow-correction"]);
    incomplete.remediation_context.fixes.pop();
    assert.throws(() => validateSliceReviewResult(incomplete), /classify every required fix exactly once/u);
  });

  it("no longer cross-checks the doubly encoded nonconvergence", () => {
    // `review.convergence` is the routed field; the per-fix `nonconvergent`
    // classification restated it, and the two had to agree exactly. Either
    // direction of disagreement now validates, and convergence is reported from
    // the routed field alone.
    const fixClassifiedOnly = validateSliceReviewResult(classifiedReview(["nonconvergent"]));
    assert.equal(fixClassifiedOnly.convergence, "converging");

    const reviewMarkedOnly = validateSliceReviewResult(classifiedReview(["narrow-correction"], { convergence: "nonconvergent" }));
    assert.equal(reviewMarkedOnly.convergence, "nonconvergent");
  });

  it("validates the required late-discovery strike shape", () => {
    const strike = classifiedReview(["narrow-correction"], { attempt: 2, lateDiscoveryStrike: true });
    assert.equal(validateSliceReviewResult(strike).late_discovery_strike, true);

    const missing = classifiedReview(["narrow-correction"]);
    delete missing.late_discovery_strike;
    assert.throws(() => validateSliceReviewResult(missing), /late_discovery_strike.*must be a boolean/u);

    const wrongType = classifiedReview(["narrow-correction"]);
    wrongType.late_discovery_strike = "true";
    assert.throws(() => validateSliceReviewResult(wrongType), /late_discovery_strike.*boolean/u);

    const terminalStrike = classifiedReview(["nonconvergent"], { convergence: "nonconvergent" });
    terminalStrike.late_discovery_strike = true;
    assert.throws(() => validateSliceReviewResult(terminalStrike), /requires a converging REJECT/u);

    const approvingStrike = classifiedReview([]);
    approvingStrike.verdict = "APPROVE";
    approvingStrike.late_discovery_strike = true;
    assert.throws(() => validateSliceReviewResult(approvingStrike), /requires a converging REJECT/u);
  });

  it("rejects schema-v1 and unstructured slice reviews for validation, task context, and feasibility", () => {
    const schemaV1 = classifiedReview(["narrow-correction"], { schemaVersion: 1 });
    const unstructured = classifiedReview(["narrow-correction"]);
    delete unstructured.remediation_context;
    for (const [name, review, expected] of [
      ["schema-v1", schemaV1, /schema_version.*must equal 2/u],
      ["unstructured", unstructured, /remediation_context.*required/u],
    ]) {
      assert.throws(() => validateSliceReviewResult(review), expected, name);
      assert.throws(() => sliceReviewTaskContext(review), expected, name);
      assert.throws(() => validateSliceReviewFeasibility(review, feasibilityPlan(), { sliceId: "slice" }), expected, name);
    }
  });

  it("requires every v2 positional fix to carry closed canonical feasibility fields", () => {
    for (const field of ["scope_effect", "likely_paths", "fix_owner"]) {
      const review = classifiedReview(["narrow-correction"]);
      delete review.remediation_context.fixes[0][field];
      assert.throws(() => validateSliceReviewResult(review), new RegExp(field, "u"), field);
    }
    for (const scopeEffect of SLICE_FIX_SCOPE_EFFECTS) {
      const review = classifiedReview(["narrow-correction"], { scopeEffect });
      assert.equal(validateSliceReviewResult(review).task_context, "reuse", scopeEffect);
    }
    for (const likelyPaths of [[], ["src/*.js"], ["/src/fix.js"], ["src/../fix.js"], ["src/fix.js", "src/fix.js"]]) {
      const review = classifiedReview(["narrow-correction"], { likelyPaths });
      assert.throws(() => validateSliceReviewResult(review), /likely_paths|canonical concrete|unique paths/u, JSON.stringify(likelyPaths));
    }
  });

  it("rejects each closed-schema and canonical-path violation at its exact field", () => {
    const cases = [
      ["extra remediation context key", (review) => { review.remediation_context.extra = true; }, "review.remediation_context.extra", /is not allowed/u],
      ["extra v2 fix key", (review) => { review.remediation_context.fixes[0].extra = true; }, "review.remediation_context.fixes[0].extra", /is not allowed/u],
      ["unknown scope_effect", (review) => { review.remediation_context.fixes[0].scope_effect = "adjacent"; }, "review.remediation_context.fixes[0].scope_effect", /must be one of/u],
      ["non-NFC likely path", (review) => { review.remediation_context.fixes[0].likely_paths = ["src/cafe\u0301.js"]; }, "review.remediation_context.fixes[0].likely_paths[0]", /canonical concrete repository path/u],
      ["backslash likely path", (review) => { review.remediation_context.fixes[0].likely_paths = ["src\\fix.js"]; }, "review.remediation_context.fixes[0].likely_paths[0]", /canonical concrete repository path/u],
    ];
    for (const [name, mutate, expectedPath, expectedMessage] of cases) {
      const review = classifiedReview(["narrow-correction"]);
      mutate(review);
      assert.throws(() => validateSliceReviewResult(review), (error) => {
        assert.equal(error.errors.some((item) => item.path === expectedPath && expectedMessage.test(item.message)), true, name);
        return true;
      });
    }
  });

  it("mechanically accepts each unambiguous plan-aware scope forecast", () => {
    const plan = feasibilityPlan();
    for (const [scopeEffect, likelyPaths, fixOwner] of [
      ["in-lane", ["src/fix.js"], "slice"],
      ["unowned-extension", ["docs/fix.md"], "slice"],
      ["sibling-owned", ["test/fix.test.js"], "sibling"],
      ["contract-change", ["src/public-contract.js"], "sibling"],
    ]) {
      const review = classifiedReview(["narrow-correction"], { scopeEffect, likelyPaths, fixOwner });
      assert.deepEqual(validateSliceReviewFeasibility(review, plan, { sliceId: "slice" }), {
        schema_version: 2,
        slice_id: "slice",
        fixes: [{ required_fix_index: 0, classification: "narrow-correction", scope_effect: scopeEffect, likely_paths: likelyPaths, fix_owner: fixOwner }],
      }, scopeEffect);
    }
  });

  it("uses the admitted exact-file and recursive-directory lane grammar for feasibility", () => {
    for (const [lane, likelyPath] of [["src/fix.js", "src/fix.js"], ["src/**", "src/nested/fix.js"]]) {
      const plan = feasibilityPlan();
      plan.slices[0].paths = [lane];
      const review = classifiedReview(["narrow-correction"], { likelyPaths: [likelyPath] });
      assert.equal(validateSliceReviewFeasibility(review, plan, { sliceId: "slice" }).fixes[0].likely_paths[0], likelyPath, lane);
    }
    for (const lane of ["src/", "src/*.js", "src/**/fix.js"]) {
      const plan = feasibilityPlan();
      plan.slices[0].paths = [lane];
      assert.throws(
        () => validateSliceReviewFeasibility(classifiedReview(["narrow-correction"]), plan, { sliceId: "slice" }),
        /invalid or ambiguous ownership lane/u,
        lane,
      );
    }
  });

  it("fails closed for ambiguous, overlapping, mixed, missing-owner, and mismatched forecasts", () => {
    const cases = [
      ["overlap", classifiedReview(["narrow-correction"]), feasibilityPlan({ overlap: true }), /sole plan owner/u],
      ["mixed sibling ownership", classifiedReview(["narrow-correction"], { scopeEffect: "sibling-owned", likelyPaths: ["test/a.js", "src/a.js"], fixOwner: "sibling" }), feasibilityPlan(), /sole plan owner/u],
      ["owned extension", classifiedReview(["narrow-correction"], { scopeEffect: "unowned-extension", likelyPaths: ["src/a.js"] }), feasibilityPlan(), /zero plan owners/u],
      ["missing owner", classifiedReview(["narrow-correction"], { fixOwner: "missing" }), feasibilityPlan(), /existing current-plan slice id/u],
      ["same-slice sibling", classifiedReview(["narrow-correction"], { scopeEffect: "sibling-owned" }), feasibilityPlan(), /must differ from the reviewed slice/u],
      ["invalid plan lane", classifiedReview(["narrow-correction"]), { ...feasibilityPlan(), slices: [{ ...feasibilityPlan().slices[0], paths: ["src/*"] }, feasibilityPlan().slices[1]] }, /invalid or ambiguous ownership lane/u],
    ];
    for (const [name, review, plan, expected] of cases) {
      assert.throws(() => validateSliceReviewFeasibility(review, plan, { sliceId: "slice" }), expected, name);
    }
  });
});

function feasibilityPlan({ overlap = false } = {}) {
  return withDeliveryEnvelope({
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: [
      { id: "slice", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["slice works"], test_plan: ["test slice"] },
      { id: "sibling", stack: "backend", paths: ["test/**", ...(overlap ? ["src/**"] : [])], depends_on: [], acceptance: ["sibling works"], test_plan: ["test sibling"] },
    ],
  });
}

describe("cost attribution hardening", () => {
  const base = { run_id: "run-1", agent: "backend-builder" };

  it("treats an identical duplicate entry id as an idempotent no-op", () => {
    const entry = { ...base, id: "e1", recorded_at: NOW, cost_total: 0.5, cost_currency: "USD" };
    const result = normalizeCostAttribution({ entries: [entry, { ...entry }] }, { now: NOW });
    assert.equal(result.entries.length, 1);
    assert.equal(result.totals.cost_total, 0.5);
  });

  it("rejects reusing an entry id with different content", () => {
    const entry = { ...base, id: "e1", recorded_at: NOW, cost_total: 0.5, cost_currency: "USD" };
    assert.throws(
      () => normalizeCostAttribution({ entries: [entry, { ...entry, cost_total: 0.75 }] }, { now: NOW }),
      /already recorded with different content/u,
    );
  });

  it("flags mixed currencies even when they appear in different cost fields", () => {
    const result = normalizeCostAttribution({
      entries: [
        { ...base, id: "e1", recorded_at: NOW, cost_total: 1, cost_currency: "USD" },
        { ...base, id: "e2", recorded_at: NOW, cost_input: 2, cost_currency: "EUR" },
      ],
    }, { now: NOW });
    assert.equal(result.totals.mixed_currency, true);
    assert.equal(result.totals.cost_total, undefined);
    assert.equal(result.totals.cost_currency, undefined);
    assert.ok(result.totals.missing.includes("mixed_currency"));
  });

  it("rejects terminal control characters in provider metadata strings", () => {
    assert.throws(
      () => normalizeCostAttribution({
        entries: [{ ...base, id: "e1", recorded_at: NOW, model: "gpt]0;pwned", cost_total: 1, cost_currency: "USD" }],
      }, { now: NOW }),
      /model must not contain terminal control characters/u,
    );
  });

  it("is idempotent for a retry that omits recorded_at, even at a later time", () => {
    // Reviewer's repro: record {id:'retry', agent, input_tokens:1} at T1, then
    // append the same object at T2 with no --recorded-at. The stored entry keeps
    // its original timestamp; the retry must not be treated as different content.
    const entry = { ...base, id: "retry", input_tokens: 1 };
    const first = normalizeCostAttribution({ entries: [entry] }, { now: "2026-07-10T00:00:00.000Z" });
    const retried = normalizeCostAttribution({ entries: [...first.entries, { ...entry }] }, { now: "2026-07-10T01:00:00.000Z" });
    assert.equal(retried.entries.length, 1);
    assert.equal(retried.entries[0].recorded_at, first.entries[0].recorded_at);
  });

  it("dedupes before the entry cap so an identical retry at capacity is a no-op", () => {
    const entries = [];
    for (let i = 0; i < 1000; i += 1) entries.push({ ...base, id: `e${i}`, recorded_at: NOW, input_tokens: 1 });
    const atCap = normalizeCostAttribution({ entries: [...entries, { ...entries[0] }] }, { now: NOW });
    assert.equal(atCap.entries.length, 1000);
    assert.throws(
      () => normalizeCostAttribution({ entries: [...entries, { ...base, id: "e1000", recorded_at: NOW, input_tokens: 1 }] }, { now: NOW }),
      /at most 1000 entries/u,
    );
  });

  it("is idempotent through recordCostUsage (the cost-record CLI path) with no --recorded-at", async () => {
    const runDir = createRunDir("cost-record-retry");
    const repo = join(runDir, "..", "..", "..");
    try {
      await recordCostUsage("cost-record-retry", { agent: "a", input_tokens: 1 }, { cwd: repo, entryId: "retry", now: "2026-07-10T00:00:00.000Z" });
      await recordCostUsage("cost-record-retry", { agent: "a", input_tokens: 1 }, { cwd: repo, entryId: "retry", now: "2026-07-10T01:00:00.000Z" });
      const run = readJson(join(runDir, "run.json"));
      assert.equal(run.cost_attribution.entries.length, 1);
      assert.equal(run.cost_attribution.entries[0].id, "retry");
    } finally {
      cleanupDir(runDir);
    }
  });
});

describe("telemetry hardening", () => {
  it("rejects tracestate values beyond the W3C 512-character cap", () => {
    const result = validateTracestate(`vendor=${"x".repeat(510)}`);
    assert.equal(result.ok, false);
    assert.match(result.error, /512/u);
    assert.equal(validateTracestate("vendor=value").ok, true);
  });

  it("coerces mixed-type attribute arrays to a JSON string", () => {
    const attrs = runAttributes({ tags: [1, "two", true], counts: [1, 2, 3] });
    assert.equal(typeof attrs.tags, "string");
    assert.deepEqual(JSON.parse(attrs.tags), [1, "two", true]);
    assert.deepEqual(attrs.counts, [1, 2, 3]);
  });

  it("applies header redaction to multi-segment OTLP headers variables", () => {
    const safe = sanitizeOtlpEnv({ OTEL_EXPORTER_OTLP_FOO_BAR_HEADERS: "authorization=Bearer sk-abcdef1234567890" });
    const value = safe.OTEL_EXPORTER_OTLP_FOO_BAR_HEADERS;
    assert.ok(Array.isArray(value), "multi-segment headers var must use the per-header sanitizer");
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes("sk-abcdef1234567890"), false);
    assert.match(serialized, /redacted/iu);
  });
});

describe("steering conflict protected state", () => {
  it("treats stopped gates and in-review slices as protected durable state", () => {
    const protectedState = collectProtectedSteeringState(null, {
      gates: { pre_pr: { status: "stopped" }, story: { status: "pending" } },
      steps: [],
      slices: [{ id: "s1", status: "review" }, { id: "s2", status: "pending" }],
    });
    assert.ok(protectedState.includes("gate:pre_pr"));
    assert.ok(protectedState.includes("slice:s1"));
    assert.equal(protectedState.includes("gate:story"), false);
    assert.equal(protectedState.includes("slice:s2"), false);
  });
});

describe("pre-manifest detached launch recovery", () => {
  it("cancels and cleans a run dir that has process evidence but no manifest", async () => {
    const repo = mkdtempSync(join(tmpdir(), "review-pre-manifest-"));
    const runId = "pre-manifest-run";
    const runDir = join(repo, ".opencode", "factory", runId);
    try {
      mkdirSync(join(runDir, "processes"), { recursive: true });
      writeFileSync(join(runDir, "processes", "opencode.log"), "started\n", "utf8");
      writeJson(join(runDir, "process.json"), {
        schema_version: 1,
        kind: "opencode-process",
        run_id: runId,
        execution_id: "exec-1",
        pid: 4242,
        started_at: NOW,
        updated_at: NOW,
        state: "running",
        cwd: repo,
        identity: { inspector: "node-process", start_marker: "linux-procfs:111", command_name: "opencode" },
        log_ref: "processes/opencode.log",
        cancel: null,
      });

      await assert.rejects(cleanupRun(runId, { cwd: repo }), /run 'factory cancel/u);

      const cancelled = await cancelFactoryRun(runId, {
        cwd: repo,
        platform: "linux",
        livenessProbe: () => ({ status: "absent" }),
        signalFn: () => {},
      });
      assert.equal(cancelled.ok, true);
      assert.equal(cancelled.status, "cancelled");

      const cleaned = await cleanupRun(runId, { cwd: repo });
      assert.equal(cleaned.status, "pre-manifest");
      assert.equal(cleaned.removed_run_dir, true);
      assert.equal(existsSync(runDir), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed pre-manifest process evidence unless --force is supplied", async () => {
    const repo = mkdtempSync(join(tmpdir(), "review-pre-manifest-invalid-"));
    const runId = "pre-manifest-invalid";
    const runDir = join(repo, ".opencode", "factory", runId);
    try {
      mkdirSync(runDir, { recursive: true });
      // Unparseable evidence: liveness cannot be established, so cleanup must not delete.
      writeFileSync(join(runDir, "process.json"), "{ not json", "utf8");

      await assert.rejects(cleanupRun(runId, { cwd: repo }), /invalid process evidence[\s\S]*--force/u);
      assert.equal(existsSync(runDir), true, "invalid evidence must not permit deletion");

      const forced = await cleanupRun(runId, { cwd: repo, force: true });
      assert.equal(forced.status, "pre-manifest");
      assert.equal(forced.removed_run_dir, true);
      assert.equal(existsSync(runDir), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails closed on mismatched pre-manifest process evidence", async () => {
    const repo = mkdtempSync(join(tmpdir(), "review-pre-manifest-mismatch-"));
    const runId = "pre-manifest-mismatch";
    const runDir = join(repo, ".opencode", "factory", runId);
    try {
      mkdirSync(join(runDir, "processes"), { recursive: true });
      writeFileSync(join(runDir, "processes", "opencode.log"), "started\n", "utf8");
      // Evidence naming a DIFFERENT run does not establish that THIS launch died.
      writeJson(join(runDir, "process.json"), {
        schema_version: 1,
        kind: "opencode-process",
        run_id: "some-other-run",
        execution_id: "exec-1",
        pid: 4242,
        started_at: NOW,
        updated_at: NOW,
        state: "exited",
        cwd: repo,
        identity: { inspector: "test-inspector", start_marker: "start-1", command_name: "opencode" },
        log_ref: "processes/opencode.log",
        cancel: null,
      });

      await assert.rejects(cleanupRun(runId, { cwd: repo }), /invalid process evidence/u);
      assert.equal(existsSync(runDir), true, "mismatched evidence must not permit deletion");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("continuation and named-start git preflight", () => {
  it("rejects a parent base_commit that no longer resolves", () => {
    const repo = mkdtempSync(join(tmpdir(), "review-continue-base-"));
    const runId = "blocked-parent";
    try {
      initGitRepo(repo);
      runGit(repo, ["branch", runId]);
      const runDir = join(repo, ".opencode", "factory", runId);
      mkdirSync(join(runDir, "artifacts"), { recursive: true });
      mkdirSync(join(runDir, "reviews"), { recursive: true });
      writeFileSync(join(runDir, "artifacts", "story.md"), "story\n", "utf8");
      writeFileSync(join(runDir, "artifacts", "validation.md"), "NO-GO\n", "utf8");
      writeJson(join(runDir, "reviews", "reviewer.json"), { subject: runId, summary: "needs continuation" });
      writeJson(join(runDir, "reviews", "security.json"), { subject: runId, summary: "security blocks continuation" });
      writeJson(join(runDir, "run.json"), {
        schema_version: 1,
        run_id: runId,
        status: "blocked",
        branch: runId,
        base_commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        worktree: join(repo, ".opencode", "worktrees", runId),
        validator: {
          verdict: "NO-GO", report: "artifacts/validation.md", report_hash: jsonHashText("NO-GO\n"),
          review_ref: "reviews/reviewer.json", review_hash: jsonHash({ subject: runId, summary: "needs continuation" }), reviewed_head_sha: gitOutput(repo, ["rev-parse", runId]),
        },
        security_review: {
          verdict: "BLOCK", review_ref: "reviews/security.json", review_hash: jsonHash({ subject: runId, summary: "security blocks continuation" }), reviewed_head_sha: gitOutput(repo, ["rev-parse", runId]),
        },
        gates: {},
        terminal_result: { status: "blocked", run_id: runId, reason: "review blocked", summary: "blocked", artifacts: {} },
      });

      assert.throws(
        () => continueFactory(runId, { cwd: repo, review: "reviewer.json", runId: `${runId}-next`, carryForward: true, dryRun: true }),
        /parent base commit/u,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects a parent base_commit that resolves but is not an ancestor of the parent branch", () => {
    const repo = mkdtempSync(join(tmpdir(), "review-continue-orphan-"));
    const runId = "orphan-base-parent";
    try {
      initGitRepo(repo);
      runGit(repo, ["branch", runId]);
      // A commit that exists but belongs to an unrelated orphan branch — it
      // resolves via rev-parse yet is not in the parent branch's history.
      runGit(repo, ["checkout", "--orphan", "unrelated"]);
      writeFileSync(join(repo, "other.txt"), "unrelated\n", "utf8");
      runGit(repo, ["add", "other.txt"]);
      runGit(repo, ["commit", "-m", "orphan"]);
      const orphanSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
      runGit(repo, ["checkout", "main"]);

      const runDir = join(repo, ".opencode", "factory", runId);
      mkdirSync(join(runDir, "artifacts"), { recursive: true });
      mkdirSync(join(runDir, "reviews"), { recursive: true });
      writeFileSync(join(runDir, "artifacts", "story.md"), "story\n", "utf8");
      writeFileSync(join(runDir, "artifacts", "validation.md"), "NO-GO\n", "utf8");
      writeJson(join(runDir, "reviews", "reviewer.json"), { subject: runId, summary: "needs continuation" });
      writeJson(join(runDir, "reviews", "security.json"), { subject: runId, summary: "security blocks continuation" });
      writeJson(join(runDir, "run.json"), {
        schema_version: 1,
        run_id: runId,
        status: "blocked",
        branch: runId,
        base_commit: orphanSha,
        worktree: join(repo, ".opencode", "worktrees", runId),
        validator: {
          verdict: "NO-GO", report: "artifacts/validation.md", report_hash: jsonHashText("NO-GO\n"),
          review_ref: "reviews/reviewer.json", review_hash: jsonHash({ subject: runId, summary: "needs continuation" }), reviewed_head_sha: gitOutput(repo, ["rev-parse", runId]),
        },
        security_review: {
          verdict: "BLOCK", review_ref: "reviews/security.json", review_hash: jsonHash({ subject: runId, summary: "security blocks continuation" }), reviewed_head_sha: gitOutput(repo, ["rev-parse", runId]),
        },
        gates: {},
        terminal_result: { status: "blocked", run_id: runId, reason: "review blocked", summary: "blocked", artifacts: {} },
      });

      assert.throws(
        () => continueFactory(runId, { cwd: repo, review: "reviewer.json", runId: `${runId}-next`, carryForward: true, dryRun: true }),
        /not an ancestor of parent branch/u,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects named starts that collide with an existing branch or worktree", async () => {
    const repo = mkdtempSync(join(tmpdir(), "review-named-start-"));
    try {
      initGitRepo(repo);
      runGit(repo, ["branch", "taken-branch"]);
      await assert.rejects(
        startFactory(["implement the feature"], { cwd: repo, runId: "taken-branch" }),
        /collides with existing branch/u,
      );

      mkdirSync(join(repo, ".opencode", "worktrees", "taken-worktree"), { recursive: true });
      await assert.rejects(
        startFactory(["implement the feature"], { cwd: repo, runId: "taken-worktree" }),
        /collides with existing worktree/u,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

function createRunDir(name, extra = {}) {
  const repo = mkdtempSync(join(tmpdir(), `review-hardening-${name}-`));
  const runDir = join(repo, ".opencode", "factory", name);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, "run.json"), { schema_version: 1, run_id: name, status: "running", gates: {}, ...extra });
  return runDir;
}

function initGitRepo(repo) {
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "test\n", "utf8");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "init"]);
}

function runGit(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function jsonHash(value) {
  return `sha256:${createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex")}`;
}

function jsonHashText(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function gitOutput(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

function cleanupDir(runDir) {
  rmSync(join(runDir, "..", "..", ".."), { recursive: true, force: true });
}
