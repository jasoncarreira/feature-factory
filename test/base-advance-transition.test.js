import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { hashValue } from "../src/refs.js";
import { transitionRunBaseAdvance, transitionRunJson } from "../src/run-state.js";
import { createBaseAdvanceTransitionFixture, git, output } from "./helpers/base-advance-transition/fixture.js";

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

  it("preserves representative sidecars, candidate refs, commits, worktree files, and manifest history", async () => {
    const fixture = createBaseAdvanceTransitionFixture("preserve");
    try {
      const target = fixture.advance();
      const candidate = `${fixture.runId}-candidate`;
      const candidateWorktree = join(fixture.repo, ".opencode", "worktrees", candidate);
      git(fixture.repo, ["worktree", "add", "-b", candidate, candidateWorktree, fixture.base]);
      writeFileSync(join(candidateWorktree, "candidate.txt"), "candidate bytes\n");
      const candidateStatus = output(candidateWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
      const candidateHead = output(fixture.repo, ["rev-parse", `refs/heads/${candidate}`]);
      mkdirSync(join(fixture.runDir, "artifacts"));
      writeFileSync(join(fixture.runDir, "artifacts", "story.md"), "accepted story\n");
      const beforeRun = fixture.readRun();
      const sidecar = readFileSync(join(fixture.runDir, "artifacts", "story.md"));
      const result = await transitionRunBaseAdvance(fixture.runDir, { now: LATER });
      assert.equal(result.base_commit, target);
      assert.deepEqual(readFileSync(join(fixture.runDir, "artifacts", "story.md")), sidecar);
      assert.equal(output(fixture.repo, ["rev-parse", `refs/heads/${candidate}`]), candidateHead);
      assert.equal(output(candidateWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]), candidateStatus);
      assert.equal(readFileSync(join(candidateWorktree, "candidate.txt"), "utf8"), "candidate bytes\n");
      assert.deepEqual(omitMutable(fixture.readRun()), omitMutable(beforeRun));
    } finally {
      fixture.cleanup();
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
