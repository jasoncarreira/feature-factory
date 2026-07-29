import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { advanceFactoryRunBase, resumeFactory as resumeFactoryImpl } from "../src/factory.js";
import { acquireLaunchClaim } from "../src/process-evidence.js";
import { transitionRunBaseAdvance } from "../src/run-state.js";
import { createBaseAdvanceTransitionFixture } from "./helpers/base-advance-transition/fixture.js";
import { spawnSync } from "./helpers/git-fixture.js";
import { withTestRuntimeAdmission } from "./helpers/runtime-admission.js";

const resumeFactory = (runId, options) => resumeFactoryImpl(runId, withTestRuntimeAdmission(options));

describe("base advancement selected-run and issue-69 isolation", () => {
  it("mutates only the selected fixture while preserving the real issue-69 run, refs, and worktrees byte-for-byte", async () => {
    const externalBefore = observeRealIssue69();
    const selected = createBaseAdvanceTransitionFixture("selected-run");
    const unselected = createBaseAdvanceTransitionFixture("unselected-run");
    try {
      const target = selected.advance();
      unselected.advance();
      const unselectedBefore = observeFixture(unselected);

      const result = await advanceFactoryRunBase(selected.runId, { cwd: selected.repo });

      assert.equal(result.run_id, selected.runId);
      assert.equal(result.base_commit, target);
      assert.deepEqual(observeFixture(unselected), unselectedBefore);
      assert.deepEqual(observeRealIssue69(), externalBefore);
    } finally {
      selected.cleanup();
      unselected.cleanup();
    }
  });

  it("lets base advancement own the launch fence before normal resume without any launch claim or callback", async () => {
    const externalBefore = observeRealIssue69();
    const fixture = createBaseAdvanceTransitionFixture("advance-first-race");
    try {
      const target = fixture.advance();
      const beforeRun = fixture.readRun();
      let resume;
      let launchClaimAttempts = 0;
      let successfulLaunchClaims = 0;
      let claimCallbacks = 0;
      let launches = 0;
      const advanced = await transitionRunBaseAdvance(fixture.runDir, {
        repoRoot: fixture.repo,
        baseAdvanceHooks: {
          afterLaunchFenceAcquired: async () => {
            resume = await resumeFactory(fixture.runId, {
              cwd: fixture.repo,
              acquireLaunchClaimFn(...args) {
                launchClaimAttempts += 1;
                const result = acquireLaunchClaim(...args);
                if (result.acquired) successfulLaunchClaims += 1;
                return result;
              },
              launchHooks: { afterClaimAcquired: () => { claimCallbacks += 1; } },
              foregroundLaunchFn: async () => { launches += 1; return { status: "launched" }; },
            });
          },
        },
      });
      const afterRun = fixture.readRun();
      assert.equal(advanced.base_commit, target);
      assert.equal(advanced.disposition, "advanced");
      assert.equal(resume.status, "recovery-required");
      assert.equal(resume.reason_code, "launch-claim-invalid");
      assert.equal(launchClaimAttempts, 1);
      assert.equal(successfulLaunchClaims, 0);
      assert.equal(claimCallbacks, 0);
      assert.equal(launches, 0);
      assert.deepEqual(changedTopLevelKeys(beforeRun, afterRun), ["base_commit", "updated_at"]);
      assert.equal(afterRun.base_commit, target);
      assert.equal(gitOutput(fixture.worktree, ["rev-parse", "HEAD"]), target);
      assert.deepEqual(observeRealIssue69(), externalBefore);
    } finally {
      fixture.cleanup();
    }
  });

  it("lets normal resume own the launch fence and rejects base advancement before mutation while launching exactly once", async () => {
    const externalBefore = observeRealIssue69();
    const fixture = createBaseAdvanceTransitionFixture("resume-first-race");
    try {
      fixture.advance();
      const before = observeFixture(fixture);
      const manifest = readFileSync(join(fixture.runDir, "run.json"));
      let advanceError;
      let launchClaimAttempts = 0;
      let successfulLaunchClaims = 0;
      let claimCallbacks = 0;
      let launches = 0;
      const resumed = await resumeFactory(fixture.runId, {
        cwd: fixture.repo,
        acquireLaunchClaimFn(...args) {
          launchClaimAttempts += 1;
          const result = acquireLaunchClaim(...args);
          if (result.acquired) successfulLaunchClaims += 1;
          return result;
        },
        launchHooks: {
          afterClaimAcquired: async () => {
            claimCallbacks += 1;
            try {
              await transitionRunBaseAdvance(fixture.runDir, { repoRoot: fixture.repo });
            } catch (error) {
              advanceError = error;
            }
          },
        },
        foregroundLaunchFn: async () => {
          launches += 1;
          return { status: "launched", launched: true };
        },
      });
      assert.deepEqual(resumed, { status: "launched", launched: true });
      assert.equal(advanceError?.code, "BASE_ADVANCE_LOCK_CONTENDED");
      assert.equal(advanceError?.message, "base advancement rejected launch_claim:live");
      assert.equal(launchClaimAttempts, 1);
      assert.equal(successfulLaunchClaims, 1);
      assert.equal(claimCallbacks, 1);
      assert.equal(launches, 1);
      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), manifest);
      assert.deepEqual(observeFixture(fixture), before);
      assert.deepEqual(observeRealIssue69(), externalBefore);
    } finally {
      fixture.cleanup();
    }
  });
});

function observeFixture(fixture) {
  return {
    manifest: hash(readFileSync(join(fixture.runDir, "run.json"))),
    branch: gitOutput(fixture.repo, ["rev-parse", `refs/heads/${fixture.runId}`]),
    head: gitOutput(fixture.worktree, ["rev-parse", "HEAD"]),
    status: gitOutput(fixture.worktree, ["status", "--porcelain=v1", "--untracked-files=all"]),
  };
}

function observeRealIssue69() {
  const common = gitOutput(process.cwd(), ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const repository = dirname(common);
  const runDir = join(repository, ".opencode", "factory", "issue-69");
  const worktrees = registeredWorktrees(repository);
  return {
    run_files: existsSync(runDir) ? snapshotFiles(runDir) : null,
    refs: {
      "refs/heads/issue-69": optionalGitOutput(repository, ["rev-parse", "--verify", "refs/heads/issue-69"]),
      "refs/heads/issue-69--ss-protocol-state-model": optionalGitOutput(repository, ["rev-parse", "--verify", "refs/heads/issue-69--ss-protocol-state-model"]),
      "refs/heads/issue-69-narrow-base": optionalGitOutput(repository, ["rev-parse", "--verify", "refs/heads/issue-69-narrow-base"]),
    },
    worktrees: {
      "issue-69": observeRegisteredWorktree(worktrees, join(repository, ".opencode", "worktrees", "issue-69")),
      "issue-69--ss-protocol-state-model": observeRegisteredWorktree(worktrees, join(repository, ".opencode", "worktrees", "issue-69--ss-protocol-state-model")),
    },
  };
}

function registeredWorktrees(repository) {
  const result = gitProbe(repository, ["worktree", "list", "--porcelain", "-z"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const worktrees = [];
  let current = null;
  for (const field of result.stdout.split("\0")) {
    if (!field) continue;
    const separator = field.indexOf(" ");
    const key = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? true : field.slice(separator + 1);
    if (key === "worktree") {
      if (current) worktrees.push(current);
      current = { worktree: value };
    } else {
      assert.ok(current, `git worktree field ${key} must follow a worktree path`);
      current[key] = value;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function observeRegisteredWorktree(worktrees, expectedPath) {
  const registered = worktrees.find((entry) => resolve(entry.worktree) === resolve(expectedPath));
  if (!registered) return null;
  return {
    registered_path: registered.worktree,
    registered_branch: registered.branch ?? null,
    registered_head: registered.HEAD ?? null,
    status: optionalGitOutput(registered.worktree, ["status", "--porcelain=v1", "--untracked-files=all"]),
  };
}

function snapshotFiles(root) {
  const result = {};
  visit(root);
  return result;

  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const entry = lstatSync(path);
      const key = relative(root, path);
      if (entry.isSymbolicLink()) result[key] = `symlink:${readlinkSync(path)}`;
      else if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result[key] = hash(readFileSync(path));
      else result[key] = `other:${entry.mode}`;
    }
  }
}

function gitOutput(cwd, args) {
  const result = gitProbe(cwd, args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function optionalGitOutput(cwd, args) {
  if (!existsSync(resolve(cwd))) return null;
  const result = gitProbe(cwd, args);
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitProbe(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
}

function gitEnv() {
  return { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function changedTopLevelKeys(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort();
}
