import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtureGit } from "../git-fixture.js";

const NOW = "2026-07-23T12:00:00.000Z";

export function createBaseAdvanceTransitionFixture(name) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `base-advance-transition-${name}-`)));
  const remote = join(root, "origin.git");
  const publisher = join(root, "publisher");
  const repo = join(root, "repo");
  const runId = `run-${name}`;
  const worktree = join(repo, ".opencode", "worktrees", runId);
  const runDir = join(repo, ".opencode", "factory", runId);
  git(root, ["init", "--bare", "--initial-branch=main", remote]);
  git(root, ["clone", remote, publisher]);
  writeFileSync(join(publisher, "state.txt"), "base\n");
  git(publisher, ["add", "state.txt"]);
  commit(publisher, "base");
  git(publisher, ["push", "origin", "main"]);
  git(root, ["clone", remote, repo]);
  const canonicalUrl = `https://github.com/example/${runId}.git`;
  git(repo, ["remote", "set-url", "origin", canonicalUrl]);
  git(repo, ["config", `url.file://${remote}.insteadOf`, canonicalUrl]);
  git(repo, ["config", "protocol.file.allow", "always"]);
  const base = output(repo, ["rev-parse", "HEAD"]);
  mkdirSync(join(repo, ".opencode", "worktrees"), { recursive: true });
  git(repo, ["worktree", "add", "-b", runId, worktree, base]);
  mkdirSync(runDir, { recursive: true });
  const run = {
    schema_version: 1,
    run_id: runId,
    mode: "headless",
    status: "running",
    created_at: NOW,
    updated_at: NOW,
    heartbeat_at: null,
    base_ref: "main",
    base_commit: base,
    branch: runId,
    worktree,
    github_account: "octocat",
    pr_mode: "ready",
    pr_url: null,
    max_parallel_slices: 1,
    max_retries: 3,
    review_tier: "standard",
    gates: {},
    slices: [],
    steps: [],
    terminal_result: null,
  };
  writeJson(join(runDir, "run.json"), run);

  return {
    root,
    remote,
    publisher,
    repo,
    runId,
    runDir,
    worktree,
    base,
    run,
    advance(contents = `advance-${name}\n`) {
      writeFileSync(join(publisher, "state.txt"), contents);
      git(publisher, ["add", "state.txt"]);
      commit(publisher, `advance ${name}`);
      git(publisher, ["push", "origin", "main"]);
      return output(publisher, ["rev-parse", "HEAD"]);
    },
    readRun() {
      return JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    },
    writeRun(value) {
      writeJson(join(runDir, "run.json"), value);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function git(cwd, args) {
  const result = runFixtureGit(cwd, args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

export function output(cwd, args) {
  return git(cwd, args).stdout.trim();
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function commit(cwd, message) {
  git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message]);
}
