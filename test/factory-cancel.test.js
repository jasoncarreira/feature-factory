import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cancelFactoryRun } from "../src/factory.js";
import { inspectProcessIdentity, recordDetachedProcessEvidence } from "../src/process-evidence.js";

const NOW = "2026-07-09T15:00:00.000Z";

describe("factory cancellation process evidence", { concurrency: false }, () => {
  it("sends one targeted SIGTERM and confirms exit before recording cancelled", async () => {
    const fixture = createFixture("cancel-valid");
    const beforeRun = readFileSync(join(fixture.runDir, "run.json"), "utf8");
    const signals = [];
    try {
      writeProcessEvidence(fixture, { pid: 4242 });
      const result = await cancelFactoryRun(fixture.runId, {
        cwd: fixture.repo,
        now: NOW,
        cancelWaitMs: 500,
        // The process stays alive until it receives the signal, then exits.
        ...linuxProcessOptions(fixture, { liveness: () => signals.length > 0 ? "absent" : "live" }),
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

  it("stops the run heartbeat after confirmed process cancellation", async () => {
    const fixture = createFixture("cancel-with-heartbeat");
    const signals = [];
    try {
      writeProcessEvidence(fixture, { pid: 4242 });
      writeJson(join(fixture.runDir, "heartbeat.json"), {
        schema_version: 1,
        run_id: fixture.runId,
        phase: "builder-wave",
        pid: 9876,
        interval_ms: 30000,
        last_tick_at: NOW,
        identity: { inspector: "test-heartbeat", start_marker: "heartbeat-start", command_name: "node", cwd: fixture.repo },
      });
      const result = await cancelFactoryRun(fixture.runId, {
        cwd: fixture.repo,
        now: NOW,
        cancelWaitMs: 500,
        ...linuxProcessOptions(fixture, {
          liveness: (pid) => pid === 9876 || !signals.some((item) => item.pid === 4242) ? "live" : "absent",
        }),
        heartbeatInspectorFn: (pid) => ({ ok: true, inspector: "test-heartbeat", pid, start_marker: "heartbeat-start", command_name: "node", cwd: fixture.repo }),
        signalFn: (pid, signal) => signals.push({ pid, signal }),
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, "cancelled");
      assert.equal(result.heartbeat_stopped, true);
      assert.deepEqual(signals, [{ pid: 4242, signal: "SIGTERM" }, { pid: 9876, signal: "SIGTERM" }]);
      assert.equal(readJson(join(fixture.runDir, "heartbeat.json")).pid, null);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("keeps state running and reports cancel-pending while the process ignores SIGTERM", async () => {
    const fixture = createFixture("cancel-hung");
    const signals = [];
    try {
      writeProcessEvidence(fixture, { pid: 4242 });

      const pending = await cancelFactoryRun(fixture.runId, {
        cwd: fixture.repo,
        now: NOW,
        cancelWaitMs: 0,
        ...linuxProcessOptions(fixture),
        signalFn: (pid, signal) => signals.push({ pid, signal }),
      });

      assert.equal(pending.ok, false);
      assert.equal(pending.status, "cancel-pending");
      assert.equal(pending.signaled, true);
      assert.match(pending.reason, /still alive/u);
      const processState = readJson(join(fixture.runDir, "process.json"));
      assert.equal(processState.state, "running");
      assert.equal(processState.cancel.result, "pending");
      assert.equal(processState.cancel.confirmed_at, null);

      // Once the process is actually gone, a re-run confirms without signaling.
      const confirmed = await cancelFactoryRun(fixture.runId, {
        cwd: fixture.repo,
        now: NOW,
        ...linuxProcessOptions(fixture, { liveness: () => "absent" }),
        signalFn: (pid, signal) => signals.push({ pid, signal }),
      });

      assert.equal(confirmed.ok, true);
      assert.equal(confirmed.status, "cancelled");
      assert.equal(confirmed.signaled, false);
      assert.deepEqual(signals, [{ pid: 4242, signal: "SIGTERM" }]);
      assert.equal(readJson(join(fixture.runDir, "process.json")).state, "cancelled");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("re-running cancel after success is an idempotent no-op", async () => {
    const fixture = createFixture("cancel-idempotent");
    const signals = [];
    try {
      writeProcessEvidence(fixture, { pid: 4242, state: "cancelled", cancel: { requested_at: NOW, signal: "SIGTERM", confirmed_at: NOW, result: "cancelled", reason: null } });

      const result = await cancelFactoryRun(fixture.runId, {
        cwd: fixture.repo,
        ...linuxProcessOptions(fixture),
        signalFn: (pid, signal) => signals.push({ pid, signal }),
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, "cancelled");
      assert.equal(result.updated, false);
      assert.deepEqual(signals, []);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("fails closed for missing evidence and ignores heartbeat pids", async () => {
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

      const result = await cancelFactoryRun(fixture.runId, {
        cwd: fixture.repo,
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

  it("requires an explicit run id instead of using latest-run authority", async () => {
    const fixture = createFixture("cancel-require-run-id");
    const signals = [];
    try {
      writeProcessEvidence(fixture, { pid: 4242 });
      await assert.rejects(
        () => cancelFactoryRun(undefined, {
          cwd: fixture.repo,
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
          ...linuxProcessOptions(fixture),
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
        ...linuxProcessOptions(fixture, {
          liveness: (pid) => pid === 4242 ? "absent" : "live",
          marker: (pid) => pid === 5252 ? "222" : "111",
        }),
      });

      assert.equal(evidence.pid, 5252);
      assert.equal(evidence.state, "running");
      assert.equal(evidence.identity.start_marker, "linux-procfs:222");
      const persisted = readJson(join(fixture.runDir, "process.json"));
      assert.equal(persisted.pid, 5252);
      assert.equal(persisted.identity.start_marker, "linux-procfs:222");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("refuses to record process evidence when the live identity cannot be verified", () => {
    const fixture = createFixture("record-refuse-unverified");
    try {
      assert.throws(
        () => recordDetachedProcessEvidence(fixture.runDir, {
          runId: fixture.runId,
          pid: 5252,
          cwd: fixture.repo,
          commandName: "opencode",
          logRef: "processes/opencode.log",
          platform: "unsupported-test-platform",
          livenessProbe: () => ({ status: "live" }),
        }),
        /requires verifiable live process identity/u,
      );
      assert.throws(
        () => recordDetachedProcessEvidence(fixture.runDir, {
          runId: fixture.runId,
          pid: 5252,
          cwd: fixture.repo,
          commandName: "opencode",
          logRef: "processes/opencode.log",
          ...linuxProcessOptions(fixture, { cwd: () => resolve(tmpdir()) }),
        }),
        /process cwd mismatch/u,
      );
      assert.equal(existsSync(join(fixture.runDir, "process.json")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("refuses to overwrite running evidence when liveness is uninspectable", () => {
    const fixture = createFixture("record-refuse-uninspectable");
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
          ...linuxProcessOptions(fixture, { liveness: () => "indeterminate" }),
        }),
        /stale\/exited state could not be proven/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "process.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("refuses to overwrite invalid process evidence", () => {
    const fixture = createFixture("record-refuse-invalid");
    try {
      writeJson(join(fixture.runDir, "process.json"), { invalid: true });
      const before = readFileSync(join(fixture.runDir, "process.json"), "utf8");

      assert.throws(
        () => recordDetachedProcessEvidence(fixture.runDir, {
          runId: fixture.runId,
          pid: 5252,
          cwd: fixture.repo,
          commandName: "opencode",
          logRef: "processes/opencode.log",
          ...linuxProcessOptions(fixture, { liveness: () => "live", marker: () => "222" }),
        }),
        /refusing to overwrite invalid process evidence/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "process.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("default liveness treats EPERM as unknown rather than proven stale", () => {
    const originalKill = process.kill;
    try {
      process.kill = (pid, signal) => {
        if (pid === 4242 && signal === 0) {
          const error = new Error("operation not permitted");
          error.code = "EPERM";
          throw error;
        }
        return originalKill(pid, signal);
      };

      const result = inspectProcessIdentity(4242);

      assert.equal(result.ok, false);
      assert.match(result.reason, /liveness unknown: EPERM/u);
      assert.doesNotMatch(result.reason, /stale pid/u);
    } finally {
      process.kill = originalKill;
    }
  });

  it("inspects Darwin process identity with targeted PID commands and a final start recheck", () => {
    const fixture = createFixture("darwin-inspect");
    const commands = [];
    try {
      const result = inspectProcessIdentity(4242, {
        platform: "darwin",
        livenessProbe: (pid) => ({ status: pid === 4242 ? "live" : "absent" }),
        commandRunner: (command, args) => {
          commands.push([command, ...args]);
          if (command === "ps" && args.join(" ") === "-p 4242 -o lstart=") return "Thu Jul  9 15:00:00 2026\n";
          if (command === "ps" && args.join(" ") === "-p 4242 -o comm=") return "/opt/homebrew/bin/opencode\n";
          if (command === "lsof" && args.join(" ") === "-a -p 4242 -d cwd -Fn") return `p4242\nfcwd\nn${fixture.repo}\n`;
          throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.inspector, "node-process");
      assert.equal(result.start_marker, "darwin-ps:Thu Jul 9 15:00:00 2026");
      assert.equal(result.command_name, "opencode");
      assert.equal(result.cwd, fixture.repo);
      assert.deepEqual(commands, [
        ["ps", "-p", "4242", "-o", "lstart="],
        ["ps", "-p", "4242", "-o", "comm="],
        ["lsof", "-a", "-p", "4242", "-d", "cwd", "-Fn"],
        // Recheck after metadata reads so PID reuse cannot produce a mixed identity.
        ["ps", "-p", "4242", "-o", "lstart="],
      ]);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("records and cancels only matching Darwin process identity", async () => {
    const fixture = createFixture("darwin-record-cancel");
    const signals = [];
    try {
      const evidence = recordDetachedProcessEvidence(fixture.runDir, {
        runId: fixture.runId,
        pid: 5252,
        cwd: fixture.repo,
        commandName: "opencode",
        logRef: "processes/opencode.log",
        ...darwinProcessOptions(5252, { cwd: fixture.repo }),
      });

      assert.equal(evidence.pid, 5252);
      assert.equal(evidence.identity.start_marker, "darwin-ps:Thu Jul 9 15:00:00 2026");
      assert.doesNotMatch(evidence.identity.start_marker, /^unverified:/u);

      const mismatch = await cancelFactoryRun(fixture.runId, {
        cwd: fixture.repo,
        ...darwinProcessOptions(5252, { cwd: resolve(tmpdir()) }),
        signalFn: (pid, signal) => signals.push({ pid, signal }),
      });

      assert.equal(mismatch.ok, false);
      assert.match(mismatch.reason, /cwd mismatch/u);
      assert.deepEqual(signals, []);

      const result = await cancelFactoryRun(fixture.runId, {
        cwd: fixture.repo,
        cancelWaitMs: 500,
        ...darwinProcessOptions(5252, { cwd: fixture.repo, liveness: () => signals.length > 0 ? "absent" : "live" }),
        signalFn: (pid, signal) => signals.push({ pid, signal }),
      });

      assert.equal(result.ok, true);
      assert.deepEqual(signals, [{ pid: 5252, signal: "SIGTERM" }]);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("fails closed for stale, mismatched, or non-run-scoped evidence without mutating run.json", async () => {
    const cases = [
      {
        name: "run-id-mismatch",
        evidence: { run_id: "other-run" },
        options: () => ({}),
        reason: /run_id must match requested run/u,
      },
      {
        name: "bad-log-ref",
        evidence: { log_ref: "../processes/out.log" },
        options: () => ({}),
        reason: /log_ref must stay under processes/u,
      },
      {
        name: "indeterminate-liveness",
        options: (fixture) => linuxProcessOptions(fixture, { liveness: () => "indeterminate" }),
        reason: /liveness could not be determined/u,
      },
      {
        name: "start-marker-mismatch",
        options: (fixture) => linuxProcessOptions(fixture, { marker: () => "222" }),
        reason: /start marker mismatch/u,
      },
      {
        name: "unverified-start-marker",
        evidence: { identity: { start_marker: `unverified:4242:${NOW}` } },
        options: () => ({}),
        reason: /identity\.start_marker must be verifiable process evidence/u,
      },
      {
        name: "unsupported-inspector",
        evidence: { identity: { inspector: "unsupported-inspector" } },
        options: (fixture) => linuxProcessOptions(fixture),
        reason: /unsupported inspector/u,
      },
      {
        name: "command-mismatch",
        options: (fixture) => linuxProcessOptions(fixture, { command: () => "node" }),
        reason: /command mismatch/u,
      },
      {
        name: "cwd-mismatch",
        options: (fixture) => linuxProcessOptions(fixture, { cwd: () => resolve(tmpdir()) }),
        reason: /cwd mismatch/u,
      },
    ];

    for (const item of cases) {
      const fixture = createFixture(`cancel-${item.name}`);
      const beforeRun = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      const signals = [];
      try {
        writeProcessEvidence(fixture, item.evidence || {});
        const result = await cancelFactoryRun(fixture.runId, {
          cwd: fixture.repo,
          ...item.options(fixture),
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
    inspector: "node-process",
    start_marker: "linux-procfs:111",
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

function linuxProcessOptions(fixture, {
  liveness = () => "live",
  marker = () => "111",
  command = () => "opencode",
  cwd = () => fixture.repo,
} = {}) {
  return {
    platform: "linux",
    hostname: "test-host",
    livenessProbe: (pid) => ({ status: liveness(pid) }),
    procReadFile: (path) => {
      const pid = Number(path.split("/")[2]);
      return path.endsWith("/stat")
        ? `${pid} (opencode) S ${Array(18).fill("0").join(" ")} ${marker(pid)}\n`
        : `${command(pid)}\n`;
    },
    procReadlink: (path) => cwd(Number(path.split("/")[2])),
  };
}

function darwinProcessOptions(expectedPid, {
  cwd,
  command = "/opt/homebrew/bin/opencode",
  start = "Thu Jul  9 15:00:00 2026",
  liveness = (pid) => pid === expectedPid ? "live" : "absent",
} = {}) {
  return {
    platform: "darwin",
    hostname: "test-host",
    livenessProbe: (pid) => ({ status: liveness(pid) }),
    commandRunner: (cmd, args) => {
      if (cmd === "ps" && args.join(" ") === `-p ${expectedPid} -o lstart=`) return `${start}\n`;
      if (cmd === "ps" && args.join(" ") === `-p ${expectedPid} -o comm=`) return `${command}\n`;
      if (cmd === "lsof" && args.join(" ") === `-a -p ${expectedPid} -d cwd -Fn`) return `p${expectedPid}\nfcwd\nn${cwd}\n`;
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    },
  };
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
