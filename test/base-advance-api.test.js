import assert from "node:assert/strict";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { advanceFactoryRunBase } from "../src/factory.js";
import { createBaseAdvanceTransitionFixture, output } from "./helpers/base-advance-transition/fixture.js";

describe("factory active-run base-advance API", () => {
  it("returns the exact closed advanced and already-current envelopes", async () => {
    const fixture = createBaseAdvanceTransitionFixture("api-success");
    try {
      const target = fixture.advance();
      const advanced = await advanceFactoryRunBase(`  ${fixture.runId}\t`, { cwd: fixture.repo });
      assert.deepEqual(advanced, success(fixture, target, "advanced", true, false, fixture.base));
      assert.equal(fixture.readRun().base_commit, target);
      assert.equal(output(fixture.worktree, ["rev-parse", "HEAD"]), target);

      const alreadyCurrent = await advanceFactoryRunBase(fixture.runId, { cwd: fixture.repo });
      assert.deepEqual(alreadyCurrent, success(fixture, target, "already-current", false, true, target));
    } finally {
      fixture.cleanup();
    }
  });

  it("fulfills every unsafe ID and invalid options case with one closed usage envelope", async () => {
    const invalidIds = [null, undefined, 1, "", " ", ".", "..", "a..b", "run.lock", "-run", "run-", "run id", "run/id", "run\\id", "~", "C:run"];
    for (const runId of invalidIds) {
      const result = await advanceFactoryRunBase(runId, {});
      assert.deepEqual(result, failure(null, "BASE_ADVANCE_USAGE", "factory base-advance requires one safe bare run id"), String(runId));
    }

    const optionsCases = [
      null,
      [],
      new Date(0),
      Object.create(null),
      { cwd: "" },
      { cwd: 7 },
      { target: "f".repeat(40) },
      { gitOptions: {} },
      { now: "2026-07-23T12:30:00.000Z" },
      { cwd: "/tmp", force: true },
    ];
    for (const options of optionsCases) {
      const result = await advanceFactoryRunBase("safe-run", options);
      assert.deepEqual(result, failure("safe-run", "BASE_ADVANCE_USAGE", "factory base-advance options must be a plain closed object containing only optional cwd"));
    }
  });

  it("uses only the selected repository direct root and rejects missing or mismatched durable identity", async () => {
    const fixture = createBaseAdvanceTransitionFixture("api-direct-root");
    try {
      const fromNestedWorktree = await advanceFactoryRunBase(fixture.runId, { cwd: fixture.worktree });
      assert.deepEqual(fromNestedWorktree, failure(fixture.runId, "BASE_ADVANCE_RUN_INVALID", "factory base-advance run could not be resolved safely"));

      fixture.writeRun({ ...fixture.readRun(), run_id: "different-run" });
      const mismatched = await advanceFactoryRunBase(fixture.runId, { cwd: fixture.repo });
      assert.deepEqual(mismatched, failure(fixture.runId, "BASE_ADVANCE_RUN_INVALID", "factory base-advance durable run identity does not match the requested run"));
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects symlink-substituted run directories and manifests without invoking the transition", async () => {
    for (const target of ["run-directory", "run-json"]) {
      const fixture = createBaseAdvanceTransitionFixture(`api-symlink-${target}`);
      try {
        fixture.advance();
        if (target === "run-directory") {
          const moved = `${fixture.runDir}-real`;
          renameSync(fixture.runDir, moved);
          symlinkSync(moved, fixture.runDir, "dir");
        } else {
          const manifest = join(fixture.runDir, "run.json");
          const moved = join(fixture.runDir, "run.real.json");
          renameSync(manifest, moved);
          symlinkSync(moved, manifest, "file");
        }
        const result = await advanceFactoryRunBase(fixture.runId, { cwd: fixture.repo });
        assert.deepEqual(result, failure(fixture.runId, "BASE_ADVANCE_RUN_INVALID", "factory base-advance run could not be resolved safely"));
        assert.equal(output(fixture.worktree, ["rev-parse", "HEAD"]), fixture.base);
      } finally {
        fixture.cleanup();
      }
    }
  });

  it("maps malformed state and operational rejection to sanitized stable error envelopes", async () => {
    const malformed = createBaseAdvanceTransitionFixture("api-malformed");
    try {
      writeFileSync(join(malformed.runDir, "run.json"), "PRIVATE-CONTENTS {");
      assert.deepEqual(
        await advanceFactoryRunBase(malformed.runId, { cwd: malformed.repo }),
        failure(malformed.runId, "BASE_ADVANCE_RUN_INVALID", "factory base-advance run could not be resolved safely"),
      );
    } finally {
      malformed.cleanup();
    }

    const dirty = createBaseAdvanceTransitionFixture("api-dirty");
    try {
      dirty.advance();
      writeFileSync(join(dirty.worktree, "PRIVATE-CONTENTS.txt"), "credential-secret\n");
      const result = await advanceFactoryRunBase(dirty.runId, { cwd: dirty.repo });
      assert.deepEqual(result, failure(dirty.runId, "BASE_ADVANCE_GIT_STATE_INVALID", "registered worktree identity is invalid"));
      assert.equal(JSON.stringify(result).includes("credential-secret"), false);
      assert.equal(JSON.stringify(result).includes(dirty.root), false);
    } finally {
      dirty.cleanup();
    }
  });

  it("classifies a valid cwd outside a Git repository as run-invalid rather than throwing", async () => {
    const fixture = createBaseAdvanceTransitionFixture("api-no-repository");
    const outside = join(fixture.root, "outside");
    try {
      mkdirSync(outside);
      const result = await advanceFactoryRunBase("safe-run", { cwd: outside });
      assert.deepEqual(result, failure("safe-run", "BASE_ADVANCE_RUN_INVALID", "factory base-advance run could not be resolved safely"));
    } finally {
      fixture.cleanup();
    }
  });
});

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
