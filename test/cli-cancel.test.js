import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "./helpers/git-fixture.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cancelProcessFromEvidence, writeProcessEvidence } from "../src/process-evidence.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

describe("cli factory cancel", () => {
  for (const item of [
    { name: "exit before signal", initial: "absent", after: "absent", status: "cancelled", signals: 0 },
    { name: "verified process exits after one signal", initial: "live", after: "absent", status: "cancelled", signals: 1 },
    { name: "verified process remains after one signal", initial: "live", after: "live", status: "cancel-pending", signals: 1 },
  ]) {
    it(`handles cancellation race: ${item.name}`, async () => {
      const fixture = createFixture(`cancel-${item.name.replaceAll(" ", "-")}`);
      const claimPath = seedClaimSentinel(fixture);
      seedRunningProcess(fixture);
      const runBefore = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      const claimBefore = readFileSync(claimPath, "utf8");
      let signaled = false;
      const signals = [];
      try {
        const result = await cancelProcessFromEvidence(fixture.runDir, {
          runId: fixture.runId,
          cancelWaitMs: 0,
          inspectorFn: (pid) => {
            const state = signaled ? item.after : item.initial;
            return state === "absent"
              ? { ok: false, inspector: "test-inspector", code: "ESRCH", reason: "ESRCH" }
              : { ok: true, inspector: "test-inspector", pid, start_marker: "test-start", command_name: "opencode", cwd: fixture.repo };
          },
          signalFn: (pid, signal) => { signals.push({ pid, signal }); signaled = true; },
        });
        assert.equal(result.status, item.status);
        assert.equal(result.signaled, item.signals === 1);
        assert.equal(signals.length, item.signals);
        if (item.signals) assert.deepEqual(signals[0], { pid: 7654, signal: "SIGTERM" });
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), runBefore);
        assert.equal(readFileSync(claimPath, "utf8"), claimBefore);
      } finally {
        cleanup(fixture.repo);
      }
    });
  }

  it("keeps cancellation idempotent and failed-closed for stopped evidence without signals", async () => {
    for (const state of ["cancelled", "exited", "failed-closed"]) {
      const fixture = createFixture(`cancel-state-${state}`);
      const claimPath = seedClaimSentinel(fixture);
      seedRunningProcess(fixture, state);
      const processBefore = readFileSync(join(fixture.runDir, "process.json"), "utf8");
      const claimBefore = readFileSync(claimPath, "utf8");
      const signals = [];
      try {
        const result = await cancelProcessFromEvidence(fixture.runDir, { runId: fixture.runId, signalFn: (...args) => signals.push(args) });
        assert.equal(result.status, state === "cancelled" ? "cancelled" : "failed-closed");
        assert.equal(result.signaled, false);
        assert.deepEqual(signals, []);
        assert.equal(readFileSync(join(fixture.runDir, "process.json"), "utf8"), processBefore);
        assert.equal(readFileSync(claimPath, "utf8"), claimBefore);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("truthfully fails before publication then targets published evidence on retry", async () => {
    const fixture = createFixture("cancel-publication-race");
    const claimPath = seedClaimSentinel(fixture);
    const claimBefore = readFileSync(claimPath, "utf8");
    try {
      const first = await cancelProcessFromEvidence(fixture.runDir, { runId: fixture.runId });
      assert.equal(first.status, "failed-closed");
      assert.equal(first.updated, false);
      seedRunningProcess(fixture);
      let signaled = false;
      const signals = [];
      const second = await cancelProcessFromEvidence(fixture.runDir, {
        runId: fixture.runId,
        cancelWaitMs: 0,
        inspectorFn: (pid) => signaled ? { ok: false, code: "ESRCH", reason: "ESRCH" } : { ok: true, inspector: "test-inspector", pid, start_marker: "test-start", command_name: "opencode", cwd: fixture.repo },
        signalFn: (pid, signal) => { signals.push({ pid, signal }); signaled = true; },
      });
      assert.equal(second.status, "cancelled");
      assert.deepEqual(signals, [{ pid: 7654, signal: "SIGTERM" }]);
      assert.equal(readFileSync(claimPath, "utf8"), claimBefore);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("cancellation remains evidence-bound while the matching claim is removed", async () => {
    const fixture = createFixture("cancel-claim-cleanup-race");
    const claimPath = seedClaimSentinel(fixture);
    seedRunningProcess(fixture);
    let signaled = false;
    const signals = [];
    try {
      const result = await cancelProcessFromEvidence(fixture.runDir, {
        runId: fixture.runId,
        cancelWaitMs: 0,
        inspectorFn: (pid) => signaled ? { ok: false, code: "ESRCH", reason: "ESRCH" } : { ok: true, inspector: "test-inspector", pid, start_marker: "test-start", command_name: "opencode", cwd: fixture.repo },
        signalFn: (pid, signal) => {
          signals.push({ pid, signal });
          rmSync(join(fixture.runDir, "process-launch.lock"), { recursive: true, force: true });
          signaled = true;
        },
      });
      assert.equal(result.status, "cancelled");
      assert.deepEqual(signals, [{ pid: 7654, signal: "SIGTERM" }]);
      assert.equal(readFileSync(join(fixture.runDir, "process.json"), "utf8").includes('"state": "cancelled"'), true);
      assert.throws(() => readFileSync(claimPath, "utf8"), /ENOENT/u);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("routes cancel to process-evidence cancellation and exits non-zero for ok:false", () => {
    const fixture = createFixture("cli-cancel-missing-evidence");
    try {
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      const claimDir = join(fixture.runDir, "process-launch.lock");
      mkdirSync(claimDir);
      const claimPath = join(claimDir, "owner.json");
      writeFileSync(claimPath, "preserve claim bytes exactly\n", "utf8");
      const claimBefore = readFileSync(claimPath, "utf8");

      const proc = runCli(fixture.repo, ["factory", "cancel", fixture.runId, "--json"]);

      assert.notEqual(proc.status, 0);
      assert.equal(proc.stderr, "");
      const output = JSON.parse(proc.stdout);
      assert.equal(output.ok, false);
      assert.equal(output.status, "failed-closed");
      assert.match(output.reason, /missing process evidence/u);
      assert.equal(output.signaled, false);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
      assert.equal(readFileSync(claimPath, "utf8"), claimBefore);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("requires exactly one explicit run id", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-cli-cancel-"));
    try {
      const proc = runCli(repo, ["factory", "cancel", "--json"]);

      assert.notEqual(proc.status, 0);
      assert.equal(proc.stdout, "");
      assert.match(proc.stderr, /factory cancel requires exactly one <run-id>/u);
    } finally {
      cleanup(repo);
    }
  });
});

function createFixture(runId) {
  const repo = mkdtempSync(join(tmpdir(), "factory-cli-cancel-"));
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, "run.json"), { schema_version: 1, run_id: runId, status: "running", gates: {} });
  return { repo, runDir, runId };
}

function runCli(repo, args) {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: "utf8",
    timeout: 15000,
  });
  if (proc.error) throw proc.error;
  return proc;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function seedClaimSentinel(fixture) {
  const dir = join(fixture.runDir, "process-launch.lock");
  mkdirSync(dir);
  const path = join(dir, "owner.json");
  writeFileSync(path, "claim bytes remain authoritative\n", "utf8");
  return path;
}

function seedRunningProcess(fixture, state = "running") {
  mkdirSync(join(fixture.runDir, "processes"), { recursive: true });
  writeFileSync(join(fixture.runDir, "processes", "cancel.log"), "log\n", "utf8");
  const now = new Date().toISOString();
  writeProcessEvidence(fixture.runDir, {
    schema_version: 1, kind: "opencode-process", run_id: fixture.runId, execution_id: "cancel-execution", pid: 7654,
    started_at: now, updated_at: now, state, cwd: fixture.repo,
    identity: { inspector: "test-inspector", start_marker: "test-start", command_name: "opencode" },
    log_ref: "processes/cancel.log",
    cancel: state === "cancelled" ? { requested_at: now, signal: "SIGTERM", confirmed_at: now, result: "cancelled", reason: null } : null,
  });
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
