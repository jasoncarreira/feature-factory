import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heartbeatStatus, startHeartbeat, stopHeartbeat } from "../src/factory.js";
import { HEARTBEAT_PHASES } from "../src/validate.js";

const RUN_ID = "heartbeat-liveness";

describe("factory heartbeat lifecycle", () => {
  it("performs an immediate once-equivalent tick and rejects overlapping starts", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    const original = runningRun({
      validator: { verdict: "GO-WITH-NITS", report: "validator.md", loops: 1 },
      security_review: { verdict: "PASS", report: "security.md", loops: 1 },
      pr_url: "https://example.com/pr/1",
    });
    writeJson(join(runDir, "run.json"), original);

    let lease;
    try {
      assert.equal(heartbeatStatus(RUN_ID, { cwd: repo }), null);

      lease = await startHeartbeat(RUN_ID, { phase: "builder-wave", intervalMs: 25, maxDurationMs: 5000 }, { cwd: repo });

      const storedRun = readJson(join(runDir, "run.json"));
      const storedLease = readJson(join(runDir, "heartbeat.json"));
      assert.equal(lease.token, storedLease.token);
      assert.equal(storedLease.status, "running");
      assert.equal(storedLease.interval_ms, 1000);
      assert.equal(storedLease.phase, "builder-wave");
      assert.deepEqual(storedRun, { ...original, heartbeat_at: storedLease.last_tick_at });

      await assert.rejects(
        startHeartbeat(RUN_ID, { phase: "slice-review", intervalMs: 1000, maxDurationMs: 5000 }, { cwd: repo }),
        /heartbeat already active/i,
      );
    } finally {
      await stopIfActive(repo, lease?.token);
      cleanup(repo);
    }
  });

  it("stops and freezes heartbeat writes after a successful stop", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    let lease;
    try {
      lease = await startHeartbeat(RUN_ID, { phase: "slice-review", intervalMs: 1000, maxDurationMs: 5000 }, { cwd: repo });

      const stopped = await stopHeartbeat(RUN_ID, { token: lease.token, waitMs: 300 }, { cwd: repo });
      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.stop_reason, "stop-requested");
      assert.equal(heartbeatStatus(RUN_ID, { cwd: repo }).status, "stopped");

      const stoppedRun = readJson(join(runDir, "run.json"));
      assert.equal(stopped.last_tick_at, stoppedRun.heartbeat_at);
      assert.equal(await waitForChange(() => readJson(join(runDir, "run.json")).heartbeat_at !== stoppedRun.heartbeat_at, { timeoutMs: 1200 }), false);
    } finally {
      await stopIfActive(repo, lease?.token);
      cleanup(repo);
    }
  });

  it("performs repeated interval ticks", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    let lease;
    try {
      lease = await startHeartbeat(RUN_ID, { phase: "test-verifier", intervalMs: 1000, maxDurationMs: 5000 }, { cwd: repo });
      const firstHeartbeatAt = readJson(join(runDir, "run.json")).heartbeat_at;

      await waitFor(() => readJson(join(runDir, "run.json")).heartbeat_at !== firstHeartbeatAt, { timeoutMs: 2500 });
      const secondHeartbeatAt = readJson(join(runDir, "run.json")).heartbeat_at;
      const stopped = await stopHeartbeat(RUN_ID, { token: lease.token, waitMs: 300 }, { cwd: repo });

      const storedRun = readJson(join(runDir, "run.json"));
      const storedLease = readJson(join(runDir, "heartbeat.json"));
      assert.notEqual(secondHeartbeatAt, firstHeartbeatAt);
      assert.equal(stopped.status, "stopped");
      assert.equal(storedLease.last_tick_at, storedRun.heartbeat_at);
    } finally {
      await stopIfActive(repo, lease?.token);
      cleanup(repo);
    }
  });

  it("stops when the run becomes terminal without rewriting the terminal run manifest", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    let lease;
    try {
      lease = await startHeartbeat(RUN_ID, { phase: "security-reviewer", intervalMs: 1000, maxDurationMs: 5000 }, { cwd: repo });

      const terminal = completedRun({ heartbeat_at: readJson(join(runDir, "run.json")).heartbeat_at });
      writeJson(join(runDir, "run.json"), terminal);

      await waitFor(() => heartbeatStatus(RUN_ID, { cwd: repo })?.status === "stopped", { timeoutMs: 2500 });

      assert.deepEqual(readJson(join(runDir, "run.json")), terminal);
      assert.equal(heartbeatStatus(RUN_ID, { cwd: repo }).stop_reason, "run-completed");
    } finally {
      await stopIfActive(repo, lease?.token);
      cleanup(repo);
    }
  });

  it("stops itself when max duration elapses", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    try {
      await startHeartbeat(RUN_ID, { phase: "remediation", intervalMs: 1000, maxDurationMs: 1000 }, { cwd: repo });

      await waitFor(() => heartbeatStatus(RUN_ID, { cwd: repo })?.status === "stopped", { timeoutMs: 2500 });

      assert.equal(heartbeatStatus(RUN_ID, { cwd: repo }).stop_reason, "max-duration-exceeded");
    } finally {
      await stopIfActive(repo);
      cleanup(repo);
    }
  });

  it("can force stop an unresponsive lease", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());
    writeJson(join(runDir, "heartbeat.json"), heartbeatLease({ token: "force-lease", pid: process.pid }));

    try {
      await assert.rejects(
        stopHeartbeat(RUN_ID, { token: "force-lease", waitMs: 25 }, { cwd: repo }),
        /timed out waiting for heartbeat/i,
      );

      assert.equal(heartbeatStatus(RUN_ID, { cwd: repo }).status, "stopping");

      const stopped = await stopHeartbeat(RUN_ID, { token: "force-lease", waitMs: 25, force: true }, { cwd: repo });
      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.stop_reason, "force-stop");
    } finally {
      await stopIfActive(repo, "force-lease");
      cleanup(repo);
    }
  });

  it("accepts each allowed heartbeat phase label", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    try {
      for (const phase of HEARTBEAT_PHASES) {
        const lease = await startHeartbeat(RUN_ID, { phase, intervalMs: 1000, maxDurationMs: 2000 }, { cwd: repo });
        assert.equal(heartbeatStatus(RUN_ID, { cwd: repo }).phase, phase);
        await stopHeartbeat(RUN_ID, { token: lease.token, waitMs: 300 }, { cwd: repo });
      }
    } finally {
      await stopIfActive(repo);
      cleanup(repo);
    }
  });
});

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "feature-factory-heartbeat-"));
}

function createRunDir(repo) {
  const runDir = join(repo, ".opencode", "factory", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

async function stopIfActive(repo, token) {
  try {
    const current = heartbeatStatus(RUN_ID, { cwd: repo });
    if (!current || ["stopped", "error"].includes(current.status)) return;
    await stopHeartbeat(RUN_ID, { token: token || current.token, waitMs: 100, force: true }, { cwd: repo });
  } catch {
    // Best-effort test cleanup.
  }
}

function runningRun(overrides = {}) {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    mode: "headless",
    status: "running",
    created_at: "2026-07-06T11:00:00.000Z",
    updated_at: "2026-07-06T11:05:00.000Z",
    heartbeat_at: "2026-07-06T11:05:00.000Z",
    branch: RUN_ID,
    worktree: `.opencode/worktrees/${RUN_ID}`,
    gates: {
      story: {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      },
    },
    steps: [
      {
        agent: "story-reader",
        status: "accepted",
        attempts: 1,
        artifact_ref: "artifacts/story.md",
      },
    ],
    slices: [
      {
        id: "factory-heartbeat-lifecycle",
        stack: "backend",
        depends_on: [],
        status: "running",
        branch: "heartbeat-liveness--factory-heartbeat-lifecycle",
        worktree: ".opencode/worktrees/heartbeat-liveness--factory-heartbeat-lifecycle",
        attempts: 1,
      },
    ],
    validator: null,
    security_review: null,
    pr_url: null,
    terminal_result: null,
    ...overrides,
  };
}

function completedRun(overrides = {}) {
  return {
    ...runningRun(),
    status: "completed",
    terminal_result: {
      status: "completed",
      run_id: RUN_ID,
      pr_url: null,
      reason: null,
      summary: "done",
      artifacts: {},
    },
    ...overrides,
  };
}

function heartbeatLease(overrides = {}) {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    token: "lease-1",
    phase: "security-reviewer",
    status: "running",
    pid: 4242,
    started_at: new Date(Date.now() - 1000).toISOString(),
    last_tick_at: new Date(Date.now() - 500).toISOString(),
    stop_requested_at: null,
    stopped_at: null,
    interval_ms: 1000,
    deadline_at: new Date(Date.now() + 10_000).toISOString(),
    stop_reason: null,
    ...overrides,
  };
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}

async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 200;
  const stepMs = options.stepMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(stepMs);
  }
  if (!predicate()) throw new Error("timed out waiting for test condition");
}

async function waitForChange(predicate, options = {}) {
  try {
    await waitFor(predicate, options);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === "timed out waiting for test condition") return false;
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
