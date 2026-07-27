import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { completeSliceBuilderTaskDispatch, prepareSliceBuilderTaskDispatch, transitionGateDecision, transitionIntegrationAmendment, transitionRunJson, transitionRunSlice, transitionSliceMerged, transitionSteeringBoundaryOpened } from "../src/run-state.js";
import { checkRunConsistency } from "../src/validate.js";
import { executeIntegrationAmendment } from "../src/factory.js";
import { FEATURE_BRANCH, NOW, RUN_ID, addAcceptedTechnicalBrief, advanceMergedAmendmentConsumer, bindAmendmentDispatch, blocked, cleanup, cleanupFixtures, commitCandidate, createFixture, executionOptions, git, publishAmendmentReview, publishConsumerReview, reachIntegrated, reachMerged, readJson, readRun, reportRequest, snapshotRuntimeFiles, writeJson, writeVerification } from "./helpers/integration-amendment/fixture.js";

after(cleanupFixtures);

describe("generic integration amendment lifecycle and execution", () => {
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
