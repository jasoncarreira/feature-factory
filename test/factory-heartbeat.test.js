import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertHeartbeatStartable, heartbeatStatus, startHeartbeat, stopHeartbeat } from "../src/factory.js";

const RUN_ID = "heartbeat-liveness";

describe("factory heartbeat lifecycle", () => {
  it("centralizes every heartbeat start guard", () => {
    const cases = [
      ["run status", runningRun({ status: "blocked" }), /must be running/u],
      ["pending steering", runningRun({ steering: { pending: {} } }), /pending steering/u],
      ["uncheckpointed steering", runningRun({ steering: { uncheckpointed: {} } }), /awaiting acknowledgement/u],
      ["action claim", runningRun({ steering: { action_claim: {} } }), /action awaiting start acknowledgement/u],
      ["pre-PR fence", runningRun({ steering: { pr_fence: {} } }), /active pre-PR fence/u],
      ["protected gate", runningRun({ gates: protectedGates("brief") }), /protected gate 'brief'/u],
      ["no in-flight work", runningRun({ steps: [], slices: [] }), /no in-flight factory work/u],
    ];

    assert.doesNotThrow(() => assertHeartbeatStartable(runningRun()));
    for (const [name, run, expected] of cases) {
      assert.throws(() => assertHeartbeatStartable(run), expected, name);
    }
  });

  it("rejects path-like heartbeat run ids", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    try {
      assert.throws(() => heartbeatStatus(runDir, { cwd: repo }), /bare <run-id>|inside \.opencode\/factory/i);
      await assert.rejects(
        startHeartbeat(runDir, { phase: "builder-wave", intervalMs: 1000 }, { cwd: repo }),
        /bare <run-id>|inside \.opencode\/factory/i,
      );
      await assert.rejects(stopHeartbeat(runDir, {}, { cwd: repo }), /bare <run-id>|inside \.opencode\/factory/i);
    } finally {
      cleanup(repo);
    }
  });

  it("refuses to start while protected gates are pending", async () => {
    for (const gate of ["story", "brief", "pre_pr"]) {
      const repo = tempRepo();
      const runDir = createRunDir(repo);
      writeJson(join(runDir, "run.json"), runningRun({ gates: protectedGates(gate) }));

      try {
        await assert.rejects(
          startHeartbeat(RUN_ID, { phase: "builder-wave", intervalMs: 1000 }, { cwd: repo }),
          new RegExp(`protected gate '${gate}'`, "i"),
        );
        assert.equal(heartbeatStatus(RUN_ID, { cwd: repo }), null, gate);
      } finally {
        cleanup(repo);
      }
    }
  });

  it("rejects symlinked run directories that resolve outside the factory root", async () => {
    const repo = tempRepo();
    const external = tempRepo();
    const runDir = createRunDir(repo);
    const escapedRun = join(external, "escaped-run");
    mkdirSync(escapedRun, { recursive: true });
    writeJson(join(escapedRun, "run.json"), runningRun());
    rmSync(runDir, { recursive: true, force: true });
    symlinkSync(escapedRun, runDir, "dir");

    try {
      assert.throws(() => heartbeatStatus(RUN_ID, { cwd: repo }), /inside \.opencode\/factory/i);
      await assert.rejects(
        startHeartbeat(RUN_ID, { phase: "builder-wave", intervalMs: 1000 }, { cwd: repo }),
        /inside \.opencode\/factory/i,
      );
    } finally {
      cleanup(repo);
      cleanup(external);
    }
  });

  it("starts for in-flight work when an approved gate lacks proof metadata", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun({
      gates: { story: { status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer_ref: "gates/story.answer" } },
    }));

    try {
      const started = await startHeartbeat(RUN_ID, { phase: "builder-wave", intervalMs: 1000 }, { cwd: repo });
      assert.equal(started.phase, "builder-wave");
      assert.equal(started.pid, process.pid);
      const stopped = await stopHeartbeat(RUN_ID, {}, { cwd: repo });
      assert.equal(stopped.pid, null);
    } finally {
      await stopIfActive(repo);
      cleanup(repo);
    }
  });

  it("starts with a fresh timestamp and rejects overlapping fresh starts", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    const original = runningRun({ review_tier: "standard" });
    writeJson(join(runDir, "run.json"), original);

    try {
      assert.equal(heartbeatStatus(RUN_ID, { cwd: repo }), null);

      const heartbeat = await startHeartbeat(RUN_ID, { phase: "builder-wave", intervalMs: 25 }, { cwd: repo });
      const storedRun = readJson(join(runDir, "run.json"));
      const storedHeartbeat = readJson(join(runDir, "heartbeat.json"));

      assert.equal(heartbeat.fresh, true);
      assert.equal(heartbeat.phase, "builder-wave");
      assert.equal(storedHeartbeat.pid, process.pid);
      assert.equal(storedHeartbeat.interval_ms, 1000);
      assert.deepEqual(storedRun, { ...original, heartbeat_at: storedHeartbeat.last_tick_at });

      await assert.rejects(
        startHeartbeat(RUN_ID, { phase: "slice-review", intervalMs: 1000 }, { cwd: repo }),
        /heartbeat already active/i,
      );
    } finally {
      await stopIfActive(repo);
      cleanup(repo);
    }
  });

  it("stops by clearing pid without requiring credentials", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    try {
      await startHeartbeat(RUN_ID, { phase: "slice-review", intervalMs: 1000 }, { cwd: repo });
      const heartbeatAt = readJson(join(runDir, "run.json")).heartbeat_at;

      const stopped = await stopHeartbeat(RUN_ID, {}, { cwd: repo });

      assert.equal(stopped.pid, null);
      assert.equal(stopped.fresh, false);
      assert.equal(heartbeatStatus(RUN_ID, { cwd: repo }).pid, null);
      assert.equal(readJson(join(runDir, "run.json")).heartbeat_at, heartbeatAt);
      assert.equal(await waitForChange(() => readJson(join(runDir, "run.json")).heartbeat_at !== heartbeatAt, { timeoutMs: 1200 }), false);
    } finally {
      await stopIfActive(repo);
      cleanup(repo);
    }
  });

  it("performs repeated interval ticks", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    try {
      await startHeartbeat(RUN_ID, { phase: "test-verifier", intervalMs: 1000 }, { cwd: repo });
      const firstHeartbeatAt = readJson(join(runDir, "run.json")).heartbeat_at;

      await waitFor(() => readJson(join(runDir, "run.json")).heartbeat_at !== firstHeartbeatAt, { timeoutMs: 2500 });
      const secondHeartbeatAt = readJson(join(runDir, "run.json")).heartbeat_at;
      const stopped = await stopHeartbeat(RUN_ID, {}, { cwd: repo });

      assert.notEqual(secondHeartbeatAt, firstHeartbeatAt);
      assert.equal(stopped.pid, null);
    } finally {
      await stopIfActive(repo);
      cleanup(repo);
    }
  });

  it("accepts opaque phase labels", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());

    try {
      const heartbeat = await startHeartbeat(RUN_ID, { phase: "operator-defined-phase", intervalMs: 1000 }, { cwd: repo });
      assert.equal(heartbeat.phase, "operator-defined-phase");
    } finally {
      await stopIfActive(repo);
      cleanup(repo);
    }
  });

  it("keeps indeterminate liveness distinct and refuses heartbeat replacement", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());
    writeJson(join(runDir, "heartbeat.json"), heartbeatRecord(424242));
    try {
      const opts = { cwd: repo, now: "2026-07-06T11:05:01.000Z", processAliveFn: () => "truthy-but-malformed" };
      assert.equal(heartbeatStatus(RUN_ID, opts).process_alive, null);
      await assert.rejects(startHeartbeat(RUN_ID, { phase: "slice-review", intervalMs: 1000 }, opts), /already active/i);
      assert.equal(readJson(join(runDir, "heartbeat.json")).pid, 424242);
    } finally {
      cleanup(repo);
    }
  });

  it("signals live lifecycle owners, clears absent owners, and fails closed for indeterminate pids", async () => {
    for (const [name, value, clears, signalCount] of [["absent", false, true, 0], ["live", true, true, 1], ["indeterminate", {}, false, 0]]) {
      const repo = tempRepo();
      const runDir = createRunDir(repo);
      const signals = [];
      const originalKill = process.kill;
      writeJson(join(runDir, "run.json"), runningRun());
      writeJson(join(runDir, "heartbeat.json"), heartbeatRecord(424242, repo));
      try {
        process.kill = (pid, signal) => { signals.push({ pid, signal }); return true; };
        const action = stopHeartbeat(RUN_ID, {}, {
          cwd: repo,
          processAliveFn: () => value,
          heartbeatInspectorFn: (pid) => ({ ok: true, inspector: "test-inspector", pid, start_marker: "heartbeat-start", command_name: "node", cwd: repo }),
        });
        if (clears) assert.equal((await action).pid, null, name);
        else await assert.rejects(action, /refusing to clear foreign pid/i, name);
        assert.equal(signals.length, signalCount, name);
        if (signalCount) assert.deepEqual(signals[0], { pid: 424242, signal: "SIGTERM" });
      } finally {
        process.kill = originalKill;
        cleanup(repo);
      }
    }
  });

  it("refuses to signal a live pid whose heartbeat start identity no longer matches", async () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    const signals = [];
    writeJson(join(runDir, "run.json"), runningRun());
    writeJson(join(runDir, "heartbeat.json"), heartbeatRecord(424242, repo));
    try {
      await assert.rejects(
        stopHeartbeat(RUN_ID, {}, {
          cwd: repo,
          processAliveFn: () => true,
          heartbeatInspectorFn: (pid) => ({ ok: true, inspector: "test-inspector", pid, start_marker: "reused-pid", command_name: "node", cwd: repo }),
          signalFn: (pid, signal) => signals.push({ pid, signal }),
        }),
        /ownership is mismatched/u,
      );
      assert.deepEqual(signals, []);
      assert.equal(readJson(join(runDir, "heartbeat.json")).pid, 424242);
    } finally {
      cleanup(repo);
    }
  });

  it("exits quietly when work becomes terminal, gated, or no longer in flight", async () => {
    for (const [name, nextRun] of [
      ["terminal", terminalRun("completed")],
      ["protected-gate", runningRun({ gates: protectedGates("pre_pr") })],
      ["no-in-flight-work", runningRun({ steps: [{ agent: "story-reader", status: "accepted", attempts: 1, artifact_ref: "artifacts/story.md" }], slices: [{ id: "slice", declared_paths: ["slice.txt"], effective_paths: ["slice.txt"], status: "merged", attempts: 1 }] })],
    ]) {
      const repo = tempRepo();
      const runDir = createRunDir(repo);
      writeJson(join(runDir, "run.json"), runningRun());

      try {
        await startHeartbeat(RUN_ID, { phase: "security-reviewer", intervalMs: 1000 }, { cwd: repo });
        const frozenHeartbeatAt = readJson(join(runDir, "run.json")).heartbeat_at;
        writeJson(join(runDir, "run.json"), { ...nextRun, heartbeat_at: frozenHeartbeatAt });

        await waitFor(() => heartbeatStatus(RUN_ID, { cwd: repo })?.pid === null, { timeoutMs: 2500 });

        assert.equal(readJson(join(runDir, "run.json")).heartbeat_at, frozenHeartbeatAt, name);
      } finally {
        await stopIfActive(repo);
        cleanup(repo);
      }
    }
  });
});

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "feature-factory-heartbeat-"));
}

function createRunDir(repo) {
  const runDir = join(repo, ".opencode", "factory", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, "factory.lock"), factoryLock());
  return runDir;
}

async function stopIfActive(repo) {
  try {
    const current = heartbeatStatus(RUN_ID, { cwd: repo });
    if (!current || current.pid === null) return;
    await stopHeartbeat(RUN_ID, {}, { cwd: repo });
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
    branch: null,
    worktree: null,
    gates: {},
    steps: [{ agent: "story-reader", status: "accepted", attempts: 1, artifact_ref: "artifacts/story.md" }],
    slices: [{ id: "slice", stack: "backend", depends_on: [], declared_paths: ["slice.txt"], effective_paths: ["slice.txt"], status: "running", branch: "heartbeat-liveness--slice", worktree: ".opencode/worktrees/heartbeat-liveness--slice", attempts: 1 }],
    validator: null,
    security_review: null,
    pr_url: null,
    terminal_result: null,
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

function heartbeatRecord(pid, cwd) {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    phase: "builder-wave",
    pid,
    last_tick_at: "2026-07-06T11:05:00.000Z",
    interval_ms: 1000,
    ...(cwd ? { identity: { inspector: "test-inspector", start_marker: "heartbeat-start", command_name: "node", cwd } } : {}),
  };
}

function terminalRun(status, overrides = {}) {
  return {
    ...runningRun(),
    status,
    terminal_result: {
      status,
      run_id: RUN_ID,
      pr_url: null,
      reason: status === "completed" ? null : `${status} run`,
      summary: "done",
      artifacts: {},
    },
    ...overrides,
  };
}

function factoryLock(overrides = {}) {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    session_owner: "session-1",
    updated_at: new Date(Date.now() - 1000).toISOString(),
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
  assert.fail("timed out waiting for test condition");
}

async function waitForChange(predicate, options = {}) {
  try {
    await waitFor(predicate, options);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
