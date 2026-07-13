import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtureGit } from "./git-fixture.js";

export function createCleanupSweepFixture(name = "eligibility") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `feature-factory-${name}-`)));
  const repo = join(root, "repo");
  mkdirSync(repo);
  mustGit(repo, ["init", "-b", "main"]);
  mustGit(repo, ["config", "user.name", "Fixture"]);
  mustGit(repo, ["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  mustGit(repo, ["add", "README.md"]);
  mustGit(repo, ["commit", "-m", "fixture base"]);
  const baseSha = gitOutput(repo, ["rev-parse", "HEAD"]);
  const factoryRoot = join(repo, ".opencode", "factory");
  const worktreeRoot = join(repo, ".opencode", "worktrees");
  mkdirSync(factoryRoot, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });

  function addRun(runId, overrides = {}) {
    const runDir = join(factoryRoot, runId);
    mkdirSync(runDir, { recursive: true });
    const branch = overrides.branch ?? runId;
    if (branch !== null && validBranch(repo, branch) && !branchExists(repo, branch)) mustGit(repo, ["branch", branch, baseSha]);
    const url = "https://github.com/example/project/pull/7";
    const run = {
      run_id: runId,
      status: "completed",
      branch: overrides.branch === null ? undefined : (overrides.branch ?? runId),
      worktree: overrides.worktree ?? undefined,
      pr_url: url,
      terminal_result: {
        status: "completed",
        run_id: runId,
        pr_url: url,
        repository: "example/project",
        pr_number: 7,
        artifacts: {},
      },
      ...overrides,
    };
    if (run.branch === undefined) delete run.branch;
    if (run.worktree === undefined) delete run.worktree;
    writeJson(join(runDir, "run.json"), run);
    return { runDir, run };
  }

  function writeRun(runId, run) { writeJson(join(factoryRoot, runId, "run.json"), run); }
  function readRun(runId) { return JSON.parse(readFileSync(join(factoryRoot, runId, "run.json"), "utf8")); }
  function addRecordedWorktree(runId, branch = runId) {
    const worktree = join(worktreeRoot, runId);
    addRegisteredWorktree(runId, branch);
    const run = readRun(runId);
    run.branch = branch;
    run.worktree = worktree;
    writeRun(runId, run);
    return worktree;
  }
  function addRegisteredWorktree(name, branch = name, root = worktreeRoot) {
    const worktree = join(root, name);
    mustGit(repo, ["worktree", "add", worktree, branch]);
    return worktree;
  }
  function createBranch(branch, start = baseSha) {
    if (!branchExists(repo, branch)) mustGit(repo, ["branch", branch, start]);
    return branch;
  }

  function gitRunner(cwd, args) {
    if (args[0] === "fetch") {
      const destination = args.at(-1).split(":").at(-1);
      const proc = runFixtureGit(cwd, ["update-ref", destination, baseSha]);
      return commandResult(proc);
    }
    return commandResult(runFixtureGit(cwd, args));
  }

  function githubRunner(_cwd, _args) {
    return {
      ok: true,
      status: 0,
      stdout: JSON.stringify({
        html_url: "https://github.com/example/project/pull/7",
        number: 7,
        state: "closed",
        merged: true,
        base: { ref: "main", sha: baseSha, repo: { full_name: "example/project" } },
      }),
      stderr: "",
      command: null,
    };
  }

  return {
    root, repo, factoryRoot, worktreeRoot, baseSha,
    addRun, writeRun, readRun, addRecordedWorktree, addRegisteredWorktree, createBranch, gitRunner, githubRunner,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function snapshotTree(root) {
  const visit = (path) => readdirSync(path).sort().map((name) => {
    const child = join(path, name);
    const stat = statSync(child);
    return stat.isDirectory() ? [name, visit(child)] : [name, readFileSync(child).toString("base64")];
  });
  return visit(root);
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function mustGit(cwd, args) {
  const proc = runFixtureGit(cwd, args);
  if (proc.status !== 0) throw new Error(proc.stderr || proc.stdout || `git ${args.join(" ")} failed`);
  return proc;
}
function gitOutput(cwd, args) { return mustGit(cwd, args).stdout.trim(); }
function branchExists(cwd, branch) { return runFixtureGit(cwd, ["show-ref", "--verify", `refs/heads/${branch}`]).status === 0; }
function validBranch(cwd, branch) { return runFixtureGit(cwd, ["check-ref-format", "--branch", branch]).status === 0; }
function commandResult(proc) {
  return { ok: proc.status === 0, status: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", command: null, signal: proc.signal ?? null };
}
