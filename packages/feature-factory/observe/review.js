// Review records, and the bindings that make a review mean something.
//
// viso's review record is {subject, reviewer, verdict, attempt, findings,
// required_fixes, checked_against} — it does not say *what code* was reviewed.
// With a human at Gate 3 that is tolerable, because the human sees the diff. In an
// autonomous run nobody does, so a verdict must name the commit it judged:
//
//   attack 3 — an approval presented against a different commit
//   attack 2 — a merged tree that differs from the reviewed tree
//   attack 4 — a validator verdict bound to a stale head
//
// All three are the same defect: a judgement detached from its subject.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAbsolute, sep } from "node:path";
import { deriveReviewReady, EVIDENCE_DIR, EVIDENCE_KEYS, observeAncestry, observeTree } from "./index.js";

export const REVIEW_KEYS = Object.freeze([
  "subject", "reviewer", "verdict", "attempt", "reviewed_commit",
  "findings", "required_fixes", "checked_against",
]);

export const APPROVING_VERDICTS = Object.freeze(["APPROVE", "GO", "GO-WITH-NITS", "PASS"]);
const SHA = /^[0-9a-f]{40}$/u;

export const REVIEWS_DIR = "reviews";
export const reviewRef = (subject) => join(REVIEWS_DIR, `${subject}.json`);

export function readReview(runDir, ref) {
  let value;
  try {
    value = JSON.parse(readFileSync(join(runDir, ref), "utf8"));
  } catch (error) {
    throw new Error(`review '${ref}' could not be read: ${error.message}`);
  }
  const unknown = Object.keys(value).filter((key) => !REVIEW_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`review '${ref}' has unknown keys: ${unknown.sort().join(", ")}`);
  if (typeof value.subject !== "string" || !value.subject.trim()) throw new Error(`review '${ref}' has no subject`);
  if (typeof value.verdict !== "string" || !value.verdict.trim()) throw new Error(`review '${ref}' has no verdict`);
  if (!Number.isSafeInteger(value.attempt) || value.attempt < 1) throw new Error(`review '${ref}' has no attempt`);
  // The binding this whole module exists for. A review without it cannot be
  // consumed, rather than being consumed against an assumed commit.
  if (!SHA.test(String(value.reviewed_commit))) {
    throw new Error(`review '${ref}' must record reviewed_commit as a full 40-character sha`);
  }
  return value;
}

export function isApproving(verdict) {
  return APPROVING_VERDICTS.includes(String(verdict).toUpperCase());
}

// Attack 3: the review must have judged the commit that is about to be consumed.
// Comparing to the slice's current head rather than to anything the review says
// about itself is the point — a review cannot vouch for its own currency.
export function assertReviewBinding({ review, ref, observedHead }) {
  if (!isApproving(review.verdict)) {
    throw new Error(`review '${ref}' verdict is ${review.verdict}, not an approval`);
  }
  if (!SHA.test(String(observedHead))) {
    throw new Error(`review '${ref}' cannot be consumed without an observed head`);
  }
  if (review.reviewed_commit !== observedHead) {
    throw new Error(`review '${ref}' approved ${review.reviewed_commit.slice(0, 12)} but the head is ${String(observedHead).slice(0, 12)}`);
  }
}

// Attack 2: the merge proof. What landed on the integration branch must have the
// same tree as what was reviewed. Ancestry alone is not enough — a merge can
// resolve conflicts into a tree nobody looked at, and that tree is what ships.
//
// Tree equality is achievable here precisely because merges are serial: a slice
// branches from the current integration head and nothing else lands before it
// merges, so the merged tree is the reviewed tree. That makes this check do double
// duty — it also detects a seriality violation, where a concurrent merge means the
// combined code was never reviewed as a whole.
export function observeMergeProof(worktree, { reviewedCommit, mergeCommit, options = {} } = {}) {
  const reviewedTree = observeTree(worktree, reviewedCommit, options);
  const mergedTree = observeTree(worktree, mergeCommit, options);
  if (reviewedTree === null || mergedTree === null) {
    return { proven: false, reason: "trees could not be observed", reviewed_tree: reviewedTree, merged_tree: mergedTree };
  }
  const ancestry = observeAncestry(worktree, reviewedCommit, mergeCommit, options);
  if (ancestry !== "ancestor") {
    return { proven: false, reason: `reviewed commit is ${ancestry} of the merge commit`, reviewed_tree: reviewedTree, merged_tree: mergedTree };
  }
  if (reviewedTree !== mergedTree) {
    return {
      proven: false,
      reason: "merged tree differs from the reviewed tree",
      reviewed_tree: reviewedTree,
      merged_tree: mergedTree,
    };
  }
  return { proven: true, reason: null, reviewed_tree: reviewedTree, merged_tree: mergedTree };
}

// Evidence records are read the same way reviews are: shape-checked, and refused
// rather than half-trusted. `factory observe` is the only writer.
// Finding 2, three parts:
//
//   * the ref was an unrestricted string joined to runDir, so ../app-2/evidence/... in
//     another run's directory was accepted. Refs are now admitted canonically: run-local,
//     no traversal, under evidence/.
//   * evidence carried no run identity, so a foreign record with a matching subject
//     passed. run_id is now required and must match.
//   * review_ready was trusted as stored, so a record with review_ready: true and
//     tests.exit: 1 was accepted. It is a *derived* field, so it is recomputed here from
//     the record's own contents and the stored value is required to agree. A derived
//     field read back as authority is not evidence, it is an assertion.
export function readEvidence(runDir, ref, { runId = null } = {}) {
  if (typeof ref !== "string" || !ref.trim()) throw new Error("evidence ref is missing");
  if (isAbsolute(ref) || ref.split(/[\\/]/u).includes("..")) {
    throw new Error(`evidence ref '${ref}' must be run-local without traversal`);
  }
  const normalized = ref.split(sep).join("/");
  if (!normalized.startsWith(`${EVIDENCE_DIR}/`)) {
    throw new Error(`evidence ref '${ref}' must be under ${EVIDENCE_DIR}/`);
  }
  let value;
  try {
    value = JSON.parse(readFileSync(join(runDir, normalized), "utf8"));
  } catch (error) {
    throw new Error(`evidence '${ref}' could not be read: ${error.message}`);
  }
  const unknown = Object.keys(value).filter((key) => !EVIDENCE_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`evidence '${ref}' has unknown keys: ${unknown.sort().join(", ")}`);
  for (const key of ["subject", "status", "observed_by"]) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`evidence '${ref}' has no ${key}`);
  }
  if (value.observed_by !== "orchestrator") throw new Error(`evidence '${ref}' was not written by the orchestrator`);
  if (typeof value.review_ready !== "boolean") throw new Error(`evidence '${ref}' has no review_ready`);
  if (!Number.isSafeInteger(value.attempt) || value.attempt < 1) throw new Error(`evidence '${ref}' has no attempt`);
  if (runId !== null && value.run_id !== runId) {
    throw new Error(`evidence '${ref}' belongs to run '${value.run_id}', not '${runId}'`);
  }
  const derived = deriveReviewReady(value);
  if (value.review_ready !== derived) {
    throw new Error(`evidence '${ref}' claims review_ready: ${value.review_ready} but its own contents derive ${derived}`);
  }
  return value;
}
