import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPanelReviewRecord, createSliceAttemptReview, createSliceReviewRecord } from "../review-record-fixture.js";
import { passingInvariantFamilyLedger, withDeliveryEnvelope, writeVerificationArtifactReceipt } from "../delivery-envelope-fixture.js";
import { claimCheckedTestExecution, completeCheckedTestExecution, createPostPrState, transitionPanelVerdicts, transitionPrePrFenceEstablished, transitionPrCreated, transitionRunStep } from "../../../src/run-state.js";
import { postPrObserve } from "../../../src/factory.js";
import { observePullRequestOperation, prOperationMarker } from "../../../src/github.js";
import { git, output, writeJson } from "../base-advance-transition/fixture.js";

export const LIFECYCLE_NOW = "2026-07-23T13:00:00.000Z";
export const LIFECYCLE_REVIEWER = "mimir-carreira";

export function configureReadyPostPrReview(fixture, reviewer = LIFECYCLE_REVIEWER) {
  const run = fixture.readRun();
  run.post_pr = createPostPrState({
    enabled: true,
    wait_ms: 3_600_000,
    initial_poll_ms: 30_000,
    max_poll_ms: 120_000,
    check_start_grace_ms: 300_000,
    max_transient_errors: 12,
    review: { required: true, reviewer_login: reviewer, source: "driver" },
  });
  fixture.writeRun(run);
  return run.post_pr;
}

export function installApprovedLifecycleSlice(fixture, { path = "src/lifecycle.js" } = {}) {
  const target = fixture.readRun().base_commit;
  const sliceId = "lifecycle";
  const branch = `${fixture.runId}-${sliceId}`;
  const worktree = join(fixture.repo, ".opencode", "worktrees", branch);
  git(fixture.repo, ["branch", branch, target]);
  git(fixture.repo, ["worktree", "add", worktree, branch]);
  mkdirSync(join(worktree, ...path.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(worktree, path), "export const lifecycle = 'advanced';\n");
  git(worktree, ["add", path]);
  commit(worktree, "add advanced lifecycle candidate");
  const reviewedCommit = output(worktree, ["rev-parse", "HEAD"]);

  const plan = withDeliveryEnvelope({
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: [{
      id: sliceId,
      stack: "backend",
      paths: [path],
      depends_on: [],
      acceptance: ["advanced lifecycle remains exact"],
      test_plan: ["node --test test/lifecycle.test.js"],
    }],
  });
  for (const directory of ["artifacts", "dispatch", "evidence", "plan", "reviews"]) {
    mkdirSync(join(fixture.runDir, directory), { recursive: true });
  }
  writeJson(join(fixture.runDir, "plan", "slices.json"), plan);
  writeJson(join(fixture.runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE" });
  const evidenceRef = `evidence/${sliceId}.attempt-1.json`;
  const reviewRef = `reviews/${sliceId}.attempt-1.json`;
  writeJson(join(fixture.runDir, evidenceRef), { subject: sliceId, attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommit });
  const unit = plan.delivery_envelope.delivery_units[0];
  const family = unit.invariant_families[0];
  const artifactId = unit.obligations[0].verification_artifact_id;
  const focused = writeVerificationArtifactReceipt({
    runDir: fixture.runDir,
    runId: fixture.runId,
    plan,
    sliceId,
    attempt: 1,
    reviewedCommit,
    artifactId,
    evidenceRef: `evidence/${sliceId}.focused.json`,
    result: { type: "verification-result", outcome: "pass", summary: `${family.description} passed` },
  });
  const review = createSliceReviewRecord({ subject: sliceId, attempt: 1, reviewedCommit });
  review.invariant_family_ledger = passingInvariantFamilyLedger({
    plan,
    sliceId,
    reviewedCommit,
    evidenceRef: focused.ref,
    evidenceHash: focused.hash,
  });
  writeJson(join(fixture.runDir, reviewRef), review);

  const contextHash = hashBytes("advanced lifecycle dispatch context");
  const completionToken = "advanced-lifecycle-completion";
  const claimStem = createHash("sha256").update(`${fixture.runId}\0${sliceId}\0${1}`, "utf8").digest("hex");
  const claimRef = `dispatch/${claimStem}.json`;
  const closureRef = `dispatch/${claimStem}.closed.json`;
  writeJson(join(fixture.runDir, claimRef), {
    schema_version: 1,
    kind: "checked-slice-builder-dispatch-claim",
    run_id: fixture.runId,
    slice_id: sliceId,
    attempt: 1,
    agent: "backend-builder",
    branch,
    worktree,
    head: target,
    context_hash: contextHash,
    completion_token_hash: hashBytes(completionToken),
    claimed_at: LIFECYCLE_NOW,
    closure_ref: closureRef,
  });
  const claimHash = fileHash(join(fixture.runDir, claimRef));
  writeJson(join(fixture.runDir, closureRef), {
    schema_version: 1,
    kind: "checked-slice-builder-dispatch-closure",
    claim_ref: claimRef,
    claim_hash: claimHash,
    run_id: fixture.runId,
    slice_id: sliceId,
    attempt: 1,
    agent: "backend-builder",
    branch,
    worktree,
    head: target,
    completion_head: reviewedCommit,
    context_hash: contextHash,
    completion_token: completionToken,
    returned_at: LIFECYCLE_NOW,
  });
  const closureHash = fileHash(join(fixture.runDir, closureRef));
  const evidenceHash = fileHash(join(fixture.runDir, evidenceRef));
  const reviewHash = fileHash(join(fixture.runDir, reviewRef));
  const dispatch = {
    dispatch_claim_ref: claimRef,
    dispatch_claim_hash: claimHash,
    dispatch_closure_ref: closureRef,
    dispatch_closure_hash: closureHash,
  };
  const attemptReview = {
    ...createSliceAttemptReview({ evidenceRef, evidenceHash, reviewRef, reviewHash, reviewedCommit, diffBaseCommit: target }),
    ...dispatch,
  };

  git(fixture.worktree, ["merge", "--no-ff", branch, "-m", "integrate advanced lifecycle candidate"]);
  const integrationHead = output(fixture.worktree, ["rev-parse", "HEAD"]);
  const run = fixture.readRun();
  run.gates.pre_pr = { status: "approved" };
  run.slices = [{
    id: sliceId,
    stack: "backend",
    depends_on: [],
    declared_paths: [path],
    effective_paths: [path],
    status: "review",
    attempts: 1,
    branch,
    worktree,
    evidence_ref: evidenceRef,
    evidence_hash: evidenceHash,
    review_ref: reviewRef,
    review_hash: reviewHash,
    reviewed_commit: reviewedCommit,
    attempt_reviews: [attemptReview],
    dispatch_required: true,
    ...dispatch,
  }];
  run.steps = [
    {
      agent: "work-decomposer",
      status: "accepted",
      attempts: 1,
      artifact_ref: "plan/slices.json",
      review_ref: "reviews/work-decomposer.json",
      acceptance: {
        artifact_ref: "plan/slices.json",
        artifact_hash: fileHash(join(fixture.runDir, "plan", "slices.json")),
        review_ref: "reviews/work-decomposer.json",
        review_hash: fileHash(join(fixture.runDir, "reviews", "work-decomposer.json")),
      },
    },
    { agent: "test-verifier", status: "running", attempts: 1 },
  ];
  fixture.writeRun(run);
  return { sliceId, branch, worktree, path, target, reviewedCommit, integrationHead, focused };
}

export function approvePreservedCandidate(fixture, inventory) {
  const sliceId = "candidate";
  const attempt = 2;
  const reviewedCommit = inventory.candidateHead;
  const evidenceRef = `evidence/${sliceId}.attempt-${attempt}.json`;
  const familyEvidenceRef = `evidence/${sliceId}.attempt-${attempt}.family.json`;
  const reviewRef = `reviews/${sliceId}.attempt-${attempt}.json`;
  writeJson(join(fixture.runDir, evidenceRef), { subject: sliceId, attempt, status: "pass", review_ready: true, head_sha: reviewedCommit, ownership_disclosure: [] });
  const plan = JSON.parse(readFileSync(join(fixture.runDir, "plan", "slices.json"), "utf8"));
  const unit = plan.delivery_envelope.delivery_units.find((candidate) => candidate.slice_id === sliceId);
  const family = unit.invariant_families[0];
  const artifactId = unit.obligations[0].verification_artifact_id;
  const familyEvidence = writeVerificationArtifactReceipt({
    runDir: fixture.runDir,
    runId: fixture.runId,
    plan,
    sliceId,
    attempt,
    reviewedCommit,
    artifactId,
    evidenceRef: familyEvidenceRef,
    result: { type: "verification-result", outcome: "pass", summary: `${family.description} passed` },
  });
  const review = createSliceReviewRecord({ subject: sliceId, attempt, reviewedCommit });
  review.invariant_family_ledger = passingInvariantFamilyLedger({
    plan,
    sliceId,
    reviewedCommit,
    evidenceRef: familyEvidence.ref,
    evidenceHash: familyEvidence.hash,
  });
  writeJson(join(fixture.runDir, reviewRef), review);

  const contextHash = hashBytes("preserved candidate attempt two dispatch context");
  const completionToken = "preserved-candidate-attempt-two";
  const claimStem = createHash("sha256").update(`${fixture.runId}\0${sliceId}\0${attempt}`, "utf8").digest("hex");
  const claimRef = `dispatch/${claimStem}.json`;
  const closureRef = `dispatch/${claimStem}.closed.json`;
  writeJson(join(fixture.runDir, claimRef), {
    schema_version: 1,
    kind: "checked-slice-builder-dispatch-claim",
    run_id: fixture.runId,
    slice_id: sliceId,
    attempt,
    agent: "backend-builder",
    branch: inventory.candidate,
    worktree: inventory.candidateWorktree,
    head: reviewedCommit,
    context_hash: contextHash,
    completion_token_hash: hashBytes(completionToken),
    claimed_at: LIFECYCLE_NOW,
    closure_ref: closureRef,
  });
  const claimHash = fileHash(join(fixture.runDir, claimRef));
  writeJson(join(fixture.runDir, closureRef), {
    schema_version: 1,
    kind: "checked-slice-builder-dispatch-closure",
    claim_ref: claimRef,
    claim_hash: claimHash,
    run_id: fixture.runId,
    slice_id: sliceId,
    attempt,
    agent: "backend-builder",
    branch: inventory.candidate,
    worktree: inventory.candidateWorktree,
    head: reviewedCommit,
    completion_head: reviewedCommit,
    context_hash: contextHash,
    completion_token: completionToken,
    returned_at: LIFECYCLE_NOW,
  });
  const dispatch = {
    dispatch_claim_ref: claimRef,
    dispatch_claim_hash: claimHash,
    dispatch_closure_ref: closureRef,
    dispatch_closure_hash: fileHash(join(fixture.runDir, closureRef)),
  };
  const evidenceHash = fileHash(join(fixture.runDir, evidenceRef));
  const reviewHash = fileHash(join(fixture.runDir, reviewRef));
  const run = fixture.readRun();
  const slice = run.slices.find((candidate) => candidate.id === sliceId);
  const attemptReview = {
    ...createSliceAttemptReview({ attempt, evidenceRef, evidenceHash, reviewRef, reviewHash, reviewedCommit, diffBaseCommit: fixture.base }),
    ...dispatch,
  };
  Object.assign(slice, {
    attempts: attempt,
    evidence_ref: evidenceRef,
    evidence_hash: evidenceHash,
    review_ref: reviewRef,
    review_hash: reviewHash,
    reviewed_commit: reviewedCommit,
    attempt_reviews: [...slice.attempt_reviews, attemptReview],
    ...dispatch,
  });
  run.steps.push({ agent: "test-verifier", status: "running", attempts: 1 });
  fixture.writeRun(run);
  return { attempt, reviewedCommit, evidenceRef, reviewRef, familyEvidence, ...dispatch };
}

export async function completeFinalCheckedTest(fixture, expectedHead) {
  const claimed = await claimCheckedTestExecution(fixture.runDir, { now: LIFECYCLE_NOW, nonce: "123e4567-e89b-42d3-a456-426614174024" });
  const emptyStream = { captured_bytes: 0, sha256: hashBytes(""), truncated: false };
  const receipt = {
    schema_version: 1,
    kind: "checked-test-execution-receipt",
    subject: "test-verifier",
    run_id: fixture.runId,
    attempt: 1,
    claim_nonce: claimed.claim.nonce,
    plan_ref: claimed.claim.plan_ref,
    plan_hash: claimed.claim.plan_hash,
    head_sha: expectedHead,
    timeout_ms: claimed.claim.timeout_ms,
    started_at: LIFECYCLE_NOW,
    completed_at: LIFECYCLE_NOW,
    duration_ms: 0,
    status: "pass",
    review_ready: true,
    commands: claimed.authority.commands.map((command, index) => ({
      index,
      ...command,
      outcome: "exited",
      status: "pass",
      exit_code: 0,
      signal: null,
      error_code: null,
      duration_ms: 0,
      stdout: emptyStream,
      stderr: emptyStream,
    })),
  };
  const completed = await completeCheckedTestExecution(fixture.runDir, claimed.claim, claimed.authority, receipt, { now: LIFECYCLE_NOW });
  writeFileSync(join(fixture.runDir, "artifacts", "test-report.md"), "advanced lifecycle final checks pass\n");
  const reviewRef = "reviews/test-verifier.attempt-1.json";
  writeJson(join(fixture.runDir, reviewRef), { subject: "test-verifier", attempt: 1, verdict: "APPROVE", reviewed_head_sha: expectedHead, required_fixes: [] });
  const accepted = await transitionRunStep(fixture.runDir, "test-verifier", {
    status: "accepted",
    attempts: 1,
    artifact_ref: "artifacts/test-report.md",
    evidence_ref: claimed.claim.receipt_ref,
    review_ref: reviewRef,
  }, { mustExist: true });
  return { claimed, completed, receipt, accepted };
}

export async function completeIntegratedConflictCheckedTest(fixture, expectedHead) {
  await transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 1 }, { mustExist: true });
  const claimed = await claimCheckedTestExecution(fixture.runDir, { now: LIFECYCLE_NOW, nonce: "123e4567-e89b-42d3-a456-426614174023" });
  const emptyStream = { captured_bytes: 0, sha256: hashBytes(""), truncated: false };
  const receipt = {
    schema_version: 1,
    kind: "checked-test-execution-receipt",
    subject: "test-verifier",
    run_id: fixture.runId,
    attempt: 1,
    claim_nonce: claimed.claim.nonce,
    plan_ref: claimed.claim.plan_ref,
    plan_hash: claimed.claim.plan_hash,
    head_sha: expectedHead,
    timeout_ms: claimed.claim.timeout_ms,
    started_at: LIFECYCLE_NOW,
    completed_at: LIFECYCLE_NOW,
    duration_ms: 0,
    status: "pass",
    review_ready: true,
    commands: claimed.authority.commands.map((command, index) => ({
      index,
      ...command,
      outcome: "exited",
      status: "pass",
      exit_code: 0,
      signal: null,
      error_code: null,
      duration_ms: 0,
      stdout: emptyStream,
      stderr: emptyStream,
    })),
  };
  const completed = await completeCheckedTestExecution(fixture.runDir, claimed.claim, claimed.authority, receipt, { now: LIFECYCLE_NOW });
  const artifactRef = "artifacts/test-report.md";
  const reviewRef = "reviews/test-verifier.attempt-1.json";
  writeFileSync(join(fixture.runDir, artifactRef), "delegated integration conflict checks pass\n");
  writeJson(join(fixture.runDir, reviewRef), { subject: "test-verifier", attempt: 1, verdict: "APPROVE", reviewed_head_sha: expectedHead, required_fixes: [] });
  const accepted = await transitionRunStep(fixture.runDir, "test-verifier", {
    status: "accepted",
    attempts: 1,
    artifact_ref: artifactRef,
    evidence_ref: claimed.claim.receipt_ref,
    review_ref: reviewRef,
  }, { mustExist: true });
  return { claimed, completed, accepted, receipt, artifactRef, reviewRef };
}

export async function publishIndependentPanels(fixture, expectedHead) {
  const validatorRef = "reviews/implementation-validator.json";
  const securityRef = "reviews/security-reviewer.json";
  writeFileSync(join(fixture.runDir, "artifacts", "validation-report.md"), "GO\n");
  writeJson(join(fixture.runDir, validatorRef), createPanelReviewRecord({ subject: fixture.runId, attempt: 1, reviewedHeadSha: expectedHead, verdict: "GO" }));
  writeJson(join(fixture.runDir, securityRef), createPanelReviewRecord({ subject: fixture.runId, attempt: 1, reviewedHeadSha: expectedHead, verdict: "PASS" }));
  return transitionPanelVerdicts(fixture.runDir, {
    validator: { verdict: "GO", report: "artifacts/validation-report.md", review_ref: validatorRef },
    security_review: { verdict: "PASS", review_ref: securityRef },
  }, { repoRoot: fixture.repo, now: LIFECYCLE_NOW });
}

export async function recordOpenReadyPr(fixture, expectedBase, expectedHead) {
  git(fixture.worktree, ["push", "-u", "origin", `HEAD:refs/heads/${fixture.runId}`]);
  const fenced = await transitionPrePrFenceEstablished(fixture.runDir, { repoRoot: fixture.repo, now: LIFECYCLE_NOW, token: "advanced-lifecycle-pr-fence" });
  const fence = fenced.fence;
  assert.equal(fence.base_sha, expectedBase);
  assert.equal(fence.head_sha, expectedHead);
  assert.equal(fence.draft, false);
  const operationMarker = prOperationMarker(fence.operation_id);
  const observedPull = {
    html_url: `https://github.com/${fence.repository}/pull/100`,
    number: 100,
    node_id: "PR_advanced_lifecycle",
    draft: false,
    body: `${operationMarker}\n`,
    state: "open",
    merged_at: null,
    merge_commit_sha: null,
    head: { ref: fence.head_ref, sha: fence.head_sha, repo: { full_name: fence.repository } },
    base: { ref: fence.base_ref, sha: fence.base_sha, repo: { full_name: fence.repository } },
  };
  const observationCalls = [];
  const executeGithub = async (input) => {
    observationCalls.push(input.args);
    if (input.args[0] === "auth") return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    assert.equal(input.timeoutMs, 30_000);
    assert.equal(input.stdoutCap, 1024 * 1024);
    assert.equal(input.stderrCap, 64 * 1024);
    return { exitCode: 0, signal: null, stdout: includedPullRequestPage([observedPull]), stderr: "" };
  };
  const recorded = await transitionPrCreated(fixture.runDir, {}, {
    repoRoot: fixture.repo,
    now: LIFECYCLE_NOW,
    fenceToken: fence.token,
    observePrOperation: observePullRequestOperation,
    executeGithub,
  });
  return { fence, pullRequest: recorded.run.post_pr.pr_operation, recorded, observedPull, operationMarker, observationCalls };
}

export async function requestConfiguredReviewer(fixture, now = "2026-07-23T13:00:30.000Z") {
  const calls = [];
  const result = await postPrObserve(fixture.runId, {
    cwd: fixture.repo,
    now,
    executeGithub: async ({ args }) => {
      calls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  return { result, calls };
}

export function fileHash(path) {
  return hashBytes(readFileSync(path));
}

function hashBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function includedPullRequestPage(pulls) {
  return `HTTP/2 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(pulls)}`;
}

function commit(cwd, message) {
  git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message]);
}
