import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistFactoryRunResumeEnv, resumeFactory, writeSteering } from "../src/factory.js";

describe("factory resume", () => {
  it("builds an exact dry-run resume payload with steering pointers and no raw text", async () => {
    const fixture = createFixture("resume-pointer");
    try {
      const queued = await writeSteering(fixture.runId, "raw steering should not leak", { cwd: fixture.repo, now: "2026-07-08T12:00:00.000Z" });
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, json: true, headless: true });

      assert.equal(result.status, "dry-run");
      assert.equal(result.eligible, true);
      assert.deepEqual(result.payload.resume, { schema_version: 1, kind: "existing-run-resume", run_id: fixture.runId });
      assert.equal(result.payload.driver.mode, "headless");
      assert.equal(result.payload.driver.ready, false);
      assert.equal(result.payload.steering.raw_message_included, false);
      assert.deepEqual(result.payload.steering.pending, queued.steering);
      assert.deepEqual(result.payload.steering.consume.args, ["factory", "steer-consume", fixture.runId, "--ref", queued.steering.ref, "--hash", queued.steering.hash, "--json"]);
      assert.equal(JSON.stringify(result.payload).includes("raw steering"), false);
      assert.equal(readdirSync(join(fixture.repo, ".opencode", "factory")).length, 1);
      assert.equal(readJson(join(fixture.runDir, "run.json")).run_id, fixture.runId);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects fresh active heartbeat before resume spawn", async () => {
    const fixture = createFixture("resume-active-heartbeat");
    try {
      writeJson(join(fixture.runDir, "heartbeat.json"), heartbeat(fixture.runId));
      await assert.rejects(
        resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, processAliveFn: (pid) => pid === process.pid }),
        /active-heartbeat/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("record-resume locks and rejects active heartbeat before mutating debug snapshot", async () => {
    const fixture = createFixture("record-resume-active-heartbeat");
    try {
      writeJson(join(fixture.runDir, "heartbeat.json"), heartbeat(fixture.runId));
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(
        persistFactoryRunResumeEnv(fixture.runId, { cwd: fixture.repo, now: "2026-07-08T12:00:00.000Z", processAliveFn: (pid) => pid === process.pid }),
        /active-heartbeat/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });
});

function createFixture(runId) {
  const repo = mkdtempSync(join(tmpdir(), "factory-resume-"));
  const runDir = join(repo, ".opencode", "factory", runId);
  const worktree = join(repo, ".opencode", "worktrees", runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    status: "running",
    branch: runId,
    worktree,
    gates: {},
    slices: [{ id: "slice", status: "running", attempts: 1, branch: runId, worktree }],
  });
  return { repo, runDir, runId, worktree };
}

function heartbeat(runId) {
  return {
    schema_version: 1,
    run_id: runId,
    phase: "builder-wave",
    pid: process.pid,
    interval_ms: 30000,
    last_tick_at: new Date().toISOString(),
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
