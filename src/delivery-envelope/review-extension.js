import { validateDeliveryEnvelope, validateInvariantFamilyLedger, validateReviewExtensionResult } from "./extensions.js";
import { evaluateReviewLedger } from "./review-ledger.js";
import { validateVerificationArtifactExecutionClaim, validateVerificationArtifactExecutionReceipt } from "../validate.js";
import { parseVerificationCommand } from "./verification-command.js";

export function evaluateInvariantFamilyReview({ plan, sliceId, review, observeEvidence } = {}) {
  const ledger = review?.invariant_family_ledger;
  const deliveryEnvelope = plan?.delivery_envelope;
  const hasDeliveryEnvelope = deliveryEnvelope !== undefined && deliveryEnvelope !== null;
  if (hasDeliveryEnvelope) validateDeliveryEnvelope(deliveryEnvelope, plan?.slices);
  if (ledger !== undefined) {
    validateInvariantFamilyLedger(ledger, {
      deliveryEnvelope,
      slices: plan?.slices,
      sliceId,
      reviewedCommit: review?.reviewed_commit,
      requireDeliveryEnvelope: plan !== undefined,
    });
    if (typeof observeEvidence === "function") {
      for (const disposition of ledger.dispositions) {
        const observed = observeEvidence(disposition.evidence_ref, disposition);
        if (observed?.ref !== disposition.evidence_ref) {
          throw new Error(`invariant family ledger evidence ref is not current for '${disposition.evidence_ref}'`);
        }
        if (observed?.hash !== disposition.evidence_hash) {
          throw new Error(`invariant family ledger evidence hash is stale for '${disposition.evidence_ref}'`);
        }
        assertCheckedDispositionReceipt({ deliveryEnvelope, sliceId, review, disposition, observed });
      }
    }
  }
  const active = hasDeliveryEnvelope && ["APPROVE", "REJECT"].includes(review?.verdict);
  if (active) {
    const deliveryUnit = deliveryEnvelope.delivery_units.find((unit) => unit.slice_id === sliceId) ?? null;
    const policy = evaluateReviewLedger({
      deliveryUnit,
      ledger,
      reviewVerdict: review.verdict,
      evidenceObserved: typeof observeEvidence === "function",
    });
    return validateReviewExtensionResult({
      schema_version: 1,
      extension: "invariant-family-review",
      status: "active",
      grants_b4_authority: policy.grants_b4_authority,
      decision: policy.decision,
      reasons: policy.reasons,
    });
  }
  return validateReviewExtensionResult({
    schema_version: 1,
    extension: "invariant-family-review",
    status: "inactive",
    grants_b4_authority: false,
    reason: "b4-review-policy-inactive",
  });
}

function assertCheckedDispositionReceipt({ deliveryEnvelope, sliceId, review, disposition, observed }) {
  let claim;
  let receipt;
  try {
    claim = validateVerificationArtifactExecutionClaim(observed?.claim);
    receipt = validateVerificationArtifactExecutionReceipt(observed?.receipt);
  } catch (error) {
    throw new Error(`invariant family ledger evidence '${disposition.evidence_ref}' must have a completed checked execution claim and receipt: ${error.message}`);
  }
  const unit = deliveryEnvelope.delivery_units.find((candidate) => candidate.slice_id === sliceId);
  const artifact = unit?.verification_artifacts.find((candidate) => candidate.id === disposition.verification_artifact_id);
  if (!artifact) throw new Error(`invariant family ledger checked receipt references an unknown artifact '${disposition.verification_artifact_id}'`);
  const command = parseVerificationCommand(artifact.test_plan_entry);
  if (receipt.slice_id !== sliceId || receipt.subject !== sliceId) throw new Error("invariant family ledger checked receipt subject/slice is stale");
  if (receipt.attempt !== review.attempt) throw new Error("invariant family ledger checked receipt attempt is stale");
  if (receipt.head_sha !== review.reviewed_commit) throw new Error("invariant family ledger checked receipt reviewed HEAD is stale");
  if (receipt.verification_artifact_id !== artifact.id) throw new Error("invariant family ledger checked receipt artifact id is stale");
  if (receipt.probe.test_plan_index !== artifact.test_plan_index || receipt.probe.test_plan_entry !== artifact.test_plan_entry
    || receipt.probe.program !== command.program || JSON.stringify(receipt.probe.args) !== JSON.stringify(command.args)) {
    throw new Error("invariant family ledger checked receipt probe does not match the exact current verification artifact command");
  }
  if (receipt.status !== disposition.result.outcome || JSON.stringify(receipt.result) !== JSON.stringify(disposition.result)) {
    throw new Error("invariant family ledger claimed result does not match the observed checked execution result");
  }
  if (claim.state !== "completed" || claim.status !== receipt.status || claim.receipt_hash !== observed.hash
    || claim.nonce !== receipt.claim_nonce || claim.run_id !== receipt.run_id || claim.slice_id !== receipt.slice_id
    || claim.attempt !== receipt.attempt || claim.plan_ref !== receipt.plan_ref || claim.plan_hash !== receipt.plan_hash
    || claim.head_sha !== receipt.head_sha || claim.verification_artifact_id !== receipt.verification_artifact_id
    || claim.receipt_ref !== disposition.evidence_ref || JSON.stringify(claim.probe) !== JSON.stringify(receipt.probe)) {
    throw new Error("invariant family ledger checked execution claim is not the exact completed authority for the observed receipt");
  }
}
