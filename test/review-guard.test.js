import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
      assert.equal(result.command, `git -C ${repo} status --porcelain=v1 --untracked-files=all --ignore-submodules=none`);
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

  it("does not let repo-local excludesFile hide reviewer-created untracked files", () => {
    const repo = createCommittedRepo();
    const localIgnore = join(repo, ".review-guard-local-ignore");

    try {
      writeFileSync(localIgnore, "hidden-reviewer-file.txt\n", "utf8");
      git(repo, ["config", "core.excludesFile", localIgnore]);
      writeFileSync(join(repo, "hidden-reviewer-file.txt"), "new\n", "utf8");

      const unsafe = gitStdout(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
      assert.equal(unsafe, "?? .review-guard-local-ignore\n");

      const result = checkReviewedWorktreeClean(repo);

      assert.equal(result.ok, false);
      assert.equal(result.status, "dirty");
      assert.equal(result.safe_git_policy, SAFE_GIT_POLICY);
      assert.deepEqual(
        result.dirty_paths.map((item) => item.path).sort(),
        [".review-guard-local-ignore", "hidden-reviewer-file.txt"],
      );
    } finally {
      cleanup(repo);
    }
  });

  it("does not let worktree-local core.worktree redirection hide dirty files", () => {
    const repo = createCommittedRepo();
    const linkedRoot = mkdtempSync(join(tmpdir(), "review-guard-linked-"));
    const cleanRoot = mkdtempSync(join(tmpdir(), "review-guard-clean-"));
    const worktree = join(linkedRoot, "review-worktree");

    try {
      git(repo, ["worktree", "add", "-b", "review-worktree", worktree, "HEAD"]);
      writeFileSync(join(cleanRoot, "tracked.txt"), "tracked.txt\n", "utf8");
      git(worktree, ["config", "extensions.worktreeConfig", "true"]);
      git(worktree, ["config", "--worktree", "core.worktree", cleanRoot]);
      writeFileSync(join(worktree, "tracked.txt"), "changed\n", "utf8");

      const unsafe = gitStdout(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
      assert.equal(unsafe, "");

      const result = checkReviewedWorktreeClean(worktree);

      assert.equal(result.ok, false);
      assert.equal(result.status, "unverifiable");
      assert.equal(result.safe_git_policy, SAFE_GIT_POLICY);
      assert.match(result.stderr, /worktree-identity observation|dirty-state could not be verified/i);
    } finally {
      cleanup(repo);
      cleanup(linkedRoot);
      cleanup(cleanRoot);
    }
  });

  it("does not let .git/info/exclude hide reviewer-created untracked files", () => {
    const repo = createCommittedRepo();

    try {
      appendFileSync(join(repo, ".git", "info", "exclude"), "hidden-by-info-exclude.txt\n", "utf8");
      writeFileSync(join(repo, "hidden-by-info-exclude.txt"), "new\n", "utf8");

      const unsafe = gitStdout(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
      assert.equal(unsafe, "");

      const result = checkReviewedWorktreeClean(repo);

      assert.equal(result.ok, false);
      assert.equal(result.status, "dirty");
      assert.equal(result.stdout, "");
      assert.deepEqual(result.dirty_paths.map((item) => item.path), ["hidden-by-info-exclude.txt"]);
      assert.equal(result.dirty_paths[0].ignored, true);
    } finally {
      cleanup(repo);
    }
  });

  it("does not let core.fileMode=false hide executable-bit-only changes", () => {
    const repo = createCommittedRepo(["script.sh"]);

    try {
      git(repo, ["config", "core.fileMode", "false"]);
      chmodSync(join(repo, "script.sh"), 0o755);

      const unsafe = gitStdout(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
      assert.equal(unsafe, "");

      const result = checkReviewedWorktreeClean(repo);

      assert.equal(result.ok, false);
      assert.equal(result.status, "dirty");
      assert.equal(result.stdout, " M script.sh\n");
      assert.equal(result.dirty_paths[0].path, "script.sh");
    } finally {
      cleanup(repo);
    }
  });

  it("does not let submodule.<name>.ignore=all hide dirty submodule mutations", () => {
    const { root, repo, submoduleName, submodulePath } = createCommittedRepoWithSubmodule();

    try {
      git(repo, ["config", `submodule.${submoduleName}.ignore`, "all"]);
      writeFileSync(join(submodulePath, "tracked.txt"), "changed\n", "utf8");

      const unsafe = gitStdout(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
      assert.equal(unsafe, "");

      const result = checkReviewedWorktreeClean(repo);

      assert.equal(result.ok, false);
      assert.equal(result.status, "dirty");
      assert.equal(result.exit_code, 0);
      assert.equal(result.safe_git_policy, SAFE_GIT_POLICY);
      assert.equal(result.stdout, " M review-submodule\n");
      assert.deepEqual(result.hidden_index_paths, []);
      assert.deepEqual(result.dirty_paths.map((item) => item.path), ["review-submodule"]);
      assert.equal(result.dirty_paths[0].raw, " M review-submodule");
    } finally {
      cleanup(root);
    }
  });

  it("does not let submodule.<name>.ignore=all hide submodule-local ignored untracked files", () => {
    const { root, repo, submoduleName, submodulePath } = createCommittedRepoWithSubmodule({
      submoduleFixtures: {
        ".gitignore": "ignored-inside.txt\n",
        "tracked.txt": "tracked.txt\n",
      },
    });

    try {
      git(repo, ["config", `submodule.${submoduleName}.ignore`, "all"]);
      writeFileSync(join(submodulePath, "ignored-inside.txt"), "new\n", "utf8");

      const unsafe = gitStdout(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
      assert.equal(unsafe, "");

      const result = checkReviewedWorktreeClean(repo);

      assert.equal(result.ok, false);
      assert.equal(result.status, "dirty");
      assert.equal(result.exit_code, 0);
      assert.equal(result.safe_git_policy, SAFE_GIT_POLICY);
      assert.equal(result.stdout, "");
      assert.deepEqual(result.hidden_index_paths, []);
      assert.deepEqual(result.dirty_paths.map((item) => item.path), ["review-submodule/ignored-inside.txt"]);
      assert.equal(result.dirty_paths[0].ignored, true);
      assert.equal(result.dirty_paths[0].untracked, true);
    } finally {
      cleanup(root);
    }
  });

  it("does not let submodule.<name>.ignore=all hide submodule-local hidden index flags", () => {
    const { root, repo, submoduleName, submodulePath } = createCommittedRepoWithSubmodule({
      submoduleFixtures: {
        "assume.txt": "assume.txt\n",
        "skip.txt": "skip.txt\n",
      },
    });

    try {
      git(repo, ["config", `submodule.${submoduleName}.ignore`, "all"]);
      git(submodulePath, ["update-index", "--assume-unchanged", "assume.txt"]);
      git(submodulePath, ["update-index", "--skip-worktree", "skip.txt"]);

      const unsafe = gitStdout(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
      assert.equal(unsafe, "");

      const result = checkReviewedWorktreeClean(repo);

      assert.equal(result.ok, false);
      assert.equal(result.status, "dirty");
      assert.equal(result.exit_code, 0);
      assert.equal(result.safe_git_policy, SAFE_GIT_POLICY);
      assert.equal(result.stdout, "");
      assert.deepEqual(result.dirty_paths, []);
      assert.deepEqual(result.hidden_index_paths, [
        {
          path: "review-submodule/assume.txt",
          tag: "h",
          assume_unchanged: true,
          skip_worktree: false,
        },
        {
          path: "review-submodule/skip.txt",
          tag: "S",
          assume_unchanged: false,
          skip_worktree: true,
        },
      ]);
    } finally {
      cleanup(root);
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

          if (args.includes("status") && args.includes("--ignore-submodules=none")) {
            return { status: 0, stdout: "", stderr: "" };
          }
          if (args[args.length - 1] === "--show-toplevel") {
            return { status: 0, stdout: `${resolve(repo)}\n`, stderr: "" };
          }
          if (args.includes("HEAD^{tree}")) {
            return { status: 0, stdout: `${headCommit}\n${headTree}\n`, stderr: "" };
          }
          if (args[args.length - 2] === "ls-files" && args[args.length - 1] === "-v") {
            return { status: 0, stdout: "", stderr: "" };
          }
          if (args[args.length - 1] === "--exclude-standard") {
            return { status: 0, stdout: "", stderr: "" };
          }
          if (args[args.length - 1] === "--stage") {
            return { status: 0, stdout: "", stderr: "" };
          }

          throw new Error(`unexpected git args: ${args.join(" ")}`);
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.safe_git_policy, SAFE_GIT_POLICY);
      assert.equal(result.command, `git -C ${repo} status --porcelain=v1 --untracked-files=all --ignore-submodules=none`);
      assert.deepEqual(calls.map((call) => call.args), [
        expectedSafeGitArgs(repo, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]),
        expectedSafeGitArgs(repo, ["rev-parse", "--show-toplevel"]),
        expectedSafeGitArgs(repo, ["rev-parse", "HEAD", "HEAD^{tree}"]),
        expectedSafeGitArgs(repo, ["ls-files", "-v"]),
        expectedSafeGitArgs(repo, ["ls-files", "--others", "--ignored", "--exclude-standard"]),
        expectedSafeGitArgs(repo, ["ls-files", "--stage"]),
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

function createCommittedRepoWithSubmodule({ submoduleFixtures = { "tracked.txt": "tracked.txt\n" } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "review-guard-submodule-"));
  const submoduleSource = join(root, "submodule-source");
  const repo = join(root, "super-repo");
  const submoduleName = "review-submodule";
  const submodulePath = join(repo, submoduleName);

  mkdirSync(submoduleSource, { recursive: true });
  mkdirSync(repo, { recursive: true });

  git(submoduleSource, ["init"]);
  for (const [file, content] of Object.entries(submoduleFixtures)) {
    writeFixture(submoduleSource, file, content);
  }
  git(submoduleSource, ["add", "."]);
  git(submoduleSource, ["-c", "user.name=Review Guard Test", "-c", "user.email=review-guard@example.com", "commit", "-m", "initial submodule"]);

  git(repo, ["init"]);
  git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", submoduleSource, submoduleName]);
  git(repo, ["-c", "user.name=Review Guard Test", "-c", "user.email=review-guard@example.com", "commit", "-am", "initial"]);

  return { root, repo, submoduleName, submodulePath };
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

function expectedSafeGitArgs(cwd, args) {
  return [...SAFE_GIT_PREFIX_ARGS, "-c", `core.worktree=${resolve(cwd)}`, ...args];
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
