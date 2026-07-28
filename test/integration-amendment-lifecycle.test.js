import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { completeSliceBuilderTaskDispatch, observeIntegrationAmendmentExecutionAuthority, prepareSliceBuilderTaskDispatch, transitionGateDecision, transitionIntegrationAmendment, transitionRunJson, transitionRunSlice, transitionSliceMerged, transitionSteeringBoundaryOpened, transitionTerminalResult } from "../src/run-state.js";
import { checkRunConsistency, validateRun } from "../src/validate.js";
import { continueFactory, executeIntegrationAmendment } from "../src/factory.js";
import { CARRY_FORWARD_REQUIRED_SUMMARY, FEATURE_BRANCH, NOW, RUN_ID, addAcceptedTechnicalBrief, advanceMergedAmendmentConsumer, blockRuntimeAmendment, bindAmendmentDispatch, blocked, carryForwardTerminalResult, cleanup, cleanupFixtures, commitCandidate, createFixture, executionOptions, git, publishAmendmentReview, publishConsumerReview, reachIntegrated, reachMerged, readJson, readRun, reportRequest, sha, snapshotRuntimeFiles, writeJson, writeVerification } from "./helpers/integration-amendment/fixture.js";

after(cleanupFixtures);

describe("generic integration amendment lifecycle and execution", () => {
  it("rejects every non-pristine consumer class with one exact effect-free reason", async () => {
    const cases = [
      ["blocked", (consumer) => Object.assign(consumer, { status: "blocked", attempts: 0, blocked_reason: "prior terminal stop" })],
      ["previously-attempted", (consumer) => Object.assign(consumer, { status: "blocked", attempts: 1, blocked_reason: "attempted before repair" })],
      ["branch-only", (consumer) => Object.assign(consumer, { branch: "consumer-build", worktree: "/tmp/consumer-build" })],
      ["active", (consumer) => Object.assign(consumer, { status: "running", attempts: 1 })],
    ];
    for (const [name, mutate] of cases) {
      const fixture = createFixture({ publishReport: false });
      try {
        const run = readRun(fixture);
        mutate(run.slices.find((slice) => slice.id === "consumer"));
        validateRun(run);
        writeJson(join(fixture.runDir, "run.json"), run);
        const beforeFiles = snapshotRuntimeFiles(fixture.runDir);
        const beforeRefs = git(fixture.repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
        const beforeWorktrees = git(fixture.repo, ["worktree", "list", "--porcelain"]);

        assert.throws(
          () => observeIntegrationAmendmentExecutionAuthority(fixture.runDir, run, "report", reportRequest(), { repoRoot: fixture.repo }),
          (error) => error?.message === "integration-amendment-consumer-not-pristine-pending",
          name,
        );
        await assert.rejects(
          executeIntegrationAmendment(fixture.runDir, reportRequest(), { spawnFn() { throw new Error("unexpected spawn"); } }),
          (error) => error?.message === "integration-amendment-consumer-not-pristine-pending",
          name,
        );
        assert.deepEqual(snapshotRuntimeFiles(fixture.runDir), beforeFiles, `${name}: durable files`);
        assert.equal(git(fixture.repo, ["for-each-ref", "--format=%(refname) %(objectname)"]), beforeRefs, `${name}: refs`);
        assert.equal(git(fixture.repo, ["worktree", "list", "--porcelain"]), beforeWorktrees, `${name}: worktrees`);
        assert.equal(readRun(fixture).terminal_result, undefined, `${name}: terminal result`);
        assert.equal(readRun(fixture).integration_amendment, undefined, `${name}: manifest`);

        const transitionFixture = createFixture();
        try {
          const transitionRun = readRun(transitionFixture);
          mutate(transitionRun.slices.find((slice) => slice.id === "consumer"));
          validateRun(transitionRun);
          writeJson(join(transitionFixture.runDir, "run.json"), transitionRun);
          const beforeTransition = snapshotRuntimeFiles(transitionFixture.runDir);
          await assert.rejects(
            transitionIntegrationAmendment(transitionFixture.runDir, reportRequest(), { repoRoot: transitionFixture.repo }),
            (error) => error?.message === "integration-amendment-consumer-not-pristine-pending",
            name,
          );
          assert.deepEqual(snapshotRuntimeFiles(transitionFixture.runDir), beforeTransition, `${name}: transition files`);
        } finally { cleanup(transitionFixture); }
      } finally { cleanup(fixture); }
    }
  });

  it("executes the AC3 parent class x terminal precondition x review source matrix without effects", async () => {
    const parentClasses = [
      ["ordinary", ["running", "terminal"]],
      ["checkpoint-child", ["running", "terminal"]],
      ["checkpoint-router", ["terminal"]],
    ];
    const reviewSources = ["current", "stale"];
    const expectedRows = 10;
    assert.equal(parentClasses.length, 3, "exact AC3 parent classes");
    assert.equal(reviewSources.length, 2, "exact AC3 review-source classes");
    assert.equal(parentClasses.reduce((count, [, preconditions]) => count + preconditions.length * reviewSources.length, 0), expectedRows);
    let assertedRows = 0;

    for (const [parentClass, terminalPreconditions] of parentClasses) {
      for (const terminalPrecondition of terminalPreconditions) {
        for (const reviewSource of reviewSources) {
          const fixture = createFixture({ publishReport: false });
          try {
            const run = readRun(fixture);
            Object.assign(run.slices.find((slice) => slice.id === "consumer"), { status: "blocked", attempts: 0, blocked_reason: "prior terminal stop" });
            applyAc3ParentClass(run, fixture, parentClass, terminalPrecondition);
            validateRun(run);
            writeJson(join(fixture.runDir, "run.json"), run);
            if (reviewSource === "stale") writeFileSync(join(fixture.runDir, "reviews", "work-decomposer.json"), "{\"subject\":\"work-decomposer\",\"attempt\":1,\"verdict\":\"APPROVE\",\"required_fixes\":[]}\n");
            const beforeFiles = snapshotRuntimeFiles(fixture.runDir);
            const beforeRefs = git(fixture.repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
            const beforeWorktrees = git(fixture.repo, ["worktree", "list", "--porcelain"]);
            let spawns = 0;
            const expected = ac3ExpectedError(parentClass, terminalPrecondition, reviewSource);

            assert.throws(
              () => observeIntegrationAmendmentExecutionAuthority(fixture.runDir, run, "report", reportRequest(), { repoRoot: fixture.repo }),
              (error) => error?.message === expected,
              `${parentClass}/${terminalPrecondition}/${reviewSource}: observer`,
            );
            await assert.rejects(
              executeIntegrationAmendment(fixture.runDir, reportRequest(), { spawnFn() { spawns += 1; throw new Error("unexpected spawn"); } }),
              (error) => error?.message === expected,
              `${parentClass}/${terminalPrecondition}/${reviewSource}: executor`,
            );
            assert.equal(spawns, 0, `${parentClass}/${terminalPrecondition}/${reviewSource}: spawn count`);
            assert.deepEqual(snapshotRuntimeFiles(fixture.runDir), beforeFiles, `${parentClass}/${terminalPrecondition}/${reviewSource}: durable files`);
            assert.equal(git(fixture.repo, ["for-each-ref", "--format=%(refname) %(objectname)"]), beforeRefs, `${parentClass}/${terminalPrecondition}/${reviewSource}: refs`);
            assert.equal(git(fixture.repo, ["worktree", "list", "--porcelain"]), beforeWorktrees, `${parentClass}/${terminalPrecondition}/${reviewSource}: worktrees`);
            assertedRows += 1;
          } finally { cleanup(fixture); }
        }
      }
    }
    assert.equal(assertedRows, expectedRows, "every AC3 matrix row was executed and asserted");
  });

  it("terminalizes an ordinary rejected repair only through checked carry-forward authority", async () => {
    const fixture = createFixture({ publishReport: false });
    try {
      const run = readRun(fixture);
      Object.assign(run.slices.find((slice) => slice.id === "consumer"), { status: "blocked", blocked_reason: "prior terminal stop" });
      writeJson(join(fixture.runDir, "run.json"), run);
      await assert.rejects(
        executeIntegrationAmendment(fixture.runDir, reportRequest(), { spawnFn() { throw new Error("unexpected spawn"); } }),
        (error) => error?.message === "integration-amendment-consumer-not-pristine-pending",
      );

      await assert.rejects(
        transitionTerminalResult(fixture.runDir, carryForwardTerminalResult()),
        /terminal requires a lock-protected boundary observation/u,
      );
      const opened = await transitionSteeringBoundaryOpened(fixture.runDir, "terminal", { now: NOW });
      const reviewPath = join(fixture.runDir, "reviews", "work-decomposer.json");
      const reviewBytes = readFileSync(reviewPath);
      writeFileSync(reviewPath, `${reviewBytes.toString("utf8")} `);
      await assert.rejects(
        transitionTerminalResult(fixture.runDir, carryForwardTerminalResult(), { boundaryToken: opened.boundary.token, now: NOW }),
        /accepted work-decomposer|review_hash|authority/u,
      );
      writeFileSync(reviewPath, reviewBytes);

      const terminal = await transitionTerminalResult(fixture.runDir, carryForwardTerminalResult(), { boundaryToken: opened.boundary.token, now: NOW });
      assert.equal(terminal.run.status, "blocked");
      assert.equal(terminal.terminal_result.reason, "carry-forward-required");
      assert.equal(terminal.terminal_result.summary, CARRY_FORWARD_REQUIRED_SUMMARY);
      assert.deepEqual(terminal.terminal_result.artifacts, {});
      assert.equal(terminal.run.integration_amendment, undefined);
    } finally { cleanup(fixture); }
  });

  it("lets a carry-forward-required parent continue while its settled blocked amendment is retained", async () => {
    // The terminal summary instructs the operator to continue in a fresh
    // schema-v2 carry-forward child, and that terminalization deliberately keeps
    // the blocked amendment authority. Continuation admission previously demanded
    // an all-absent inventory, so the only documented recovery was unreachable
    // for exactly the parent that needed it. Verified against the real sidecar
    // inventory, not a hand-written run.json field: a synthesized
    // `integration_amendment` alone classifies all-absent and would pass the old
    // guard vacuously.
    const fixture = createFixture();
    const runId = RUN_ID;
    const continueOpts = { cwd: fixture.repo, review: "reviews/work-decomposer.json", runId: "amendment-carry-child", carryForward: true, dryRun: true, json: true };
    const amendmentRejection = /integration-amendment-continuation-unsupported/u;
    try {
      const head = git(fixture.repo, ["rev-parse", "HEAD"]).trim();
      const runPath = join(fixture.runDir, "run.json");
      writeJson(runPath, { ...readRun(fixture), base_ref: "main", base_commit: head });
      addAcceptedTechnicalBrief(fixture);

      // An amendment that is merely reported is active authority and still rejects.
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      assert.equal(readRun(fixture).integration_amendment.status, "reported");
      assert.throws(() => continueFactory(runId, continueOpts), amendmentRejection, "reported amendment must still reject");

      // Blocked but not yet terminalized is also still live authority.
      const blockedRun = await blockRuntimeAmendment(fixture);
      assert.equal(blockedRun.integration_amendment.status, "blocked");
      assert.throws(() => continueFactory(runId, continueOpts), amendmentRejection, "blocked without carry-forward terminalization must still reject");

      // Only the exact terminalized shape is admitted.
      const terminal = await transitionTerminalResult(fixture.runDir, carryForwardTerminalResult(), { now: NOW, blockedAmendmentTerminal: true });
      assert.equal(terminal.terminal_result.reason, "carry-forward-required");
      assert.equal(terminal.run.integration_amendment.status, "blocked", "terminalization retains the blocked amendment");

      // The amendment gate no longer blocks. Continuation now proceeds to the
      // ordinary carry-forward authority checks; this fixture's git history has
      // no accepted merge-commit ancestry, so it stops there rather than
      // publishing. That later stop is the proof the gate was passed.
      assert.throws(
        () => continueFactory(runId, continueOpts),
        (error) => {
          assert.doesNotMatch(error.message, amendmentRejection, "amendment gate must no longer reject a terminalized parent");
          assert.match(error.message, /first-parent range must contain all and only accepted merge commits/u);
          return true;
        },
      );
    } finally { cleanup(fixture); }
  });

  it("drives report, build, review, integrate, verify, and merge with exact replay", async () => {
    const fixture = createFixture();
    try {
      const reported = await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      assert.equal(reported.integration_amendment.status, "reported");
      await assert.rejects(transitionRunJson(fixture.runDir, (run) => { delete run.integration_amendment; }), /integration amendment is reported|only be changed by transitionIntegrationAmendment|generic run writer/u);
      await assert.rejects(transitionRunSlice(fixture.runDir, "consumer", { status: "running", attempts: 1 }), /integration amendment is reported/u);

      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW, integrationAmendmentHooks: { afterBuildBranch: () => { throw new Error("crash-after-build-branch"); } } }), /crash-after-build-branch/u);
      assert.equal(readRun(fixture).integration_amendment.status, "reported");
      const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      const attempt = built.integration_amendment.attempts[0];
      assert.equal(attempt.state, "building");
      const replay = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(replay.updated, false);

      const candidate = commitCandidate(attempt.worktree);
      bindAmendmentDispatch(fixture, candidate);
      await publishAmendmentReview(fixture, "APPROVE", []);
      const reviewed = await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(reviewed.integration_amendment.status, "reviewed");
      assert.equal(reviewed.integration_amendment.attempts[0].reviewed_commit, candidate);
      assert.equal(reviewed.run.special_builder_dispatch, undefined);

      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "integrate" }, { repoRoot: fixture.repo, now: NOW, integrationAmendmentHooks: { afterStagingRef: () => { throw new Error("crash-after-staging-ref"); } } }), /crash-after-staging-ref/u);
      assert.equal(readRun(fixture).integration_amendment.status, "reviewed");
      const integrated = await transitionIntegrationAmendment(fixture.runDir, { action: "integrate" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(integrated.integration_amendment.status, "integrated");
      assert.equal(git(fixture.repo, ["rev-list", "--parents", "-n", "1", integrated.integration_amendment.integration.commit]).trim().split(/\s+/u).length, 3);
      await transitionIntegrationAmendment(fixture.runDir, { action: "integrate" }, { repoRoot: fixture.repo, now: NOW });

      writeVerification(fixture);
      const verified = await transitionIntegrationAmendment(fixture.runDir, { action: "verify" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(verified.integration_amendment.status, "verified");
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "merge" }, { repoRoot: fixture.repo, now: NOW, integrationAmendmentHooks: { afterFeatureCas: () => { throw new Error("crash-after-feature-cas"); } } }), /crash-after-feature-cas/u);
      assert.equal(readRun(fixture).integration_amendment.status, "verified");
      const merged = await transitionIntegrationAmendment(fixture.runDir, { action: "merge" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(merged.integration_amendment.status, "merged");
      assert.equal(git(fixture.repo, ["rev-parse", FEATURE_BRANCH]).trim(), merged.integration_amendment.integration.commit);
      assert.equal(git(fixture.repo, ["status", "--porcelain"]).trim(), "");
      await transitionIntegrationAmendment(fixture.runDir, { action: "merge" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(checkRunConsistency(fixture.runDir, readRun(fixture)).ok, true);
    } finally { cleanup(fixture); }
  });

  it("continues a merged amendment through checked consumer execution, merge, and a fresh gate", async () => {
    const fixture = createFixture();
    try {
      addAcceptedTechnicalBrief(fixture);
      await reachMerged(fixture);
      const progressed = await advanceMergedAmendmentConsumer(fixture, { assertCurrentDispatchTamper: true });
      assert.equal(progressed.started.status, "running");
      assert.equal(progressed.reviewed.status, "review");
      assert.equal(progressed.merged.status, "merged");
      assert.notEqual(progressed.mergeCommit, readRun(fixture).integration_amendment.integration.commit);
      assert.equal(git(fixture.repo, ["rev-parse", FEATURE_BRANCH]).trim(), progressed.mergeCommit);
      assert.equal(checkRunConsistency(fixture.runDir, readRun(fixture)).ok, true);

      mkdirSync(join(fixture.runDir, "artifacts"), { recursive: true });
      mkdirSync(join(fixture.runDir, "gates"), { recursive: true });
      writeFileSync(join(fixture.runDir, "artifacts", "test-report.md"), "consumer integration passed\n");
      writeFileSync(join(fixture.runDir, "gates", "pre-pr.md"), "Create the pull request?\n");
      const pending = await transitionGateDecision(fixture.runDir, "pre_pr", { status: "pending", artifact: "artifacts/test-report.md", question_ref: "gates/pre-pr.md" });
      assert.equal(pending.run.gates.pre_pr.status, "pending");
      const boundary = await transitionSteeringBoundaryOpened(fixture.runDir, "gate", { now: NOW, token: "merged-consumer-gate" });
      assert.equal(boundary.boundary.kind, "gate");
    } finally { cleanup(fixture); }

    for (const tamper of ["row", "feature-descendant"]) {
      const adversarial = createFixture();
      try {
        addAcceptedTechnicalBrief(adversarial);
        await reachMerged(adversarial);
        await advanceMergedAmendmentConsumer(adversarial);
        if (tamper === "row") {
          const run = readRun(adversarial);
          run.slices.find((slice) => slice.id === "consumer").merge_commit = run.integration_amendment.integration.commit;
          writeJson(join(adversarial.runDir, "run.json"), run);
        } else {
          git(adversarial.featureWorktree, ["commit", "--allow-empty", "-m", "unauthorized descendant after consumer merge"]);
        }
        const before = readFileSync(join(adversarial.runDir, "run.json"));
        await assert.rejects(
          transitionSteeringBoundaryOpened(adversarial.runDir, "gate", { now: NOW, token: `reject-${tamper}-gate` }),
          /integration amendment|feature head|merge chain|merge commit|stale|authority/u,
          tamper,
        );
        assert.deepEqual(readFileSync(join(adversarial.runDir, "run.json")), before, `${tamper} rejection must be effect-free`);
      } finally { cleanup(adversarial); }
    }
  });

  it("rejects caller-controlled commits before first downstream dispatch without effects", async (t) => {
    const cases = [
      {
        name: "owner and control-plane poison before an allowed consumer change",
        extraSlices: [],
        writes: [
          ["src/owner/api.js", "export const value = 999;\n"],
          [".github/workflows/poison.yml", "name: poison\n"],
          ["src/consumer/index.js", "export const consumer = true;\n"],
        ],
      },
      {
        name: "sibling consumer poison",
        extraSlices: [{ id: "sibling", effective_paths: ["src/sibling/**"] }],
        writes: [
          ["src/sibling/index.js", "export const sibling = 'poison';\n"],
          ["src/consumer/index.js", "export const consumer = true;\n"],
        ],
      },
      {
        name: "otherwise allowed consumer commit ahead of baseline",
        extraSlices: [],
        writes: [["src/consumer/index.js", "export const consumer = true;\n"]],
      },
    ];
    for (const testCase of cases) {
      await t.test(testCase.name, async () => {
        const fixture = createFixture({ extraSlices: testCase.extraSlices });
        try {
          addAcceptedTechnicalBrief(fixture);
          await reachMerged(fixture);
          const integrationCommit = readRun(fixture).integration_amendment.integration.commit;
          const branch = `poison-${createHash("sha256").update(testCase.name).digest("hex").slice(0, 8)}`;
          const worktree = join(fixture.repo, ".opencode", "worktrees", branch);
          git(fixture.repo, ["branch", branch, integrationCommit]);
          git(fixture.repo, ["worktree", "add", worktree, branch]);
          for (const [path, contents] of testCase.writes) {
            mkdirSync(dirname(join(worktree, path)), { recursive: true });
            writeFileSync(join(worktree, path), contents);
          }
          git(worktree, ["add", "-A"]);
          git(worktree, ["commit", "-m", "caller-controlled pre-dispatch poison"]);
          const poisonedHead = git(worktree, ["rev-parse", "HEAD"]).trim();
          const before = snapshotRuntimeFiles(fixture.runDir);
          await assert.rejects(
            transitionRunSlice(fixture.runDir, "consumer", { status: "running", attempts: 1, branch, worktree }, { mustExist: true, now: NOW }),
            /exact clean worktree at the authorized feature baseline/u,
          );
          assert.deepEqual(snapshotRuntimeFiles(fixture.runDir), before, "rejected start must not publish state or sidecars");
          assert.equal(git(worktree, ["rev-parse", "HEAD"]).trim(), poisonedHead, "rejection must not rewrite caller Git state");
          assert.equal(git(worktree, ["status", "--porcelain"]).trim(), "");
        } finally { cleanup(fixture); }
      });
    }
  });

  it("rejects baseline substitution between checked start and first dispatch without side effects", async () => {
    const fixture = createFixture();
    try {
      addAcceptedTechnicalBrief(fixture);
      await reachMerged(fixture);
      const integrationCommit = readRun(fixture).integration_amendment.integration.commit;
      const branch = "consumer-substitution";
      const worktree = join(fixture.repo, ".opencode", "worktrees", branch);
      git(fixture.repo, ["branch", branch, integrationCommit]);
      git(fixture.repo, ["worktree", "add", worktree, branch]);
      const started = await transitionRunSlice(fixture.runDir, "consumer", { status: "running", attempts: 1, branch, worktree }, { mustExist: true, now: NOW });
      assert.equal(started.slice.authorized_baseline_commit, integrationCommit);

      mkdirSync(join(worktree, "src", "consumer"), { recursive: true });
      writeFileSync(join(worktree, "src", "consumer", "index.js"), "export const substituted = true;\n");
      git(worktree, ["add", "src/consumer/index.js"]);
      git(worktree, ["commit", "-m", "substitute baseline before dispatch"]);
      const substitutedHead = git(worktree, ["rev-parse", "HEAD"]).trim();
      const before = snapshotRuntimeFiles(fixture.runDir);
      await assert.rejects(
        prepareSliceBuilderTaskDispatch(fixture.repo, { run_id: RUN_ID, slice_id: "consumer", attempt: 1, agent: "backend-builder" }, { claimDispatch: true, completionToken: "must-not-publish", now: NOW }),
        /first dispatch head must equal its authorized feature baseline/u,
      );
      assert.deepEqual(snapshotRuntimeFiles(fixture.runDir), before, "rejected dispatch must not publish claim or state");
      assert.equal(git(worktree, ["rev-parse", "HEAD"]).trim(), substitutedHead);
    } finally { cleanup(fixture); }
  });

  it("keeps the authorized baseline through valid retries and binds strike history to review bytes", async () => {
    const fixture = createFixture();
    try {
      addAcceptedTechnicalBrief(fixture);
      await reachMerged(fixture);
      const integrationCommit = readRun(fixture).integration_amendment.integration.commit;
      const branch = "consumer-retry";
      const worktree = join(fixture.repo, ".opencode", "worktrees", branch);
      git(fixture.repo, ["branch", branch, integrationCommit]);
      git(fixture.repo, ["worktree", "add", worktree, branch]);
      await transitionRunSlice(fixture.runDir, "consumer", { status: "running", attempts: 1, branch, worktree }, { mustExist: true, now: NOW });

      const firstToken = "consumer-retry-one";
      const first = await prepareSliceBuilderTaskDispatch(fixture.repo, { run_id: RUN_ID, slice_id: "consumer", attempt: 1, agent: "backend-builder" }, { claimDispatch: true, completionToken: firstToken, now: NOW });
      assert.equal(first.slice.head, integrationCommit);
      mkdirSync(join(worktree, "src", "consumer"), { recursive: true });
      writeFileSync(join(worktree, "src", "consumer", "index.js"), "export const consumer = 1;\n");
      git(worktree, ["add", "src/consumer/index.js"]);
      git(worktree, ["commit", "-m", "consumer attempt one"]);
      const firstHead = git(worktree, ["rev-parse", "HEAD"]).trim();
      await completeSliceBuilderTaskDispatch(fixture.repo, { run_id: RUN_ID, slice_id: "consumer", attempt: 1, agent: "backend-builder", claim_ref: first.dispatch_claim.ref, claim_hash: first.dispatch_claim.hash, completion_token: firstToken }, { now: NOW });
      await publishConsumerReview(fixture, { attempt: 1, reviewedCommit: firstHead, verdict: "REJECT", requiredFixes: ["adjust consumer implementation"] });

      await transitionRunSlice(fixture.runDir, "consumer", { status: "running", attempts: 2 }, { mustExist: true, now: NOW });
      const secondToken = "consumer-retry-two";
      const second = await prepareSliceBuilderTaskDispatch(fixture.repo, { run_id: RUN_ID, slice_id: "consumer", attempt: 2, agent: "backend-builder" }, { claimDispatch: true, completionToken: secondToken, now: NOW });
      assert.equal(second.slice.head, firstHead);
      writeFileSync(join(worktree, "src", "consumer", "index.js"), "export const consumer = 2;\n");
      git(worktree, ["add", "src/consumer/index.js"]);
      git(worktree, ["commit", "-m", "consumer attempt two"]);
      const secondHead = git(worktree, ["rev-parse", "HEAD"]).trim();
      await completeSliceBuilderTaskDispatch(fixture.repo, { run_id: RUN_ID, slice_id: "consumer", attempt: 2, agent: "backend-builder", claim_ref: second.dispatch_claim.ref, claim_hash: second.dispatch_claim.hash, completion_token: secondToken }, { now: NOW });
      await publishConsumerReview(fixture, { attempt: 2, reviewedCommit: secondHead, verdict: "REJECT", requiredFixes: ["apply final consumer correction"] });

      const runPath = join(fixture.runDir, "run.json");
      const runBytes = readFileSync(runPath);
      const run = readRun(fixture);
      run.slices.find((slice) => slice.id === "consumer").attempt_reviews[1].late_discovery_strike = true;
      writeJson(runPath, run);
      const consistency = checkRunConsistency(fixture.runDir, readRun(fixture));
      assert.equal(consistency.checks.find((check) => check.name === "run.schema")?.ok, true, "attempt-two strike remains schema-valid");
      const authority = consistency.checks.find((check) => check.name === "run.integration_amendment.authority");
      assert.equal(authority?.ok, false, "amendment authority rejects history that differs from the review sidecar");
      assert.match(authority.errors.map((error) => error.message).join("\n"), /consumer attempt 2 review authority is stale/u);
      writeFileSync(runPath, runBytes);

      await transitionRunSlice(fixture.runDir, "consumer", { status: "running", attempts: 3 }, { mustExist: true, now: NOW });
      const thirdToken = "consumer-retry-three";
      const third = await prepareSliceBuilderTaskDispatch(fixture.repo, { run_id: RUN_ID, slice_id: "consumer", attempt: 3, agent: "backend-builder" }, { claimDispatch: true, completionToken: thirdToken, now: NOW });
      assert.equal(third.slice.head, secondHead);
      writeFileSync(join(worktree, "src", "consumer", "index.js"), "export const consumer = 3;\n");
      git(worktree, ["add", "src/consumer/index.js"]);
      git(worktree, ["commit", "-m", "consumer attempt three"]);
      const thirdHead = git(worktree, ["rev-parse", "HEAD"]).trim();
      await completeSliceBuilderTaskDispatch(fixture.repo, { run_id: RUN_ID, slice_id: "consumer", attempt: 3, agent: "backend-builder", claim_ref: third.dispatch_claim.ref, claim_hash: third.dispatch_claim.hash, completion_token: thirdToken }, { now: NOW });
      await publishConsumerReview(fixture, { attempt: 3, reviewedCommit: thirdHead });

      git(fixture.featureWorktree, ["merge", "--no-ff", branch, "-m", "merge retried consumer"]);
      const mergeCommit = git(fixture.featureWorktree, ["rev-parse", "HEAD"]).trim();
      const merged = await transitionSliceMerged(fixture.runDir, "consumer", { merge_commit: mergeCommit }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(merged.slice.authorized_baseline_commit, integrationCommit);
      assert.equal(merged.slice.attempt_reviews[0].diff_base_commit, integrationCommit);
      assert.equal(merged.slice.attempt_reviews[1].diff_base_commit, integrationCommit);
      assert.equal(merged.slice.attempt_reviews[2].diff_base_commit, integrationCommit);
      assert.equal(checkRunConsistency(fixture.runDir, readRun(fixture)).ok, true);
    } finally { cleanup(fixture); }
  });

  it("claims before spawn, derives the exact probe environment, and exact-replays without spawning", async () => {
    const fixture = createFixture({ publishReport: false });
    const calls = [];
    try {
      const result = await executeIntegrationAmendment(fixture.runDir, reportRequest(), executionOptions([{ code: 1 }], calls, {
        integrationAmendmentExecutionHooks: {
          afterClaim: ({ claim }) => {
            assert.equal(readJson(join(fixture.runDir, "evidence", "integration-amendment.report.claim.json")).state, "active");
            assert.equal(claim.head_sha, fixture.baseline);
          },
        },
      }));
      assert.equal(result.status, "reported");
      assert.equal(result.replayed, false);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args, ["--test", "test/consumer.test.js"]);
      assert.equal(calls[0].options.cwd, fixture.featureWorktree);
      assert.equal(calls[0].options.shell, false);
      assert.equal(calls[0].options.env.UNSAFE_SECRET, undefined);

      const replay = await executeIntegrationAmendment(fixture.runDir, reportRequest(), {
        env: { PATH: "/fixture/bin" },
        spawnFn() { throw new Error("exact replay must not spawn"); },
      });
      assert.equal(replay.status, "reported");
      assert.equal(replay.replayed, true);
    } finally { cleanup(fixture); }
  });

  it("settles pass and diagnostic reports and makes authority drift permanently unknown", async () => {
    for (const [behavior, expected] of [[{ code: 0 }, "not-reproduced"], [{ launchThrow: true }, "diagnostic"]]) {
      const fixture = createFixture({ publishReport: false });
      try {
        const calls = [];
        const result = await executeIntegrationAmendment(fixture.runDir, reportRequest(), executionOptions([behavior], calls));
        assert.equal(result.status, expected);
        assert.equal(readRun(fixture).integration_amendment, undefined);
        assert.equal(calls.length, 1);
        const replay = await executeIntegrationAmendment(fixture.runDir, reportRequest(), { env: { PATH: "/fixture/bin" }, spawnFn() { throw new Error("settled replay must not spawn"); } });
        assert.equal(replay.status, expected);
        assert.equal(replay.replayed, true);
      } finally { cleanup(fixture); }
    }

    const stale = createFixture({ publishReport: false });
    try {
      await assert.rejects(executeIntegrationAmendment(stale.runDir, reportRequest(), executionOptions([{ code: 1 }], [], {
        integrationAmendmentExecutionHooks: { afterProcess: () => git(stale.featureWorktree, ["commit", "--allow-empty", "-m", "authority drift"]) },
      })), /authority changed after process close/u);
      const claim = readJson(join(stale.runDir, "evidence", "integration-amendment.report.claim.json"));
      assert.equal(claim.state, "unknown");
      assert.equal(claim.reason, "authority-changed");
      assert.equal(existsSync(join(stale.runDir, claim.receipt_ref)), false);
    } finally { cleanup(stale); }
  });

  it("records report signal, timeout, output-limit, and process-indeterminate outcomes", async () => {
    for (const [name, behavior, outcome, overrides] of [
      ["signal", { signal: "SIGTERM" }, "signaled", {}],
      ["timeout", { hang: true }, "timeout", { commandTimeoutMs: 1, closeTimeoutMs: 100 }],
      ["output-limit", { stdout: Buffer.alloc(2 * 1024 * 1024) }, "output-limit", {}],
    ]) {
      const fixture = createFixture({ publishReport: false });
      try {
        const calls = [];
        const result = await executeIntegrationAmendment(fixture.runDir, reportRequest(), executionOptions([behavior], calls, overrides));
        assert.equal(result.status, "diagnostic", name);
        assert.equal(result.outcome, outcome, name);
        if (name === "timeout") {
          const claim = readJson(join(fixture.runDir, "evidence", "integration-amendment.report.claim.json"));
          const receipt = readJson(join(fixture.runDir, claim.receipt_ref));
          assert.equal(claim.timeout_ms, 1000);
          assert.equal(receipt.timeout_ms, 1000);
        }
        const replay = await executeIntegrationAmendment(fixture.runDir, reportRequest(), { env: { PATH: "/fixture/bin" }, spawnFn() { throw new Error("report replay must not spawn"); } });
        assert.equal(replay.replayed, true, name);
      } finally { cleanup(fixture); }
    }

    const indeterminate = createFixture({ publishReport: false });
    try {
      await assert.rejects(executeIntegrationAmendment(indeterminate.runDir, reportRequest(), executionOptions([{ indeterminate: true }], [])), /process outcome is indeterminate/u);
      const claim = readJson(join(indeterminate.runDir, "evidence", "integration-amendment.report.claim.json"));
      assert.equal(claim.state, "unknown");
      assert.equal(claim.reason, "process-outcome-indeterminate");
    } finally { cleanup(indeterminate); }
  });

  it("rechecks execution authority at claim and receipt commit boundaries", async () => {
    const claimRace = createFixture({ publishReport: false });
    try {
      const calls = [];
      await assert.rejects(executeIntegrationAmendment(claimRace.runDir, reportRequest(), executionOptions([{ code: 1 }], calls, {
        integrationAmendmentClaimAtomicWriteHooks: {
          beforeCommit: () => git(claimRace.featureWorktree, ["commit", "--allow-empty", "-m", "claim publication drift"]),
        },
      })), (error) => /authority changed before claim publication|baseline|authority|stale/u.test(error?.cause?.message || error?.message));
      assert.equal(calls.length, 0);
      assert.equal(existsSync(join(claimRace.runDir, "evidence", "integration-amendment.report.claim.json")), false);
    } finally { cleanup(claimRace); }

    const receiptRace = createFixture({ publishReport: false });
    try {
      const calls = [];
      await assert.rejects(executeIntegrationAmendment(receiptRace.runDir, reportRequest(), executionOptions([{ code: 1 }], calls, {
        integrationAmendmentReceiptAtomicWriteHooks: {
          beforeCommit: () => git(receiptRace.featureWorktree, ["commit", "--allow-empty", "-m", "receipt publication drift"]),
        },
      })), /authority changed before receipt publication/u);
      assert.equal(calls.length, 1);
      const claim = readJson(join(receiptRace.runDir, "evidence", "integration-amendment.report.claim.json"));
      assert.equal(claim.state, "unknown");
      assert.equal(claim.reason, "authority-changed");
      assert.equal(existsSync(join(receiptRace.runDir, claim.receipt_ref)), false);
    } finally { cleanup(receiptRace); }
  });

  it("executes verification at the staged commit and maps pass and decided failure", async () => {
    for (const [code, expected] of [[0, "verified"], [1, "blocked"]]) {
      const fixture = createFixture();
      try {
        const integrated = await reachIntegrated(fixture);
        const calls = [];
        const result = await executeIntegrationAmendment(fixture.runDir, { action: "verify" }, executionOptions([{ code }], calls));
        assert.equal(result.status, expected);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.cwd, integrated.integration_amendment.integration.worktree);
        assert.equal(readJson(join(fixture.runDir, `evidence/integration-amendment-${fixture.amendmentId}.verify.claim.json`)).state, "completed");
        if (code !== 0) assert.equal(readRun(fixture).integration_amendment.blocked.origin, "integrated");
      } finally { cleanup(fixture); }
    }
  });

  it("records verification diagnostic outcomes, drift, indeterminate execution, and exact no-spawn replay", async () => {
    for (const [name, behavior, outcome, overrides] of [
      ["launch-error", { launchThrow: true }, "launch-error", {}],
      ["signal", { signal: "SIGTERM" }, "signaled", {}],
      ["timeout", { hang: true }, "timeout", { commandTimeoutMs: 1, closeTimeoutMs: 100 }],
      ["output-limit", { stderr: Buffer.alloc(2 * 1024 * 1024) }, "output-limit", {}],
    ]) {
      const fixture = createFixture();
      try {
        await reachIntegrated(fixture);
        const calls = [];
        const result = await executeIntegrationAmendment(fixture.runDir, { action: "verify" }, executionOptions([behavior], calls, overrides));
        assert.equal(result.status, "blocked", name);
        assert.equal(result.outcome, outcome, name);
        if (name === "timeout") {
          const claim = readJson(join(fixture.runDir, "evidence", `integration-amendment-${fixture.amendmentId}.verify.claim.json`));
          const receipt = readJson(join(fixture.runDir, claim.receipt_ref));
          assert.equal(claim.timeout_ms, 1000);
          assert.equal(receipt.timeout_ms, 1000);
        }
        const replay = await executeIntegrationAmendment(fixture.runDir, { action: "verify" }, { env: { PATH: "/fixture/bin" }, spawnFn() { throw new Error("verification replay must not spawn"); } });
        assert.equal(replay.status, "blocked", name);
        assert.equal(replay.replayed, true, name);
      } finally { cleanup(fixture); }
    }

    for (const [name, behavior, hooks, expected] of [
      ["process-indeterminate", { indeterminate: true }, {}, "process-outcome-indeterminate"],
      ["authority-drift", { code: 0 }, { integrationAmendmentExecutionHooks: { afterProcess: ({ authority }) => git(authority.cwd, ["commit", "--allow-empty", "-m", "verification authority drift"]) } }, "authority-changed"],
    ]) {
      const fixture = createFixture();
      try {
        await reachIntegrated(fixture);
        await assert.rejects(executeIntegrationAmendment(fixture.runDir, { action: "verify" }, executionOptions([behavior], [], hooks)), /indeterminate|authority changed/u, name);
        const claim = readJson(join(fixture.runDir, "evidence", `integration-amendment-${fixture.amendmentId}.verify.claim.json`));
        assert.equal(claim.state, "unknown", name);
        assert.equal(claim.reason, expected, name);
      } finally { cleanup(fixture); }
    }
  });

  it("fails closed across post-receipt and completed-claim closure ambiguity", async () => {
    const postReceipt = createFixture({ publishReport: false });
    try {
      await assert.rejects(executeIntegrationAmendment(postReceipt.runDir, reportRequest(), executionOptions([{ code: 1 }], [], {
        integrationAmendmentExecutionHooks: { afterReceipt: () => { throw new Error("crash-after-receipt"); } },
      })), /authority changed after receipt publication/u);
      const claim = readJson(join(postReceipt.runDir, "evidence", "integration-amendment.report.claim.json"));
      assert.equal(claim.state, "unknown");
      assert.equal(claim.receipt_status, "fail");
    } finally { cleanup(postReceipt); }

    const beforeClosure = createFixture({ publishReport: false });
    try {
      await assert.rejects(executeIntegrationAmendment(beforeClosure.runDir, reportRequest(), executionOptions([{ code: 1 }], [], {
        integrationAmendmentCompletedClaimAtomicWriteHooks: { beforeCommit: () => { throw new Error("before-closure"); } },
      })), /claim closure is indeterminate/u);
      assert.equal(readJson(join(beforeClosure.runDir, "evidence", "integration-amendment.report.claim.json")).state, "unknown");
    } finally { cleanup(beforeClosure); }

    const afterClosure = createFixture({ publishReport: false });
    try {
      await assert.rejects(executeIntegrationAmendment(afterClosure.runDir, reportRequest(), executionOptions([{ code: 1 }], [], {
        integrationAmendmentCompletedClaimAtomicWriteHooks: { afterCommit: () => { throw new Error("after-closure"); } },
      })), /closure published but completion acknowledgement is indeterminate/u);
      assert.equal(readJson(join(afterClosure.runDir, "evidence", "integration-amendment.report.claim.json")).state, "completed");
      const replay = await executeIntegrationAmendment(afterClosure.runDir, reportRequest(), { env: { PATH: "/fixture/bin" }, spawnFn() { throw new Error("completed closure replay must not spawn"); } });
      assert.equal(replay.status, "reported");
      assert.equal(replay.replayed, true);
    } finally { cleanup(afterClosure); }
  });

});

function applyAc3ParentClass(run, fixture, parentClass, terminalPrecondition) {
  const manifestHash = sha("current checkpoint routing manifest");
  const manifestRef = `artifacts/checkpoint-routing-${manifestHash.slice("sha256:".length)}.json`;
  if (parentClass === "checkpoint-child") {
    run.base_ref = "refs/remotes/origin/main";
    run.base_commit = fixture.base;
    run.checkpoint_source = {
      schema_version: 1,
      kind: "delivery-checkpoint-source",
      parent_run_id: "checkpoint-parent",
      manifest_ref: manifestRef,
      manifest_hash: manifestHash,
      checkpoint_id: "checkpoint-001",
      checkpoint_ordinal: 1,
      root_child_run_id: run.run_id,
      source_plan_ref: "plan/slices.json",
      source_plan_hash: run.steps[0].acceptance.artifact_hash,
      source_review_ref: "reviews/work-decomposer.json",
      source_review_hash: run.steps[0].acceptance.review_hash,
      source_review_attempt: run.steps[0].attempts,
      parent_review_identity_hash: sha("current parent review identity"),
      child_disposition_hash: run.steps[0].acceptance.review_hash,
      admission_probe_hash: sha("current admission probe"),
      brief_scope_hash: sha("current brief scope"),
      child_plan_hash: run.steps[0].acceptance.artifact_hash,
      acceptance_mapping_hash: sha("current acceptance mapping"),
      initial_base_ref: "refs/remotes/origin/main",
      initial_base_commit: fixture.base,
    };
  }
  if (parentClass === "checkpoint-router") {
    run.checkpoint_progress = {
      schema_version: 1,
      kind: "delivery-checkpoint-progress",
      manifest_ref: manifestRef,
      manifest_hash: manifestHash,
      status: "active",
      entries: [],
      final_closure: null,
    };
    run.status = "blocked";
    run.pr_url = null;
    run.terminal_result = {
      status: "blocked",
      run_id: run.run_id,
      pr_url: null,
      reason: "oversized-plan-checkpoint-routing-required",
      summary: "Resume checkpoint publication.",
      artifacts: { checkpoint_routing: manifestRef },
    };
    return;
  }
  if (terminalPrecondition === "terminal") {
    run.status = "blocked";
    run.terminal_result = { status: "blocked", run_id: run.run_id, pr_url: null, reason: "repair rejected", summary: "Continue elsewhere.", artifacts: {} };
  }
}

function ac3ExpectedError(parentClass, terminalPrecondition, reviewSource) {
  if (parentClass !== "ordinary") return "integration-amendment-continuation-unsupported";
  if (terminalPrecondition === "terminal") return "integration amendment requires a running run";
  if (reviewSource === "stale") return "accepted work-decomposer review bytes changed after acceptance";
  return "integration-amendment-consumer-not-pristine-pending";
}
