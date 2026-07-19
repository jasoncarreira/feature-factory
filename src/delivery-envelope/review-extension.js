import { validateInvariantFamilyLedger, validateReviewExtensionResult } from "./extensions.js";

export function evaluateInvariantFamilyReview({ plan, sliceId, review, observeEvidence } = {}) {
  const ledger = review?.invariant_family_ledger;
  if (ledger !== undefined) {
    validateInvariantFamilyLedger(ledger, {
      deliveryEnvelope: plan?.delivery_envelope,
      slices: plan?.slices,
      sliceId,
      reviewedCommit: review?.reviewed_commit,
      requireDeliveryEnvelope: plan !== undefined,
    });
    if (typeof observeEvidence === "function") {
      for (const disposition of ledger.dispositions) {
        const observed = observeEvidence(disposition.evidence_ref);
        if (observed?.hash !== disposition.evidence_hash) {
          throw new Error(`invariant family ledger evidence hash is stale for '${disposition.evidence_ref}'`);
        }
      }
    }
  }
  return validateReviewExtensionResult({
    schema_version: 1,
    extension: "invariant-family-review",
    status: "inactive",
    grants_b4_authority: false,
    reason: "b4-review-policy-inactive",
  });
}
