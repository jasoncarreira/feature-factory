const APPROVE = "APPROVE";
const REJECT = "REJECT";

export function evaluateReviewLedger({ deliveryUnit, ledger, reviewVerdict, evidenceObserved = false } = {}) {
  const reasons = [];
  if (reviewVerdict !== APPROVE) reasons.push(reviewVerdict === REJECT ? "review-verdict-reject" : "review-verdict-not-approve");
  if (!deliveryUnit) reasons.push("current-delivery-unit-required");
  if (!ledger) {
    reasons.push("invariant-family-ledger-required");
    return reject(reasons);
  }

  if (!evidenceObserved) reasons.push("current-evidence-observer-required");
  if (deliveryUnit) appendCoverageReasons(reasons, deliveryUnit, ledger);

  if (reasons.length > 0) return reject(reasons);
  return {
    decision: "approve",
    grants_b4_authority: true,
    reasons: ["all-invariant-families-current"],
  };
}

function appendCoverageReasons(reasons, deliveryUnit, ledger) {
  const expectedFamilyIds = deliveryUnit.invariant_families.map((family) => family.id);
  const expectedFamilySet = new Set(expectedFamilyIds);
  const dispositionsByFamily = new Map();

  for (const disposition of ledger.dispositions) {
    const familyId = disposition.invariant_family_id;
    const dispositions = dispositionsByFamily.get(familyId) ?? [];
    dispositions.push(disposition);
    dispositionsByFamily.set(familyId, dispositions);
  }

  for (const familyId of expectedFamilyIds) {
    const dispositions = dispositionsByFamily.get(familyId) ?? [];
    if (dispositions.length === 0) {
      reasons.push(`invariant-family-disposition-missing:${familyId}`);
      continue;
    }
    if (dispositions.length > 1) {
      reasons.push(`invariant-family-disposition-duplicate:${familyId}`);
      continue;
    }
    const [disposition] = dispositions;
    if (disposition.result.outcome !== "pass") reasons.push(`invariant-family-result-not-pass:${familyId}`);
    if (disposition.unresolved_findings.length !== 0) reasons.push(`invariant-family-unresolved-findings:${familyId}`);
  }

  const extraFamilyIds = [...dispositionsByFamily.keys()]
    .filter((familyId) => !expectedFamilySet.has(familyId))
    .sort();
  for (const familyId of extraFamilyIds) reasons.push(`invariant-family-disposition-extra:${familyId}`);
}

function reject(reasons) {
  return {
    decision: "reject",
    grants_b4_authority: false,
    reasons,
  };
}
