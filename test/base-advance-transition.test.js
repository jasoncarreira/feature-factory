import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { hashValue } from "../src/refs.js";
import { transitionRunBaseAdvance, transitionRunJson } from "../src/run-state.js";
import { spawnSync } from "./helpers/git-fixture.js";
import {
  captureRepresentativeAuthorityInventory,
  createBaseAdvanceTransitionFixture,
  git,
  installRepresentativeAuthorityInventory,
  output,
  writeJson,
} from "./helpers/base-advance-transition/fixture.js";

const LATER = "2026-07-23T12:30:00.000Z";

describe("checked active-run base advancement", () => {
  it("fast-forwards and binds the exact canonical target while changing only base_commit and updated_at", async () => {
    const fixture = createBaseAdvanceTransitionFixture("advance");
    try {
      const target = fixture.advance();
      const before = fixture.readRun();
      const result = await transitionRunBaseAdvance(fixture.runDir, { now: LATER });
      const after = fixture.readRun();
      assert.deepEqual(result, success(before, target, "advanced", true, false));
      assert.deepEqual(after, { ...before, base_commit: target, updated_at: LATER });
      assert.equal(output(fixture.repo, ["rev-parse", `refs/heads/${fixture.runId}`]), target);
      assert.equal(output(fixture.worktree, ["rev-parse", "HEAD"]), target);
      assert.equal(output(fixture.worktree, ["symbolic-ref", "HEAD"]), `refs/heads/${fixture.runId}`);
      assert.equal(output(fixture.worktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    } finally {
      fixture.cleanup();
    }
  });

  it("replays an already-current identity without changing manifest bytes", async () => {
    const fixture = createBaseAdvanceTransitionFixture("replay");
    try {
      const before = readFileSync(join(fixture.runDir, "run.json"));
      const result = await transitionRunBaseAdvance(fixture.runDir, { now: LATER });
      assert.deepEqual(result, success(fixture.run, fixture.base, "already-current", false, true));
      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), before);
    } finally {
      fixture.cleanup();
    }
  });

  it("recovers all three crash states deterministically without reset or rebase", async () => {
    for (const crashPoint of ["before-git", "after-git", "during-bind", "after-bind"]) {
      const fixture = createBaseAdvanceTransitionFixture(crashPoint);
      try {
        const target = fixture.advance();
        const hooks = crashPoint === "before-git" ? { beforeGit() { throw new Error("crash-before-git"); } }
          : crashPoint === "after-git" ? { afterGit() { throw new Error("crash-after-git"); } }
            : crashPoint === "during-bind" ? {}
            : { afterBind() { throw new Error("crash-after-bind"); } };
        const atomicHooks = crashPoint === "during-bind" ? { beforeCommit() { throw new Error("crash-during-bind"); } } : undefined;
        await assert.rejects(transitionRunBaseAdvance(fixture.runDir, { now: LATER, baseAdvanceHooks: hooks, baseAdvanceAtomicWriteHooks: atomicHooks }),
          (error) => causalMessages(error).includes(`crash-${crashPoint}`));
        const interrupted = fixture.readRun();
        if (crashPoint === "before-git") {
          assert.equal(interrupted.base_commit, fixture.base);
          assert.equal(output(fixture.worktree, ["rev-parse", "HEAD"]), fixture.base);
        } else if (["after-git", "during-bind"].includes(crashPoint)) {
          assert.equal(interrupted.base_commit, fixture.base);
          assert.equal(output(fixture.worktree, ["rev-parse", "HEAD"]), target);
        } else {
          assert.equal(interrupted.base_commit, target);
          assert.equal(output(fixture.worktree, ["rev-parse", "HEAD"]), target);
        }
        const retried = await transitionRunBaseAdvance(fixture.runDir, { now: LATER });
        assert.equal(retried.disposition, crashPoint === "after-bind" ? "already-current" : "advanced");
        assert.equal(fixture.readRun().base_commit, target);
        assert.equal(output(fixture.repo, ["reflog", "show", "--format=%gs", fixture.runId]).includes("reset"), false);
        assert.equal(existsSync(output(fixture.worktree, ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"])), false);
      } finally {
        fixture.cleanup();
      }
    }
  });

  it("fails closed for dirty, split, target-moved, and active authority without repairing state", async () => {
    const cases = [
      ["dirty", (fixture) => writeFileSync(join(fixture.worktree, "dirty.txt"), "dirty\n"), "BASE_ADVANCE_GIT_STATE_INVALID"],
      ["split", (fixture) => git(fixture.worktree, ["checkout", "--detach", fixture.base]), "BASE_ADVANCE_GIT_STATE_INVALID"],
      ["pr-bound", (fixture) => fixture.writeRun({ ...fixture.readRun(), pr_url: "https://github.com/example/repo/pull/1" }), "BASE_ADVANCE_INELIGIBLE"],
    ];
    for (const [name, arrange, code] of cases) {
      const fixture = createBaseAdvanceTransitionFixture(name);
      try {
        const target = fixture.advance();
        arrange(fixture, target);
        const manifest = readFileSync(join(fixture.runDir, "run.json"));
        await assert.rejects(transitionRunBaseAdvance(fixture.runDir), (error) => error.code === code);
        assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), manifest);
      } finally {
        fixture.cleanup();
      }
    }

    const moved = createBaseAdvanceTransitionFixture("target-moved");
    try {
      moved.advance("first\n");
      const manifest = readFileSync(join(moved.runDir, "run.json"));
      await assert.rejects(transitionRunBaseAdvance(moved.runDir, {
        baseAdvanceHooks: { beforeBind: () => moved.advance("second\n") },
      }), (error) => error.code === "BASE_ADVANCE_TARGET_MOVED");
      assert.deepEqual(readFileSync(join(moved.runDir, "run.json")), manifest);
    } finally {
      moved.cleanup();
    }

    const movedAfterGit = createBaseAdvanceTransitionFixture("target-moved-after-git");
    try {
      const firstTarget = movedAfterGit.advance("first\n");
      await assert.rejects(transitionRunBaseAdvance(movedAfterGit.runDir, {
        baseAdvanceHooks: { afterGit() { throw new Error("interrupt-after-git"); } },
      }), (error) => causalMessages(error).includes("interrupt-after-git"));
      assert.equal(movedAfterGit.readRun().base_commit, movedAfterGit.base);
      assert.equal(output(movedAfterGit.worktree, ["rev-parse", "HEAD"]), firstTarget);
      movedAfterGit.advance("second\n");
      await assert.rejects(transitionRunBaseAdvance(movedAfterGit.runDir), (error) => error.code === "BASE_ADVANCE_TARGET_MOVED");
      assert.equal(movedAfterGit.readRun().base_commit, movedAfterGit.base);
      assert.equal(output(movedAfterGit.worktree, ["rev-parse", "HEAD"]), firstTarget);
    } finally {
      movedAfterGit.cleanup();
    }
  });

  it("rejects an orphan special-dispatch closure before Git movement", async () => {
    const fixture = createBaseAdvanceTransitionFixture("orphan-special-closure");
    try {
      fixture.advance();
      const dispatchDir = join(fixture.runDir, "dispatch");
      mkdirSync(dispatchDir);
      writeJson(join(dispatchDir, `${"a".repeat(64)}.special.closed.json`), { orphan: true });
      const manifest = readFileSync(join(fixture.runDir, "run.json"));

      await assert.rejects(transitionRunBaseAdvance(fixture.runDir), (error) => error.code === "BASE_ADVANCE_RUN_INVALID");

      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), manifest);
      assert.equal(output(fixture.repo, ["rev-parse", `refs/heads/${fixture.runId}`]), fixture.base);
      assert.equal(output(fixture.worktree, ["rev-parse", "HEAD"]), fixture.base);
    } finally {
      fixture.cleanup();
    }
  });

  it("classifies fresh and stale live heartbeats as active, dead as inactive, and indeterminate as invalid", async () => {
    const rejected = [
      ["stale-live", "2026-07-23T11:00:00.000Z", () => ({ status: "live" }), "BASE_ADVANCE_INELIGIBLE"],
      ["fresh-live", LATER, () => ({ status: "live" }), "BASE_ADVANCE_INELIGIBLE"],
      ["indeterminate", LATER, () => ({ status: "indeterminate" }), "BASE_ADVANCE_RUN_INVALID"],
    ];
    for (const [name, lastTickAt, livenessProbe, code] of rejected) {
      const fixture = createBaseAdvanceTransitionFixture(name);
      try {
        fixture.advance();
        writeHeartbeat(fixture, lastTickAt);
        const manifest = readFileSync(join(fixture.runDir, "run.json"));
        const integrationHead = output(fixture.worktree, ["rev-parse", "HEAD"]);
        await assert.rejects(transitionRunBaseAdvance(fixture.runDir, { now: LATER, livenessProbe }), (error) => error.code === code);
        assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), manifest, `${name} manifest`);
        assert.equal(output(fixture.worktree, ["rev-parse", "HEAD"]), integrationHead, `${name} integration head`);
      } finally {
        fixture.cleanup();
      }
    }

    const dead = createBaseAdvanceTransitionFixture("dead-heartbeat");
    try {
      const target = dead.advance();
      writeHeartbeat(dead, LATER);
      const result = await transitionRunBaseAdvance(dead.runDir, { now: LATER, livenessProbe: () => ({ status: "absent" }) });
      assert.deepEqual(result, success(dead.run, target, "advanced", true, false));
      assert.equal(dead.readRun().base_commit, target);
      assert.equal(output(dead.worktree, ["rev-parse", "HEAD"]), target);
    } finally {
      dead.cleanup();
    }
  });

  it("preserves the complete representative authority inventory and admits settled steering history", async () => {
    const fixture = createBaseAdvanceTransitionFixture("preserve");
    try {
      const inventory = installRepresentativeAuthorityInventory(fixture);
      const target = fixture.advance();
      const beforeRun = fixture.readRun();
      const beforeInventory = captureRepresentativeAuthorityInventory(fixture, inventory);
      assert.deepEqual(Object.keys(beforeInventory.run_files), inventory.protectedRunPaths);
      assert.deepEqual(Object.keys(beforeInventory.candidate.files), inventory.candidateFiles);
      assert.equal(beforeRun.steering.last_action.outcome, "closed");
      assert.equal(beforeRun.steering.history[0].event, "acknowledged");
      const result = await transitionRunBaseAdvance(fixture.runDir, { now: LATER });
      const afterRun = fixture.readRun();
      assert.equal(result.base_commit, target);
      assert.deepEqual(captureRepresentativeAuthorityInventory(fixture, inventory), beforeInventory);
      assert.deepEqual(afterRun, { ...beforeRun, base_commit: target, updated_at: LATER });
      assert.deepEqual(omitMutable(afterRun), omitMutable(beforeRun));
    } finally {
      fixture.cleanup();
    }
  });

  it("classifies uncoded durable reads, dependency Git diagnostics, and proven pre-publication changes without leaking details", async () => {
    for (const method of ["readdirSync", "lstatSync", "openSync", "fstatSync", "readFileSync"]) {
      const fixture = createBaseAdvanceTransitionFixture(`durable-${method}`);
      try {
        fixture.advance();
        writeFileSync(join(fixture.runDir, "sidecar.txt"), "PRIVATE-SIDECAR-CONTENTS\n");
        const manifest = readFileSync(join(fixture.runDir, "run.json"));
        const sentinel = `SENTINEL-${method}`;
        await assert.rejects(transitionRunBaseAdvance(fixture.runDir, {
          baseAdvanceDurableFileSystem: {
            [method]() { throw new Error(`${sentinel} ${fixture.runDir}/private PRIVATE-SIDECAR-CONTENTS\n    at private-stack`); },
          },
        }), (error) => {
          assert.equal(error.code, "BASE_ADVANCE_RUN_INVALID");
          assertTerminalSafe(error, sentinel, fixture);
          return true;
        });
        assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), manifest);
        assert.equal(output(fixture.worktree, ["rev-parse", "HEAD"]), fixture.base);
      } finally {
        fixture.cleanup();
      }
    }

    const gitFailure = createBaseAdvanceTransitionFixture("git-diagnostic");
    try {
      gitFailure.advance();
      const sentinel = "SENTINEL-GIT-STDERR";
      await assert.rejects(transitionRunBaseAdvance(gitFailure.runDir, {
        gitOptions: selectiveGitFailure(() => true, ["worktree", "list", "--porcelain"], sentinel, gitFailure),
      }), (error) => {
        assert.equal(error.code, "BASE_ADVANCE_GIT_STATE_INVALID");
        assertTerminalSafe(error, sentinel, gitFailure);
        return true;
      });
      assert.equal(gitFailure.readRun().base_commit, gitFailure.base);
      assert.equal(output(gitFailure.worktree, ["rev-parse", "HEAD"]), gitFailure.base);
    } finally {
      gitFailure.cleanup();
    }

    const changed = createBaseAdvanceTransitionFixture("pre-publication-change");
    try {
      const target = changed.advance();
      const sidecar = join(changed.runDir, "settled.log");
      writeFileSync(sidecar, "before\n");
      await assert.rejects(transitionRunBaseAdvance(changed.runDir, {
        baseAdvanceHooks: { beforeBind: () => writeFileSync(sidecar, "after\n") },
      }), (error) => error.code === "BASE_ADVANCE_INELIGIBLE");
      assert.equal(changed.readRun().base_commit, changed.base);
      assert.equal(output(changed.worktree, ["rev-parse", "HEAD"]), target);
    } finally {
      changed.cleanup();
    }
  });

  it("maps every final post-publication read, snapshot, Git, origin, and mismatch failure to publish-failed", async () => {
    const cases = [
      ["snapshot", (fixture) => {
        let fail = false;
        return {
          baseAdvanceHooks: { beforeFinalVerification: () => { fail = true; } },
          baseAdvanceDurableFileSystem: {
            readdirSync(path) {
              if (fail) throw new Error(`SENTINEL-snapshot ${fixture.runDir}/private PRIVATE-SIDECAR-CONTENTS\n    at private-stack`);
              return readdirSync(path);
            },
          },
        };
      }],
      ["read", (fixture) => ({
        baseAdvanceHooks: { beforeFinalVerification: () => writeFileSync(join(fixture.runDir, "run.json"), "PRIVATE-SIDECAR-CONTENTS {") },
      })],
      ["git", (fixture) => {
        let fail = false;
        return {
          baseAdvanceHooks: { beforeFinalVerification: () => { fail = true; } },
          gitOptions: selectiveGitFailure(() => fail, ["worktree", "list", "--porcelain"], "SENTINEL-git", fixture),
        };
      }],
      ["origin", (fixture) => {
        let fail = false;
        return {
          baseAdvanceHooks: { beforeFinalVerification: () => { fail = true; } },
          gitOptions: selectiveGitFailure(() => fail, ["ls-remote", "--exit-code", "--refs", "origin", "refs/heads/main"], "SENTINEL-origin", fixture),
        };
      }],
      ["mismatch", (fixture) => ({
        baseAdvanceHooks: {
          beforeFinalVerification: () => fixture.writeRun({ ...fixture.readRun(), heartbeat_at: LATER }),
        },
      })],
    ];
    for (const [name, options] of cases) {
      const fixture = createBaseAdvanceTransitionFixture(`post-publication-${name}`);
      try {
        fixture.advance();
        await assert.rejects(transitionRunBaseAdvance(fixture.runDir, { now: LATER, ...options(fixture) }), (error) => {
          assert.equal(error.code, "BASE_ADVANCE_PUBLISH_FAILED", name);
          assert.equal(error.message, "final base publication verification failed", name);
          assertTerminalSafe(error, `SENTINEL-${name}`, fixture);
          return true;
        });
      } finally {
        fixture.cleanup();
      }
    }
  });

  it("holds run lock before launch fence and releases launch fence before run lock", async () => {
    const fixture = createBaseAdvanceTransitionFixture("lock-order");
    try {
      fixture.advance();
      const events = [];
      await transitionRunBaseAdvance(fixture.runDir, {
        baseAdvanceHooks: {
          afterLaunchFenceAcquired({ fence }) {
            events.push(["acquired", existsSync(join(fixture.runDir, "run-json.lock")), existsSync(fence.path)]);
          },
          afterLaunchFenceReleased() {
            events.push(["released", existsSync(join(fixture.runDir, "run-json.lock"))]);
          },
        },
      });
      assert.deepEqual(events, [["acquired", true, true], ["released", true]]);
      assert.equal(existsSync(join(fixture.runDir, "run-json.lock")), false);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps generic base_commit mutation forbidden", async () => {
    const fixture = createBaseAdvanceTransitionFixture("generic-immutable");
    try {
      const target = fixture.advance();
      await assert.rejects(transitionRunJson(fixture.runDir, (run) => { run.base_commit = target; }, {
        expectedCurrentHash: hashValue(fixture.readRun()),
      }), /run identity field 'base_commit' is immutable/u);
      assert.equal(fixture.readRun().base_commit, fixture.base);
    } finally {
      fixture.cleanup();
    }
  });
});

function success(run, target, disposition, updated, replayed) {
  return {
    ok: true,
    operation: "active-run-base-advance",
    run_id: run.run_id,
    disposition,
    updated,
    replayed,
    base_ref: run.base_ref,
    previous_base_commit: run.base_commit,
    base_commit: target,
    branch: run.branch,
    worktree: run.worktree,
  };
}

function omitMutable(run) {
  const copy = structuredClone(run);
  delete copy.base_commit;
  delete copy.updated_at;
  return copy;
}

function causalMessages(error) {
  const messages = [];
  for (let current = error; current; current = current.cause) messages.push(current.message);
  return messages;
}

function writeHeartbeat(fixture, lastTickAt) {
  writeJson(join(fixture.runDir, "heartbeat.json"), {
    schema_version: 1, run_id: fixture.runId, phase: "running", pid: 4242, interval_ms: 30_000, last_tick_at: lastTickAt,
  });
}

function selectiveGitFailure(active, expectedArgs, sentinel, fixture) {
  return {
    spawnSync(file, args, options) {
      if (active() && args.length === expectedArgs.length && args.every((arg, index) => arg === expectedArgs[index])) {
        return {
          status: 2,
          stdout: "",
          stderr: `${sentinel} ${fixture.runDir}/private PRIVATE-SIDECAR-CONTENTS\n    at private-stack`,
        };
      }
      return spawnSync(file, args, options);
    },
  };
}

function assertTerminalSafe(error, sentinel, fixture) {
  const outward = JSON.stringify({ code: error.code, message: error.message });
  assert.equal(outward.includes(sentinel), false);
  assert.equal(outward.includes(fixture.root), false);
  assert.equal(outward.includes("PRIVATE-SIDECAR-CONTENTS"), false);
  assert.equal(outward.includes("private-stack"), false);
}
