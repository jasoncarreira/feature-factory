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
    } finally {
      cleanup(repo);
    }
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
  return {
    ...runningRun(),
    status,
    terminal_result: { status, run_id: RUN_ID, pr_url: null, reason: status === "completed" ? null : `${status} run`, summary: "done", artifacts: {} },
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

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
