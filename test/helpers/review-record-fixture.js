export function createReviewRecord(overrides = {}) {
  return {
    subject: "fixture-subject",
    verdict: "APPROVE",
    required_fixes: [],
    ...overrides,
  };
}

export function createSliceReviewRecord({ subject = "fixture-subject", attempt = 1, reviewedCommit, verdict = "APPROVE", requiredFixes = [], convergence = "converging", fixClassifications, scopeEffect = "in-lane", likelyPaths = ["src/fix.js"], fixOwner = subject, ratifiedPaths = [] } = {}) {
  const classifications = fixClassifications || requiredFixes.map(() => convergence === "nonconvergent" ? "nonconvergent" : "narrow-correction");
  return createReviewRecord({
    subject,
    attempt,
    reviewed_commit: reviewedCommit,
    verdict,
    convergence,
    remaining_fix_count: requiredFixes.length,
    required_fixes: requiredFixes,
    ownership_ratification: { schema_version: 1, paths: [...ratifiedPaths] },
    remediation_context: {
      schema_version: 2,
      fixes: classifications.map((classification, required_fix_index) => ({
        required_fix_index,
        classification,
        scope_effect: scopeEffect,
        likely_paths: [...likelyPaths],
        fix_owner: fixOwner,
      })),
    },
  });
}

export function createSliceAttemptReview({ attempt = 1, evidenceRef, evidenceHash, reviewRef, reviewHash, reviewedCommit, diffBaseCommit = reviewedCommit, ratifiedPaths = [], verdict = "APPROVE", convergence = "converging", remainingFixCount = verdict === "APPROVE" ? 0 : 1 } = {}) {
  return {
    attempt,
    evidence_ref: evidenceRef,
    evidence_hash: evidenceHash,
    review_ref: reviewRef,
    review_hash: reviewHash,
    reviewed_commit: reviewedCommit,
    diff_base_commit: diffBaseCommit,
    ratified_paths: [...ratifiedPaths],
    verdict,
    convergence,
    remaining_fix_count: remainingFixCount,
  };
}

export function createPanelReviewRecord({ subject = "fixture-branch", attempt = 1, reviewedHeadSha, verdict = "GO", requiredFixes = [] } = {}) {
  return createReviewRecord({ subject, attempt, reviewed_head_sha: reviewedHeadSha, verdict, required_fixes: requiredFixes });
}
