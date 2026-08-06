// Attacks 1, 5 and 7, against real git repositories.
//
// Every test here is paired with a falsification recorded in the commit message:
// removing the guard under test must fail the test. A test that passes with its
// guard removed is documentation, not evidence.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEvidence, deriveReviewReady, observeAncestry, observeWorktree,
  privilegedPaths, reconcileClaim, unownedPaths,
} from "../observe/index.js";

const run = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// A real repository with a base commit and a slice branch on top.
function repo(name, { files = { "src/app/thing.ts": "export const a = 1;\n" } } = {}) {
  const root = mkdtempSync(join(tmpdir(), `ff-obs-${name}-`));
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.email", "t@example.com");
  run(root, "config", "user.name", "T");
  mkdirSync(join(root, "src", "app"), { recursive: true });
  writeFileSync(join(root, "README.md"), "base\n");
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "base");
  const base = run(root, "rev-parse", "HEAD");

  run(root, "checkout", "-q", "-b", "slice");
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, path, "..").replace(/\/\.\.$/u, ""), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "slice work");
  return { root, base, head: run(root, "rev-parse", "HEAD") };
}

describe("attack 1 — an agent claims a test pass that never ran", () => {
  it("records the observed exit code, not the claimed one, and refuses review_ready", () => {
    const f = repo("claim");
    try {
      // The builder claims a green run. The real command exits 1.
      const claim = { status: "completed", commit: f.head, files_changed: ["src/app/thing.ts"], tests: { exit: 0 } };
      const evidence = buildEvidence({
        subject: "be-thing", attempt: 1, branch: "slice", baseRef: f.base, worktree: f.root,
        status: "completed", claim,
        testCommand: ["git", "--no-pager", "grep", "--quiet", "THIS_STRING_IS_ABSENT"],
      });

      assert.equal(evidence.tests.observed, true, "the command must actually have been run");
      assert.notEqual(evidence.tests.exit, 0, "the observed exit code must be the failing one");
      assert.equal(evidence.review_ready, false, "a failing observed test cannot be review-ready");
      const fields = evidence.claim_reconciliation.mismatches.map((entry) => entry.field);
      assert.ok(fields.includes("tests.exit"), `the claim/observation disagreement must be recorded, got ${JSON.stringify(fields)}`);

      const shellCommand = "FACTORY_VALUE='two words' && test \"$FACTORY_VALUE\" = 'two words' && test -f src/app/thing.ts && exit 23";
      const shellEvidence = buildEvidence({
        subject: "test-verifier", runId: "app-1", attempt: 1, branch: "slice", baseRef: f.base,
        worktree: f.root, status: "completed", testCommand: shellCommand, shellCommand: true,
      });
      assert.deepEqual(Object.keys(shellEvidence.tests).sort(), ["cmd", "exit", "observed", "skipped_reason"]);
      assert.equal(shellEvidence.tests.cmd, shellCommand);
      assert.equal(shellEvidence.tests.exit, 23);
      assert.equal(shellEvidence.tests.observed, true);
      assert.equal(shellEvidence.review_ready, false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("is review-ready when the observed run actually passes", () => {
    const f = repo("claim-ok");
    try {
      const evidence = buildEvidence({
        subject: "be-thing", attempt: 1, branch: "slice", baseRef: f.base, worktree: f.root,
        status: "completed", testCommand: ["git", "--no-pager", "log", "-1", "--format=%H"],
      });
      assert.equal(evidence.tests.exit, 0);
      assert.equal(evidence.review_ready, true);
      assert.deepEqual(evidence.claim_reconciliation, { claimed: false, mismatches: [] });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("refuses review_ready when no test command was given at all", () => {
    // The skip escape hatch used to populate its own precondition: runTests defaulted
    // skipped_reason to "no test command declared", and any nonempty reason satisfies
    // deriveReviewReady, so omitting --test-cmd manufactured a pass. An omission is not
    // an explicit skip.
    const f = repo("no-test-cmd");
    try {
      const omitted = buildEvidence({
        subject: "be-thing", runId: "app-1", attempt: 1, branch: "slice", baseRef: f.base,
        worktree: f.root, status: "completed", testCommand: null,
      });
      assert.equal(omitted.tests.skipped_reason, null, "an omission records no reason");
      assert.equal(omitted.review_ready, false, "omitting the test command must not produce review_ready");

      // A declared skip still works, because that is a decision somebody made.
      const declared = buildEvidence({
        subject: "be-thing", runId: "app-1", attempt: 1, branch: "slice", baseRef: f.base,
        worktree: f.root, status: "completed", testCommand: null,
        skipReason: "no backend tests for a docs-only slice",
      });
      assert.equal(declared.review_ready, true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("refuses review_ready for an unobserved test with no recorded reason", () => {
    const base = {
      status: "completed", files_changed: ["a.ts"], diff_observed: true, worktree_clean: true,
      tests: { cmd: null, exit: null, observed: false, skipped_reason: null },
    };
    assert.equal(deriveReviewReady(base), false, "an unexplained absent test run is the shape a fabricated pass takes");
    assert.equal(deriveReviewReady({ ...base, tests: { ...base.tests, skipped_reason: "no backend tests for a docs slice" } }), true);
    // Isolate the diff_observed guard: passing observed tests, non-empty files, so
    // nothing else can be responsible for the refusal.
    const green = { ...base, tests: { cmd: "npm test", exit: 0, observed: true, skipped_reason: null } };
    assert.equal(deriveReviewReady(green), true, "the isolating fixture must otherwise be review-ready");
    assert.equal(deriveReviewReady({ ...green, diff_observed: false }), false, "an unobserved diff cannot be review-ready");
    assert.equal(deriveReviewReady({ ...base, files_changed: [] }), false, "an empty diff cannot be review-ready");
    assert.equal(deriveReviewReady({ ...base, status: "blocked" }), false);
    // A dirty tree cannot produce evidence about the commit it claims, whatever the
    // tests said: the bytes tested are not the bytes that merge.
    assert.equal(deriveReviewReady({ ...green, worktree_clean: false }), false);
  });

  it("refuses review_ready on a claim mismatch even when the observed run passes", () => {
    // Isolates the mismatch guard. Everything else here is green: the tests pass,
    // the diff is observed, the file list is non-empty. Only the disagreement
    // between the claim and the observation can make this not review-ready, so
    // removing that guard must fail this test.
    const f = repo("mismatch-only");
    try {
      const evidence = buildEvidence({
        subject: "be-thing", attempt: 1, branch: "slice", baseRef: f.base, worktree: f.root,
        status: "completed",
        testCommand: ["git", "--no-pager", "log", "-1", "--format=%H"],
        claim: { files_changed: ["src/app/thing.ts", "src/invented/extra.ts"] },
      });

      assert.equal(evidence.tests.exit, 0, "the observed run must pass, so it cannot be what blocks review");
      assert.equal(evidence.diff_observed, true);
      assert.ok(evidence.files_changed.length > 0);
      assert.deepEqual(evidence.claim_reconciliation.mismatches.map((entry) => entry.field), ["files_changed"]);
      assert.equal(evidence.review_ready, false, "a claim that disagrees with observation cannot be review-ready");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("records a claimed file list that disagrees with the observed one", () => {
    const observation = { commit: "a".repeat(40), files_changed: ["src/a.ts"], status: "completed", tests: { exit: 0 } };
    const { mismatches } = reconcileClaim({ files_changed: ["src/a.ts", "src/b.ts"] }, observation);
    assert.deepEqual(mismatches.map((entry) => entry.field), ["files_changed"]);
    // Order must not be treated as a disagreement.
    assert.deepEqual(reconcileClaim({ files_changed: ["src/a.ts"] }, observation).mismatches, []);
  });
});

describe("attack 5 — a slice changes paths it does not own", () => {
  it("reports paths outside the declared set", () => {
    const changed = ["src/app/thing.ts", "src/other/sneak.ts", "src/application/x.ts"];
    assert.deepEqual(unownedPaths(changed, ["src/app/"]), ["src/other/sneak.ts", "src/application/x.ts"],
      "a prefix that is not a path boundary must not count as ownership");
    assert.deepEqual(unownedPaths(["src/app/thing.ts"], ["src/app"]), []);
    assert.deepEqual(unownedPaths(["src/app/thing.ts"], ["src/app/thing.ts"]), []);
    assert.deepEqual(unownedPaths(["package.json", "package-lock.json"], ["package.json", "package-lock.json"]), []);
    assert.deepEqual(unownedPaths(["package.json"], ["src/app/"]), ["package.json"]);
    // An empty declaration owns nothing, rather than owning everything.
    assert.deepEqual(unownedPaths(changed, []), changed);
  });

  it("reports privileged control-plane paths regardless of declaration", () => {
    // `.factory.json` joins the list because it is committed rather than gitignored: it is the
    // repository's declaration of what the factory may run, so a run able to edit it could redefine
    // its own permissions. Ownership comes from this policy, not from being unversioned.
    const privileged = [".gitignore", ".factory.json", ".factory", ".factory/app-1/run.json", ".git", ".git/config"];
    assert.deepEqual(privilegedPaths([...privileged, "package.json", "package-lock.json", "pyproject.toml", "Cargo.toml", "src/app/ok.ts"]).sort(),
      privileged.sort());
    assert.deepEqual(privilegedPaths(["package.json", "package-lock.json"]), []);
    const policy = readFileSync(new URL("../observe/index.js", import.meta.url), "utf8");
    assert.match(policy, /const PRIVILEGED_PREFIXES = Object\.freeze\(\[CONTROL_PLANE, "\.git"\]\);/u,
      "the universal policy may have only the .factory and .git prefixes");
    assert.match(policy, /const PRIVILEGED_EXACT = Object\.freeze\(\["\.gitignore", "\.factory\.json"\]\);/u,
      "the universal policy may have only the exact .gitignore entry");
    assert.match(policy, /\.gitignore can conceal files from cleanliness and observed-diff checks/u,
      "the adjacent policy comment must explain .gitignore's concealment risk");
    assert.match(policy, /Ecosystem manifests\n\/\/ are authorized through ratified seeded ownership instead\./u,
      "the adjacent policy comment must explain manifest authorization through seeded ownership");
    // Declaring them does not grant them.
    assert.deepEqual(unownedPaths([".factory/app-1/run.json"], [".factory/"]), []);
    assert.equal(privilegedPaths([".factory/app-1/run.json"]).length, 1,
      "ownership and privilege are separate questions; declaring a privileged path must not clear it");
  });

  it("observes the real changed-file list from git", () => {
    const f = repo("paths", { files: { "src/app/thing.ts": "1\n", "src/other/sneak.ts": "2\n" } });
    try {
      const observation = observeWorktree(f.root, f.base);
      assert.equal(observation.diff_observed, true);
      assert.deepEqual(observation.files_changed.sort(), ["src/app/thing.ts", "src/other/sneak.ts"]);
      assert.deepEqual(unownedPaths(observation.files_changed, ["src/app/"]), ["src/other/sneak.ts"]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe("attack 7 — a stale or unrelated base is presented", () => {
  it("distinguishes ancestor, not-ancestor, and an unrunnable probe", () => {
    const f = repo("ancestry");
    try {
      assert.equal(observeAncestry(f.root, f.base, "HEAD"), "ancestor");

      // An unrelated history: the base is genuinely not an ancestor.
      run(f.root, "checkout", "-q", "--orphan", "elsewhere");
      run(f.root, "rm", "-rq", "--cached", ".");
      writeFileSync(join(f.root, "unrelated.txt"), "x\n");
      run(f.root, "add", "-A");
      run(f.root, "commit", "-q", "-m", "unrelated");
      assert.equal(observeAncestry(f.root, f.base, "HEAD"), "not-ancestor");

      // A ref that does not exist is a failed probe, not a proven negative: git
      // exits 128 rather than 1, and reading that as "not-ancestor" would report a
      // relationship nobody established.
      assert.equal(observeAncestry(f.root, "refs/heads/does-not-exist", "HEAD"), "indeterminate");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("marks evidence not-review-ready when the diff could not be observed", () => {
    const f = repo("unobservable");
    try {
      const evidence = buildEvidence({
        subject: "be-thing", attempt: 1, branch: "slice", baseRef: "refs/heads/does-not-exist",
        worktree: f.root, status: "completed", testCommand: ["git", "--no-pager", "log", "-1"],
      });
      assert.equal(evidence.diff_observed, false, "git could not produce the diff");
      assert.equal(evidence.review_ready, false, "an unobservable diff cannot be review-ready even with passing tests");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
