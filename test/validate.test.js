import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REDACTED_ENV_VALUE } from "../src/env-snapshot.js";
import { ValidationError, checkRunConsistency, validateRun, validateRunDir } from "../src/validate.js";

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
