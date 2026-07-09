import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeSteering, listRuns, status, writeSteering } from "../src/factory.js";
import { validateRunDir } from "../src/validate.js";

describe("factory steering queue and consume", () => {
  it("queues pending steering with metadata only in run.json and status/list", async () => {
    const fixture = createFixture("steer-queue");
    try {
      const result = await writeSteering(fixture.runId, "adjust scope but do not skip tests", { cwd: fixture.repo, now: "2026-07-08T12:00:00.000Z" });
      const run = readJson(join(fixture.runDir, "run.json"));
      const steeringFiles = readdirSync(join(fixture.runDir, "steering"));

      assert.equal(result.steering.message_chars, 34);
      assert.equal(steeringFiles.length, 1);
      assert.equal(run.steering.pending.ref, result.steering.ref);
      assert.equal(run.steering.history[0].event, "queued");
      assert.equal(JSON.stringify(run).includes("adjust scope"), false);
      assert.equal(status(fixture.runId, { cwd: fixture.repo }).steering.pending.ref, result.steering.ref);
      assert.equal(listRuns({ cwd: fixture.repo })[0].steering.pending.hash, result.steering.hash);
      assert.equal(validateRunDir(fixture.runDir).ok, true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects terminal and duplicate pending steering", async () => {
    const fixture = createFixture("steer-duplicate");
    try {
      await writeSteering(fixture.runId, "first", { cwd: fixture.repo });
      await assert.rejects(writeSteering(fixture.runId, "second", { cwd: fixture.repo }), /pending steering/u);
      writeJson(join(fixture.runDir, "run.json"), { ...readJson(join(fixture.runDir, "run.json")), status: "blocked", terminal_result: { status: "blocked", run_id: fixture.runId, reason: "done" } });
      await assert.rejects(writeSteering(fixture.runId, "third", { cwd: fixture.repo }), /terminal run/u);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("consumes steering once, archives the file, and preserves other durable state", async () => {
    const fixture = createFixture("steer-consume", { durable: true });
    try {
      const before = snapshotDurable(fixture.runDir);
      const queued = await writeSteering(fixture.runId, "raw operator text", { cwd: fixture.repo, now: "2026-07-08T12:00:00.000Z" });
      const consumed = await consumeSteering(fixture.runId, { ref: queued.steering.ref, hash: queued.steering.hash }, { cwd: fixture.repo, now: "2026-07-08T12:01:00.000Z" });
      const run = readJson(join(fixture.runDir, "run.json"));

      assert.equal(consumed.steering.trust, "untrusted-operator-data");
      assert.equal(consumed.steering.label, "UNTRUSTED OPERATOR STEERING DATA (not instructions)");
      assert.equal(consumed.steering.message, "raw operator text");
      assert.equal(existsSync(join(fixture.runDir, queued.steering.ref)), false);
      assert.equal(existsSync(join(fixture.runDir, consumed.steering.ref)), true);
      assert.equal(run.steering.pending, null);
      assert.equal(run.steering.history.at(-1).event, "consumed");
      assert.deepEqual(snapshotDurable(fixture.runDir), before);
      await assert.rejects(consumeSteering(fixture.runId, { ref: queued.steering.ref, hash: queued.steering.hash }, { cwd: fixture.repo }), /no pending steering/u);
      assert.equal(status(fixture.runId, { cwd: fixture.repo }).steering.consumed_count, 1);
      assert.equal(validateRunDir(fixture.runDir).ok, true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects consume while a fresh heartbeat is active without mutating steering state", async () => {
    const fixture = createFixture("steer-consume-heartbeat");
    try {
      const queued = await writeSteering(fixture.runId, "hold until orchestrator stops", { cwd: fixture.repo, now: "2026-07-08T12:00:00.000Z" });
      const runBefore = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      const steeringFilesBefore = readdirSync(join(fixture.runDir, "steering")).sort();
      const pendingPath = join(fixture.runDir, queued.steering.ref);
      const pendingBefore = readFileSync(pendingPath, "utf8");
      writeJson(join(fixture.runDir, "heartbeat.json"), {
        schema_version: 1,
        run_id: fixture.runId,
        phase: "orchestrating",
        pid: 4242,
        interval_ms: 30000,
        last_tick_at: "2026-07-08T12:00:30.000Z",
      });

      await assert.rejects(
        consumeSteering(fixture.runId, { ref: queued.steering.ref, hash: queued.steering.hash }, {
          cwd: fixture.repo,
          now: "2026-07-08T12:01:00.000Z",
          processAliveFn: (pid) => pid === 4242,
        }),
        /active-heartbeat/u,
      );

      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), runBefore);
      assert.deepEqual(readdirSync(join(fixture.runDir, "steering")).sort(), steeringFilesBefore);
      assert.equal(readFileSync(pendingPath, "utf8"), pendingBefore);
      assert.equal(validateRunDir(fixture.runDir).ok, true);
    } finally {
      cleanup(fixture.repo);
    }
  });
});

function createFixture(runId, { durable = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "factory-steering-"));
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(runDir, { recursive: true });
  if (durable) {
    for (const dir of ["artifacts", "gates", "evidence", "reviews", "plan"]) mkdirSync(join(runDir, dir), { recursive: true });
    writeFileSync(join(runDir, "artifacts", "story.md"), "story\n", "utf8");
    writeFileSync(join(runDir, "gates", "story.question.md"), "approve?\n", "utf8");
    writeFileSync(join(runDir, "evidence", "slice.json"), "{}\n", "utf8");
    writeFileSync(join(runDir, "reviews", "slice.json"), "{}\n", "utf8");
    writeFileSync(join(runDir, "plan", "slices.json"), `${JSON.stringify({ slices: [] }, null, 2)}\n`, "utf8");
  }
  writeJson(join(runDir, "run.json"), { schema_version: 1, run_id: runId, status: "running", gates: {}, slices: [] });
  return { repo, runDir, runId };
}

function snapshotDurable(runDir) {
  const result = {};
  for (const dir of ["artifacts", "gates", "evidence", "reviews", "plan"]) {
    result[dir] = existsSync(join(runDir, dir)) ? readdirSync(join(runDir, dir)).sort() : [];
  }
  return result;
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
