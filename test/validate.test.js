import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewRecord, createSliceAttemptReview, createSliceReviewRecord } from "./helpers/review-record-fixture.js";
import { createRunRecord } from "./helpers/run-record-fixture.js";
import { recomputeCostAttribution } from "../src/cost-attribution.js";
import { REDACTED_ENV_VALUE } from "../src/env-snapshot.js";
import { hashValue } from "../src/refs.js";
import { MAX_SLICE_DEPENDENCY_WAVES, ValidationError, checkRunConsistency, validateCostAttributionEntries, validateRun, validateRunDir, validateSliceReviewResult, validateSlicesPlan, validateTestExecutionReceipt } from "../src/validate.js";

const HASH = `sha256:${"a".repeat(64)}`;
const TERMINAL_CURRENCY_PAYLOADS = Object.freeze([
  "USD\u001b]0;pwned\u0007",
  "USD\u001b[2J",
  "USD\u001b]52;c;U0VDUkVU\u0007",
]);
const TERMINAL_LABEL_PAYLOADS = Object.freeze([
  "work\u001b[2J",
  "work\u0007",
  "work\u009b2J",
]);

describe("run schema and consistency", () => {
  it("builds valid canonical semantic run and review fixtures", () => {
    const run = createRunRecord();
    const review = createReviewRecord();

    assert.equal(validateRun(run), run);
    assert.equal(run.run_id, "fixture-run");
    assert.equal(run.status, "running");
    assert.equal(review.subject, "fixture-subject");
    assert.equal(review.verdict, "APPROVE");
    assert.deepEqual(review.required_fixes, []);
  });

  it("enforces the closed plan and planned-slice shapes", () => {
    const plan = slicesPlan([plannedSlice("slice")]);
    assert.equal(validateSlicesPlan(plan), plan);
    assert.deepEqual(Object.keys(plan), ["slices"]);
    assert.deepEqual(Object.keys(plan.slices[0]), ["id", "stack", "paths", "depends_on", "acceptance", "test_plan"]);
    assert.throws(
      () => validateSlicesPlan({ ...plan, legacy_plan: true }),
      (error) => error instanceof ValidationError && error.message.includes("plan.legacy_plan: is not allowed"),
    );
    assert.throws(
      () => validateSlicesPlan({ slices: [{ ...plan.slices[0], dependencies: [] }] }),
      (error) => error instanceof ValidationError && error.message.includes("plan.slices[0].dependencies: is not allowed"),
    );
    assert.throws(
      () => validateSlicesPlan({ slices: [plannedSlice("root"), plannedSlice("leaf", ["stale-slice"])] }),
      (error) => error instanceof ValidationError && error.message.includes("unknown dependency 'stale-slice'"),
    );
  });

  it("admits only exact-file and recursive-directory ownership lanes", () => {
    for (const lane of ["src/server/api.js", "src/server/api/**"]) {
      const plan = slicesPlan([{ ...plannedSlice("slice"), paths: [lane] }]);
      assert.equal(validateSlicesPlan(plan), plan, lane);
      assert.equal(plan.slices[0].paths[0], lane, `${lane} must remain byte-exact`);
    }
    for (const lane of ["src/server/api/", "src/server/*.js", "src/**/api.js", "src/server/{api,ui}.js", "src/server/api?.js"]) {
      assert.throws(
        () => validateSlicesPlan(slicesPlan([{ ...plannedSlice("slice"), paths: [lane] }])),
        (error) => error instanceof ValidationError
          && error.errors.some((item) => item.path === "plan.slices[0].paths[0]" && /invalid or ambiguous ownership lane/u.test(item.message)),
        lane,
      );
    }
  });

  it("requires canonical review ratification and forbids REJECT ownership", () => {
    const approved = createSliceReviewRecord({ ratifiedPaths: ["docs/a.md", "docs/z.md"] });
    assert.deepEqual(validateSliceReviewResult(approved).ratified_paths, ["docs/a.md", "docs/z.md"]);

    const missing = structuredClone(approved);
    delete missing.ownership_ratification;
    assert.throws(() => validateSliceReviewResult(missing), /ownership_ratification: is required/u);

    const unsorted = createSliceReviewRecord({ ratifiedPaths: ["docs/z.md", "docs/a.md"] });
    assert.throws(() => validateSliceReviewResult(unsorted), /must be sorted by canonical repository path/u);

    const rejected = createSliceReviewRecord({ verdict: "REJECT", requiredFixes: ["fix"], ratifiedPaths: ["docs/a.md"] });
    assert.throws(() => validateSliceReviewResult(rejected), /must be empty for REJECT/u);
  });

  it("requires durable ownership and derives effective paths only from the current APPROVE", () => {
    const sha = "a".repeat(40);
    const first = createSliceAttemptReview({ attempt: 1, evidenceRef: "evidence/one.json", evidenceHash: HASH, reviewRef: "reviews/one.json", reviewHash: HASH, reviewedCommit: sha, verdict: "REJECT" });
    const current = createSliceAttemptReview({ attempt: 2, evidenceRef: "evidence/two.json", evidenceHash: HASH, reviewRef: "reviews/two.json", reviewHash: HASH, reviewedCommit: sha, ratifiedPaths: ["docs/adjacent.md"] });
    const slice = {
      id: "slice", status: "review", attempts: 2, declared_paths: ["src/**"], effective_paths: ["src/**", "docs/adjacent.md"],
      evidence_ref: current.evidence_ref, evidence_hash: current.evidence_hash, review_ref: current.review_ref, review_hash: current.review_hash,
      reviewed_commit: sha, attempt_reviews: [first, current],
    };
    assert.deepEqual(validateRun({ ...runningRun(), slices: [slice] }).slices[0].effective_paths, ["src/**", "docs/adjacent.md"]);

    assert.throws(() => validateRun({ ...runningRun(), slices: [{ ...slice, effective_paths: ["src/**", "docs/prior.md", "docs/adjacent.md"] }] }), /plus only the current APPROVE/u);
    const missing = structuredClone(slice);
    delete missing.declared_paths;
    assert.throws(() => validateRun({ ...runningRun(), slices: [missing] }), /declared_paths: must be a nonempty array/u);

    const running = durableSlice({ id: "slice", status: "running", attempts: 2, attempt_reviews: [first] }, ["src/**"]);
    assert.deepEqual(validateRun({ ...runningRun(), slices: [running] }).slices[0].effective_paths, ["src/**"]);
  });

  it("enforces the closed versioned run envelope, top-level timestamps, and absolute worktree", () => {
    const allowedRunKeys = ["schema_version", "run_id", "mode", "status", "created_at", "updated_at", "heartbeat_at", "base_ref", "base_commit", "branch", "worktree", "github_account", "pr_mode", "pr_url", "max_parallel_slices", "max_retries", "review_tier", "debug_snapshot", "provenance", "merged_slice_repair", "continuation", "steering", "post_pr", "gates", "slices", "cost_attribution", "steps", "validator", "security_review", "terminal_result"];
    const canonical = { ...runningRun(), created_at: "2026-07-08T11:00:00.000Z", updated_at: "2026-07-08T11:30:00.000Z", heartbeat_at: "2026-07-08T11:59:00.000Z", worktree: "/tmp/run" };
    assert.equal(validateRun(canonical), canonical);
    assert.deepEqual(allowedRunKeys.filter((key) => Object.hasOwn(canonical, key)).sort(), Object.keys(canonical).sort());
    for (const run of [
      { run_id: "run", status: "running", gates: {} },
      { ...runningRun(), schema_version: 2 },
      { ...runningRun(), legacy_status: "running" },
    ]) assert.throws(() => validateRun(run), ValidationError);
    for (const key of ["created_at", "updated_at", "heartbeat_at"]) {
      assert.throws(
        () => validateRun({ ...runningRun(), [key]: "not-a-time" }),
        (error) => error instanceof ValidationError && error.message.includes(`run.${key}: must be an ISO timestamp or null`),
      );
    }
    assert.throws(
      () => validateRun({ ...runningRun(), worktree: ".opencode/worktrees/run" }),
      (error) => error instanceof ValidationError && error.message.includes("run.worktree: must be an absolute path or null"),
    );
  });

  it("enforces closed terminal variants, durable artifact refs, and canonical completed PR tuples", () => {
    const commonKeys = ["status", "run_id", "pr_url", "reason", "summary", "artifacts"];
    for (const status of ["blocked", "partial", "needs-human"]) {
      const terminalResult = { status, run_id: "run", pr_url: null, reason: `${status}-reason`, summary: `${status} summary`, artifacts: { report: "artifacts/report.md" } };
      const run = { ...runningRun(), status, terminal_result: terminalResult };
      assert.equal(validateRun(run), run);
      assert.deepEqual(Object.keys(terminalResult), commonKeys);
      assert.throws(() => validateRun({ ...run, terminal_result: { ...terminalResult, legacy_result: true } }), ValidationError);
    }

    const prUrl = "https://github.com/acme/repo/pull/7";
    const completed = {
      ...runningRun(),
      status: "completed",
      pr_url: prUrl,
      terminal_result: { status: "completed", run_id: "run", pr_url: prUrl, reason: null, summary: "PR created.", artifacts: { test_report: "artifacts/test-report.md" }, pr_number: 7, repository: "acme/repo", draft: false },
    };
    assert.equal(validateRun(completed), completed);
    assert.deepEqual(Object.keys(completed.terminal_result), [...commonKeys, "pr_number", "repository", "draft"]);
    const withHead = { ...completed, terminal_result: { ...completed.terminal_result, head_sha: "a".repeat(40) } };
    assert.equal(validateRun(withHead), withHead);
    for (const head_sha of ["abc123", "A".repeat(40), "a".repeat(39)]) {
      assert.throws(() => validateRun({ ...completed, terminal_result: { ...completed.terminal_result, head_sha } }), /head_sha: must be a full 40-character lowercase git SHA/u);
    }
    assert.throws(() => validateRun({ ...completed, terminal_result: { ...completed.terminal_result, pr_number: 8 } }), /pr_number: must match pr_url pull request number/u);
    assert.throws(() => validateRun({ ...completed, terminal_result: { ...completed.terminal_result, repository: "other/repo" } }), /repository: must match pr_url repository/u);
    assert.throws(() => validateRun({ ...completed, pr_url: "https://github.com/acme/repo/pull/8" }), /run\.pr_url: must match completed terminal_result\.pr_url/u);
    for (const artifact of ["../outside.md", "/tmp/report.md", "reviews/report.json", "artifacts/../report.md", "artifacts\\report.md"]) {
      assert.throws(() => validateRun({ ...completed, terminal_result: { ...completed.terminal_result, artifacts: { report: artifact } } }), /run\.terminal_result\.artifacts\.report/u);
    }
  });

  it("preserves exact legacy semantic literals when fixtures are specialized", () => {
    const runOverrides = {
      run_id: "repair-run",
      branch: "repair-feature",
      steps: [],
      slices: [{ id: "owner", status: "merged", attempts: 2, merge_commit: "1111111" }],
    };
    const reviewOverrides = {
      subject: "repair:owner",
      verdict: "REJECT",
      required_fixes: ["tighten the sort key"],
      attempt: 1,
      commit: "a".repeat(40),
    };

    assert.deepEqual(createRunRecord(runOverrides), {
      schema_version: 1,
      status: "running",
      gates: {},
      ...runOverrides,
    });
    assert.deepEqual(createReviewRecord(reviewOverrides), reviewOverrides);
  });

  it("accepts debug snapshots", () => {
    const run = validateRun({
      ...runningRun(),
      debug_snapshot: snapshotRoot({ env: { tool: "opencode", token_value: REDACTED_ENV_VALUE } }),
    });

    assert.equal(run.debug_snapshot.resume_count, 0);
  });

  it("rejects unredacted sensitive debug snapshot values", () => {
    assert.throws(
      () => validateRun({ ...runningRun(), debug_snapshot: snapshotRoot({ env: { observed: "github_pat_123456789012345678901234567890" } }) }),
      (error) => error instanceof ValidationError && error.message.includes("must be redacted"),
    );
  });

  it("treats review_tier as optional opaque display text", () => {
    assert.equal(validateRun({ ...runningRun(), review_tier: "strict" }).review_tier, "strict");
    assert.throws(
      () => validateRun({ ...runningRun(), review_tier: { selected: "strict" } }),
      (error) => error instanceof ValidationError && error.message.includes("run.review_tier: must be a non-empty string"),
    );
  });

  it("accepts valid cost attribution metadata", () => {
    const costAttribution = recomputeCostAttribution({ entries: [
      { id: "cost-1", recorded_at: "2026-07-08T12:00:00.000Z", run_id: "run", agent: "backend-builder", slice_id: "slice", provider: "opencode", model: "gpt-5.5", input_tokens: 10, output_tokens: 5, total_tokens: 15, cost_total: 0.02, cost_currency: "USD" },
    ] }, { now: "2026-07-08T12:00:01.000Z" });

    const run = validateRun({ ...runningRun(), slices: [durableSlice({ id: "slice", status: "running" })], cost_attribution: costAttribution });

    assert.equal(run.cost_attribution.schema_version, 1);
    assert.equal(run.cost_attribution.status, "available");
    assert.equal(run.cost_attribution.totals.total_tokens, 15);
  });

  it("accepts cost attribution rollup keys such as __proto__", () => {
    const costAttribution = recomputeCostAttribution({ entries: [
      { id: "cost-1", recorded_at: "2026-07-08T12:00:00.000Z", run_id: "run", agent: "__proto__", slice_id: "__proto__", provider: "opencode", model: "gpt-5.5", input_tokens: 10, cost_total: 0.02, cost_currency: "USD" },
    ] }, { now: "2026-07-08T12:00:01.000Z" });

    const run = validateRun({ ...runningRun(), slices: [durableSlice({ id: "__proto__", status: "running" })], cost_attribution: costAttribution });

    assert.equal(run.cost_attribution.by_agent["__proto__"].entry_count, 1);
    assert.equal(run.cost_attribution.by_slice["__proto__"].cost_total, 0.02);
  });

  it("rejects invalid cost attribution metadata", () => {
    const costAttribution = recomputeCostAttribution({ entries: [
      { id: "cost-1", recorded_at: "2026-07-08T12:00:00.000Z", run_id: "run", agent: "backend-builder", slice_id: "slice", provider: "opencode", model: "gpt-5.5", input_tokens: 10, cost_total: 0.02, cost_currency: "USD" },
    ] }, { now: "2026-07-08T12:00:01.000Z" });

    const unknownSlice = structuredClone(costAttribution);
    unknownSlice.entries[0].slice_id = "missing-slice";
    assert.throws(
      () => validateRun({ ...runningRun(), slices: [{ id: "slice", status: "running" }], cost_attribution: unknownSlice }),
      (error) => error instanceof ValidationError && error.message.includes("run.cost_attribution.entries[0].slice_id: unknown slice 'missing-slice'"),
    );

    const tooMany = structuredClone(costAttribution);
    tooMany.entries = Array.from({ length: 1001 }, (_, index) => ({ ...costAttribution.entries[0], id: `cost-${index}` }));
    assert.throws(
      () => validateRun({ ...runningRun(), cost_attribution: tooMany }),
      (error) => error instanceof ValidationError && error.message.includes("run.cost_attribution.entries: must have at most 1000 entries"),
    );

    const invalidNumber = structuredClone(costAttribution);
    invalidNumber.entries[0].input_tokens = -1;
    assert.throws(
      () => validateRun({ ...runningRun(), cost_attribution: invalidNumber }),
      (error) => error instanceof ValidationError && error.message.includes("run.cost_attribution.entries[0].input_tokens: must be a finite non-negative number"),
    );

    const mismatchedRunId = structuredClone(costAttribution);
    mismatchedRunId.entries[0].run_id = "other-run";
    assert.throws(
      () => validateRun({ ...runningRun("run"), cost_attribution: mismatchedRunId }),
      (error) => error instanceof ValidationError && error.message.includes("run.cost_attribution.entries[0].run_id: must match run.run_id"),
    );

    const invalidAvailability = structuredClone(costAttribution);
    delete invalidAvailability.entries[0].provider;
    assert.throws(
      () => validateRun({ ...runningRun(), cost_attribution: invalidAvailability }),
      (error) => error instanceof ValidationError && error.message.includes("run.cost_attribution.entries[0].status: available requires provider, model, usage, cost_total, and cost_currency"),
    );
  });

  it("rejects terminal control cost currency metadata", () => {
    for (const payload of TERMINAL_CURRENCY_PAYLOADS) {
      const costAttribution = recomputeCostAttribution({ entries: [
        { id: "cost-1", recorded_at: "2026-07-08T12:00:00.000Z", run_id: "run", agent: "backend-builder", slice_id: "slice", provider: "opencode", model: "gpt-5.5", input_tokens: 10, cost_total: 0.02, cost_currency: "USD" },
      ] }, { now: "2026-07-08T12:00:01.000Z" });
      costAttribution.entries[0].cost_currency = payload;
      costAttribution.totals.cost_currency = payload;
      costAttribution.by_agent["backend-builder"].cost_currency = payload;
      costAttribution.by_slice.slice.cost_currency = payload;

      assert.throws(
        () => validateRun({ ...runningRun(), slices: [{ id: "slice", status: "running" }], cost_attribution: costAttribution }),
        (error) => error instanceof ValidationError && error.message.includes("cost_currency: must be an uppercase currency code (3-12 letters) with no control characters"),
      );
    }
  });

  it("rejects terminal controls in cost attribution missing metadata", () => {
    const costAttribution = recomputeCostAttribution({ entries: [
      { id: "cost-1", recorded_at: "2026-07-08T12:00:00.000Z", run_id: "run", agent: "backend-builder", input_tokens: 10 },
    ] }, { now: "2026-07-08T12:00:01.000Z" });
    costAttribution.totals.missing = ["provider\u001b[2J"];

    assert.throws(
      () => validateRun({ ...runningRun(), cost_attribution: costAttribution }),
      (error) => error instanceof ValidationError && error.message.includes("run.cost_attribution.totals.missing[0]: must not contain control characters"),
    );
  });

  it("validates cost entries independently of full-run and known-slice state", () => {
    const entry = {
      id: "cost-1",
      recorded_at: "2026-07-08T12:00:00.000Z",
      run_id: "run",
      agent: "backend-builder",
      slice_id: "not-in-a-plan",
      provider: "unknown-provider",
      model: "unknown-model",
      input_tokens: 10,
      cost_total: 0.02,
      cost_currency: "USD",
      status: "available",
      missing: [],
    };

    assert.equal(validateCostAttributionEntries([entry], "run")[0], entry);
    assert.throws(
      () => validateCostAttributionEntries([{ ...entry, run_id: "other" }], "run"),
      (error) => error instanceof ValidationError && error.message.includes("run.cost_attribution.entries[0].run_id: must match run.run_id"),
    );
    assert.throws(
      () => validateCostAttributionEntries(Array.from({ length: 1001 }, () => entry), "run"),
      (error) => error instanceof ValidationError && error.message.includes("run.cost_attribution.entries: must have at most 1000 entries"),
    );
  });

  it("accepts persisted numeric nulls and data-less partial entries but rejects invalid non-null values", () => {
    const numericFields = [
      "input_tokens", "output_tokens", "total_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "reasoning_tokens",
      "cost_total", "cost_input", "cost_output", "cost_cache_creation", "cost_cache_read",
    ];
    const entry = {
      id: "cost-null",
      recorded_at: "2026-07-08T12:00:00.000Z",
      run_id: "run",
      agent: "backend-builder",
      status: "partial",
      missing: ["usage"],
      ...Object.fromEntries(numericFields.map((field) => [field, null])),
    };

    assert.equal(validateCostAttributionEntries([entry], "run")[0], entry);
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
      assert.throws(
        () => validateCostAttributionEntries([{ ...entry, input_tokens: value }], "run"),
        (error) => error instanceof ValidationError && error.message.includes("run.cost_attribution.entries[0].input_tokens: must be a finite non-negative number"),
      );
    }
  });

  it("rejects terminal controls in planned and durable work labels", () => {
    for (const payload of TERMINAL_LABEL_PAYLOADS) {
      assert.throws(
        () => validateSlicesPlan({ slices: [{ id: payload, stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["safe"], test_plan: ["node --test"] }] }),
        (error) => error instanceof ValidationError && error.message.includes("plan.slices[0].id: must not contain control characters"),
      );
      assert.throws(
        () => validateRun({ ...runningRun(), slices: [{ id: payload, status: "running" }] }),
        (error) => error instanceof ValidationError && error.message.includes("run.slices[0].id: must not contain control characters"),
      );
      assert.throws(
        () => validateRun({ ...runningRun(), steps: [{ agent: payload, status: "running" }] }),
        (error) => error instanceof ValidationError && error.message.includes("run.steps[0].agent: must not contain control characters"),
      );
    }
  });

  it("does not expose duplicate planned slice ids with terminal controls in validation errors", () => {
    for (const payload of TERMINAL_LABEL_PAYLOADS) {
      let error;
      assert.throws(
        () => validateSlicesPlan({ slices: [
          { id: payload, stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["safe"], test_plan: ["node --test"] },
          { id: payload, stack: "backend", paths: ["test/**"], depends_on: [], acceptance: ["safe"], test_plan: ["node --test"] },
        ] }),
        (caught) => {
          error = caught;
          return caught instanceof ValidationError;
        },
      );

      assert.match(error.message, /plan\.slices\[1\]\.id: duplicate id/u);
      assert.equal(validationErrorHasTerminalControl(error), false);
    }
  });

  it("caps planned slice dependency paths at four waves", () => {
    assert.equal(MAX_SLICE_DEPENDENCY_WAVES, 4);
    const threeWaves = slicesPlan([
      plannedSlice("root"),
      plannedSlice("middle", ["root"]),
      plannedSlice("leaf", ["middle"]),
    ]);
    assert.equal(validateSlicesPlan(threeWaves), threeWaves);

    const diamond = slicesPlan([
      plannedSlice("root"),
      plannedSlice("left", ["root"]),
      plannedSlice("right", ["root"]),
      plannedSlice("leaf", ["left", "right"]),
    ]);
    assert.equal(validateSlicesPlan(diamond), diamond);

    // A four-wave chain is now accepted (width-primary decomposition may use a fourth wave).
    const fourWaves = slicesPlan([
      plannedSlice("root"),
      plannedSlice("second", ["root"]),
      plannedSlice("third", ["second"]),
      plannedSlice("fourth", ["third"]),
    ]);
    assert.equal(validateSlicesPlan(fourWaves), fourWaves);

    assert.throws(
      () => validateSlicesPlan(slicesPlan([
        plannedSlice("root"),
        plannedSlice("second", ["root"]),
        plannedSlice("third", ["second"]),
        plannedSlice("fourth", ["third"]),
        plannedSlice("fifth", ["fourth"]),
      ])),
      (error) => error instanceof ValidationError
        && error.message.includes("plan.slices[4].depends_on: dependency depth 5 exceeds maximum 4 waves: root -> second -> third -> fourth -> fifth"),
    );

    const legacyPlan = slicesPlan([
      plannedSlice("root"),
      plannedSlice("second", ["root"]),
      plannedSlice("third", ["second"]),
      plannedSlice("fourth", ["third"]),
      plannedSlice("fifth", ["fourth"]),
    ]);
    assert.equal(validateSlicesPlan(legacyPlan, { enforceDependencyDepth: false }), legacyPlan);
  });

  it("reports invalid dependency graphs before calculating depth", () => {
    assert.throws(
      () => validateSlicesPlan(slicesPlan([plannedSlice("leaf", ["missing"])])),
      (error) => error instanceof ValidationError
        && error.message.includes("unknown dependency 'missing'")
        && !error.message.includes("dependency depth"),
    );
    assert.throws(
      () => validateSlicesPlan(slicesPlan([
        plannedSlice("one", ["two"]),
        plannedSlice("two", ["one"]),
      ])),
      (error) => error instanceof ValidationError
        && error.message.includes("dependency cycle")
        && !error.message.includes("dependency depth"),
    );
  });

  it("does not expose duplicate durable slice ids with terminal controls in validation errors", () => {
    for (const payload of TERMINAL_LABEL_PAYLOADS) {
      let error;
      assert.throws(
        () => validateRun({ ...runningRun(), slices: [{ id: payload, status: "running" }, { id: payload, status: "blocked" }] }),
        (caught) => {
          error = caught;
          return caught instanceof ValidationError;
        },
      );

      assert.match(error.message, /run\.slices\[1\]\.id: duplicate id/u);
      assert.equal(validationErrorHasTerminalControl(error), false);
    }
  });

  it("treats pr_mode as optional persisted PR creation mode", () => {
    assert.equal(validateRun({ ...runningRun(), pr_mode: "draft" }).pr_mode, "draft");
    assert.equal(validateRun({ ...runningRun(), pr_mode: "ready" }).pr_mode, "ready");
    assert.throws(
      () => validateRun({ ...runningRun(), pr_mode: "published" }),
      (error) => error instanceof ValidationError && error.message.includes("run.pr_mode: must be one of draft, ready"),
    );
  });

  it("accepts blocked-run continuation metadata without bumping run schema", () => {
    const run = validateRun({
      ...runningRun("continuation-run"),
      branch: "continuation-branch",
      worktree: "/tmp/continuation-worktree",
      continuation: continuationMetadata("continuation-run"),
    });

    assert.equal(run.schema_version, 1);
    assert.equal(run.continuation.schema_version, 1);
    assert.equal(run.continuation.kind, "blocked-run-continuation");
    assert.deepEqual(run.continuation.parent_artifacts, [
      { kind: "validation_report", ref: "artifacts/validation-report.md", hash: HASH },
    ]);
    assert.equal(run.continuation.planning_reuse, undefined, "existing v1 continuations may omit reuse metadata");
    assert.equal(run.continuation.post_pr, undefined, "existing v1 continuations may omit post-PR metadata");
  });

  it("permits inherited acceptance only for reuse-eligible spec-writer continuations", () => {
    const valid = inheritedAcceptanceRun();
    assert.equal(validateRun(valid).steps[0].inherited_acceptance.from_run_id, "parent-run");

    const absentContinuation = structuredClone(valid);
    delete absentContinuation.continuation;
    assert.throws(
      () => validateRun(absentContinuation),
      /inherited_acceptance.*requires a blocked-run continuation/u,
    );

    const nonSpecWriter = structuredClone(valid);
    nonSpecWriter.steps[0].agent = "story-writer";
    assert.throws(
      () => validateRun(nonSpecWriter),
      /inherited_acceptance.*allowed only for the spec-writer step/u,
    );

    const ineligible = structuredClone(valid);
    ineligible.continuation.planning_reuse = { eligible: false, reason: "parent planning was not accepted" };
    assert.throws(
      () => validateRun(ineligible),
      /inherited_acceptance.*requires reuse-eligible continuation metadata/u,
    );
  });

  it("closes persisted gate, snapshot, receipt, step, acceptance, and continuation nested shapes", () => {
    const snapshot = {
      question_ref: "gates/story.question.md", question_hash: HASH,
      artifact_ref: "artifacts/story.md", artifact_hash: HASH,
      answer_ref: "gates/story.answer", created_at: "2026-07-08T12:00:00.000Z",
    };
    const interactive = {
      ...runningRun("closed-gate"),
      mode: "interactive",
      gates: { story: {
        status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer.consumed-1", answer: "approve", approval_source: "external-driver",
        answered_at: "2026-07-08T12:00:00.000Z", pending_snapshot: snapshot,
        handoff_receipt: {
          schema_version: 1, kind: "interactive-approval-handoff", gate: "story",
          approval_fingerprint: HASH, pending_snapshot_hash: HASH, answer_hash: HASH,
          steering_generation: 0, accepted_at: "2026-07-08T12:00:00.000Z",
        },
      } },
    };
    assert.equal(validateRun(interactive).gates.story.status, "approved");
    for (const [label, mutate, expected] of [
      ["gate", (run) => { run.gates.story.extra = true; }, /run\.gates\.story\.extra: is not allowed/u],
      ["snapshot", (run) => { run.gates.story.pending_snapshot.extra = true; }, /pending_snapshot\.extra: is not allowed/u],
      ["receipt", (run) => { run.gates.story.handoff_receipt.extra = true; }, /handoff_receipt\.extra: is not allowed/u],
      ["receipt time", (run) => { run.gates.story.handoff_receipt.accepted_at = "not-time"; }, /accepted_at: must be an ISO timestamp/u],
    ]) {
      const malformed = structuredClone(interactive); mutate(malformed);
      assert.throws(() => validateRun(malformed), expected, label);
    }

    const acceptedStep = {
      agent: "spec-writer", status: "accepted", attempts: 1,
      artifact_ref: "artifacts/technical-brief.md", review_ref: "reviews/spec-writer.json",
      acceptance: { artifact_ref: "artifacts/technical-brief.md", artifact_hash: HASH, review_ref: "reviews/spec-writer.json", review_hash: HASH },
    };
    assert.equal(validateRun({ ...runningRun(), steps: [{ agent: "legacy", status: "accepted", attempts: 1 }] }).steps[0].acceptance, undefined);
    for (const [label, mutate, expected] of [
      ["step", (step) => { step.extra = true; }, /run\.steps\[0\]\.extra: is not allowed/u],
      ["acceptance", (step) => { step.acceptance.extra = true; }, /acceptance\.extra: is not allowed/u],
      ["binding", (step) => { step.acceptance.artifact_ref = "artifacts/other.md"; }, /must match step artifact_ref/u],
    ]) {
      const step = structuredClone(acceptedStep); mutate(step);
      assert.throws(() => validateRun({ ...runningRun(), steps: [step] }), expected, label);
    }

    const continuation = continuationMetadata();
    continuation.extra = true;
    assert.throws(() => validateRun({ ...runningRun(), continuation }), /run\.continuation\.extra: is not allowed/u);
    delete continuation.extra;
    continuation.parent.extra = true;
    assert.throws(() => validateRun({ ...runningRun(), continuation }), /run\.continuation\.parent\.extra: is not allowed/u);
  });

  it("requires receipts only for interactive approved gates and forbids them on other variants", () => {
    const approved = {
      status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md",
      answer_ref: "gates/story.answer.consumed-1", answer: "approve", approval_source: "autonomous",
      answered_at: "2026-07-08T12:00:00.000Z",
      pending_snapshot: { question_ref: "gates/story.question.md", question_hash: HASH, artifact_ref: "artifacts/story.md", artifact_hash: HASH, answer_ref: "gates/story.answer", created_at: "2026-07-08T12:00:00.000Z" },
    };
    assert.equal(validateRun({ ...runningRun(), mode: "autonomous", gates: { story: approved } }).gates.story.handoff_receipt, undefined);
    assert.throws(() => validateRun({ ...runningRun(), mode: "interactive", gates: { story: approved } }), /handoff_receipt: is required for an interactive approval/u);
    const pending = { ...structuredClone(approved), status: "pending" };
    delete pending.answer; delete pending.answered_at; delete pending.approval_source;
    pending.answer_ref = pending.pending_snapshot.answer_ref;
    pending.handoff_receipt = { schema_version: 1, kind: "interactive-approval-handoff", gate: "story", approval_fingerprint: HASH, pending_snapshot_hash: HASH, answer_hash: HASH, steering_generation: 0, accepted_at: "2026-07-08T12:00:00.000Z" };
    assert.throws(() => validateRun({ ...runningRun(), mode: "interactive", gates: { story: pending } }), /handoff_receipt: is forbidden for a pending gate/u);
  });

  it("closes checked execution claim and receipt variants with exact outcome nullability", () => {
    const claim = {
      schema_version: 1, kind: "checked-test-execution-claim", state: "active", nonce: "123e4567-e89b-42d3-a456-426614174000",
      run_id: "checked", attempt: 1, plan_ref: "plan/slices.json", plan_hash: HASH, head_sha: "a".repeat(40),
      receipt_ref: "evidence/test-verifier.attempt-1.json", claimed_at: "2026-07-17T12:00:00.000Z",
    };
    const claimStep = (executionClaim, status = "running") => ({
      agent: "test-verifier", status, attempts: 1, execution_claim: executionClaim, execution_claim_hash: hashValue(executionClaim),
    });
    assert.equal(validateRun({ ...runningRun("checked"), steps: [claimStep(claim)] }).steps[0].execution_claim.state, "active");
    assert.throws(
      () => validateRun({ ...runningRun("checked"), steps: [{ agent: "test-verifier", status: "running", attempts: 1, execution_claim: claim }] }),
      /execution_claim_hash: must be present exactly when execution_claim is present/u,
    );
    assert.throws(
      () => validateRun({ ...runningRun("checked"), steps: [{ agent: "test-verifier", status: "running", attempts: 1, execution_claim_hash: hashValue(claim) }] }),
      /execution_claim_hash: must be present exactly when execution_claim is present/u,
    );
    assert.throws(
      () => validateRun({ ...runningRun("checked"), steps: [{ ...claimStep(claim), execution_claim_hash: HASH }] }),
      /execution_claim_hash: must equal the canonical execution_claim hash/u,
    );
    for (const [label, mutate, expected] of [
      ["unknown key", (value) => { value.extra = true; }, /execution_claim\.extra: is not allowed/u],
      ["attempt binding", (value) => { value.attempt = 2; value.receipt_ref = "evidence/test-verifier.attempt-2.json"; }, /must match step attempts/u],
      ["fixed ref", (value) => { value.receipt_ref = "evidence/other.json"; }, /must equal the fixed attempt receipt ref/u],
    ]) {
      const malformed = structuredClone(claim); mutate(malformed);
      assert.throws(() => validateRun({ ...runningRun("checked"), steps: [claimStep(malformed)] }), expected, label);
    }
    const unknown = { ...claim, state: "unknown", failed_at: "2026-07-17T12:01:00.000Z", reason: "authority-changed" };
    assert.equal(validateRun({ ...runningRun("checked"), steps: [claimStep(unknown)] }).steps[0].execution_claim.reason, "authority-changed");
    const completed = { ...claim, state: "completed", completed_at: "2026-07-17T12:01:00.000Z", status: "fail", receipt_hash: HASH };
    assert.equal(validateRun({ ...runningRun("checked"), steps: [{ ...claimStep(completed, "rejected"), evidence_ref: claim.receipt_ref }] }).steps[0].status, "rejected");

    const stream = { captured_bytes: 0, sha256: `sha256:${createHash("sha256").digest("hex")}`, truncated: false };
    const receipt = {
      schema_version: 1, kind: "checked-test-execution-receipt", subject: "test-verifier", run_id: "checked", attempt: 1,
      claim_nonce: claim.nonce, plan_ref: claim.plan_ref, plan_hash: HASH, head_sha: "a".repeat(40),
      started_at: "2026-07-17T12:00:00.000Z", completed_at: "2026-07-17T12:01:00.000Z", duration_ms: 60_000,
      status: "pass", review_ready: true,
      commands: [{ index: 0, program: "npm", args: ["run", "check"], outcome: "exited", status: "pass", exit_code: 0, signal: null, error_code: null, duration_ms: 1, stdout: stream, stderr: stream }],
    };
    assert.equal(validateTestExecutionReceipt(receipt).status, "pass");
    for (const [label, mutate, expected] of [
      ["unknown key", (value) => { value.commands[0].extra = true; }, /commands\[0\]\.extra: is not allowed/u],
      ["exited nullability", (value) => { value.commands[0].signal = "SIGTERM"; }, /exited requires an exit code and null signal/u],
      ["aggregate", (value) => { value.status = "fail"; value.review_ready = false; }, /aggregate command result status/u],
      ["output limit", (value) => { Object.assign(value.commands[0], { outcome: "output-limit", status: "fail", exit_code: null, signal: "SIGKILL" }); value.status = "fail"; value.review_ready = false; }, /output-limit requires a truncated stream/u],
    ]) {
      const malformed = structuredClone(receipt); mutate(malformed);
      assert.throws(() => validateTestExecutionReceipt(malformed), expected, label);
    }
  });

  it("accepts steering metadata without bumping run schema and checks pending hash", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo, "steering-valid");
    try {
      mkdirSync(join(runDir, "steering"), { recursive: true });
      const steeringFile = { schema_version: 1, kind: "operator-steering", run_id: "steering-valid", id: "s1", message: "do x", message_chars: 4, created_at: "2026-07-08T12:00:00.000Z", source: "factory steer" };
      writeJson(join(runDir, "steering", "pending.json"), steeringFile);
      const hash = hashFile(join(runDir, "steering", "pending.json"));
      const run = {
        ...runningRun("steering-valid"),
        steering: { schema_version: 1, pending: { id: "s1", ref: "steering/pending.json", hash, message_chars: 4, created_at: "2026-07-08T12:00:00.000Z" }, history: [] },
      };
      writeJson(join(runDir, "run.json"), run);

      assert.equal(validateRun(run).schema_version, 1);
      assert.equal(validateRunDir(runDir).ok, true);
      const bad = { ...run, steering: { ...run.steering, pending: { ...run.steering.pending, hash: HASH } } };
      assert.equal(checkRunConsistency(runDir, bad).ok, false);
    } finally {
      cleanup(repo);
    }
  });

  it("accepts unbound running slices and panel rows while closing successor and steering authority records", () => {
    const slice = durableSlice({ id: "slice", stack: "backend", depends_on: [], status: "running", attempts: 1, branch: "feature--slice", worktree: "/tmp/slice" });
    const steering = {
      schema_version: 1,
      generation: 2,
      boundary: { kind: "dispatch", token: "dispatch-token", generation: 2, state_hash: HASH, created_at: "2026-07-08T12:00:00.000Z" },
      action_claim: null,
      last_action: { kind: "dispatch", token: "prior-token", generation: 2, outcome: "closed", claimed_at: "2026-07-08T11:00:00.000Z", resolved_at: "2026-07-08T11:01:00.000Z" },
      history: [],
    };
    const run = {
      ...runningRun(),
      slices: [slice],
      validator: { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json", loops: 1 },
      security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json", loops: 1 },
      steering,
    };
    assert.equal(validateRun(run), run);
    for (const [label, mutate] of [
      ["slice", (value) => { value.slices[0].reviewed_commit = "a".repeat(40); }],
      ["validator", (value) => { value.validator.subject = "feature"; }],
      ["security", (value) => { value.security_review.review_hash = HASH; }],
      ["boundary", (value) => { value.steering.boundary.operation_token = "other"; }],
      ["last action", (value) => { value.steering.last_action.subject = "dispatch"; }],
    ]) {
      const changed = structuredClone(run);
      mutate(changed);
      assert.throws(() => validateRun(changed), /is not allowed|all present or all absent|forbidden outside/u, label);
    }
  });

  it("treats null own successor fence and completed-result fields as partial tuples", () => {
    const legacyFence = { token: "legacy-fence", generation: 2, state_hash: HASH, created_at: "2026-07-08T12:00:00.000Z" };
    const steering = {
      schema_version: 1,
      generation: 2,
      pending: null,
      uncheckpointed: null,
      boundary: null,
      action_claim: null,
      last_action: null,
      pr_fence: legacyFence,
      history: [],
    };
    assert.equal(validateRun({ ...runningRun(), steering }).steering.pr_fence, legacyFence);
    for (const key of ["operation_id", "repository", "head_ref", "head_sha", "base_ref", "base_sha", "draft"]) {
      assert.throws(() => validateRun({ ...runningRun(), steering: { ...steering, pr_fence: { ...legacyFence, [key]: null } } }), /all present or all absent|must be/u, `fence ${key}=null`);
    }

    const prUrl = "https://github.com/acme/repo/pull/7";
    const legacyResult = { status: "completed", run_id: "run", pr_url: prUrl, pr_number: 7, repository: "acme/repo", head_sha: "a".repeat(40), draft: false, reason: null, summary: "PR created.", artifacts: {} };
    const completed = { ...runningRun(), status: "completed", pr_url: prUrl, terminal_result: legacyResult };
    assert.equal(validateRun(completed).terminal_result, legacyResult);
    for (const key of ["operation_id", "pr_node_id", "head_ref", "base_ref", "base_sha"]) {
      assert.throws(() => validateRun({ ...completed, terminal_result: { ...legacyResult, [key]: null } }), /successor PR tuple|must be/u, `completed ${key}=null`);
    }
  });

  it("requires complete current slice review authority and dual-panel successor bindings", () => {
    const sha = "a".repeat(40);
    const sliceBinding = { evidence_hash: HASH, review_hash: HASH, reviewed_commit: sha };
    const reviewSlice = durableSlice({ id: "slice", status: "review", attempts: 1, evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json" });
    for (let mask = 0; mask < 8; mask += 1) {
      const partial = { ...reviewSlice };
      Object.entries(sliceBinding).forEach(([key, value], index) => { if (mask & (1 << index)) partial[key] = value; });
      assert.throws(() => validateRun({ ...runningRun(), slices: [partial] }), /attempt_reviews: is required for review and merged slices/u, `slice mask ${mask}`);
    }
    const attemptReview = createSliceAttemptReview({ evidenceRef: reviewSlice.evidence_ref, evidenceHash: HASH, reviewRef: reviewSlice.review_ref, reviewHash: HASH, reviewedCommit: sha });
    const completeSlice = { ...reviewSlice, ...sliceBinding, attempt_reviews: [attemptReview] };
    assert.equal(validateRun({ ...runningRun(), slices: [completeSlice] }).slices[0].reviewed_commit, sha);
    assert.deepEqual(validateRun({ ...runningRun(), slices: [completeSlice] }).slices[0].attempt_reviews, [attemptReview]);
    assert.throws(() => validateRun({ ...runningRun(), slices: [{ ...completeSlice, status: "running" }] }), /forbidden outside review or merged/u);

    const validatorBase = { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" };
    const securityBase = { verdict: "PASS", review_ref: "reviews/security-reviewer.json" };
    const validatorBinding = { report_hash: HASH, review_hash: HASH, reviewed_head_sha: sha };
    const securityBinding = { review_hash: HASH, reviewed_head_sha: sha };
    for (let mask = 1; mask < 7; mask += 1) {
      const validator = { ...validatorBase };
      Object.entries(validatorBinding).forEach(([key, value], index) => { if (mask & (1 << index)) validator[key] = value; });
      assert.throws(() => validateRun({ ...runningRun(), validator, security_review: securityBase }), /all present or all absent|both use successor/u, `validator mask ${mask}`);
    }
    for (let mask = 1; mask < 3; mask += 1) {
      const security = { ...securityBase };
      Object.entries(securityBinding).forEach(([key, value], index) => { if (mask & (1 << index)) security[key] = value; });
      assert.throws(() => validateRun({ ...runningRun(), validator: validatorBase, security_review: security }), /all present or all absent/u, `security mask ${mask}`);
    }
    for (const [label, validator, security_review] of [
      ["validator successor/security absent", { ...validatorBase, ...validatorBinding }, undefined],
      ["validator successor/security null", { ...validatorBase, ...validatorBinding }, null],
      ["validator successor/security legacy", { ...validatorBase, ...validatorBinding }, securityBase],
      ["security successor/validator absent", undefined, { ...securityBase, ...securityBinding }],
      ["security successor/validator null", null, { ...securityBase, ...securityBinding }],
      ["security successor/validator legacy", validatorBase, { ...securityBase, ...securityBinding }],
    ]) {
      assert.throws(() => validateRun({ ...runningRun(), validator, security_review }), /both use successor reviewed-head bindings/u, label);
    }
    const successor = validateRun({ ...runningRun(), validator: { ...validatorBase, ...validatorBinding }, security_review: { ...securityBase, ...securityBinding } });
    assert.equal(successor.validator.reviewed_head_sha, sha);
    assert.equal(successor.security_review.review_hash, HASH);
  });

  it("accepts continuation reviews with summary or required fixes", () => {
    const summaryOnly = continuationMetadata();
    summaryOnly.review.required_fixes = [];
    assert.equal(validateRun({ ...runningRun(), continuation: summaryOnly }).continuation.review.summary, "Validator found required fixes.");

    const fixesOnly = continuationMetadata();
    delete fixesOnly.review.summary;
    assert.deepEqual(validateRun({ ...runningRun(), continuation: fixesOnly }).continuation.review.required_fixes, ["fix failing acceptance test"]);
  });

  it("rejects invalid blocked-run continuation metadata", () => {
    const invalidVersion = continuationMetadata();
    invalidVersion.schema_version = 3;
    assert.throws(
      () => validateRun({ ...runningRun(), continuation: invalidVersion }),
      (error) => error instanceof ValidationError && error.message.includes("run.continuation.schema_version: must equal 1"),
    );

    const invalidParentStatus = continuationMetadata();
    invalidParentStatus.parent.status = "completed";
    assert.throws(
      () => validateRun({ ...runningRun(), continuation: invalidParentStatus }),
      (error) => error instanceof ValidationError && error.message.includes("run.continuation.parent.status: must be one of blocked"),
    );

    const invalidReviewHash = continuationMetadata();
    invalidReviewHash.review.hash = "not-a-hash";
    assert.throws(
      () => validateRun({ ...runningRun(), continuation: invalidReviewHash }),
      (error) => error instanceof ValidationError && error.message.includes("run.continuation.review.hash: must be a sha256 hash"),
    );

    const mismatchedTarget = continuationMetadata("other-run");
    assert.throws(
      () => validateRun({ ...runningRun("run"), continuation: mismatchedTarget }),
      (error) => error instanceof ValidationError && error.message.includes("run.continuation.target.run_id: must match run.run_id"),
    );

    const missingReviewDetail = continuationMetadata();
    missingReviewDetail.review.summary = "";
    missingReviewDetail.review.required_fixes = [];
    assert.throws(
      () => validateRun({ ...runningRun(), continuation: missingReviewDetail }),
      (error) => error instanceof ValidationError && error.message.includes("run.continuation.review: requires summary or required_fixes"),
    );

    const invalidArtifactHash = continuationMetadata();
    invalidArtifactHash.parent_artifacts[0].hash = "not-a-hash";
    assert.throws(
      () => validateRun({ ...runningRun(), continuation: invalidArtifactHash }),
      (error) => error instanceof ValidationError && error.message.includes("run.continuation.parent_artifacts[0].hash: must be a sha256 hash"),
    );

    const invalidArtifactShape = continuationMetadata();
    invalidArtifactShape.parent_artifacts = { refs: { validation_report: "artifacts/validation-report.md" }, hashes: { validation_report: HASH } };
    assert.throws(
      () => validateRun({ ...runningRun(), continuation: invalidArtifactShape }),
      (error) => error instanceof ValidationError && error.message.includes("run.continuation.parent_artifacts: must be an array"),
    );
  });

  it("preserves v1 while accepting only the closed schema-v2 carry-forward projection", () => {
    const v1 = continuationMetadata();
    assert.equal(validateRun({ ...runningRun(), continuation: v1 }).continuation.carry_forward, undefined);
    const invalidV1 = structuredClone(v1);
    invalidV1.carry_forward = carryForwardMetadata();
    assert.throws(() => validateRun({ ...runningRun(), continuation: invalidV1 }), /carry_forward: is not allowed/u);

    const v2 = continuationMetadata("continuation-run");
    v2.schema_version = 2;
    v2.carry_forward = carryForwardMetadata();
    v2.parent.commit = v2.carry_forward.start_commit;
    v2.target.base_ref = "refs/remotes/origin/main";
    v2.planning_reuse = {
      eligible: true, spec_review_ref: "reviews/spec-writer.json", spec_review_hash: HASH,
      spec_artifact_ref: "artifacts/technical-brief.md", spec_artifact_hash: HASH, child_spec_review_ref: "reviews/spec-writer.json",
    };
    const policy = { enabled: false, wait_ms: 3_600_000, initial_poll_ms: 30_000, max_poll_ms: 120_000, check_start_grace_ms: 300_000, max_transient_errors: 12, review: { required: false, reviewer_login: null, source: "none" } };
    v2.configuration = { mode: "headless", github_account: null, pr_mode: "ready", max_parallel_slices: 3, max_retries: 3, post_pr_policy: policy };
    const run = {
      ...runningRun("continuation-run"), mode: "headless", branch: v2.target.branch, worktree: v2.target.worktree, github_account: null, pr_mode: "ready",
      max_parallel_slices: 3, max_retries: 3, continuation: v2,
      post_pr: { schema_version: 1, policy, phase: "disabled", attempt: 0, observation: null, remediation: null, evidence_refs: [], continuation_review: null, terminal_fact: null, pr_operation: null },
      slices: [
        durableSlice({ id: "A", stack: "backend", depends_on: [], status: "merged", ...v2.carry_forward.accepted_slices[0] }, ["src/A.js"]),
        durableSlice({ id: "B", stack: "backend", depends_on: ["A"], status: "pending", attempts: 0 }, ["src/B.js"]),
      ],
    };
    assert.equal(validateRun(run).continuation.schema_version, 2);
    const acceptedVerifier = structuredClone(run);
    acceptedVerifier.steps = [{
      agent: "test-verifier", status: "accepted", attempts: 1,
      artifact_ref: "artifacts/test-report.md", evidence_ref: "evidence/test-verifier.attempt-1.json", review_ref: "reviews/test-verifier.attempt-1.json",
      execution_claim: {
        schema_version: 1, kind: "checked-test-execution-claim", state: "completed", nonce: "123e4567-e89b-42d3-a456-426614174000",
        run_id: "continuation-run", attempt: 1, plan_ref: "plan/slices.json", plan_hash: HASH, head_sha: "a".repeat(40),
        receipt_ref: "evidence/test-verifier.attempt-1.json", claimed_at: "2026-07-17T12:00:00.000Z",
        completed_at: "2026-07-17T12:01:00.000Z", status: "pass", receipt_hash: HASH,
      },
      acceptance: {
        artifact_ref: "artifacts/test-report.md", artifact_hash: HASH,
        evidence_ref: "evidence/test-verifier.attempt-1.json", evidence_hash: HASH,
        review_ref: "reviews/test-verifier.attempt-1.json", review_hash: HASH, reviewed_head_sha: "a".repeat(40),
      },
    }];
    acceptedVerifier.steps[0].execution_claim_hash = hashValue(acceptedVerifier.steps[0].execution_claim);
    assert.equal(validateRun(acceptedVerifier).steps[0].acceptance.evidence_hash, HASH);
    assert.equal(validateRun(acceptedVerifier).steps[0].execution_claim.status, "pass");
    const missingVerifierEvidence = structuredClone(acceptedVerifier);
    delete missingVerifierEvidence.steps[0].acceptance.evidence_hash;
    assert.throws(() => validateRun(missingVerifierEvidence), /acceptance\.evidence_hash: is required for accepted schema-v2 test-verifier/u);
    const invalidV1Configuration = structuredClone(v1);
    invalidV1Configuration.configuration = structuredClone(v2.configuration);
    assert.throws(() => validateRun({ ...runningRun(), continuation: invalidV1Configuration }), /configuration: is not allowed for schema_version 1/u);
    for (const [label, mutate, expected] of [
      ["extra", (candidate) => { candidate.continuation.configuration.extra = true; }, /configuration\.extra: is not allowed/u],
      ["mode", (candidate) => { candidate.continuation.configuration.mode = "legacy"; }, /configuration\.mode: must be one of/u],
      ["github_account", (candidate) => { candidate.continuation.configuration.github_account = ""; }, /configuration\.github_account: must be null or a non-empty string/u],
      ["pr_mode", (candidate) => { candidate.continuation.configuration.pr_mode = "prompt"; }, /configuration\.pr_mode: must be one of/u],
      ["max_parallel_slices", (candidate) => { candidate.continuation.configuration.max_parallel_slices = 2; }, /configuration\.max_parallel_slices: must be an integer from 3 to 3/u],
      ["max_retries", (candidate) => { candidate.continuation.configuration.max_retries = 4; }, /configuration\.max_retries: must be an integer from 3 to 3/u],
      ["post_pr_policy", (candidate) => { candidate.continuation.configuration.post_pr_policy.enabled = "no"; }, /configuration\.post_pr_policy\.enabled: must be a boolean/u],
    ]) {
      const candidate = structuredClone(run);
      mutate(candidate);
      assert.throws(() => validateRun(candidate), expected, label);
    }
    for (const [label, mutate] of [
      ["mode", (candidate) => { candidate.mode = "autonomous"; }],
      ["github_account", (candidate) => { candidate.github_account = "octo-org"; }],
      ["pr_mode", (candidate) => { candidate.pr_mode = "draft"; }],
      ["max_parallel_slices", (candidate) => { candidate.max_parallel_slices = 2; }],
      ["max_retries", (candidate) => { candidate.max_retries = 2; }],
      ["post_pr_policy", (candidate) => { candidate.post_pr.policy = { ...candidate.post_pr.policy, wait_ms: 7_200_000 }; }],
    ]) {
      const candidate = structuredClone(run);
      mutate(candidate);
      assert.throws(() => validateRun(candidate), /must exactly match immutable schema-v2 continuation configuration/u, label);
    }
    const rewrittenAccepted = structuredClone(run);
    rewrittenAccepted.slices[0].attempts = 2;
    assert.throws(() => validateRun(rewrittenAccepted), /adopted carry-forward row is immutable/u);
  });

  it("rejects merged rows before advisory checks when review authority is absent", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo, "consistency");
    const run = {
      ...runningRun("consistency"),
      gates: { story: { status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer: "approve", answered_at: "2026-07-08T12:00:00.000Z" } },
      slices: [{ id: "one", status: "merged", attempts: 1, evidence_ref: "evidence/one.json", review_ref: null, merge_commit: null }],
    };
    writeJson(join(runDir, "run.json"), run);

    try {
      const result = checkRunConsistency(runDir, run);
      const errors = result.checks.flatMap((check) => check.errors || []).map((error) => error.message).join("\n");
      assert.equal(result.ok, false);
      assert.match(errors, /is required for review and merged slices/u);
      assert.match(errors, /review and merged slices require complete evidence_hash, review_hash, and reviewed_commit bindings/u);
    } finally {
      cleanup(repo);
    }
  });

  it("validates run directories with schema plus consistency checks", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo, "valid-dir");
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    mkdirSync(join(runDir, "gates"), { recursive: true });
    writeFileSync(join(runDir, "artifacts", "story.md"), "story\n");
    writeFileSync(join(runDir, "gates", "story.question.md"), "approve?\n");
    writeJson(join(runDir, "run.json"), {
      ...runningRun("valid-dir"),
      gates: { story: { status: "pending", artifact: "artifacts/story.md", question_ref: "gates/story.question.md" } },
    });

    try {
      assert.equal(validateRunDir(runDir).ok, true);
    } finally {
      cleanup(repo);
    }
  });

  it("enforces depth before seeding while preserving deeper seeded runs", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo, "legacy-depth");
    const plan = slicesPlan([
      plannedSlice("root"),
      plannedSlice("second", ["root"]),
      plannedSlice("third", ["second"]),
      plannedSlice("fourth", ["third"]),
      plannedSlice("fifth", ["fourth"]),
    ]);
    mkdirSync(join(runDir, "plan"), { recursive: true });
    writeJson(join(runDir, "plan", "slices.json"), plan);
    writeJson(join(runDir, "run.json"), runningRun("legacy-depth"));

    try {
      assert.equal(validateRunDir(runDir).ok, false, "new unseeded plans enforce the depth cap");

      writeJson(join(runDir, "run.json"), {
        ...runningRun("legacy-depth"),
        slices: plan.slices.map(({ id, stack, paths, depends_on }) => durableSlice({ id, stack, depends_on, status: "pending", attempts: 0 }, paths)),
      });
      assert.equal(validateRunDir(runDir).ok, true, "existing seeded plans remain readable");
    } finally {
      cleanup(repo);
    }
  });

  it("does not grandfather the depth cap when run.slices is not the durable form of the current plan", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo, "stale-depth");
    const plan = slicesPlan([
      plannedSlice("root"),
      plannedSlice("second", ["root"]),
      plannedSlice("third", ["second"]),
      plannedSlice("fourth", ["third"]),
      plannedSlice("fifth", ["fourth"]),
    ]);
    mkdirSync(join(runDir, "plan"), { recursive: true });
    writeJson(join(runDir, "plan", "slices.json"), plan);

    const withSlices = (slices) => ({ ...runningRun("stale-depth"), slices });
    try {
      // partial durable slice list must not exempt the over-depth plan
      writeJson(join(runDir, "run.json"), withSlices([{ id: "root", stack: "backend", depends_on: [], status: "pending", attempts: 0 }]));
      assert.equal(validateRunDir(runDir).ok, false, "a partial run.slices must not grandfather the plan");

      // unrelated ids likewise do not exempt
      writeJson(join(runDir, "run.json"), withSlices([
        { id: "x-a", stack: "backend", depends_on: [], status: "pending", attempts: 0 },
        { id: "x-b", stack: "backend", depends_on: ["x-a"], status: "pending", attempts: 0 },
        { id: "x-c", stack: "backend", depends_on: ["x-b"], status: "pending", attempts: 0 },
        { id: "x-d", stack: "backend", depends_on: ["x-c"], status: "pending", attempts: 0 },
        { id: "x-e", stack: "backend", depends_on: ["x-d"], status: "pending", attempts: 0 },
      ]));
      assert.equal(validateRunDir(runDir).ok, false, "an unrelated run.slices must not grandfather the plan");

      // same ids but a different dependency graph is still a mismatch
      writeJson(join(runDir, "run.json"), withSlices(plan.slices.map(({ id, stack, paths }) => durableSlice({ id, stack, depends_on: [], status: "pending", attempts: 0 }, paths))));
      assert.equal(validateRunDir(runDir).ok, false, "same ids with a different dependency graph must not grandfather the plan");

      // the exact durable form of this plan does grandfather it
      writeJson(join(runDir, "run.json"), withSlices(plan.slices.map(({ id, stack, paths, depends_on }) => durableSlice({ id, stack, depends_on, status: "pending", attempts: 0 }, paths))));
      assert.equal(validateRunDir(runDir).ok, true, "the exact durable form of the plan remains grandfathered");
    } finally {
      cleanup(repo);
    }
  });

  it("validates optional process evidence sidecars when present", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo, "process-valid");
    mkdirSync(join(runDir, "processes"), { recursive: true });
    writeJson(join(runDir, "run.json"), runningRun("process-valid"));

    try {
      assert.equal(validateRunDir(runDir).ok, true, "missing process.json remains valid for old runs");

      writeJson(join(runDir, "process.json"), processEvidence("process-valid", { cwd: repo }));
      assert.equal(validateRunDir(runDir).ok, true, "valid process.json is accepted");

      const cases = [
        { name: "run-id mismatch", value: processEvidence("other-run", { cwd: repo }), match: /run_id must match requested run/u },
        { name: "kind mismatch", value: processEvidence("process-valid", { cwd: repo, kind: "heartbeat" }), match: /kind must be opencode-process/u },
        { name: "non-positive pid", value: processEvidence("process-valid", { cwd: repo, pid: 0 }), match: /pid must be a positive integer/u },
        { name: "invalid state", value: processEvidence("process-valid", { cwd: repo, state: "stopping" }), match: /state must be one of running, cancelled, failed-closed, exited/u },
        { name: "invalid identity", value: processEvidence("process-valid", { cwd: repo, identity: null }), match: /identity must be an object/u },
        { name: "unverified identity", value: processEvidence("process-valid", { cwd: repo, identity: { start_marker: "unverified:4242:2026-07-09T15:00:00.000Z" } }), match: /identity\.start_marker must be verifiable process evidence/u },
        { name: "escaping log ref", value: processEvidence("process-valid", { cwd: repo, log_ref: "processes/../outside.log" }), match: /log_ref must stay under processes/u },
      ];

      for (const item of cases) {
        writeJson(join(runDir, "process.json"), item.value);
        const result = validateRunDir(runDir);
        const errors = result.checks.flatMap((check) => check.errors || []).map((error) => error.message).join("\n");
        assert.equal(result.ok, false, item.name);
        assert.match(errors, item.match, item.name);
      }
    } finally {
      cleanup(repo);
    }
  });

  it("allows pending gates to reference not-yet-written question and artifact files", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo, "pending-refs");
    const run = {
      ...runningRun("pending-refs"),
      gates: { story: { status: "pending", artifact: "artifacts/story.md", question_ref: "gates/story.question.md" } },
    };
    writeJson(join(runDir, "run.json"), run);

    try {
      assert.equal(checkRunConsistency(runDir, run).ok, true);
    } finally {
      cleanup(repo);
    }
  });
});

function runningRun(runId = "run") {
  return createRunRecord({ run_id: runId });
}

function snapshotRoot({ env } = {}) {
  return {
    created_with: {
      collected_at: "2026-07-08T12:00:00.000Z",
      event: "run-created",
      diagnostic_only: true,
      env,
    },
    last_resumed_with: null,
    resume_count: 0,
  };
}

function continuationMetadata(targetRunId = "run") {
  return {
    schema_version: 1,
    kind: "blocked-run-continuation",
    created_at: "2026-07-08T12:00:00.000Z",
    operator_summary: "Continue blocked parent run from implementation-validator review.",
    parent: {
      run_id: "parent-run",
      status: "blocked",
      run_ref: ".opencode/factory/parent-run/run.json",
      run_hash: HASH,
      branch: "parent-branch",
      commit: "a".repeat(40),
      worktree: "/tmp/parent-worktree",
    },
    review: {
      kind: "validator",
      ref: "reviews/implementation-validator.json",
      hash: HASH,
      subject: "parent-run",
      summary: "Validator found required fixes.",
      required_fixes: ["fix failing acceptance test"],
      source: "run.validator.review_ref",
    },
    target: {
      run_id: targetRunId,
      branch: "continuation-branch",
      worktree: "/tmp/continuation-worktree",
      base_ref: "main",
      base_commit: "b".repeat(40),
    },
    parent_artifacts: [
      { kind: "validation_report", ref: "artifacts/validation-report.md", hash: HASH },
    ],
    parent_evidence: [
      { kind: "evidence", ref: "evidence/test-verifier.json", hash: HASH },
    ],
    parent_reviews: [
      { kind: "review", ref: "reviews/implementation-validator.json", hash: HASH },
    ],
  };
}

function carryForwardMetadata() {
  const attemptReview = createSliceAttemptReview({ evidenceRef: "evidence/A.json", evidenceHash: HASH, reviewRef: "reviews/A.json", reviewHash: HASH, reviewedCommit: "a".repeat(40) });
  return {
    scope: "full-remaining-plan",
    plan_ref: "plan/slices.json",
    plan_hash: HASH,
    start_commit: "c".repeat(40),
    accepted_slices: [{
      id: "A",
      declared_paths: ["src/A.js"],
      effective_paths: ["src/A.js"],
      attempts: 1,
      attempt_reviews: [attemptReview],
      evidence_ref: "evidence/A.json",
      evidence_hash: HASH,
      review_ref: "reviews/A.json",
      review_hash: HASH,
      reviewed_commit: "a".repeat(40),
      merge_commit: "b".repeat(40),
    }],
    remaining_slice_ids: ["B"],
  };
}

function inheritedAcceptanceRun() {
  const continuation = continuationMetadata("continuation-run");
  continuation.planning_reuse = {
    eligible: true,
    spec_review_ref: "reviews/parent-spec-writer.json",
    spec_review_hash: HASH,
    spec_artifact_ref: "artifacts/technical-brief.md",
    spec_artifact_hash: HASH,
    child_spec_review_ref: "reviews/spec-writer.json",
  };
  return {
    ...runningRun("continuation-run"),
    branch: "continuation-branch",
    worktree: "/tmp/continuation-worktree",
    continuation,
    steps: [{
      agent: "spec-writer",
      status: "accepted",
      attempts: 1,
      artifact_ref: "artifacts/technical-brief.md",
      review_ref: "reviews/spec-writer.json",
      acceptance: {
        artifact_ref: "artifacts/technical-brief.md",
        artifact_hash: HASH,
        review_ref: "reviews/spec-writer.json",
        review_hash: HASH,
      },
      inherited_acceptance: {
        from_run_id: "parent-run",
        parent_spec_review_ref: "reviews/parent-spec-writer.json",
        artifact_hash: HASH,
        review_hash: HASH,
      },
    }],
  };
}

function processEvidence(runId = "run", overrides = {}) {
  const identity = { inspector: "test-inspector", start_marker: "start-1", command_name: "opencode" };
  const evidence = {
    schema_version: 1,
    kind: "opencode-process",
    run_id: runId,
    execution_id: "exec-1",
    pid: 4242,
    started_at: "2026-07-09T14:59:00.000Z",
    updated_at: "2026-07-09T14:59:00.000Z",
    state: "running",
    cwd: "/tmp/opencode-process-cwd",
    identity,
    log_ref: "processes/opencode.log",
    cancel: null,
    ...overrides,
  };
  if (overrides.identity && typeof overrides.identity === "object" && !Array.isArray(overrides.identity)) {
    evidence.identity = { ...identity, ...overrides.identity };
  }
  return evidence;
}

function plannedSlice(id, dependsOn = []) {
  return { id, stack: "backend", paths: [`src/${id}.js`], depends_on: dependsOn, acceptance: [id], test_plan: ["node --test"] };
}

function durableSlice(slice, declaredPaths = [`src/${slice.id}.js`]) {
  return { ...slice, declared_paths: [...declaredPaths], effective_paths: [...declaredPaths] };
}

function slicesPlan(slices) {
  return { slices };
}

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "validate-simplified-"));
}

function createRunDir(repo, runId) {
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validationErrorHasTerminalControl(error) {
  return hasTerminalControl(error.message)
    || error.errors.some((item) => hasTerminalControl(item.path) || hasTerminalControl(item.message));
}

function hasTerminalControl(value) {
  return /[\u0000-\u001F\u007F-\u009F]/u.test(value);
}

function hashFile(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
