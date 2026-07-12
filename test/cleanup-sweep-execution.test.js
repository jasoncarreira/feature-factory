import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { executeCleanupSweep, previewCleanupSweep } from "../src/cleanup-sweep.js";
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

  it("R46 records worktree failure, retains its branch/run directory, and invokes the worktree phase seam", async () => {
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
      assert.equal(candidate.classification, "failed");
      assert.equal(candidate.reason_codes.includes("FAILED_CLEANUP_WORKTREE"), true);
      assert.equal(candidate.cleanup.branches[0].outcome, "not-attempted");
      assert.equal(candidate.cleanup.run_dir.outcome, "retained");
      assert.equal(phases.includes("before-worktree-remove"), true);
      assert.equal(report.exit_code, 1);
    } finally { fixture.cleanup(); }
  });

  it("before-branch-delete mutation is refused by CAS and retains the run directory", async () => {
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
      assert.deepEqual(report.candidates[0].reason_codes, ["FAILED_CLEANUP_BRANCH", "RETAINED_AFTER_PARTIAL_FAILURE"]);
      assert.equal(report.candidates[0].cleanup.branches[0].outcome, "failed");
      assert.equal(existsSync(join(fixture.factoryRoot, "run")), true);
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
function listInvocationRefs(fixture) {
  const result = runFixtureGit(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/feature-factory/cleanup-sweep/v1/"]);
  return result.stdout.trim() ? result.stdout.trim().split("\n") : [];
}
