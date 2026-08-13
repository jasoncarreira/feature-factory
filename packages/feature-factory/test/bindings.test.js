// Attacks 2, 3, 4, 9, 10 — judgements bound to their subjects, and effects
// recorded exactly once.
//
// Each guard is falsified by removing it; the results are in the commit message.
// Where a test could pass for a reason other than the guard under test, the fixture
// is made otherwise-green so only that guard can explain the refusal.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertReviewBinding, observeMergeProof, readEvidence, readReview } from "../observe/review.js";
import { archiveReviewAttempt } from "../state/review-archive.js";

const run = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// An integration branch with one slice branched off it, mirroring the real flow:
// the slice branches from the current integration head, so a clean merge produces
// the reviewed tree.
function fixture(name) {
  const root = mkdtempSync(join(tmpdir(), `ff-bind-${name}-`));
  run(root, "init", "-q", "-b", "feature");
  run(root, "config", "user.email", "t@example.com");
  run(root, "config", "user.name", "T");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "base.ts"), "base\n");
  writeFileSync(join(root, ".gitignore"), ".factory/\n");
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "base");
  const featureBase = run(root, "rev-parse", "HEAD");

  run(root, "checkout", "-q", "-b", "slice");
  writeFileSync(join(root, "src", "slice.ts"), "slice\n");
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "slice");
  const sliceHead = run(root, "rev-parse", "HEAD");

  const runDir = join(root, ".factory", "app-1");
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  return { root, runDir, featureBase, sliceHead };
}

function writeReview(runDir, subject, overrides = {}) {
  const review = {
    subject, reviewer: "work-reviewer", verdict: "APPROVE", attempt: 1,
    reviewed_commit: "a".repeat(40), findings: [], required_fixes: [], checked_against: ["brief"],
    ...overrides,
  };
  writeFileSync(join(runDir, "reviews", `${subject}.json`), `${JSON.stringify(review, null, 2)}\n`);
  return `reviews/${subject}.json`;
}

// Merge the slice into the integration branch the way the orchestrator does.
function mergeSlice(root) {
  run(root, "checkout", "-q", "feature");
  run(root, "merge", "-q", "--no-ff", "slice", "-m", "merge slice");
  return run(root, "rev-parse", "HEAD");
}

describe("attack 3 — an approval presented against a different commit", () => {
  it("refuses a review bound to another commit, and accepts the matching one", () => {
    const f = fixture("binding");
    try {
      const ref = writeReview(f.runDir, "be-slice", { reviewed_commit: f.sliceHead });
      const review = readReview(f.runDir, ref);

      // The head it judged: accepted.
      assertReviewBinding({ review, ref, observedHead: f.sliceHead });

      // A different commit: refused, even though the verdict is a genuine APPROVE.
      assert.throws(() => assertReviewBinding({ review, ref, observedHead: f.featureBase }),
        /approved [0-9a-f]{12} but the head is [0-9a-f]{12}/u);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("refuses a review with no reviewed_commit at all", () => {
    const f = fixture("unbound");
    try {
      const ref = writeReview(f.runDir, "be-slice", { reviewed_commit: undefined });
      assert.throws(() => readReview(f.runDir, ref), /must record reviewed_commit as a full 40-character sha/u);
      // A short sha is not a binding either: it cannot be compared unambiguously.
      const shortRef = writeReview(f.runDir, "short", { reviewed_commit: f.sliceHead.slice(0, 12) });
      assert.throws(() => readReview(f.runDir, shortRef), /full 40-character sha/u);

      // One refusal names every problem. This record is 1437's shape: the validator wrote the sha under
      // `reviewed_head`, added `risks`, and omitted `attempt`. Fail-fast reported only the unknown keys, so
      // correcting them would have earned a second refusal for the binding and a third for the attempt --
      // each one another validator pass over a 27-file change.
      const manyRef = writeReview(f.runDir, "many", {
        reviewed_commit: undefined, attempt: undefined,
        reviewed_head: f.sliceHead, risks: ["unclosed contract"],
      });
      // The other half of the same contract: these four were rejected when unknown but never required, so a
      // record with only a subject, verdict, attempt and binding passed as a complete approval. `findings` and
      // `checked_against` are the evidence an approval is supposed to carry.
      const partialRef = join("reviews", "partial.json");
      writeFileSync(join(f.runDir, partialRef), `${JSON.stringify({
        subject: "be-slice", verdict: "APPROVE", attempt: 1, reviewed_commit: f.sliceHead,
      }, null, 2)}\n`);
      let partial = null;
      try { readReview(f.runDir, partialRef); } catch (error) { partial = error; }
      assert.ok(partial, "a record missing half the required keys must be refused");
      for (const fragment of [
        "has no reviewer", "must record findings as an array",
        "must record required_fixes as an array", "must record checked_against as a non-empty array",
      ]) {
        assert.ok(partial.message.includes(fragment), `one refusal must name every missing key, missing: ${fragment}`);
      }

      // And key order is deliberately not part of the contract: JSON order carries no meaning, so a complete
      // record in a different order is accepted. Refusing it would be the over-reach that cost run 291.
      const shuffledRef = join("reviews", "shuffled.json");
      writeFileSync(join(f.runDir, shuffledRef), `${JSON.stringify({
        checked_against: ["brief"], required_fixes: [], findings: [], reviewed_commit: f.sliceHead,
        attempt: 1, verdict: "APPROVE", reviewer: "work-reviewer", subject: "be-slice",
      }, null, 2)}\n`);
      assert.doesNotThrow(() => readReview(f.runDir, shuffledRef),
        "a complete record must be accepted regardless of key order");

      let raised = null;
      try { readReview(f.runDir, manyRef); } catch (error) { raised = error; }
      assert.ok(raised, "a record with three shape problems must be refused");
      for (const fragment of [
        "has unknown keys: reviewed_head, risks",
        "has no attempt",
        "must record reviewed_commit as a full 40-character sha",
      ]) {
        assert.ok(raised.message.includes(fragment), `one refusal must name every problem, missing: ${fragment}`);
      }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("refuses a review from an earlier attempt, and retains what each attempt said", async () => {
    // Attempts are distinct review rounds: attempt 1's approval says nothing about the
    // code produced for attempt 2. Isolated deliberately — the subject and commit both
    // match, so only the attempt comparison can refuse this.
    const f = fixture("stale-attempt");
    try {
      const ref = writeReview(f.runDir, "be-slice", { reviewed_commit: f.sliceHead, attempt: 1 });
      const review = readReview(f.runDir, ref);

      assert.doesNotThrow(() => assertReviewBinding({
        review, ref, observedHead: f.sliceHead, subject: "be-slice", attempt: 1,
      }), "the matching attempt must be accepted");

      assert.throws(() => assertReviewBinding({
        review, ref, observedHead: f.sliceHead, subject: "be-slice", attempt: 2,
      }), /is for attempt 1, subject is at attempt 2/u);

      // Distinct rounds share one path, so each attempt overwrites the last. That is fatal
      // exactly when it matters: attempts are budgeted, exhausting the budget blocks a run,
      // and `blocked` is final. Run 216's test-verifier was rejected twice and approved on
      // the third, and both rejection reasons are gone — reconstructable only from commit
      // subjects, which is guesswork wearing evidence's clothes.
      const rejected = writeReview(f.runDir, "round", {
        reviewed_commit: f.sliceHead, attempt: 1, verdict: "REQUEST_CHANGES",
        required_fixes: ["cover the refusal path"],
      });
      assert.equal(await archiveReviewAttempt(f.runDir, rejected), "reviews/round.attempt-1.json");

      writeReview(f.runDir, "round", { reviewed_commit: f.sliceHead, attempt: 2, verdict: "APPROVE" });
      assert.equal(await archiveReviewAttempt(f.runDir, rejected), "reviews/round.attempt-2.json");

      const archived = (n) =>
        JSON.parse(readFileSync(join(f.runDir, "reviews", `round.attempt-${n}.json`), "utf8"));
      assert.equal(archived(1).verdict, "REQUEST_CHANGES", "the overwritten verdict must survive");
      assert.deepEqual(archived(1).required_fixes, ["cover the refusal path"],
        "what the reviewer demanded is the whole reason to keep it");
      assert.equal(archived(2).verdict, "APPROVE");

      // An archive that can be rewritten is not an archive: a later record filed under an
      // attempt already preserved must not be able to restate that attempt's history.
      writeReview(f.runDir, "round", {
        reviewed_commit: f.sliceHead, attempt: 1, verdict: "APPROVE", findings: ["revised"],
      });
      assert.equal(await archiveReviewAttempt(f.runDir, rejected), "reviews/round.attempt-1.json");
      assert.equal(archived(1).verdict, "REQUEST_CHANGES", "the first record of an attempt wins");

      // Instruction, not enforcement: a record that cannot be archived must not fail the step
      // that earned it, because losing a verdict cannot manufacture a false green.
      assert.equal(await archiveReviewAttempt(f.runDir, "reviews/absent.json"), null);
      writeFileSync(join(f.runDir, "reviews", "torn.json"), "{ not json");
      assert.equal(await archiveReviewAttempt(f.runDir, "reviews/torn.json"), null);
      writeReview(f.runDir, "no-attempt", { attempt: undefined });
      assert.equal(await archiveReviewAttempt(f.runDir, "reviews/no-attempt.json"), null);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("refuses a non-approving verdict and an unknown key", () => {
    const f = fixture("verdicts");
    try {
      const rejectRef = writeReview(f.runDir, "rejected", { verdict: "REJECT", reviewed_commit: f.sliceHead });
      const review = readReview(f.runDir, rejectRef);
      assert.throws(() => assertReviewBinding({ review, ref: rejectRef, observedHead: f.sliceHead }),
        /verdict is REJECT, not an approval/u);
      const oddRef = writeReview(f.runDir, "odd", { reviewed_commit: f.sliceHead, late_discovery_strike: false });
      assert.throws(() => readReview(f.runDir, oddRef), /unknown keys: late_discovery_strike/u);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe("attack 2 — the merge must contribute exactly what was reviewed", () => {
  it("proves a merge onto an unmoved base", () => {
    const f = fixture("proof-ok");
    try {
      const mergeCommit = mergeSlice(f.root);
      const proof = observeMergeProof(f.root, {
        baseRef: f.featureBase, reviewedCommit: f.sliceHead, mergeCommit,
      });
      assert.equal(proof.proven, true, proof.reason ?? "");
      assert.deepEqual(proof.reviewed_paths, ["src/slice.ts"]);

      // Folded in: a slice whose change is a deletion. Ordinary refactoring work, and it
      // was refused outright for one commit — the per-path tree lookup found the path in
      // neither tree and could not tell that from a failed lookup, so refusing the
      // ambiguity refused the deletion. The proof is asked as a diff now, in which a
      // deletion both commits made is simply no difference.
      const del = fixture("proof-deletion");
      try {
        run(del.root, "checkout", "-q", "slice");
        run(del.root, "rm", "-q", "src/base.ts");
        run(del.root, "commit", "-q", "-m", "slice deletes a file");
        const deletedAt = run(del.root, "rev-parse", "HEAD");
        const delMerge = mergeSlice(del.root);

        const delProof = observeMergeProof(del.root, {
          baseRef: del.featureBase, reviewedCommit: deletedAt, mergeCommit: delMerge,
        });
        assert.equal(delProof.proven, true, delProof.reason ?? "");
        assert.deepEqual(delProof.reviewed_paths, ["src/base.ts", "src/slice.ts"],
          "the deleted path is part of the reviewed change, not an unreadable tree entry");
      } finally { rmSync(del.root, { recursive: true, force: true }); }

      // Same group, because it is the same question: which merge topologies can be
      // proven. A fast-forward has no merge commit, so its first parent is the slice's
      // own previous commit and the proof would measure the slice's last commit against
      // its whole reviewed diff — silently the wrong thing. Proving one would need the
      // pre-merge head stored durably; requiring --no-ff, which the skill specifies,
      // costs nothing.
      const ff = fixture("proof-ff");
      try {
        run(ff.root, "checkout", "-q", "feature");
        run(ff.root, "merge", "-q", "--ff-only", "slice");
        const forwarded = run(ff.root, "rev-parse", "HEAD");
        assert.equal(forwarded, ff.sliceHead, "a fast-forward leaves the slice head as the tip");
        const ffProof = observeMergeProof(ff.root, {
          baseRef: ff.featureBase, reviewedCommit: ff.sliceHead, mergeCommit: forwarded,
        });
        assert.equal(ffProof.proven, false);
        assert.match(ffProof.reason, /has 1 parent; a slice merge must be a two-parent merge \(use --no-ff\)/u);
      } finally { rmSync(ff.root, { recursive: true, force: true }); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("tolerates a base that moved, which is what a wave's second merge always looks like", () => {
    // Inverted deliberately. This scenario used to be asserted as a failure, on the
    // assumption that nothing lands between a slice branching and merging. A wave's
    // slices all branch from one head and merge serially, so for every merge after the
    // first the base has moved and the merged tree contains a sibling's work. That is
    // normal and must pass.
    const f = fixture("proof-moved-base");
    try {
      // The sibling arrives as a real merge, which is how a wave actually moves the base.
      // A bare commit would also be tolerated — see the end-to-end moved-base test for why
      // that is deliberate — but modelling the real shape here keeps this test about the
      // case the proof was redesigned for.
      run(f.root, "checkout", "-q", "-b", "sibling", f.featureBase);
      writeFileSync(join(f.root, "src", "sibling.ts"), "another slice\n");
      run(f.root, "add", "-A");
      run(f.root, "commit", "-q", "-m", "sibling work");
      run(f.root, "checkout", "-q", "feature");
      run(f.root, "merge", "-q", "--no-ff", "sibling", "-m", "merge sibling");
      const mergeCommit = mergeSlice(f.root);

      const proof = observeMergeProof(f.root, {
        baseRef: f.featureBase, reviewedCommit: f.sliceHead, mergeCommit,
      });
      assert.equal(proof.proven, true, proof.reason ?? "");
      assert.deepEqual(proof.reviewed_paths, ["src/slice.ts"],
        "only the slice's own path was reviewed, and only it may be contributed");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("refuses a merge that carries a path nobody reviewed", () => {
    // The case tree equality was really trying to catch, now isolated from base movement.
    const f = fixture("proof-extra-path");
    try {
      run(f.root, "checkout", "-q", "feature");
      run(f.root, "merge", "-q", "--no-ff", "--no-commit", "slice");
      writeFileSync(join(f.root, "src", "smuggled.ts"), "never reviewed\n");
      run(f.root, "add", "-A");
      run(f.root, "commit", "-q", "-m", "merge slice plus extra");
      const mergeCommit = run(f.root, "rev-parse", "HEAD");

      const proof = observeMergeProof(f.root, {
        baseRef: f.featureBase, reviewedCommit: f.sliceHead, mergeCommit,
      });
      assert.equal(proof.proven, false);
      assert.match(proof.reason, /contributed paths that were not reviewed: src\/smuggled\.ts/u);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("refuses a merge whose content differs from the reviewed content", () => {
    const f = fixture("proof-altered");
    try {
      run(f.root, "checkout", "-q", "feature");
      run(f.root, "merge", "-q", "--no-ff", "--no-commit", "slice");
      writeFileSync(join(f.root, "src", "slice.ts"), "altered during the merge\n");
      run(f.root, "add", "-A");
      run(f.root, "commit", "-q", "-m", "merge slice, altered");
      const mergeCommit = run(f.root, "rev-parse", "HEAD");

      const proof = observeMergeProof(f.root, {
        baseRef: f.featureBase, reviewedCommit: f.sliceHead, mergeCommit,
      });
      assert.equal(proof.proven, false);
      assert.match(proof.reason, /differs from the reviewed commit's: src\/slice\.ts/u);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("refuses a merge that drops part of the reviewed change", () => {
    // The other half of diff equality. A conflict resolution that quietly discards one of
    // the reviewed files ships less than was approved, which is as wrong as shipping more.
    const f = fixture("proof-dropped");
    try {
      run(f.root, "checkout", "-q", "slice");
      writeFileSync(join(f.root, "src", "second.ts"), "also reviewed\n");
      run(f.root, "add", "-A");
      run(f.root, "commit", "-q", "-m", "second reviewed file");
      const reviewedCommit = run(f.root, "rev-parse", "HEAD");

      run(f.root, "checkout", "-q", "feature");
      run(f.root, "merge", "-q", "--no-ff", "--no-commit", "slice");
      run(f.root, "rm", "-qf", "src/second.ts");
      run(f.root, "commit", "-q", "-m", "merge slice, minus one file");
      const mergeCommit = run(f.root, "rev-parse", "HEAD");

      const proof = observeMergeProof(f.root, {
        baseRef: f.featureBase, reviewedCommit, mergeCommit,
      });
      assert.equal(proof.proven, false);
      assert.match(proof.reason, /did not contribute reviewed paths: src\/second\.ts/u);

      // Folded in: altered content must be caught whatever the filename's bytes are.
      //
      // Stated honestly, because the previous version of this comment claimed more than
      // the test shows: this case passes under both the old newline-split-and-trim path
      // parsing and the current NUL-delimited parsing, so it does not falsify that
      // change. It cannot, now — the proof compares two path lists produced by the same
      // parser and holds no pathspec, so a mis-parsed name compares as the same wrong
      // string on both sides and the difference still surfaces. The parsing is right on
      // its own merits and matters where paths are used as pathspecs or matched against
      // declared ownership; it is no longer load-bearing here.
      const spaced = fixture("proof-spaced-name");
      try {
        run(spaced.root, "checkout", "-q", "slice");
        writeFileSync(join(spaced.root, "src", "spaced .ts"), "reviewed\n");
        run(spaced.root, "add", "-A");
        run(spaced.root, "commit", "-q", "-m", "file with a trailing space in its name");
        const spacedReviewed = run(spaced.root, "rev-parse", "HEAD");

        run(spaced.root, "checkout", "-q", "feature");
        run(spaced.root, "merge", "-q", "--no-ff", "--no-commit", "slice");
        writeFileSync(join(spaced.root, "src", "spaced .ts"), "TAMPERED\n");
        run(spaced.root, "add", "-A");
        run(spaced.root, "commit", "-q", "-m", "merge, altered");
        const spacedMerge = run(spaced.root, "rev-parse", "HEAD");

        const spacedProof = observeMergeProof(spaced.root, {
          baseRef: spaced.featureBase, reviewedCommit: spacedReviewed, mergeCommit: spacedMerge,
        });
        assert.equal(spacedProof.proven, false, "altered content must be caught whatever the filename");
        assert.match(spacedProof.reason, /differs from the reviewed commit's/u);
      } finally { rmSync(spaced.root, { recursive: true, force: true }); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("refuses when the reviewed commit is not an ancestor of the merge", () => {
    const f = fixture("proof-unrelated");
    try {
      const mergeCommit = mergeSlice(f.root);
      run(f.root, "checkout", "-q", "--orphan", "elsewhere");
      run(f.root, "rm", "-rq", "--cached", ".");
      writeFileSync(join(f.root, "other.ts"), "x\n");
      run(f.root, "add", "-A");
      run(f.root, "commit", "-q", "-m", "unrelated");
      const unrelated = run(f.root, "rev-parse", "HEAD");

      const proof = observeMergeProof(f.root, {
        baseRef: f.featureBase, reviewedCommit: unrelated, mergeCommit,
      });
      assert.equal(proof.proven, false);
      assert.match(proof.reason, /not-ancestor/u);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("refuses when the changed paths cannot be observed", () => {
    const f = fixture("proof-unobservable");
    try {
      const mergeCommit = mergeSlice(f.root);
      const proof = observeMergeProof(f.root, {
        baseRef: "refs/heads/does-not-exist", reviewedCommit: f.sliceHead, mergeCommit,
      });
      assert.equal(proof.proven, false);
      assert.equal(proof.reason, "changed paths could not be observed");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe("attack 8 — external state changes between observation and effect", () => {
  it("observes immediately before the commit, not at command start", async () => {
    // The distinctive claim of this attack is about *ordering*: a check performed
    // when the command starts is worthless if the world moves before the write
    // lands. The write core runs reobserve inside the rename, after the mutator and
    // after the compare-and-swap, so a change injected at the commit boundary must
    // still be caught.
    const { transition } = await import("../state/transition.js");
    const f = fixture("late-observation");
    try {
      const runDir = f.runDir;
      writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
        version: 1, run_id: "app-1", issue_key: null, branch: "feature", worktree: ".",
        created_at: "2026-07-30T12:00:00.000Z", updated_at: "2026-07-30T12:00:00.000Z",
        status: "running", mode: "interactive", max_parallel_slices: 3, max_retries: 3,
        gates: {}, steps: [],
        slices: [{
          id: "be-thing", stack: "backend", depends_on: [], status: "review",
          worktree: ".", branch: "slice", attempts: 1, paths: ["src/"], test_plan: ["t"],
          base_ref: f.featureBase, evidence_ref: null, review_ref: "reviews/be-thing.json",
          merge_commit: null,
        }],
        validator: null, terminal_result: null, pr_url: null,
      }, null, 2)}\n`);

      let observedAt = null;
      let injected = false;
      const reobservers = new Map([["slices", async () => {
        // What the observer reports is decided when it runs, which is the point.
        observedAt = injected ? "after-injection" : "before-injection";
        return { diff_observed: true, unowned: injected ? ["src/injected.ts"] : [], privileged: [] };
      }]]);

      await assert.rejects(() => transition(runDir, {
        participants: [{ familyId: "slices", mode: "merge" }],
        reobservers,
        apply: (state) => ({
          ...state,
          updated_at: "2026-07-30T12:05:00.000Z",
          slices: state.slices.map((slice) => ({ ...slice, status: "merged", merge_commit: "b".repeat(40) })),
        }),
        // Fires after the mutator and before the rename: the window an early check
        // would miss entirely.
        hooks: { beforeCommit: () => { injected = true; } },
      }), (error) => {
        assert.match(String(error.cause?.message ?? error.message), /changed paths it does not own: src\/injected\.ts/u);
        return true;
      });

      assert.equal(observedAt, "after-injection",
        "the observation must run after the commit-boundary injection, or an early check would have passed");
      assert.equal(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).slices[0].status, "review",
        "the refused merge must leave the slice unmerged");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe("evidence records are bound to their run and internally consistent", () => {
  function writeEvidence(runDir, overrides = {}) {
    mkdirSync(join(runDir, "evidence"), { recursive: true });
    const record = {
      subject: "be-thing", run_id: "app-1", attempt: 1, branch: "slice",
      base_ref: "a".repeat(40), worktree: ".", status: "completed", blocked_reason: null,
      worktree_clean: true,
      files_changed: ["src/app/thing.ts"], diff_stat: " 1 file changed", diff_observed: true,
      commands: [], tests: { cmd: "npm test", exit: 0, observed: true, skipped_reason: null },
      commit: "b".repeat(40), observed_by: "orchestrator", review_ready: true,
      claim_reconciliation: { claimed: false, mismatches: [] },
      ...overrides,
    };
    writeFileSync(join(runDir, "evidence", "be-thing.json"), `${JSON.stringify(record, null, 2)}\n`);
    return "evidence/be-thing.json";
  }

  it("accepts a consistent run-local record", () => {
    const f = fixture("ev-ok");
    try {
      const ref = writeEvidence(f.runDir);
      assert.equal(readEvidence(f.runDir, ref, { runId: "app-1" }).subject, "be-thing");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("refuses a record whose stored review_ready disagrees with its own contents", () => {
    // review_ready is derived. Read back as authority it is not evidence, it is an
    // assertion — so it is recomputed and the stored value must agree.
    const f = fixture("ev-tampered");
    try {
      const ref = writeEvidence(f.runDir, { tests: { cmd: "npm test", exit: 1, observed: true, skipped_reason: null } });
      assert.throws(() => readEvidence(f.runDir, ref, { runId: "app-1" }),
        /claims review_ready: true but its own contents derive false/u);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("refuses a record belonging to another run", () => {
    const f = fixture("ev-foreign");
    try {
      const ref = writeEvidence(f.runDir, { run_id: "app-2" });
      assert.throws(() => readEvidence(f.runDir, ref, { runId: "app-1" }),
        /belongs to run 'app-2', not 'app-1'/u);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("refuses a ref that escapes the run or its directory", () => {
    const f = fixture("ev-escape");
    try {
      writeEvidence(f.runDir);
      for (const ref of ["../app-2/evidence/be-thing.json", "/etc/passwd"]) {
        assert.throws(() => readEvidence(f.runDir, ref, { runId: "app-1" }),
          /must be run-local without traversal/u, `must refuse ${ref}`);
      }

      // Isolates the directory rule: this file is present and perfectly valid, so a
      // "could not be read" failure cannot be what refuses it — only the requirement
      // that evidence live under evidence/ can.
      const valid = JSON.parse(readFileSync(join(f.runDir, "evidence", "be-thing.json"), "utf8"));
      mkdirSync(join(f.runDir, "reviews"), { recursive: true });
      writeFileSync(join(f.runDir, "reviews", "be-thing.json"), `${JSON.stringify(valid, null, 2)}\n`);
      assert.doesNotThrow(() => readEvidence(f.runDir, "evidence/be-thing.json", { runId: "app-1" }),
        "the same contents under evidence/ must be accepted");
      assert.throws(() => readEvidence(f.runDir, "reviews/be-thing.json", { runId: "app-1" }),
        /must be under evidence\//u, "identical contents outside evidence/ must be refused");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("refuses a record carrying an unknown key", () => {
    const f = fixture("ev-unknown");
    try {
      const ref = writeEvidence(f.runDir, { late_discovery_strike: false });
      assert.throws(() => readEvidence(f.runDir, ref, { runId: "app-1" }), /unknown keys: late_discovery_strike/u);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
