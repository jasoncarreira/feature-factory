export function createReviewRecord(overrides = {}) {
  return {
    subject: "fixture-subject",
    verdict: "APPROVE",
    required_fixes: [],
    ...overrides,
  };
}

export function createSliceReviewRecord({ subject = "fixture-subject", attempt = 1, reviewedCommit, verdict = "APPROVE", requiredFixes = [] } = {}) {
  return createReviewRecord({ subject, attempt, reviewed_commit: reviewedCommit, verdict, required_fixes: requiredFixes });
}

export function createPanelReviewRecord({ subject = "fixture-branch", attempt = 1, reviewedHeadSha, verdict = "GO", requiredFixes = [] } = {}) {
  return createReviewRecord({ subject, attempt, reviewed_head_sha: reviewedHeadSha, verdict, required_fixes: requiredFixes });
}
