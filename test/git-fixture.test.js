import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ChildProcess, execFileSync, runFixtureGit, spawn, spawnSync } from "./helpers/git-fixture.js";
import { createTwoRefsAtomicallyNoReplace } from "../src/git.js";

describe("fixture Git harness", () => {
  it("exports the native process API shapes used by fixtures", () => {
    assert.equal(typeof spawn, "function");
    assert.equal(typeof spawnSync, "function");
    assert.equal(typeof execFileSync, "function");
    assert.equal(typeof ChildProcess, "function");
  });

  it("returns the raw result for a nonzero Git exit", () => {
    const cwd = mkdtempSync(join(tmpdir(), "feature-factory-git-result-"));
    try {
      const proc = runFixtureGit(cwd, ["config", "--get", "fixture.missing"]);

      assert.equal(proc.status, 1);
      assert.equal(proc.signal, null);
      assert.equal(proc.error, undefined);
      assert.equal(proc.stdout, "");
      assert.equal(proc.stderr, "");
      assert.deepEqual(proc.output, [null, "", ""]);
      assert.equal(Number.isInteger(proc.pid), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("ignores hostile global and system config while preserving local config and identity", () => {
    const root = mkdtempSync(join(tmpdir(), "feature-factory-git-config-"));
    const repo = join(root, "repo");
    const hostileGlobalConfig = join(root, "hostile-global.gitconfig");
    const hostileSystemConfig = join(root, "hostile-system.gitconfig");
    const hostileGlobalContents = "[fixture]\n\thostileGlobal = visible\n";
    const hostileSystemContents = "[fixture]\n\thostileSystem = visible\n";
    const processEnvBefore = { ...process.env };
    const baseEnv = {
      GIT_CONFIG_GLOBAL: hostileGlobalConfig,
      GIT_CONFIG_SYSTEM: hostileSystemConfig,
      GIT_CONFIG_NOSYSTEM: "0",
    };
    const baseEnvBefore = { ...baseEnv };

    try {
      mkdirSync(repo);
      writeFileSync(hostileGlobalConfig, hostileGlobalContents, "utf8");
      writeFileSync(hostileSystemConfig, hostileSystemContents, "utf8");

      assertMissingConfig(repo, "fixture.hostileGlobal", baseEnv);
      assertMissingConfig(repo, "fixture.hostileSystem", baseEnv);

      assertGit(repo, ["init", "-b", "main"], baseEnv);
      assertGit(repo, ["config", "--local", "fixture.localSentinel", "preserved"], baseEnv);
      assertGit(repo, ["config", "--local", "user.name", "Fixture Author"], baseEnv);
      assertGit(repo, ["config", "--local", "user.email", "fixture@example.com"], baseEnv);

      const localSentinel = assertGit(repo, ["config", "--local", "--get", "fixture.localSentinel"], baseEnv);
      assert.equal(localSentinel.stdout, "preserved\n");

      writeFileSync(join(repo, "README.md"), "fixture\n", "utf8");
      assertGit(repo, ["add", "README.md"], baseEnv);
      assertGit(repo, ["commit", "-m", "normal fixture commit"], baseEnv);

      const identity = assertGit(repo, ["log", "-1", "--format=%an%x00%ae"], baseEnv);
      assert.equal(identity.stdout, "Fixture Author\u0000fixture@example.com\n");
      assert.equal(readFileSync(hostileGlobalConfig, "utf8"), hostileGlobalContents);
      assert.equal(readFileSync(hostileSystemConfig, "utf8"), hostileSystemContents);
      assert.deepEqual(baseEnv, baseEnvBefore);
      assert.deepEqual({ ...process.env }, processEnvBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("disables signing without changing hostile local signing settings", () => {
    const root = mkdtempSync(join(tmpdir(), "feature-factory-git-signing-"));
    const repo = join(root, "repo");
    const nonexistentSigner = join(root, "nonexistent-gpg-program");

    try {
      mkdirSync(repo);
      assert.equal(existsSync(nonexistentSigner), false);
      assertGit(repo, ["init", "-b", "main"]);
      assertGit(repo, ["config", "--local", "user.name", "Fixture Author"]);
      assertGit(repo, ["config", "--local", "user.email", "fixture@example.com"]);
      assertGit(repo, ["config", "--local", "commit.gpgsign", "true"]);
      assertGit(repo, ["config", "--local", "gpg.program", nonexistentSigner]);

      writeFileSync(join(repo, "signed.txt"), "signing must be disabled\n", "utf8");
      assertGit(repo, ["add", "signed.txt"]);
      assertGit(repo, ["commit", "-m", "commit without signer"]);

      const signingRequired = assertGit(repo, ["config", "--local", "--get", "commit.gpgsign"]);
      const signerProgram = assertGit(repo, ["config", "--local", "--get", "gpg.program"]);
      assert.equal(signingRequired.stdout, "true\n");
      assert.equal(signerProgram.stdout, `${nonexistentSigner}\n`);
      assert.equal(existsSync(nonexistentSigner), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("atomic no-replace ref transaction", () => {
  it("uses one update-ref stdin transaction with an all-zero old OID for both refs", () => {
    const calls = [];
    const firstOid = "a".repeat(40);
    const secondOid = "b".repeat(40);
    const zero = "0".repeat(40);
    const result = createTwoRefsAtomicallyNoReplace("/tmp", {
      ref: "refs/heads/parent",
      oid: "c".repeat(40),
    }, {
      ref: "refs/opencode/continuations/abc",
      oid: firstOid,
    }, {
      ref: "refs/heads/child",
      oid: secondOid,
    }, {
      spawnSync(file, args, options) {
        calls.push({ file, args: [...args], input: options.input });
        return { status: 0, stdout: "start: ok\nprepare: ok\ncommit: ok\n", stderr: "" };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["update-ref", "--no-deref", "--stdin"]);
    assert.equal(calls[0].input, [
      "start",
      `verify refs/heads/parent ${"c".repeat(40)}`,
      `update refs/opencode/continuations/abc ${firstOid} ${zero}`,
      `update refs/heads/child ${secondOid} ${zero}`,
      "prepare",
      "commit",
      "",
    ].join("\n"));
  });

  it("requires three distinct direct refs with full nonzero object ids", () => {
    const oid = "a".repeat(40);
    const options = { spawnSync: () => ({ status: 0, stdout: "", stderr: "" }) };
    assert.throws(
      () => createTwoRefsAtomicallyNoReplace("/tmp", { ref: "refs/heads/parent", oid }, { ref: "refs/heads/parent", oid }, { ref: "refs/heads/child", oid }, options),
      /three distinct direct refs/u,
    );
    assert.throws(
      () => createTwoRefsAtomicallyNoReplace("/tmp", { ref: "HEAD", oid }, { ref: "refs/claims/one", oid }, { ref: "refs/heads/child", oid }, options),
      /full safe direct ref name/u,
    );
    assert.throws(
      () => createTwoRefsAtomicallyNoReplace("/tmp", { ref: "refs/heads/parent", oid: "a" }, { ref: "refs/claims/one", oid }, { ref: "refs/heads/child", oid }, options),
      /nonzero full lowercase object id/u,
    );
  });
});

function assertGit(cwd, args, baseEnv = {}) {
  const proc = runFixtureGit(cwd, args, { baseEnv });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc;
}

function assertMissingConfig(cwd, key, baseEnv) {
  const proc = runFixtureGit(cwd, ["config", "--get", key], { baseEnv });
  assert.equal(proc.status, 1, proc.stderr || proc.stdout);
  assert.equal(proc.stdout, "");
}
