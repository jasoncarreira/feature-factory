import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRuns, status, validateState } from "../src/factory.js";

describe("factory run.json strict JSON parsing", () => {
  it("reports JSONC comments in run.json as invalid factory state", () => {
    assertRunJsonRejected("commented-run", withLineComment(validRun("commented-run")));
  });

  it("reports trailing commas in run.json as invalid factory state", () => {
    assertRunJsonRejected("trailing-comma-run", withTrailingComma(validRun("trailing-comma-run")));
  });
});

function assertRunJsonRejected(runId, runJson) {
  const repo = tempRepo();
  const runDir = join(repo, ".opencode", "factory", runId);
  const runPath = join(runDir, "run.json");

  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(runPath, runJson, "utf8");

    const validation = validateState(runId, { cwd: repo });
    assert.equal(validation.ok, false);
    assert.equal(validation.runs[0].ok, false);
    assert.equal(validation.runs[0].checks.length, 1);
    assert.equal(validation.runs[0].checks[0].path, runPath);
    assert.equal(validation.runs[0].checks[0].ok, false);
    assert.equal(validation.runs[0].checks[0].errors[0].path, runPath);
    assert.equal(typeof validation.runs[0].checks[0].errors[0].message, "string");
    assert.notEqual(validation.runs[0].checks[0].errors[0].message, "");

    const listed = listRuns({ cwd: repo });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].run_id, runId);
    assert.equal(listed[0].status, "invalid");
    assert.equal(typeof listed[0].error, "string");
    assert.notEqual(listed[0].error, "");

    assert.throws(() => status(runId, { cwd: repo }), SyntaxError);
  } finally {
    cleanup(repo);
  }
}

function validRun(runId) {
  return {
    schema_version: 1,
    run_id: runId,
    mode: "headless",
    status: "running",
    updated_at: "2026-07-05T00:00:00.000Z",
    gates: {
      story: {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      },
    },
  };
}

function withLineComment(value) {
  return `${JSON.stringify(value, null, 2).replace("{\n", "{\n  // JSONC comments must not parse in durable factory state\n")}\n`;
}

function withTrailingComma(value) {
  return `${JSON.stringify(value, null, 2).replace(/\n\}$/u, ",\n}")}\n`;
}

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "feature-factory-strict-json-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
