import { validateDeliveryEnvelope, validateInvariantFamilyLedger, validateReviewExtensionResult } from "./extensions.js";
import { evaluateReviewLedger } from "./review-ledger.js";

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
        const observed = observeEvidence(disposition.evidence_ref);
        if (observed?.ref !== disposition.evidence_ref) {
          throw new Error(`invariant family ledger evidence ref is not current for '${disposition.evidence_ref}'`);
        }
        if (observed?.hash !== disposition.evidence_hash) {
          throw new Error(`invariant family ledger evidence hash is stale for '${disposition.evidence_ref}'`);
        }
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
