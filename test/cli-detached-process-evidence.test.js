import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
      assert.equal(output.status, "started");
      assert.equal(existsSync(join(repo, ".opencode", "factory", "process.json")), false);
      assert.equal(existsSync(join(repo, ".opencode", "factory", "processes")), true);
      stopProcess(output.pid);
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
      assert.equal(output.status, "started");
      const processEvidencePath = join(runDir, "process.json");
      assert.equal(existsSync(processEvidencePath), true);
      const processEvidence = JSON.parse(readFileSync(processEvidencePath, "utf8"));
      assert.equal(processEvidence.run_id, runId);
      assert.equal(processEvidence.kind, "opencode-process");
      assert.equal(processEvidence.state, "running");
      assert.match(processEvidence.log_ref, /^processes\/.+\.log$/u);
      stopProcess(output.pid);
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
  writeFileSync(script, "#!/usr/bin/env node\nsetTimeout(() => {}, 30000);\n", "utf8");
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

function stopProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Best-effort cleanup for detached test processes.
  }
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}
