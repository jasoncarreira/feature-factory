// Shared fixtures and helpers for the integration-amendment suites.
// Extracted verbatim from test/integration-amendment.test.js when that file
// was split for CI shard balance; behaviour is unchanged.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { execFileSync } from "../git-fixture.js";
import { withDeliveryEnvelope, passingInvariantFamilyLedger, writeVerificationArtifactReceipt } from "../delivery-envelope-fixture.js";
import { createSliceAttemptReview, createSliceReviewRecord } from "../review-record-fixture.js";
import { computePrOperationId } from "../../../src/github.js";
import { hashFile, hashValue } from "../../../src/refs.js";
import { observeIntegrationAmendmentExecutionAuthority, completeIntegrationAmendmentReviewTaskDispatch, completeSliceBuilderTaskDispatch, completeSpecialBuilderTaskDispatch, createPostPrState, hasInFlightHeartbeatWork, heartbeatOnce, prepareIntegrationAmendmentReviewTaskDispatch, prepareSliceBuilderTaskDispatch, prepareSpecialBuilderTaskDispatch, transitionGateDecision, transitionIntegrationAmendment, transitionPanelVerdicts, transitionPostPrState, transitionPrCreated, transitionRunJson, transitionRunSlice, transitionRunStep, transitionSliceMerged, transitionSteeringBoundaryOpened, transitionTerminalResult } from "../../../src/run-state.js";
import { checkRunConsistency, inspectIntegrationAmendmentInventory, integrationAmendmentId, validateIntegrationAmendment, validateIntegrationAmendmentExecutionClaim, validateIntegrationAmendmentExecutionReceipt, validateIntegrationAmendmentReview, validateRun } from "../../../src/validate.js";
import { executeIntegrationAmendment, resumeFactory } from "../../../src/factory.js";
import { executeCheckedTestExecution } from "../../../src/test-execution.js";

export const RUN_ID = "amendment-run";
export const FEATURE_BRANCH = "amendment-feature";
export const NOW = "2026-07-20T12:00:00.000Z";
export const CARRY_FORWARD_REQUIRED_SUMMARY = "Integration amendment is unsupported for this run state; continue remaining work in a fresh schema-v2 carry-forward child.";
export const fixtures = [];
export const PR79_GENERIC_PARITY = [
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


export async function exerciseGenericParity(id) {
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
        ["PR fence", (run, { base }) => {
          const repository = "acme/repo";
          run.steering = {
            schema_version: 1,
            generation: 0,
            pending: null,
            uncheckpointed: null,
            boundary: null,
            action_claim: null,
            last_action: null,
            pr_fence: {
              token: "fence-token",
              generation: 0,
              state_hash: hashValue(run),
              created_at: NOW,
              operation_id: computePrOperationId({ base_commit: base, branch: run.branch, created_at: NOW, repository, run_id: run.run_id }),
              repository,
              head_ref: run.branch,
              head_sha: git(run.worktree, ["rev-parse", "HEAD"]).trim(),
              base_ref: "main",
              base_sha: base,
              draft: false,
            },
            history: [],
          };
        }, /excluded after panel|PR/u],
        ["PR presence", (run) => { run.pr_url = "https://github.com/acme/repo/pull/79"; }, /excluded after panel|PR/u],
      ]) {
        const excluded = createFixture({ publishReport: false });
        try {
          const run = readRun(excluded);
          mutate(run, excluded);
          writeJson(join(excluded.runDir, "run.json"), run);
          await assert.rejects(executeIntegrationAmendment(excluded.runDir, reportRequest(), executionOptions([{ code: 1 }], [])), error, name);
        } finally { cleanup(excluded); }
      }
      const run = readRun(fixture);
      run.validator = { verdict: "GO", report: "artifacts/validation-report.md", report_hash: sha("validator-report"), review_ref: "reviews/implementation-validator.json", review_hash: sha("validator-review"), reviewed_head_sha: fixture.baseline };
      run.security_review = { verdict: "PASS", review_ref: "reviews/security-reviewer.json", review_hash: sha("security-review"), reviewed_head_sha: fixture.baseline };
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
      await assert.rejects(transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 1 }), /integration amendment is reported/u);
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

export async function exerciseManifestMutations(record, cases) {
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

export async function exerciseExecutionClaimMutations(record, cases) {
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

export async function exerciseExecutionReceiptMutations(record, cases) {
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

export async function exerciseAmendmentReviewMutations(record, cases) {
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

export async function exerciseBuilderDispatchMutations(record, cases) {
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

export async function reachManifestCatalogVariant(fixture, id) {
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

export async function completeRuntimeAmendmentReview(fixture, verdict) {
  const run = readRun(fixture);
  const attempt = run.integration_amendment.attempts.at(-1);
  const candidate = commitCandidate(attempt.worktree);
  bindAmendmentDispatch(fixture, candidate);
  await publishAmendmentReview(fixture, verdict, verdict === "APPROVE" ? [] : ["correct the owner implementation"]);
  return transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
}

export function blockRuntimeAmendment(fixture) {
  return transitionIntegrationAmendment(fixture.runDir, { action: "block", reason: "catalog baseline block" }, { repoRoot: fixture.repo, now: NOW });
}

export async function proveManifestTransitionAcceptance(id) {
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

export async function invokeManifestMutationConsumer(fixture, id) {
  const consistency = checkRunConsistency(fixture.runDir, readRun(fixture));
  if (!consistency.ok) throw new Error(`checkRunConsistency rejected integration amendment mutation: ${JSON.stringify(consistency.checks.filter(({ ok }) => !ok))}`);
  if (id.startsWith("amendment-blocked-")) return transitionTerminalResult(fixture.runDir, { status: "blocked", reason: "catalog baseline block" }, { now: NOW });
  if (id === "amendment-merged") return transitionRunJson(fixture.runDir, () => {});
  return blockRuntimeAmendment(fixture);
}

export async function createExecutionCatalogFixture(record, target) {
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

export function bindRuntimeExecutionClaim(source, original, receiptPath, receipt) {
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
    timeout_ms: original.timeout_ms,
    receipt_ref: original.receipt_ref,
  };
  if (claim.state === "completed") claim.receipt_hash = hashFile(receiptPath);
  return claim;
}

export function bindRuntimeCompletedClaim(original, receiptPath, receipt) {
  return {
    ...structuredClone(original),
    state: "completed",
    completed_at: NOW,
    status: receipt.status,
    receipt_hash: hashFile(receiptPath),
  };
}

export function bindRuntimeExecutionReceipt(source, claim) {
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
    timeout_ms: claim.timeout_ms,
  };
}

export async function createReviewCatalogFixture(id) {
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

export async function proveReviewTransitionAcceptance(id) {
  const fixture = await createReviewCatalogFixture(id);
  try {
    const result = await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
    assert.equal(result.integration_amendment.status, "reviewed", `${id} baseline review transition`);
  } finally { cleanup(fixture); }
}

export async function createBuilderDispatchCatalogFixture(id) {
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

export async function proveBuilderDispatchTransitionAcceptance(id) {
  const fixture = await createBuilderDispatchCatalogFixture(id);
  try {
    const result = await invokeBuilderDispatchMutationConsumer(fixture);
    if (id === "amendment-dispatch-binding-active" || id === "amendment-dispatch-claim") assert.equal(result.completion_head, fixture.builderCandidate, `${id} baseline completion transition`);
    else assert.ok(result.dispatch_claim, `${id} baseline review-dispatch transition`);
  } finally { cleanup(fixture); }
}

export function invokeBuilderDispatchMutationConsumer(fixture) {
  const run = readRun(fixture);
  if (!run.special_builder_dispatch?.closure_ref) {
    return completeSpecialBuilderTaskDispatch(fixture.repo, {
      run_id: RUN_ID, route: "integration-amendment", agent: "backend-builder", claim_ref: fixture.builderContext.dispatch_claim.ref,
      claim_hash: fixture.builderContext.dispatch_claim.hash, completion_token: fixture.builderToken,
    }, { now: NOW });
  }
  return prepareIntegrationAmendmentReviewTaskDispatch(fixture.repo, reviewMarker(run.integration_amendment), { claimDispatch: true, completionToken: "catalog-review-dispatch", now: NOW });
}

export function assertDirectValidatorDisposition(invoke, expected, validatorName, mutationCase) {
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

export function isMutationSpecificRejection(error, mutationCase, consumer) {
  assert.ok(error instanceof Error, `${mutationCase.name} ${consumer} must throw Error`);
  assert.ok(error.message.length > 0, `${mutationCase.name} ${consumer} must identify rejection`);
  assert.doesNotMatch(error.message, /unexpected spawn|catalog baseline fixture/u, `${mutationCase.name} must not fail through unrelated fixture scaffolding`);
  return true;
}

export function assertRuntimeConsistency(fixture, run, label) {
  const consistency = checkRunConsistency(fixture.runDir, run);
  assert.equal(consistency.ok, true, `${label}: ${JSON.stringify(consistency.checks.filter(({ ok }) => !ok))}`);
}

export function applyRuntimeExternalMutation(runDir, record, mutationCase, actualRecord) {
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

export function findScalarPath(value, expected, path = []) {
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

export function valueAtRuntimePath(value, path) {
  return path.reduce((current, segment) => current?.[segment], value);
}

export function applyMutationDifference(actual, source, mutated) {
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

export function isPlainRuntimeObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function snapshotRuntimeFiles(root) {
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

export function restoreRuntimeFiles(root, snapshot) {
  for (const [relative, bytes] of Object.entries(snapshot)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
}

// The git topology — base commit, owner-build worktree carrying the reviewed
// owner commit, the no-ff merge onto the feature branch, and optionally a
// managed feature worktree — is identical for every fixture sharing the same
// managedFeatureWorktree flag; every other parameter shapes only the JSON
// written afterwards. Build each variant once per process and cpSync per
// fixture. Worktree metadata stores absolute paths, so one `git worktree
// repair` per clone relinks the copies; commit SHAs are byte-copied and reused
// from the template. Templates are registered in `fixtures`, which is swept
// once at process end.
export const amendmentGitTemplates = new Map();

export function amendmentGitTemplate(managedFeatureWorktree) {
  const key = managedFeatureWorktree ? "managed" : "plain";
  const cached = amendmentGitTemplates.get(key);
  if (cached) return cached;
  const repo = mkdtempSync(join(tmpdir(), "feature-factory-amendment-template-"));
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
  if (managedFeatureWorktree) {
    git(repo, ["checkout", "main"]);
    git(repo, ["worktree", "add", join(repo, ".opencode", "worktrees", FEATURE_BRANCH), FEATURE_BRANCH]);
  }
  const template = { repo, base, reviewedCommit, baseline, baselineTree };
  amendmentGitTemplates.set(key, template);
  return template;
}

export function createFixture({ managedFeatureWorktree = false, publishReport = true, ownerPaths = ["src/owner/**"], consumerPaths = ["src/consumer/**"], extraSlices = [] } = {}) {
  const template = amendmentGitTemplate(managedFeatureWorktree);
  const repo = mkdtempSync(join(tmpdir(), "feature-factory-amendment-"));
  fixtures.push(repo);
  cpSync(template.repo, repo, { recursive: true });
  const ownerWorktree = join(repo, ".opencode", "worktrees", "owner-build");
  let featureWorktree = repo;
  if (managedFeatureWorktree) featureWorktree = join(repo, ".opencode", "worktrees", FEATURE_BRANCH);
  git(repo, ["worktree", "repair", ownerWorktree, ...(managedFeatureWorktree ? [featureWorktree] : [])]);
  const { base, reviewedCommit, baseline, baselineTree } = template;
  const runDir = join(repo, ".opencode", "factory", RUN_ID);
  for (const dir of ["plan", "evidence", "reviews", "dispatch"]) mkdirSync(join(runDir, dir), { recursive: true });
  const plan = withDeliveryEnvelope({
    slices: [
      { id: "owner", stack: "backend", paths: ownerPaths, depends_on: [], acceptance: ["owner works"], test_plan: ["node --test test/owner.test.js"] },
      { id: "consumer", stack: "backend", paths: consumerPaths, depends_on: ["owner"], acceptance: ["consumer works"], test_plan: ["node --test test/consumer.test.js"] },
      ...extraSlices.map((slice) => ({ id: slice.id, stack: slice.stack || "backend", paths: slice.effective_paths, depends_on: slice.depends_on || [], acceptance: ["extra works"], test_plan: ["node --test test/extra.test.js"] })),
    ],
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
  }, { explicitExecutionTimeouts: true });
  for (const unit of plan.delivery_envelope.delivery_units) unit.verification_artifacts[0].timeout_ms = 1000;
  writeJson(join(runDir, "plan", "slices.json"), plan);
  writeJson(join(runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] });
  const family = writeVerificationArtifactReceipt({ runDir, runId: RUN_ID, plan, sliceId: "owner", attempt: 1, reviewedCommit, artifactId: "fixture-artifact-1", evidenceRef: "evidence/owner-family.json", result: { type: "verification-result", outcome: "pass", summary: "Verify owner behavior passed" } });
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

// Publishes the amendment report sidecar for a run this module did not build.
// createFixture bakes in its own run id, feature branch, and owner/consumer
// slice ids; a carry-forward parent from createV2Fixture uses different ones,
// and without a published report `transitionIntegrationAmendment({action:
// "report"})` fails with `integration amendment report cannot consume
// all-absent`.
//
// The admission is taken from the production observer rather than rebuilt with
// admissionFixture. Report admission re-derives the admission and rejects any
// claim whose identity, probe, head, tree, or cwd differs, so reconstructing it
// by hand means guessing five values correctly; deriving it cannot drift.
export function publishAmendmentReportFor({ runDir, run, request, exitCode = 1 }) {
  const authority = observeIntegrationAmendmentExecutionAuthority(runDir, run, "report", request, { repoRoot: run.worktree });
  writeExecution(runDir, {
    phase: "report",
    identity: authority.identity,
    amendmentId: authority.amendment_id,
    probe: authority.probe,
    head: authority.head_sha,
    tree: authority.tree_sha,
    cwd: authority.cwd,
    exitCode,
    runId: run.run_id,
  });
  return authority;
}

export function carryForwardTerminalResult() {
  return { status: "blocked", reason: "carry-forward-required", summary: CARRY_FORWARD_REQUIRED_SUMMARY, artifacts: {} };
}

export function admissionFixture({ repo, baseline, baselineTree, owner, consumer, plan, consumerSliceId = "consumer", featureBranch = FEATURE_BRANCH }) {
  const unit = plan.delivery_envelope.delivery_units.find((entry) => entry.slice_id === consumerSliceId);
  const artifact = unit.verification_artifacts[0];
  return {
    baseline_ref: `refs/heads/${featureBranch}`, baseline_commit: baseline, baseline_tree: baselineTree, worktree: repo,
    probe: { schema_version: 1, kind: "integration-amendment-probe", delivery_unit_id: unit.id, consumer_slice_id: consumerSliceId, verification_artifact_id: artifact.id, test_plan_index: artifact.test_plan_index, test_plan_entry: artifact.test_plan_entry, program: "node", args: ["--test", "test/consumer.test.js"], timeout_ms: artifact.timeout_ms, substrate: "feature-baseline" },
    owner: pick(owner, ["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts", "attempt_reviews", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "merge_commit"]),
    consumer: pick(consumer, ["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts"]),
  };
}

export function writeOwnerDispatch(runDir, head, completionHead, worktree, { runId = RUN_ID, sliceId = "owner", branch = "owner-build", attempt = 1 } = {}) {
  const name = `${createHash("sha256").update(`${runId}\0${sliceId}\0${attempt}`).digest("hex")}.json`;
  const claimRef = `dispatch/${name}`;
  const closureRef = `dispatch/${name.slice(0, -5)}.closed.json`;
  const token = "owner-token";
  const claim = { schema_version: 1, kind: "checked-slice-builder-dispatch-claim", run_id: runId, slice_id: sliceId, attempt, agent: "backend-builder", branch, worktree, head, context_hash: hashValue({ owner: true }), completion_token_hash: sha(token), claimed_at: NOW, closure_ref: closureRef };
  writeJson(join(runDir, claimRef), claim);
  const claimHash = hashFile(join(runDir, claimRef));
  const closure = { schema_version: 1, kind: "checked-slice-builder-dispatch-closure", claim_ref: claimRef, claim_hash: claimHash, run_id: runId, slice_id: sliceId, attempt, agent: "backend-builder", branch, worktree, head, completion_head: completionHead, context_hash: claim.context_hash, completion_token: token, returned_at: NOW };
  writeJson(join(runDir, closureRef), closure);
  return { dispatch_claim_ref: claimRef, dispatch_claim_hash: claimHash, dispatch_closure_ref: closureRef, dispatch_closure_hash: hashFile(join(runDir, closureRef)) };
}

export function bindAmendmentDispatch(fixture, candidate) {
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

export async function publishAmendmentReview(fixture, verdict, requiredFixes, options = {}) {
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

export function reviewMarker(amendment) {
  return { run_id: RUN_ID, amendment_id: amendment.amendment_id, attempt: amendment.attempts.at(-1).attempt, agent: "work-reviewer" };
}

export function reviewFromContext(context, verdict, requiredFixes) {
  return {
    schema_version: 1, kind: "integration-amendment-review", subject: `integration-amendment:${context.amendment_id}`, amendment_id: context.amendment_id, attempt: context.attempt,
    build_base_commit: context.build_base_commit, reviewed_commit: context.candidate_commit, reviewed_tree: context.candidate_tree, changed_paths: context.changed_paths,
    dispositions: Object.fromEntries(["accepted_contract", "public_contract", "persisted_contract", "product_scope", "security_boundary", "generated_ownership", "decomposition"].map((key) => [key, "preserved"])),
    verdict, required_fixes: requiredFixes, reviewed_at: NOW,
  };
}

export function amendmentReviewPrompt(amendment) {
  return `FEATURE_FACTORY_INTEGRATION_AMENDMENT_REVIEW ${JSON.stringify(reviewMarker(amendment))}\nReview only the checked integration amendment candidate.`;
}

export function checkedReviewPromptContext(prompt) {
  const encoded = prompt.match(/PLUGIN_CHECKED_INTEGRATION_AMENDMENT_REVIEW_CONTEXT_START[\s\S]*?context_base64url: ([A-Za-z0-9_-]+)/u)?.[1];
  assert.ok(encoded, "checked amendment review context must be present");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

export function writeVerification(fixture) {
  const run = readRun(fixture);
  const amendment = run.integration_amendment;
  writeExecution(fixture.runDir, { phase: "verify", identity: { schema_version: 1, kind: "integration-amendment-identity", run_id: RUN_ID, defect_path: amendment.defect_path, admission: amendment.admission }, amendmentId: amendment.amendment_id, probe: amendment.admission.probe, head: amendment.integration.commit, tree: amendment.integration.tree, cwd: amendment.integration.worktree, exitCode: 0 });
}

export async function reachIntegrated(fixture) {
  await transitionIntegrationAmendment(fixture.runDir, reportRequest(), { repoRoot: fixture.repo, now: NOW });
  const built = await transitionIntegrationAmendment(fixture.runDir, { action: "build", attempt: 1 }, { repoRoot: fixture.repo, now: NOW });
  const candidate = commitCandidate(built.integration_amendment.attempts[0].worktree);
  bindAmendmentDispatch(fixture, candidate);
  await publishAmendmentReview(fixture, "APPROVE", []);
  await transitionIntegrationAmendment(fixture.runDir, { action: "review" }, { repoRoot: fixture.repo, now: NOW });
  return transitionIntegrationAmendment(fixture.runDir, { action: "integrate" }, { repoRoot: fixture.repo, now: NOW });
}

export async function reachVerified(fixture) {
  await reachIntegrated(fixture);
  writeVerification(fixture);
  return transitionIntegrationAmendment(fixture.runDir, { action: "verify" }, { repoRoot: fixture.repo, now: NOW });
}

export async function reachMerged(fixture) {
  await reachVerified(fixture);
  return transitionIntegrationAmendment(fixture.runDir, { action: "merge" }, { repoRoot: fixture.repo, now: NOW });
}

export function addAcceptedTechnicalBrief(fixture) {
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

export async function advanceMergedAmendmentConsumer(fixture, { assertCurrentDispatchTamper = false } = {}) {
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
  review.ownership_ratification = { schema_version: 2, kind: "factory-derived-modified-extension" };
  review.invariant_family_ledger = passingInvariantFamilyLedger({ plan, sliceId: "consumer", reviewedCommit, evidenceRef: family.ref, evidenceHash: family.hash });
  writeJson(join(fixture.runDir, reviewRef), review);
  const reviewedResult = await transitionRunSlice(fixture.runDir, "consumer", {
    status: "review", attempts: 1, evidence_ref: evidenceRef, review_ref: reviewRef,
  }, { mustExist: true, now: NOW });
  assert.equal(checkRunConsistency(fixture.runDir, readRun(fixture)).ok, true, "merged amendment accepts checked consumer review");
  git(fixture.featureWorktree, ["merge", "--no-ff", branch, "-m", "merge consumer integration"]);
  const mergeCommit = git(fixture.featureWorktree, ["rev-parse", "HEAD"]).trim();
  const mergedResult = await transitionSliceMerged(fixture.runDir, "consumer", { merge_commit: mergeCommit }, { repoRoot: fixture.repo, now: NOW });
  await establishAcceptedCheckedTestAuthority(fixture, mergeCommit);
  return { started: startedResult.slice, reviewed: reviewedResult.slice, merged: mergedResult.slice, reviewedCommit, mergeCommit };
}

export async function establishAcceptedCheckedTestAuthority(fixture, head) {
  const run = readRun(fixture);
  run.steps.push({ agent: "test-verifier", status: "blocked", attempts: 0 });
  writeJson(join(fixture.runDir, "run.json"), validateRun(run));
  await transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 1 }, { mustExist: true });
  const completed = await executeCheckedTestExecution(fixture.runDir, executionOptions([{ code: 0 }], []));
  assert.equal(completed.status, "pass");
  assert.equal(completed.head_sha, head);
  writeFileSync(join(fixture.runDir, "artifacts", "test-report.md"), "consumer integration passed\n");
  const reviewRef = "reviews/test-verifier.attempt-1.json";
  writeJson(join(fixture.runDir, reviewRef), { subject: "test-verifier", attempt: 1, verdict: "APPROVE", reviewed_head_sha: head, required_fixes: [] });
  const accepted = await transitionRunStep(fixture.runDir, "test-verifier", {
    status: "accepted", attempts: 1, artifact_ref: "artifacts/test-report.md", evidence_ref: completed.receipt_ref, review_ref: reviewRef,
  }, { mustExist: true });
  writeFileSync(join(fixture.runDir, "artifacts", "validation-report.md"), "GO\n");
  writeJson(join(fixture.runDir, "reviews", "implementation-validator.json"), { subject: FEATURE_BRANCH, attempt: 1, verdict: "GO", reviewed_head_sha: head, required_fixes: [] });
  writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), { subject: FEATURE_BRANCH, attempt: 1, verdict: "PASS", reviewed_head_sha: head, required_fixes: [] });
  await transitionPanelVerdicts(fixture.runDir, {
    validator: { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" },
    security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" },
  });
  return accepted;
}

export async function publishConsumerReview(fixture, { attempt, reviewedCommit, verdict = "APPROVE", requiredFixes = [] }) {
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
  review.ownership_ratification = { schema_version: 2, kind: "factory-derived-modified-extension" };
  review.invariant_family_ledger = passingInvariantFamilyLedger({ plan, sliceId: "consumer", reviewedCommit, evidenceRef: family.ref, evidenceHash: family.hash });
  writeJson(join(fixture.runDir, reviewRef), review);
  return transitionRunSlice(fixture.runDir, "consumer", { status: "review", attempts: attempt, evidence_ref: evidenceRef, review_ref: reviewRef }, { mustExist: true, now: NOW });
}

export function downstreamProductionConsumers({ includeGate = false } = {}) {
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

export function snapshotAmendmentGateAuthority(fixture) {
  const run = readRun(fixture);
  return {
    run_bytes: readFileSync(join(fixture.runDir, "run.json")),
    gates: structuredClone(run.gates),
    steering: structuredClone(run.steering ?? null),
    sidecars: snapshotAmendmentSidecars(fixture.runDir),
  };
}

export function snapshotAmendmentSidecars(root) {
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

export function rewriteReportOutcome(fixture, outcome) {
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

export function addPristineTestVerifier(fixture) {
  const run = readRun(fixture);
  run.steps.push({ agent: "test-verifier", status: "running", attempts: 0 });
  validateRun(run);
  writeJson(join(fixture.runDir, "run.json"), run);
}

export function makeReportClaimActive(fixture) {
  const claimPath = join(fixture.runDir, "evidence", "integration-amendment.report.claim.json");
  const claim = readJson(claimPath);
  rmSync(join(fixture.runDir, claim.receipt_ref), { force: true });
  delete claim.completed_at;
  delete claim.status;
  delete claim.receipt_hash;
  claim.state = "active";
  writeJson(claimPath, claim);
}

export function rewriteExecutionBinding(fixture, field, value) {
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

export function rewriteReportAsForeignRun(fixture) {
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

export function writeExecution(runDir, { phase, identity, amendmentId, probe, head, tree, cwd, exitCode, runId = RUN_ID }) {
  const nonce = `${phase}-nonce`;
  const timeoutMs = probe.timeout_ms ?? 300_000;
  const receiptRef = `evidence/integration-amendment-${amendmentId}.${phase}.receipt.json`;
  const receipt = { schema_version: 1, kind: "integration-amendment-execution-receipt", phase, subject: `integration-amendment:${amendmentId}:${phase}`, run_id: runId, amendment_id: amendmentId, claim_nonce: nonce, probe, head_sha: head, tree_sha: tree, cwd, timeout_ms: timeoutMs, started_at: NOW, completed_at: NOW, duration_ms: 1, status: exitCode === 0 ? "pass" : "fail", review_ready: phase === "verify" ? exitCode === 0 : exitCode !== 0, commands: [{ index: 0, program: probe.program, args: probe.args, outcome: "exited", status: exitCode === 0 ? "pass" : "fail", exit_code: exitCode, signal: null, error_code: null, duration_ms: 1, stdout: stream(), stderr: stream() }] };
  writeJson(join(runDir, receiptRef), receipt);
  const claim = { schema_version: 1, kind: "integration-amendment-execution-claim", phase, subject: receipt.subject, state: "completed", nonce, amendment_id: amendmentId, identity, run_id: runId, probe, head_sha: head, tree_sha: tree, cwd, timeout_ms: timeoutMs, receipt_ref: receiptRef, claimed_at: NOW, completed_at: NOW, status: receipt.status, receipt_hash: hashFile(join(runDir, receiptRef)) };
  const claimRef = phase === "report" ? "evidence/integration-amendment.report.claim.json" : `evidence/integration-amendment-${amendmentId}.${phase}.claim.json`;
  writeJson(join(runDir, claimRef), claim);
}

let candidateValue = 2;
export function commitCandidate(worktree) {
  candidateValue += 1;
  writeFileSync(join(worktree, "src", "owner", "api.js"), `export const value = ${candidateValue};\n`);
  git(worktree, ["add", "src/owner/api.js"]);
  git(worktree, ["commit", "-m", "amend owner integration"]);
  return git(worktree, ["rev-parse", "HEAD"]).trim();
}

export function commitCandidatePath(worktree, path, value) {
  mkdirSync(dirname(join(worktree, path)), { recursive: true });
  writeFileSync(join(worktree, path), `export const value = ${JSON.stringify(value)};\n`);
  git(worktree, ["add", "--", path]);
  git(worktree, ["commit", "-m", `amend ${value}`]);
  return git(worktree, ["rev-parse", "HEAD"]).trim();
}

export function reportRequest() {
  return { action: "report", owner_slice_id: "owner", consumer_slice_id: "consumer", defect_path: "src/owner/api.js", verification_artifact_id: "fixture-artifact-2" };
}

export function manifestFixture() {
  const id = "A".repeat(43);
  const admission = { baseline_ref: "refs/heads/f", baseline_commit: "1".repeat(40), baseline_tree: "2".repeat(40), worktree: "/tmp/f", probe: { schema_version: 1, kind: "integration-amendment-probe", delivery_unit_id: "u", consumer_slice_id: "consumer", verification_artifact_id: "artifact", test_plan_index: 0, test_plan_entry: "node test.js", program: "node", args: ["test.js"], substrate: "feature-baseline" }, owner: { id: "owner", stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status: "merged", attempts: 1, attempt_reviews: [{ attempt: 1, evidence_ref: "evidence/o.json", evidence_hash: sha("e"), review_ref: "reviews/o.json", review_hash: sha("r"), reviewed_commit: "3".repeat(40), diff_base_commit: "1".repeat(40), ratified_paths: [], verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0 }], evidence_ref: "evidence/o.json", evidence_hash: sha("e"), review_ref: "reviews/o.json", review_hash: sha("r"), reviewed_commit: "3".repeat(40), merge_commit: "4".repeat(40) }, consumer: { id: "consumer", stack: "backend", depends_on: ["owner"], declared_paths: ["test/**"], effective_paths: ["test/**"], status: "pending", attempts: 0 } };
  return { schema_version: 1, kind: "integration-amendment", amendment_id: id, status: "reported", owner_slice_id: "owner", consumer_slice_id: "consumer", defect_path: "src/a.js", verification_artifact_id: "artifact", admission, failure_execution: { claim_ref: "evidence/integration-amendment.report.claim.json", claim_hash: sha("c"), receipt_ref: `evidence/integration-amendment-${id}.report.receipt.json`, receipt_hash: sha("x") }, max_attempts: 2, attempts: [], created_at: NOW, updated_at: NOW };
}

export function buildingAttempt(attempt, base) { const id = "A".repeat(43); return { attempt, state: "building", build_base_commit: base, branch_ref: `refs/heads/f--amend-${id}-a${attempt}`, worktree: `/tmp/f/.opencode/worktrees/f--amend-${id}-a${attempt}` }; }
export function reviewedAttempt(attempt, base) { const id = "A".repeat(43); return { ...buildingAttempt(attempt, base), state: "reviewed", dispatch_claim_ref: `dispatch/${"a".repeat(64)}.special.json`, dispatch_claim_hash: sha("dc"), dispatch_closure_ref: `dispatch/${"a".repeat(64)}.special.closed.json`, dispatch_closure_hash: sha("dx"), candidate_commit: "5".repeat(40), candidate_tree: "6".repeat(40), changed_paths: ["src/a.js"], review_ref: `reviews/integration-amendment-${id}.attempt-${attempt}.json`, review_hash: sha("rv"), reviewed_commit: "5".repeat(40), reviewed_tree: "6".repeat(40) }; }
export function integrationFixture(base, attempt) { return { ref: `refs/opencode/integration-amendments/${base.amendment_id}/staged`, worktree: `/tmp/f/.opencode/worktrees/f--amend-${base.amendment_id}-staged`, commit: "7".repeat(40), tree: attempt.reviewed_tree }; }
export function verificationBinding(id) { return { claim_ref: `evidence/integration-amendment-${id}.verify.claim.json`, claim_hash: sha("vc"), receipt_ref: `evidence/integration-amendment-${id}.verify.receipt.json`, receipt_hash: sha("vr") }; }
export function publicationFixture(base) { return { branch_ref: base.admission.baseline_ref, previous_commit: base.admission.baseline_commit, commit: "7".repeat(40), published_at: NOW }; }
export function blocked(base, attempts, origin) { return { ...base, status: "blocked", attempts, blocked: { origin, reason: "stopped", blocked_at: NOW } }; }
export function stream() { return { captured_bytes: 0, sha256: sha(""), truncated: false }; }

export function executionOptions(behaviors, calls, overrides = {}) {
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
export function sha(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
export function pick(value, keys) { return Object.fromEntries(keys.map((key) => [key, structuredClone(value[key])])); }
export function readRun(fixture) { return JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8")); }
export function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
export function writeJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
export function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8" }); }
export function cleanup(fixture) { rmSync(fixture.repo, { recursive: true, force: true }); }


export function cleanupFixtures() {
  for (const repo of fixtures) if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
}
