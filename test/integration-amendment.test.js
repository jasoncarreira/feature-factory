import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { execFileSync } from "./helpers/git-fixture.js";
import { withDeliveryEnvelope, passingInvariantFamilyLedger, writeVerificationArtifactReceipt } from "./helpers/delivery-envelope-fixture.js";
import { createSliceAttemptReview, createSliceReviewRecord } from "./helpers/review-record-fixture.js";
import { DURABLE_AUTHORITY_CATALOG, DURABLE_AUTHORITY_REQUIRED_RECORD_IDS, emitDurableRecordMutations } from "./helpers/durable-record-mutations.js";
import { hashFile, hashValue } from "../src/refs.js";
import { completeIntegrationAmendmentReviewTaskDispatch, completeSliceBuilderTaskDispatch, completeSpecialBuilderTaskDispatch, createPostPrState, hasInFlightHeartbeatWork, heartbeatOnce, inspectContinuationRouteSchema, prepareIntegrationAmendmentReviewTaskDispatch, prepareSliceBuilderTaskDispatch, prepareSpecialBuilderTaskDispatch, transitionContinuationAdoption, transitionGateDecision, transitionIntegrationAmendment, transitionMergedSliceRepair, transitionPanelVerdicts, transitionPostPrState, transitionPrCreated, transitionRunJson, transitionRunSlice, transitionRunStep, transitionSliceMerged, transitionSteeringBoundaryOpened, transitionTerminalResult } from "../src/run-state.js";
import { checkRunConsistency, inspectIntegrationAmendmentInventory, integrationAmendmentId, validateIntegrationAmendment, validateIntegrationAmendmentExecutionClaim, validateIntegrationAmendmentExecutionReceipt, validateIntegrationAmendmentReview, validateRun } from "../src/validate.js";
import { buildContinuation, cleanupRun, continueFactory, executeIntegrationAmendment, recordReviewDispatchProvenance, recoverDisruptedRun, resumeFactory, startHeartbeat, stopHeartbeat } from "../src/factory.js";
import plugin from "../src/plugin.js";

const RUN_ID = "amendment-run";
const FEATURE_BRANCH = "amendment-feature";
const NOW = "2026-07-20T12:00:00.000Z";
const fixtures = [];
const PR79_GENERIC_PARITY = [
  [1, "report eligibility", "checked failure execution and report admission"],
  [2, "ratified ownership and overlap", "current effective-owner observation"],
  [3, "quiescence and attempt ceiling", "build transition"],
  [4, "special dispatch derivation", "generic prepare/complete route"],
  [5, "heartbeat dispatch fence", "heartbeat pre-mutation check"],
  [6, "abbreviated commit", "full-SHA review binding"],
  [7, "changed paths and write-once review", "Git path observation/create-only review"],
  [8, "resulting feature head", "staged verify then feature CAS"],
  [9, "unresolved resume fence", "resume projection"],
  [10, "blocked terminalization", "checked block then terminal boundary"],
  [11, "exact-file lanes", "effective ownership matcher"],
  [12, "exact reviewed commit", "dispatch closure/review binding"],
  [13, "divergent merge tree", "reviewed/integration tree proof"],
  [14, "stale verdict or attempt", "external review consumer"],
  [15, "rename source", "no-renames two-endpoint path set"],
  [16, "frozen owner authority", "plan/owner reobservation"],
  [17, "original evidence drift", "failure claim/receipt rehash"],
  [18, "canonical lane text", "path normalization"],
  [19, "unsupported globs", "accepted plan/lane validator"],
  [20, "slice quiescence", "slice start/merge fences"],
  [21, "step fence", "step/test-verifier fences"],
  [22, "gate fence", "gate boundary/decision fences"],
  [23, "post-PR exclusion", "canonical actual-authority predicate"],
  [24, "pre-integration admission", "test/panel/gate/fence/PR absence"],
  [25, "heartbeat work", "building/review wait classification"],
  [26, "consistency drift", "sidecar/Git consistency consumers"],
  [27, "generic mutation denial", "scoped run-writer guard"],
  [28, "sidecar/Git publication races", "deterministic pre/post effect hooks"],
].map(([id, category, sink]) => ({ id, category, sink }));

describe("generic integration amendment", () => {
  it("ports all 28 PR #79 adversarial categories through their generic production sinks", async (t) => {
    assert.deepEqual(PR79_GENERIC_PARITY.map(({ id }) => id), Array.from({ length: 28 }, (_, index) => index + 1));
    assert.equal(new Set(PR79_GENERIC_PARITY.map(({ category }) => category)).size, 28);
    assert.equal(new Set(PR79_GENERIC_PARITY.map(({ sink }) => sink)).size, 28);
    for (const row of PR79_GENERIC_PARITY) {
      await t.test(`${row.id}. ${row.category} -> ${row.sink}`, () => exerciseGenericParity(row.id));
    }
  });

  it("routes every emitted mutation for all 46 activated amendment rows through exact production consumers", async () => {
    const ids = DURABLE_AUTHORITY_REQUIRED_RECORD_IDS["pr79-merged-slice-repair"]
      .filter((id) => id.startsWith("amendment-") && !id.startsWith("amendment-review-dispatch-"));
    const records = DURABLE_AUTHORITY_CATALOG.flatMap(({ records: rows }) => rows);
    const executed = new Set();
    assert.equal(ids.length, 46);

    for (const id of ids) {
      const record = records.find((row) => row.id === id);
      assert.ok(record, `${id} registered catalog row`);
      const cases = emitDurableRecordMutations(record.source, record.descriptor, record.externalSources);
      const rejected = id.startsWith("amendment-report-claim-") || id.startsWith("amendment-verify-claim-")
        ? await exerciseExecutionClaimMutations(record, cases)
        : id.startsWith("amendment-report-receipt-") || id.startsWith("amendment-verify-receipt-")
          ? await exerciseExecutionReceiptMutations(record, cases)
          : id === "amendment-review-approve" || id === "amendment-review-reject"
            ? await exerciseAmendmentReviewMutations(record, cases)
            : id.startsWith("amendment-dispatch-")
              ? await exerciseBuilderDispatchMutations(record, cases)
              : await exerciseManifestMutations(record, cases);
      assert.deepEqual(rejected, cases.map(({ name }) => name), `${id} exact generated rejection inventory`);
      for (const name of rejected) {
        assert.equal(executed.has(name), false, `duplicate production mutation execution ${name}`);
        executed.add(name);
      }
    }

    const expected = ids.flatMap((id) => {
      const record = records.find((row) => row.id === id);
      return emitDurableRecordMutations(record.source, record.descriptor, record.externalSources).map(({ name }) => name);
    });
    assert.equal(expected.length, 788, "closed 46-row emitted mutation count");
    assert.equal(executed.size, 788, "every emitted mutation must reach a rejecting production consumer");
    assert.deepEqual([...executed], expected);
  });

  it("validates all 16 closed manifest variants", () => {
    const base = manifestFixture();
    const building1 = buildingAttempt(1, base.admission.baseline_commit);
    const approve1 = reviewedAttempt(1, base.admission.baseline_commit);
    const reject1 = reviewedAttempt(1, base.admission.baseline_commit);
    const building2 = buildingAttempt(2, reject1.reviewed_commit);
    const approve2 = reviewedAttempt(2, reject1.reviewed_commit);
    const reject2 = reviewedAttempt(2, reject1.reviewed_commit);
    const variants = [
      { ...base, status: "reported", attempts: [] },
      { ...base, status: "building", attempts: [building1] },
      { ...base, status: "building", attempts: [reject1, building2] },
      { ...base, status: "reviewed", attempts: [approve1] },
      { ...base, status: "reviewed", attempts: [reject1] },
      { ...base, status: "reviewed", attempts: [reject1, reject2] },
      { ...base, status: "reviewed", attempts: [reject1, approve2] },
      { ...base, status: "integrated", attempts: [approve1], integration: integrationFixture(base, approve1) },
      { ...base, status: "verified", attempts: [approve1], integration: integrationFixture(base, approve1), verification: verificationBinding(base.amendment_id) },
      { ...base, status: "merged", attempts: [approve1], integration: integrationFixture(base, approve1), verification: verificationBinding(base.amendment_id), publication: publicationFixture(base) },
      blocked(base, [], "reported"),
      blocked(base, [building1], "building"),
      blocked(base, [approve1], "reviewed-approve"),
      blocked(base, [reject1], "reviewed-reject"),
      { ...blocked(base, [approve1], "integrated"), integration: integrationFixture(base, approve1) },
      { ...blocked(base, [approve1], "verified"), integration: integrationFixture(base, approve1), verification: verificationBinding(base.amendment_id) },
    ];
    assert.equal(variants.length, 16);
    for (const variant of variants) assert.equal(validateIntegrationAmendment(variant), variant);
    assert.throws(() => validateIntegrationAmendment({ ...base, unknown: true }), /unknown: is not allowed/u);
    assert.throws(() => validateIntegrationAmendment({ ...base, attempts: [buildingAttempt(2, base.admission.baseline_commit)], status: "building" }), /must equal 1/u);
    assert.throws(() => validateIntegrationAmendment({ ...blocked(base, [], "integrated"), integration: integrationFixture(base, approve1) }), /requires a reviewed APPROVE-capable attempt/u);
    assert.throws(() => validateIntegrationAmendment({ ...blocked(base, [], "verified"), integration: integrationFixture(base, approve1), verification: verificationBinding(base.amendment_id) }), /requires a reviewed APPROVE-capable attempt/u);
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

  it("keeps the authorized baseline through a valid pristine first dispatch and retry", async () => {
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
      await publishConsumerReview(fixture, { attempt: 2, reviewedCommit: secondHead });

      git(fixture.featureWorktree, ["merge", "--no-ff", branch, "-m", "merge retried consumer"]);
      const mergeCommit = git(fixture.featureWorktree, ["rev-parse", "HEAD"]).trim();
      const merged = await transitionSliceMerged(fixture.runDir, "consumer", { merge_commit: mergeCommit }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(merged.slice.authorized_baseline_commit, integrationCommit);
      assert.equal(merged.slice.attempt_reviews[0].diff_base_commit, integrationCommit);
      assert.equal(merged.slice.attempt_reviews[1].diff_base_commit, integrationCommit);
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

  it("derives and closes the checked owner-stack integration-amendment dispatch", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      const attempt = built.integration_amendment.attempts[0];
      const context = await prepareSpecialBuilderTaskDispatch(fixture.repo, { run_id: RUN_ID, route: "integration-amendment", agent: "backend-builder" }, {
        repoRoot: fixture.repo, claimDispatch: true, completionToken: "process-local-capability", now: NOW,
      });
      assert.equal(context.target.branch, attempt.branch_ref.slice("refs/heads/".length));
      assert.equal(context.target.worktree, attempt.worktree);
      assert.equal(context.target.head, attempt.build_base_commit);
      assert.equal(context.authority.owner.id, "owner");
      assert.deepEqual(context.authority.path_policy, { effective_paths: ["src/owner/**"], expansion_allowed: false });

      const candidate = commitCandidate(attempt.worktree);
      const closed = await completeSpecialBuilderTaskDispatch(fixture.repo, {
        run_id: RUN_ID, route: "integration-amendment", agent: "backend-builder",
        claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash, completion_token: "process-local-capability",
      }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(closed.completion_head, candidate);
      const run = readRun(fixture);
      assert.equal(run.special_builder_dispatch.completion_head, candidate);
      assert.equal(run.special_builder_dispatch.closure_ref, closed.closure_ref);
    } finally { cleanup(fixture); }
  });

  it("replays special builder claim and closure crash boundaries without changing authority", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      const marker = { run_id: RUN_ID, route: "integration-amendment", agent: "backend-builder" };
      await assert.rejects(prepareSpecialBuilderTaskDispatch(fixture.repo, marker, {
        repoRoot: fixture.repo, claimDispatch: true, completionToken: "special-crash-token", now: NOW,
        specialDispatchClaimAtomicWriteHooks: { afterCommit: () => { throw new Error("crash-after-special-claim"); } },
      }), /crash-after-special-claim/u);
      const context = await prepareSpecialBuilderTaskDispatch(fixture.repo, marker, {
        repoRoot: fixture.repo, claimDispatch: true, completionToken: "special-crash-token", now: NOW,
      });
      const candidate = commitCandidate(built.integration_amendment.attempts[0].worktree);
      const completion = { ...marker, claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash, completion_token: "special-crash-token" };
      await assert.rejects(completeSpecialBuilderTaskDispatch(fixture.repo, completion, {
        repoRoot: fixture.repo, now: NOW,
        specialDispatchClosureAtomicWriteHooks: { beforeCommit: () => { throw new Error("crash-before-special-closure"); } },
      }), (error) => /crash-before-special-closure/u.test(error?.cause?.message || error?.message));
      await assert.rejects(completeSpecialBuilderTaskDispatch(fixture.repo, completion, {
        repoRoot: fixture.repo, now: NOW,
        specialDispatchClosureAtomicWriteHooks: { afterCommit: () => { throw new Error("crash-after-special-closure"); } },
      }), /crash-after-special-closure/u);
      const closed = await completeSpecialBuilderTaskDispatch(fixture.repo, completion, { repoRoot: fixture.repo, now: NOW });
      assert.equal(closed.completion_head, candidate);
      assert.equal(readRun(fixture).special_builder_dispatch.completion_head, candidate);
    } finally { cleanup(fixture); }
  });

  it("accepts reviews only through the exact fresh synchronous work-reviewer callback", async () => {
    const skipped = createFixture();
    try {
      await transitionIntegrationAmendment(skipped.runDir, reportRequest(), { repoRoot: skipped.repo, now: NOW });
      const built = await transitionIntegrationAmendment(skipped.runDir, { action: "build", attempt: 1 }, { repoRoot: skipped.repo, now: NOW });
      const candidate = commitCandidate(built.integration_amendment.attempts[0].worktree);
      bindAmendmentDispatch(skipped, candidate);
      await assert.rejects(transitionIntegrationAmendment(skipped.runDir, { action: "review" }, { repoRoot: skipped.repo, now: NOW }), /closed-unconsumed reviewer authority|reviewer claim|review publication provenance|missing reviews ref/u);
    } finally { cleanup(skipped); }

    const precreated = createFixture();
    try {
      await transitionIntegrationAmendment(precreated.runDir, reportRequest(), { repoRoot: precreated.repo, now: NOW });
      const built = await transitionIntegrationAmendment(precreated.runDir, { action: "build", attempt: 1 }, { repoRoot: precreated.repo, now: NOW });
      const candidate = commitCandidate(built.integration_amendment.attempts[0].worktree);
      bindAmendmentDispatch(precreated, candidate);
      const amendment = readRun(precreated).integration_amendment;
      writeJson(join(precreated.runDir, "reviews", `integration-amendment-${amendment.amendment_id}.attempt-1.json`), { forged: true });
      await assert.rejects(prepareIntegrationAmendmentReviewTaskDispatch(precreated.repo, reviewMarker(amendment), {
        claimDispatch: true, completionToken: "precreated-token", now: NOW,
      }), /already exists before checked reviewer dispatch|unknown sidecar|orphaned without its claim/u);
    } finally { cleanup(precreated); }

    const callback = createFixture();
    try {
      await transitionIntegrationAmendment(callback.runDir, reportRequest(), { repoRoot: callback.repo, now: NOW });
      const built = await transitionIntegrationAmendment(callback.runDir, { action: "build", attempt: 1 }, { repoRoot: callback.repo, now: NOW });
      const candidate = commitCandidate(built.integration_amendment.attempts[0].worktree);
      bindAmendmentDispatch(callback, candidate);
      const amendment = readRun(callback).integration_amendment;
      const instance = await plugin({ directory: callback.repo });
      const identity = { tool: "task", sessionID: "review-session", callID: "review-call" };
      const task = { args: { subagent_type: "work-reviewer", prompt: amendmentReviewPrompt(amendment) } };
      await instance["tool.execute.before"](identity, task);
      const context = checkedReviewPromptContext(task.args.prompt);
      assert.equal(context.candidate_commit, candidate);
      assert.deepEqual(context.ownership.map(({ id }) => id), ["owner", "consumer"]);
      await assert.rejects(instance["tool.execute.after"]({ ...identity, args: { ...task.args, subagent_type: "security-reviewer" } }, {
        output: JSON.stringify(reviewFromContext(context, "APPROVE", [])), metadata: {},
      }), /cross-role|callback identity/u);
      assert.equal(existsSync(join(callback.runDir, context.review_ref)), false);
      await instance["tool.execute.after"]({ ...identity, args: task.args }, {
        output: JSON.stringify(reviewFromContext(context, "APPROVE", [])), metadata: {},
      });
      assert.equal(existsSync(join(callback.runDir, context.review_ref)), false, "a rejected callback must destroy pending reviewer capability");
    } finally { cleanup(callback); }
  });

  it("classifies reviewer effects and fences every semantic action until exact review consumption", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      bindAmendmentDispatch(fixture, commitCandidate(built.integration_amendment.attempts[0].worktree));
      const amendment = readRun(fixture).integration_amendment;
      const marker = reviewMarker(amendment);
      const context = await prepareIntegrationAmendmentReviewTaskDispatch(fixture.repo, marker, {
        claimDispatch: true, completionToken: "effect-token", now: NOW,
      });
      assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, "active-claim-only");
      for (const request of [{ action: "block", reason: "must not bypass" }, { action: "build", attempt: 1 }, { action: "integrate" }, { action: "review" }]) {
        await assert.rejects(transitionIntegrationAmendment(fixture.runDir, request, { repoRoot: fixture.repo, now: NOW }), /reviewer effect is active-claim-only|closed-unconsumed reviewer authority/u);
      }

      const review = reviewFromContext(context, "APPROVE", []);
      await assert.rejects(completeIntegrationAmendmentReviewTaskDispatch(fixture.repo, {
        ...marker, claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash,
        completion_token: "effect-token", output: JSON.stringify(review),
      }, {
        now: NOW,
        amendmentReviewClosureAtomicWriteHooks: { beforeCommit: () => { throw new Error("closure-publication-paused"); } },
      }), (error) => /closure-publication-paused/u.test(error?.cause?.message || error?.message));
      const reviewPath = join(fixture.runDir, context.review_ref);
      const reviewBytes = readFileSync(reviewPath);
      assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, "review-published-without-closure");
      await assert.rejects(prepareIntegrationAmendmentReviewTaskDispatch(fixture.repo, marker, {
        claimDispatch: true, completionToken: "replacement-token", now: NOW,
      }), /reviewer effect is review-published-without-closure/u);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "block", reason: "must not bypass" }, { repoRoot: fixture.repo, now: NOW }), /reviewer effect is review-published-without-closure/u);

      await completeIntegrationAmendmentReviewTaskDispatch(fixture.repo, {
        ...marker, claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash,
        completion_token: "effect-token", output: JSON.stringify(review),
      }, { now: NOW });
      assert.deepEqual(readFileSync(reviewPath), reviewBytes);
      assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, "closed-unconsumed");
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "block", reason: "must not bypass" }, { repoRoot: fixture.repo, now: NOW }), /reviewer effect is closed-unconsumed/u);
      const consumed = await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(consumed.integration_amendment.status, "reviewed");
      assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, "consumed");
    } finally { cleanup(fixture); }
  });

  it("replays review and closure publication ambiguity without overwriting bytes", async () => {
    for (const [name, hooks, expectedState] of [
      ["review-publication", { amendmentReviewPublicationAtomicWriteHooks: { afterCommit: () => { throw new Error("after-review-publication"); } } }, "review-published-without-closure"],
      ["closure-publication", { amendmentReviewClosureAtomicWriteHooks: { afterCommit: () => { throw new Error("after-closure-publication"); } } }, "closed-unconsumed"],
    ]) {
      const fixture = createFixture();
      try {
        await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
        const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
        bindAmendmentDispatch(fixture, commitCandidate(built.integration_amendment.attempts[0].worktree));
        const amendment = readRun(fixture).integration_amendment;
        const marker = reviewMarker(amendment);
        const token = `${name}-token`;
        const context = await prepareIntegrationAmendmentReviewTaskDispatch(fixture.repo, marker, { claimDispatch: true, completionToken: token, now: NOW });
        const review = reviewFromContext(context, "APPROVE", []);
        const completion = { ...marker, claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash, completion_token: token, output: JSON.stringify(review) };
        await assert.rejects(completeIntegrationAmendmentReviewTaskDispatch(fixture.repo, completion, { now: NOW, ...hooks }), new RegExp(`after-${name}`, "u"));
        assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, expectedState, name);
        const reviewBytes = readFileSync(join(fixture.runDir, context.review_ref));
        const closurePath = join(fixture.runDir, context.dispatch_claim.closure_ref);
        const closureBytes = existsSync(closurePath) ? readFileSync(closurePath) : null;
        const replay = await completeIntegrationAmendmentReviewTaskDispatch(fixture.repo, completion, { now: NOW });
        assert.equal(replay.replayed, true, name);
        assert.deepEqual(readFileSync(join(fixture.runDir, context.review_ref)), reviewBytes, `${name} review bytes`);
        if (closureBytes) assert.deepEqual(readFileSync(closurePath), closureBytes, `${name} closure bytes`);
      } finally { cleanup(fixture); }
    }
  });

  it("retains the real plugin callback only for exact review or closure publication ambiguity", async () => {
    for (const [name, hookName, expectedState] of [
      ["review", "amendmentReviewPublicationAtomicWriteHooks", "review-published-without-closure"],
      ["closure", "amendmentReviewClosureAtomicWriteHooks", "closed-unconsumed"],
    ]) {
      const fixture = createFixture();
      try {
        await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
        const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
        bindAmendmentDispatch(fixture, commitCandidate(built.integration_amendment.attempts[0].worktree));
        const amendment = readRun(fixture).integration_amendment;
        const instance = await plugin({ directory: fixture.repo }, {
          dispatchLockOptions: {
            now: NOW,
            [hookName]: { afterCommit: () => { throw new Error(`plugin-after-${name}-publication`); } },
          },
        });
        const identity = { tool: "task", sessionID: `${name}-ambiguity-session`, callID: `${name}-ambiguity-call` };
        const task = { args: { subagent_type: "work-reviewer", prompt: amendmentReviewPrompt(amendment) } };
        await instance["tool.execute.before"](identity, task);
        const context = checkedReviewPromptContext(task.args.prompt);
        const result = { output: JSON.stringify(reviewFromContext(context, "APPROVE", [])), metadata: {} };

        await assert.rejects(instance["tool.execute.after"]({ ...identity, args: task.args }, result), new RegExp(`plugin-after-${name}-publication`, "u"));
        assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, expectedState);
        const reviewPath = join(fixture.runDir, context.review_ref);
        const closurePath = join(fixture.runDir, context.dispatch_claim.closure_ref);
        const reviewBytes = readFileSync(reviewPath);
        const closureBytes = existsSync(closurePath) ? readFileSync(closurePath) : null;

        await instance["tool.execute.after"]({ ...identity, args: task.args }, result);
        assert.deepEqual(readFileSync(reviewPath), reviewBytes, `${name} replay must not replace review bytes`);
        if (closureBytes) assert.deepEqual(readFileSync(closurePath), closureBytes, `${name} replay must not replace closure bytes`);
        assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, "closed-unconsumed");

        const completedReviewBytes = readFileSync(reviewPath);
        const completedClosureBytes = readFileSync(closurePath);
        await instance["tool.execute.after"]({ ...identity, args: task.args }, result);
        assert.deepEqual(readFileSync(reviewPath), completedReviewBytes, `${name} completed callback must be deleted`);
        assert.deepEqual(readFileSync(closurePath), completedClosureBytes, `${name} completed closure must be immutable`);
      } finally { cleanup(fixture); }
    }
  });

  it("rejects orphan reviewer review and closure sidecars", async () => {
    for (const kind of ["review", "closure"]) {
      const fixture = createFixture();
      try {
        await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
        const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
        bindAmendmentDispatch(fixture, commitCandidate(built.integration_amendment.attempts[0].worktree));
        const amendment = readRun(fixture).integration_amendment;
        const name = createHash("sha256").update(`${RUN_ID}\0integration-amendment-review\0${amendment.amendment_id}\0${1}`, "utf8").digest("hex");
        if (kind === "review") writeJson(join(fixture.runDir, "reviews", `integration-amendment-${amendment.amendment_id}.attempt-1.json`), { orphan: true });
        else writeJson(join(fixture.runDir, "dispatch", `${name}.amendment-review.closed.json`), { kind: "checked-integration-amendment-review-dispatch-closure" });
        assert.throws(() => inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)), /orphan/u, kind);
      } finally { cleanup(fixture); }
    }
  });

  it("consumes a successful real plugin reviewer callback", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      bindAmendmentDispatch(fixture, commitCandidate(built.integration_amendment.attempts[0].worktree));
      const amendment = readRun(fixture).integration_amendment;
      const instance = await plugin({ directory: fixture.repo });
      const identity = { tool: "task", sessionID: "successful-review-session", callID: "successful-review-call" };
      const task = { args: { subagent_type: "work-reviewer", prompt: amendmentReviewPrompt(amendment) } };
      await instance["tool.execute.before"](identity, task);
      const context = checkedReviewPromptContext(task.args.prompt);
      await instance["tool.execute.after"]({ ...identity, args: task.args }, { output: JSON.stringify(reviewFromContext(context, "APPROVE", [])), metadata: {} });
      assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, "closed-unconsumed");
      const reviewed = await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(reviewed.integration_amendment.status, "reviewed");
      assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)).review_effect.classification, "consumed");
    } finally { cleanup(fixture); }
  });

  it("create-publishes one review, exact-replays without overwrite, and rejects stale callback authority", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      const candidate = commitCandidate(built.integration_amendment.attempts[0].worktree);
      bindAmendmentDispatch(fixture, candidate);
      const published = await publishAmendmentReview(fixture, "APPROVE", []);
      const reviewPath = join(fixture.runDir, published.context.review_ref);
      const before = readFileSync(reviewPath);
      const replay = await completeIntegrationAmendmentReviewTaskDispatch(fixture.repo, {
        ...reviewMarker(readRun(fixture).integration_amendment), claim_ref: published.context.dispatch_claim.ref,
        claim_hash: published.context.dispatch_claim.hash, completion_token: "review-token-1", output: JSON.stringify(published.review),
      }, { now: NOW });
      assert.equal(replay.replayed, true);
      assert.deepEqual(readFileSync(reviewPath), before);
      await assert.rejects(completeIntegrationAmendmentReviewTaskDispatch(fixture.repo, {
        ...reviewMarker(readRun(fixture).integration_amendment), claim_ref: published.context.dispatch_claim.ref,
        claim_hash: published.context.dispatch_claim.hash, completion_token: "review-token-1",
        output: JSON.stringify({ ...published.review, verdict: "REJECT", required_fixes: ["different"] }),
      }, { now: NOW }), /conflicts with preexisting bytes|existing closure/u);
      assert.deepEqual(readFileSync(reviewPath), before);
    } finally { cleanup(fixture); }

    const stale = createFixture();
    try {
      await transitionIntegrationAmendment(stale.runDir, reportRequest(), { repoRoot: stale.repo, now: NOW });
      const built = await transitionIntegrationAmendment(stale.runDir, { action: "build", attempt: 1 }, { repoRoot: stale.repo, now: NOW });
      const candidate = commitCandidate(built.integration_amendment.attempts[0].worktree);
      bindAmendmentDispatch(stale, candidate);
      const amendment = readRun(stale).integration_amendment;
      const context = await prepareIntegrationAmendmentReviewTaskDispatch(stale.repo, reviewMarker(amendment), { claimDispatch: true, completionToken: "stale-token", now: NOW });
      commitCandidate(built.integration_amendment.attempts[0].worktree);
      await assert.rejects(completeIntegrationAmendmentReviewTaskDispatch(stale.repo, {
        ...reviewMarker(amendment), claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash,
        completion_token: "stale-token", output: JSON.stringify(reviewFromContext(context, "APPROVE", [])),
      }, { now: NOW }), /worktree authority is stale|context changed|branch\/worktree authority/u);
    } finally { cleanup(stale); }
  });

  it("rejects stale attempt-2 prior fixes after reviewer dispatch", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      let result = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      bindAmendmentDispatch(fixture, commitCandidate(result.integration_amendment.attempts[0].worktree));
      await publishAmendmentReview(fixture, "REJECT", ["original exact fix"]);
      await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
      result = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 2 }, { repoRoot: fixture.repo, now: NOW });
      bindAmendmentDispatch(fixture, commitCandidate(result.integration_amendment.attempts[1].worktree));
      const amendment = readRun(fixture).integration_amendment;
      const context = await prepareIntegrationAmendmentReviewTaskDispatch(fixture.repo, reviewMarker(amendment), { claimDispatch: true, completionToken: "attempt-2-token", now: NOW });
      const priorPath = join(fixture.runDir, amendment.attempts[0].review_ref);
      const prior = readJson(priorPath);
      prior.required_fixes = ["changed after dispatch"];
      writeJson(priorPath, prior);
      await assert.rejects(completeIntegrationAmendmentReviewTaskDispatch(fixture.repo, {
        ...reviewMarker(amendment), claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash,
        completion_token: "attempt-2-token", output: JSON.stringify(reviewFromContext(context, "APPROVE", [])),
      }, { now: NOW }), /prior|review|authority|hash is stale/u);
      assert.equal(existsSync(join(fixture.runDir, context.review_ref)), false);
    } finally { cleanup(fixture); }
  });

  it("enforces sole all-slice ownership for exact and recursive lanes", async () => {
    const exact = createFixture({ ownerPaths: ["src/owner/api.js"] });
    try {
      await transitionIntegrationAmendment(exact.runDir, reportRequest(), { repoRoot: exact.repo, now: NOW });
      const built = await transitionIntegrationAmendment(exact.runDir, { action: "build", attempt: 1 }, { repoRoot: exact.repo, now: NOW });
      bindAmendmentDispatch(exact, commitCandidate(built.integration_amendment.attempts[0].worktree));
      await publishAmendmentReview(exact, "APPROVE", []);
      const reviewed = await transitionIntegrationAmendment(exact.runDir, { action: "review" }, { repoRoot: exact.repo, now: NOW });
      assert.deepEqual(reviewed.integration_amendment.attempts[0].changed_paths, ["src/owner/api.js"]);
    } finally { cleanup(exact); }

    for (const [name, fixtureOptions, changedPath] of [
      ["direct-consumer", { consumerPaths: ["src/consumer/**", "src/owner/consumer.js"] }, "src/owner/consumer.js"],
      ["unrelated-sibling", { extraSlices: [{ id: "sibling", effective_paths: ["src/owner/sibling.js"] }] }, "src/owner/sibling.js"],
      ["recursive-overlap", { extraSlices: [{ id: "sibling", effective_paths: ["src/owner/nested/**"] }] }, "src/owner/nested/value.js"],
    ]) {
      const fixture = createFixture(fixtureOptions);
      try {
        await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
        const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
        const candidate = commitCandidatePath(built.integration_amendment.attempts[0].worktree, changedPath, name);
        bindAmendmentDispatch(fixture, candidate);
        await assert.rejects(prepareIntegrationAmendmentReviewTaskDispatch(fixture.repo, reviewMarker(readRun(fixture).integration_amendment), {
          claimDispatch: true, completionToken: `${name}-token`, now: NOW,
        }), /not solely owned by admitted owner/u, name);
      } finally { cleanup(fixture); }
    }
  });

  it("fences lifecycle effects after claim publication and for every nonmerged manifest", async () => {
    const claimed = createFixture({ publishReport: false });
    try {
      await assert.rejects(executeIntegrationAmendment(claimed.runDir, reportRequest(), executionOptions([{ code: 1 }], [], {
        integrationAmendmentExecutionHooks: {
          afterClaim: async () => startHeartbeat(RUN_ID, { phase: "amendment-race" }, { cwd: claimed.repo }),
        },
      })), /heartbeat start rejected: integration amendment authority is active-claim-only/u);
      assert.equal(readJson(join(claimed.runDir, "evidence", "integration-amendment.report.claim.json")).state, "active");
    } finally { cleanup(claimed); }

    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      await assert.rejects(resumeFactory(RUN_ID, { cwd: fixture.repo, dryRun: true }), /integration amendment authority is reported/u);
      await assert.rejects(cleanupRun(RUN_ID, { cwd: fixture.repo, force: true }), /cleanup rejected: integration amendment authority is reported/u);
      await assert.rejects(startHeartbeat(RUN_ID, { phase: "amendment" }, { cwd: fixture.repo }), /heartbeat start rejected: integration amendment authority is reported/u);
    } finally { cleanup(fixture); }
  });

  it("fences continuation construction, reservation/allocation/publication ingress, adoption, route replay, local resume, and provenance", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      const beforeRefs = git(fixture.repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/opencode/continuation-targets", "refs/opencode/continuations"]);
      for (const operation of [
        () => buildContinuation(RUN_ID, { cwd: fixture.repo, runId: "amendment-child", review: "reviews/owner.json" }),
        () => continueFactory(RUN_ID, { cwd: fixture.repo, runId: "amendment-child", review: "reviews/owner.json", carryForward: true }),
        () => inspectContinuationRouteSchema(fixture.repo, RUN_ID, 1, { route: "continuation" }),
        () => inspectContinuationRouteSchema(fixture.repo, RUN_ID, 1, { route: "resume", ordinaryResumeSchema: 1 }),
        () => transitionContinuationAdoption(fixture.runDir, { repoRoot: fixture.repo }),
        () => resumeFactory(RUN_ID, { cwd: fixture.repo, dryRun: true }),
        () => recordReviewDispatchProvenance(RUN_ID, { agent: "work-reviewer", subject: "amendment-review", attempt: 1, promptHash: sha("prompt"), promptBytes: 6 }, { cwd: fixture.repo }),
      ]) await assert.rejects(Promise.resolve().then(operation), /integration-amendment-continuation-unsupported|integration amendment (?:is|authority is) reported|run\.json writer rejected/u);
      assert.equal(git(fixture.repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/opencode/continuation-targets", "refs/opencode/continuations"]), beforeRefs);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "amendment-child")), false);
    } finally { cleanup(fixture); }
  });

  it("rejects recovery before worktree or terminal mutation and permits only checked blocked terminalization", async () => {
    const recovery = createFixture();
    try {
      await transitionIntegrationAmendment(recovery.runDir, reportRequest(), { repoRoot: recovery.repo, now: NOW });
      let worktreeHook = false;
      let terminalHook = false;
      await assert.rejects(recoverDisruptedRun(RUN_ID, {
        cwd: recovery.repo,
        recoveryHooks: {
          beforeWorktreeAdd: () => { worktreeHook = true; },
          beforeTerminalWrite: () => { terminalHook = true; },
        },
      }), /recovery rejected: integration amendment authority is reported/u);
      assert.equal(worktreeHook, false);
      assert.equal(terminalHook, false);
    } finally { cleanup(recovery); }

    const blocked = createFixture();
    try {
      await transitionIntegrationAmendment(blocked.runDir, reportRequest(), { repoRoot: blocked.repo, now: NOW });
      await assert.rejects(transitionTerminalResult(blocked.runDir, { status: "blocked", reason: "unchecked" }), /integration amendment is reported/u);
      await transitionIntegrationAmendment(blocked.runDir, { action: "block", reason: "checked amendment stop" }, { repoRoot: blocked.repo, now: NOW });
      const terminal = await transitionTerminalResult(blocked.runDir, { status: "blocked", reason: "checked amendment stop" }, { now: NOW });
      assert.equal(terminal.run.status, "blocked");
      assert.equal(terminal.run.integration_amendment.status, "blocked");
    } finally { cleanup(blocked); }
  });

  it("rechecks merged amendment authority immediately before every forced cleanup deletion effect", async () => {
    for (const [name, hookName] of [
      ["worktree", "beforeWorktreeRemove"],
      ["branch", "beforeBranchDelete"],
      ["run-directory", "beforeRunDirectoryRemove"],
    ]) {
      const fixture = createFixture();
      try {
        const verified = await reachVerified(fixture);
        await transitionIntegrationAmendment(fixture.runDir, { action: "merge" }, { repoRoot: fixture.repo, now: NOW });
        let fired = false;
        await assert.rejects(cleanupRun(RUN_ID, {
          cwd: fixture.repo,
          force: true,
          now: NOW,
          cleanupHooks: {
            [hookName]: () => {
              if (fired) return;
              fired = true;
              writeJson(join(fixture.runDir, "run.json"), verified.run);
            },
          },
        }), /cleanup rejected: integration amendment authority is verified|integration amendment.*stale|does not resolve/u, name);
        assert.equal(fired, true, name);
        assert.equal(existsSync(fixture.runDir), true, name);
      } finally { cleanup(fixture); }
    }
  });

  it("fences heartbeat stop/tick/publication and generic semantic-writer commit races", async () => {
    const heartbeat = createFixture({ publishReport: false });
    try {
      addPristineTestVerifier(heartbeat);
      await startHeartbeat(RUN_ID, { phase: "amendment-fixture", intervalMs: 1000 }, { cwd: heartbeat.repo, now: NOW });
      await stopHeartbeat(RUN_ID, {}, { cwd: heartbeat.repo, now: NOW });
      await executeIntegrationAmendment(heartbeat.runDir, reportRequest(), executionOptions([{ code: 1 }], []));
      await assert.rejects(stopHeartbeat(RUN_ID, {}, { cwd: heartbeat.repo, now: NOW }), /heartbeat stop rejected: integration amendment authority is reported/u);
      await assert.rejects(heartbeatOnce(heartbeat.runDir, { now: NOW }), /integration amendment is reported|run\.json writer rejected/u);
    } finally { cleanup(heartbeat); }

    const publication = createFixture({ publishReport: false });
    try {
      addPristineTestVerifier(publication);
      await executeIntegrationAmendment(publication.runDir, reportRequest(), executionOptions([{ code: 0 }], []));
      await assert.rejects(startHeartbeat(RUN_ID, { phase: "publication-race", intervalMs: 1000 }, {
        cwd: publication.repo,
        now: NOW,
        heartbeatAtomicWriteHooks: { beforeSidecarCommit: () => makeReportClaimActive(publication) },
      }), /heartbeat publication rejected: integration amendment authority is active-claim-only/u);
      assert.equal(existsSync(join(publication.runDir, "heartbeat.json")), false);
    } finally { cleanup(publication); }

    const writer = createFixture({ publishReport: false });
    try {
      await executeIntegrationAmendment(writer.runDir, reportRequest(), executionOptions([{ code: 0 }], []));
      await assert.rejects(transitionRunJson(writer.runDir, (run) => { run.review_tier = "race"; }, {
        atomicWriteHooks: { beforeCommit: () => makeReportClaimActive(writer) },
      }), (error) => /integration amendment authority changed before protected run\.json replacement|active-claim-only/u.test(error?.cause?.message || error?.message));
      assert.equal(readRun(writer).review_tier, undefined);
    } finally { cleanup(writer); }
  });

  it("derives amendment worktrees from the repository root for a managed feature worktree", async () => {
    const fixture = createFixture({ managedFeatureWorktree: true });
    try {
      const verified = await reachVerified(fixture);
      const attempt = verified.integration_amendment.attempts[0];
      assert.equal(attempt.worktree, join(fixture.repo, ".opencode", "worktrees", `${FEATURE_BRANCH}--amend-${fixture.amendmentId}-a1`));
      assert.equal(verified.integration_amendment.integration.worktree, join(fixture.repo, ".opencode", "worktrees", `${FEATURE_BRANCH}--amend-${fixture.amendmentId}-staged`));
      const merged = await transitionIntegrationAmendment(fixture.runDir, { action: "merge" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(merged.integration_amendment.status, "merged");
      assert.equal(git(fixture.featureWorktree, ["status", "--porcelain"]).trim(), "");
    } finally { cleanup(fixture); }
  });

  it("classifies the fixed pre-manifest tombstone and fails closed on orphans", () => {
    const fixture = createFixture();
    try {
      const inventory = inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture));
      assert.equal(inventory.classification, "completed-nonzero-receipt-no-manifest");
      rmSync(join(fixture.runDir, "evidence", "integration-amendment.report.claim.json"));
      assert.throws(() => inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)), /orphan/u);
    } finally { cleanup(fixture); }
  });

  it("keeps settled generic tombstones disjoint from new legacy repair admission", async () => {
    for (const outcome of ["pass", "launch-error"]) {
      const fixture = createFixture();
      try {
        rewriteReportOutcome(fixture, outcome);
        const inventory = inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture));
        assert.equal(inventory.classification, outcome === "pass" ? "completed-pass-receipt-no-manifest" : "completed-diagnostic-receipt-no-manifest");
        await assert.rejects(transitionMergedSliceRepair(fixture.runDir, {
          status: "reported", owner_slice_id: "owner", consumer_slice_id: "consumer", defect_path: "src/owner/api.js", evidence_ref: "evidence/unused.json",
        }), /generic amendment tombstone/u);
      } finally { cleanup(fixture); }
    }
  });

  it("rejects stale plan, owner, baseline, sidecar, and attempt Git authority", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      const planPath = join(fixture.runDir, "plan", "slices.json");
      const planBytes = readFileSync(planPath);
      const plan = JSON.parse(planBytes);
      plan.slices[0].acceptance.push("drift");
      writeJson(planPath, plan);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo }), /plan|decomposition|stale|changed/u);
      writeFileSync(planPath, planBytes);

      const runPath = join(fixture.runDir, "run.json");
      const runBytes = readFileSync(runPath);
      const run = JSON.parse(runBytes);
      run.slices[0].merge_commit = fixture.base;
      writeJson(runPath, run);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo }), /owner|merge|stale|authority/u);
      writeFileSync(runPath, runBytes);

      git(fixture.repo, ["commit", "--allow-empty", "-m", "baseline drift"]);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo }), /baseline|authority|stale/u);
      git(fixture.repo, ["reset", "--hard", fixture.baseline]);

      const receiptPath = join(fixture.runDir, "evidence", `integration-amendment-${fixture.amendmentId}.report.receipt.json`);
      const receiptBytes = readFileSync(receiptPath);
      const receipt = JSON.parse(receiptBytes);
      receipt.duration_ms += 1;
      writeJson(receiptPath, receipt);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo }), /receipt|hash|stale/u);
      writeFileSync(receiptPath, receiptBytes);

      const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo });
      git(fixture.repo, ["update-ref", built.integration_amendment.attempts[0].branch_ref, fixture.reviewedCommit]);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo }), /branch\/worktree authority is stale|head-mismatch/u);
    } finally { cleanup(fixture); }
  });

  it("rechecks amendment authority after an awaited pre-commit hook", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      const receiptPath = join(fixture.runDir, "evidence", `integration-amendment-${fixture.amendmentId}.report.receipt.json`);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, {
        repoRoot: fixture.repo,
        now: NOW,
        atomicWriteHooks: {
          beforeCommit: async () => {
            await Promise.resolve();
            const receipt = readJson(receiptPath);
            receipt.duration_ms += 1;
            writeJson(receiptPath, receipt);
          },
        },
      }), (error) => /receipt hash is stale|authority changed/u.test(error?.cause?.message || error?.message));
      assert.equal(readRun(fixture).integration_amendment.status, "reported");
    } finally { cleanup(fixture); }
  });

  it("rejects premature publication and foreign feature worktree identities", async () => {
    const premature = createFixture();
    try {
      const integrated = await reachIntegrated(premature);
      git(premature.repo, ["update-ref", `refs/heads/${FEATURE_BRANCH}`, integrated.integration_amendment.integration.commit, premature.baseline]);
      await assert.rejects(transitionIntegrationAmendment(premature.runDir, { action: "verify" }, { repoRoot: premature.repo }), /feature ref is stale|recoverable publication authority|clean integration worktree/u);
    } finally { cleanup(premature); }

    for (const mode of ["detached", "wrong-branch"]) {
      const fixture = createFixture();
      try {
        await reachVerified(fixture);
        if (mode === "detached") git(fixture.repo, ["checkout", "--detach", fixture.baseline]);
        else git(fixture.repo, ["checkout", "-b", "foreign-feature", fixture.baseline]);
        assert.equal(checkRunConsistency(fixture.runDir, readRun(fixture)).ok, false);
        await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "merge" }, { repoRoot: fixture.repo }), /outside the three recoverable publication cases|stale or dirty|feature worktree identity is stale/u);
      } finally { cleanup(fixture); }
    }

    const merged = createFixture();
    try {
      const verified = await reachVerified(merged);
      await transitionIntegrationAmendment(merged.runDir, { action: "merge" }, { repoRoot: merged.repo, now: NOW });
      git(merged.repo, ["checkout", "--detach", verified.integration_amendment.integration.commit]);
      assert.equal(checkRunConsistency(merged.runDir, readRun(merged)).ok, false);
    } finally { cleanup(merged); }
  });

  it("rejects report and verification execution cross-binding", async () => {
    const report = createFixture();
    try {
      const claimPath = join(report.runDir, "evidence", "integration-amendment.report.claim.json");
      const claim = readJson(claimPath);
      claim.run_id = "another-run";
      writeJson(claimPath, claim);
      assert.throws(() => inspectIntegrationAmendmentInventory(report.runDir, readRun(report)), /another run or baseline|same run and probe/u);
    } finally { cleanup(report); }

    const verifyIdentity = createFixture();
    try {
      await reachIntegrated(verifyIdentity);
      writeVerification(verifyIdentity);
      const claimPath = join(verifyIdentity.runDir, "evidence", `integration-amendment-${verifyIdentity.amendmentId}.verify.claim.json`);
      const claim = readJson(claimPath);
      claim.identity.defect_path = "src/owner/other.js";
      writeJson(claimPath, claim);
      assert.throws(() => inspectIntegrationAmendmentInventory(verifyIdentity.runDir, readRun(verifyIdentity)), /identity is stale or cross-bound/u);
    } finally { cleanup(verifyIdentity); }

    const unknown = createFixture();
    try {
      await reachIntegrated(unknown);
      writeVerification(unknown);
      const claimPath = join(unknown.runDir, "evidence", `integration-amendment-${unknown.amendmentId}.verify.claim.json`);
      const claim = readJson(claimPath);
      claim.state = "unknown";
      delete claim.completed_at;
      delete claim.status;
      claim.failed_at = NOW;
      claim.reason = "receipt-publication-indeterminate";
      claim.receipt_status = "fail";
      writeJson(claimPath, claim);
      assert.throws(() => inspectIntegrationAmendmentInventory(unknown.runDir, readRun(unknown)), /unknown integration amendment verification receipt binding is stale/u);
    } finally { cleanup(unknown); }
  });

  it("rejects every report baseline binding mismatch and coherent foreign-run identity", () => {
    for (const field of ["head_sha", "tree_sha", "cwd"]) {
      const fixture = createFixture();
      try {
        rewriteExecutionBinding(fixture, field, field === "cwd" ? "/tmp/foreign-amendment-worktree" : fixture.base);
        assert.throws(() => inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)), /another run or baseline/u, field);
      } finally { cleanup(fixture); }
    }

    const foreign = createFixture();
    try {
      rewriteReportAsForeignRun(foreign);
      assert.throws(() => inspectIntegrationAmendmentInventory(foreign.runDir, readRun(foreign)), /another run or baseline/u);
    } finally { cleanup(foreign); }
  });

  it("rejects unknown verification receipt hash drift", async () => {
    const fixture = createFixture();
    try {
      await reachIntegrated(fixture);
      writeVerification(fixture);
      const claimPath = join(fixture.runDir, "evidence", `integration-amendment-${fixture.amendmentId}.verify.claim.json`);
      const claim = readJson(claimPath);
      claim.state = "unknown";
      delete claim.completed_at;
      delete claim.status;
      claim.failed_at = NOW;
      claim.reason = "receipt-publication-indeterminate";
      claim.receipt_status = "pass";
      claim.receipt_hash = sha("wrong-receipt-bytes");
      writeJson(claimPath, claim);
      assert.throws(() => inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)), /unknown integration amendment verification receipt binding is stale/u);
    } finally { cleanup(fixture); }
  });

  it("retains an all-preserved REJECT across attempt 2 and blocks terminally", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      let result = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      let candidate = commitCandidate(result.integration_amendment.attempts.at(-1).worktree);
      bindAmendmentDispatch(fixture, candidate);
      await publishAmendmentReview(fixture, "REJECT", ["tighten the integration behavior"]);
      result = await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(result.integration_amendment.attempts[0].state, "reviewed");

      result = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 2 }, { repoRoot: fixture.repo, now: NOW });
      candidate = commitCandidate(result.integration_amendment.attempts.at(-1).worktree);
      bindAmendmentDispatch(fixture, candidate);
      await publishAmendmentReview(fixture, "REJECT", ["still not isolated"]);
      await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
      const blocked = await transitionIntegrationAmendment(fixture.runDir, { action: "block", reason: "attempt budget exhausted" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(blocked.integration_amendment.status, "blocked");
      assert.equal(blocked.integration_amendment.blocked.origin, "reviewed-reject");
      await assert.rejects(transitionRunSlice(fixture.runDir, "consumer", { status: "running", attempts: 1 }), /integration amendment is blocked|merged-slice repair is unresolved/u);
    } finally { cleanup(fixture); }
  });

  it("binds distinct REJECT and APPROVE review authority across attempt 2", async () => {
    const fixture = createFixture();
    try {
      await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
      let result = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
      let candidate = commitCandidate(result.integration_amendment.attempts[0].worktree);
      bindAmendmentDispatch(fixture, candidate);
      await publishAmendmentReview(fixture, "REJECT", ["tighten the integration behavior"]);
      await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
      result = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 2 }, { repoRoot: fixture.repo, now: NOW });
      candidate = commitCandidate(result.integration_amendment.attempts.at(-1).worktree);
      bindAmendmentDispatch(fixture, candidate);
      await publishAmendmentReview(fixture, "APPROVE", []);
      result = await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(result.integration_amendment.attempts.length, 2);
      assert.equal(checkRunConsistency(fixture.runDir, result.run).ok, true);
      const blocked = await transitionIntegrationAmendment(fixture.runDir, { action: "block", reason: "operator stop after approval" }, { repoRoot: fixture.repo, now: NOW });
      assert.equal(blocked.integration_amendment.blocked.origin, "reviewed-approve");
      assert.equal(checkRunConsistency(fixture.runDir, blocked.run).ok, true);
    } finally { cleanup(fixture); }
  });

  it("rejects blocked integrated and verified origins bound to a REJECT review", async () => {
    for (const origin of ["integrated", "verified"]) {
      const fixture = createFixture();
      try {
        if (origin === "integrated") await reachIntegrated(fixture);
        else await reachVerified(fixture);
        const run = readRun(fixture);
        const attempt = run.integration_amendment.attempts.at(-1);
        const reviewPath = join(fixture.runDir, attempt.review_ref);
        const review = readJson(reviewPath);
        review.verdict = "REJECT";
        review.required_fixes = ["still rejected"];
        writeJson(reviewPath, review);
        attempt.review_hash = hashFile(reviewPath);
        run.integration_amendment.status = "blocked";
        run.integration_amendment.blocked = { origin, reason: "stopped", blocked_at: NOW };
        writeJson(join(fixture.runDir, "run.json"), run);
        const consistency = checkRunConsistency(fixture.runDir, run);
        assert.equal(consistency.ok, false);
        assert.match(JSON.stringify(consistency.checks), /requires an exact APPROVE review|reviewer publication hash is stale|review_hash is stale or cross-bound/u);
      } finally { cleanup(fixture); }
    }
  });

  it("rejects caller authority fields and legacy coexistence", async () => {
    const fixture = createFixture();
    try {
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { ...reportRequest(), commit: fixture.baseline }), /does not accept caller authority field/u);
      const run = readRun(fixture);
      run.merged_slice_repair = { status: "reported" };
      writeJson(join(fixture.runDir, "run.json"), run);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, reportRequest()), /merged_slice_repair|legacy repair/u);
    } finally { cleanup(fixture); }
  });

  it("fences gate, panel, PR, and post-PR production entries before effects for unresolved and blocked amendments", async () => {
    for (const status of ["reported", "blocked"]) {
      const consumers = [
        ["gate boundary", (fixture) => transitionSteeringBoundaryOpened(fixture.runDir, "gate")],
        ["gate decision", (fixture) => transitionGateDecision(fixture.runDir, "pre_pr", { status: "pending", artifact: "artifacts/test-report.md", question_ref: "gates/pre-pr.md" })],
        ...downstreamProductionConsumers(),
      ];
      for (const [name, invoke] of consumers) {
        const fixture = createFixture();
        try {
          await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
          if (status === "blocked") await transitionIntegrationAmendment(fixture.runDir, { action: "block", reason: "checked blocked fixture" }, { repoRoot: fixture.repo, now: NOW });
          const before = snapshotAmendmentGateAuthority(fixture);
          await assert.rejects(invoke(fixture), /integration amendment is (?:reported|blocked)|writer rejected|merged-slice repair is unresolved/u, `${status}:${name}`);
          assert.deepEqual(snapshotAmendmentGateAuthority(fixture), before, `${status}:${name}: protected gate authority`);
        } finally { cleanup(fixture); }
      }
    }
  });

  it("revalidates merged amendment sidecar and Git authority at gate, panel, PR, and post-PR consumers", async () => {
    for (const drift of ["sidecar", "git"]) {
      for (const [name, invoke] of downstreamProductionConsumers({ includeGate: true })) {
        const fixture = createFixture();
        try {
          await reachMerged(fixture);
          if (name === "PR") installLegacyPrFence(fixture);
          if (drift === "sidecar") {
            const receiptPath = join(fixture.runDir, readRun(fixture).integration_amendment.failure_execution.receipt_ref);
            const receipt = readJson(receiptPath);
            receipt.duration_ms += 1;
            writeJson(receiptPath, receipt);
          } else {
            git(fixture.featureWorktree, ["commit", "--allow-empty", "-m", `stale Git authority before ${name}`]);
          }
          const before = readFileSync(join(fixture.runDir, "run.json"));
          await assert.rejects(invoke(fixture), /integration amendment|receipt|authority|feature ref|worktree|stale/u, `${drift}:${name}`);
          assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), before, `${drift}:${name}: protected run bytes`);
        } finally { cleanup(fixture); }
      }
    }
  });

  it("retires new generic-eligible legacy reports before publication and preserves malformed overlap rejection", async () => {
    const fixture = createFixture({ publishReport: false });
    try {
      writeJson(join(fixture.runDir, "evidence", "legacy-generic-failure.json"), { subject: "consumer", status: "fail", substrate: "feature-baseline" });
      const before = readFileSync(join(fixture.runDir, "run.json"));
      await assert.rejects(transitionMergedSliceRepair(fixture.runDir, {
        status: "reported", owner_slice_id: "owner", consumer_slice_id: "consumer", defect_path: "src/owner/api.js", evidence_ref: "evidence/legacy-generic-failure.json",
      }, { repoRoot: fixture.repo }), /legacy merged-slice repair report is retired.*factory amendment amendment-run report.*--artifact-id fixture-artifact-2 --json/u);
      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), before);
      assert.equal(readRun(fixture).merged_slice_repair, undefined);

      const malformed = readRun(fixture);
      malformed.merged_slice_repair = { status: "reported" };
      malformed.integration_amendment = { status: "reported" };
      assert.throws(() => validateRun(malformed), /mutually exclusive|merged_slice_repair|integration_amendment/u);
    } finally { cleanup(fixture); }
  });
});

async function exerciseGenericParity(id) {
  const fixtureOptions = id === 2
    ? { extraSlices: [{ id: "overlap", effective_paths: ["src/owner/**"] }], publishReport: false }
    : [1, 11, 18, 19, 23, 24].includes(id) ? { publishReport: false } : {};
  const fixture = createFixture(fixtureOptions);
  try {
    if (id === 1) {
      await assert.rejects(executeIntegrationAmendment(fixture.runDir, { ...reportRequest(), verification_artifact_id: "missing-artifact" }, executionOptions([{ code: 1 }], [])), /artifact must belong|delivery unit/u);
      assert.equal(existsSync(join(fixture.runDir, "evidence", "integration-amendment.report.claim.json")), false);
      return;
    }
    if (id === 2) {
      await assert.rejects(executeIntegrationAmendment(fixture.runDir, reportRequest(), executionOptions([{ code: 1 }], [])), /sole non-privileged effective owner/u);
      return;
    }
    if (id === 11) {
      const exact = createFixture({ ownerPaths: ["src/owner/api.js"], publishReport: false });
      try {
        await assert.rejects(executeIntegrationAmendment(exact.runDir, { ...reportRequest(), defect_path: "src/owner/api.js/nested" }, executionOptions([{ code: 1 }], [])), /sole non-privileged effective owner/u);
      } finally { cleanup(exact); }
      return;
    }
    if (id === 18) {
      const run = readRun(fixture);
      run.slices.find((slice) => slice.id === "owner").effective_paths = [" src/owner/**"];
      writeJson(join(fixture.runDir, "run.json"), run);
      await assert.rejects(executeIntegrationAmendment(fixture.runDir, reportRequest(), executionOptions([{ code: 1 }], [])), /canonical|ownership lane|invalid run/u);
      return;
    }
    if (id === 19) {
      const planPath = join(fixture.runDir, "plan", "slices.json");
      const plan = readJson(planPath);
      plan.slices.find((slice) => slice.id === "owner").paths = ["src/owner/*.js"];
      writeJson(planPath, plan);
      const run = readRun(fixture);
      run.steps.find((step) => step.agent === "work-decomposer").acceptance.artifact_hash = hashFile(planPath);
      writeJson(join(fixture.runDir, "run.json"), run);
      await assert.rejects(executeIntegrationAmendment(fixture.runDir, reportRequest(), executionOptions([{ code: 1 }], [])), /unsupported glob|ownership lane|canonical/u);
      return;
    }
    if (id === 23) {
      const run = readRun(fixture);
      run.post_pr = { ...createPostPrState({ enabled: true, wait_ms: 3600000, initial_poll_ms: 30000, max_poll_ms: 120000, check_start_grace_ms: 300000, max_transient_errors: 12, review: { required: false, reviewer_login: null, source: "none" } }), attempt: 1 };
      writeJson(join(fixture.runDir, "run.json"), run);
      await assert.rejects(executeIntegrationAmendment(fixture.runDir, reportRequest(), executionOptions([{ code: 1 }], [])), /post-PR authority|excluded after panel/u);
      return;
    }
    if (id === 24) {
      for (const [name, mutate, error] of [
        ["test-verifier", (run) => { run.steps.push({ agent: "test-verifier", status: "running", attempts: 1 }); }, /pristine attempt-zero test-verifier/u],
        ["gate", (run) => { run.gates.pre_pr = { status: "pending", artifact: "artifacts/test-report.md", question_ref: "gates/pre-pr.md" }; }, /excluded after panel|gate/u],
        ["PR fence", (run) => { run.steering = { schema_version: 1, generation: 0, pending: null, uncheckpointed: null, boundary: null, action_claim: null, last_action: null, pr_fence: { token: "fence-token", generation: 0, state_hash: hashValue(run), created_at: NOW }, history: [] }; }, /excluded after panel|PR/u],
        ["PR presence", (run) => { run.pr_url = "https://github.com/acme/repo/pull/79"; }, /excluded after panel|PR/u],
      ]) {
        const excluded = createFixture({ publishReport: false });
        try {
          const run = readRun(excluded);
          mutate(run);
          writeJson(join(excluded.runDir, "run.json"), run);
          await assert.rejects(executeIntegrationAmendment(excluded.runDir, reportRequest(), executionOptions([{ code: 1 }], [])), error, name);
        } finally { cleanup(excluded); }
      }
      const run = readRun(fixture);
      run.validator = { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" };
      run.security_review = { verdict: "PASS", review_ref: "reviews/security-reviewer.json" };
      writeJson(join(fixture.runDir, "run.json"), run);
      await assert.rejects(executeIntegrationAmendment(fixture.runDir, reportRequest(), executionOptions([{ code: 1 }], [])), /excluded after panel/u, "panel presence");
      return;
    }

    await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
    if (id === 3) {
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 2 }, { repoRoot: fixture.repo }), /attempt 2 requires reviewed attempt 1/u);
      const run = readRun(fixture);
      run.slices.push({ id: "busy", stack: "backend", depends_on: [], declared_paths: ["src/busy/**"], effective_paths: ["src/busy/**"], status: "running", branch: "busy", worktree: fixture.repo, attempts: 1, dispatch_required: true });
      writeJson(join(fixture.runDir, "run.json"), run);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo }), /quiescent|running|authority|exactly classify the bound plan/u);
      const exhausted = createFixture();
      try {
        await transitionIntegrationAmendment(exhausted.runDir, reportRequest(), { repoRoot: exhausted.repo, now: NOW });
        for (const attemptNumber of [1, 2]) {
          const builtAttempt = await transitionIntegrationAmendment(exhausted.runDir, { action: "build", attempt: attemptNumber }, { repoRoot: exhausted.repo, now: NOW });
          bindAmendmentDispatch(exhausted, commitCandidate(builtAttempt.integration_amendment.attempts.at(-1).worktree));
          await publishAmendmentReview(exhausted, "REJECT", [`attempt ${attemptNumber} rejected`]);
          await transitionIntegrationAmendment(exhausted.runDir, { action: "review" }, { repoRoot: exhausted.repo, now: NOW });
        }
        assert.equal(readRun(exhausted).integration_amendment.attempts.length, 2);
        await assert.rejects(transitionIntegrationAmendment(exhausted.runDir, { action: "build", attempt: 2 }, { repoRoot: exhausted.repo }), /attempt 2|reviewed attempt 1|already|requires/u);
        await assert.rejects(transitionIntegrationAmendment(exhausted.runDir, { action: "build", attempt: 3 }, { repoRoot: exhausted.repo }), /exactly 1 or 2/u);
      } finally { cleanup(exhausted); }
      return;
    }
    if (id === 9) {
      await assert.rejects(resumeFactory(RUN_ID, { cwd: fixture.repo, dryRun: true }), /integration amendment authority is reported/u);
      return;
    }
    if (id === 10) {
      await assert.rejects(transitionTerminalResult(fixture.runDir, { status: "blocked", reason: "unchecked" }), /integration amendment is reported/u);
      await transitionIntegrationAmendment(fixture.runDir, { action: "block", reason: "checked stop" }, { repoRoot: fixture.repo, now: NOW });
      const terminal = await transitionTerminalResult(fixture.runDir, { status: "blocked", reason: "checked stop" }, { now: NOW });
      assert.equal(terminal.run.status, "blocked");
      return;
    }
    if (id === 16) {
      const run = readRun(fixture);
      run.slices.find((slice) => slice.id === "owner").effective_paths.push("src/late/**");
      writeJson(join(fixture.runDir, "run.json"), run);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo }), /owner|authority|stale|effective_paths/u);
      const planDrift = createFixture();
      try {
        await transitionIntegrationAmendment(planDrift.runDir, reportRequest(), { repoRoot: planDrift.repo, now: NOW });
        const planPath = join(planDrift.runDir, "plan", "slices.json");
        const plan = readJson(planPath);
        plan.slices[0].acceptance.push("late accepted-plan drift");
        writeJson(planPath, plan);
        await assert.rejects(transitionIntegrationAmendment(planDrift.runDir, { action: "build", attempt: 1 }, { repoRoot: planDrift.repo }), /accepted decomposition authority is stale|artifact_hash|accepted plan|authority|plan ref\/hash/u);
      } finally { cleanup(planDrift); }
      return;
    }
    if (id === 17 || id === 26 || id === 28) {
      const receiptPath = join(fixture.runDir, readRun(fixture).integration_amendment.failure_execution.receipt_ref);
      if (id === 28) {
        await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, {
          repoRoot: fixture.repo,
          atomicWriteHooks: { beforeCommit: () => { const receipt = readJson(receiptPath); receipt.duration_ms += 1; writeJson(receiptPath, receipt); } },
        }), (error) => /receipt hash is stale|authority changed/u.test(error?.cause?.message || error?.message));
        assert.equal(readRun(fixture).integration_amendment.status, "reported");
        const gitRace = createFixture();
        try {
          await transitionIntegrationAmendment(gitRace.runDir, reportRequest(), { repoRoot: gitRace.repo, now: NOW });
          await assert.rejects(transitionIntegrationAmendment(gitRace.runDir, { action: "build", attempt: 1 }, {
            repoRoot: gitRace.repo,
            atomicWriteHooks: { beforeCommit: () => git(gitRace.featureWorktree, ["commit", "--allow-empty", "-m", "Git publication race"]) },
          }), (error) => /authority changed|feature ref|baseline|stale/u.test(error?.cause?.message || error?.message));
          assert.equal(readRun(gitRace).integration_amendment.status, "reported");
        } finally { cleanup(gitRace); }
        return;
      }
      const receipt = readJson(receiptPath);
      receipt.duration_ms += 1;
      writeJson(receiptPath, receipt);
      if (id === 17) await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo }), /receipt|hash|stale/u);
      else {
        assert.equal(checkRunConsistency(fixture.runDir, readRun(fixture)).ok, false);
        const gitDrift = createFixture();
        try {
          await transitionIntegrationAmendment(gitDrift.runDir, reportRequest(), { repoRoot: gitDrift.repo, now: NOW });
          git(gitDrift.featureWorktree, ["commit", "--allow-empty", "-m", "Git consistency drift"]);
          assert.equal(checkRunConsistency(gitDrift.runDir, readRun(gitDrift)).ok, false);
        } finally { cleanup(gitDrift); }
      }
      return;
    }
    if (id === 20) {
      await assert.rejects(transitionRunSlice(fixture.runDir, "consumer", { status: "running", attempts: 1 }), /integration amendment is reported/u);
      await assert.rejects(transitionSliceMerged(fixture.runDir, "consumer", { merge_commit: fixture.baseline }, { repoRoot: fixture.repo }), /integration amendment is reported|writer rejected/u);
      return;
    }
    if (id === 21) {
      addPristineTestVerifier(fixture);
      await assert.rejects(transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 1 }), /integration amendment is reported|merged-slice repair is unresolved/u);
      return;
    }
    if (id === 22) {
      await assert.rejects(transitionSteeringBoundaryOpened(fixture.runDir, "gate"), /gate boundary cannot open|integration amendment/u);
      await assert.rejects(transitionGateDecision(fixture.runDir, "pre_pr", { status: "pending", artifact: "artifacts/test-report.md", question_ref: "gates/pre-pr.md" }), /integration amendment is reported|writer rejected/u);
      return;
    }
    if (id === 27) {
      await assert.rejects(transitionRunJson(fixture.runDir, (run) => { run.integration_amendment.status = "merged"; }), /only be changed by transitionIntegrationAmendment|generic run writer|writer rejected/u);
      await assert.rejects(transitionRunJson(fixture.runDir, (run) => { delete run.integration_amendment; }), /only be changed by transitionIntegrationAmendment|generic run writer|writer rejected/u);
      const createDenied = createFixture({ publishReport: false });
      try {
        await assert.rejects(transitionRunJson(createDenied.runDir, (run) => { run.integration_amendment = {}; }), /generic run writer cannot create|only be changed by transitionIntegrationAmendment/u);
      } finally { cleanup(createDenied); }
      return;
    }

    const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
    if (id === 25) assert.equal(hasInFlightHeartbeatWork(readRun(fixture)), true, "building amendment is heartbeat work");
    if (id === 4) {
      await assert.rejects(prepareSpecialBuilderTaskDispatch(fixture.repo, { run_id: RUN_ID, route: "integration-amendment", agent: "frontend-builder" }), /owner stack|agent|backend-builder|authority is not current/u);
      const context = await prepareSpecialBuilderTaskDispatch(fixture.repo, { run_id: RUN_ID, route: "integration-amendment", agent: "backend-builder" }, { claimDispatch: true, completionToken: "parity-dispatch" });
      assert.equal(context.authority.owner.id, "owner");
      const completionHead = commitCandidate(built.integration_amendment.attempts[0].worktree);
      const closed = await completeSpecialBuilderTaskDispatch(fixture.repo, {
        run_id: RUN_ID, route: "integration-amendment", agent: "backend-builder", claim_ref: context.dispatch_claim.ref,
        claim_hash: context.dispatch_claim.hash, completion_token: "parity-dispatch",
      });
      assert.equal(closed.completion_head, completionHead);
      return;
    }
    if (id === 5) {
      await prepareSpecialBuilderTaskDispatch(fixture.repo, { run_id: RUN_ID, route: "integration-amendment", agent: "backend-builder" }, { claimDispatch: true, completionToken: "parity-heartbeat" });
      await assert.rejects(heartbeatOnce(fixture.runDir), /special builder Task dispatch|integration amendment/u);
      return;
    }
    if (id === 15) {
      const worktree = built.integration_amendment.attempts[0].worktree;
      mkdirSync(join(worktree, "src", "consumer"), { recursive: true });
      git(worktree, ["mv", "src/owner/api.js", "src/consumer/renamed.js"]);
      git(worktree, ["commit", "-m", "rename owner source out of lane"]);
      bindAmendmentDispatch(fixture, git(worktree, ["rev-parse", "HEAD"]).trim());
      await assert.rejects(prepareIntegrationAmendmentReviewTaskDispatch(fixture.repo, reviewMarker(readRun(fixture).integration_amendment), { claimDispatch: true, completionToken: "rename-token" }), /not solely owned|changed path/u);
      return;
    }
    const candidate = commitCandidate(built.integration_amendment.attempts[0].worktree);
    bindAmendmentDispatch(fixture, candidate);
    if ([6, 12, 14].includes(id)) {
      const amendment = readRun(fixture).integration_amendment;
      const context = await prepareIntegrationAmendmentReviewTaskDispatch(fixture.repo, reviewMarker(amendment), { claimDispatch: true, completionToken: `parity-${id}`, now: NOW });
      const review = reviewFromContext(context, "APPROVE", []);
      if (id === 6) review.reviewed_commit = review.reviewed_commit.slice(0, 12);
      if (id === 12) review.reviewed_commit = fixture.baseline;
      if (id === 14) review.attempt = 2;
      await assert.rejects(completeIntegrationAmendmentReviewTaskDispatch(fixture.repo, {
        ...reviewMarker(amendment), claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash, completion_token: `parity-${id}`, output: JSON.stringify(review),
      }), /stale or cross-bound|exact marker|reviewed commit|full 40-character lowercase git SHA/u);
      return;
    }
    if (id === 7) {
      const published = await publishAmendmentReview(fixture, "APPROVE", []);
      await assert.rejects(completeIntegrationAmendmentReviewTaskDispatch(fixture.repo, {
        ...reviewMarker(readRun(fixture).integration_amendment), claim_ref: published.context.dispatch_claim.ref, claim_hash: published.context.dispatch_claim.hash,
        completion_token: "review-token-1", output: JSON.stringify({ ...published.review, verdict: "REJECT", required_fixes: ["different"] }),
      }), /conflicts with preexisting bytes|existing closure/u);
      return;
    }
    await publishAmendmentReview(fixture, "APPROVE", []);
    await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
    if (id === 25) {
      assert.equal(hasInFlightHeartbeatWork(readRun(fixture)), true, "reviewed amendment is heartbeat work");
      return;
    }
    const integrated = await transitionIntegrationAmendment(fixture.runDir, { action: "integrate" }, { repoRoot: fixture.repo, now: NOW });
    if (id === 13) {
      const run = readRun(fixture);
      run.integration_amendment.integration.tree = "f".repeat(40);
      writeJson(join(fixture.runDir, "run.json"), run);
      assert.equal(checkRunConsistency(fixture.runDir, readRun(fixture)).ok, false);
      return;
    }
    if (id === 8) {
      writeVerification(fixture);
      await transitionIntegrationAmendment(fixture.runDir, { action: "verify" }, { repoRoot: fixture.repo, now: NOW });
      writeFileSync(join(fixture.featureWorktree, "foreign.txt"), "foreign\n");
      git(fixture.featureWorktree, ["add", "foreign.txt"]);
      git(fixture.featureWorktree, ["commit", "-m", "foreign feature movement"]);
      await assert.rejects(transitionIntegrationAmendment(fixture.runDir, { action: "merge" }, { repoRoot: fixture.repo, now: NOW }), /feature ref is stale|baseline|publication/u);
      return;
    }
    assert.equal(integrated.integration_amendment.status, "integrated");
  } finally {
    cleanup(fixture);
  }
}

async function exerciseManifestMutations(record, cases) {
  await proveManifestTransitionAcceptance(record.id);
  const fixture = createFixture();
  try {
    await reachManifestCatalogVariant(fixture, record.id);
    const canonicalRun = readRun(fixture);
    assert.equal(validateRun(canonicalRun), canonicalRun, `${record.id} baseline validateRun`);
    assert.equal(validateIntegrationAmendment(canonicalRun.integration_amendment, { run: canonicalRun }), canonicalRun.integration_amendment, `${record.id} baseline validateIntegrationAmendment`);
    assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, canonicalRun).manifest, true, `${record.id} baseline inventory`);
    assertRuntimeConsistency(fixture, canonicalRun, `${record.id} baseline consistency`);
    const baselineFiles = snapshotRuntimeFiles(fixture.runDir);
    const rejected = [];

    for (const mutationCase of cases) {
      restoreRuntimeFiles(fixture.runDir, baselineFiles);
      const run = readRun(fixture);
      applyMutationDifference(run.integration_amendment, record.source, mutationCase.record);
      applyRuntimeExternalMutation(fixture.runDir, record, mutationCase, run.integration_amendment);
      writeJson(join(fixture.runDir, "run.json"), run);
      assertDirectValidatorDisposition(
        () => validateIntegrationAmendment(run.integration_amendment, { run }),
        run.integration_amendment,
        "validateIntegrationAmendment",
        mutationCase,
      );
      const beforeConsumer = snapshotRuntimeFiles(fixture.runDir);
      await assert.rejects(
        invokeManifestMutationConsumer(fixture, record.id),
        (error) => isMutationSpecificRejection(error, mutationCase, "transitionIntegrationAmendment/checkRunConsistency"),
        mutationCase.name,
      );
      assert.deepEqual(snapshotRuntimeFiles(fixture.runDir), beforeConsumer, `${mutationCase.name} consumer must be effect-free`);
      rejected.push(mutationCase.name);
    }
    return rejected;
  } finally { cleanup(fixture); }
}

async function exerciseExecutionClaimMutations(record, cases) {
  const fixture = await createExecutionCatalogFixture(record, "claim");
  try {
    const canonicalRun = readRun(fixture);
    const canonicalClaim = readJson(fixture.executionClaimPath);
    assert.equal(validateIntegrationAmendmentExecutionClaim(canonicalClaim), canonicalClaim, `${record.id} baseline validateIntegrationAmendmentExecutionClaim`);
    assert.ok(inspectIntegrationAmendmentInventory(fixture.runDir, canonicalRun).classification, `${record.id} baseline inventory`);
    assertRuntimeConsistency(fixture, canonicalRun, `${record.id} baseline consistency`);
    const baselineFiles = snapshotRuntimeFiles(fixture.runDir);
    const rejected = [];

    for (const mutationCase of cases) {
      restoreRuntimeFiles(fixture.runDir, baselineFiles);
      const claim = readJson(fixture.executionClaimPath);
      applyMutationDifference(claim, record.source, mutationCase.record);
      writeJson(fixture.executionClaimPath, claim);
      applyRuntimeExternalMutation(fixture.runDir, record, mutationCase, claim);
      assertDirectValidatorDisposition(
        () => validateIntegrationAmendmentExecutionClaim(claim),
        claim,
        "validateIntegrationAmendmentExecutionClaim",
        mutationCase,
      );
      const beforeConsumer = snapshotRuntimeFiles(fixture.runDir);
      assert.throws(
        () => inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)),
        (error) => isMutationSpecificRejection(error, mutationCase, "inspectIntegrationAmendmentInventory"),
        mutationCase.name,
      );
      assert.deepEqual(snapshotRuntimeFiles(fixture.runDir), beforeConsumer, `${mutationCase.name} inventory must be read-only`);
      rejected.push(mutationCase.name);
    }
    return rejected;
  } finally { cleanup(fixture); }
}

async function exerciseExecutionReceiptMutations(record, cases) {
  const fixture = await createExecutionCatalogFixture(record, "receipt");
  try {
    const canonicalRun = readRun(fixture);
    const canonicalReceipt = readJson(fixture.executionReceiptPath);
    assert.equal(validateIntegrationAmendmentExecutionReceipt(canonicalReceipt), canonicalReceipt, `${record.id} baseline validateIntegrationAmendmentExecutionReceipt`);
    assert.ok(inspectIntegrationAmendmentInventory(fixture.runDir, canonicalRun).classification, `${record.id} baseline inventory`);
    assertRuntimeConsistency(fixture, canonicalRun, `${record.id} baseline consistency`);
    const baselineFiles = snapshotRuntimeFiles(fixture.runDir);
    const rejected = [];

    for (const mutationCase of cases) {
      restoreRuntimeFiles(fixture.runDir, baselineFiles);
      const receipt = readJson(fixture.executionReceiptPath);
      applyMutationDifference(receipt, record.source, mutationCase.record);
      writeJson(fixture.executionReceiptPath, receipt);
      assertDirectValidatorDisposition(
        () => validateIntegrationAmendmentExecutionReceipt(receipt),
        receipt,
        "validateIntegrationAmendmentExecutionReceipt",
        mutationCase,
      );
      const beforeConsumer = snapshotRuntimeFiles(fixture.runDir);
      assert.throws(
        () => inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)),
        (error) => isMutationSpecificRejection(error, mutationCase, "inspectIntegrationAmendmentInventory"),
        mutationCase.name,
      );
      assert.deepEqual(snapshotRuntimeFiles(fixture.runDir), beforeConsumer, `${mutationCase.name} inventory must be read-only`);
      rejected.push(mutationCase.name);
    }
    return rejected;
  } finally { cleanup(fixture); }
}

async function exerciseAmendmentReviewMutations(record, cases) {
  await proveReviewTransitionAcceptance(record.id);
  const fixture = await createReviewCatalogFixture(record.id);
  try {
    const canonicalRun = readRun(fixture);
    const canonicalReview = readJson(fixture.amendmentReviewPath);
    assert.equal(validateIntegrationAmendmentReview(canonicalReview), canonicalReview, `${record.id} baseline validateIntegrationAmendmentReview`);
    assert.equal(inspectIntegrationAmendmentInventory(fixture.runDir, canonicalRun).review_effect.classification, "closed-unconsumed", `${record.id} baseline review inventory`);
    const baselineFiles = snapshotRuntimeFiles(fixture.runDir);
    const rejected = [];

    for (const mutationCase of cases) {
      restoreRuntimeFiles(fixture.runDir, baselineFiles);
      const review = readJson(fixture.amendmentReviewPath);
      applyMutationDifference(review, record.source, mutationCase.record);
      writeJson(fixture.amendmentReviewPath, review);
      assertDirectValidatorDisposition(
        () => validateIntegrationAmendmentReview(review),
        review,
        "validateIntegrationAmendmentReview",
        mutationCase,
      );
      const beforeConsumer = snapshotRuntimeFiles(fixture.runDir);
      assert.throws(
        () => inspectIntegrationAmendmentInventory(fixture.runDir, readRun(fixture)),
        (error) => isMutationSpecificRejection(error, mutationCase, "inspectIntegrationAmendmentInventory"),
        `${mutationCase.name} inventory`,
      );
      await assert.rejects(
        transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW }),
        (error) => isMutationSpecificRejection(error, mutationCase, "transitionIntegrationAmendment review"),
        `${mutationCase.name} transition`,
      );
      assert.deepEqual(snapshotRuntimeFiles(fixture.runDir), beforeConsumer, `${mutationCase.name} review consumers must be effect-free`);
      rejected.push(mutationCase.name);
    }
    return rejected;
  } finally { cleanup(fixture); }
}

async function exerciseBuilderDispatchMutations(record, cases) {
  await proveBuilderDispatchTransitionAcceptance(record.id);
  const fixture = await createBuilderDispatchCatalogFixture(record.id);
  try {
    const canonicalRun = readRun(fixture);
    assert.equal(validateRun(canonicalRun), canonicalRun, `${record.id} baseline validateRun`);
    assert.ok(inspectIntegrationAmendmentInventory(fixture.runDir, canonicalRun).classification, `${record.id} baseline inventory`);
    const baselineFiles = snapshotRuntimeFiles(fixture.runDir);
    const rejected = [];

    for (const mutationCase of cases) {
      restoreRuntimeFiles(fixture.runDir, baselineFiles);
      const run = readRun(fixture);
      if (record.id.startsWith("amendment-dispatch-binding-")) {
        applyMutationDifference(run.special_builder_dispatch, record.source, mutationCase.record);
        writeJson(join(fixture.runDir, "run.json"), run);
        applyRuntimeExternalMutation(fixture.runDir, record, mutationCase, run.special_builder_dispatch);
        assertDirectValidatorDisposition(() => validateRun(run), run, "validateRun", mutationCase);
      } else {
        const path = record.id === "amendment-dispatch-claim" ? fixture.builderClaimPath : fixture.builderClosurePath;
        const sidecar = readJson(path);
        applyMutationDifference(sidecar, record.source, mutationCase.record);
        writeJson(path, sidecar);
        applyRuntimeExternalMutation(fixture.runDir, record, mutationCase, sidecar);
      }
      const beforeConsumer = snapshotRuntimeFiles(fixture.runDir);
      await assert.rejects(
        invokeBuilderDispatchMutationConsumer(fixture),
        (error) => isMutationSpecificRejection(error, mutationCase, "checked special builder dispatch consumer"),
        mutationCase.name,
      );
      assert.deepEqual(snapshotRuntimeFiles(fixture.runDir), beforeConsumer, `${mutationCase.name} dispatch consumer must be effect-free`);
      rejected.push(mutationCase.name);
    }
    return rejected;
  } finally { cleanup(fixture); }
}

async function reachManifestCatalogVariant(fixture, id) {
  await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
  if (id === "amendment-reported" || id === "amendment-blocked-from-reported") {
    if (id.startsWith("amendment-blocked-")) await blockRuntimeAmendment(fixture);
    return readRun(fixture);
  }

  await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
  if (id === "amendment-building-attempt-1" || id === "amendment-blocked-from-building") {
    if (id.startsWith("amendment-blocked-")) await blockRuntimeAmendment(fixture);
    return readRun(fixture);
  }

  const firstVerdict = id.includes("reviewed-reject") || id.includes("attempt-2") ? "REJECT" : "APPROVE";
  await completeRuntimeAmendmentReview(fixture, firstVerdict);
  if (id.includes("attempt-2")) {
    await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 2 }, { repoRoot: fixture.repo, now: NOW });
    if (id === "amendment-building-attempt-2") return readRun(fixture);
    await completeRuntimeAmendmentReview(fixture, id.includes("reviewed-reject-attempt-2") ? "REJECT" : "APPROVE");
    return readRun(fixture);
  }
  if (id.startsWith("amendment-reviewed-")) return readRun(fixture);
  if (id.startsWith("amendment-blocked-from-reviewed-")) {
    await blockRuntimeAmendment(fixture);
    return readRun(fixture);
  }

  await transitionIntegrationAmendment(fixture.runDir, { action: "integrate" }, { repoRoot: fixture.repo, now: NOW });
  if (id === "amendment-integrated" || id === "amendment-blocked-from-integrated") {
    if (id.startsWith("amendment-blocked-")) await blockRuntimeAmendment(fixture);
    return readRun(fixture);
  }
  writeVerification(fixture);
  await transitionIntegrationAmendment(fixture.runDir, { action: "verify" }, { repoRoot: fixture.repo, now: NOW });
  if (id === "amendment-verified" || id === "amendment-blocked-from-verified") {
    if (id.startsWith("amendment-blocked-")) await blockRuntimeAmendment(fixture);
    return readRun(fixture);
  }
  await transitionIntegrationAmendment(fixture.runDir, { action: "merge" }, { repoRoot: fixture.repo, now: NOW });
  return readRun(fixture);
}

async function completeRuntimeAmendmentReview(fixture, verdict) {
  const run = readRun(fixture);
  const attempt = run.integration_amendment.attempts.at(-1);
  const candidate = commitCandidate(attempt.worktree);
  bindAmendmentDispatch(fixture, candidate);
  await publishAmendmentReview(fixture, verdict, verdict === "APPROVE" ? [] : ["correct the owner implementation"]);
  return transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
}

function blockRuntimeAmendment(fixture) {
  return transitionIntegrationAmendment(fixture.runDir, { action: "block", reason: "catalog baseline block" }, { repoRoot: fixture.repo, now: NOW });
}

async function proveManifestTransitionAcceptance(id) {
  const fixture = createFixture();
  try {
    await reachManifestCatalogVariant(fixture, id);
    if (id.startsWith("amendment-blocked-")) {
      const result = await transitionTerminalResult(fixture.runDir, { status: "blocked", reason: "catalog baseline block" }, { now: NOW });
      assert.equal(result.run.status, "blocked", `${id} baseline terminal transition`);
    } else if (id === "amendment-merged") {
      const result = await transitionRunJson(fixture.runDir, () => {});
      assert.equal(result.run.integration_amendment.status, "merged", `${id} baseline generic downstream transition`);
    } else {
      const result = await blockRuntimeAmendment(fixture);
      assert.equal(result.integration_amendment.status, "blocked", `${id} baseline amendment transition`);
    }
  } finally { cleanup(fixture); }
}

async function invokeManifestMutationConsumer(fixture, id) {
  const consistency = checkRunConsistency(fixture.runDir, readRun(fixture));
  if (!consistency.ok) throw new Error(`checkRunConsistency rejected integration amendment mutation: ${JSON.stringify(consistency.checks.filter(({ ok }) => !ok))}`);
  if (id.startsWith("amendment-blocked-")) return transitionTerminalResult(fixture.runDir, { status: "blocked", reason: "catalog baseline block" }, { now: NOW });
  if (id === "amendment-merged") return transitionRunJson(fixture.runDir, () => {});
  return blockRuntimeAmendment(fixture);
}

async function createExecutionCatalogFixture(record, target) {
  const phase = record.id.startsWith("amendment-report-") ? "report" : "verify";
  const fixture = createFixture();
  if (phase === "verify") {
    await reachIntegrated(fixture);
    writeVerification(fixture);
  }
  const claimPath = phase === "report"
    ? join(fixture.runDir, "evidence", "integration-amendment.report.claim.json")
    : join(fixture.runDir, "evidence", `integration-amendment-${fixture.amendmentId}.verify.claim.json`);
  const originalClaim = readJson(claimPath);
  const receiptPath = join(fixture.runDir, originalClaim.receipt_ref);
  const receiptTemplate = target === "receipt"
    ? record.source
    : record.externalSources?.receipt ? JSON.parse(record.externalSources.receipt.bytes) : null;
  const receipt = receiptTemplate ? bindRuntimeExecutionReceipt(receiptTemplate, originalClaim) : null;
  rmSync(receiptPath, { force: true });
  if (receipt) writeJson(receiptPath, receipt);

  const claim = target === "claim"
    ? bindRuntimeExecutionClaim(record.source, originalClaim, receiptPath, receipt)
    : bindRuntimeCompletedClaim(originalClaim, receiptPath, receipt);
  writeJson(claimPath, claim);
  fixture.executionClaimPath = claimPath;
  fixture.executionReceiptPath = receiptPath;
  return fixture;
}

function bindRuntimeExecutionClaim(source, original, receiptPath, receipt) {
  const claim = {
    ...structuredClone(source),
    phase: original.phase,
    subject: original.subject,
    nonce: original.nonce,
    amendment_id: original.amendment_id,
    identity: structuredClone(original.identity),
    run_id: original.run_id,
    probe: structuredClone(original.probe),
    head_sha: original.head_sha,
    tree_sha: original.tree_sha,
    cwd: original.cwd,
    receipt_ref: original.receipt_ref,
  };
  if (claim.state === "completed") claim.receipt_hash = hashFile(receiptPath);
  return claim;
}

function bindRuntimeCompletedClaim(original, receiptPath, receipt) {
  return {
    ...structuredClone(original),
    state: "completed",
    completed_at: NOW,
    status: receipt.status,
    receipt_hash: hashFile(receiptPath),
  };
}

function bindRuntimeExecutionReceipt(source, claim) {
  return {
    ...structuredClone(source),
    phase: claim.phase,
    subject: claim.subject,
    run_id: claim.run_id,
    amendment_id: claim.amendment_id,
    claim_nonce: claim.nonce,
    probe: structuredClone(claim.probe),
    head_sha: claim.head_sha,
    tree_sha: claim.tree_sha,
    cwd: claim.cwd,
  };
}

async function createReviewCatalogFixture(id) {
  const fixture = createFixture();
  await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
  await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
  const attempt = readRun(fixture).integration_amendment.attempts[0];
  bindAmendmentDispatch(fixture, commitCandidate(attempt.worktree));
  const verdict = id.endsWith("approve") ? "APPROVE" : "REJECT";
  await publishAmendmentReview(fixture, verdict, verdict === "APPROVE" ? [] : ["correct the owner implementation"]);
  fixture.amendmentReviewPath = join(fixture.runDir, `reviews/integration-amendment-${fixture.amendmentId}.attempt-1.json`);
  return fixture;
}

async function proveReviewTransitionAcceptance(id) {
  const fixture = await createReviewCatalogFixture(id);
  try {
    const result = await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
    assert.equal(result.integration_amendment.status, "reviewed", `${id} baseline review transition`);
  } finally { cleanup(fixture); }
}

async function createBuilderDispatchCatalogFixture(id) {
  const fixture = createFixture();
  await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
  const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
  const token = `catalog-dispatch-${id}`;
  const context = await prepareSpecialBuilderTaskDispatch(fixture.repo, { run_id: RUN_ID, route: "integration-amendment", agent: "backend-builder" }, { claimDispatch: true, completionToken: token, now: NOW });
  assertRuntimeConsistency(fixture, readRun(fixture), `${id} baseline consistency before builder effect`);
  const candidate = commitCandidate(built.integration_amendment.attempts[0].worktree);
  if (id === "amendment-dispatch-binding-closed" || id === "amendment-dispatch-closure") {
    await completeSpecialBuilderTaskDispatch(fixture.repo, {
      run_id: RUN_ID, route: "integration-amendment", agent: "backend-builder", claim_ref: context.dispatch_claim.ref,
      claim_hash: context.dispatch_claim.hash, completion_token: token,
    }, { now: NOW });
  }
  const run = readRun(fixture);
  fixture.builderContext = context;
  fixture.builderToken = token;
  fixture.builderCandidate = candidate;
  fixture.builderClaimPath = join(fixture.runDir, context.dispatch_claim.ref);
  fixture.builderClosurePath = run.special_builder_dispatch?.closure_ref ? join(fixture.runDir, run.special_builder_dispatch.closure_ref) : null;
  return fixture;
}

async function proveBuilderDispatchTransitionAcceptance(id) {
  const fixture = await createBuilderDispatchCatalogFixture(id);
  try {
    const result = await invokeBuilderDispatchMutationConsumer(fixture);
    if (id === "amendment-dispatch-binding-active" || id === "amendment-dispatch-claim") assert.equal(result.completion_head, fixture.builderCandidate, `${id} baseline completion transition`);
    else assert.ok(result.dispatch_claim, `${id} baseline review-dispatch transition`);
  } finally { cleanup(fixture); }
}

function invokeBuilderDispatchMutationConsumer(fixture) {
  const run = readRun(fixture);
  if (!run.special_builder_dispatch?.closure_ref) {
    return completeSpecialBuilderTaskDispatch(fixture.repo, {
      run_id: RUN_ID, route: "integration-amendment", agent: "backend-builder", claim_ref: fixture.builderContext.dispatch_claim.ref,
      claim_hash: fixture.builderContext.dispatch_claim.hash, completion_token: fixture.builderToken,
    }, { now: NOW });
  }
  return prepareIntegrationAmendmentReviewTaskDispatch(fixture.repo, reviewMarker(run.integration_amendment), { claimDispatch: true, completionToken: "catalog-review-dispatch", now: NOW });
}

function assertDirectValidatorDisposition(invoke, expected, validatorName, mutationCase) {
  let result;
  let rejection = null;
  try {
    result = invoke();
  } catch (error) {
    rejection = error;
  }
  if (rejection) {
    assert.ok(rejection instanceof Error, `${mutationCase.name} ${validatorName} rejection`);
    assert.ok(rejection.message.length > 0, `${mutationCase.name} ${validatorName} rejection message`);
  } else {
    assert.equal(result, expected, `${mutationCase.name} ${validatorName} explicitly accepted structure for contextual rejection`);
  }
  return rejection;
}

function isMutationSpecificRejection(error, mutationCase, consumer) {
  assert.ok(error instanceof Error, `${mutationCase.name} ${consumer} must throw Error`);
  assert.ok(error.message.length > 0, `${mutationCase.name} ${consumer} must identify rejection`);
  assert.doesNotMatch(error.message, /unexpected spawn|catalog baseline fixture/u, `${mutationCase.name} must not fail through unrelated fixture scaffolding`);
  return true;
}

function assertRuntimeConsistency(fixture, run, label) {
  const consistency = checkRunConsistency(fixture.runDir, run);
  assert.equal(consistency.ok, true, `${label}: ${JSON.stringify(consistency.checks.filter(({ ok }) => !ok))}`);
}

function applyRuntimeExternalMutation(runDir, record, mutationCase, actualRecord) {
  const changed = Object.keys(record.externalSources || {})
    .filter((key) => JSON.stringify(record.externalSources[key]) !== JSON.stringify(mutationCase.externalSources[key]));
  assert.ok(changed.length <= 1, `${mutationCase.name} mutates at most one external sidecar`);
  if (changed.length === 0) return;
  const key = changed[0];
  const source = record.externalSources[key];
  const path = findScalarPath(record.source, source.ref);
  assert.ok(path, `${mutationCase.name} external source ${key} must have a canonical ref binding`);
  const actualRef = valueAtRuntimePath(actualRecord, path);
  assert.equal(typeof actualRef, "string", `${mutationCase.name} actual sidecar ref`);
  const actualPath = join(runDir, actualRef);
  assert.equal(existsSync(actualPath), true, `${mutationCase.name} canonical sidecar exists before mutation`);
  writeFileSync(actualPath, `${readFileSync(actualPath, "utf8")}-tampered`);
}

function findScalarPath(value, expected, path = []) {
  if (value === expected) return path;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findScalarPath(item, expected, [...path, index]);
      if (found) return found;
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const found = findScalarPath(item, expected, [...path, key]);
      if (found) return found;
    }
  }
  return null;
}

function valueAtRuntimePath(value, path) {
  return path.reduce((current, segment) => current?.[segment], value);
}

function applyMutationDifference(actual, source, mutated) {
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(mutated, key)) {
      delete actual[key];
      continue;
    }
    const sourceValue = source[key];
    const mutatedValue = mutated[key];
    if (isPlainRuntimeObject(sourceValue) && isPlainRuntimeObject(mutatedValue) && isPlainRuntimeObject(actual[key])) {
      applyMutationDifference(actual[key], sourceValue, mutatedValue);
    } else if (JSON.stringify(sourceValue) !== JSON.stringify(mutatedValue)) {
      actual[key] = structuredClone(mutatedValue);
    }
  }
  for (const key of Object.keys(mutated)) if (!Object.hasOwn(source, key)) actual[key] = structuredClone(mutated[key]);
}

function isPlainRuntimeObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function snapshotRuntimeFiles(root) {
  const result = {};
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, relative);
      else result[relative] = readFileSync(path);
    }
  };
  visit(root);
  return result;
}

function restoreRuntimeFiles(root, snapshot) {
  for (const [relative, bytes] of Object.entries(snapshot)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
}

function createFixture({ managedFeatureWorktree = false, publishReport = true, ownerPaths = ["src/owner/**"], consumerPaths = ["src/consumer/**"], extraSlices = [] } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "feature-factory-amendment-"));
  fixtures.push(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, ".gitignore"), ".opencode/\n");
  writeFileSync(join(repo, "README.md"), "base\n");
  mkdirSync(join(repo, "src", "owner"), { recursive: true });
  writeFileSync(join(repo, "src", "owner", "api.js"), "export const value = 1;\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["branch", "owner-build"]);
  const ownerWorktree = join(repo, ".opencode", "worktrees", "owner-build");
  mkdirSync(dirname(ownerWorktree), { recursive: true });
  git(repo, ["worktree", "add", ownerWorktree, "owner-build"]);
  writeFileSync(join(ownerWorktree, "src", "owner", "api.js"), "export const value = 2;\n");
  git(ownerWorktree, ["add", "src/owner/api.js"]);
  git(ownerWorktree, ["commit", "-m", "owner work"]);
  const reviewedCommit = git(ownerWorktree, ["rev-parse", "HEAD"]).trim();
  git(repo, ["checkout", "-b", FEATURE_BRANCH, base]);
  git(repo, ["merge", "--no-ff", "owner-build", "-m", "merge owner"]);
  const baseline = git(repo, ["rev-parse", "HEAD"]).trim();
  const baselineTree = git(repo, ["rev-parse", `${baseline}^{tree}`]).trim();
  let featureWorktree = repo;
  if (managedFeatureWorktree) {
    git(repo, ["checkout", "main"]);
    featureWorktree = join(repo, ".opencode", "worktrees", FEATURE_BRANCH);
    git(repo, ["worktree", "add", featureWorktree, FEATURE_BRANCH]);
  }
  const runDir = join(repo, ".opencode", "factory", RUN_ID);
  for (const dir of ["plan", "evidence", "reviews", "dispatch"]) mkdirSync(join(runDir, dir), { recursive: true });
  const plan = withDeliveryEnvelope({
    slices: [
      { id: "owner", stack: "backend", paths: ownerPaths, depends_on: [], acceptance: ["owner works"], test_plan: ["node --test test/owner.test.js"] },
      { id: "consumer", stack: "backend", paths: consumerPaths, depends_on: ["owner"], acceptance: ["consumer works"], test_plan: ["node --test test/consumer.test.js"] },
      ...extraSlices.map((slice) => ({ id: slice.id, stack: slice.stack || "backend", paths: slice.effective_paths, depends_on: slice.depends_on || [], acceptance: ["extra works"], test_plan: ["node --test test/extra.test.js"] })),
    ],
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
  });
  writeJson(join(runDir, "plan", "slices.json"), plan);
  writeJson(join(runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] });
  const family = writeVerificationArtifactReceipt({ runDir, runId: RUN_ID, plan, sliceId: "owner", attempt: 1, reviewedCommit, artifactId: "fixture-artifact-1", evidenceRef: "evidence/owner-family.json", result: { type: "verification-result", outcome: "pass", summary: "owner passed" } });
  writeJson(join(runDir, "evidence", "owner.json"), { subject: "owner", attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommit, ownership_disclosure: [] });
  const ownerReview = createSliceReviewRecord({ subject: "owner", attempt: 1, reviewedCommit });
  ownerReview.invariant_family_ledger = passingInvariantFamilyLedger({ plan, sliceId: "owner", reviewedCommit, evidenceRef: family.ref, evidenceHash: family.hash });
  writeJson(join(runDir, "reviews", "owner.json"), ownerReview);
  const dispatch = writeOwnerDispatch(runDir, base, reviewedCommit, ownerWorktree);
  const attemptReview = { ...createSliceAttemptReview({ attempt: 1, evidenceRef: "evidence/owner.json", evidenceHash: hashFile(join(runDir, "evidence", "owner.json")), reviewRef: "reviews/owner.json", reviewHash: hashFile(join(runDir, "reviews", "owner.json")), reviewedCommit, diffBaseCommit: base }), ...dispatch };
  const owner = { id: "owner", stack: "backend", depends_on: [], declared_paths: ownerPaths, effective_paths: ownerPaths, status: "merged", branch: "owner-build", worktree: ownerWorktree, attempts: 1, dispatch_required: true, ...dispatch, attempt_reviews: [attemptReview], evidence_ref: attemptReview.evidence_ref, evidence_hash: attemptReview.evidence_hash, review_ref: attemptReview.review_ref, review_hash: attemptReview.review_hash, reviewed_commit: reviewedCommit, merge_commit: baseline };
  const consumer = { id: "consumer", stack: "backend", depends_on: ["owner"], declared_paths: consumerPaths, effective_paths: consumerPaths, status: "pending", attempts: 0 };
  const extraRunSlices = extraSlices.map((slice) => ({ id: slice.id, stack: slice.stack || "backend", depends_on: slice.depends_on || [], declared_paths: slice.effective_paths, effective_paths: slice.effective_paths, status: "pending", attempts: 0 }));
  const run = {
    schema_version: 1, run_id: RUN_ID, status: "running", branch: FEATURE_BRANCH, worktree: featureWorktree, gates: {}, slices: [owner, consumer, ...extraRunSlices],
    steps: [{ agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json", acceptance: { artifact_ref: "plan/slices.json", artifact_hash: hashFile(join(runDir, "plan", "slices.json")), review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(runDir, "reviews", "work-decomposer.json")) } }],
  };
  validateRun(run);
  writeJson(join(runDir, "run.json"), run);
  const admission = admissionFixture({ repo: featureWorktree, baseline, baselineTree, owner, consumer, plan });
  const identity = { schema_version: 1, kind: "integration-amendment-identity", run_id: RUN_ID, defect_path: "src/owner/api.js", admission };
  const amendmentId = integrationAmendmentId(identity);
  if (publishReport) writeExecution(runDir, { phase: "report", identity, amendmentId, probe: admission.probe, head: baseline, tree: baselineTree, cwd: featureWorktree, exitCode: 1 });
  return { repo, featureWorktree, runDir, base, baseline, baselineTree, reviewedCommit, amendmentId };
}

function admissionFixture({ repo, baseline, baselineTree, owner, consumer, plan }) {
  const unit = plan.delivery_envelope.delivery_units.find((entry) => entry.slice_id === "consumer");
  const artifact = unit.verification_artifacts[0];
  return {
    baseline_ref: `refs/heads/${FEATURE_BRANCH}`, baseline_commit: baseline, baseline_tree: baselineTree, worktree: repo,
    probe: { schema_version: 1, kind: "integration-amendment-probe", delivery_unit_id: unit.id, consumer_slice_id: "consumer", verification_artifact_id: artifact.id, test_plan_index: artifact.test_plan_index, test_plan_entry: artifact.test_plan_entry, program: "node", args: ["--test", "test/consumer.test.js"], substrate: "feature-baseline" },
    owner: pick(owner, ["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts", "attempt_reviews", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "merge_commit"]),
    consumer: pick(consumer, ["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts"]),
  };
}

function writeOwnerDispatch(runDir, head, completionHead, worktree) {
  const name = `${createHash("sha256").update(`${RUN_ID}\0owner\0${1}`).digest("hex")}.json`;
  const claimRef = `dispatch/${name}`;
  const closureRef = `dispatch/${name.slice(0, -5)}.closed.json`;
  const token = "owner-token";
  const claim = { schema_version: 1, kind: "checked-slice-builder-dispatch-claim", run_id: RUN_ID, slice_id: "owner", attempt: 1, agent: "backend-builder", branch: "owner-build", worktree, head, context_hash: hashValue({ owner: true }), completion_token_hash: sha(token), claimed_at: NOW, closure_ref: closureRef };
  writeJson(join(runDir, claimRef), claim);
  const claimHash = hashFile(join(runDir, claimRef));
  const closure = { schema_version: 1, kind: "checked-slice-builder-dispatch-closure", claim_ref: claimRef, claim_hash: claimHash, run_id: RUN_ID, slice_id: "owner", attempt: 1, agent: "backend-builder", branch: "owner-build", worktree, head, completion_head: completionHead, context_hash: claim.context_hash, completion_token: token, returned_at: NOW };
  writeJson(join(runDir, closureRef), closure);
  return { dispatch_claim_ref: claimRef, dispatch_claim_hash: claimHash, dispatch_closure_ref: closureRef, dispatch_closure_hash: hashFile(join(runDir, closureRef)) };
}

function bindAmendmentDispatch(fixture, candidate) {
  const run = readRun(fixture);
  const amendment = run.integration_amendment;
  const attempt = amendment.attempts.at(-1);
  const instance = `${amendment.amendment_id}:attempt-${attempt.attempt}`;
  const name = `${createHash("sha256").update(`${RUN_ID}\0special\0integration-amendment\0${instance}`).digest("hex")}.special.json`;
  const claimRef = `dispatch/${name}`;
  const closureRef = `dispatch/${name.slice(0, -5)}.closed.json`;
  const token = "amendment-token";
  const authorityRun = structuredClone(run);
  delete authorityRun.updated_at;
  const claim = { schema_version: 1, kind: "checked-special-builder-dispatch-claim", run_id: RUN_ID, route: "integration-amendment", instance, agent: "backend-builder", branch: attempt.branch_ref.slice("refs/heads/".length), worktree: attempt.worktree, head: attempt.build_base_commit, run_hash: hashValue(authorityRun), context_hash: hashValue({ amendment: amendment.amendment_id }), completion_token_hash: sha(token), claimed_at: NOW, closure_ref: closureRef };
  writeJson(join(fixture.runDir, claimRef), claim);
  const claimHash = hashFile(join(fixture.runDir, claimRef));
  const closure = { schema_version: 1, kind: "checked-special-builder-dispatch-closure", claim_ref: claimRef, claim_hash: claimHash, run_id: RUN_ID, route: "integration-amendment", instance, agent: "backend-builder", branch: claim.branch, worktree: claim.worktree, head: claim.head, completion_head: candidate, run_hash: claim.run_hash, context_hash: claim.context_hash, completion_token: token, returned_at: NOW };
  writeJson(join(fixture.runDir, closureRef), closure);
  run.special_builder_dispatch = { schema_version: 1, route: "integration-amendment", instance, agent: "backend-builder", claim_ref: claimRef, claim_hash: claimHash, closure_ref: closureRef, closure_hash: hashFile(join(fixture.runDir, closureRef)), completion_head: candidate };
  writeJson(join(fixture.runDir, "run.json"), run);
}

async function publishAmendmentReview(fixture, verdict, requiredFixes, options = {}) {
  const run = readRun(fixture);
  const amendment = run.integration_amendment;
  const attempt = amendment.attempts.at(-1);
  const token = `review-token-${attempt.attempt}`;
  const context = await prepareIntegrationAmendmentReviewTaskDispatch(fixture.repo, reviewMarker(amendment), { claimDispatch: true, completionToken: token, now: NOW, ...options.prepare });
  const review = reviewFromContext(context, verdict, requiredFixes);
  const completed = await completeIntegrationAmendmentReviewTaskDispatch(fixture.repo, {
    ...reviewMarker(amendment),
    claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash, completion_token: token,
    output: JSON.stringify(options.mutate ? options.mutate(review) : review),
  }, { now: NOW, ...options.complete });
  return { context, review, completed };
}

function reviewMarker(amendment) {
  return { run_id: RUN_ID, amendment_id: amendment.amendment_id, attempt: amendment.attempts.at(-1).attempt, agent: "work-reviewer" };
}

function reviewFromContext(context, verdict, requiredFixes) {
  return {
    schema_version: 1, kind: "integration-amendment-review", subject: `integration-amendment:${context.amendment_id}`, amendment_id: context.amendment_id, attempt: context.attempt,
    build_base_commit: context.build_base_commit, reviewed_commit: context.candidate_commit, reviewed_tree: context.candidate_tree, changed_paths: context.changed_paths,
    dispositions: Object.fromEntries(["accepted_contract", "public_contract", "persisted_contract", "product_scope", "security_boundary", "generated_ownership", "decomposition"].map((key) => [key, "preserved"])),
    verdict, required_fixes: requiredFixes, reviewed_at: NOW,
  };
}

function amendmentReviewPrompt(amendment) {
  return `FEATURE_FACTORY_INTEGRATION_AMENDMENT_REVIEW ${JSON.stringify(reviewMarker(amendment))}\nReview only the checked integration amendment candidate.`;
}

function checkedReviewPromptContext(prompt) {
  const encoded = prompt.match(/PLUGIN_CHECKED_INTEGRATION_AMENDMENT_REVIEW_CONTEXT_START[\s\S]*?context_base64url: ([A-Za-z0-9_-]+)/u)?.[1];
  assert.ok(encoded, "checked amendment review context must be present");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

function writeVerification(fixture) {
  const run = readRun(fixture);
  const amendment = run.integration_amendment;
  writeExecution(fixture.runDir, { phase: "verify", identity: { schema_version: 1, kind: "integration-amendment-identity", run_id: RUN_ID, defect_path: amendment.defect_path, admission: amendment.admission }, amendmentId: amendment.amendment_id, probe: amendment.admission.probe, head: amendment.integration.commit, tree: amendment.integration.tree, cwd: amendment.integration.worktree, exitCode: 0 });
}

async function reachIntegrated(fixture) {
  await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
  const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
  const candidate = commitCandidate(built.integration_amendment.attempts[0].worktree);
  bindAmendmentDispatch(fixture, candidate);
  await publishAmendmentReview(fixture, "APPROVE", []);
  await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
  return transitionIntegrationAmendment(fixture.runDir, { action: "integrate" }, { repoRoot: fixture.repo, now: NOW });
}

async function reachVerified(fixture) {
  await reachIntegrated(fixture);
  writeVerification(fixture);
  return transitionIntegrationAmendment(fixture.runDir, { action: "verify" }, { repoRoot: fixture.repo, now: NOW });
}

async function reachMerged(fixture) {
  await reachVerified(fixture);
  return transitionIntegrationAmendment(fixture.runDir, { action: "merge" }, { repoRoot: fixture.repo, now: NOW });
}

function addAcceptedTechnicalBrief(fixture) {
  const artifactRef = "artifacts/technical-brief.md";
  const reviewRef = "reviews/spec-writer.json";
  mkdirSync(join(fixture.runDir, "artifacts"), { recursive: true });
  writeFileSync(join(fixture.runDir, artifactRef), "Implement the checked consumer slice.\n");
  writeJson(join(fixture.runDir, reviewRef), { subject: "spec-writer", attempt: 1, verdict: "APPROVE", required_fixes: [] });
  const run = readRun(fixture);
  run.steps.unshift({
    agent: "spec-writer",
    status: "accepted",
    attempts: 1,
    artifact_ref: artifactRef,
    review_ref: reviewRef,
    acceptance: {
      artifact_ref: artifactRef,
      artifact_hash: hashFile(join(fixture.runDir, artifactRef)),
      review_ref: reviewRef,
      review_hash: hashFile(join(fixture.runDir, reviewRef)),
    },
  });
  writeJson(join(fixture.runDir, "run.json"), validateRun(run));
}

async function advanceMergedAmendmentConsumer(fixture, { assertCurrentDispatchTamper = false } = {}) {
  const integrationCommit = readRun(fixture).integration_amendment.integration.commit;
  const branch = "consumer-build";
  const worktree = join(fixture.repo, ".opencode", "worktrees", branch);
  git(fixture.repo, ["branch", branch, integrationCommit]);
  git(fixture.repo, ["worktree", "add", worktree, branch]);
  const startedResult = await transitionRunSlice(fixture.runDir, "consumer", {
    status: "running", attempts: 1, branch, worktree,
  }, { mustExist: true, now: NOW });
  assert.equal(checkRunConsistency(fixture.runDir, readRun(fixture)).ok, true, "merged amendment accepts checked consumer start");

  const token = "consumer-builder-callback";
  const context = await prepareSliceBuilderTaskDispatch(fixture.repo, {
    run_id: RUN_ID, slice_id: "consumer", attempt: 1, agent: "backend-builder",
  }, { claimDispatch: true, completionToken: token, now: NOW });
  if (assertCurrentDispatchTamper) {
    const claimPath = join(fixture.runDir, context.dispatch_claim.ref);
    const claimBytes = readFileSync(claimPath);
    const claim = readJson(claimPath);
    claim.context_hash = sha("stale-current-consumer-context");
    writeJson(claimPath, claim);
    assert.equal(checkRunConsistency(fixture.runDir, readRun(fixture)).ok, false, "merged amendment rejects stale current consumer dispatch claim");
    writeFileSync(claimPath, claimBytes);
  }
  mkdirSync(join(worktree, "src", "consumer"), { recursive: true });
  writeFileSync(join(worktree, "src", "consumer", "index.js"), "export const consumer = true;\n");
  git(worktree, ["add", "src/consumer/index.js"]);
  git(worktree, ["commit", "-m", "implement consumer integration"]);
  const reviewedCommit = git(worktree, ["rev-parse", "HEAD"]).trim();
  await completeSliceBuilderTaskDispatch(fixture.repo, {
    run_id: RUN_ID, slice_id: "consumer", attempt: 1, agent: "backend-builder",
    claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash, completion_token: token,
  }, { now: NOW });
  assert.equal(checkRunConsistency(fixture.runDir, readRun(fixture)).ok, true, "merged amendment accepts checked consumer callback completion");
  if (assertCurrentDispatchTamper) {
    const current = readRun(fixture).slices.find((slice) => slice.id === "consumer");
    const closurePath = join(fixture.runDir, current.dispatch_closure_ref);
    const closureBytes = readFileSync(closurePath);
    const closure = readJson(closurePath);
    closure.completion_head = integrationCommit;
    writeJson(closurePath, closure);
    assert.equal(checkRunConsistency(fixture.runDir, readRun(fixture)).ok, false, "merged amendment rejects stale current consumer dispatch closure");
    writeFileSync(closurePath, closureBytes);
  }

  const plan = readJson(join(fixture.runDir, "plan", "slices.json"));
  const family = writeVerificationArtifactReceipt({
    runDir: fixture.runDir, runId: RUN_ID, plan, sliceId: "consumer", attempt: 1, reviewedCommit,
    artifactId: "fixture-artifact-2", evidenceRef: "evidence/consumer-family.json",
    result: { type: "verification-result", outcome: "pass", summary: "Verify consumer behavior passed" },
  });
  const evidenceRef = "evidence/consumer.json";
  const reviewRef = "reviews/consumer.json";
  writeJson(join(fixture.runDir, evidenceRef), { subject: "consumer", attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommit, ownership_disclosure: [] });
  const review = createSliceReviewRecord({ subject: "consumer", attempt: 1, reviewedCommit });
  review.invariant_family_ledger = passingInvariantFamilyLedger({ plan, sliceId: "consumer", reviewedCommit, evidenceRef: family.ref, evidenceHash: family.hash });
  writeJson(join(fixture.runDir, reviewRef), review);
  const reviewedResult = await transitionRunSlice(fixture.runDir, "consumer", {
    status: "review", attempts: 1, evidence_ref: evidenceRef, review_ref: reviewRef,
  }, { mustExist: true, now: NOW });
  assert.equal(checkRunConsistency(fixture.runDir, readRun(fixture)).ok, true, "merged amendment accepts checked consumer review");

  git(fixture.featureWorktree, ["merge", "--no-ff", branch, "-m", "merge consumer integration"]);
  const mergeCommit = git(fixture.featureWorktree, ["rev-parse", "HEAD"]).trim();
  const mergedResult = await transitionSliceMerged(fixture.runDir, "consumer", { merge_commit: mergeCommit }, { repoRoot: fixture.repo, now: NOW });
  return { started: startedResult.slice, reviewed: reviewedResult.slice, merged: mergedResult.slice, reviewedCommit, mergeCommit };
}

async function publishConsumerReview(fixture, { attempt, reviewedCommit, verdict = "APPROVE", requiredFixes = [] }) {
  const plan = readJson(join(fixture.runDir, "plan", "slices.json"));
  const familyRef = `evidence/consumer-family-${attempt}.json`;
  const family = writeVerificationArtifactReceipt({
    runDir: fixture.runDir, runId: RUN_ID, plan, sliceId: "consumer", attempt, reviewedCommit,
    artifactId: "fixture-artifact-2", evidenceRef: familyRef,
    result: { type: "verification-result", outcome: "pass", summary: "Verify consumer behavior passed" },
  });
  const evidenceRef = `evidence/consumer-${attempt}.json`;
  const reviewRef = `reviews/consumer-${attempt}.json`;
  writeJson(join(fixture.runDir, evidenceRef), { subject: "consumer", attempt, status: "pass", review_ready: true, head_sha: reviewedCommit, ownership_disclosure: [] });
  const review = createSliceReviewRecord({
    subject: "consumer", attempt, reviewedCommit, verdict, requiredFixes,
    likelyPaths: ["src/consumer/index.js"], fixOwner: "consumer",
  });
  review.invariant_family_ledger = passingInvariantFamilyLedger({ plan, sliceId: "consumer", reviewedCommit, evidenceRef: family.ref, evidenceHash: family.hash });
  writeJson(join(fixture.runDir, reviewRef), review);
  return transitionRunSlice(fixture.runDir, "consumer", { status: "review", attempts: attempt, evidence_ref: evidenceRef, review_ref: reviewRef }, { mustExist: true, now: NOW });
}

function downstreamProductionConsumers({ includeGate = false } = {}) {
  return [
    ...(includeGate ? [["gate", (fixture) => transitionGateDecision(fixture.runDir, "pre_pr", { status: "pending", artifact: "artifacts/test-report.md", question_ref: "gates/pre-pr.md" })]] : []),
    ["panel", (fixture) => transitionPanelVerdicts(fixture.runDir, {
      validator: { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" },
      security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" },
    })],
    ["PR", (fixture) => transitionPrCreated(fixture.runDir, {}, { fenceToken: "stale-pr-fence" })],
    ["post-PR", (fixture) => transitionPostPrState(fixture.runDir, createPostPrState({ enabled: true, wait_ms: 3600000, initial_poll_ms: 30000, max_poll_ms: 120000, check_start_grace_ms: 300000, max_transient_errors: 12, review: { required: false, reviewer_login: null, source: "none" } }))],
  ];
}

function snapshotAmendmentGateAuthority(fixture) {
  const run = readRun(fixture);
  return {
    run_bytes: readFileSync(join(fixture.runDir, "run.json")),
    gates: structuredClone(run.gates),
    steering: structuredClone(run.steering ?? null),
    sidecars: snapshotAmendmentSidecars(fixture.runDir),
  };
}

function snapshotAmendmentSidecars(root) {
  const result = {};
  const visit = (directory, prefix = "") => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, relative);
      else if (relative !== "run.json") result[relative] = readFileSync(path);
    }
  };
  visit(root);
  return result;
}

function installLegacyPrFence(fixture) {
  const run = readRun(fixture);
  run.steering = { schema_version: 1, generation: 0, pending: null, uncheckpointed: null, boundary: null, action_claim: null, last_action: null, pr_fence: { token: "stale-pr-fence", generation: 0, state_hash: hashValue(run), created_at: NOW }, history: [] };
  writeJson(join(fixture.runDir, "run.json"), run);
}

function rewriteReportOutcome(fixture, outcome) {
  const claimPath = join(fixture.runDir, "evidence", "integration-amendment.report.claim.json");
  const original = readJson(claimPath);
  rmSync(claimPath);
  rmSync(join(fixture.runDir, original.receipt_ref));
  writeExecution(fixture.runDir, {
    phase: "report", identity: original.identity, amendmentId: original.amendment_id, probe: original.probe,
    head: original.head_sha, tree: original.tree_sha, cwd: original.cwd, exitCode: outcome === "pass" ? 0 : 1,
  });
  if (outcome !== "launch-error") return;
  const claim = readJson(claimPath);
  const receiptPath = join(fixture.runDir, claim.receipt_ref);
  const receipt = readJson(receiptPath);
  Object.assign(receipt, { status: "fail", review_ready: false });
  Object.assign(receipt.commands[0], { outcome: "launch-error", status: "fail", exit_code: null, signal: null, error_code: "spawn-failed" });
  writeJson(receiptPath, receipt);
  claim.status = "fail";
  claim.receipt_hash = hashFile(receiptPath);
  writeJson(claimPath, claim);
}

function addPristineTestVerifier(fixture) {
  const run = readRun(fixture);
  run.steps.push({ agent: "test-verifier", status: "running", attempts: 0 });
  validateRun(run);
  writeJson(join(fixture.runDir, "run.json"), run);
}

function makeReportClaimActive(fixture) {
  const claimPath = join(fixture.runDir, "evidence", "integration-amendment.report.claim.json");
  const claim = readJson(claimPath);
  rmSync(join(fixture.runDir, claim.receipt_ref), { force: true });
  delete claim.completed_at;
  delete claim.status;
  delete claim.receipt_hash;
  claim.state = "active";
  writeJson(claimPath, claim);
}

function rewriteExecutionBinding(fixture, field, value) {
  const claimPath = join(fixture.runDir, "evidence", "integration-amendment.report.claim.json");
  const claim = readJson(claimPath);
  const receiptPath = join(fixture.runDir, claim.receipt_ref);
  const receipt = readJson(receiptPath);
  claim[field] = value;
  receipt[field] = value;
  writeJson(receiptPath, receipt);
  claim.receipt_hash = hashFile(receiptPath);
  writeJson(claimPath, claim);
}

function rewriteReportAsForeignRun(fixture) {
  const claimPath = join(fixture.runDir, "evidence", "integration-amendment.report.claim.json");
  const claim = readJson(claimPath);
  const oldReceiptPath = join(fixture.runDir, claim.receipt_ref);
  const receipt = readJson(oldReceiptPath);
  claim.identity.run_id = "foreign-run";
  const amendmentId = integrationAmendmentId(claim.identity);
  const receiptRef = `evidence/integration-amendment-${amendmentId}.report.receipt.json`;
  Object.assign(receipt, { run_id: "foreign-run", amendment_id: amendmentId, subject: `integration-amendment:${amendmentId}:report` });
  rmSync(oldReceiptPath);
  writeJson(join(fixture.runDir, receiptRef), receipt);
  Object.assign(claim, {
    run_id: "foreign-run",
    amendment_id: amendmentId,
    subject: `integration-amendment:${amendmentId}:report`,
    receipt_ref: receiptRef,
    receipt_hash: hashFile(join(fixture.runDir, receiptRef)),
  });
  writeJson(claimPath, claim);
}

function writeExecution(runDir, { phase, identity, amendmentId, probe, head, tree, cwd, exitCode }) {
  const nonce = `${phase}-nonce`;
  const receiptRef = `evidence/integration-amendment-${amendmentId}.${phase}.receipt.json`;
  const receipt = { schema_version: 1, kind: "integration-amendment-execution-receipt", phase, subject: `integration-amendment:${amendmentId}:${phase}`, run_id: RUN_ID, amendment_id: amendmentId, claim_nonce: nonce, probe, head_sha: head, tree_sha: tree, cwd, started_at: NOW, completed_at: NOW, duration_ms: 1, status: exitCode === 0 ? "pass" : "fail", review_ready: phase === "verify" ? exitCode === 0 : exitCode !== 0, commands: [{ index: 0, program: probe.program, args: probe.args, outcome: "exited", status: exitCode === 0 ? "pass" : "fail", exit_code: exitCode, signal: null, error_code: null, duration_ms: 1, stdout: stream(), stderr: stream() }] };
  writeJson(join(runDir, receiptRef), receipt);
  const claim = { schema_version: 1, kind: "integration-amendment-execution-claim", phase, subject: receipt.subject, state: "completed", nonce, amendment_id: amendmentId, identity, run_id: RUN_ID, probe, head_sha: head, tree_sha: tree, cwd, receipt_ref: receiptRef, claimed_at: NOW, completed_at: NOW, status: receipt.status, receipt_hash: hashFile(join(runDir, receiptRef)) };
  const claimRef = phase === "report" ? "evidence/integration-amendment.report.claim.json" : `evidence/integration-amendment-${amendmentId}.${phase}.claim.json`;
  writeJson(join(runDir, claimRef), claim);
}

let candidateValue = 2;
function commitCandidate(worktree) {
  candidateValue += 1;
  writeFileSync(join(worktree, "src", "owner", "api.js"), `export const value = ${candidateValue};\n`);
  git(worktree, ["add", "src/owner/api.js"]);
  git(worktree, ["commit", "-m", "amend owner integration"]);
  return git(worktree, ["rev-parse", "HEAD"]).trim();
}

function commitCandidatePath(worktree, path, value) {
  mkdirSync(dirname(join(worktree, path)), { recursive: true });
  writeFileSync(join(worktree, path), `export const value = ${JSON.stringify(value)};\n`);
  git(worktree, ["add", "--", path]);
  git(worktree, ["commit", "-m", `amend ${value}`]);
  return git(worktree, ["rev-parse", "HEAD"]).trim();
}

function reportRequest() {
  return { action: "report", owner_slice_id: "owner", consumer_slice_id: "consumer", defect_path: "src/owner/api.js", verification_artifact_id: "fixture-artifact-2" };
}

function manifestFixture() {
  const id = "A".repeat(43);
  const admission = { baseline_ref: "refs/heads/f", baseline_commit: "1".repeat(40), baseline_tree: "2".repeat(40), worktree: "/tmp/f", probe: { schema_version: 1, kind: "integration-amendment-probe", delivery_unit_id: "u", consumer_slice_id: "consumer", verification_artifact_id: "artifact", test_plan_index: 0, test_plan_entry: "node test.js", program: "node", args: ["test.js"], substrate: "feature-baseline" }, owner: { id: "owner", stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status: "merged", attempts: 1, attempt_reviews: [{ attempt: 1, evidence_ref: "evidence/o.json", evidence_hash: sha("e"), review_ref: "reviews/o.json", review_hash: sha("r"), reviewed_commit: "3".repeat(40), diff_base_commit: "1".repeat(40), ratified_paths: [], verdict: "APPROVE", convergence: "converging", remaining_fix_count: 0 }], evidence_ref: "evidence/o.json", evidence_hash: sha("e"), review_ref: "reviews/o.json", review_hash: sha("r"), reviewed_commit: "3".repeat(40), merge_commit: "4".repeat(40) }, consumer: { id: "consumer", stack: "backend", depends_on: ["owner"], declared_paths: ["test/**"], effective_paths: ["test/**"], status: "pending", attempts: 0 } };
  return { schema_version: 1, kind: "integration-amendment", amendment_id: id, status: "reported", owner_slice_id: "owner", consumer_slice_id: "consumer", defect_path: "src/a.js", verification_artifact_id: "artifact", admission, failure_execution: { claim_ref: "evidence/integration-amendment.report.claim.json", claim_hash: sha("c"), receipt_ref: `evidence/integration-amendment-${id}.report.receipt.json`, receipt_hash: sha("x") }, max_attempts: 2, attempts: [], created_at: NOW, updated_at: NOW };
}

function buildingAttempt(attempt, base) { const id = "A".repeat(43); return { attempt, state: "building", build_base_commit: base, branch_ref: `refs/heads/f--amend-${id}-a${attempt}`, worktree: `/tmp/f/.opencode/worktrees/f--amend-${id}-a${attempt}` }; }
function reviewedAttempt(attempt, base) { const id = "A".repeat(43); return { ...buildingAttempt(attempt, base), state: "reviewed", dispatch_claim_ref: `dispatch/${"a".repeat(64)}.special.json`, dispatch_claim_hash: sha("dc"), dispatch_closure_ref: `dispatch/${"a".repeat(64)}.special.closed.json`, dispatch_closure_hash: sha("dx"), candidate_commit: "5".repeat(40), candidate_tree: "6".repeat(40), changed_paths: ["src/a.js"], review_ref: `reviews/integration-amendment-${id}.attempt-${attempt}.json`, review_hash: sha("rv"), reviewed_commit: "5".repeat(40), reviewed_tree: "6".repeat(40) }; }
function integrationFixture(base, attempt) { return { ref: `refs/opencode/integration-amendments/${base.amendment_id}/staged`, worktree: `/tmp/f/.opencode/worktrees/f--amend-${base.amendment_id}-staged`, commit: "7".repeat(40), tree: attempt.reviewed_tree }; }
function verificationBinding(id) { return { claim_ref: `evidence/integration-amendment-${id}.verify.claim.json`, claim_hash: sha("vc"), receipt_ref: `evidence/integration-amendment-${id}.verify.receipt.json`, receipt_hash: sha("vr") }; }
function publicationFixture(base) { return { branch_ref: base.admission.baseline_ref, previous_commit: base.admission.baseline_commit, commit: "7".repeat(40), published_at: NOW }; }
function blocked(base, attempts, origin) { return { ...base, status: "blocked", attempts, blocked: { origin, reason: "stopped", blocked_at: NOW } }; }
function stream() { return { captured_bytes: 0, sha256: sha(""), truncated: false }; }

function executionOptions(behaviors, calls, overrides = {}) {
  const queue = [...behaviors];
  return {
    env: { PATH: "/fixture/bin", HOME: "/fixture/home", UNSAFE_SECRET: "do-not-forward" },
    now: NOW,
    spawnFn(program, args, options) {
      const behavior = queue.shift();
      calls.push({ program, args: [...args], options });
      if (!behavior) throw new Error("unexpected spawn");
      if (behavior.launchThrow) throw new Error("launch failed");
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        queueMicrotask(() => child.emit("close", null, "SIGKILL"));
        return true;
      };
      queueMicrotask(() => {
        if (behavior.stdout) child.stdout.emit("data", behavior.stdout);
        if (behavior.stderr) child.stderr.emit("data", behavior.stderr);
        if (behavior.pipeError) child.stdout.emit("error", new Error("pipe failed"));
        if (!behavior.hang) child.emit("close", behavior.indeterminate ? null : behavior.code ?? 0, behavior.signal ?? null);
      });
      return child;
    },
    ...overrides,
  };
}
function sha(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function pick(value, keys) { return Object.fromEntries(keys.map((key) => [key, structuredClone(value[key])])); }
function readRun(fixture) { return JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8")); }
function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function writeJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8" }); }
function cleanup(fixture) { rmSync(fixture.repo, { recursive: true, force: true }); }

after(() => { for (const repo of fixtures) if (existsSync(repo)) rmSync(repo, { recursive: true, force: true }); });
