import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "./helpers/git-fixture.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("cli detached process evidence", () => {
  it("allocates a run id and writes cancellable process evidence for generic detached starts", async () => {
    const repo = tempRepo("generic-detached-start");
    try {
      const proc = runDeterministicCli(repo, ["factory", "start", "--detached", "--json", "test generic detached prompt"]);

      assert.equal(proc.status, 0, proc.stderr);
      const output = JSON.parse(proc.stdout);
      assert.equal(output.status, "started", proc.stdout);
      assert.match(output.run_id, /^run-[a-z0-9-]+$/u);
      assert.equal(output.command, undefined);
      assert.equal(proc.stdout.includes("test generic detached prompt"), false);
      assert.equal(proc.stdout.includes("ffpayload-v1:"), false);
      const runDir = join(repo, ".opencode", "factory", output.run_id);
      const processEvidence = JSON.parse(readFileSync(join(runDir, "process.json"), "utf8"));
      assert.equal(processEvidence.run_id, output.run_id);
      assert.equal(processEvidence.state, "running");
      assert.equal(existsSync(join(runDir, "processes")), true);
      assert.deepEqual(readLifecycle(repo), ["supervisor-created", "init", "evidence-published", "spawned", "ready", "unref", "disconnect"]);
    } finally {
      cleanup(repo);
    }
  });

  it("does not write run-scoped process evidence for generic detached starts with a user-supplied run id", () => {
    const repo = tempRepo("generic-detached-start-explicit-run-id");
    const victimRunId = "victim-run";
    const victimRunDir = join(repo, ".opencode", "factory", victimRunId);
    mkdirSync(victimRunDir, { recursive: true });
    writeJson(join(victimRunDir, "run.json"), {
      schema_version: 1,
      run_id: victimRunId,
      status: "running",
      gates: {},
    });
    try {
      const proc = runDeterministicCli(repo, ["factory", "start", "--detached", "--run-id", victimRunId, "--json", "unrelated prompt"]);

      // A generic start targeting an existing run id is rejected before launch by
      // assertStartRunIdAvailable. That is a stronger guarantee than starting without
      // evidence: no process spawns and the victim run dir is never touched.
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /already exists/i);
      assert.equal(existsSync(join(victimRunDir, "process.json")), false);
      assert.equal(existsSync(join(victimRunDir, "processes")), false);
      assert.equal(existsSync(join(repo, "detached-lifecycle.json")), false);
    } finally {
      cleanup(repo);
    }
  });

  it("writes run-scoped process evidence for detached resume with an explicit run id", async () => {
    const repo = tempRepo("detached-resume");
    const runId = "resume-detached-run";
    const runDir = join(repo, ".opencode", "factory", runId);
    const worktree = join(repo, ".opencode", "worktrees", runId);
    mkdirSync(worktree, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "run.json"), {
      schema_version: 1,
      run_id: runId,
      status: "running",
      branch: runId,
      worktree,
      gates: {},
      slices: [{ id: "slice", declared_paths: ["slice.txt"], effective_paths: ["slice.txt"], status: "running", attempts: 1, branch: runId, worktree }],
    });

    try {
      const proc = runDeterministicCli(repo, ["factory", "resume", runId, "--detached", "--json"]);

      assert.equal(proc.status, 0, proc.stderr);
      const output = JSON.parse(proc.stdout);
      assert.equal(output.status, "started", proc.stdout);
      const processEvidencePath = join(runDir, "process.json");
      assert.equal(existsSync(processEvidencePath), true);
      const processEvidence = JSON.parse(readFileSync(processEvidencePath, "utf8"));
      assert.equal(processEvidence.run_id, runId);
      assert.equal(processEvidence.kind, "opencode-process");
      assert.equal(processEvidence.state, "running");
      assert.doesNotMatch(processEvidence.identity.start_marker, /^unverified:/u);
      assert.match(processEvidence.log_ref, /^processes\/.+\.log$/u);
      assert.deepEqual(readLifecycle(repo), ["supervisor-created", "init", "evidence-published", "spawned", "ready", "unref", "disconnect"]);
    } finally {
      cleanup(repo);
    }
  });

  it("rejects a symlinked factory root before creating detached run state", () => {
    const repo = tempRepo("symlinked-factory-root");
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "factory-detached-outside-")));
    try {
      symlinkSync(outside, join(repo, ".opencode"));
      const proc = runDeterministicCli(repo, ["factory", "start", "--detached", "--json", "must not escape"]);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /\.opencode.*(?:real directory|must not contain symlinks)/u);
      assert.equal(existsSync(join(outside, "factory")), false);
      assert.equal(existsSync(join(repo, "detached-lifecycle.json")), false);
    } finally {
      cleanup(repo);
      cleanup(outside);
    }
  });
});

function tempRepo(name) {
  return realpathSync(mkdtempSync(join(tmpdir(), `factory-detached-${name}-`)));
}

function runDeterministicCli(repo, args) {
  const cliUrl = new URL("../src/cli.js", import.meta.url).href;
  const evidenceUrl = new URL("../src/process-evidence.js", import.meta.url).href;
  const lifecyclePath = join(repo, "detached-lifecycle.json");
  const source = `
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { runCliCommand } from ${JSON.stringify(cliUrl)};
    import { recordDetachedProcessEvidence } from ${JSON.stringify(evidenceUrl)};
    const repo = ${JSON.stringify(repo)};
    const lifecyclePath = ${JSON.stringify(lifecyclePath)};
    const events = [];
    const persist = () => writeFileSync(lifecyclePath, JSON.stringify(events));
    class DeterministicSupervisor extends EventEmitter {
      constructor() { super(); this.pid = process.pid; events.push("supervisor-created"); persist(); }
      send(init) {
        events.push("init"); persist();
        queueMicrotask(() => {
          if (init.recordEvidence) {
            mkdirSync(init.runDir + "/processes", { recursive: true });
            writeFileSync(init.log, "");
            recordDetachedProcessEvidence(init.runDir, { runId: init.runId, executionId: init.executionId, pid: process.pid, cwd: repo, logRef: init.logRef });
            events.push("evidence-published"); persist();
          }
          events.push("spawned"); persist();
          this.emit("message", { type: "spawned", pid: process.pid });
          events.push("ready"); persist();
          this.emit("message", { type: "ready", pid: process.pid });
        });
      }
      unref() { events.push("unref"); persist(); }
      disconnect() { events.push("disconnect"); persist(); }
    }
    await runCliCommand(${JSON.stringify(args)}, { factoryOptions: { supervisorSpawnFn: () => new DeterministicSupervisor() } });
    process.exit(process.exitCode || 0);
  `;
  const proc = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env },
  });
  if (proc.error) throw proc.error;
  return proc;
}

function readLifecycle(repo) {
  return JSON.parse(readFileSync(join(repo, "detached-lifecycle.json"), "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
