import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashFile } from "../../src/refs.js";
import { claimCheckedTestExecution, completeCheckedTestExecution, transitionGateDecision, transitionRunStep, transitionSteeringBoundaryOpened } from "../../src/run-state.js";
import { passingInvariantFamilyLedger, withDeliveryEnvelope, writeVerificationArtifactReceipt } from "./delivery-envelope-fixture.js";
import { createSliceAttemptReview, createSliceReviewRecord } from "./review-record-fixture.js";

const DEFAULT_NOW = "2026-07-19T10:00:00.000Z";

export function installCurrentWholeStoryAuthority({ runDir, runId, head, slices, integrationGate = null }) {
  for (const directory of ["artifacts", "evidence", "plan", "reviews"]) mkdirSync(join(runDir, directory), { recursive: true });
  const plan = withDeliveryEnvelope({
    slices: structuredClone(slices),
    integration_gate: integrationGate || { required_commands: [{ program: "npm", args: ["run", "check"] }] },
  });
  writeJson(join(runDir, "plan", "slices.json"), plan);
  writeJson(join(runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] });

  const mergedSlices = plan.slices.map((slice, index) => {
    const evidenceRef = `evidence/${slice.id}.json`;
    const familyEvidenceRef = `evidence/${slice.id}.family.json`;
    const reviewRef = `reviews/${slice.id}.json`;
    writeJson(join(runDir, evidenceRef), { subject: slice.id, attempt: 1, status: "pass", review_ready: true, head_sha: head });
    const unit = plan.delivery_envelope.delivery_units[index];
    const familyEvidence = writeVerificationArtifactReceipt({
      runDir,
      runId,
      plan,
      sliceId: slice.id,
      attempt: 1,
      reviewedCommit: head,
      artifactId: unit.verification_artifacts[0].id,
      evidenceRef: familyEvidenceRef,
      result: { type: "verification-result", outcome: "pass", summary: `Verify ${slice.id} behavior passed` },
    });
    const review = createSliceReviewRecord({ subject: slice.id, attempt: 1, reviewedCommit: head });
    review.invariant_family_ledger = passingInvariantFamilyLedger({
      plan,
      sliceId: slice.id,
      reviewedCommit: head,
      evidenceRef: familyEvidence.ref,
      evidenceHash: familyEvidence.hash,
    });
    writeJson(join(runDir, reviewRef), review);
    const evidenceHash = hashFile(join(runDir, evidenceRef));
    const reviewHash = hashFile(join(runDir, reviewRef));
    const attemptReview = createSliceAttemptReview({ evidenceRef, evidenceHash, reviewRef, reviewHash, reviewedCommit: head });
    return {
      id: slice.id,
      stack: slice.stack,
      depends_on: structuredClone(slice.depends_on),
      declared_paths: structuredClone(slice.paths),
      effective_paths: structuredClone(slice.paths),
      status: "merged",
      attempts: 1,
      attempt_reviews: [attemptReview],
      evidence_ref: evidenceRef,
      evidence_hash: evidenceHash,
      review_ref: reviewRef,
      review_hash: reviewHash,
      reviewed_commit: head,
      merge_commit: head,
    };
  });
  const steps = [{
    agent: "work-decomposer",
    status: "accepted",
    attempts: 1,
    artifact_ref: "plan/slices.json",
    review_ref: "reviews/work-decomposer.json",
    acceptance: {
      artifact_ref: "plan/slices.json",
      artifact_hash: hashFile(join(runDir, "plan", "slices.json")),
      review_ref: "reviews/work-decomposer.json",
      review_hash: hashFile(join(runDir, "reviews", "work-decomposer.json")),
    },
  }, { agent: "test-verifier", status: "running", attempts: 1 }];
  return { plan, slices: mergedSlices, steps };
}

export async function acceptCurrentWholeStoryTests(runDir, head, { now = DEFAULT_NOW, nonce = "123e4567-e89b-42d3-a456-426614174099" } = {}) {
  const claimed = await claimCheckedTestExecution(runDir, { now, nonce });
  const emptyStream = { captured_bytes: 0, sha256: sha256Empty(), truncated: false };
  const receipt = {
    schema_version: 1,
    kind: "checked-test-execution-receipt",
    subject: "test-verifier",
    run_id: claimed.claim.run_id,
    attempt: claimed.claim.attempt,
    claim_nonce: claimed.claim.nonce,
    plan_ref: claimed.claim.plan_ref,
    plan_hash: claimed.claim.plan_hash,
    head_sha: head,
    timeout_ms: claimed.claim.timeout_ms,
    started_at: now,
    completed_at: now,
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
  await completeCheckedTestExecution(runDir, claimed.claim, claimed.authority, receipt, { now });
  writeFileSync(join(runDir, "artifacts", "test-report.md"), "Current whole-story checks pass.\n");
  const reviewRef = "reviews/test-verifier.attempt-1.json";
  writeJson(join(runDir, reviewRef), { subject: "test-verifier", attempt: 1, verdict: "APPROVE", reviewed_head_sha: head, required_fixes: [] });
  return transitionRunStep(runDir, "test-verifier", {
    status: "accepted",
    attempts: 1,
    artifact_ref: "artifacts/test-report.md",
    evidence_ref: claimed.claim.receipt_ref,
    review_ref: reviewRef,
  }, { mustExist: true });
}

export async function approveCurrentPrePrGate(runDir, { now = DEFAULT_NOW } = {}) {
  mkdirSync(join(runDir, "gates"), { recursive: true });
  const questionRef = "gates/pre_pr.question.md";
  writeFileSync(join(runDir, questionRef), "Approve the current whole-story authority?\n");
  await transitionGateDecision(runDir, "pre_pr", {
    status: "pending",
    artifact: "artifacts/validation-report.md",
    question_ref: questionRef,
  }, { now });
  const opened = await transitionSteeringBoundaryOpened(runDir, "gate", { now });
  return transitionGateDecision(runDir, "pre_pr", {
    status: "approved",
    artifact: "artifacts/validation-report.md",
    question_ref: questionRef,
    answer: "approve",
  }, { now, boundaryToken: opened.boundary.token });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256Empty() {
  return "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
}
