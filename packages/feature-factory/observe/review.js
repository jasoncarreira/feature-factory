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
import { deriveReviewReady, EVIDENCE_DIR, EVIDENCE_KEYS, git, observeAncestry } from "./index.js";

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
export function assertReviewBinding({ review, ref, observedHead, subject = null, attempt = null }) {
  // Finding 2: a review was bound to a commit but not to a subject, so a valid
  // approval for another slice at the same commit was accepted. With several slices
  // in a wave and one --review-ref argument, passing the wrong one is an ordinary
  // mistake. The record already names its subject, so checking costs nothing.
  if (subject !== null && review.subject !== subject) {
    throw new Error(`review '${ref}' approved '${review.subject}', not '${subject}'`);
  }
  if (attempt !== null && review.attempt !== attempt) {
    throw new Error(`review '${ref}' is for attempt ${review.attempt}, subject is at attempt ${attempt}`);
  }
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

// Attack 2: the merge proof. What the merge contributed must be exactly what was
// reviewed.
//
// This was tree equality — reviewed_tree === merged_tree — which is wrong for the
// design's central case. A wave's slices all branch from the same integration head and
// merges are serial, so the second merge of any wave lands on a base containing the
// first slice's work and its merged tree necessarily differs from what was reviewed.
// Every multi-slice wave would have failed on its second merge; a single-slice fixture
// hid it.
//
// Diff equality instead, expressed at blob level rather than by comparing patch text
// (patch context can differ legitimately once the surrounding base has moved):
//
//   * the paths the merge touched, relative to its first parent, are exactly the paths
//     the slice changed relative to its own base; and
//   * for each of those paths, the merge's blob equals the reviewed commit's blob.
//
// A moved base is then normal and passes. Unreviewed content inside the merge shows up
// either as an extra path or as a differing blob, and fails. Tree equality is the
// special case where the first parent still equals base_ref, i.e. a wave's first merge.
//
// Dependencies need no special handling: a wave contains only slices whose dependencies
// are already merged, so a dependent's base already includes them and its reviewed diff
// is just its own change. The only base movement the proof must tolerate is a same-wave
// sibling merging first.
export function observeMergeProof(worktree, { baseRef, reviewedCommit, mergeCommit, options = {} } = {}) {
  const fail = (reason, extra = {}) => ({ proven: false, reason, ...extra });

  const ancestry = observeAncestry(worktree, reviewedCommit, mergeCommit, options);
  if (ancestry !== "ancestor") return fail(`reviewed commit is ${ancestry} of the merge commit`);

  const firstParent = revParse(worktree, `${mergeCommit}^1`, options);
  if (!firstParent) return fail("the merge commit's first parent could not be observed");

  const reviewedPaths = pathsChanged(worktree, baseRef, reviewedCommit, options);
  const contributedPaths = pathsChanged(worktree, firstParent, mergeCommit, options);
  if (reviewedPaths === null || contributedPaths === null) {
    return fail("changed paths could not be observed");
  }

  const extra = contributedPaths.filter((path) => !reviewedPaths.includes(path));
  if (extra.length > 0) {
    return fail(`the merge contributed paths that were not reviewed: ${extra.join(", ")}`);
  }
  const missing = reviewedPaths.filter((path) => !contributedPaths.includes(path));
  if (missing.length > 0) {
    return fail(`the merge did not contribute reviewed paths: ${missing.join(", ")}`);
  }

  for (const path of reviewedPaths) {
    const reviewedBlob = revParse(worktree, `${reviewedCommit}:${path}`, options);
    const mergedBlob = revParse(worktree, `${mergeCommit}:${path}`, options);
    // Both absent is a reviewed deletion that the merge also deleted, which agrees.
    if (reviewedBlob !== mergedBlob) {
      return fail(`the merge's '${path}' differs from the reviewed commit's`);
    }
  }

  return { proven: true, reason: null, reviewed_paths: reviewedPaths, first_parent: firstParent };
}

function revParse(worktree, spec, options) {
  const probe = git(worktree, ["rev-parse", spec], options);
  return probe.ok ? probe.stdout.trim() : null;
}

function pathsChanged(worktree, from, to, options) {
  const probe = git(worktree, ["diff", "--name-only", from, to], options);
  if (!probe.ok) return null;
  return probe.stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

// Finding 2, three parts:
//
//   * the ref was an unrestricted string joined to runDir, so ../app-2/evidence/... in
//     another run's directory was accepted. Refs are admitted canonically: run-local, no
//     traversal, under evidence/.
//   * evidence carried no run identity, so a foreign record with a matching subject
//     passed. run_id is required and must match.
//   * review_ready was trusted as stored, so a record claiming true with tests.exit 1 was
//     accepted. It is a *derived* field, so it is recomputed here from the record's own
//     contents and the stored value must agree. A derived field read back as authority is
//     not evidence, it is an assertion.
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
