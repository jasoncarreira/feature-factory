import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { advanceFactoryRunBase as cliAdvanceFactoryRunBase } from "../src/cli.js";
import { advanceFactoryRunBase } from "../src/factory.js";
import { createBaseAdvanceTransitionFixture, output } from "./helpers/base-advance-transition/fixture.js";
import { spawnSync } from "./helpers/git-fixture.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

describe("factory base-advance CLI contract", () => {
  it("re-exports the existing closed factory API from the ./cli module", () => {
    assert.equal(cliAdvanceFactoryRunBase, advanceFactoryRunBase);
  });

  it("prints the exact advanced and already-current JSON documents with matching exits", () => {
    const fixture = createBaseAdvanceTransitionFixture("cli-success");
    try {
      const target = fixture.advance();
      const advanced = runCli(fixture.repo, ["factory", "base-advance", fixture.runId, "--json"]);
      assert.equal(advanced.status, 0, advanced.stderr || advanced.stdout);
      assert.equal(advanced.stderr, "");
      assert.deepEqual(JSON.parse(advanced.stdout), success(fixture, target, "advanced", true, false, fixture.base));

      const replayed = runCli(fixture.repo, ["factory", "base-advance", "--json", fixture.runId]);
      assert.equal(replayed.status, 0, replayed.stderr || replayed.stdout);
      assert.equal(replayed.stderr, "");
      assert.deepEqual(JSON.parse(replayed.stdout), success(fixture, target, "already-current", false, true, target));
      assert.equal(fixture.readRun().base_commit, target);
      assert.equal(output(fixture.worktree, ["rev-parse", "HEAD"]), target);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects every non-exact grammar as one closed usage document before mutation", () => {
    const fixture = createBaseAdvanceTransitionFixture("cli-grammar");
    try {
      fixture.advance();
      const invalidArguments = [
        ["factory", "base-advance", fixture.runId],
        ["factory", "base-advance", fixture.runId, "--json", "--json"],
        ["factory", "base-advance", "--json"],
        ["factory", "base-advance", fixture.runId, "extra", "--json"],
        ["factory", "base-advance", fixture.runId, "--repo", fixture.repo, "--json"],
        ["factory", "base-advance", fixture.runId, "--force", "--json"],
        ["factory", "base-advance", fixture.runId, "--commit", "f".repeat(40), "--json"],
        ["factory", "base-advance", fixture.runId, "--ref", "refs/heads/main", "--json"],
        ["factory", "base-advance", fixture.runId, "--branch", fixture.runId, "--json"],
        ["factory", "base-advance", fixture.runId, "--worktree", fixture.worktree, "--json"],
      ];
      for (const args of invalidArguments) {
        const rejected = runCli(fixture.repo, args);
        assert.equal(rejected.status, 1, args.join(" "));
        assert.equal(rejected.stderr, "", args.join(" "));
        const envelope = JSON.parse(rejected.stdout);
        assert.deepEqual(Object.keys(envelope), ["ok", "operation", "run_id", "error"], args.join(" "));
        assert.equal(envelope.ok, false, args.join(" "));
        assert.equal(envelope.operation, "active-run-base-advance", args.join(" "));
        assert.deepEqual(envelope.error, {
          code: "BASE_ADVANCE_USAGE",
          message: "factory base-advance requires exactly <run-id> --json",
        }, args.join(" "));
      }
      assert.equal(fixture.readRun().base_commit, fixture.base);
      assert.equal(output(fixture.worktree, ["rev-parse", "HEAD"]), fixture.base);
    } finally {
      fixture.cleanup();
    }
  });

  it("normalizes one safe ID once and rejects unsafe IDs with a null envelope identity", () => {
    const fixture = createBaseAdvanceTransitionFixture("cli-id");
    try {
      const target = fixture.advance();
      const normalized = runCli(fixture.repo, ["factory", "base-advance", `  ${fixture.runId}\t`, "--json"]);
      assert.equal(normalized.status, 0, normalized.stderr || normalized.stdout);
      assert.equal(JSON.parse(normalized.stdout).base_commit, target);

      for (const unsafe of ["../run", ".", "run.lock", "run/id", "run id", "-run", "run-"]) {
        const rejected = runCli(fixture.repo, ["factory", "base-advance", unsafe, "--json"]);
        assert.equal(rejected.status, 1, unsafe);
        assert.equal(rejected.stderr, "", unsafe);
        assert.deepEqual(JSON.parse(rejected.stdout), failure(null, "BASE_ADVANCE_USAGE", "factory base-advance requires one safe bare run id"), unsafe);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("returns operational failures as one sanitized JSON document on stdout", () => {
    const fixture = createBaseAdvanceTransitionFixture("cli-failure");
    try {
      fixture.advance();
      writeFileSync(`${fixture.worktree}/PRIVATE-CONTENTS.txt`, "credential-secret\n");
      const rejected = runCli(fixture.repo, ["factory", "base-advance", fixture.runId, "--json"]);
      assert.equal(rejected.status, 1);
      assert.equal(rejected.stderr, "");
      assert.deepEqual(JSON.parse(rejected.stdout), failure(
        fixture.runId,
        "BASE_ADVANCE_GIT_STATE_INVALID",
        "registered worktree identity is invalid",
      ));
      assert.equal(rejected.stdout.includes("credential-secret"), false);
      assert.equal(rejected.stdout.includes(fixture.root), false);
    } finally {
      fixture.cleanup();
    }
  });

  it("advertises the exact JSON-only command in help", () => {
    const help = runCli(process.cwd(), ["--help"]);
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.equal(help.stderr, "");
    assert.equal(help.stdout.includes("factory base-advance <run-id> --json"), true);
  });
});

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function success(fixture, target, disposition, updated, replayed, previousBase) {
  return {
    ok: true,
    operation: "active-run-base-advance",
    run_id: fixture.runId,
    disposition,
    updated,
    replayed,
    base_ref: "main",
    previous_base_commit: previousBase,
    base_commit: target,
    branch: fixture.runId,
    worktree: fixture.worktree,
  };
}

function failure(runId, code, message) {
  return {
    ok: false,
    operation: "active-run-base-advance",
    run_id: runId,
    error: { code, message },
  };
}
