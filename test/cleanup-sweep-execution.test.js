import assert from "node:assert/strict";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { executeCleanupSweep, previewCleanupSweep } from "../src/cleanup-sweep.js";
import { acquireLaunchClaim } from "../src/process-evidence.js";
import { RunJsonLockContendedError } from "../src/run-state.js";
import { createCleanupSweepFixture } from "./helpers/cleanup-sweep-fixture.js";
import { runFixtureGit } from "./helpers/git-fixture.js";

const INVOCATION = "execution-test";

describe("cleanup sweep execution R23 and R43-R55", () => {
  it("builds physical repository identity and a repository-bound preview without mutating targets", async () => {
    const fixture = createCleanupSweepFixture("execution-identity");
    try {
      fixture.addRun("run", { branch: null });
      const before = readFileSync(join(fixture.factoryRoot, "run", "run.json"), "utf8");
      const report = await preview(fixture);
      assert.equal(report.status, "previewed");
      assert.equal(report.repository.root_path, realpathSync(fixture.repo));
      assert.equal(report.repository.git_common_dir_path, realpathSync(join(fixture.repo, ".git")));
      for (const key of ["root_device", "root_inode", "git_common_dir_device", "git_common_dir_inode"]) assert.match(report.repository[key], /^\d+$/u);
      assert.equal(report.repository.object_format, "sha1");
      assert.equal(readFileSync(join(fixture.factoryRoot, "run", "run.json"), "utf8"), before);
      assert.equal(report.candidates[0].classification, "eligible");
      assert.deepEqual(report.candidates[0].evidence.worktree_root, {
        state: "valid",
        logical_path: join(report.repository.root_path, ".opencode", "worktrees"),
        physical_path: realpathSync(fixture.worktreeRoot),
        device: String(lstatSync(fixture.worktreeRoot).dev),
        inode: String(lstatSync(fixture.worktreeRoot).ino),
      });
      assert.equal(report.authorization.digest, report.confirmation.argv[5]);
      assert.equal(listInvocationRefs(fixture).length, 0);
    } finally { fixture.cleanup(); }
  });

  it("R43 refuses foreign and stale digests before candidate locks", async () => {
    const fixture = createCleanupSweepFixture("execution-refusal");
    try {
      fixture.addRun("run", { branch: null });
      const initial = await preview(fixture);
      let locks = 0;
      const parts = initial.authorization.digest.split(".");
      parts[1] = parts[1] === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
      const foreign = parts.join(".");
      const foreignReport = await execute(fixture, foreign, { acquireRunLock() { locks += 1; } });
      assert.equal(foreignReport.authorization.refusal_code, "DIGEST_FOREIGN");
      assert.equal(foreignReport.exit_code, 1);
      assert.equal(listInvocationRefs(fixture).length, 0);
      writeFileSync(join(fixture.factoryRoot, "unsafe-entry"), "unsafe\n");
      const staleReport = await execute(fixture, initial.authorization.digest, { acquireRunLock() { locks += 1; } });
      assert.equal(staleReport.authorization.refusal_code, "DIGEST_STALE");
      assert.equal(locks, 0);
      assert.equal(listInvocationRefs(fixture).length, 0);
    } finally { fixture.cleanup(); }
  });

  it("R23 maps one-shot no-reclaim contention directly without owner inspection", async () => {
    const fixture = createCleanupSweepFixture("execution-contention");
    try {
      fixture.addRun("run", { branch: null });
      const authorization = await preview(fixture);
      const calls = [];
      const report = await execute(fixture, authorization.authorization.digest, {
        acquireRunLock(runDir, _callback, lockOptions) {
          calls.push([runDir, lockOptions]);
          throw new RunJsonLockContendedError(join(runDir, "run-json.lock"));
        },
      });
      assert.equal(report.candidates[0].classification, "skipped");
      assert.deepEqual(report.candidates[0].reason_codes, ["SKIPPED_RUN_LOCK_CONTENDED"]);
      assert.deepEqual(calls[0][1], { reclaimMode: "never" });
      assert.equal(report.exit_code, 0);
      assert.equal(listInvocationRefs(fixture).length, 0);
    } finally { fixture.cleanup(); }
  });

  it("R44 recomputes complete authorization after the revalidation hook and skips positive changes", async () => {
    const fixture = createCleanupSweepFixture("execution-revalidation-change");
    try {
      fixture.addRun("run", { branch: null });
      const authorization = await preview(fixture);
      const report = await execute(fixture, authorization.authorization.digest, {
        phaseHook(name) {
          if (name !== "after-candidate-revalidation") return;
          const run = fixture.readRun("run");
          run.status = "running";
          delete run.terminal_result;
          fixture.writeRun("run", run);
        },
      });
      assert.deepEqual(report.candidates[0].reason_codes, ["SKIPPED_CHANGED_DURING_EXECUTION"]);
      assert.equal(report.candidates[0].attempted_cleanup, false);
      assert.equal(existsSync(join(fixture.factoryRoot, "run")), true);
    } finally { fixture.cleanup(); }
  });

  it("refuses authorization changes injected after digest recompute or candidate lock", async () => {
    for (const hook of ["after-digest-recompute", "after-candidate-lock"]) {
      const fixture = createCleanupSweepFixture(`execution-mutation-${hook}`);
      try {
        fixture.addRun("run", { branch: null });
        const authorization = await preview(fixture);
        let mutated = false;
        const report = await execute(fixture, authorization.authorization.digest, {
          phaseHook(name) {
            if (name !== hook || mutated) return;
            mutated = true;
            const run = fixture.readRun("run");
            run.status = "running";
            delete run.terminal_result;
            fixture.writeRun("run", run);
          },
        });
        assert.deepEqual(report.candidates[0].reason_codes, ["SKIPPED_CHANGED_DURING_EXECUTION"], hook);
        assert.equal(report.candidates[0].attempted_cleanup, false, hook);
        assert.equal(existsSync(join(fixture.factoryRoot, "run")), true, hook);
      } finally { fixture.cleanup(); }
    }
  });

  it("fails closed when a launch claim appears after preview or lock-held revalidation", async () => {
    for (const hook of ["after-digest-recompute", "after-candidate-lock", "after-candidate-revalidation"]) {
      const fixture = createCleanupSweepFixture(`execution-launch-claim-${hook}`);
      try {
        fixture.addRun("run", { branch: null });
        const authorization = await preview(fixture);
        let created = false;
        const report = await execute(fixture, authorization.authorization.digest, {
          phaseHook(name) {
            if (name !== hook || created) return;
            created = true;
            const claimDir = join(fixture.factoryRoot, "run", "process-launch.lock");
            mkdirSync(claimDir);
            writeFileSync(join(claimDir, "owner.json"), "{}\n", "utf8");
          },
        });
        assert.deepEqual(report.candidates[0].reason_codes, ["SKIPPED_CHANGED_DURING_EXECUTION"], hook);
        assert.equal(report.candidates[0].attempted_cleanup, false, hook);
        assert.equal(existsSync(join(fixture.factoryRoot, "run", "process-launch.lock", "owner.json")), true, hook);
      } finally { fixture.cleanup(); }
    }
  });

  it("requires the final temporary ref to resolve to the authorized base OID", async () => {
    const fixture = createCleanupSweepFixture("execution-base-race");
    try {
      fixture.addRun("run");
      const authorization = await preview(fixture);
      const changedCommit = gitOutput(fixture.repo, ["commit-tree", `${fixture.baseSha}^{tree}`, "-p", fixture.baseSha, "-m", "changed base"]);
      let fetches = 0;
      const gitRunner = fallbackRunner((cwd, args) => {
        if (args[0] !== "fetch") return null;
        fetches += 1;
        const result = fixture.gitRunner(cwd, args);
        if (fetches === 3) fixture.gitRunner(cwd, ["update-ref", args.at(-1).split(":").at(-1), changedCommit]);
        return result;
      }, fixture.gitRunner);
      const report = await execute(fixture, authorization.authorization.digest, { gitRunner });
      assert.deepEqual(report.candidates[0].reason_codes, ["SKIPPED_CHANGED_DURING_EXECUTION"]);
      assert.equal(existsSync(join(fixture.factoryRoot, "run")), true);
    } finally { fixture.cleanup(); }
  });

  it("fails closed when the PR reopens at any final mutation boundary", async () => {
    for (const boundary of ["after-worktree-final-validation", "after-branch-final-validation", "after-run-dir-final-validation"]) {
      const fixture = createCleanupSweepFixture(`execution-pr-reopened-${boundary}`);
      try {
        fixture.addRun("run");
        if (boundary === "after-worktree-final-validation") fixture.addRecordedWorktree("run");
        const authorization = await preview(fixture);
        let reopened = false;
        const githubRunner = (...args) => {
          const result = fixture.githubRunner(...args);
          if (!reopened) return result;
          const body = JSON.parse(result.stdout);
          return { ...result, stdout: JSON.stringify({ ...body, state: "open", merged: false }) };
        };
        const report = await execute(fixture, authorization.authorization.digest, {
          githubRunner,
          phaseHook(name) { if (name === boundary) reopened = true; },
        });

        assert.notEqual(report.candidates[0].classification, "deleted", boundary);
        assert.equal(existsSync(join(fixture.factoryRoot, "run")), true, boundary);
        assert.equal(branchExists(fixture.repo, "run"), boundary !== "after-run-dir-final-validation", boundary);
      } finally { fixture.cleanup(); }
    }
  });

  it("fails closed when the canonical base head moves at any final mutation boundary", async () => {
    for (const boundary of ["after-worktree-final-validation", "after-branch-final-validation", "after-run-dir-final-validation"]) {
      const fixture = createCleanupSweepFixture(`execution-base-moved-${boundary}`);
      try {
        fixture.addRun("run");
        if (boundary === "after-worktree-final-validation") fixture.addRecordedWorktree("run");
        const authorization = await preview(fixture);
        const changedBase = gitOutput(fixture.repo, ["commit-tree", `${fixture.baseSha}^{tree}`, "-p", fixture.baseSha, "-m", "changed base"]);
        let moved = false;
        const gitRunner = fallbackRunner((_cwd, args) => args[0] === "ls-remote" && moved
          ? { ok: true, status: 0, stdout: `${changedBase}\trefs/heads/main\n`, stderr: "" }
          : null, fixture.gitRunner);
        const report = await execute(fixture, authorization.authorization.digest, {
          gitRunner,
          phaseHook(name) { if (name === boundary) moved = true; },
        });

        assert.notEqual(report.candidates[0].classification, "deleted", boundary);
        assert.equal(existsSync(join(fixture.factoryRoot, "run")), true, boundary);
        assert.equal(branchExists(fixture.repo, "run"), boundary !== "after-run-dir-final-validation", boundary);
      } finally { fixture.cleanup(); }
    }
  });

  it("restores a quarantined worktree when remote authorization changes before removal", async () => {
    for (const change of ["pr", "base"]) {
      const fixture = createCleanupSweepFixture(`execution-worktree-quarantine-${change}`);
      try {
        fixture.addRun("run");
        const worktree = fixture.addRecordedWorktree("run");
        const authorization = await preview(fixture);
        const changedBase = gitOutput(fixture.repo, ["commit-tree", `${fixture.baseSha}^{tree}`, "-p", fixture.baseSha, "-m", "changed base"]);
        let changed = false;
        const githubRunner = (...args) => {
          const result = fixture.githubRunner(...args);
          if (!changed || change !== "pr") return result;
          const body = JSON.parse(result.stdout);
          return { ...result, stdout: JSON.stringify({ ...body, state: "open", merged: false }) };
        };
        const gitRunner = (cwd, args, options) => {
          if (args[0] === "ls-remote" && changed && change === "base") {
            return { ok: true, status: 0, stdout: `${changedBase}\trefs/heads/main\n`, stderr: "" };
          }
          const result = fixture.gitRunner(cwd, args, options);
          if (args[0] === "worktree" && args[1] === "move" && result.ok) changed = true;
          return result;
        };

        const report = await execute(fixture, authorization.authorization.digest, { githubRunner, gitRunner });

        assert.notEqual(report.candidates[0].classification, "deleted", change);
        assert.equal(existsSync(worktree), true, change);
        assert.equal(existsSync(join(fixture.factoryRoot, "run")), true, change);
        assert.equal(branchExists(fixture.repo, "run"), true, change);
      } finally { fixture.cleanup(); }
    }
  });

  it("R45/R48 delegates exact expected evidence and deletes branches by CAS in canonical order", async () => {
    const fixture = createCleanupSweepFixture("execution-success");
    try {
      fixture.addRun("z");
      fixture.addRun("a");
      const authorization = await preview(fixture);
      const operations = [];
      const phases = [];
      const gitRunner = (cwd, args) => {
        if (args[0] === "update-ref" && args[1] === "-d" && args[2].startsWith("refs/heads/")) operations.push([...args]);
        return fixture.gitRunner(cwd, args);
      };
      const report = await execute(fixture, authorization.authorization.digest, { gitRunner, phaseHook: (name) => phases.push(name) });
      assert.deepEqual(report.candidates.map(({ entry_name, classification }) => [entry_name, classification]), [["a", "deleted"], ["z", "deleted"]]);
      assert.deepEqual(operations.map((args) => args[2]), ["refs/heads/a", "refs/heads/z"]);
      assert.equal(operations.every((args) => args.length === 4 && /^[0-9a-f]{40}$/u.test(args[3])), true);
      for (const hook of ["after-digest-recompute", "after-candidate-lock", "after-candidate-revalidation", "before-branch-delete", "before-run-dir-remove", "before-temp-ref-delete"]) assert.equal(phases.includes(hook), true, hook);
      assert.equal(report.exit_code, 0);
    } finally { fixture.cleanup(); }
  });

  it("maps a pre-first-mutation worktree change to an ordinary changed-during-execution skip", async () => {
    const fixture = createCleanupSweepFixture("execution-worktree-failure");
    try {
      fixture.addRun("run");
      fixture.addRecordedWorktree("run");
      const authorization = await preview(fixture);
      const phases = [];
      const report = await execute(fixture, authorization.authorization.digest, {
        phaseHook(name, context) {
          phases.push(name);
          if (name === "before-worktree-remove") rmSync(context.physical_path, { recursive: true, force: true });
        },
      });
      const candidate = report.candidates[0];
      assert.equal(candidate.classification, "skipped");
      assert.deepEqual(candidate.reason_codes, ["SKIPPED_CHANGED_DURING_EXECUTION"]);
      assert.equal(candidate.attempted_cleanup, false);
      assert.equal(candidate.cleanup, null);
      assert.equal(phases.includes("before-worktree-remove"), true);
      assert.equal(report.attempted_cleanup_failures, 0);
      assert.equal(report.exit_code, 0);
    } finally { fixture.cleanup(); }
  });

  it("maps a pre-first-mutation branch change to an ordinary changed-during-execution skip", async () => {
    const fixture = createCleanupSweepFixture("execution-before-branch-delete");
    try {
      fixture.addRun("run");
      const authorization = await preview(fixture);
      const changedCommit = gitOutput(fixture.repo, ["commit-tree", `${fixture.baseSha}^{tree}`, "-p", fixture.baseSha, "-m", "branch changed"]);
      const report = await execute(fixture, authorization.authorization.digest, {
        phaseHook(name, context) {
          if (name === "before-branch-delete") fixture.gitRunner(fixture.repo, ["update-ref", `refs/heads/${context.branch}`, changedCommit, context.expected_head]);
        },
      });
      assert.deepEqual(report.candidates[0].reason_codes, ["SKIPPED_CHANGED_DURING_EXECUTION"]);
      assert.equal(report.candidates[0].attempted_cleanup, false);
      assert.equal(report.candidates[0].cleanup, null);
      assert.equal(report.attempted_cleanup_failures, 0);
      assert.equal(report.exit_code, 0);
      assert.equal(existsSync(join(fixture.factoryRoot, "run")), true);
    } finally { fixture.cleanup(); }
  });

  it("keeps post-mutation branch evidence changes as attempted cleanup failures", async () => {
    const fixture = createCleanupSweepFixture("execution-post-mutation-branch-change");
    try {
      fixture.addRun("run");
      fixture.addRecordedWorktree("run");
      const authorization = await preview(fixture);
      const changedCommit = gitOutput(fixture.repo, ["commit-tree", `${fixture.baseSha}^{tree}`, "-p", fixture.baseSha, "-m", "branch changed after worktree removal"]);
      const report = await execute(fixture, authorization.authorization.digest, {
        phaseHook(name, context) {
          if (name === "before-branch-delete") fixture.gitRunner(fixture.repo, ["update-ref", `refs/heads/${context.branch}`, changedCommit, context.expected_head]);
        },
      });
      const candidate = report.candidates[0];
      assert.equal(candidate.classification, "failed");
      assert.equal(candidate.attempted_cleanup, true);
      assert.deepEqual(candidate.reason_codes, ["FAILED_CLEANUP_BRANCH", "RETAINED_AFTER_PARTIAL_FAILURE"]);
      assert.equal(candidate.cleanup.worktrees[0].outcome, "removed");
      assert.equal(candidate.cleanup.branches[0].outcome, "failed");
      assert.equal(report.attempted_cleanup_failures, 1);
      assert.equal(report.exit_code, 1);
    } finally { fixture.cleanup(); }
  });

  it("R47/R50/R53 continues independent branches and candidates after CAS failure", async () => {
    const fixture = createCleanupSweepFixture("execution-branch-continuation");
    try {
      fixture.addRun("a");
      fixture.addRun("b");
      const authorization = await preview(fixture);
      const gitRunner = fallbackRunner((_cwd, args) => args[0] === "update-ref" && args[1] === "-d" && args[2] === "refs/heads/a"
        ? commandFailure()
        : null, fixture.gitRunner);
      const report = await execute(fixture, authorization.authorization.digest, { gitRunner });
      assert.deepEqual(report.candidates.map((item) => item.classification), ["failed", "deleted"]);
      assert.deepEqual(report.candidates[0].reason_codes, ["FAILED_CLEANUP_BRANCH", "RETAINED_AFTER_PARTIAL_FAILURE"]);
      assert.equal(existsSync(join(fixture.factoryRoot, "a")), true);
      assert.equal(existsSync(join(fixture.factoryRoot, "b")), false);
      assert.equal(report.attempted_cleanup_failures, 1);
    } finally { fixture.cleanup(); }
  });

  it("R49 maps run-directory removal failure through the injected mutation seam", async () => {
    const fixture = createCleanupSweepFixture("execution-run-dir-failure");
    try {
      fixture.addRun("run", { branch: null });
      const authorization = await preview(fixture);
      const report = await execute(fixture, authorization.authorization.digest, { removeRunDir() { throw new Error("injected"); } });
      assert.deepEqual(report.candidates[0].reason_codes, ["FAILED_CLEANUP_RUN_DIR"]);
      assert.equal(report.candidates[0].cleanup.run_dir.outcome, "failed");
      assert.equal(report.exit_code, 1);
    } finally { fixture.cleanup(); }
  });

  it("maps a pre-first-mutation run-directory evidence change to an ordinary skip with exact exit accounting", async () => {
    const fixture = createCleanupSweepFixture("execution-run-dir-change");
    try {
      fixture.addRun("run", { branch: null });
      const authorization = await preview(fixture);
      let removals = 0;
      const report = await execute(fixture, authorization.authorization.digest, {
        phaseHook(name) {
          if (name !== "before-run-dir-remove") return;
          const run = fixture.readRun("run");
          run.changed_after_authorization = true;
          fixture.writeRun("run", run);
        },
        removeRunDir() { removals += 1; },
      });
      assert.deepEqual(report.candidates[0].reason_codes, ["SKIPPED_CHANGED_DURING_EXECUTION"]);
      assert.equal(report.candidates[0].attempted_cleanup, false);
      assert.equal(report.candidates[0].cleanup, null);
      assert.equal(report.attempted_cleanup_failures, 0);
      assert.equal(report.exit_code, 0);
      assert.equal(removals, 0);
      assert.equal(existsSync(join(fixture.factoryRoot, "run")), true);
    } finally { fixture.cleanup(); }
  });

  it("binds every activity sidecar through the first mutation", async () => {
    for (const sidecar of ["factory.lock", "heartbeat.json", "process.json", "process-launch.lock/owner.json"]) {
      const fixture = createCleanupSweepFixture(`execution-sidecar-${sidecar.replaceAll(/[^A-Za-z0-9_-]/gu, "-")}`);
      try {
        fixture.addRun("run", { branch: null });
        const authorization = await preview(fixture);
        const report = await execute(fixture, authorization.authorization.digest, {
          phaseHook(name) {
            if (name === "after-run-dir-final-validation") {
              const path = join(fixture.factoryRoot, "run", sidecar);
              if (sidecar.includes("/")) mkdirSync(join(fixture.factoryRoot, "run", "process-launch.lock"));
              writeFileSync(path, "{}\n", "utf8");
            }
          },
        });
        assert.deepEqual(report.candidates[0].reason_codes, ["SKIPPED_CHANGED_DURING_EXECUTION"], sidecar);
        assert.equal(report.candidates[0].attempted_cleanup, false, sidecar);
        assert.equal(existsSync(join(fixture.factoryRoot, "run")), true, sidecar);
      } finally { fixture.cleanup(); }
    }
  });

  it("holds the launch fence continuously across every destructive mutation", async () => {
    const fixture = createCleanupSweepFixture("execution-launch-fence");
    const aliasRepo = `${fixture.repo}-alias`;
    try {
      const { runDir } = fixture.addRun("run");
      symlinkSync(fixture.repo, aliasRepo, "dir");
      const aliasRunDir = join(aliasRepo, ".opencode", "factory", "run");
      fixture.addRecordedWorktree("run");
      const authorization = await preview(fixture);
      const attempts = [];
      const report = await execute(fixture, authorization.authorization.digest, {
        phaseHook(name) {
          if (!["after-worktree-final-validation", "after-branch-final-validation", "after-run-dir-final-validation"].includes(name)) return;
          const result = acquireLaunchClaim(aliasRunDir, {
            runId: "run",
            executionId: `race-${name}`,
            launchKind: "resume-foreground",
            pid: process.pid,
            cwd: fixture.repo,
          });
          attempts.push({ name, acquired: result.acquired, reason: result.reason });
        },
      });
      assert.equal(report.candidates[0].classification, "deleted");
      assert.equal(attempts.some((item) => item.name === "after-worktree-final-validation"), true);
      assert.equal(attempts.some((item) => item.name === "after-branch-final-validation"), true);
      assert.equal(attempts.some((item) => item.name === "after-run-dir-final-validation"), true);
      assert.equal(attempts.every((item) => item.acquired === false && item.reason === "launch fence is held"), true);
      assert.equal(existsSync(runDir), false);
    } finally {
      rmSync(aliasRepo, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it("revalidates repository common-dir identity after digest authorization", async () => {
    const fixture = createCleanupSweepFixture("execution-common-dir-race");
    try {
      fixture.addRun("run");
      const authorization = await preview(fixture);
      let changed = false;
      const mutations = [];
      const gitRunner = (cwd, args) => {
        if (["fetch", "update-ref"].includes(args[0])) mutations.push([...args]);
        return fixture.gitRunner(cwd, args);
      };
      const report = await execute(fixture, authorization.authorization.digest, {
        gitRunner,
        fsInspector(path, { operation, inspectDefault }) {
          const value = inspectDefault();
          if (changed && operation === "stat" && path === authorization.repository.git_common_dir_path) return { ...value, ino: Number(value.ino) + 1 };
          return value;
        },
        phaseHook(name) { if (name === "after-digest-recompute") changed = true; },
      });
      assert.notEqual(report.candidates[0].classification, "deleted");
      assert.equal(mutations.some((args) => args[0] === "update-ref" && args[1] === "-d" && args[2] === "refs/heads/run"), false);
      assert.equal(existsSync(join(fixture.factoryRoot, "run")), true);
    } finally { fixture.cleanup(); }
  });

  it("quarantines and verifies the run directory before recursive deletion", async () => {
    const fixture = createCleanupSweepFixture("execution-run-dir-swap");
    const displaced = join(fixture.factoryRoot, "authorized-run");
    try {
      fixture.addRun("run", { branch: null });
      const authorization = await preview(fixture);
      const runDir = join(fixture.factoryRoot, "run");
      const sentinel = join(runDir, "replacement-sentinel");
      const report = await execute(fixture, authorization.authorization.digest, {
        phaseHook(name) {
          if (name !== "after-run-dir-final-validation") return;
          renameSync(runDir, displaced);
          mkdirSync(runDir);
          writeFileSync(sentinel, "replacement\n", "utf8");
        },
      });
      assert.deepEqual(report.candidates[0].reason_codes, ["SKIPPED_CHANGED_DURING_EXECUTION"]);
      assert.equal(readFileSync(sentinel, "utf8"), "replacement\n");
      assert.equal(existsSync(displaced), true);
    } finally { fixture.cleanup(); }
  });

  it("never removes a worktree replacement installed after final validation", async () => {
    const fixture = createCleanupSweepFixture("execution-worktree-final-swap");
    const displaced = join(fixture.root, "authorized-worktree");
    try {
      fixture.addRun("run");
      const worktree = fixture.addRecordedWorktree("run");
      const authorization = await preview(fixture);
      const sentinel = join(worktree, "replacement-sentinel");
      let removeCommands = 0;
      const gitRunner = fallbackRunner((_cwd, args) => {
        if (args[0] === "worktree" && args[1] === "remove") removeCommands += 1;
        return null;
      }, fixture.gitRunner);
      const report = await execute(fixture, authorization.authorization.digest, {
        gitRunner,
        phaseHook(name) {
          if (name !== "after-worktree-final-validation") return;
          renameSync(worktree, displaced);
          mkdirSync(worktree);
          writeFileSync(sentinel, "replacement\n", "utf8");
        },
      });
      assert.notEqual(report.candidates[0].classification, "deleted");
      assert.equal(readFileSync(sentinel, "utf8"), "replacement\n");
      assert.equal(existsSync(displaced), true);
      assert.equal(removeCommands, 0);
    } finally { fixture.cleanup(); }
  });

  it("revalidates bound worktree-root identity before every top-level and slice removal", async () => {
    for (const target of ["top-level", "slice"]) {
      const fixture = createCleanupSweepFixture(`execution-swapped-root-${target}`);
      try {
        let externalWorktree;
        if (target === "top-level") {
          fixture.addRun("run");
          externalWorktree = fixture.addRecordedWorktree("run");
        } else {
          fixture.createBranch("slice");
          externalWorktree = fixture.addRegisteredWorktree("slice", "slice");
          fixture.addRun("run", { branch: null, slices: [{ id: "slice", branch: "slice", worktree: externalWorktree, declared_paths: ["slice.txt"], effective_paths: ["slice.txt"], status: "running", attempts: 1 }] });
        }
        const authorization = await preview(fixture);
        const externalRoot = join(fixture.root, `external-${target}`);
        let swapped = false;
        let removalCommands = 0;
        const gitRunner = fallbackRunner((_cwd, args) => {
          if (args[0] === "worktree" && args[1] === "remove") removalCommands += 1;
          return null;
        }, fixture.gitRunner);
        const report = await execute(fixture, authorization.authorization.digest, {
          gitRunner,
          phaseHook(name) {
            if (name !== "before-worktree-remove" || swapped) return;
            swapped = true;
            renameSync(fixture.worktreeRoot, externalRoot);
            symlinkSync(externalRoot, fixture.worktreeRoot, "dir");
          },
        });
        assert.deepEqual(report.candidates[0].reason_codes, ["SKIPPED_CHANGED_DURING_EXECUTION"], target);
        assert.equal(report.candidates[0].attempted_cleanup, false, target);
        assert.equal(report.attempted_cleanup_failures, 0, target);
        assert.equal(report.exit_code, 0, target);
        assert.equal(removalCommands, 0, target);
        assert.equal(existsSync(join(externalRoot, target === "top-level" ? "run" : "slice")), true, target);
      } finally { fixture.cleanup(); }
    }
  });

  it("rejects replacement directories at authorized top-level and slice worktree paths before mutation", async () => {
    for (const target of ["top-level", "slice"]) {
      const fixture = createCleanupSweepFixture(`execution-replaced-worktree-${target}`);
      try {
        let worktree;
        if (target === "top-level") {
          fixture.addRun("run");
          worktree = fixture.addRecordedWorktree("run");
        } else {
          fixture.createBranch("slice");
          worktree = fixture.addRegisteredWorktree("slice", "slice");
          fixture.addRun("run", { branch: null, slices: [{ id: "slice", branch: "slice", worktree, declared_paths: ["slice.txt"], effective_paths: ["slice.txt"], status: "running", attempts: 1 }] });
        }
        const authorization = await preview(fixture);
        const authorizedIdentity = authorization.candidates[0].evidence.worktrees[0];
        const original = `${worktree}-authorized-original`;
        let removalCommands = 0;
        const gitRunner = fallbackRunner((_cwd, args) => {
          if (args[0] === "worktree" && args[1] === "remove") removalCommands += 1;
          return null;
        }, fixture.gitRunner);
        const report = await execute(fixture, authorization.authorization.digest, {
          gitRunner,
          phaseHook(name) {
            if (name !== "before-worktree-remove" || existsSync(original)) return;
            renameSync(worktree, original);
            mkdirSync(worktree);
            copyFileSync(join(original, ".git"), join(worktree, ".git"));
            writeFileSync(join(worktree, "victim.txt"), "replacement must survive\n");
          },
        });
        const candidate = report.candidates[0];
        assert.deepEqual(candidate.reason_codes, ["SKIPPED_CHANGED_DURING_EXECUTION"], target);
        assert.equal(candidate.attempted_cleanup, false, target);
        assert.equal(candidate.cleanup, null, target);
        assert.equal(report.attempted_cleanup_failures, 0, target);
        assert.equal(report.exit_code, 0, target);
        assert.equal(removalCommands, 0, target);
        assert.equal(existsSync(join(worktree, "victim.txt")), true, target);
        assert.equal(existsSync(join(original, "README.md")), true, target);
        assert.notEqual(String(lstatSync(worktree).ino), authorizedIdentity.inode, target);
        assert.equal(String(lstatSync(original).ino), authorizedIdentity.inode, target);
      } finally { fixture.cleanup(); }
    }
  });

  it("before-run-dir-remove inspection exception is FAILED_INSPECTION and retains an unattempted run", async () => {
    const fixture = createCleanupSweepFixture("execution-before-run-dir-remove");
    try {
      fixture.addRun("run", { branch: null });
      const authorization = await preview(fixture);
      const report = await execute(fixture, authorization.authorization.digest, {
        phaseHook(name) { if (name === "before-run-dir-remove") throw new Error("injected pre-mutation inspection failure"); },
      });
      assert.deepEqual(report.candidates[0].reason_codes, ["FAILED_INSPECTION"]);
      assert.equal(report.candidates[0].attempted_cleanup, false);
      assert.equal(existsSync(join(fixture.factoryRoot, "run")), true);
    } finally { fixture.cleanup(); }
  });

  it("R51 maps exceptions after mutation begins to FAILED_CLEANUP_UNEXPECTED and continues", async () => {
    const fixture = createCleanupSweepFixture("execution-unexpected");
    try {
      fixture.addRun("a");
      fixture.addRun("b");
      const authorization = await preview(fixture);
      const gitRunner = fallbackRunner((_cwd, args) => {
        if (args[0] === "update-ref" && args[1] === "-d" && args[2] === "refs/heads/a") throw new Error("injected mutation exception");
        return null;
      }, fixture.gitRunner);
      const report = await execute(fixture, authorization.authorization.digest, { gitRunner });
      assert.deepEqual(report.candidates[0].reason_codes, ["FAILED_CLEANUP_UNEXPECTED"]);
      assert.equal(report.candidates[0].attempted_cleanup, true);
      assert.equal(report.candidates[1].classification, "deleted");
    } finally { fixture.cleanup(); }
  });

  it("R52 maps pre-mutation inspection exceptions to FAILED_INSPECTION, never changed evidence", async () => {
    const fixture = createCleanupSweepFixture("execution-inspection-exception");
    try {
      fixture.addRun("run", { branch: null });
      const authorization = await preview(fixture);
      const report = await execute(fixture, authorization.authorization.digest, {
        phaseHook(name) { if (name === "after-candidate-lock") throw new Error("inspection failed"); },
      });
      assert.equal(report.candidates[0].classification, "failed");
      assert.deepEqual(report.candidates[0].reason_codes, ["FAILED_INSPECTION"]);
      assert.equal(report.candidates[0].attempted_cleanup, false);
      assert.equal(report.exit_code, 0);
    } finally { fixture.cleanup(); }
  });

  it("R54 compare-deletes every invocation ref best-effort and fails closed after any failure", async () => {
    const fixture = createCleanupSweepFixture("execution-temp-cleanup");
    try {
      fixture.addRun("a");
      fixture.addRun("b");
      const calls = [];
      const report = await preview(fixture, {
        deleteTemporaryRef(_repo, ref, expectedOid) {
          calls.push([ref, expectedOid]);
          return calls.length === 1 ? false : fixture.gitRunner(fixture.repo, ["update-ref", "-d", ref, expectedOid]);
        },
      });
      assert.equal(calls.length, 2);
      assert.equal(calls.every(([, oid]) => oid === fixture.baseSha), true);
      assert.equal(report.status, "failed");
      assert.deepEqual(report.report_errors.map(({ code }) => code), ["FAILED_TEMP_REF_CLEANUP"]);
      assert.equal(report.authorization.digest, null);
      assert.equal(listInvocationRefs(fixture).length, 1);
    } finally { fixture.cleanup(); }
  });

  it("records authorized OIDs before initial and lock-held fetch inspection can throw", async () => {
    for (const stage of ["initial", "lock-held"]) {
      const fixture = createCleanupSweepFixture(`execution-ref-registration-${stage}`);
      try {
        fixture.addRun("run");
        const deleted = [];
        if (stage === "initial") {
          const gitRunner = fallbackRunner((cwd, args) => {
            if (args[0] !== "fetch") return null;
            fixture.gitRunner(cwd, args);
            throw new Error("injected after ref creation");
          }, fixture.gitRunner);
          const report = await preview(fixture, {
            gitRunner,
            deleteTemporaryRef(repo, ref, expectedOid) {
              deleted.push([ref, expectedOid]);
              return fixture.gitRunner(repo, ["update-ref", "-d", ref, expectedOid]);
            },
          });
          assert.equal(report.status, "previewed");
          assert.deepEqual(report.candidates[0].reason_codes, ["FAILED_INSPECTION"]);
        } else {
          const authorization = await preview(fixture);
          let fetches = 0;
          const gitRunner = fallbackRunner((cwd, args) => {
            if (args[0] !== "fetch") return null;
            fetches += 1;
            if (fetches === 1) return fixture.gitRunner(cwd, args);
            throw new Error("injected lock-held fetch failure");
          }, fixture.gitRunner);
          const report = await execute(fixture, authorization.authorization.digest, {
            gitRunner,
            deleteTemporaryRef(repo, ref, expectedOid) {
              deleted.push([ref, expectedOid]);
              return fixture.gitRunner(repo, ["update-ref", "-d", ref, expectedOid]);
            },
          });
          assert.deepEqual(report.candidates[0].reason_codes, ["FAILED_INSPECTION"]);
        }
        assert.equal(deleted.length, 1, stage);
        assert.equal(deleted[0][1], fixture.baseSha, stage);
        assert.equal(listInvocationRefs(fixture).length, 0, stage);
      } finally { fixture.cleanup(); }
    }
  });

  it("registers an authorized missing ref when inspection throws before fetch", async () => {
    const fixture = createCleanupSweepFixture("execution-ref-before-fetch");
    try {
      fixture.addRun("run");
      const compared = [];
      const gitRunner = fallbackRunner((_cwd, args) => {
        if (args[0] === "check-ref-format" && String(args[1]).startsWith("refs/feature-factory/")) throw new Error("injected before fetch");
        return null;
      }, fixture.gitRunner);
      const report = await preview(fixture, {
        gitRunner,
        phaseHook(name, context) { if (name === "before-temp-ref-delete") compared.push(context); },
      });
      assert.equal(report.status, "previewed");
      assert.deepEqual(report.candidates[0].reason_codes, ["FAILED_INSPECTION"]);
      assert.equal(compared.length, 1);
      assert.equal(compared[0].expected_oid, fixture.baseSha);
      assert.equal(listInvocationRefs(fixture).length, 0);
    } finally { fixture.cleanup(); }
  });

  it("R54 treats a missing temporary ref as clean and changed/undeletable refs as failure", async () => {
    for (const mode of ["missing", "changed", "undeletable"]) {
      const fixture = createCleanupSweepFixture(`execution-temp-${mode}`);
      try {
        fixture.addRun("run");
        const changedCommit = gitOutput(fixture.repo, ["commit-tree", `${fixture.baseSha}^{tree}`, "-p", fixture.baseSha, "-m", "changed"]);
        const report = await preview(fixture, {
          phaseHook(name, context) {
            if (name !== "before-temp-ref-delete") return;
            if (mode === "missing") fixture.gitRunner(fixture.repo, ["update-ref", "-d", context.ref, context.expected_oid]);
            if (mode === "changed") fixture.gitRunner(fixture.repo, ["update-ref", context.ref, changedCommit, context.expected_oid]);
          },
          deleteTemporaryRef: mode === "undeletable" ? () => false : undefined,
        });
        assert.equal(report.status, mode === "missing" ? "previewed" : "failed", mode);
      } finally { fixture.cleanup(); }
    }
  });

  it("retains pre-fetch authorization even when the run manifest disappears after ref creation", async () => {
    const fixture = createCleanupSweepFixture("execution-temp-preserved-authorization");
    try {
      fixture.addRun("run");
      const gitRunner = fallbackRunner((cwd, args) => {
        if (args[0] !== "fetch") return null;
        fixture.gitRunner(cwd, args);
        rmSync(join(fixture.factoryRoot, "run", "run.json"));
        throw new Error("authorization disappeared after ref creation");
      }, fixture.gitRunner);
      const report = await preview(fixture, { gitRunner });
      assert.equal(report.status, "previewed");
      assert.deepEqual(report.candidates[0].reason_codes, ["FAILED_INSPECTION"]);
      assert.equal(listInvocationRefs(fixture).length, 0);
    } finally { fixture.cleanup(); }
  });

  it("R55 preserves completed outcomes when lock orchestration fails after a candidate", async () => {
    const fixture = createCleanupSweepFixture("execution-orchestration-failure");
    try {
      fixture.addRun("run", { branch: null });
      const authorization = await preview(fixture);
      const report = await execute(fixture, authorization.authorization.digest, {
        async acquireRunLock(_runDir, callback, lockOptions) {
          assert.deepEqual(lockOptions, { reclaimMode: "never" });
          await callback();
          throw new Error("post-callback orchestration failure");
        },
      });
      assert.equal(report.status, "failed");
      assert.equal(report.candidates[0].classification, "deleted");
      assert.deepEqual(report.report_errors.map(({ code }) => code), ["FAILED_ORCHESTRATION"]);
      assert.equal(report.authorization.digest, null);
      assert.equal(report.exit_code, 1);
    } finally { fixture.cleanup(); }
  });

  it("rejects malformed execution digests before repository inspection", async () => {
    let gitCalls = 0;
    await assert.rejects(executeCleanupSweep({ digest: "bad", gitRunner() { gitCalls += 1; } }), /digest is malformed/u);
    assert.equal(gitCalls, 0);
  });

  it("maps repository identity/factory-root inspection failure to FAILED_FACTORY_ROOT", async () => {
    const fixture = createCleanupSweepFixture("execution-factory-root-failure");
    try {
      const report = await preview(fixture, {
        fsInspector(path, context) {
          if (path === fixture.repo && context.operation === "realpath") throw new Error("injected root failure");
          return context.inspectDefault();
        },
      });
      assert.equal(report.status, "failed");
      assert.equal(report.repository, null);
      assert.deepEqual(report.report_errors.map(({ code }) => code), ["FAILED_FACTORY_ROOT"]);
      assert.equal(report.authorization.digest, null);
    } finally { fixture.cleanup(); }
  });
});

function sweepOptions(fixture, overrides = {}) {
  return {
    cwd: fixture.repo,
    invocationId: INVOCATION,
    clock: () => Date.parse("2026-07-12T12:00:00.000Z"),
    inspectProcess: () => ({ state: "absent" }),
    githubRunner: fixture.githubRunner,
    gitRunner: fixture.gitRunner,
    ...overrides,
  };
}
function preview(fixture, overrides) { return previewCleanupSweep(sweepOptions(fixture, overrides)); }
function execute(fixture, digest, overrides) { return executeCleanupSweep({ ...sweepOptions(fixture, overrides), digest }); }
function fallbackRunner(primary, fallback) { return (cwd, args, options) => primary(cwd, args, options) ?? fallback(cwd, args, options); }
function commandFailure() { return { ok: false, status: 1, stdout: "", stderr: "", command: null, signal: null }; }
function gitOutput(cwd, args) {
  const result = runFixtureGit(cwd, args);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
function branchExists(cwd, branch) { return runFixtureGit(cwd, ["show-ref", "--verify", `refs/heads/${branch}`]).status === 0; }
function listInvocationRefs(fixture) {
  const result = runFixtureGit(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/feature-factory/cleanup-sweep/v1/"]);
  return result.stdout.trim() ? result.stdout.trim().split("\n") : [];
}
