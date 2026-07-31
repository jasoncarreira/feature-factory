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
import { deriveReviewReady, EVIDENCE_DIR, EVIDENCE_KEYS, evidenceRef, git, observeAncestry } from "./index.js";
import { GATE_NAMES, TERMINAL_STATUSES, VALIDATOR_VERDICTS } from "../state/schema.js";

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

// The implementation-validator's judgement, bound the way every other judgement here is
// bound: by a record naming the commit it judged.
//
// `factory validator` took the verdict and head as arguments and stored them without
// reading anything, so a report describing H1 could be recorded as a verdict on H2 — which
// is exactly what happened, and it disproves the claim that the whole-diff pass stands
// between unreviewed content and a PR. It does, but only if the record says what it judged.
// Both values are now derived from that record, and the commit it names must be the head as
// observed now. `assertReviewBinding` is not reused: it demands an approving verdict, and a
// NO-GO must be recordable.
export function readValidatorReview(runDir, observedHead) {
  const ref = reviewRef("implementation-validator");
  const review = readReview(runDir, ref);
  if (review.subject !== "implementation-validator") {
    throw new Error(`${ref} describes '${review.subject}', not the implementation-validator`);
  }
  if (!VALIDATOR_VERDICTS.includes(review.verdict)) {
    throw new Error(`${ref} verdict must be one of ${VALIDATOR_VERDICTS.join(" | ")}`);
  }
  if (!SHA.test(String(observedHead))) {
    throw new Error(`${ref} cannot be recorded without an observed integration head`);
  }
  if (review.reviewed_commit !== observedHead) {
    throw new Error(`${ref} judged ${review.reviewed_commit.slice(0, 12)} but the integration head is ${String(observedHead).slice(0, 12)}; re-run the validator`);
  }
  return review;
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
// Diff equality instead, expressed as changed-path sets rather than by comparing patch
// text (patch context can differ legitimately once the surrounding base has moved):
//
//   * the paths the merge touched, relative to its first parent, are exactly the paths
//     the slice changed relative to its own base; and
//   * the reviewed commit and the merge differ on none of those paths.
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

  // Do not add a check that the base moved only by *recorded* slice merges. It was built
  // and reverted: `base_ref` is immutable, so refusing the merge permanently strands the
  // slice and the run ships nothing — a whole feature destroyed to enforce a lane check.
  // It also contradicts SKILL.md, whose NO-GO remediation permits fixing test-only problems
  // directly in the integration branch. Unreviewed content is stopped downstream instead,
  // where it costs an approval rather than the run: the validator judges the whole
  // integrated diff, and publication requires its judged head to still be the head.

  // Content identity, asked as one diff rather than as a per-path lookup.
  //
  // This was a per-path `ls-tree` comparison, and it could not distinguish two cases that
  // both look like an empty lookup: the path is absent because the slice deleted it and
  // the merge deleted it too, which agrees; or the pathspec matched nothing because the
  // name was mis-parsed, which is tampered content wrongly proven. Treating them the same
  // either passed the tampering or, once that was refused, refused every slice that
  // deletes a file. Both spellings were wrong because the question was asked in a form
  // whose failure mode is silence.
  //
  // Asked as a diff, there is no lookup to miss. Any difference on a reviewed path —
  // content, file mode, or a regular file becoming a symlink — appears as that path in
  // the drift list, and a deletion both commits made appears in neither. Both lists come
  // from the same parser, so a mis-parsed name compares as the same wrong string on both
  // sides and still matches.
  //
  // Drift on a path *outside* reviewedPaths is the sibling-merge case this proof must
  // tolerate: such a path is identical in base and reviewed, and the two-parent check
  // above already proved the merge contributed nothing outside reviewedPaths, so the
  // difference came from the integration branch rather than from this slice.
  const drift = pathsChanged(worktree, reviewedCommit, mergeCommit, options);
  if (drift === null) return fail("the reviewed commit could not be compared to the merge");
  const altered = drift.filter((path) => reviewedPaths.includes(path));
  if (altered.length > 0) {
    return fail(`the merge's content differs from the reviewed commit's: ${altered.join(", ")}`);
  }

  return { proven: true, reason: null, reviewed_paths: reviewedPaths, first_parent: firstParent };
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

// The single definition of "this run may be published", asked at both points where that
// question has an answer: when Gate 3 is approved, and again when the PR is recorded.
//
// It lived only in the `pr` handler, and the skill pushes the branch and creates the PR
// *before* calling `factory pr` — so every check there was post-effect. It could describe
// a bad publication; it could not stop one. Gate 3's approval is the last transition
// before the push, so that is where the refusal has to be able to land. Asking again at
// `pr` is not redundant: between the two, slices can regress and the integration head can
// move, and the second call re-observes rather than trusting the first.
//
// `observeHead` is injected so this module does not need to know how a worktree is
// resolved; it returns the integration branch's currently observed commit, or null.
export function assertPublicationReady({ runDir, state, runId, observeHead }) {
  const refuse = (message) => { throw new Error(`this run is not publishable: ${message}`); };

  if (TERMINAL_STATUSES.includes(state.status)) {
    refuse(`a ${state.status} run must be surfaced, not published`);
  }
  // Every gate, currently approved — not just pre_pr, and not "was approved once".
  // Re-opening a decided gate is what keeps a late change from stranding a run, but it also
  // means an approval can be withdrawn, and publication was reading only pre_pr: opencode
  // approved Gate 3, re-opened Story, decided stop, and recorded a PR against a stopped
  // run. Asking for the current status of all three is what makes re-opening safe.
  const unapproved = GATE_NAMES.filter((name) => state.gates?.[name]?.status !== "approved");
  if (unapproved.length > 0) {
    refuse(`every gate must be approved; not approved: ${unapproved.map((name) => `${name}(${state.gates?.[name]?.status ?? "absent"})`).join(", ")}`);
  }
  if (!Array.isArray(state.slices) || state.slices.length === 0) refuse("no slice plan has been seeded");
  const unmerged = state.slices.filter((slice) => slice.status !== "merged");
  if (unmerged.length > 0) {
    refuse(`every slice must be merged; not merged: ${unmerged.map((slice) => `${slice.id}(${slice.status})`).join(", ")}`);
  }
  // Attack 4: the verdict names the head it judged, and that head is re-observed here
  // rather than read back from the manifest — the manifest records what we were told and
  // the repository records what is true.
  const head = observeHead();
  if (!head) refuse("the integration head could not be observed");
  // Required only when there is something holistic to judge: the validator's subject is the diff
  // *across* slices, and one slice has none — it re-reads what the slice reviewer just approved,
  // serialized before the gate. Zero slices was refused above, so this is not "skip when nothing
  // was built". Skipping is permitted, ignoring is not: a recorded verdict must approve and must
  // name this head either way. The published head stays bound by the test-verifier check below.
  const validator = state.validator;
  if (!validator && state.slices.length > 1) refuse("a multi-slice run requires an approving validator verdict");
  if (validator && !isApproving(validator.verdict)) refuse("the validator verdict is not an approval");
  if (validator && head !== validator.reviewed_head) {
    refuse(`the validator judged ${String(validator.reviewed_head).slice(0, 12)} but the integration head is ${head.slice(0, 12)}`);
  }

  // The test-verifier stage, required by evidence rather than by having been mentioned.
  // Read at its canonical path, not through a ref in run.json: a ref is a value the
  // orchestrator chooses, and the point is that this particular stage ran.
  //
  // `review_ready` is not sufficient here. It admits an explicitly-reasoned skip, which
  // is right for a slice whose gate waived tests and wrong for the stage whose entire
  // job is to run them. So the run is required to have been observed, and to have exited
  // zero, with no exemption available.
  const ref = evidenceRef("test-verifier");
  const evidence = readEvidence(runDir, ref, { runId });
  if (evidence.subject !== "test-verifier") refuse(`${ref} describes '${evidence.subject}'`);
  // The concrete facts before the derived one, so each refusal names what is actually
  // wrong. Reversed, `review_ready` absorbs both: a failing run derives false, so the
  // exit-code branch could never be reached and would have been a dead guard reading as
  // enforcement. The observed-run branch stays load-bearing either way — `review_ready`
  // admits a recorded skip, which is exactly the exemption this stage does not get.
  if (evidence.tests?.observed !== true) refuse(`${ref} records no observed test run`);
  if (evidence.tests.exit !== 0) refuse(`${ref} records tests exiting ${evidence.tests.exit}`);
  if (evidence.review_ready !== true) {
    refuse(`${ref} is not review_ready${evidence.blocked_reason ? `: ${evidence.blocked_reason}` : ""}`);
  }
  if (evidence.commit !== head) {
    refuse(`${ref} tested ${String(evidence.commit).slice(0, 12)} but the integration head is ${head.slice(0, 12)}`);
  }
  return { head, tested: evidence.commit };
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
