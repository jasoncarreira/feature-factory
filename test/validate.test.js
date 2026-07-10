import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recomputeCostAttribution } from "../src/cost-attribution.js";
import { REDACTED_ENV_VALUE } from "../src/env-snapshot.js";
import { ValidationError, checkRunConsistency, validateCostAttributionEntries, validateRun, validateRunDir, validateSlicesPlan } from "../src/validate.js";

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

    const run = validateRun({ ...runningRun(), slices: [{ id: "slice", status: "running" }], cost_attribution: costAttribution });

    assert.equal(run.cost_attribution.schema_version, 1);
    assert.equal(run.cost_attribution.status, "available");
    assert.equal(run.cost_attribution.totals.total_tokens, 15);
  });

  it("accepts cost attribution rollup keys such as __proto__", () => {
    const costAttribution = recomputeCostAttribution({ entries: [
      { id: "cost-1", recorded_at: "2026-07-08T12:00:00.000Z", run_id: "run", agent: "__proto__", slice_id: "__proto__", provider: "opencode", model: "gpt-5.5", input_tokens: 10, cost_total: 0.02, cost_currency: "USD" },
    ] }, { now: "2026-07-08T12:00:01.000Z" });

    const run = validateRun({ ...runningRun(), slices: [{ id: "__proto__", status: "running" }], cost_attribution: costAttribution });

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
    invalidVersion.schema_version = 2;
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

  it("reports advisory consistency failures for missing refs and merged slices", () => {
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
      assert.match(errors, /missing artifacts ref|missing gates ref|merged slice requires review_ref|merged slice requires merge_commit/u);
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
  return { schema_version: 1, run_id: runId, status: "running", gates: {} };
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
      run_ref: "runs/parent-run/run.json",
      run_hash: HASH,
      branch: "parent-branch",
      commit: "abc123",
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
      base_commit: "def456",
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
