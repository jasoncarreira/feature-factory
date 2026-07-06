import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { SAFE_GIT_POLICY, SAFE_GIT_PREFIX_ARGS } from "../src/safe-git.js";
import { buildReviewGuardBlockReport, checkReviewedWorktreeClean } from "../src/review-guard.js";

describe("checkReviewedWorktreeClean", () => {
  it("returns ok for a clean git worktree", () => {
    const repo = createCommittedRepo();
    const { headCommit, headTree } = getHeadObservation(repo);

    try {
      const result = checkReviewedWorktreeClean(repo);

      assert.equal(result.ok, true);
      assert.equal(result.status, "clean");
      assert.equal(result.worktree, repo);
      assert.equal(result.exit_code, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.equal(result.safe_git_policy, SAFE_GIT_POLICY);
      assert.equal(result.head_commit, headCommit);
      assert.equal(result.head_tree, headTree);
      assert.deepEqual(result.dirty_paths, []);
      assert.deepEqual(result.hidden_index_paths, []);
      assert.equal(result.command, `git -C ${repo} status --porcelain=v1 --untracked-files=all`);
    } finally {
      cleanup(repo);
    }
  });

  it("blocks tracked dirty modifications and reports path metadata", () => {
    const repo = createCommittedRepo();

    try {
      writeFileSync(join(repo, "tracked.txt"), "changed\n", "utf8");

      const result = checkReviewedWorktreeClean(repo);

      assert.equal(result.ok, false);
      assert.equal(result.status, "dirty");
      assert.equal(result.exit_code, 0);
      assert.equal(result.safe_git_policy, SAFE_GIT_POLICY);
      assert.equal(result.dirty_paths.length, 1);
      assert.deepEqual(result.hidden_index_paths, []);
      assert.equal(result.stdout, " M tracked.txt\n");

      const dirtyPath = result.dirty_paths[0];
      assert.equal(dirtyPath.path, "tracked.txt");
      assert.equal(dirtyPath.original_path, null);
      assert.equal(dirtyPath.raw, " M tracked.txt");
      assert.equal(dirtyPath.xy, " M");
      assert.equal(dirtyPath.index_status, " ");
      assert.equal(dirtyPath.worktree_status, "M");
      assert.equal(dirtyPath.staged, false);
      assert.equal(dirtyPath.unstaged, true);
      assert.equal(dirtyPath.deleted, false);
      assert.equal(dirtyPath.conflicted, false);
      assert.equal(dirtyPath.untracked, false);
    } finally {
      cleanup(repo);
    }
  });

  it("blocks untracked files and reports untracked metadata", () => {
    const repo = createCommittedRepo();

    try {
      writeFileSync(join(repo, "new-file.txt"), "new\n", "utf8");

      const result = checkReviewedWorktreeClean(repo);

      assert.equal(result.ok, false);
      assert.equal(result.status, "dirty");
      assert.equal(result.exit_code, 0);
      assert.equal(result.safe_git_policy, SAFE_GIT_POLICY);
      assert.equal(result.dirty_paths.length, 1);
      assert.deepEqual(result.hidden_index_paths, []);
      assert.equal(result.stdout, "?? new-file.txt\n");

      const dirtyPath = result.dirty_paths[0];
      assert.equal(dirtyPath.path, "new-file.txt");
      assert.equal(dirtyPath.original_path, null);
      assert.equal(dirtyPath.raw, "?? new-file.txt");
      assert.equal(dirtyPath.xy, "??");
      assert.equal(dirtyPath.index_status, "?");
      assert.equal(dirtyPath.worktree_status, "?");
      assert.equal(dirtyPath.staged, false);
      assert.equal(dirtyPath.unstaged, false);
      assert.equal(dirtyPath.deleted, false);
      assert.equal(dirtyPath.conflicted, false);
      assert.equal(dirtyPath.untracked, true);
    } finally {
      cleanup(repo);
    }
  });

  it("blocks non-git worktrees as unverifiable", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-guard-nongit-"));

    try {
      const result = checkReviewedWorktreeClean(dir);

      assert.equal(result.ok, false);
      assert.equal(result.status, "unverifiable");
      assert.equal(result.worktree, dir);
      assert.notEqual(result.exit_code, 0);
      assert.equal(result.safe_git_policy, SAFE_GIT_POLICY);
      assert.equal(result.head_commit, null);
      assert.equal(result.head_tree, null);
      assert.deepEqual(result.dirty_paths, []);
      assert.deepEqual(result.hidden_index_paths, []);
      assert.equal(result.stdout, "");
      assert.equal(typeof result.stderr, "string");
      assert.notEqual(result.stderr.length, 0);
    } finally {
      cleanup(dir);
    }
  });

  it("blocks hidden index flags even when git status is otherwise clean", () => {
    const repo = createCommittedRepo(["visible.txt", "assume.txt", "skip.txt"]);

    try {
      git(repo, ["update-index", "--assume-unchanged", "assume.txt"]);
      git(repo, ["update-index", "--skip-worktree", "skip.txt"]);

      const result = checkReviewedWorktreeClean(repo);

      assert.equal(result.ok, false);
      assert.equal(result.status, "dirty");
      assert.equal(result.exit_code, 0);
      assert.equal(result.stdout, "");
      assert.deepEqual(result.dirty_paths, []);
      assert.equal(result.safe_git_policy, SAFE_GIT_POLICY);
      assert.equal(typeof result.head_commit, "string");
      assert.equal(typeof result.head_tree, "string");
      assert.deepEqual(result.hidden_index_paths, [
        {
          path: "assume.txt",
          tag: "h",
          assume_unchanged: true,
          skip_worktree: false,
        },
        {
          path: "skip.txt",
          tag: "S",
          assume_unchanged: false,
          skip_worktree: true,
        },
      ]);
    } finally {
      cleanup(repo);
    }
  });

  it("uses safe-git policy-bound commands for status, head, and hidden-index observations", () => {
    const repo = createCommittedRepo();
    const { headCommit, headTree } = getHeadObservation(repo);
    const calls = [];

    try {
      const result = checkReviewedWorktreeClean(repo, {
        spawnSync(file, args, options) {
          calls.push({ file, args, options });

          if (args[args.length - 1] === "--untracked-files=all") {
            return { status: 0, stdout: "", stderr: "" };
          }
          if (args.includes("HEAD^{tree}")) {
            return { status: 0, stdout: `${headCommit}\n${headTree}\n`, stderr: "" };
          }
          if (args[args.length - 2] === "ls-files" && args[args.length - 1] === "-v") {
            return { status: 0, stdout: "", stderr: "" };
          }

          throw new Error(`unexpected git args: ${args.join(" ")}`);
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.safe_git_policy, SAFE_GIT_POLICY);
      assert.equal(result.command, `git -C ${repo} status --porcelain=v1 --untracked-files=all`);
      assert.deepEqual(calls.map((call) => call.args), [
        [...SAFE_GIT_PREFIX_ARGS, "status", "--porcelain=v1", "--untracked-files=all"],
        [...SAFE_GIT_PREFIX_ARGS, "rev-parse", "HEAD", "HEAD^{tree}"],
        [...SAFE_GIT_PREFIX_ARGS, "ls-files", "-v"],
      ]);
      for (const call of calls) {
        assert.equal(call.options.shell, false);
        assert.equal(call.options.cwd, repo);
      }
    } finally {
      cleanup(repo);
    }
  });
});

describe("buildReviewGuardBlockReport", () => {
  it("marks reviewer output invalid and preserves stable guard context", () => {
    const repo = createCommittedRepo();

    try {
      writeFileSync(join(repo, "tracked.txt"), "changed\n", "utf8");
      const guard = checkReviewedWorktreeClean(repo);

      const report = buildReviewGuardBlockReport({
        reviewer: "work-reviewer",
        subject: "be-review-guard-tests",
        reviewed_worktree: repo,
        guard,
      });

      assert.equal(report.status, "blocked");
      assert.equal(report.reason, "reviewer left reviewed worktree dirty (1 git-visible path)");
      assert.equal(report.reviewer, "work-reviewer");
      assert.equal(report.subject, "be-review-guard-tests");
      assert.equal(report.attempt, 1);
      assert.equal(report.reviewed_worktree, repo);
      assert.equal(report.review_output_valid, false);
      assert.deepEqual(report.dirty_paths, guard.dirty_paths);
      assert.equal(report.guard.ok, false);
      assert.equal(report.guard.status, "dirty");
      assert.equal(report.guard.safe_git_policy, SAFE_GIT_POLICY);
      assert.equal(report.guard.worktree, repo);
      assert.equal(typeof report.guard.head_commit, "string");
      assert.equal(typeof report.guard.head_tree, "string");
      assert.deepEqual(report.guard.hidden_index_paths, []);
      assert.equal(report.guard.command, guard.command);
      assert.equal(report.guard.exit_code, 0);
      assert.equal(report.guard.stdout, " M tracked.txt\n");
    } finally {
      cleanup(repo);
    }
  });
});

function createCommittedRepo(files = ["tracked.txt"]) {
  const repo = mkdtempSync(join(tmpdir(), "review-guard-repo-"));

  git(repo, ["init"]);
  for (const file of files) {
    writeFixture(repo, file, `${file}\n`);
  }
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=Review Guard Test", "-c", "user.email=review-guard@example.com", "commit", "-m", "initial"]);

  return repo;
}

function getHeadObservation(cwd) {
  const stdout = gitStdout(cwd, ["rev-parse", "HEAD", "HEAD^{tree}"]);
  const [headCommit, headTree] = stdout
    .split(/\r?\n/u)
    .filter(Boolean);

  return { headCommit, headTree };
}

function writeFixture(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function git(cwd, args) {
  const proc = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (proc.error) throw proc.error;
  assert.equal(proc.status, 0, `git ${args.join(" ")} failed:\n${proc.stderr || proc.stdout}`);
  return proc;
}

function gitStdout(cwd, args) {
  const proc = git(cwd, args);
  return proc.stdout;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
