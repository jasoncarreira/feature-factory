import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "./helpers/git-fixture.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HEARTBEAT_PHASES } from "../src/validate.js";
import { createTrackedProcessCleanup } from "./process-cleanup-helper.js";

const RUN_ID = "heartbeat-liveness";
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const CLI_RESULT_TIMEOUT = "CLI_RESULT_TIMEOUT";
const CLI_RESULT_TIMEOUT_MS = 15000;

describe("cli heartbeat routing", () => {
  it("starts, reports, and stops liveness heartbeats without credentials", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    const diagnostic = console.error;
    const owner = createTrackedProcessCleanup({ diagnostic });
    writeJson(join(runDir, "run.json"), runningRun());

    let started;
    try {
      started = jsonOutput(await runHeartbeatCliTracked(owner, repo, ["--start", "--phase", "builder-wave", "--interval", "1000", "--json"]));
      assert.equal(started.run_id, RUN_ID);
      assert.equal(started.phase, "builder-wave");
      assert.equal(started.fresh, true);
      assert.equal(Number.isInteger(started.pid), true);

      const current = jsonOutput(await runHeartbeatCliTracked(owner, repo, ["--status", "--json"]));
      assert.equal(current.pid, started.pid);
      assert.equal(current.fresh, true);

      const stopped = jsonOutput(await runHeartbeatCliTracked(owner, repo, ["--stop", "--json"]));
      assert.equal(stopped.pid, null);
      assert.equal(stopped.fresh, false);

      const finalStatus = jsonOutput(await runHeartbeatCliTracked(owner, repo, ["--status", "--json"]));
      assert.equal(finalStatus.pid, null);
      assert.equal(finalStatus.fresh, false);
      await waitFor(() => !isProcessAlive(started.pid), { timeoutMs: 1500 });
    } finally {
      await stopIfActive(repo, { owner, diagnostic });
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
    const diagnostic = console.error;
    const owner = createTrackedProcessCleanup({ diagnostic });
    writeJson(join(runDir, "run.json"), runningRun());

    try {
      for (const phase of [...HEARTBEAT_PHASES, "operator-defined-phase"]) {
        const started = jsonOutput(await runHeartbeatCliTracked(owner, repo, ["--start", "--phase", phase, "--interval", "1000", "--json"]));
        const current = jsonOutput(await runHeartbeatCliTracked(owner, repo, ["--status", "--json"]));

        assert.equal(started.phase, phase);
        assert.equal(current.phase, phase);
        assert.equal(current.fresh, true);

        const stopped = jsonOutput(await runHeartbeatCliTracked(owner, repo, ["--stop", "--json"]));
        assert.equal(stopped.pid, null);
        await waitFor(() => !isProcessAlive(started.pid), { timeoutMs: 1500 });
      }
    } finally {
      await stopIfActive(repo, { owner, diagnostic });
      cleanup(repo);
    }
  });

  it("keeps ticking in the detached heartbeat process", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    const diagnostic = console.error;
    const owner = createTrackedProcessCleanup({ diagnostic });
    writeJson(join(runDir, "run.json"), runningRun());

    let started;
    try {
      started = jsonOutput(await runHeartbeatCliTracked(owner, repo, ["--start", "--phase", "builder-wave", "--interval", "1000", "--json"]));
      const firstHeartbeatAt = readJson(join(runDir, "run.json")).heartbeat_at;

      await waitFor(() => {
        const current = readJson(join(runDir, "run.json")).heartbeat_at;
        return current !== firstHeartbeatAt ? current : null;
      }, { timeoutMs: 2500 });

      assert.equal(jsonOutput(await runHeartbeatCliTracked(owner, repo, ["--status", "--json"])).fresh, true);

      const stopped = jsonOutput(await runHeartbeatCliTracked(owner, repo, ["--stop", "--json"]));
      assert.equal(stopped.pid, null);
      await waitFor(() => !isProcessAlive(started.pid), { timeoutMs: 1500 });
    } finally {
      await stopIfActive(repo, { owner, diagnostic });
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

  it("heartbeat teardown cleans the owner once for absent state and null PID", async () => {
    for (const state of ["absent", "null-pid"]) {
      const repo = tempRepo();
      createRunDir(repo);
      if (state === "null-pid") writeJson(join(repo, ".opencode", "factory", RUN_ID, "heartbeat.json"), heartbeatState({ pid: null }));
      let cleanupCount = 0;
      let stopCount = 0;
      let observationCount = 0;

      try {
        await stopIfActive(repo, {
          owner: { cleanup: async () => { cleanupCount += 1; } },
          runTracked: async () => { stopCount += 1; },
          isAlive: () => { observationCount += 1; return false; },
        });
        assert.equal(cleanupCount, 1);
        assert.equal(stopCount, 0);
        assert.equal(observationCount, 0);
      } finally {
        cleanup(repo);
      }
    }
  });

  it("heartbeat teardown diagnoses a nonzero public stop and continues observation", async () => {
    const repo = teardownRepo(4242);
    const diagnostics = [];
    let cleanupCount = 0;
    let observationCount = 0;
    try {
      await stopIfActive(repo, {
        owner: { cleanup: async () => { cleanupCount += 1; } },
        diagnostic: (entry) => diagnostics.push(entry),
        runTracked: async () => ({ status: 7, signal: null, stderr: "stop failed" }),
        isAlive: () => { observationCount += 1; return false; },
      });
      assert.equal(observationCount, 1);
      assert.equal(cleanupCount, 1);
      assert.deepEqual(diagnostics.map(({ outcome }) => outcome), ["public-stop-failed"]);
      assert.equal(diagnostics[0].stderr, "stop failed");
    } finally {
      cleanup(repo);
    }
  });

  it("heartbeat teardown diagnoses a public stop result timeout and continues observation", async () => {
    const repo = teardownRepo(4242);
    const diagnostics = [];
    let cleanupCount = 0;
    let observationCount = 0;
    try {
      await stopIfActive(repo, {
        owner: { cleanup: async () => { cleanupCount += 1; } },
        diagnostic: (entry) => diagnostics.push(entry),
        runTracked: async () => { throw Object.assign(new Error("deadline"), { code: CLI_RESULT_TIMEOUT }); },
        isAlive: () => { observationCount += 1; return false; },
      });
      assert.equal(observationCount, 1);
      assert.equal(cleanupCount, 1);
      assert.deepEqual(diagnostics.map(({ outcome }) => outcome), ["public-stop-timed-out"]);
    } finally {
      cleanup(repo);
    }
  });

  it("heartbeat teardown stop and liveness success are silent", async () => {
    const repo = teardownRepo(4242);
    const diagnostics = [];
    let cleanupCount = 0;
    try {
      await stopIfActive(repo, {
        owner: { cleanup: async () => { cleanupCount += 1; } },
        diagnostic: (entry) => diagnostics.push(entry),
        runTracked: async () => ({ status: 0, signal: null, stderr: "" }),
        isAlive: () => false,
      });
      assert.equal(cleanupCount, 1);
      assert.deepEqual(diagnostics, []);
    } finally {
      cleanup(repo);
    }
  });

  it("heartbeat teardown bounds and diagnoses detached child liveness timeout", async () => {
    const repo = teardownRepo(4242);
    const diagnostics = [];
    let cleanupCount = 0;
    const startedAt = Date.now();
    try {
      await stopIfActive(repo, {
        owner: { cleanup: async () => { cleanupCount += 1; } },
        diagnostic: (entry) => diagnostics.push(entry),
        runTracked: async () => ({ status: 0, signal: null, stderr: "" }),
        livenessTimeoutMs: 10,
        isAlive: () => true,
      });
      assert.ok(Date.now() - startedAt < 500);
      assert.equal(cleanupCount, 1);
      assert.deepEqual(diagnostics.map(({ outcome }) => outcome), ["detached-child-liveness-timed-out"]);
    } finally {
      cleanup(repo);
    }
  });

  it("heartbeat teardown swallows throwing diagnostics for stop and liveness failures", async () => {
    for (const stopResult of [{ status: 9, signal: null, stderr: "failed" }, { status: 0, signal: null, stderr: "" }]) {
      const repo = teardownRepo(4242);
      let cleanupCount = 0;
      try {
        await stopIfActive(repo, {
          owner: { cleanup: async () => { cleanupCount += 1; } },
          diagnostic: () => { throw new Error("diagnostic failed"); },
          runTracked: async () => stopResult,
          livenessTimeoutMs: 5,
          isAlive: () => true,
        });
        assert.equal(cleanupCount, 1);
      } finally {
        cleanup(repo);
      }
    }
  });

  it("heartbeat teardown preserves a prior assertion failure and cleans once", async () => {
    const repo = tempRepo();
    createRunDir(repo);
    const sentinel = new assert.AssertionError({ message: "sentinel" });
    let cleanupCount = 0;
    let caught;
    try {
      try {
        throw sentinel;
      } finally {
        await stopIfActive(repo, { owner: { cleanup: async () => { cleanupCount += 1; } } });
      }
    } catch (error) {
      caught = error;
    } finally {
      cleanup(repo);
    }
    assert.equal(caught, sentinel);
    assert.equal(cleanupCount, 1);
  });

  it("heartbeat teardown does not retry rejected cleanup or let diagnostics mask a sentinel", async () => {
    const repo = tempRepo();
    createRunDir(repo);
    const sentinel = new assert.AssertionError({ message: "sentinel" });
    let cleanupCount = 0;
    let caught;
    try {
      try {
        throw sentinel;
      } finally {
        await stopIfActive(repo, {
          owner: { cleanup: async () => { cleanupCount += 1; throw new Error("cleanup rejected"); } },
          diagnostic: () => { throw new Error("diagnostic failed"); },
        });
      }
    } catch (error) {
      caught = error;
    } finally {
      cleanup(repo);
    }
    assert.equal(caught, sentinel);
    assert.equal(cleanupCount, 1);
  });

  it("heartbeat teardown cleans the owner while fixture state still exists", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    let fixtureExistedDuringCleanup = false;
    try {
      await stopIfActive(repo, {
        owner: { cleanup: async () => { fixtureExistedDuringCleanup = existsSync(runDir); } },
      });
    } finally {
      cleanup(repo);
    }
    assert.equal(fixtureExistedDuringCleanup, true);
    assert.equal(existsSync(repo), false);
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

function runHeartbeatCliTracked(owner, repo, args, runId = RUN_ID) {
  const child = owner.spawn(process.execPath, [CLI, "factory", "heartbeat", runId, ...args], {
    cwd: repo,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  }, { label: `heartbeat ${args[0] ?? "command"}` });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error(`heartbeat command result timed out after ${CLI_RESULT_TIMEOUT_MS}ms`), { code: CLI_RESULT_TIMEOUT }));
    }, CLI_RESULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => settle(() => reject(error)));
    child.once("close", (status, signal) => settle(() => resolve({
      pid: child.pid,
      output: [null, stdout, stderr],
      stdout,
      stderr,
      status,
      signal,
      error: null,
    })));

    function settle(complete) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      complete();
    }
  });
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

async function stopIfActive(repo, {
  owner = null,
  diagnostic = console.error,
  runTracked = runHeartbeatCliTracked,
  stopTimeoutMs = 15000,
  livenessTimeoutMs = 1500,
  isAlive = isProcessAlive,
} = {}) {
  const emit = heartbeatDiagnosticEmitter(diagnostic);
  try {
    let current;
    try {
      current = readHeartbeat(repo);
    } catch (error) {
      emit("heartbeat-state-read-failed", { operation: "read-heartbeat-state", pid: null, ...boundedError(error) });
      return;
    }
    if (!current || current.pid === null) return;

    const pid = current.pid;
    try {
      const result = owner
        ? await withResultTimeout(runTracked(owner, repo, ["--stop", "--json"], RUN_ID), stopTimeoutMs)
        : runHeartbeatCli(repo, ["--stop", "--json"]);
      if (result.status !== 0 || result.signal || result.error) {
        emit("public-stop-failed", {
          operation: RUN_ID,
          pid: positivePid(pid),
          status: result.status ?? null,
          signal: boundedText(result.signal, 160),
          errorCode: boundedText(result.error?.code, 160),
          errorMessage: boundedText(result.error?.message, 300),
          stderr: boundedText(result.stderr, 300),
        });
      }
    } catch (error) {
      const timedOut = error?.code === CLI_RESULT_TIMEOUT || error?.code === "ETIMEDOUT";
      emit(timedOut ? "public-stop-timed-out" : "public-stop-failed", {
        operation: RUN_ID,
        pid: positivePid(pid),
        status: null,
        signal: boundedText(error?.signal, 160),
        timeoutMs: timedOut ? stopTimeoutMs : undefined,
        ...boundedError(error),
        stderr: boundedText(error?.stderr, 300),
      });
    }

    if (positivePid(pid) !== null && pid !== process.pid) {
      try {
        await waitFor(() => !isAlive(pid), { timeoutMs: livenessTimeoutMs });
      } catch (error) {
        if (/timed out/i.test(String(error?.message))) {
          emit("detached-child-liveness-timed-out", {
            operation: RUN_ID,
            pid,
            timeoutMs: livenessTimeoutMs,
          });
        }
      }
    }
  } finally {
    if (owner) {
      try {
        await owner.cleanup();
      } catch (error) {
        emit("owner-cleanup-failed", { operation: "owner-cleanup", pid: null, ...boundedError(error) });
      }
    }
  }
}

function heartbeatDiagnosticEmitter(diagnostic) {
  const emitted = new Set();
  return (outcome, fields) => {
    if (emitted.size >= 3 || emitted.has(outcome) || typeof diagnostic !== "function") return;
    emitted.add(outcome);
    const entry = { source: "heartbeat-teardown", outcome, ...fields };
    for (const key of Object.keys(entry)) if (entry[key] === undefined) delete entry[key];
    try {
      diagnostic(entry);
    } catch {
      // Teardown diagnostics must not replace the test result.
    }
  };
}

function withResultTimeout(result, timeoutMs) {
  const normalizedTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 0 ? Number(timeoutMs) : CLI_RESULT_TIMEOUT_MS;
  let timer;
  return Promise.race([
    Promise.resolve(result),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`heartbeat command result timed out after ${normalizedTimeout}ms`), { code: CLI_RESULT_TIMEOUT })), normalizedTimeout);
    }),
  ]).finally(() => clearTimeout(timer));
}

function boundedError(error) {
  return {
    errorCode: boundedText(error?.code, 160),
    errorMessage: boundedText(error?.message ?? error, 300),
  };
}

function boundedText(value, limit) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, limit);
}

function positivePid(pid) {
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readHeartbeat(repo) {
  const file = join(repo, ".opencode", "factory", RUN_ID, "heartbeat.json");
  if (!existsSync(file)) return null;
  return readJson(file);
}

function teardownRepo(pid) {
  const repo = tempRepo();
  const runDir = createRunDir(repo);
  writeJson(join(runDir, "heartbeat.json"), heartbeatState({ pid }));
  return repo;
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
