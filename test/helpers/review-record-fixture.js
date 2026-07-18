export function createReviewRecord(overrides = {}) {
  return {
    subject: "fixture-subject",
    verdict: "APPROVE",
    required_fixes: [],
    ...overrides,
  };
}

export function createSliceReviewRecord({ subject = "fixture-subject", attempt = 1, reviewedCommit, verdict = "APPROVE", requiredFixes = [], convergence = "converging", fixClassifications } = {}) {
  const classifications = fixClassifications || requiredFixes.map(() => convergence === "nonconvergent" ? "nonconvergent" : "narrow-correction");
  return createReviewRecord({
    subject,
    attempt,
    reviewed_commit: reviewedCommit,
    verdict,
    convergence,
    remaining_fix_count: requiredFixes.length,
    required_fixes: requiredFixes,
    remediation_context: {
      schema_version: 1,
      fixes: classifications.map((classification, required_fix_index) => ({ required_fix_index, classification })),
    },
  });
}

export function createPanelReviewRecord({ subject = "fixture-branch", attempt = 1, reviewedHeadSha, verdict = "GO", requiredFixes = [] } = {}) {
  return createReviewRecord({ subject, attempt, reviewed_head_sha: reviewedHeadSha, verdict, required_fixes: requiredFixes });
}
