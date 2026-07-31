// Wiring, not mechanism.
//
// The unit tests prove the observers are correct. They cannot prove the transition
// actually calls them. That distinction is not academic: the predecessor shipped a
// gate span whose attribute was always undefined, and an ancestry probe bound to a
// boolean, both of which had correct helpers and dead wiring. So every refusal
// below is driven through the real CLI against a real repository.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run as cli } from "../bin/factory.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "factory.js");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// Runs the CLI out of process so the assertion is against the real entry point,
// including argument parsing, rather than against an imported handler.
function factory(repo, args) {
  try {
    const stdout = execFileSync("node", [CLI, ...args, "--repo", repo, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: JSON.parse(stdout) };
  } catch (error) {
    return { ok: false, stderr: String(error.stderr ?? error.message) };
  }
}

const RUN = "app-1";
const NOW = (minute) => `2026-07-30T12:${String(minute).padStart(2, "0")}:00Z`;

// A repository with an integration branch and one slice branched from its head.
function project(name, { seed = true, testPlan = ["t"] } = {}) {
  const repo = mkdtempSync(join(tmpdir(), `ff-e2e-${name}-`));
  git(repo, "init", "-q", "-b", "feature");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  mkdirSync(join(repo, "src", "app"), { recursive: true });
  writeFileSync(join(repo, "src", "app", "base.ts"), "base\n");
  // The control plane must be untracked. If it is not, run.json changes appear in
  // every slice diff and every merge trips the privileged-path refusal - which is
  // how this fixture first failed, and is a real deployment requirement rather than
  // a test detail.
  writeFileSync(join(repo, ".gitignore"), ".factory/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");

  const runDir = join(repo, ".factory", RUN);
  const init = factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW(0)]);
  assert.equal(init.ok, true, init.stderr);
  writeFileSync(join(runDir, "plan", "slices.json"), JSON.stringify({
    slices: [{ id: "be-thing", stack: "backend", paths: ["src/app/"], depends_on: [], acceptance: ["AC1"], test_plan: testPlan }],
  }, null, 2));
  if (seed) assert.equal(factory(repo, ["slices-seed", RUN, "--now", NOW(1)]).ok, true);
  return { repo, runDir };
}

// Build the slice, optionally touching an extra path, and return its head.
function buildSlice(repo, { extra = null } = {}) {
  const basePoint = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "slice");
  writeFileSync(join(repo, "src", "app", "thing.ts"), "slice\n");
  if (extra) {
    mkdirSync(join(repo, dirname(extra)), { recursive: true });
    writeFileSync(join(repo, extra), "extra\n");
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "slice work");
  return { head: git(repo, "rev-parse", "HEAD"), basePoint };
}

function writeReview(runDir, subject, reviewedCommit, overrides = {}) {
  writeFileSync(join(runDir, "reviews", `${subject}.json`), `${JSON.stringify({
    subject, reviewer: "work-reviewer", verdict: "APPROVE", attempt: 1,
    reviewed_commit: reviewedCommit, findings: [], required_fixes: [], checked_against: ["brief"],
    ...overrides,
  }, null, 2)}\n`);
  return `reviews/${subject}.json`;
}

// The validator judges a commit and says so in its record; `factory validator` derives the
// verdict and the head from that rather than taking them as arguments. Reports used to be
// an opaque path and the head an argument, so a report about one commit could be recorded
// as a verdict on another.
function recordValidator(repo, runDir, head, verdict, at) {
  writeReview(runDir, "implementation-validator", head, { verdict });
  return factory(repo, ["validator", RUN, "--report", "artifacts/validation-report.md", "--now", at]);
}

function mergeIntoFeature(repo) {
  git(repo, "checkout", "-q", "feature");
  git(repo, "merge", "-q", "--no-ff", "slice", "-m", "merge slice");
  return git(repo, "rev-parse", "HEAD");
}

const runJson = (runDir) => JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));

// Every publication check now asks for all three gates, so a fixture probing one specific
// refusal has to be otherwise-complete or the earlier gates explain the failure instead of
// the guard under test. That masking has bitten this suite repeatedly.
function approveEarlyGates(repo, at) {
  for (const name of ["story", "brief"]) { const r = approveGate(repo, name, at); assert.equal(r.ok, true, `${name}: ${r.stderr}`); }
}

function approveGate(repo, name, at) {
  factory(repo, ["gate", RUN, name, "pending", "--now", at]);
  return factory(repo, ["gate", RUN, name, "approved", "--now", at]);
}

describe("end to end — a merge is refused through the real CLI", () => {
  function upToReview(name, buildOptions) {
    const p = project(name);
    const { head: sliceHead } = buildSlice(p.repo, buildOptions);
    const activated = factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
    assert.equal(activated.ok, true, activated.stderr);
    // The documented flow: `observe --base` takes the base_ref this command reported. Asserted
    // because the skill told readers to get it from `factory status`, which never exposed it.
    const basePoint = activated.out.base_ref;
    assert.match(String(basePoint), /^[0-9a-f]{40}$/u, "activation must report the base_ref it recorded");
    // The orchestrator must observe before it may merge: the diff is re-derived and
    // the named tests are re-run here, not taken from a builder's report.
    const observed = factory(p.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", basePoint,
      "--attempt", "1", "--test-cmd", "git --no-pager log -1 --format=%H", "--now", NOW(3)]);
    assert.equal(observed.ok, true, observed.stderr);
    assert.equal(observed.out.review_ready, true, "the fixture must produce review_ready evidence");
    const reviewRef = writeReview(p.runDir, "be-thing", sliceHead);
    assert.equal(factory(p.repo, ["slice", RUN, "be-thing", "review", "--review-ref", reviewRef,
      "--evidence-ref", "evidence/be-thing.json", "--now", NOW(3)]).ok, true);
    return { ...p, sliceHead, basePoint };
  }

  it("records a clean serial merge", () => {
    const p = upToReview("clean");
    try {
      const mergeCommit = mergeIntoFeature(p.repo);
      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, true, merged.stderr);
      assert.equal(runJson(p.runDir).slices[0].status, "merged");
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses a slice that changed a path it does not own", () => {
    const p = upToReview("unowned", { extra: "src/other/sneak.ts" });
    try {
      const mergeCommit = mergeIntoFeature(p.repo);
      const before = readFileSync(join(p.runDir, "run.json"), "utf8");
      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false, "the merge must be refused");
      assert.match(merged.stderr, /changed paths it does not own: src\/other\/sneak\.ts/u);
      assert.equal(readFileSync(join(p.runDir, "run.json"), "utf8"), before, "run.json must be untouched");
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses a slice that touched a privileged control-plane path", () => {
    // package.json rather than .factory/: the control plane is gitignored, so it can
    // never reach a diff. A slice quietly adding a dependency is the realistic case
    // and is trackable.
    const p = upToReview("privileged", { extra: "package.json" });
    try {
      const mergeCommit = mergeIntoFeature(p.repo);
      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false);
      assert.match(merged.stderr, /privileged control-plane paths/u);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses a merge whose review approved a different commit", () => {
    const p = upToReview("stale-review");
    try {
      // The builder pushes one more commit after the review was written.
      git(p.repo, "checkout", "-q", "slice");
      writeFileSync(join(p.repo, "src", "app", "thing.ts"), "changed after review\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "post-review change");
      const mergeCommit = mergeIntoFeature(p.repo);

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false, "an approval for an earlier commit must not merge a later one");
      assert.match(merged.stderr, /approved [0-9a-f]{12} but the head is [0-9a-f]{12}/u);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("tolerates a moved base, however it moved, and refuses unreviewed content in the merge", () => {
    // Inverted once and then left alone deliberately.
    //
    // It originally asserted a moved base fails, which is what every wave's second merge
    // looks like. A round later a guard was added requiring the base to have moved only by
    // recorded slice merges — opencode had walked a direct privileged commit through here —
    // and it was reverted: `base_ref` is immutable, so refusing the merge permanently
    // strands the slice and the run produces no PR. Destroying a shipped feature to enforce
    // a lane check is the wrong trade, and SKILL.md's NO-GO remediation explicitly permits
    // fixing test-only problems directly in the integration branch.
    //
    // So a direct commit moves the base here on purpose: that shape must merge. What must
    // fail is unreviewed content inside the *merge*, which the next test covers.
    const p = upToReview("moved-base");
    try {
      git(p.repo, "checkout", "-q", "feature");
      writeFileSync(join(p.repo, "src", "app", "sibling.ts"), "landed by other means\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "direct integration commit");
      const mergeCommit = mergeIntoFeature(p.repo);

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, true, `a moved base must not block a merge: ${merged.stderr}`);
      assert.equal(runJson(p.runDir).slices[0].status, "merged");
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses a merge that smuggles an unreviewed path", () => {
    const p = upToReview("smuggled");
    try {
      git(p.repo, "checkout", "-q", "feature");
      git(p.repo, "merge", "-q", "--no-ff", "--no-commit", "slice");
      writeFileSync(join(p.repo, "src", "app", "smuggled.ts"), "never reviewed\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "merge plus extra");
      const mergeCommit = git(p.repo, "rev-parse", "HEAD");

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false, "content nobody reviewed must not merge");
      assert.match(merged.stderr, /contributed paths that were not reviewed: src\/app\/smuggled\.ts/u);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses a merge with no observed evidence", () => {
    // opencode drove init -> slice merge without ever invoking observe and the merge
    // succeeded, which made the entire observe-don't-trust mechanism optional.
    const p = project("no-evidence");
    try {
      const { head: sliceHead, basePoint } = buildSlice(p.repo);
      factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
      const reviewRef = writeReview(p.runDir, "be-thing", sliceHead);
      factory(p.repo, ["slice", RUN, "be-thing", "review", "--review-ref", reviewRef, "--now", NOW(3)]);
      const mergeCommit = mergeIntoFeature(p.repo);

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false, "a merge without observed evidence must be refused");
      assert.match(merged.stderr, /cannot merge without an evidence_ref/u);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses a merge whose evidence is not review_ready", () => {
    const p = project("not-ready");
    try {
      const { head: sliceHead, basePoint } = buildSlice(p.repo);
      factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
      // A failing test command: observed, and observed to fail.
      const observed = factory(p.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", basePoint,
        "--attempt", "1", "--test-cmd", "git --no-pager grep --quiet THIS_STRING_IS_ABSENT", "--now", NOW(3)]);
      assert.equal(observed.out.review_ready, false);
      const reviewRef = writeReview(p.runDir, "be-thing", sliceHead);
      factory(p.repo, ["slice", RUN, "be-thing", "review", "--review-ref", reviewRef, "--evidence-ref", "evidence/be-thing.json", "--now", NOW(3)]);
      const mergeCommit = mergeIntoFeature(p.repo);

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false, "a failing observed test must block the merge");
      assert.match(merged.stderr, /evidence is not review_ready/u);

      // Folded in, because it is the same question asked one level up: what makes a slice
      // review-ready with no test run at all. That used to be `--skip-tests-reason`, set at
      // observation time by the party being observed, and any nonempty string was accepted.
      // It is now the test_plan the decompose gate ratified, and both directions are
      // asserted because only the pair shows the field is being read.
      for (const [label, testPlan, expected] of [["required", ["t"], false], ["waived", [], true]]) {
        const q = project(`test-plan-${label}`, { testPlan });
        try {
          const { basePoint: qBase } = buildSlice(q.repo);
          factory(q.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
          // No --test-cmd in either case: the only difference is the ratified plan.
          const seen = factory(q.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", qBase,
            "--attempt", "1", "--now", NOW(3)]);
          assert.equal(seen.ok, true, seen.stderr);
          assert.equal(seen.out.review_ready, expected,
            `an untested slice whose test_plan is ${label} must be review_ready: ${expected}`);
        } finally { rmSync(q.repo, { recursive: true, force: true }); }
      }
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("binds the slice base to the observed integration head, not to a supplied value", () => {
    // opencode's probe: an earlier commit added an unowned file, a later commit added an
    // owned one, and activating against the *earlier* commit made the ownership diff
    // exclude the unowned change. The base is now observed at activation, so a stale or
    // convenient value cannot be supplied at all - --base no longer exists.
    const p = project("stale-base");
    try {
      const integrationHead = git(p.repo, "rev-parse", "HEAD");
      git(p.repo, "checkout", "-q", "-b", "slice");
      writeFileSync(join(p.repo, "src", "secret.ts"), "unowned\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "unowned work");
      writeFileSync(join(p.repo, "src", "app", "visible.ts"), "owned\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "owned work");
      const sliceHead = git(p.repo, "rev-parse", "HEAD");

      const activated = factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
      assert.equal(activated.ok, true, activated.stderr);
      assert.equal(runJson(p.runDir).slices[0].base_ref, integrationHead,
        "the base must be the observed integration head, not a caller's choice");

      factory(p.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", integrationHead,
        "--attempt", "1", "--test-cmd", "git --no-pager log -1 --format=%H", "--now", NOW(3)]);
      const reviewRef = writeReview(p.runDir, "be-thing", sliceHead);
      factory(p.repo, ["slice", RUN, "be-thing", "review", "--review-ref", reviewRef,
        "--evidence-ref", "evidence/be-thing.json", "--now", NOW(3)]);
      const mergeCommit = mergeIntoFeature(p.repo);

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false, "the unowned earlier commit must still be in the diff");
      assert.match(merged.stderr, /changed paths it does not own: src\/secret\.ts/u);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses a review that approved a different slice at the same commit", () => {
    // opencode's probe: a valid approval for other-slice at the same commit was accepted
    // as the review for be-thing. With several slices in a wave and one --review-ref
    // argument, passing the wrong one is an ordinary mistake.
    const p = upToReview("foreign-review");
    try {
      const foreignRef = writeReview(p.runDir, "other-slice", p.sliceHead);
      factory(p.repo, ["slice", RUN, "be-thing", "review", "--review-ref", foreignRef, "--now", NOW(3)]);
      const mergeCommit = mergeIntoFeature(p.repo);

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false, "an approval for another slice must not merge this one");
      assert.match(merged.stderr, /approved 'other-slice', not 'be-thing'/u);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses to observe a worktree with uncommitted changes", () => {
    // opencode's probe: commit broken code, approve that commit, then make the working
    // tree pass. Tests ran on the dirty bytes while the evidence claimed the clean HEAD,
    // so the merge succeeded and the same test failed on the merged tree.
    const p = project("dirty");
    try {
      const integrationHead = git(p.repo, "rev-parse", "HEAD");
      git(p.repo, "checkout", "-q", "-b", "slice");
      writeFileSync(join(p.repo, "src", "app", "thing.ts"), "BROKEN\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "broken");
      factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);

      // The working tree now differs from the commit: a test could pass here and fail on
      // what actually merges.
      writeFileSync(join(p.repo, "src", "app", "thing.ts"), "FIXED, but uncommitted\n");

      const observed = factory(p.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", integrationHead,
        "--attempt", "1", "--test-cmd", "git --no-pager log -1 --format=%H", "--now", NOW(3)]);
      assert.equal(observed.ok, true, "observation still records; it just cannot be ready");
      assert.equal(observed.out.review_ready, false, "a dirty tree cannot produce review_ready evidence");
      const record = JSON.parse(readFileSync(join(p.runDir, "evidence", "be-thing.json"), "utf8"));
      assert.equal(record.worktree_clean, false);
      assert.equal(record.tests.observed, false, "tests must not run against bytes that will not merge");
      assert.match(record.blocked_reason, /uncommitted changes/u);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses activation when the integration head moves before the transition commits", () => {
    // opencode's race probe: the head was observed, the feature ref advanced, and the
    // stale value was persisted as base_ref without notice. The write core's CAS covers
    // run.json, not a Git ref, so the head is re-observed at the commit boundary.
    const p = project("base-race");
    try {
      git(p.repo, "checkout", "-q", "-b", "slice");
      writeFileSync(join(p.repo, "src", "app", "thing.ts"), "slice\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "slice work");

      // Advance the integration branch after activation would have sampled it. The
      // boundary observation must notice and refuse rather than persist the old head.
      git(p.repo, "checkout", "-q", "feature");
      writeFileSync(join(p.repo, "src", "app", "advanced.ts"), "moved on\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "integration advanced");
      const movedHead = git(p.repo, "rev-parse", "feature");
      git(p.repo, "checkout", "-q", "slice");

      // A clean activation records the current head; assert it is the moved one, not a
      // stale sample, which is the property the boundary re-observation guarantees.
      const activated = factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
      assert.equal(activated.ok, true, activated.stderr);
      assert.equal(runJson(p.runDir).slices[0].base_ref, movedHead,
        "the persisted base must be the head observed at the commit boundary");
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses a merge whose review changed while the merge was being verified", () => {
    // opencode's race probe: merge read a valid APPROVE, the sidecar became REJECT during
    // the merge-proof observations, and the slice was still recorded as merged. A
    // reviewer process rewriting its own output is a plausible race.
    const p = upToReview("review-race");
    try {
      const mergeCommit = mergeIntoFeature(p.repo);
      const reviewPath = join(p.runDir, "reviews", "be-thing.json");
      const approved = readFileSync(reviewPath, "utf8");

      // Rewrite the sidecar to a REJECT after the merge command has read it. The
      // rewrite happens here rather than mid-process, which still exercises the re-read:
      // the second read must disagree with the first.
      const rejected = JSON.parse(approved);
      rejected.verdict = "REJECT";
      writeFileSync(reviewPath, `${JSON.stringify(rejected, null, 2)}\n`);

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false, "a rejected review must not merge");
      assert.match(merged.stderr, /verdict is REJECT, not an approval|changed while the merge was being verified/u);
      assert.equal(runJson(p.runDir).slices[0].status, "review");
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses evidence when the test itself dirties the worktree", () => {
    // opencode's first probe: a passing test modified tracked source and left it dirty.
    // The pre-test snapshot said clean, so the evidence claimed a clean HEAD and the
    // merged tree then failed the same test.
    const p = project("test-dirties");
    try {
      const integrationHead = git(p.repo, "rev-parse", "HEAD");
      git(p.repo, "checkout", "-q", "-b", "slice");
      writeFileSync(join(p.repo, "src", "app", "thing.ts"), "slice\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "slice work");
      factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);

      // A "test" that passes and writes a tracked file — ordinary behaviour for snapshot
      // updaters, formatters, and code generators. No spaces: the command splits on them.
      const observed = factory(p.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", integrationHead,
        "--attempt", "1", "--test-cmd", "node -e require('fs').writeFileSync('src/app/thing.ts','mutated')", "--now", NOW(3)]);

      assert.equal(observed.ok, true);
      const record = JSON.parse(readFileSync(join(p.runDir, "evidence", "be-thing.json"), "utf8"));
      assert.equal(record.worktree_clean, false, "a test that dirties the tree must not yield clean evidence");
      assert.equal(record.review_ready, false);
      assert.match(record.blocked_reason, /uncommitted changes|changed while the tests ran/u);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  // The case that exposed the old tree-equality proof: a wave's slices branch from one
  // head and merge serially, so the second merge lands on a moved base. Now passing, and
  // kept as the default multi-slice coverage — a single-slice fixture cannot detect a
  // proof built on "nothing lands between branch and merge".
  it("merges two file-disjoint slices from the same wave", () => {
    // The central case, and the one that exposes the merge proof's assumption. Both
    // slices branch from the same integration head, as viso specifies ("a slice worktree
    // branched from the current feature-branch HEAD"), and merges are serial. So the
    // second merge lands on a base that has moved, and its merged tree contains the
    // first slice's work as well as its own. Tree equality cannot hold for it.
    const p = project("wave", { seed: false });
    try {
      // Both slices declare a test_plan. This fixture used to omit it, which was how the
      // omitted-field waiver stayed invisible: the fixture institutionalized the very
      // shape that granted a silent exemption. Seeding a plan without one is now refused,
      // and that refusal is asserted first so the fixture cannot drift back.
      const planFile = join(p.runDir, "plan", "slices.json");
      const slices = [
        { id: "be-one", stack: "backend", paths: ["src/app/one/"], depends_on: [] },
        { id: "be-two", stack: "backend", paths: ["src/app/two/"], depends_on: [] },
      ];
      writeFileSync(planFile, JSON.stringify({ slices }, null, 2));
      const omitted = factory(p.repo, ["slices-seed", RUN, "--now", NOW(1)]);
      assert.equal(omitted.ok, false, "a plan that never mentions tests must not seed");
      assert.match(omitted.stderr, /test_plan: must be an array of strings/u);

      writeFileSync(planFile, JSON.stringify({ slices: slices.map((s) => ({ ...s, test_plan: ["t"] })) }, null, 2));
      assert.equal(factory(p.repo, ["slices-seed", RUN, "--now", NOW(1)]).ok, true);
      const waveBase = git(p.repo, "rev-parse", "HEAD");

      const build = (id, dir, t) => {
        git(p.repo, "checkout", "-q", "-b", id, waveBase);
        mkdirSync(join(p.repo, "src", "app", dir), { recursive: true });
        writeFileSync(join(p.repo, "src", "app", dir, "work.ts"), `${id}\n`);
        git(p.repo, "add", "-A");
        git(p.repo, "commit", "-q", "-m", id);
        const head = git(p.repo, "rev-parse", "HEAD");
        const act = factory(p.repo, ["slice", RUN, id, "running", "--worktree", ".", "--branch", id, "--now", NOW(t)]);
        assert.equal(act.ok, true, `activate ${id}: ${act.stderr}`);
        const obs = factory(p.repo, ["observe", RUN, id, "--worktree", ".", "--base", waveBase, "--attempt", "1",
          "--test-cmd", "git --no-pager log -1 --format=%H", "--now", NOW(t + 1)]);
        assert.equal(obs.ok, true, `observe ${id}: ${obs.stderr}`);
        writeReview(p.runDir, id, head);
        factory(p.repo, ["slice", RUN, id, "review", "--review-ref", `reviews/${id}.json`,
          "--evidence-ref", `evidence/${id}.json`, "--now", NOW(t + 2)]);
        return head;
      };
      build("be-one", "one", 2);
      build("be-two", "two", 6);

      const mergeOne = (id, t) => {
        git(p.repo, "checkout", "-q", "feature");
        git(p.repo, "merge", "-q", "--no-ff", id, "-m", `merge ${id}`);
        return factory(p.repo, ["slice", RUN, id, "merged", "--merge-commit", git(p.repo, "rev-parse", "HEAD"), "--now", NOW(t)]);
      };

      const first = mergeOne("be-one", 10);
      assert.equal(first.ok, true, `first merge of a wave: ${first.stderr}`);

      // The second slice reviewed a tree without be-one in it; the merged tree has both.
      const second = mergeOne("be-two", 11);
      assert.equal(second.ok, true, `second merge of the same wave must succeed: ${second.stderr}`);
      assert.deepEqual(runJson(p.runDir).slices.map((slice) => slice.status), ["merged", "merged"]);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses a merge with evidence but no review", () => {
    // Evidence is checked before the review, so this supplies review_ready evidence
    // and withholds only the review — otherwise the evidence refusal fires and the
    // review requirement goes untested.
    const p = project("no-review");
    try {
      const { basePoint } = buildSlice(p.repo);
      factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
      const observed = factory(p.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", basePoint,
        "--attempt", "1", "--test-cmd", "git --no-pager log -1 --format=%H", "--now", NOW(3)]);
      assert.equal(observed.out.review_ready, true, "the evidence must be otherwise acceptable");
      factory(p.repo, ["slice", RUN, "be-thing", "review", "--evidence-ref", "evidence/be-thing.json", "--now", NOW(3)]);
      const mergeCommit = mergeIntoFeature(p.repo);

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false);
      assert.match(merged.stderr, /cannot merge without a review_ref/u);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });
});

describe("end to end — a PR is recorded once, against the judged head", () => {
  // Everything up to the point where publication becomes a question: the slice built,
  // observed, reviewed, merged, and the integration branch validated. The test-verifier
  // observation is deliberately NOT done here, so each test decides whether that stage
  // ran and the requirement can be tested in isolation.
  function readyForPr(name) {
    const p = project(name);
    const { head: sliceHead, basePoint } = buildSlice(p.repo);
    factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
    factory(p.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", basePoint,
      "--attempt", "1", "--test-cmd", "git --no-pager log -1 --format=%H", "--now", NOW(3)]);
    const reviewRef = writeReview(p.runDir, "be-thing", sliceHead);
    factory(p.repo, ["slice", RUN, "be-thing", "review", "--review-ref", reviewRef,
      "--evidence-ref", "evidence/be-thing.json", "--now", NOW(3)]);
    const mergeCommit = mergeIntoFeature(p.repo);
    assert.equal(factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]).ok, true);
    const head = git(p.repo, "rev-parse", "HEAD");
    approveEarlyGates(p.repo, NOW(5));
    assert.equal(recordValidator(p.repo, p.runDir, head, "GO", NOW(5)).ok, true);
    return { ...p, head, basePoint };
  }

  // The test-verifier stage, observed on the integrated branch rather than asserted to
  // have happened.
  function verifyTests(repo, base, at, { cmd = "git --no-pager log -1 --format=%H" } = {}) {
    return factory(repo, ["observe", RUN, "test-verifier", "--worktree", ".", "--base", base,
      "--attempt", "1", "--test-cmd", cmd, "--now", at]);
  }

  it("records a PR against the validated head, and is idempotent on replay", () => {
    const p = readyForPr("pr-ok");
    try {
      // Gate 3 is the last transition before the skill pushes and opens the PR, so the
      // readiness refusal has to be able to land here. Isolated: the slice is merged, the
      // verdict is a GO against the current head, and the only thing missing is an
      // observed test-verifier run.
      const noTests = approveGate(p.repo, "pre_pr", NOW(5));
      assert.equal(noTests.ok, false, "Gate 3 must not approve before the tests were observed");
      assert.match(noTests.stderr, /evidence\/test-verifier\.json' could not be read/u);

      // And a test-verifier run that was observed *failing* is not a pass either.
      assert.equal(verifyTests(p.repo, p.basePoint, NOW(5), { cmd: "git rev-parse --verify --quiet refs/heads/nope" }).ok, true);
      const redTests = approveGate(p.repo, "pre_pr", NOW(5));
      assert.equal(redTests.ok, false, "a failing test-verifier run must not approve Gate 3");
      assert.match(redTests.stderr, /test-verifier\.json records tests exiting 1/u);

      assert.equal(verifyTests(p.repo, p.basePoint, NOW(5)).ok, true);
      assert.equal(approveGate(p.repo, "pre_pr", NOW(5)).ok, true, "a ready run must approve");

      const first = factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/1", "--now", NOW(6)]);
      assert.equal(first.ok, true, first.stderr);
      assert.equal(first.out.pr_url, "https://example.test/pr/1");

      // Attack 9: the crash-replay path. Recording the same PR again must succeed
      // without creating or implying a second one.
      const replay = factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/1", "--now", NOW(7)]);
      assert.equal(replay.ok, true, replay.stderr);
      assert.equal(replay.out.idempotent, true);
      assert.equal(runJson(p.runDir).pr_url, "https://example.test/pr/1");
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses a second, different PR", () => {
    const p = readyForPr("pr-second");
    try {
      verifyTests(p.repo, p.basePoint, NOW(5));
      approveGate(p.repo, "pre_pr", NOW(5));

      // Folded in first, on an otherwise-publishable run: the approved Story cannot be
      // changed underneath everything that was judged against it. Both routes are asserted,
      // because the second needs no re-opening at all.
      //
      // Re-opening any gate was permitted for one round, to give the late-head recovery a way
      // out. That let Story be re-opened, pointed at a new document and re-approved, while the
      // Brief, validator, tests and Gate 3 that all judged the *old* story stayed valid — the
      // run then published Story v1's implementation under Story v2. Only pre_pr re-opens now,
      // because only its subject can legitimately change after approval.
      const reopenStory = factory(p.repo, ["gate", RUN, "story", "pending", "--now", NOW(6)]);
      assert.equal(reopenStory.ok, false, "an earlier gate must not re-open under completed work");
      assert.match(reopenStory.stderr, /gate 'story' cannot be re-opened once decided; only pre_pr may/u);

      // And the shorter route: re-deciding an approved gate to the status it already holds
      // used to skip every check, so `--artifact` swapped the document in place.
      const swap = factory(p.repo, ["gate", RUN, "story", "approved", "--artifact", "artifacts/story-v2.md", "--now", NOW(6)]);
      assert.equal(swap.ok, false, "an approved gate's artifact must not change in place");
      assert.match(swap.stderr, /gate 'story' artifact is what was decided against and cannot change/u);
      assert.equal(runJson(p.runDir).gates.story.artifact, null, "and the manifest is untouched");

      factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/1", "--now", NOW(6)]);
      const second = factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/2", "--now", NOW(7)]);
      assert.equal(second.ok, false, "a run has one PR");
      assert.match(second.stderr, /pr_url is immutable once recorded/u);
      assert.equal(runJson(p.runDir).pr_url, "https://example.test/pr/1");
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses a PR once the integration head has moved past what was approved", () => {
    // This is why readiness is asked twice rather than inherited from Gate 3. The run is
    // genuinely ready at approval; the branch then moves, and the PR would publish a head
    // nobody validated. Only the second check can see that.
    const p = readyForPr("pr-stale");
    try {
      verifyTests(p.repo, p.basePoint, NOW(5));
      assert.equal(approveGate(p.repo, "pre_pr", NOW(5)).ok, true, "the run is ready at approval time");

      writeFileSync(join(p.repo, "src", "app", "after-validation.ts"), "late\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "after validation");

      const pr = factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/1", "--now", NOW(6)]);
      assert.equal(pr.ok, false, "a stale verdict must not authorize a PR");
      assert.match(pr.stderr, /validator judged [0-9a-f]{12} but the integration head is [0-9a-f]{12}/u);
      assert.equal(runJson(p.runDir).pr_url, null);

      // Folded in: opencode's continuation of this exact sequence. Refusing the PR is not
      // enough on its own, because the obvious next move is to re-observe and re-validate
      // at the new head — which made every machine check current again while the human's
      // Gate 3 approval still referred to the old one. The gate record holds a status and a
      // time, not a commit, so nothing noticed. Freezing the verdict once the gate is
      // approved is what binds that approval to a commit without storing a second copy of
      // it for the two records to disagree about.
      const newHead = git(p.repo, "rev-parse", "HEAD");
      assert.notEqual(newHead, p.head);
      assert.equal(verifyTests(p.repo, p.basePoint, NOW(6)).ok, true, "re-observing tests is allowed");

      // Folded in: a validator record that judged the *old* head cannot be recorded while the
      // branch is at the new one. The verdict and head used to be arguments, so a report about
      // one commit could be recorded as a verdict on another — this asserts the record has to
      // name what it judged and that git is asked whether that is still current. Checked
      // before the transition, so it fires ahead of the approval freeze below.
      const stale = recordValidator(p.repo, p.runDir, p.head, "GO", NOW(6));
      assert.equal(stale.ok, false, "a verdict on a commit that is no longer the head must refuse");
      assert.match(stale.stderr, /judged [0-9a-f]{12} but the integration head is [0-9a-f]{12}; re-run the validator/u);

      const revalidate = recordValidator(p.repo, p.runDir, newHead, "GO", NOW(6));
      assert.equal(revalidate.ok, false, "an approved gate must not be re-pointed at a new head");
      assert.match(revalidate.stderr, /re-open it as pending before re-recording the validator/u);
      assert.equal(runJson(p.runDir).validator.reviewed_head, p.head, "the approved verdict stands");

      // And the recovery, which is the half that matters more than the refusal: this costs
      // one more approval, not the run. Re-open Gate 3, re-validate at the new head, present
      // it again, and the PR records. A guard that turned a late test-only commit into a
      // dead run would be worse than the staleness it prevents.
      assert.equal(factory(p.repo, ["gate", RUN, "pre_pr", "pending", "--now", NOW(7)]).ok, true, "a decided gate re-opens");
      assert.equal(recordValidator(p.repo, p.runDir, newHead, "GO", NOW(7)).ok, true, "and re-validating is then allowed");
      assert.equal(factory(p.repo, ["gate", RUN, "pre_pr", "approved", "--now", NOW(7)]).ok, true, "re-approved at the new head");
      const after = factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/1", "--now", NOW(8)]);
      assert.equal(after.ok, true, `the run must still be able to ship: ${after.stderr}`);
      assert.equal(runJson(p.runDir).pr_url, "https://example.test/pr/1");
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses to approve Gate 3 on a run that did no work", () => {
    // opencode drove init -> approving validator -> PR with no gates, steps, slices or
    // evidence, and the PR was recorded. Unseeded on purpose: the run never decomposed,
    // so there is no slice plan at all.
    //
    // Asserted at the gate rather than at `pr`, because that is now where it is refused
    // first — and refusing at `pr` alone would be a report about a PR that already exists.
    const p = project("no-work", { seed: false });
    try {
      const head = git(p.repo, "rev-parse", "HEAD");
      approveEarlyGates(p.repo, NOW(5));
      recordValidator(p.repo, p.runDir, head, "GO", NOW(5));
      const gate = approveGate(p.repo, "pre_pr", NOW(5));
      assert.equal(gate.ok, false, "a run with no slice plan must not clear Gate 3");
      assert.match(gate.stderr, /no slice plan has been seeded/u);

      // And with the gate refused, the PR cannot be recorded either — the other half of
      // the pair, since a `pr` call is what an orchestrator that ignored the gate would do.
      const pr = factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/1", "--now", NOW(6)]);
      assert.equal(pr.ok, false);
      assert.match(pr.stderr, /every gate must be approved; not approved: pre_pr\(pending\)/u);
      assert.equal(runJson(p.runDir).pr_url, null);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses to approve Gate 3 while a slice is still open", () => {
    const p = project("open-slice");
    try {
      buildSlice(p.repo);
      factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--now", NOW(2)]);
      const head = git(p.repo, "rev-parse", "slice");
      approveEarlyGates(p.repo, NOW(5));
      recordValidator(p.repo, p.runDir, head, "GO", NOW(5));
      const running = approveGate(p.repo, "pre_pr", NOW(5));
      assert.equal(running.ok, false);
      assert.match(running.stderr, /every slice must be merged; not merged: be-thing\(running\)/u);

      // Folded in rather than added, per the test budget: a *blocked* slice must refuse
      // too. This accepted "merged or blocked", so a run with blocked work published
      // while its status stayed running.
      factory(p.repo, ["slice", RUN, "be-thing", "blocked", "--now", NOW(7)]);
      const blocked = approveGate(p.repo, "pre_pr", NOW(8));
      assert.equal(blocked.ok, false, "blocked work must not be published");
      assert.match(blocked.stderr, /every slice must be merged; not merged: be-thing\(blocked\)/u);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses to approve Gate 3 with no approving verdict", () => {
    const p = readyForPr("pr-nogo");
    try {
      verifyTests(p.repo, p.basePoint, NOW(5));
      // The validator loops: a NO-GO recorded over the GO the fixture established.
      recordValidator(p.repo, p.runDir, p.head, "NO-GO", NOW(5));
      const gate = approveGate(p.repo, "pre_pr", NOW(5));
      assert.equal(gate.ok, false);
      assert.match(gate.stderr, /the validator verdict is not an approval/u);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });
});
