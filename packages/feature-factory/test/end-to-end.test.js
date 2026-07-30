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
function project(name, { seed = true } = {}) {
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
  writeFileSync(join(repo, ".gitignore"), ".claude/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");

  const runDir = join(repo, ".claude", "factory", RUN);
  const init = factory(repo, ["init", RUN, "--branch", "feature", "--worktree", ".", "--now", NOW(0)]);
  assert.equal(init.ok, true, init.stderr);
  writeFileSync(join(runDir, "plan", "slices.json"), JSON.stringify({
    slices: [{ id: "be-thing", stack: "backend", paths: ["src/app/"], depends_on: [], acceptance: ["AC1"], test_plan: ["t"] }],
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

function mergeIntoFeature(repo) {
  git(repo, "checkout", "-q", "feature");
  git(repo, "merge", "-q", "--no-ff", "slice", "-m", "merge slice");
  return git(repo, "rev-parse", "HEAD");
}

const runJson = (runDir) => JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));

function approveGate(repo, name, at) {
  factory(repo, ["gate", RUN, name, "pending", "--now", at]);
  return factory(repo, ["gate", RUN, name, "approved", "--now", at]);
}

describe("end to end — a merge is refused through the real CLI", () => {
  function upToReview(name, buildOptions) {
    const p = project(name);
    const { head: sliceHead, basePoint } = buildSlice(p.repo, buildOptions);
    assert.equal(factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--base", basePoint, "--now", NOW(2)]).ok, true);
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
    // package.json rather than .claude/: the control plane is gitignored, so it can
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

  it("refuses a merge whose tree nobody reviewed", () => {
    const p = upToReview("drift");
    try {
      // Concurrent work lands on the integration branch first: the seriality
      // violation. Ancestry still holds, the tree does not.
      git(p.repo, "checkout", "-q", "feature");
      writeFileSync(join(p.repo, "src", "app", "concurrent.ts"), "unreviewed\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "concurrent");
      const mergeCommit = mergeIntoFeature(p.repo);

      const merged = factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]);
      assert.equal(merged.ok, false);
      assert.match(merged.stderr, /merged tree differs from the reviewed tree/u);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses a merge with no observed evidence", () => {
    // opencode drove init -> slice merge without ever invoking observe and the merge
    // succeeded, which made the entire observe-don't-trust mechanism optional.
    const p = project("no-evidence");
    try {
      const { head: sliceHead, basePoint } = buildSlice(p.repo);
      factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--base", basePoint, "--now", NOW(2)]);
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
      factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--base", basePoint, "--now", NOW(2)]);
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
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses a merge with evidence but no review", () => {
    // Evidence is checked before the review, so this supplies review_ready evidence
    // and withholds only the review — otherwise the evidence refusal fires and the
    // review requirement goes untested.
    const p = project("no-review");
    try {
      const { basePoint } = buildSlice(p.repo);
      factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--base", basePoint, "--now", NOW(2)]);
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
  function readyForPr(name) {
    const p = project(name);
    const { head: sliceHead, basePoint } = buildSlice(p.repo);
    factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--base", basePoint, "--now", NOW(2)]);
    factory(p.repo, ["observe", RUN, "be-thing", "--worktree", ".", "--base", basePoint,
      "--attempt", "1", "--test-cmd", "git --no-pager log -1 --format=%H", "--now", NOW(3)]);
    const reviewRef = writeReview(p.runDir, "be-thing", sliceHead);
    factory(p.repo, ["slice", RUN, "be-thing", "review", "--review-ref", reviewRef,
      "--evidence-ref", "evidence/be-thing.json", "--now", NOW(3)]);
    const mergeCommit = mergeIntoFeature(p.repo);
    assert.equal(factory(p.repo, ["slice", RUN, "be-thing", "merged", "--merge-commit", mergeCommit, "--now", NOW(4)]).ok, true);
    return { ...p, head: git(p.repo, "rev-parse", "HEAD") };
  }

  it("records a PR against the validated head, and is idempotent on replay", () => {
    const p = readyForPr("pr-ok");
    try {
      approveGate(p.repo, "pre_pr", NOW(5));
      assert.equal(factory(p.repo, ["validator", RUN, "GO", "--report", "artifacts/validation-report.md", "--reviewed-head", p.head, "--now", NOW(5)]).ok, true);
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
      approveGate(p.repo, "pre_pr", NOW(5));
      factory(p.repo, ["validator", RUN, "GO", "--report", "artifacts/validation-report.md", "--reviewed-head", p.head, "--now", NOW(5)]);
      factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/1", "--now", NOW(6)]);
      const second = factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/2", "--now", NOW(7)]);
      assert.equal(second.ok, false, "a run has one PR");
      assert.match(second.stderr, /pr_url is immutable once recorded/u);
      assert.equal(runJson(p.runDir).pr_url, "https://example.test/pr/1");
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses a PR once the integration head has moved past what was validated", () => {
    const p = readyForPr("pr-stale");
    try {
      approveGate(p.repo, "pre_pr", NOW(5));
      factory(p.repo, ["validator", RUN, "GO", "--report", "artifacts/validation-report.md", "--reviewed-head", p.head, "--now", NOW(5)]);
      // Something lands after validation. The verdict no longer describes the branch.
      writeFileSync(join(p.repo, "src", "app", "after-validation.ts"), "late\n");
      git(p.repo, "add", "-A");
      git(p.repo, "commit", "-q", "-m", "after validation");

      const pr = factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/1", "--now", NOW(6)]);
      assert.equal(pr.ok, false, "a stale verdict must not authorize a PR");
      assert.match(pr.stderr, /validator judged [0-9a-f]{12} but the integration head is [0-9a-f]{12}/u);
      assert.equal(runJson(p.runDir).pr_url, null);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses a PR on a run that did no work", () => {
    // opencode drove init -> approving validator -> PR with no gates, steps, slices
    // or evidence, and the PR was recorded.
    // Unseeded on purpose: the run never decomposed, so there is no slice plan at all.
    const p = project("no-work", { seed: false });
    try {
      const head = git(p.repo, "rev-parse", "HEAD");
      // Approve pre_pr and record a GO so neither of those can be the refusal: the
      // only thing missing is that the run never decomposed or built anything.
      approveGate(p.repo, "pre_pr", NOW(5));
      factory(p.repo, ["validator", RUN, "GO", "--report", "artifacts/validation-report.md", "--reviewed-head", head, "--now", NOW(5)]);
      const pr = factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/1", "--now", NOW(6)]);
      assert.equal(pr.ok, false, "a run with no slice plan must not produce a PR");
      assert.match(pr.stderr, /requires a seeded slice plan/u);
      assert.equal(runJson(p.runDir).pr_url, null);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses a PR while a slice is still open", () => {
    const p = project("open-slice");
    try {
      const { basePoint } = buildSlice(p.repo);
      factory(p.repo, ["slice", RUN, "be-thing", "running", "--worktree", ".", "--branch", "slice", "--base", basePoint, "--now", NOW(2)]);
      const head = git(p.repo, "rev-parse", "slice");
      approveGate(p.repo, "pre_pr", NOW(5));
      factory(p.repo, ["validator", RUN, "GO", "--report", "artifacts/validation-report.md", "--reviewed-head", head, "--now", NOW(5)]);
      const pr = factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/1", "--now", NOW(6)]);
      assert.equal(pr.ok, false);
      assert.match(pr.stderr, /every slice merged or blocked; open: be-thing/u);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });

  it("refuses a PR with no approving verdict", () => {
    const p = readyForPr("pr-nogo");
    try {
      approveGate(p.repo, "pre_pr", NOW(5));
      factory(p.repo, ["validator", RUN, "NO-GO", "--report", "artifacts/validation-report.md", "--reviewed-head", p.head, "--now", NOW(5)]);
      const pr = factory(p.repo, ["pr", RUN, "--url", "https://example.test/pr/1", "--now", NOW(6)]);
      assert.equal(pr.ok, false);
      assert.match(pr.stderr, /requires an approving validator verdict/u);
    } finally { rmSync(p.repo, { recursive: true, force: true }); }
  });
});
