export function createReviewRecord(overrides = {}) {
  return {
    subject: "fixture-subject",
    verdict: "APPROVE",
    required_fixes: [],
    ...overrides,
  };
}
