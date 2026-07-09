import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HEARTBEAT_PHASES } from "../src/validate.js";

const RUN_ID = "heartbeat-liveness";
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

describe("cli heartbeat routing", () => {
  it("starts, reports, and stops liveness heartbeats without credentials", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    let started;
    try {
      started = jsonOutput(runHeartbeatCli(repo, ["--start", "--phase", "builder-wave", "--interval", "1000", "--json"]));
      assert.equal(started.run_id, RUN_ID);
      assert.equal(started.phase, "builder-wave");
      assert.equal(started.fresh, true);
      assert.equal(Number.isInteger(started.pid), true);

      const current = jsonOutput(runHeartbeatCli(repo, ["--status", "--json"]));
      assert.equal(current.pid, started.pid);
      assert.equal(current.fresh, true);

      const stopped = jsonOutput(runHeartbeatCli(repo, ["--stop", "--json"]));
      assert.equal(stopped.pid, null);
      assert.equal(stopped.fresh, false);

      const finalStatus = jsonOutput(runHeartbeatCli(repo, ["--status", "--json"]));
      assert.equal(finalStatus.pid, null);
      assert.equal(finalStatus.fresh, false);
      await waitFor(() => !isProcessAlive(started.pid), { timeoutMs: 1500 });
    } finally {
      await stopIfActive(repo);
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

  it("rejects symlinked run ids that resolve outside the factory root", () => {
    const repo = tempRepo();
    const external = tempRepo();
    const runDir = createRunDir(repo);
    const escapedRun = join(external, "escaped-run");
    mkdirSync(escapedRun, { recursive: true });
    writeJson(join(runDir, "run.json"), runningRun());
    writeJson(join(escapedRun, "run.json"), runningRun({ run_id: "escaped-run" }));
    rmSync(runDir, { recursive: true, force: true });
    symlinkSync(escapedRun, runDir, "dir");

    try {
      const proc = runHeartbeatCli(repo, ["--status", "--json"]);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /inside \.opencode\/factory/i);
    } finally {
      cleanup(repo);
      cleanup(external);
    }
  });

  it("refuses to start while a protected gate is pending", () => {
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

  it("starts heartbeat for in-flight work without proof metadata", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun({ gates: { story: { status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer_ref: "gates/story.answer" } } }));

    try {
      const started = jsonOutput(runHeartbeatCli(repo, ["--start", "--phase", "builder-wave", "--interval", "1000", "--json"]));
      assert.equal(started.phase, "builder-wave");
      assert.equal(started.fresh, true);
      const stopped = jsonOutput(runHeartbeatCli(repo, ["--stop", "--json"]));
      assert.equal(stopped.pid, null);
    } finally {
      await stopIfActive(repo);
      cleanup(repo);
    }
  });

  it("accepts documented and operator-defined phase labels", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    try {
      for (const phase of [...HEARTBEAT_PHASES, "operator-defined-phase"]) {
        const started = jsonOutput(runHeartbeatCli(repo, ["--start", "--phase", phase, "--interval", "1000", "--json"]));
        const current = jsonOutput(runHeartbeatCli(repo, ["--status", "--json"]));

        assert.equal(started.phase, phase);
        assert.equal(current.phase, phase);
        assert.equal(current.fresh, true);

        const stopped = jsonOutput(runHeartbeatCli(repo, ["--stop", "--json"]));
        assert.equal(stopped.pid, null);
        await waitFor(() => !isProcessAlive(started.pid), { timeoutMs: 1500 });
      }
    } finally {
      await stopIfActive(repo);
      cleanup(repo);
    }
  });

  it("keeps ticking in the detached heartbeat process", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    let started;
    try {
      started = jsonOutput(runHeartbeatCli(repo, ["--start", "--phase", "builder-wave", "--interval", "1000", "--json"]));
      const firstHeartbeatAt = readJson(join(runDir, "run.json")).heartbeat_at;

      await waitFor(() => {
        const current = readJson(join(runDir, "run.json")).heartbeat_at;
        return current !== firstHeartbeatAt ? current : null;
      }, { timeoutMs: 2500 });

      assert.equal(jsonOutput(runHeartbeatCli(repo, ["--status", "--json"])).fresh, true);

      const stopped = jsonOutput(runHeartbeatCli(repo, ["--stop", "--json"]));
      assert.equal(stopped.pid, null);
      await waitFor(() => !isProcessAlive(started.pid), { timeoutMs: 1500 });
    } finally {
      await stopIfActive(repo);
      cleanup(repo);
    }
  });

  it("requires a phase and valid interval", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    try {
      const missingPhase = runHeartbeatCli(repo, ["--start", "--json"]);
      assert.notEqual(missingPhase.status, 0);
      assert.match(missingPhase.stderr, /heartbeat phase must be a non-empty string/i);

      const badInterval = runHeartbeatCli(repo, ["--start", "--phase", "builder-wave", "--interval", "0", "--json"]);
      assert.notEqual(badInterval.status, 0);
      assert.match(badInterval.stderr, /intervalMs must be a positive integer/i);
    } finally {
      cleanup(repo);
    }
  });

  it("prints a concise diagnostics column for stale heartbeat liveness", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun({ heartbeat_at: "2026-07-06T11:00:00.000Z" }));
    writeJson(join(runDir, "heartbeat.json"), heartbeatState({ pid: process.pid, phase: "diagnostic-phase" }));

    try {
      const proc = runFactoryCli(repo, ["list"]);
      assert.equal(proc.status, 0, proc.stderr);
      const line = proc.stdout.trim();
      const columns = line.split("\t");
      assert.equal(columns.length, 6);
      assert.equal(columns[0], RUN_ID);
      assert.equal(columns[1], "running");
      assert.equal(columns[4], "-");
      assert.match(columns[5], /recoverable\/warning:Heartbeat has not advanced/u);
    } finally {
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
  writeJson(join(runDir, "factory.lock"), factoryLock());
  return runDir;
}

function runHeartbeatCli(repo, args, runId = RUN_ID) {
  const proc = spawnSync(process.execPath, [CLI, "factory", "heartbeat", runId, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env },
    timeout: 15000,
  });
  if (proc.error) throw proc.error;
  return proc;
}

function runFactoryCli(repo, args) {
  const proc = spawnSync(process.execPath, [CLI, "factory", ...args, "--repo", repo], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env },
    timeout: 15000,
  });
  if (proc.error) throw proc.error;
  return proc;
}

function jsonOutput(proc) {
  assert.equal(proc.status, 0, proc.stderr || `heartbeat command failed with status ${proc.status}`);
  return JSON.parse(proc.stdout);
}

async function stopIfActive(repo) {
  try {
    const current = readHeartbeat(repo);
    if (!current || current.pid === null) return;
    runHeartbeatCli(repo, ["--stop", "--json"]);
    if (current.pid && current.pid !== process.pid) await waitFor(() => !isProcessAlive(current.pid), { timeoutMs: 1500 });
  } catch {
    // Best-effort detached process cleanup.
  }
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
    branch: null,
    worktree: null,
    gates: {},
    steps: [{ agent: "story-reader", status: "accepted", attempts: 1, artifact_ref: "artifacts/story.md" }],
    slices: [{ id: "cli-heartbeat-routing", stack: "backend", depends_on: [], status: "running", branch: "heartbeat-liveness--cli-heartbeat-routing", worktree: ".opencode/worktrees/heartbeat-liveness--cli-heartbeat-routing", attempts: 1 }],
    validator: null,
    security_review: null,
    pr_url: null,
    terminal_result: null,
    ...overrides,
  };
}

function heartbeatState(overrides = {}) {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    phase: "builder-wave",
    pid: 4242,
    last_tick_at: "2026-07-06T11:00:00.000Z",
    interval_ms: 1000,
    ...overrides,
  };
}

function protectedGates(pending) {
  return {
    [pending]: {
      status: "pending",
      artifact: `artifacts/${pending}.md`,
      question_ref: `gates/${pending}.question.md`,
      answer_ref: `gates/${pending}.answer`,
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

function factoryLock(overrides = {}) {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    session_owner: "session-1",
    updated_at: "2026-07-06T11:00:00.000Z",
    ...overrides,
  };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
