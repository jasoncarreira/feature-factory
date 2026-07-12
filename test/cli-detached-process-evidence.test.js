import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "./helpers/git-fixture.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

describe("cli detached process evidence", () => {
  it("does not write run-scoped process evidence for generic detached starts without an explicit run id", () => {
    const repo = tempRepo("generic-detached-start");
    const opencodeBin = installFakeOpencode(repo);
    try {
      const proc = runCli(repo, ["factory", "start", "--detached", "--json", "test generic detached prompt"], opencodeBin);

      assert.equal(proc.status, 0, proc.stderr);
      const output = JSON.parse(proc.stdout);
      assert.equal(output.status, "started", proc.stdout);
      assert.equal(existsSync(join(repo, ".opencode", "factory", "process.json")), false);
      assert.equal(existsSync(join(repo, ".opencode", "factory", "processes")), true);
      stopProcess(output.pid, join(repo, "fake-opencode-ready"), join(repo, "fake-opencode-exited"));
    } finally {
      cleanup(repo);
    }
  });

  it("does not write run-scoped process evidence for generic detached starts with a user-supplied run id", () => {
    const repo = tempRepo("generic-detached-start-explicit-run-id");
    const opencodeBin = installFakeOpencode(repo);
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
      const proc = runCli(repo, ["factory", "start", "--detached", "--run-id", victimRunId, "--json", "unrelated prompt"], opencodeBin);

      // A generic start targeting an existing run id is rejected before launch by
      // assertStartRunIdAvailable. That is a stronger guarantee than starting without
      // evidence: no process spawns and the victim run dir is never touched.
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /already exists/i);
      assert.equal(existsSync(join(victimRunDir, "process.json")), false);
      assert.equal(existsSync(join(victimRunDir, "processes")), false);
    } finally {
      cleanup(repo);
    }
  });

  it("writes run-scoped process evidence for detached resume with an explicit run id", () => {
    const repo = tempRepo("detached-resume");
    const opencodeBin = installFakeOpencode(repo);
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
      slices: [{ id: "slice", status: "running", attempts: 1, branch: runId, worktree }],
    });

    try {
      const proc = runCli(repo, ["factory", "resume", runId, "--detached", "--json"], opencodeBin);

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
      stopProcess(output.pid, join(repo, "fake-opencode-ready"), join(repo, "fake-opencode-exited"));
    } finally {
      cleanup(repo);
    }
  });
});

function tempRepo(name) {
  return mkdtempSync(join(tmpdir(), `factory-detached-${name}-`));
}

function installFakeOpencode(repo) {
  const binDir = join(repo, "bin");
  const script = join(binDir, "opencode");
  mkdirSync(binDir, { recursive: true });
  const exitMarker = join(repo, "fake-opencode-exited");
  const readyMarker = join(repo, "fake-opencode-ready");
  writeFileSync(script, `#!${process.execPath}
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(exitMarker)}, "exited\\n");
  process.exit(0);
});
writeFileSync(${JSON.stringify(readyMarker)}, "ready\\n");
setInterval(() => {}, 30000);
`, "utf8");
  chmodSync(script, 0o755);
  return binDir;
}

function runCli(repo, args, opencodeBin) {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${opencodeBin}:${process.env.PATH || ""}` },
    timeout: 15000,
  });
  if (proc.error) throw proc.error;
  return proc;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stopProcess(pid, readyMarker, exitMarker) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  waitForMarker(readyMarker);
  const parent = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
  assert.equal(parent.status, 0, parent.stderr);
  const supervisorPid = Number(parent.stdout.trim());
  process.kill(pid, "SIGTERM");
  const waiter = `
    import { existsSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    const pids = ${JSON.stringify([pid, supervisorPid])}.filter((pid) => Number.isInteger(pid) && pid > 1);
    const marker = ${JSON.stringify(exitMarker)};
    const deadline = Date.now() + 5000;
    const active = (pid) => {
      try {
        const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
        return state.length > 0 && !state.startsWith("Z");
      } catch { return false; }
    };
    const observe = () => {
      if (existsSync(marker) && pids.every((pid) => !active(pid))) process.exit(0);
      if (Date.now() >= deadline) {
        console.error(JSON.stringify({ marker: existsSync(marker), pids, states: pids.map((pid) => {
          try { return execFileSync("ps", ["-o", "pid=,ppid=,stat=,command=", "-p", String(pid)], { encoding: "utf8" }).trim(); }
          catch { return "absent"; }
        }) }));
        process.exit(2);
      }
      setImmediate(observe);
    };
    observe();
  `;
  const waited = spawnSync(process.execPath, ["--input-type=module", "--eval", waiter], { encoding: "utf8", timeout: 10000 });
  assert.equal(waited.status, 0, `detached child/supervisor did not exit: ${waited.stderr}`);
}

function waitForMarker(marker) {
  const waiter = `
    import { existsSync, watch } from "node:fs";
    const marker = ${JSON.stringify(marker)};
    if (existsSync(marker)) process.exit(0);
    const watcher = watch(${JSON.stringify(join(marker, ".."))}, () => {
      if (existsSync(marker)) { watcher.close(); process.exit(0); }
    });
    setTimeout(() => { watcher.close(); process.exit(2); }, 5000).unref();
  `;
  const waited = spawnSync(process.execPath, ["--input-type=module", "--eval", waiter], { encoding: "utf8", timeout: 10000 });
  assert.equal(waited.status, 0, `detached child did not publish readiness: ${waited.stderr}`);
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}
