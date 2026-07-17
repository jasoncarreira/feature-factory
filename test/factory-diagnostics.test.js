import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIAGNOSTIC_CLASSIFICATIONS,
  DIAGNOSTIC_CONDITIONS,
  aggregateDiagnostics,
  diagnoseRunDir,
  diagnosticEnvelope,
  diagnosticItem,
} from "../src/factory-diagnostics.js";

const CHECKED_AT = "2026-07-08T12:00:00.000Z";
const RUN_ID = "diag-core";

describe("factory diagnostics", () => {
  it("exports liveness-only condition enums", () => {
    assert.deepEqual(DIAGNOSTIC_CONDITIONS, [
      "invalid-run-state",
      "missing-worktree",
      "missing-heartbeat-process",
      "stale-heartbeat",
      "protected-gate",
      "terminal-run",
    ]);
    assert.deepEqual(DIAGNOSTIC_CLASSIFICATIONS, ["healthy", "recoverable", "blocked", "needs-human", "terminal", "invalid"]);
  });

  it("aggregates by condition order and preserves detection order ties", () => {
    assert.equal(aggregateDiagnostics([
      diagnosticItem("terminal-run", { checkedAt: CHECKED_AT, terminalStatus: "completed" }),
      diagnosticItem("protected-gate", { checkedAt: CHECKED_AT }),
      diagnosticItem("missing-worktree", { checkedAt: CHECKED_AT }),
      diagnosticItem("invalid-run-state", { checkedAt: CHECKED_AT }),
    ]).primary.condition, "invalid-run-state");

    const first = { ...diagnosticItem("stale-heartbeat", { checkedAt: CHECKED_AT }), message: "first" };
    const second = { ...diagnosticItem("stale-heartbeat", { checkedAt: CHECKED_AT }), message: "second" };
    assert.equal(aggregateDiagnostics([first, second]).summary, "first");
  });

  it("returns a healthy authoritative envelope when no items exist", () => {
    assert.deepEqual(diagnosticEnvelope([], { checkedAt: CHECKED_AT, authoritative: true }), {
      schema_version: 1,
      checked_at: CHECKED_AT,
      authoritative: true,
      status: "ok",
      severity: "info",
      classification: "healthy",
      summary: "No diagnostics",
      items: [],
    });
  });

  it("reports stale/dead heartbeat evidence", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun({ heartbeat_at: "2026-07-08T11:00:00.000Z" }));
    writeJson(join(runDir, "heartbeat.json"), heartbeatState({ last_tick_at: "2026-07-08T11:00:00.000Z", pid: 987654321 }));

    try {
      const diagnostics = diagnoseRunDir(runDir, { cwd: repo, now: CHECKED_AT, processAliveFn: () => false });
      assert.deepEqual(diagnostics.items.map((item) => item.condition), ["missing-heartbeat-process", "stale-heartbeat"]);
      assert.equal(diagnostics.classification, "recoverable");
      assert.equal(diagnostics.items[0].evidence.liveness_only, true);
      assert.equal(diagnostics.items[0].evidence.process_alive, false);
    } finally {
      cleanup(repo);
    }
  });

  it("accepts only primitive booleans from legacy heartbeat liveness callbacks", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun({ heartbeat_at: "2026-07-08T11:00:00.000Z" }));
    writeJson(join(runDir, "heartbeat.json"), heartbeatState({ last_tick_at: "2026-07-08T11:00:00.000Z" }));

    try {
      for (const value of ["false", new Boolean(false), {}, [], 0, 1, null, undefined]) {
        const diagnostics = diagnoseRunDir(runDir, { cwd: repo, now: CHECKED_AT, processAliveFn: () => value });
        assert.deepEqual(diagnostics.items.map((item) => item.condition), ["stale-heartbeat"]);
        assert.equal(diagnostics.items[0].evidence.process_alive, null);
      }
      const thrown = diagnoseRunDir(runDir, {
        cwd: repo,
        now: CHECKED_AT,
        processAliveFn: () => { throw new Error("probe failed"); },
      });
      assert.deepEqual(thrown.items.map((item) => item.condition), ["stale-heartbeat"]);
      assert.equal(thrown.items[0].evidence.process_alive, null);

      const live = diagnoseRunDir(runDir, { cwd: repo, now: CHECKED_AT, processAliveFn: () => true });
      assert.deepEqual(live.items.map((item) => item.condition), ["stale-heartbeat"]);
      assert.equal(live.items[0].evidence.process_alive, true);
    } finally {
      cleanup(repo);
    }
  });

  it("projects final public diagnostic envelopes while preserving validated enums", () => {
    const secret = "Authorization: Basic dXNlcjpwYXNzd29yZA==";
    const envelope = diagnosticEnvelope([
      diagnosticItem("invalid-run-state", {
        checkedAt: CHECKED_AT,
        message: `Unsafe ${secret}\u001b[2J`,
        evidence: { source: "run.json", error: secret, path: `/tmp/${secret}` },
      }),
    ], { checkedAt: CHECKED_AT, authoritative: false });

    assert.equal(envelope.status, "error");
    assert.equal(envelope.classification, "invalid");
    assert.equal(envelope.items[0].condition, "invalid-run-state");
    assert.equal(JSON.stringify(envelope).includes("dXNlcjpwYXNzd29yZA=="), false);
    assert.equal(envelope.items[0].evidence.error.includes("[redacted]"), true);
  });

  it("suppresses stale heartbeat alarms when no heartbeat-bracketed work is in flight", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun({
      heartbeat_at: "2026-07-08T11:00:00.000Z",
      steps: [{ agent: "spec-writer", status: "blocked", attempts: 1 }],
      slices: [],
    }));
    writeJson(join(runDir, "heartbeat.json"), heartbeatState({ last_tick_at: "2026-07-08T11:00:00.000Z", pid: 987654321 }));

    try {
      const diagnostics = diagnoseRunDir(runDir, { cwd: repo, now: CHECKED_AT, processAliveFn: () => false });
      assert.deepEqual(diagnostics.items, []);
      assert.equal(diagnostics.classification, "healthy");
    } finally {
      cleanup(repo);
    }
  });

  it("suppresses heartbeat alarms while protected gates are pending", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun({
      gates: { pre_pr: { status: "pending", artifact: "artifacts/pre_pr.md", question_ref: "gates/pre_pr.question.md", answer_ref: "gates/pre_pr.answer" } },
    }));
    writeJson(join(runDir, "heartbeat.json"), heartbeatState({ last_tick_at: "2026-07-08T11:00:00.000Z", pid: 987654321 }));

    try {
      const diagnostics = diagnoseRunDir(runDir, { cwd: repo, now: CHECKED_AT, processAliveFn: () => false });
      assert.deepEqual(diagnostics.items.map((item) => item.condition), ["protected-gate"]);
      assert.equal(diagnostics.classification, "needs-human");
    } finally {
      cleanup(repo);
    }
  });

  it("treats terminal valid runs as terminal without authority proofs", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), terminalRun("completed"));
    writeJson(join(runDir, "heartbeat.json"), heartbeatState({ last_tick_at: "2026-07-08T11:00:00.000Z", pid: 987654321 }));

    try {
      const diagnostics = diagnoseRunDir(runDir, { cwd: repo, now: CHECKED_AT, processAliveFn: () => false });
      assert.deepEqual(diagnostics.items.map((item) => item.condition), ["terminal-run"]);
      assert.equal(diagnostics.classification, "terminal");
      assert.equal(diagnostics.authoritative, true);
    } finally {
      cleanup(repo);
    }
  });

  it("does not persist diagnostic state", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun({ heartbeat_at: "2026-07-08T11:00:00.000Z" }));
    const before = readFileSync(join(runDir, "run.json"), "utf8");
    try {
      diagnoseRunDir(runDir, { cwd: repo, now: CHECKED_AT });
      assert.equal(readFileSync(join(runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(repo);
    }
  });

  it("flags factory.lock run-id mismatches", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun());
    writeJson(join(runDir, "factory.lock"), { schema_version: 1, run_id: "other-run", session_owner: "session-1" });

    try {
      const diagnostics = diagnoseRunDir(runDir, { cwd: repo, now: CHECKED_AT });
      assert.equal(diagnostics.items[0].condition, "invalid-run-state");
      assert.match(diagnostics.summary, /factory\.lock\.run_id does not match run\.run_id/u);
      assert.equal(diagnostics.items[0].evidence.sidecar_run_id, "other-run");
    } finally {
      cleanup(repo);
    }
  });

  it("fails closed with invalid-run-state diagnostics for invalid process sidecars", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    mkdirSync(join(runDir, "processes"), { recursive: true });
    writeJson(join(runDir, "run.json"), runningRun());
    writeJson(join(runDir, "process.json"), processEvidence({ run_id: "other-run", cwd: repo }));

    try {
      const diagnostics = diagnoseRunDir(runDir, { cwd: repo, now: CHECKED_AT });

      assert.equal(diagnostics.classification, "invalid");
      assert.equal(diagnostics.authoritative, false);
      assert.equal(diagnostics.items[0].condition, "invalid-run-state");
      assert.match(diagnostics.summary, /cancellation must fail closed/u);
      assert.match(diagnostics.items[0].evidence.error, /run_id must match requested run/u);
      assert.equal(diagnostics.items[0].evidence.fail_closed, true);
      assert.equal(diagnostics.items[0].evidence.sidecar_run_id, "other-run");
      assert.match(diagnostics.items[0].action, /do not signal any process/u);
    } finally {
      cleanup(repo);
    }
  });

  it("accepts valid optional process sidecars without adding diagnostics", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    mkdirSync(join(runDir, "processes"), { recursive: true });
    writeJson(join(runDir, "run.json"), runningRun());
    writeJson(join(runDir, "process.json"), processEvidence({ cwd: repo }));

    try {
      const diagnostics = diagnoseRunDir(runDir, { cwd: repo, now: CHECKED_AT });
      assert.deepEqual(diagnostics.items, []);
      assert.equal(diagnostics.classification, "healthy");
    } finally {
      cleanup(repo);
    }
  });
});

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "factory-diagnostics-"));
}

function createRunDir(repo) {
  const runDir = join(repo, ".opencode", "factory", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

function runningRun(overrides = {}) {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    mode: "headless",
    status: "running",
    heartbeat_at: "2026-07-08T11:59:00.000Z",
    gates: {},
    slices: [{ id: "diag-core", stack: "backend", depends_on: [], status: "running", attempts: 1 }],
    ...overrides,
  };
}

function terminalRun(status) {
  const prUrl = "https://github.com/acme/diagnostics/pull/7";
  return {
    ...runningRun(),
    status,
    ...(status === "completed" ? { pr_url: prUrl } : {}),
    terminal_result: {
      status,
      run_id: RUN_ID,
      pr_url: status === "completed" ? prUrl : null,
      reason: status === "completed" ? null : `${status} run`,
      summary: "done",
      artifacts: {},
      ...(status === "completed" ? { repository: "acme/diagnostics", pr_number: 7, draft: false } : {}),
    },
  };
}

function heartbeatState(overrides = {}) {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    phase: "builder-wave",
    pid: process.pid,
    last_tick_at: "2026-07-08T11:59:00.000Z",
    interval_ms: 30000,
    ...overrides,
  };
}

function processEvidence(overrides = {}) {
  const identity = { inspector: "test-inspector", start_marker: "start-1", command_name: "opencode" };
  return {
    schema_version: 1,
    kind: "opencode-process",
    run_id: RUN_ID,
    execution_id: "exec-1",
    pid: 4242,
    started_at: "2026-07-09T14:59:00.000Z",
    updated_at: "2026-07-09T14:59:00.000Z",
    state: "running",
    cwd: "/tmp/opencode-process-cwd",
    identity,
    log_ref: "processes/opencode.log",
    cancel: null,
    ...overrides,
  };
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
