import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cancelFactoryRun } from "../src/factory.js";
import { recordDetachedProcessEvidence } from "../src/process-evidence.js";

const NOW = "2026-07-09T15:00:00.000Z";

describe("factory cancellation process evidence", { concurrency: false }, () => {
  it("sends one targeted SIGTERM when run-scoped evidence matches live identity", () => {
    const fixture = createFixture("cancel-valid");
    const beforeRun = readFileSync(join(fixture.runDir, "run.json"), "utf8");
    const signals = [];
    try {
      writeProcessEvidence(fixture, { pid: 4242 });

      const result = cancelFactoryRun(fixture.runId, {
        cwd: fixture.repo,
        now: NOW,
        inspectorFn: matchingInspector(fixture, 4242),
        signalFn: (pid, signal) => signals.push({ pid, signal }),
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, "cancelled");
      assert.equal(result.pid, 4242);
      assert.deepEqual(signals, [{ pid: 4242, signal: "SIGTERM" }]);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeRun);
      const processState = readJson(join(fixture.runDir, "process.json"));
      assert.equal(processState.state, "cancelled");
      assert.equal(processState.cancel.signal, "SIGTERM");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("fails closed for missing evidence and ignores heartbeat pids", () => {
    const fixture = createFixture("cancel-missing");
    const beforeRun = readFileSync(join(fixture.runDir, "run.json"), "utf8");
    const signals = [];
    try {
      writeJson(join(fixture.runDir, "heartbeat.json"), {
        schema_version: 1,
        run_id: fixture.runId,
        phase: "builder-wave",
        pid: 9876,
        interval_ms: 30000,
        last_tick_at: NOW,
      });

      const result = cancelFactoryRun(fixture.runId, {
        cwd: fixture.repo,
        inspectorFn: () => ({ ok: true, inspector: "test-inspector", pid: 9876, start_marker: "heartbeat", command_name: "opencode", cwd: fixture.repo }),
        signalFn: (pid, signal) => signals.push({ pid, signal }),
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, "failed-closed");
      assert.match(result.reason, /missing process evidence/u);
      assert.equal(result.process_ref, null);
      assert.equal(result.signaled, false);
      assert.deepEqual(signals, []);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeRun);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("requires an explicit run id instead of using latest-run authority", () => {
    const fixture = createFixture("cancel-require-run-id");
    const signals = [];
    try {
      writeProcessEvidence(fixture, { pid: 4242 });
      assert.throws(
        () => cancelFactoryRun(undefined, {
          cwd: fixture.repo,
          inspectorFn: matchingInspector(fixture, 4242),
          signalFn: (pid, signal) => signals.push({ pid, signal }),
        }),
        /factory cancel requires exactly one <run-id>/u,
      );
      assert.deepEqual(signals, []);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("refuses to overwrite live valid running process evidence", () => {
    const fixture = createFixture("record-refuse-live");
    try {
      writeProcessEvidence(fixture, { pid: 4242 });
      const before = readFileSync(join(fixture.runDir, "process.json"), "utf8");

      assert.throws(
        () => recordDetachedProcessEvidence(fixture.runDir, {
          runId: fixture.runId,
          pid: 5252,
          cwd: fixture.repo,
          commandName: "opencode",
          logRef: "processes/opencode.log",
          inspectorFn: matchingInspector(fixture, 4242),
        }),
        /refusing to overwrite live running process evidence/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "process.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("allows replacing running process evidence only when the existing process is proven stale", () => {
    const fixture = createFixture("record-allow-stale");
    try {
      writeProcessEvidence(fixture, { pid: 4242 });

      const evidence = recordDetachedProcessEvidence(fixture.runDir, {
        runId: fixture.runId,
        pid: 5252,
        cwd: fixture.repo,
        commandName: "opencode",
        logRef: "processes/opencode.log",
        inspectorFn: (pid) => {
          if (pid === 4242) return { ok: false, inspector: "test-inspector", reason: "stale pid" };
          return { ok: true, inspector: "test-inspector", pid, start_marker: "start-2", command_name: "opencode", cwd: fixture.repo };
        },
      });

      assert.equal(evidence.pid, 5252);
      assert.equal(evidence.state, "running");
      assert.equal(evidence.identity.start_marker, "start-2");
      const persisted = readJson(join(fixture.runDir, "process.json"));
      assert.equal(persisted.pid, 5252);
      assert.equal(persisted.identity.start_marker, "start-2");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("fails closed for stale, mismatched, or non-run-scoped evidence without mutating run.json", () => {
    const cases = [
      {
        name: "run-id-mismatch",
        evidence: { run_id: "other-run" },
        inspector: (fixture) => matchingInspector(fixture, 4242),
        reason: /run_id must match requested run/u,
      },
      {
        name: "bad-log-ref",
        evidence: { log_ref: "../processes/out.log" },
        inspector: (fixture) => matchingInspector(fixture, 4242),
        reason: /log_ref must stay under processes/u,
      },
      {
        name: "stale-pid",
        inspector: () => () => ({ ok: false, inspector: "test-inspector", reason: "stale pid" }),
        reason: /stale pid/u,
      },
      {
        name: "start-marker-mismatch",
        inspector: (fixture) => () => ({ ok: true, inspector: "test-inspector", pid: 4242, start_marker: "new-start", command_name: "opencode", cwd: fixture.repo }),
        reason: /start marker mismatch/u,
      },
      {
        name: "unsupported-inspector",
        evidence: { identity: { inspector: "unsupported-inspector" } },
        inspector: (fixture) => matchingInspector(fixture, 4242),
        reason: /unsupported inspector/u,
      },
      {
        name: "command-mismatch",
        inspector: (fixture) => () => ({ ok: true, inspector: "test-inspector", pid: 4242, start_marker: "start-1", command_name: "node", cwd: fixture.repo }),
        reason: /command mismatch/u,
      },
      {
        name: "cwd-mismatch",
        inspector: () => () => ({ ok: true, inspector: "test-inspector", pid: 4242, start_marker: "start-1", command_name: "opencode", cwd: resolve(tmpdir()) }),
        reason: /cwd mismatch/u,
      },
    ];

    for (const item of cases) {
      const fixture = createFixture(`cancel-${item.name}`);
      const beforeRun = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      const signals = [];
      try {
        writeProcessEvidence(fixture, item.evidence || {});
        const result = cancelFactoryRun(fixture.runId, {
          cwd: fixture.repo,
          inspectorFn: item.inspector(fixture),
          signalFn: (pid, signal) => signals.push({ pid, signal }),
        });

        assert.equal(result.ok, false, item.name);
        assert.equal(result.status, "failed-closed", item.name);
        assert.match(result.reason, item.reason, item.name);
        assert.equal(result.signaled, false, item.name);
        assert.deepEqual(signals, [], item.name);
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeRun, item.name);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("does not contain broad process cancellation helpers or group signal calls", () => {
    const source = [
      readFileSync(new URL("../src/process-evidence.js", import.meta.url), "utf8"),
      readFileSync(new URL("../src/factory.js", import.meta.url), "utf8"),
    ].join("\n");
    for (const token of ["p" + "kill", "kill" + "all"]) assert.equal(source.includes(token), false, token);
    assert.doesNotMatch(source, /process\.kill\(\s*-/u);
    assert.doesNotMatch(source, /\bspawn\([^)]*["'](?:p"?\s*\+\s*"?kill|killall)/u);
  });
});

function createFixture(runId) {
  const repo = mkdtempSync(join(tmpdir(), "factory-cancel-"));
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "processes"), { recursive: true });
  writeFileSync(join(runDir, "processes", "opencode.log"), "started\n", "utf8");
  writeJson(join(runDir, "run.json"), { schema_version: 1, run_id: runId, status: "running", gates: {} });
  return { repo, runDir, runId };
}

function writeProcessEvidence(fixture, overrides = {}) {
  const identity = {
    inspector: "test-inspector",
    start_marker: "start-1",
    command_name: "opencode",
    ...(overrides.identity || {}),
  };
  writeJson(join(fixture.runDir, "process.json"), {
    schema_version: 1,
    kind: "opencode-process",
    run_id: fixture.runId,
    execution_id: "exec-1",
    pid: 4242,
    started_at: "2026-07-09T14:59:00.000Z",
    updated_at: "2026-07-09T14:59:00.000Z",
    state: "running",
    cwd: fixture.repo,
    identity,
    log_ref: "processes/opencode.log",
    cancel: null,
    ...overrides,
    identity,
  });
}

function matchingInspector(fixture, pid) {
  return (inspectedPid) => ({
    ok: inspectedPid === pid,
    inspector: "test-inspector",
    pid: inspectedPid,
    start_marker: "start-1",
    command_name: "opencode",
    cwd: fixture.repo,
    reason: inspectedPid === pid ? null : "stale pid",
  });
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
