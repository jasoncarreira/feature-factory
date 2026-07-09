import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

describe("cli resume-check and resume preflight", () => {
  it("prints synthetic non-durable JSON and does not scaffold missing run state", () => {
    const repo = tempRepo("resume-check-missing");
    try {
      const proc = runCli(repo, ["factory", "resume-check", "missing-run", "--json"]);

      assert.notEqual(proc.status, 0);
      const output = JSON.parse(proc.stdout);
      assert.equal(output.ok, false);
      assert.equal(output.durable, false);
      assert.equal(output.updated, false);
      assert.equal(output.recovered, false);
      assert.equal(output.status, "blocked");
      assert.match(output.terminal_result.reason, /No durable terminal_result can be written without forbidden re-scaffolding/i);
      assert.equal(existsSync(join(repo, ".opencode", "factory", "missing-run", "run.json")), false);
    } finally {
      cleanup(repo);
    }
  });

  it("preflights headless factory start resume before seeding skills or spawning opencode", () => {
    const repo = tempRepo("start-resume-preflight");
    try {
      const proc = runCli(repo, ["factory", "start", "--headless", "--json", "resume missing-run"]);

      assert.notEqual(proc.status, 0);
      assert.equal(proc.stderr, "");
      const output = JSON.parse(proc.stdout);
      assert.equal(output.ok, false);
      assert.match(output.terminal_result.reason, /missing run\.json/i);
      assert.equal(existsSync(join(repo, ".opencode", "skills", "feature", "SKILL.md")), false);
    } finally {
      cleanup(repo);
    }
  });

  it("recovers a disrupted run through resume-check", () => {
    const fixture = createCliRecoveryFixture("cli-recoverable-run");
    try {
      const proc = runCli(fixture.repo, ["factory", "resume-check", fixture.runId, "--json"]);

      assert.equal(proc.status, 0, proc.stderr);
      const output = JSON.parse(proc.stdout);
      assert.equal(output.ok, true);
      assert.equal(output.recovered, true);
      assert.equal(output.worktree, fixture.worktree);
      assert.equal(gitStdout(fixture.worktree, ["branch", "--show-current"]), fixture.runId);
    } finally {
      cleanup(fixture.repo);
    }
  });
});

function createCliRecoveryFixture(runId) {
  const repo = tempRepo(runId);
  initGitRepo(repo);
  const baseCommit = gitStdout(repo, ["rev-parse", "HEAD"]);
  runGit(repo, ["branch", runId]);
  const runDir = join(repo, ".opencode", "factory", runId);
  const worktree = join(repo, ".opencode", "worktrees", runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    status: "running",
    base_ref: "main",
    base_commit: baseCommit,
    branch: runId,
    worktree,
    gates: {},
    terminal_result: null,
  });
  return { repo, runDir, runId, worktree };
}

function tempRepo(name) {
  return mkdtempSync(join(tmpdir(), `factory-cli-${name}-`));
}

function initGitRepo(repo) {
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "test\n", "utf8");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "init"]);
}

function runCli(repo, args) {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: gitEnv(),
    timeout: 15000,
  });
  if (proc.error) throw proc.error;
  return proc;
}

function runGit(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv() });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function gitStdout(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv() });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

function gitEnv() {
  return { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}
