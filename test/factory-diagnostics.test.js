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

describe("factory diagnostics aggregation", () => {
  it("exports the required condition and classification enums", () => {
    assert.deepEqual(DIAGNOSTIC_CONDITIONS, [
      "stale-heartbeat",
      "missing-heartbeat-process",
      "missing-worktree",
      "invalid-run-state",
      "invalid-authority",
      "unverifiable-authority",
      "protected-gate",
      "terminal-run",
    ]);
    assert.deepEqual(DIAGNOSTIC_CLASSIFICATIONS, ["healthy", "recoverable", "blocked", "needs-human", "terminal", "invalid"]);
  });

  it("uses the exact aggregation priority and detection-order tie break", () => {
    const tiedStale = diagnosticItem("stale-heartbeat", { checkedAt: CHECKED_AT });
    const tiedProcess = diagnosticItem("missing-heartbeat-process", { checkedAt: CHECKED_AT });

    assert.equal(aggregateDiagnostics([tiedStale, tiedProcess]).primary.condition, "missing-heartbeat-process");
    assert.equal(aggregateDiagnostics([
      diagnosticItem("terminal-run", { checkedAt: CHECKED_AT, terminalStatus: "completed" }),
      diagnosticItem("protected-gate", { checkedAt: CHECKED_AT }),
      diagnosticItem("missing-worktree", { checkedAt: CHECKED_AT }),
      diagnosticItem("invalid-authority", { checkedAt: CHECKED_AT }),
    ]).primary.condition, "invalid-authority");

    const first = { ...diagnosticItem("stale-heartbeat", { checkedAt: CHECKED_AT }), message: "first" };
    const second = { ...diagnosticItem("stale-heartbeat", { checkedAt: CHECKED_AT }), message: "second" };
    assert.equal(aggregateDiagnostics([first, second]).summary, "first");
  });

  it("returns a healthy envelope when there are no items", () => {
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
});

describe("factory diagnostics condition mappings", () => {
  it("maps every condition to the brief's exact classification/status/severity tuple", () => {
    const tuples = new Map([
      ["stale-heartbeat", ["recoverable", "warning", "warning"]],
      ["missing-heartbeat-process", ["recoverable", "warning", "warning"]],
      ["missing-worktree", ["blocked", "error", "error"]],
      ["invalid-run-state", ["invalid", "error", "critical"]],
      ["invalid-authority", ["invalid", "error", "critical"]],
      ["unverifiable-authority", ["blocked", "error", "critical"]],
      ["protected-gate", ["needs-human", "warning", "warning"]],
    ]);

    for (const [condition, [classification, status, severity]] of tuples) {
      const item = diagnosticItem(condition, { checkedAt: CHECKED_AT });
      assert.equal(item.classification, classification, condition);
      assert.equal(item.status, status, condition);
      assert.equal(item.severity, severity, condition);
    }

    assertTerminalTuple("completed", "terminal", "ok", "info");
    assertTerminalTuple("partial", "terminal", "ok", "info");
    assertTerminalTuple("blocked", "blocked", "error", "error");
    assertTerminalTuple("needs-human", "needs-human", "warning", "warning");
  });
});

describe("factory diagnostics run inspection", () => {
  it("reports invalid run JSON/schema as invalid-run-state and does not expose trusted authority", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeFileSync(join(runDir, "run.json"), "{ trailing: true, }\n", "utf8");

    try {
      const diagnostics = diagnoseRunDir(runDir, { cwd: repo, now: CHECKED_AT });
      assert.equal(diagnostics.authoritative, false);
      assert.equal(diagnostics.classification, "invalid");
      assert.equal(diagnostics.items[0].condition, "invalid-run-state");
      assert.doesNotMatch(JSON.stringify(diagnostics), /heartbeat_owner|token/u);
    } finally {
      cleanup(repo);
    }
  });

  it("marks heartbeat/process evidence liveness-only and non-authoritative", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun({ heartbeat_at: "2026-07-08T11:55:00.000Z" }));
    writeJson(join(runDir, "heartbeat.json"), heartbeatLease({ last_tick_at: "2026-07-08T11:55:00.000Z", pid: 987654321 }));

    try {
      const diagnostics = diagnoseRunDir(runDir, { cwd: repo, now: CHECKED_AT, processAliveFn: () => false, validateRunAuthorityFn: validAuthority });
      const conditions = diagnostics.items.map((item) => item.condition);
      assert.deepEqual(conditions, ["missing-heartbeat-process", "stale-heartbeat"]);
      for (const item of diagnostics.items) {
        assert.equal(item.authoritative, false);
        assert.equal(item.evidence.liveness_only, true);
        assert.equal(item.evidence.source, "heartbeat.json");
        assert.equal(Object.hasOwn(item.evidence, "token"), false);
      }
      assert.equal(diagnostics.classification, "recoverable");
      assert.equal(diagnostics.status, "warning");
    } finally {
      cleanup(repo);
    }
  });

  it("reports invalid sidecar schema as invalid-run-state before liveness checks", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun({ gates: { story: { status: "pending", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer_ref: "gates/story.answer" } } }));
    writeJson(join(runDir, "heartbeat.json"), { ...heartbeatLease(), token: "secret-heartbeat-token", status: "not-valid" });

    try {
      const diagnostics = diagnoseRunDir(runDir, { cwd: repo, now: CHECKED_AT });
      assert.equal(diagnostics.items[0].condition, "invalid-run-state");
      assert.equal(diagnostics.classification, "invalid");
      assert.doesNotMatch(JSON.stringify(diagnostics), /secret-heartbeat-token/u);
    } finally {
      cleanup(repo);
    }
  });

  it("suppresses heartbeat liveness alarms while protected gates are pending", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun({
      heartbeat_at: "2026-07-08T11:00:00.000Z",
      gates: { pre_pr: { status: "pending", artifact: "artifacts/pre_pr.md", question_ref: "gates/pre_pr.question.md", answer_ref: "gates/pre_pr.answer" } },
    }));
    writeJson(join(runDir, "heartbeat.json"), heartbeatLease({ last_tick_at: "2026-07-08T11:00:00.000Z", pid: 987654321 }));

    try {
      const diagnostics = diagnoseRunDir(runDir, { cwd: repo, now: CHECKED_AT, processAliveFn: () => false, validateRunAuthorityFn: validAuthority });
      assert.deepEqual(diagnostics.items.map((item) => item.condition), ["protected-gate"]);
      assert.equal(diagnostics.classification, "needs-human");
      assert.equal(diagnostics.status, "warning");
      assert.equal(diagnostics.severity, "warning");
    } finally {
      cleanup(repo);
    }
  });

  it("suppresses heartbeat and worktree liveness alarms for terminal valid runs", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), terminalRun("completed", { worktree: ".opencode/worktrees/missing", heartbeat_at: "2026-07-08T11:00:00.000Z" }));
    writeJson(join(runDir, "heartbeat.json"), heartbeatLease({ last_tick_at: "2026-07-08T11:00:00.000Z", pid: 987654321 }));

    try {
      const diagnostics = diagnoseRunDir(runDir, { cwd: repo, now: CHECKED_AT, processAliveFn: () => false, validateRunAuthorityFn: validAuthority });
      assert.deepEqual(diagnostics.items.map((item) => item.condition), ["terminal-run"]);
      assert.equal(diagnostics.classification, "terminal");
      assert.equal(diagnostics.status, "ok");
      assert.equal(diagnostics.severity, "info");
    } finally {
      cleanup(repo);
    }
  });

  it("reports missing worktrees only after run authority is valid", () => {
    const repo = tempRepo();
    const runDir = createRunDir(repo);
    writeJson(join(runDir, "run.json"), runningRun({ worktree: ".opencode/worktrees/missing" }));

    try {
      const diagnostics = diagnoseRunDir(runDir, { cwd: repo, now: CHECKED_AT, validateRunAuthorityFn: validAuthority });
      assert.equal(diagnostics.items[0].condition, "missing-worktree");
      assert.equal(diagnostics.classification, "blocked");
      assert.equal(diagnostics.status, "error");
    } finally {
      cleanup(repo);
    }
  });

  it("does not persist diagnostic state while inspecting a run", () => {
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
});

function assertTerminalTuple(status, classification, aggregateStatus, severity) {
  const item = diagnosticItem("terminal-run", { checkedAt: CHECKED_AT, terminalStatus: status });
  assert.equal(item.classification, classification, status);
  assert.equal(item.status, aggregateStatus, status);
  assert.equal(item.severity, severity, status);
}

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
    created_at: "2026-07-08T11:00:00.000Z",
    updated_at: "2026-07-08T11:30:00.000Z",
    heartbeat_at: "2026-07-08T11:59:00.000Z",
    gates: {},
    steps: [{ agent: "story-reader", status: "accepted", attempts: 1, artifact_ref: "artifacts/story.md" }],
    slices: [{ id: "diag-core", stack: "backend", depends_on: [], status: "running", attempts: 1 }],
    validator: null,
    security_review: null,
    terminal_result: null,
    ...overrides,
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

function heartbeatLease(overrides = {}) {
  return {
    schema_version: 1,
    run_id: RUN_ID,
    token: "secret-heartbeat-token",
    phase: "builder-wave",
    status: "running",
    pid: process.pid,
    started_at: "2026-07-08T11:00:00.000Z",
    last_tick_at: "2026-07-08T11:59:00.000Z",
    stop_requested_at: null,
    stopped_at: null,
    interval_ms: 30000,
    deadline_at: "2026-07-08T13:00:00.000Z",
    stop_reason: null,
    ...overrides,
  };
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validAuthority() {
  return { ok: true, checks: [], acceptedAttestations: {}, orderedRefs: [] };
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
