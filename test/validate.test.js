import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

    const unpairedArtifactHash = continuationMetadata();
    delete unpairedArtifactHash.parent_artifacts.hashes.validation_report;
    assert.throws(
      () => validateRun({ ...runningRun(), continuation: unpairedArtifactHash }),
      (error) => error instanceof ValidationError && error.message.includes("run.continuation.parent_artifacts.hashes.validation_report: is required"),
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
    parent: {
      run_id: "parent-run",
      status: "blocked",
      run_ref: "runs/parent-run/run.json",
      run_hash: HASH,
      branch: "parent-branch",
      commit: "abc123",
    },
    review: {
      ref: "reviews/implementation-validator.json",
      hash: HASH,
      subject: "parent-run",
      summary: "Validator found required fixes.",
      required_fixes: ["fix failing acceptance test"],
    },
    target: {
      run_id: targetRunId,
      branch: "continuation-branch",
      worktree: "/tmp/continuation-worktree",
    },
    parent_artifacts: {
      refs: {
        validation_report: "artifacts/validation-report.md",
        run_json: "runs/parent-run/run.json",
      },
      hashes: {
        validation_report: HASH,
        run_json: HASH,
      },
    },
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

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
