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

  // Exactly two parents, so first-parent means "the integration branch before this
  // merge" by construction rather than by assumption. A fast-forward has one parent -
  // the slice's own previous commit - and the proof would then measure the slice's last
  // commit against its whole reviewed diff, silently checking the wrong thing. Proving a
  // fast-forward would need the pre-merge head stored as a durable field; requiring
  // --no-ff, which the skill already specifies, costs nothing. An octopus merge carries
  // other branches, which would surface as unreviewed paths and misdescribe the cause.
  const parents = revList(worktree, mergeCommit, options);
  if (parents === null) return fail("the merge commit's parents could not be observed");
  if (parents.length !== 2) {
    return fail(`the merge commit has ${parents.length} parent${parents.length === 1 ? "" : "s"}; a slice merge must be a two-parent merge (use --no-ff)`);
  }
  const firstParent = parents[0];

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

  // Full tree-entry identity, not just the object id: rev-parse <commit>:<path> compares
  // content while ignoring mode and type, so 100644 -> 100755 with identical bytes, and a
  // regular file replaced by a symlink whose target bytes match the reviewed blob, both
  // passed. ls-tree carries mode and type, and two calls replace one rev-parse per path.
  const reviewedEntries = treeEntries(worktree, reviewedCommit, reviewedPaths, options);
  const mergedEntries = treeEntries(worktree, mergeCommit, reviewedPaths, options);
  if (reviewedEntries === null || mergedEntries === null) {
    return fail("tree entries could not be observed");
  }
  for (const path of reviewedPaths) {
    const reviewedEntry = reviewedEntries.get(path);
    const mergedEntry = mergedEntries.get(path);
    // The fail-open this replaces: both lookups returning undefined was read as "a
    // reviewed deletion the merge also made, which agrees". Both can be undefined
    // because the *lookup failed* - a trimmed filename no longer matching the real
    // path - and undefined equals undefined, so tampered content passed. A reviewed
    // deletion is now proven by the path being absent from the reviewed tree while the
    // path was genuinely observed, not inferred from two failures agreeing.
    if (reviewedEntry === undefined && mergedEntry === undefined) {
      return fail(`neither tree could be read for '${path}'`);
    }
    if (reviewedEntry !== mergedEntry) {
      return fail(`the merge's '${path}' differs from the reviewed commit's`);
    }
  }

  return { proven: true, reason: null, reviewed_paths: reviewedPaths, first_parent: firstParent };
}

// "<mode> <type> <oid>\t<path>" per line, keyed by path. Mode and type are part of the
// identity: a file that becomes executable or becomes a symlink is a different thing.
function treeEntries(worktree, commit, paths, options) {
  if (paths.length === 0) return new Map();
  // --literal-pathspecs: a filename containing a glob character is a filename, not a
  // pattern. Records are NUL-separated and the path begins after the FIRST tab, so a
  // filename containing a tab survives intact.
  const probe = git(worktree, ["--literal-pathspecs", "ls-tree", "-z", commit, "--", ...paths], options);
  if (!probe.ok) return null;
  const entries = new Map();
  for (const record of probe.stdout.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    // No trimming: leading or trailing whitespace is part of the name.
    entries.set(record.slice(tab + 1), `${mode} ${type} ${oid}`);
  }
  return entries;
}

function revList(worktree, commit, options) {
  const probe = git(worktree, ["rev-list", "--parents", "-n", "1", commit], options);
  if (!probe.ok) return null;
  // "<commit> <parent1> <parent2>..." — drop the commit itself.
  const fields = probe.stdout.trim().split(/\s+/u).filter(Boolean);
  return fields.length > 0 ? fields.slice(1) : null;
}

function pathsChanged(worktree, from, to, options) {
  // -z, and no trimming: a filename may legitimately contain a newline, a tab, or
  // leading and trailing spaces, and trimming one turned a real path into a pathspec
  // that matched nothing.
  const probe = git(worktree, ["--literal-pathspecs", "diff", "--name-only", "-z", from, to], options);
  if (!probe.ok) return null;
  return probe.stdout.split("\0").filter((path) => path !== "").sort();
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
