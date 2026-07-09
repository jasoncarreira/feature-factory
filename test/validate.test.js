import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REDACTED_ENV_VALUE } from "../src/env-snapshot.js";
import { ValidationError, checkRunConsistency, validateRun, validateRunDir } from "../src/validate.js";

const HASH = `sha256:${"a".repeat(64)}`;

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

function hashFile(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
