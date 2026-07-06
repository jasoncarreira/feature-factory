import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HEARTBEAT_PHASES } from "../src/validate.js";

const RUN_ID = "heartbeat-liveness";
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

describe("cli heartbeat routing", () => {
  it("routes start, status, owner-bound once, and stop heartbeat commands", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    let started;
    try {
      started = jsonOutput(runHeartbeatCli(repo, ["--start", "--phase", "builder-wave", "--interval", "1000", "--max-duration", "4000", "--json"]));
      assert.equal(started.run_id, RUN_ID);
      assert.equal(started.status, "running");
      assert.equal(started.phase, "builder-wave");

      const firstRun = readJson(join(runDir, "run.json"));
      const current = jsonOutput(runHeartbeatCli(repo, ["--status", "--json"]));
      assert.equal(current.token, null);
      assert.equal(current.pid, started.pid);
      assert.equal(current.status, "running");

      await sleep(20);

      const once = jsonOutput(runHeartbeatCli(repo, ["--once", "--token", started.token, "--json"]));
      assert.equal(once.updated, false);
      assert.equal(once.reason, "heartbeat-owner-mismatch");
      assert.equal(readJson(join(runDir, "run.json")).heartbeat_at, firstRun.heartbeat_at);

      const stopped = jsonOutput(runHeartbeatCli(repo, ["--stop", "--token", started.token, "--wait-ms", "2500", "--json"]));
      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.token, started.token);

      const finalStatus = jsonOutput(runHeartbeatCli(repo, ["--status", "--json"]));
      assert.equal(finalStatus.status, "stopped");
      assert.equal(finalStatus.token, null);
      await waitFor(() => !isProcessAlive(started.pid), { timeoutMs: 1500 });
    } finally {
      await stopIfActive(repo, started?.token);
      cleanup(repo);
    }
  });

  it("rejects path-like run ids", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    try {
      const proc = runHeartbeatCli(repo, ["--status", "--json"], runDir);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /bare <run-id>|inside \.opencode\/factory/i);
    } finally {
      cleanup(repo);
    }
  });

  it("refuses to start while a protected gate is pending", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun({ gates: protectedGates("brief") }));

    try {
      const proc = runHeartbeatCli(repo, ["--start", "--phase", "builder-wave", "--json"]);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /protected gate 'brief'/i);
    } finally {
      cleanup(repo);
    }
  });

  it("accepts each allowed heartbeat phase label", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    try {
      for (const phase of HEARTBEAT_PHASES) {
        const started = jsonOutput(runHeartbeatCli(repo, ["--start", "--phase", phase, "--interval", "1000", "--max-duration", "1000", "--json"]));
        const current = jsonOutput(runHeartbeatCli(repo, ["--status", "--json"]));

        assert.equal(started.phase, phase);
        assert.equal(current.phase, phase);
        assert.equal(current.token, null);

        const stopped = await waitForHeartbeatStop(repo, started.token, { timeoutMs: 2500 });
        assert.equal(stopped.phase, phase);
        assert.equal(stopped.status, "stopped");
        await waitFor(() => !isProcessAlive(started.pid), { timeoutMs: 1500 });
      }
    } finally {
      await stopIfActive(repo);
      cleanup(repo);
    }
  });

  it("keeps ticking in the detached heartbeat process without foreground progress commands", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    let started;
    try {
      started = jsonOutput(runHeartbeatCli(repo, ["--start", "--phase", "builder-wave", "--interval", "1000", "--max-duration", "4000", "--json"]));
      const firstHeartbeatAt = readJson(join(runDir, "run.json")).heartbeat_at;

      await waitFor(() => {
        const current = readJson(join(runDir, "run.json")).heartbeat_at;
        return current !== firstHeartbeatAt ? current : null;
      }, { timeoutMs: 2500 });

      assert.equal(jsonOutput(runHeartbeatCli(repo, ["--status", "--json"])).token, null);

      const stopped = jsonOutput(runHeartbeatCli(repo, ["--stop", "--token", started.token, "--wait-ms", "2500", "--json"]));
      assert.equal(stopped.status, "stopped");
      await waitFor(() => !isProcessAlive(started.pid), { timeoutMs: 1500 });
    } finally {
      await stopIfActive(repo, started?.token);
      cleanup(repo);
    }
  });

  it("fails for unknown phases and invalid intervals", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    try {
      const badPhase = runHeartbeatCli(repo, ["--start", "--phase", "unknown-phase", "--json"]);
      assert.notEqual(badPhase.status, 0);
      assert.match(badPhase.stderr, /heartbeat phase must be one of/i);

      const badInterval = runHeartbeatCli(repo, ["--start", "--phase", "builder-wave", "--interval", "0", "--json"]);
      assert.notEqual(badInterval.status, 0);
      assert.match(badInterval.stderr, /intervalMs must be a positive integer/i);
    } finally {
      await stopIfActive(repo);
      cleanup(repo);
    }
  });
});

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "feature-factory-cli-heartbeat-"));
}

function createRunDir(repo) {
  const runDir = join(repo, ".opencode", "factory", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

function runHeartbeatCli(repo, args, runId = RUN_ID) {
  const proc = spawnSync(process.execPath, [CLI, "factory", "heartbeat", runId, ...args], {
    cwd: repo,
    encoding: "utf8",
    timeout: 15000,
  });
  if (proc.error) throw proc.error;
  return proc;
}

function jsonOutput(proc) {
  assert.equal(proc.status, 0, proc.stderr || `heartbeat command failed with status ${proc.status}`);
  return JSON.parse(proc.stdout);
}

async function stopIfActive(repo, token) {
  try {
    const current = readHeartbeat(repo);
    if (!current) return;
    if (!["stopped", "error"].includes(current.status)) {
      const stop = runHeartbeatCli(repo, ["--stop", "--token", token || current.token, "--wait-ms", "2500", "--json"]);
      if (stop.status !== 0) runHeartbeatCli(repo, ["--stop", "--token", token || current.token, "--wait-ms", "25", "--force", "--json"]);
    }
    if (current.pid && current.pid !== process.pid) {
      await waitFor(() => !isProcessAlive(current.pid), { timeoutMs: 1500 });
    }
  } catch {
    // Best-effort detached process cleanup.
  }
}

async function waitForHeartbeatStop(repo, token, options = {}) {
  return waitFor(() => {
    const heartbeat = readHeartbeat(repo);
    if (!heartbeat || heartbeat.token !== token || heartbeat.status !== "stopped") return null;
    return heartbeat;
  }, options);
}

function readHeartbeat(repo) {
  const file = join(repo, ".opencode", "factory", RUN_ID, "heartbeat.json");
  if (!existsSync(file)) return null;
  return readJson(file);
}

async function waitFor(fn, { timeoutMs = 2500, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = fn();
    if (value) return value;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
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
        status: "approved",
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
        id: "cli-heartbeat-routing",
        stack: "backend",
        depends_on: [],
        status: "running",
        branch: "heartbeat-liveness--cli-heartbeat-routing",
        worktree: ".opencode/worktrees/heartbeat-liveness--cli-heartbeat-routing",
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

function protectedGates(pending) {
  return {
    story: {
      status: pending === "story" ? "pending" : "approved",
      artifact: "artifacts/story.md",
      question_ref: "gates/story.question.md",
      answer_ref: "gates/story.answer",
    },
    brief: {
      status: pending === "brief" ? "pending" : "approved",
      artifact: "artifacts/brief.md",
      question_ref: "gates/brief.question.md",
      answer_ref: "gates/brief.answer",
    },
    pre_pr: {
      status: pending === "pre_pr" ? "pending" : "approved",
      artifact: "artifacts/pre_pr.md",
      question_ref: "gates/pre_pr.question.md",
      answer_ref: "gates/pre_pr.answer",
    },
  };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return error?.code === "EPERM";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
