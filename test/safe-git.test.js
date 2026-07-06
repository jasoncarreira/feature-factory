import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  SAFE_GIT_SYSTEM_PATH,
  getTrustedGitPath,
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
      assert.equal(result.command.file, getTrustedGitPath());
      assert.equal(result.command.cwd, resolve(repo));
      assert.equal(result.command.shell, false);
      assert.equal(result.command.timeout, MAX_SAFE_GIT_TIMEOUT_MS);
      assert.equal(result.command.maxBuffer, MAX_SAFE_GIT_MAX_BUFFER);

      assert.equal(call.file, getTrustedGitPath());
      assert.deepEqual(call.args, result.command.args);
      assert.equal(call.options.shell, false);
      assert.equal(call.options.cwd, resolve(repo));
      assert.equal(call.options.timeout, MAX_SAFE_GIT_TIMEOUT_MS);
      assert.equal(call.options.maxBuffer, MAX_SAFE_GIT_MAX_BUFFER);
      assert.equal(call.options.env.CUSTOM_ENV, "kept");
      assert.equal(call.options.env.PATH, SAFE_GIT_SYSTEM_PATH);
      assert.equal(call.options.env.PATHEXT, undefined);
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

  it("ignores fake git binaries injected earlier in PATH", () => {
    const repo = createCommittedRepo(["tracked.txt"]);
    const hijackDir = mkdtempSync(join(tmpdir(), "safe-git-path-hijack-"));
    const fakeGitPath = join(hijackDir, "git");
    const hijackedPath = `${hijackDir}:${process.env.PATH || ""}`;

    try {
      writeFileSync(fakeGitPath, "#!/bin/sh\nprintf 'FAKE_GIT\\n'\n", "utf8");
      chmodSync(fakeGitPath, 0o755);

      const unsafe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, PATH: hijackedPath },
      });
      assert.equal(unsafe.status, 0);
      assert.equal(unsafe.stdout.trim(), "FAKE_GIT");

      const result = safeGit(repo, ["rev-parse", "--show-toplevel"], {
        env: { PATH: hijackedPath },
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, 0);
      assert.equal(result.command.file, getTrustedGitPath());
      assert.equal(result.stdout.trim(), realpathSync.native(repo));
      assert.notEqual(result.stdout.trim(), "FAKE_GIT");
    } finally {
      cleanup(repo);
      cleanup(hijackDir);
    }
  });

  it("blocks replace-ref forgery with no-replace hardening", () => {
    const repo = createTwoCommitRepo();

    try {
      const headCommit = gitStdout(repo, ["rev-parse", "HEAD"]).trim();
      const parentCommit = gitStdout(repo, ["rev-parse", "HEAD^"]).trim();
      git(repo, ["replace", headCommit, parentCommit]);

      const unsafe = runTrustedGit(repo, ["cat-file", "-p", "HEAD"]);
      assert.equal(unsafe.status, 0);
      assert.equal(commitMessageFromCatFile(unsafe.stdout), "first");

      const result = safeGit(repo, ["cat-file", "-p", "HEAD"]);

      assert.equal(result.ok, true);
      assert.equal(result.status, 0);
      assert.equal(commitMessageFromCatFile(result.stdout), "second");
    } finally {
      cleanup(repo);
    }
  });

  it("blocks hostile global config from hiding untracked files", () => {
    const repo = createCommittedRepo(["tracked.txt"]);
    const configDir = mkdtempSync(join(tmpdir(), "safe-git-global-config-"));
    const globalIgnorePath = join(configDir, "global-ignore");
    const globalConfigPath = join(configDir, "gitconfig");

    try {
      writeFileSync(globalIgnorePath, "hidden-by-global.txt\n", "utf8");
      writeFileSync(globalConfigPath, `[core]\n\texcludesfile = ${globalIgnorePath}\n`, "utf8");
      writeFixture(repo, "hidden-by-global.txt", "hidden\n");

      const unsafe = runTrustedGit(repo, ["status", "--porcelain=v1", "--untracked-files=all"], {
        GIT_CONFIG_GLOBAL: globalConfigPath,
      });
      assert.equal(unsafe.status, 0);
      assert.equal(unsafe.stdout, "");

      const result = safeGit(repo, ["status", "--porcelain=v1", "--untracked-files=all"], {
        env: { GIT_CONFIG_GLOBAL: globalConfigPath },
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "?? hidden-by-global.txt\n");
      assert.equal(result.stderr, "");
    } finally {
      cleanup(repo);
      cleanup(configDir);
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

function createTwoCommitRepo() {
  const repo = mkdtempSync(join(tmpdir(), "safe-git-history-"));

  git(repo, ["init"]);
  writeFixture(repo, "tracked.txt", "first\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["-c", "user.name=Safe Git Test", "-c", "user.email=safe-git@example.com", "commit", "-m", "first"]);

  writeFixture(repo, "tracked.txt", "second\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["-c", "user.name=Safe Git Test", "-c", "user.email=safe-git@example.com", "commit", "-m", "second"]);

  return repo;
}

function writeFixture(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function git(cwd, args) {
  const proc = runTrustedGit(cwd, args);
  if (proc.error) throw proc.error;
  assert.equal(proc.status, 0, `git ${args.join(" ")} failed:\n${proc.stderr || proc.stdout}`);
  return proc;
}

function gitStdout(cwd, args, env = {}) {
  const proc = runTrustedGit(cwd, args, env);
  if (proc.error) throw proc.error;
  assert.equal(proc.status, 0, `git ${args.join(" ")} failed:\n${proc.stderr || proc.stdout}`);
  return proc.stdout;
}

function runTrustedGit(cwd, args, env = {}) {
  return spawnSync(getTrustedGitPath(), args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function commitMessageFromCatFile(output) {
  return String(output).split(/\n\n/u).at(-1)?.trim() || "";
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
