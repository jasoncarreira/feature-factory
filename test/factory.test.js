import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRuns, startFactory, status, validateState } from "../src/factory.js";

describe("factory state validation", () => {
  it("validates run.json and plan/slices.json in a run directory", () => {
    const repo = tempRepo();
    const runDir = join(repo, ".opencode", "factory", "app-123");
    mkdirSync(join(runDir, "plan"), { recursive: true });
    writeJson(join(runDir, "run.json"), runningRun());
    writeJson(join(runDir, "plan", "slices.json"), slicePlan());

    const result = validateState("app-123", { cwd: repo });

    assert.equal(result.ok, true);
    assert.equal(result.runs[0].checks.length, 2);
    cleanup(repo);
  });

  it("reports invalid run files", () => {
    const repo = tempRepo();
    const runDir = join(repo, ".opencode", "factory", "broken");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "run.json"), { run_id: "broken", status: "blocked" });

    const result = validateState("broken", { cwd: repo });

    assert.equal(result.ok, false);
    assert.equal(result.runs[0].checks[0].errors[0].path, "run.terminal_result");
    cleanup(repo);
  });

  it("surfaces durable review tiers through validate, status, and list reads", () => {
    const repo = tempRepo();
    const runDir = join(repo, ".opencode", "factory", "app-123");
    mkdirSync(join(runDir, "plan"), { recursive: true });
    writeJson(join(runDir, "run.json"), runningRun({ review_tier: reviewTier() }));
    writeJson(join(runDir, "plan", "slices.json"), slicePlan());

    const validation = validateState("app-123", { cwd: repo });
    const current = status("app-123", { cwd: repo });
    const listed = listRuns({ cwd: repo });

    assert.equal(validation.ok, true);
    assert.deepEqual(current.review_tier, reviewTier());
    assert.equal(listed[0].review_tier, "strict");
    cleanup(repo);
  });

  it("returns null review tiers when run.json omits them", () => {
    const repo = tempRepo();
    const runDir = join(repo, ".opencode", "factory", "app-123");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "run.json"), runningRun());

    const current = status("app-123", { cwd: repo });
    const listed = listRuns({ cwd: repo });

    assert.equal(current.review_tier, null);
    assert.equal(listed[0].review_tier, null);
    cleanup(repo);
  });
});

describe("detached factory start", () => {
  it("starts opencode in the background and records a log path", () => {
    const repo = tempRepo();
    const bin = join(repo, "bin");
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, "opencode");
    writeFileSync(fake, "#!/bin/sh\nprintf '%s\n' \"$@\"\n", "utf8");
    chmodSync(fake, 0o755);

    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      const result = startFactory(["APP-123", "do", "work"], { cwd: repo, detached: true, headless: true });
      assert.equal(result.status, "started");
      assert.equal(typeof result.pid, "number");
      assert.equal(existsSync(result.log), true);
      assert.match(result.command, /opencode run/);
    } finally {
      process.env.PATH = oldPath;
      cleanup(repo);
    }
  });
});

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "feature-factory-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runningRun(overrides = {}) {
  return {
    schema_version: 1,
    run_id: "app-123",
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
    ...overrides,
  };
}

function reviewTier() {
  return {
    selected: "strict",
    source: "default",
    risk_reasons: ["security_or_auth"],
    rationale: "Risky changes require stricter review.",
  };
}

function slicePlan() {
  return {
    slices: [
      {
        id: "be-api",
        stack: "backend",
        paths: ["src/server/api/"],
        depends_on: [],
        acceptance: ["AC1"],
        test_plan: ["npm test -- api.feature.test"],
      },
    ],
  };
}
