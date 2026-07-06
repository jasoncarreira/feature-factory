import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_SAFE_GIT_MAX_BUFFER,
  DEFAULT_SAFE_GIT_TIMEOUT_MS,
  MAX_SAFE_GIT_MAX_BUFFER,
  MAX_SAFE_GIT_TIMEOUT_MS,
  SAFE_GIT_ENV_OVERRIDES,
  SAFE_GIT_POLICY,
  SAFE_GIT_PREFIX_ARGS,
  listHiddenIndexPaths,
  safeGit,
} from "../src/safe-git.js";

describe("safeGit", () => {
  it("exports the stable policy and executes git with hardened array-only spawn options", () => {
    const repo = createCommittedRepo(["tracked.txt"]);
    let call = null;

    try {
      const result = safeGit(repo, ["status", "--porcelain=v1"], {
        env: {
          CUSTOM_ENV: "kept",
          GIT_DIR: "/tmp/evil-dir",
          GIT_WORK_TREE: "/tmp/evil-worktree",
          GIT_CONFIG_GLOBAL: "/tmp/evil-config",
        },
        timeout: Number.MAX_SAFE_INTEGER,
        maxBuffer: Number.MAX_SAFE_INTEGER,
        spawnSync(file, args, options) {
          call = { file, args, options };
          return { status: 0, stdout: "", stderr: "" };
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.policy, SAFE_GIT_POLICY);
      assert.deepEqual(result.command.args, [...SAFE_GIT_PREFIX_ARGS, "status", "--porcelain=v1"]);
      assert.equal(result.command.file, "git");
      assert.equal(result.command.cwd, resolve(repo));
      assert.equal(result.command.shell, false);
      assert.equal(result.command.timeout, MAX_SAFE_GIT_TIMEOUT_MS);
      assert.equal(result.command.maxBuffer, MAX_SAFE_GIT_MAX_BUFFER);

      assert.equal(call.file, "git");
      assert.deepEqual(call.args, result.command.args);
      assert.equal(call.options.shell, false);
      assert.equal(call.options.cwd, resolve(repo));
      assert.equal(call.options.timeout, MAX_SAFE_GIT_TIMEOUT_MS);
      assert.equal(call.options.maxBuffer, MAX_SAFE_GIT_MAX_BUFFER);
      assert.equal(call.options.env.CUSTOM_ENV, "kept");
      assert.equal(call.options.env.GIT_DIR, undefined);
      assert.equal(call.options.env.GIT_WORK_TREE, undefined);
      assert.equal(call.options.env.GIT_CONFIG_GLOBAL, SAFE_GIT_ENV_OVERRIDES.GIT_CONFIG_GLOBAL);
      assert.equal(call.options.env.GIT_NO_REPLACE_OBJECTS, SAFE_GIT_ENV_OVERRIDES.GIT_NO_REPLACE_OBJECTS);
      assert.equal(call.options.env.GIT_CONFIG_NOSYSTEM, SAFE_GIT_ENV_OVERRIDES.GIT_CONFIG_NOSYSTEM);
    } finally {
      cleanup(repo);
    }
  });

  it("strips hostile GIT_* environment overrides before executing git", () => {
    const repo = createCommittedRepo(["tracked.txt"]);
    const hostileRepo = createCommittedRepo(["other.txt"]);

    try {
      const result = safeGit(repo, ["rev-parse", "--show-toplevel"], {
        env: {
          GIT_DIR: join(hostileRepo, ".git"),
          GIT_WORK_TREE: hostileRepo,
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), realpathSync.native(repo));
      assert.equal(result.stderr, "");
      assert.deepEqual(result.command.args, [...SAFE_GIT_PREFIX_ARGS, "rev-parse", "--show-toplevel"]);
    } finally {
      cleanup(repo);
      cleanup(hostileRepo);
    }
  });

  it("returns structured failures for normal git errors instead of throwing", () => {
    const repo = createCommittedRepo(["tracked.txt"]);

    try {
      const result = safeGit(repo, ["rev-parse", "--verify", "refs/heads/does-not-exist"]);

      assert.equal(result.ok, false);
      assert.notEqual(result.status, 0);
      assert.equal(result.policy, SAFE_GIT_POLICY);
      assert.equal(Array.isArray(result.command.args), true);
      assert.equal(result.command.shell, false);
      assert.equal(result.stdout, "");
      assert.notEqual(result.stderr.length, 0);
    } finally {
      cleanup(repo);
    }
  });

  it("rejects invalid args and unsafe git entrypoints", () => {
    const repo = createCommittedRepo(["tracked.txt"]);

    try {
      assert.throws(() => safeGit(repo, "status"), /array of strings/u);
      assert.throws(() => safeGit(repo, []), /must include a git subcommand/u);
      assert.throws(() => safeGit(repo, ["-c", "core.hooksPath=/tmp/pwn", "status"]), /global git options/u);
      assert.throws(() => safeGit(repo, ["worktree", "remove", repo]), /worktree list/u);
    } finally {
      cleanup(repo);
    }
  });

  it("uses bounded default timeout and maxBuffer values", () => {
    const repo = createCommittedRepo(["tracked.txt"]);
    let call = null;

    try {
      safeGit(repo, ["status"], {
        spawnSync(file, args, options) {
          call = { file, args, options };
          return { status: 0, stdout: "", stderr: "" };
        },
      });

      assert.equal(call.options.timeout, DEFAULT_SAFE_GIT_TIMEOUT_MS);
      assert.equal(call.options.maxBuffer, DEFAULT_SAFE_GIT_MAX_BUFFER);
    } finally {
      cleanup(repo);
    }
  });
});

describe("listHiddenIndexPaths", () => {
  it("detects assume-unchanged and skip-worktree entries from git ls-files -v", () => {
    const repo = createCommittedRepo(["visible.txt", "assume.txt", "skip.txt"]);

    try {
      git(repo, ["update-index", "--assume-unchanged", "assume.txt"]);
      git(repo, ["update-index", "--skip-worktree", "skip.txt"]);

      const result = listHiddenIndexPaths(repo);

      assert.equal(result.ok, true);
      assert.equal(result.status, 0);
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
      assert.deepEqual(result.command.args, [...SAFE_GIT_PREFIX_ARGS, "ls-files", "-v"]);
    } finally {
      cleanup(repo);
    }
  });
});

function createCommittedRepo(files) {
  const repo = mkdtempSync(join(tmpdir(), "safe-git-repo-"));

  git(repo, ["init"]);
  for (const file of files) {
    writeFixture(repo, file, `${file}\n`);
  }
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=Safe Git Test", "-c", "user.email=safe-git@example.com", "commit", "-m", "initial"]);

  return repo;
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

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
