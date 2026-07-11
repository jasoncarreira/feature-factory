import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "./helpers/git-fixture.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adoptContinuation, continueFactory, seedContinuationPlanningArtifacts } from "../src/factory.js";
import { validateRun } from "../src/validate.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

describe("factory continue", () => {
  it("builds a dry-run continuation payload from a blocked parent without mutating parent state", () => {
    const fixture = createFixture("blocked-parent");
    try {
      const beforeRunHash = hashFile(join(fixture.runDir, "run.json"));
      const beforeReviewHash = hashFile(join(fixture.runDir, "reviews", "reviewer.json"));
      const beforeArtifactHashes = hashArtifactRefs(fixture.runDir, ["artifacts/story.md"]);
      const mainCommit = gitStdout(fixture.repo, ["rev-parse", "--verify", "main^{commit}"]);

      const result = continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviews/reviewer.json",
        runId: "blocked-parent-continue",
        dryRun: true,
        ghAccount: "octo-org",
        now: "2026-07-08T12:00:00.000Z",
      });

      assert.equal(result.status, "dry-run");
      assert.equal(result.payload.driver.ready, false);
      assert.equal(result.payload.driver.pr_mode, null);
      assert.equal(result.payload.driver.github_account, "octo-org");
      const parentCommit = gitStdout(fixture.repo, ["rev-parse", "--verify", `refs/heads/${fixture.runId}^{commit}`]);
      assert.deepEqual(result.payload.continuation, {
        kind: "blocked-run-continuation",
        schema_version: 1,
        created_at: "2026-07-08T12:00:00.000Z",
        operator_summary: `Continue blocked run '${fixture.runId}' from reviews/reviewer.json.`,
        parent: {
          run_id: fixture.runId,
          status: "blocked",
          run_ref: `.opencode/factory/${fixture.runId}/run.json`,
          run_hash: beforeRunHash,
          branch: fixture.runId,
          commit: parentCommit,
          worktree: join(fixture.repo, ".opencode", "worktrees", fixture.runId),
        },
        review: {
          kind: "validator",
          ref: "reviews/reviewer.json",
          hash: beforeReviewHash,
          subject: fixture.runId,
          summary: "needs continuation",
          required_fixes: [],
          source: "run.validator.review_ref",
        },
        target: {
          run_id: "blocked-parent-continue",
          branch: "blocked-parent-continue",
          worktree: join(gitStdout(fixture.repo, ["rev-parse", "--show-toplevel"]), ".opencode", "worktrees", "blocked-parent-continue"),
          base_ref: "main",
          base_commit: mainCommit,
        },
        parent_artifacts: [{ kind: "story", ref: "artifacts/story.md", hash: hashFile(join(fixture.runDir, "artifacts", "story.md")) }],
        parent_evidence: [],
        parent_reviews: [{ kind: "review", ref: "reviews/reviewer.json", hash: beforeReviewHash }],
        planning_reuse: { eligible: false, reason: "parent has no spec-writer step; brief is amendment input only" },
      });
      assert.equal(hashFile(join(fixture.runDir, "run.json")), beforeRunHash);
      assert.equal(hashFile(join(fixture.runDir, "reviews", "reviewer.json")), beforeReviewHash);
      assert.deepEqual(hashArtifactRefs(fixture.runDir, result.payload.continuation.parent_artifacts.map((artifact) => artifact.ref)), beforeArtifactHashes);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "blocked-parent-continue", "run.json")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("emits a continuation payload that is valid for the persisted run.continuation schema", () => {
    const fixture = createFixture("schema-parent");
    try {
      const proc = runCli(fixture.repo, ["factory", "continue", fixture.runId, "--review", "reviewer.json", "--run-id", "schema-parent-next", "--dry-run", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const output = JSON.parse(proc.stdout);

      assert.doesNotThrow(() => validateRun(childRunFromPayload(output.payload.continuation)));
      assert.equal(output.payload.continuation.parent.run_ref, `.opencode/factory/${fixture.runId}/run.json`);
      assert.equal(output.payload.continuation.parent.run_hash, hashFile(join(fixture.runDir, "run.json")));
      assert.deepEqual(output.payload.continuation.parent_artifacts, hashArtifactRefs(fixture.runDir, ["artifacts/story.md"]));
      assert.equal(output.payload.continuation.parent.artifact_refs, undefined);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("accepts required_fixes without requiring a verdict enum", () => {
    const fixture = createFixture("fixes-review", { review: { subject: "fixes-review", required_fixes: ["repair tests"], verdict: "not-a-standard-verdict" } });
    try {
      const result = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "fixes-review-next", dryRun: true });
      assert.equal(result.payload.continuation.review.ref, "reviews/reviewer.json");
      assert.deepEqual(result.payload.continuation.review.required_fixes, ["repair tests"]);
      assert.equal(result.payload.continuation.review.summary, null);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("hashes only documented parent artifact refs", () => {
    const fixture = createFixture("known-artifacts-only");
    try {
      writeFileSync(join(fixture.runDir, "artifacts", "extra.json"), "{}\n", "utf8");
      mkdirSync(join(fixture.runDir, "artifacts", "nested"));
      writeFileSync(join(fixture.runDir, "artifacts", "nested", "extra.md"), "extra\n", "utf8");

      const result = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "known-artifacts-only-next", dryRun: true });

      assert.deepEqual(result.payload.continuation.parent_artifacts, hashArtifactRefs(fixture.runDir, ["artifacts/story.md"]));
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("accepts continuation reviews referenced by security, step, and slice parent sources", () => {
    const cases = [
      {
        name: "security-parent-source",
        reviewRef: "reviews/security-reviewer.json",
        review: { subject: "security-parent-source", summary: "security review blocks continuation" },
        patchRun(run) {
          run.security_review = { verdict: "BLOCK", review_ref: "reviews/security-reviewer.json" };
        },
        expected: { kind: "security_review", source: "run.security_review.review_ref", subject: "security-parent-source" },
        expectedReviews: ["reviews/reviewer.json", "reviews/security-reviewer.json"],
      },
      {
        name: "step-parent-source",
        reviewRef: "reviews/spec-review.json",
        review: { subject: "spec-writer", summary: "step review blocks continuation" },
        patchRun(run) {
          run.steps = [{ agent: "spec-writer", status: "blocked", review_ref: "reviews/spec-review.json" }];
        },
        expected: { kind: "step", source: "run.steps.spec-writer.review_ref", subject: "spec-writer" },
        expectedReviews: ["reviews/reviewer.json", "reviews/spec-review.json"],
      },
      {
        name: "slice-parent-source",
        reviewRef: "reviews/api-slice-review.json",
        review: { subject: "api-slice", summary: "slice review blocks continuation" },
        patchRun(run) {
          run.slices = [{ id: "api-slice", status: "blocked", review_ref: "reviews/api-slice-review.json" }];
        },
        expected: { kind: "slice", source: "run.slices.api-slice.review_ref", subject: "api-slice" },
        expectedReviews: ["reviews/api-slice-review.json", "reviews/reviewer.json"],
      },
    ];

    for (const testCase of cases) {
      const fixture = createFixture(testCase.name);
      try {
        writeJson(join(fixture.runDir, testCase.reviewRef), testCase.review);
        updateRun(fixture, testCase.patchRun);

        const result = continueFactory(fixture.runId, { cwd: fixture.repo, review: testCase.reviewRef, runId: `${testCase.name}-next`, dryRun: true });

        assert.equal(result.payload.continuation.review.kind, testCase.expected.kind);
        assert.equal(result.payload.continuation.review.source, testCase.expected.source);
        assert.equal(result.payload.continuation.review.subject, testCase.expected.subject);
        assert.equal(result.payload.continuation.review.ref, testCase.reviewRef);
        assert.deepEqual(result.payload.continuation.parent_reviews, hashReviewRefs(fixture.runDir, testCase.expectedReviews));
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("hashes sorted parent evidence refs from steps and slices", () => {
    const fixture = createFixture("parent-evidence");
    try {
      mkdirSync(join(fixture.runDir, "evidence"));
      writeJson(join(fixture.runDir, "evidence", "z-step.json"), { ok: false, source: "step" });
      writeJson(join(fixture.runDir, "evidence", "a-slice.json"), { ok: false, source: "slice" });
      updateRun(fixture, (run) => {
        run.steps = [{ agent: "spec-writer", status: "blocked", evidence_ref: "evidence/z-step.json" }];
        run.slices = [{ id: "api-slice", status: "blocked", evidence_ref: "evidence/a-slice.json" }];
      });

      const result = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "parent-evidence-next", dryRun: true });

      assert.deepEqual(result.payload.continuation.parent_evidence, hashEvidenceRefs(fixture.runDir, ["evidence/a-slice.json", "evidence/z-step.json"]));
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects continuation reviews that name missing parent refs", () => {
    const cases = [
      { name: "missing-review-evidence", refField: "evidence_ref", ref: "evidence/missing.json", message: /missing parent evidence ref: evidence\/missing\.json/u },
      { name: "missing-review-artifact", refField: "artifact_ref", ref: "artifacts/missing.md", message: /missing parent artifact ref: artifacts\/missing\.md/u },
      { name: "missing-review-report", refField: "report", ref: "artifacts/missing-report.md", message: /missing parent artifact ref: artifacts\/missing-report\.md/u },
      { name: "missing-secondary-review", refField: "review_ref", ref: "reviews/secondary.json", message: /missing parent review ref: reviews\/secondary\.json/u },
    ];

    for (const testCase of cases) {
      const fixture = createFixture(testCase.name, { review: { subject: testCase.name, summary: "names missing parent ref", [testCase.refField]: testCase.ref } });
      try {
        assert.throws(
          () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${testCase.name}-next`, dryRun: true }),
          testCase.message,
        );
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("rejects missing parents and missing reviews", () => {
    const missingParent = createFixture("missing-parent-source");
    try {
      assert.throws(
        () => continueFactory("missing-parent", { cwd: missingParent.repo, review: "reviewer.json", runId: "missing-parent-next", dryRun: true }),
        /run not found/u,
      );
    } finally {
      cleanup(missingParent.repo);
    }

    const missingReview = createFixture("missing-review");
    try {
      rmSync(join(missingReview.runDir, "reviews", "reviewer.json"));
      assert.throws(
        () => continueFactory(missingReview.runId, { cwd: missingReview.repo, review: "reviewer.json", runId: "missing-review-next", dryRun: true }),
        /review is unresolvable|missing/u,
      );
    } finally {
      cleanup(missingReview.repo);
    }
  });

  it("rejects invalid JSON, non-object reviews, and empty required_fixes entries without summary", () => {
    const invalidJson = createFixture("invalid-json-review");
    try {
      writeFileSync(join(invalidJson.runDir, "reviews", "reviewer.json"), "{\n", "utf8");
      assert.throws(
        () => continueFactory(invalidJson.runId, { cwd: invalidJson.repo, review: "reviewer.json", runId: "invalid-json-next", dryRun: true }),
        /must parse as a JSON object/u,
      );
    } finally {
      cleanup(invalidJson.repo);
    }

    const nonObject = createFixture("non-object-review");
    try {
      writeFileSync(join(nonObject.runDir, "reviews", "reviewer.json"), "[]\n", "utf8");
      assert.throws(
        () => continueFactory(nonObject.runId, { cwd: nonObject.repo, review: "reviewer.json", runId: "non-object-next", dryRun: true }),
        /must parse as a JSON object/u,
      );
    } finally {
      cleanup(nonObject.repo);
    }

    const emptyFixes = createFixture("empty-fixes-review", { review: { subject: "empty-fixes-review", required_fixes: ["", "   "] } });
    try {
      assert.throws(
        () => continueFactory(emptyFixes.runId, { cwd: emptyFixes.repo, review: "reviewer.json", runId: "empty-fixes-next", dryRun: true }),
        /non-empty summary or required_fixes\[\]/u,
      );
    } finally {
      cleanup(emptyFixes.repo);
    }
  });

  it("rejects non-blocked parents, missing parent branches, invalid reviews, and unsafe targets", () => {
    const nonBlocked = createFixture("running-parent", { status: "running" });
    try {
      assert.throws(
        () => continueFactory(nonBlocked.runId, { cwd: nonBlocked.repo, review: "reviewer.json", runId: "running-next", dryRun: true }),
        /must have status blocked/u,
      );
    } finally {
      cleanup(nonBlocked.repo);
    }

    const missingBranch = createFixture("missing-branch", { createBranch: false });
    try {
      assert.throws(
        () => continueFactory(missingBranch.runId, { cwd: missingBranch.repo, review: "reviewer.json", runId: "missing-branch-next", dryRun: true }),
        /requires existing branch/u,
      );
    } finally {
      cleanup(missingBranch.repo);
    }

    const invalidReview = createFixture("invalid-review", { review: { subject: "", summary: "" } });
    try {
      assert.throws(
        () => continueFactory(invalidReview.runId, { cwd: invalidReview.repo, review: "reviewer.json", runId: "invalid-review-next", dryRun: true }),
        /non-empty subject/u,
      );
      assert.throws(
        () => continueFactory(invalidReview.runId, { cwd: invalidReview.repo, review: "../run.json", runId: "invalid-review-next", dryRun: true }),
        /reviews\//u,
      );
    } finally {
      cleanup(invalidReview.repo);
    }

    const unsafeTarget = createFixture("unsafe-target");
    try {
      assert.throws(
        () => continueFactory(unsafeTarget.runId, { cwd: unsafeTarget.repo, review: "reviewer.json", runId: "../next", dryRun: true }),
        /bare safe/u,
      );
      assert.throws(
        () => continueFactory(unsafeTarget.runId, { cwd: unsafeTarget.repo, review: "reviewer.json", runId: unsafeTarget.runId, dryRun: true }),
        /differ from the parent/u,
      );
      runGit(unsafeTarget.repo, ["branch", "already-exists"]);
      assert.throws(
        () => continueFactory(unsafeTarget.runId, { cwd: unsafeTarget.repo, review: "reviewer.json", runId: "already-exists", dryRun: true }),
        /target branch already exists/u,
      );
      mkdirSync(join(unsafeTarget.repo, ".opencode", "factory", "target-run-exists"), { recursive: true });
      writeFileSync(join(unsafeTarget.repo, ".opencode", "factory", "target-run-exists", "run.json"), "{}\n", "utf8");
      assert.throws(
        () => continueFactory(unsafeTarget.runId, { cwd: unsafeTarget.repo, review: "reviewer.json", runId: "target-run-exists", dryRun: true }),
        /target run already exists/u,
      );
      mkdirSync(join(unsafeTarget.repo, ".opencode", "worktrees", "target-worktree-exists"), { recursive: true });
      assert.throws(
        () => continueFactory(unsafeTarget.runId, { cwd: unsafeTarget.repo, review: "reviewer.json", runId: "target-worktree-exists", dryRun: true }),
        /target worktree already exists/u,
      );
    } finally {
      cleanup(unsafeTarget.repo);
    }
  });

  it("rejects continuation reviews that are not referenced by parent run state or have mismatched subjects", () => {
    const unreferenced = createFixture("unreferenced-review");
    try {
      writeJson(join(unreferenced.runDir, "reviews", "unreferenced.json"), { subject: unreferenced.runId, summary: "not linked" });
      assert.throws(
        () => continueFactory(unreferenced.runId, { cwd: unreferenced.repo, review: "unreferenced.json", runId: "unreferenced-review-next", dryRun: true }),
        /must be referenced by parent run state/u,
      );
    } finally {
      cleanup(unreferenced.repo);
    }

    const mismatchedSubject = createFixture("mismatched-review-subject", { review: { subject: "other-run", summary: "wrong subject" } });
    try {
      assert.throws(
        () => continueFactory(mismatchedSubject.runId, { cwd: mismatchedSubject.repo, review: "reviewer.json", runId: "mismatched-review-subject-next", dryRun: true }),
        /subject must match parent validator source/u,
      );
    } finally {
      cleanup(mismatchedSubject.repo);
    }
  });

  it("rejects a symlinked parent run.json trust root before reading or hashing it", () => {
    const fixture = createFixture("symlink-parent-run-json");
    const escapedRun = mkdtempSync(join(tmpdir(), "factory-escaped-run-json-"));
    try {
      writeFileSync(join(escapedRun, "run.json"), readFileSync(join(fixture.runDir, "run.json")), "utf8");
      rmSync(join(fixture.runDir, "run.json"), { force: true });
      symlinkSync(join(escapedRun, "run.json"), join(fixture.runDir, "run.json"), "file");
      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "symlink-parent-run-json-next", dryRun: true }),
        /parent run\.json must not contain symlinks/u,
      );
    } finally {
      cleanup(fixture.repo);
      cleanup(escapedRun);
    }
  });

  it("rejects a symlinked parent run directory trust root", () => {
    const fixture = createFixture("symlink-parent-run-dir");
    const realRunDir = join(fixture.repo, ".opencode", "factory", `${fixture.runId}-real`);
    try {
      renameSync(fixture.runDir, realRunDir);
      symlinkSync(realRunDir, fixture.runDir, "dir");
      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "symlink-parent-run-dir-next", dryRun: true }),
        /parent run\.json must not contain symlinks/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects review symlink escapes, including an escaped parent reviews directory", () => {
    const fixture = createFixture("symlink-review");
    const escapedReviews = mkdtempSync(join(tmpdir(), "factory-escaped-reviews-"));
    try {
      writeJson(join(escapedReviews, "reviewer.json"), { subject: "escaped", summary: "outside parent run" });
      rmSync(join(fixture.runDir, "reviews"), { recursive: true, force: true });
      symlinkSync(escapedReviews, join(fixture.runDir, "reviews"), "dir");
      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "symlink-review-next", dryRun: true }),
        /reviews\//u,
      );
    } finally {
      cleanup(fixture.repo);
      cleanup(escapedReviews);
    }
  });

  it("rejects a parent reviews symlink to artifacts even when artifact JSON looks like review evidence", () => {
    const fixture = createFixture("reviews-to-artifacts");
    try {
      writeJson(join(fixture.runDir, "artifacts", "reviewer.json"), { subject: "artifact review", summary: "must not be accepted" });
      rmSync(join(fixture.runDir, "reviews"), { recursive: true, force: true });
      symlinkSync(join(fixture.runDir, "artifacts"), join(fixture.runDir, "reviews"), "dir");

      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "reviews-to-artifacts-next", dryRun: true }),
        /reviews\/ directory without symlinks/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects a symlinked review file under reviews", () => {
    const fixture = createFixture("symlink-review-file");
    try {
      writeJson(join(fixture.runDir, "artifacts", "linked-review.json"), { subject: "linked", summary: "outside reviews" });
      rmSync(join(fixture.runDir, "reviews", "reviewer.json"), { force: true });
      symlinkSync(join(fixture.runDir, "artifacts", "linked-review.json"), join(fixture.runDir, "reviews", "reviewer.json"), "file");

      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "symlink-review-file-next", dryRun: true }),
        /reviews\/ directory without symlinks/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects a symlinked intermediate review directory", () => {
    const fixture = createFixture("symlink-review-dir");
    const escapedReviews = mkdtempSync(join(tmpdir(), "factory-review-dir-"));
    try {
      writeJson(join(escapedReviews, "reviewer.json"), { subject: "linked dir", summary: "outside reviews" });
      symlinkSync(escapedReviews, join(fixture.runDir, "reviews", "nested"), "dir");

      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "nested/reviewer.json", runId: "symlink-review-dir-next", dryRun: true }),
        /reviews\/ directory without symlinks/u,
      );
    } finally {
      cleanup(fixture.repo);
      cleanup(escapedReviews);
    }
  });

  it("rejects a symlinked artifact file before reading parent_artifacts", () => {
    const fixture = createFixture("symlink-artifact-file");
    const escapedArtifacts = mkdtempSync(join(tmpdir(), "factory-escaped-artifacts-"));
    try {
      writeFileSync(join(escapedArtifacts, "story.md"), "outside story\n", "utf8");
      rmSync(join(fixture.runDir, "artifacts", "story.md"), { force: true });
      symlinkSync(join(escapedArtifacts, "story.md"), join(fixture.runDir, "artifacts", "story.md"), "file");

      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "symlink-artifact-file-next", dryRun: true }),
        /parent artifact 'artifacts\/story\.md' must not contain symlinks/u,
      );
    } finally {
      cleanup(fixture.repo);
      cleanup(escapedArtifacts);
    }
  });

  it("rejects a symlinked artifact root", () => {
    const fixture = createFixture("symlink-artifact-root");
    const escapedArtifacts = mkdtempSync(join(tmpdir(), "factory-artifacts-root-"));
    try {
      writeFileSync(join(escapedArtifacts, "story.md"), "outside story\n", "utf8");
      rmSync(join(fixture.runDir, "artifacts"), { recursive: true, force: true });
      symlinkSync(escapedArtifacts, join(fixture.runDir, "artifacts"), "dir");

      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "symlink-artifact-root-next", dryRun: true }),
        /parent artifacts\/ directory must not contain symlinks/u,
      );
    } finally {
      cleanup(fixture.repo);
      cleanup(escapedArtifacts);
    }
  });

  it("CLI routes factory continue and carries per-run PR mode overrides", () => {
    const fixture = createFixture("cli-parent");
    try {
      const proc = runCli(fixture.repo, ["factory", "continue", fixture.runId, "--review", "reviewer.json", "--run-id", "cli-parent-next", "--dry-run", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const output = JSON.parse(proc.stdout);
      assert.equal(output.status, "dry-run");
      assert.equal(output.payload.continuation.target.run_id, "cli-parent-next");
      assert.equal(output.payload.driver.ready, false);
      assert.equal(output.payload.driver.pr_mode, null);

      const ready = JSON.parse(runCli(fixture.repo, ["factory", "continue", fixture.runId, "--review", "reviewer.json", "--run-id", "ready-next", "--ready", "--dry-run", "--json"]).stdout);
      assert.equal(ready.payload.driver.pr_mode, "ready");

      const noDraft = JSON.parse(runCli(fixture.repo, ["factory", "continue", fixture.runId, "--review", "reviewer.json", "--run-id", "no-draft-next", "--no-draft", "--dry-run", "--json"]).stdout);
      assert.equal(noDraft.payload.driver.pr_mode, "ready");

      const draft = JSON.parse(runCli(fixture.repo, ["factory", "continue", fixture.runId, "--review", "reviewer.json", "--run-id", "draft-next", "--draft", "--dry-run", "--json"]).stdout);
      assert.equal(draft.payload.driver.pr_mode, "draft");
    } finally {
      cleanup(fixture.repo);
    }
  });
});

describe("continuation planning-artifact reuse", () => {
  // The brief + spec review are written by createFixture({ spec }) so the parent's
  // acceptance binding can be computed against them; here we add the other inputs.
  function seedPlanningArtifacts(runDir) {
    writeFileSync(join(runDir, "artifacts", "research-map.md"), "research\n", "utf8");
    writeFileSync(join(runDir, "artifacts", "design-brief.md"), "design\n", "utf8");
  }

  it("seeds the parent's accepted planning artifacts and carries the approving spec review into the child", () => {
    const fixture = createFixture("reuse-seed", { spec: { status: "accepted", verdict: "APPROVE" } });
    try {
      seedPlanningArtifacts(fixture.runDir);
      writeFileSync(join(fixture.runDir, "artifacts", "test-report.md"), "tests\n", "utf8");
      writeFileSync(join(fixture.runDir, "artifacts", "pr-body.md"), "pr\n", "utf8");

      const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "reuse-seed-next", dryRun: true });
      const childRunDir = join(fixture.repo, ".opencode", "factory", "reuse-seed-next");
      const targetArtifacts = join(childRunDir, "artifacts");

      assert.equal(payload.continuation.planning_reuse.eligible, true);
      assert.deepEqual([...payload.continuation.parent_artifacts.filter((a) => ["story", "research_map", "design_brief", "technical_brief"].includes(a.kind)).map((a) => a.ref)].sort(),
        ["artifacts/design-brief.md", "artifacts/research-map.md", "artifacts/story.md", "artifacts/technical-brief.md"]);
      assert.equal(existsSync(targetArtifacts), false, "dry-run must not seed");

      const seeded = seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, payload.continuation);
      assert.deepEqual([...seeded.artifacts].sort(), ["artifacts/design-brief.md", "artifacts/research-map.md", "artifacts/story.md", "artifacts/technical-brief.md"]);
      assert.equal(seeded.spec_review_ref, "reviews/spec-writer.json");
      // planning artifacts copied with identical content
      assert.equal(readFileSync(join(targetArtifacts, "technical-brief.md"), "utf8"), "brief\n");
      assert.equal(readFileSync(join(targetArtifacts, "research-map.md"), "utf8"), "research\n");
      // the approving spec review is carried into child state so the adopted step's ref resolves
      const carriedReview = JSON.parse(readFileSync(join(childRunDir, "reviews", "spec-writer.json"), "utf8"));
      assert.equal(carriedReview.subject, "spec-writer");
      assert.equal(carriedReview.verdict, "APPROVE");
      // outcome artifacts NOT seeded
      assert.equal(existsSync(join(targetArtifacts, "test-report.md")), false);
      assert.equal(existsSync(join(targetArtifacts, "pr-body.md")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("does NOT adopt a brief from a parent whose spec-writer step was rejected", () => {
    const fixture = createFixture("reuse-rejected", { spec: { status: "rejected", verdict: "REJECT" } });
    try {
      seedPlanningArtifacts(fixture.runDir); // the rejected brief IS present on disk
      const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "reuse-rejected-next", dryRun: true });
      const childRunDir = join(fixture.repo, ".opencode", "factory", "reuse-rejected-next");

      assert.equal(payload.continuation.planning_reuse.eligible, false);
      assert.match(payload.continuation.planning_reuse.reason, /rejected|not accepted|amendment input only/i);

      const seeded = seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, payload.continuation);
      assert.equal(seeded.eligible, false);
      assert.deepEqual(seeded.artifacts, []);
      // NOTHING adopted: no child artifacts and no carried review
      assert.equal(existsSync(join(childRunDir, "artifacts")), false, "rejected brief must not be seeded");
      assert.equal(existsSync(join(childRunDir, "reviews", "spec-writer.json")), false, "no approving review to carry");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("does NOT adopt when the spec-writer step is accepted but its review is not approving", () => {
    const fixture = createFixture("reuse-unapproved", { spec: { status: "accepted", verdict: "REJECT" } });
    try {
      seedPlanningArtifacts(fixture.runDir);
      const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "reuse-unapproved-next", dryRun: true });
      assert.equal(payload.continuation.planning_reuse.eligible, false);
      assert.match(payload.continuation.planning_reuse.reason, /not approving/i);
      const seeded = seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, payload.continuation);
      assert.equal(seeded.eligible, false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "reuse-unapproved-next", "artifacts")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("fails closed with no partial child directory when a source disappears after the payload was built", () => {
    const fixture = createFixture("reuse-missing", { spec: { status: "accepted", verdict: "APPROVE" } });
    try {
      seedPlanningArtifacts(fixture.runDir);
      const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "reuse-missing-next", dryRun: true });
      // a source vanishes between payload build and seed — must abort, not silently skip
      rmSync(join(fixture.runDir, "artifacts", "research-map.md"), { force: true });
      assert.throws(
        () => seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, payload.continuation),
        /missing or not a regular file/u,
      );
      // fail closed: nothing published (not even the entries validated before the missing one)
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "reuse-missing-next", "artifacts")), false, "no partial child artifacts/ may survive");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("fails closed with no partial child directory when a later entry changed after the payload was built", () => {
    const fixture = createFixture("reuse-mismatch", { spec: { status: "accepted", verdict: "APPROVE" } });
    try {
      seedPlanningArtifacts(fixture.runDir);
      const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "reuse-mismatch-next", dryRun: true });
      // tamper with a LATER planning artifact (story.md sorts after design-brief/research-map)
      writeFileSync(join(fixture.runDir, "artifacts", "story.md"), "tampered\n", "utf8");
      assert.throws(
        () => seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, payload.continuation),
        /changed since payload build/u,
      );
      // the earlier, valid entries must NOT have been written before the mismatch aborted
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "reuse-mismatch-next", "artifacts")), false, "no partial child artifacts/ may survive a later-entry mismatch");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("fails closed for a legacy accepted step that carries no durable acceptance binding", () => {
    const fixture = createFixture("reuse-unbound", { spec: { status: "accepted", verdict: "APPROVE", bind: false } });
    try {
      seedPlanningArtifacts(fixture.runDir);
      const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "reuse-unbound-next", dryRun: true });
      assert.equal(payload.continuation.planning_reuse.eligible, false);
      assert.match(payload.continuation.planning_reuse.reason, /acceptance binding|re-acceptance/i);
      assert.equal(seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, payload.continuation).eligible, false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("fails closed when the brief changed after acceptance (does not match the binding)", () => {
    const fixture = createFixture("reuse-stale", { spec: { status: "accepted", verdict: "APPROVE", staleArtifact: true } });
    try {
      seedPlanningArtifacts(fixture.runDir);
      const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "reuse-stale-next", dryRun: true });
      assert.equal(payload.continuation.planning_reuse.eligible, false);
      assert.match(payload.continuation.planning_reuse.reason, /changed since acceptance|re-acceptance/i);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("records an immutable acceptance binding when the parent step is accepted (via the real CLI transition)", () => {
    const fixture = createFixture("bind-write");
    try {
      writeFileSync(join(fixture.runDir, "artifacts", "technical-brief.md"), "brief\n", "utf8");
      writeJson(join(fixture.runDir, "reviews", "spec-writer.json"), { subject: "spec-writer", verdict: "APPROVE", summary: "ok" });
      // seed the step so the accept transition has a step to bind
      updateRun(fixture, (run) => {
        run.status = "running";
        run.terminal_result = null;
        run.steps = [{ agent: "spec-writer", status: "running", attempts: 0 }];
      });

      const proc = runCli(fixture.repo, ["factory", "step", fixture.runId, "spec-writer", "accepted", "--artifact-ref", "artifacts/technical-brief.md", "--review-ref", "reviews/spec-writer.json", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const written = JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8")).steps[0];
      assert.equal(written.acceptance.artifact_ref, "artifacts/technical-brief.md");
      assert.equal(written.acceptance.artifact_hash, hashFile(join(fixture.runDir, "artifacts", "technical-brief.md")));
      assert.equal(written.acceptance.review_hash, hashFile(join(fixture.runDir, "reviews", "spec-writer.json")));
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("clears the acceptance binding on non-accepted and failed re-acceptance transitions (no stale provenance)", () => {
    const fixture = createFixture("bind-clear");
    try {
      writeFileSync(join(fixture.runDir, "artifacts", "technical-brief.md"), "brief\n", "utf8");
      writeJson(join(fixture.runDir, "reviews", "spec-writer.json"), { subject: "spec-writer", verdict: "APPROVE", summary: "ok" });
      updateRun(fixture, (run) => {
        run.status = "running";
        run.terminal_result = null;
        run.steps = [{ agent: "spec-writer", status: "running", attempts: 0 }];
      });
      const readStep = () => JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8")).steps[0];

      // accepted(A) → binds
      assert.equal(runCli(fixture.repo, ["factory", "step", fixture.runId, "spec-writer", "accepted", "--artifact-ref", "artifacts/technical-brief.md", "--review-ref", "reviews/spec-writer.json", "--json"]).status, 0);
      assert.ok(readStep().acceptance, "accept must bind the acceptance");

      // rejected → the prior binding must be cleared (no stale provenance on a non-accepted step)
      assert.equal(runCli(fixture.repo, ["factory", "step", fixture.runId, "spec-writer", "rejected", "--json"]).status, 0);
      assert.equal(readStep().acceptance, undefined, "a non-accepted transition must clear the binding");

      // accepted(missing B) → status flips to accepted but the transition cannot bind, so it must
      // NOT re-attach the prior A binding (the manifest must not claim an acceptance never established)
      assert.equal(runCli(fixture.repo, ["factory", "step", fixture.runId, "spec-writer", "accepted", "--artifact-ref", "artifacts/missing.md", "--json"]).status, 0);
      const stale = readStep();
      assert.equal(stale.status, "accepted");
      assert.equal(stale.artifact_ref, "artifacts/missing.md");
      assert.equal(stale.acceptance, undefined, "a failed re-acceptance must not carry the prior binding");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("adopts a continuation through the checked transition, recording inherited acceptance", async () => {
    const fixture = createFixture("adopt-ok", { spec: { status: "accepted", verdict: "APPROVE" } });
    try {
      const child = seedChildForAdopt(fixture, "adopt-ok-next");
      const result = await adoptContinuation("adopt-ok-next", { cwd: fixture.repo });
      assert.equal(result.status, "adopted");
      assert.equal(result.step.status, "accepted");
      assert.equal(result.step.review_ref, "reviews/spec-writer.json");
      assert.equal(result.step.acceptance.artifact_hash, child.continuation.planning_reuse.spec_artifact_hash);
      assert.equal(result.step.inherited_acceptance.from_run_id, fixture.runId);
      assert.equal(result.step.inherited_acceptance.review_hash, child.continuation.planning_reuse.spec_review_hash);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("refuses to adopt when the seeded review was altered (or spoofed) after seeding", async () => {
    const fixture = createFixture("adopt-altered", { spec: { status: "accepted", verdict: "APPROVE" } });
    try {
      const child = seedChildForAdopt(fixture, "adopt-altered-next");
      writeFileSync(join(child.childRunDir, "reviews", "spec-writer.json"), JSON.stringify({ subject: "spec-writer", verdict: "APPROVE", summary: "TAMPERED" }), "utf8");
      await assert.rejects(() => adoptContinuation("adopt-altered-next", { cwd: fixture.repo }), /does not match the parent acceptance binding/u);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("refuses to adopt when a seeded file is missing", async () => {
    const fixture = createFixture("adopt-missing", { spec: { status: "accepted", verdict: "APPROVE" } });
    try {
      const child = seedChildForAdopt(fixture, "adopt-missing-next");
      rmSync(join(child.childRunDir, "artifacts", "technical-brief.md"), { force: true });
      await assert.rejects(() => adoptContinuation("adopt-missing-next", { cwd: fixture.repo }), /requires seeded artifacts\/technical-brief\.md/u);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("exclusive publish: a concurrent destination winner is not clobbered and this seed rolls back", () => {
    const fixture = createFixture("seed-race", { spec: { status: "accepted", verdict: "APPROVE" } });
    try {
      seedPlanningArtifacts(fixture.runDir);
      const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "seed-race-next", dryRun: true });
      const childArtifacts = join(fixture.repo, ".opencode", "factory", "seed-race-next", "artifacts");
      // a concurrent seed already published technical-brief.md (sorts last of the artifacts)
      mkdirSync(childArtifacts, { recursive: true });
      writeFileSync(join(childArtifacts, "technical-brief.md"), "winner\n", "utf8");
      assert.throws(() => seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, payload.continuation), /EEXIST|ENOTEMPTY|exist|not empty/u);
      // the winner's bytes are untouched; the earlier files this seed published are rolled back
      assert.equal(readFileSync(join(childArtifacts, "technical-brief.md"), "utf8"), "winner\n");
      assert.equal(existsSync(join(childArtifacts, "design-brief.md")), false);
      assert.equal(existsSync(join(childArtifacts, "research-map.md")), false);
      assert.equal(existsSync(join(childArtifacts, "story.md")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("mid-publication failure leaves no partial child artifacts", () => {
    const fixture = createFixture("seed-midfail", { spec: { status: "accepted", verdict: "APPROVE" } });
    try {
      seedPlanningArtifacts(fixture.runDir);
      const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "seed-midfail-next", dryRun: true });
      const childRunDir = join(fixture.repo, ".opencode", "factory", "seed-midfail-next");
      // reviews/ is a FILE, so publishing the spec review (last in the plan, after all
      // artifacts) fails with ENOTDIR mid-publication.
      mkdirSync(childRunDir, { recursive: true });
      writeFileSync(join(childRunDir, "reviews"), "not a dir\n", "utf8");
      assert.throws(() => seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, payload.continuation), /ENOTDIR|EEXIST|ENOTEMPTY|not a directory|not empty/u);
      // every artifact published before the failure was rolled back
      assert.equal(existsSync(join(childRunDir, "artifacts")), false, "no partial child artifacts/ may survive a mid-publish failure");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("keeps the child run invisible until the complete seed is atomically published", () => {
    const fixture = createFixture("seed-crash-window", { spec: { status: "accepted", verdict: "APPROVE" } });
    try {
      seedPlanningArtifacts(fixture.runDir);
      const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "seed-crash-window-next", dryRun: true });
      const childRunDir = join(fixture.repo, ".opencode", "factory", "seed-crash-window-next");
      let stagedRoot;

      assert.throws(() => seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, payload.continuation, {
        beforePublish: ({ stagingRoot, targetRunDir }) => {
          stagedRoot = stagingRoot;
          assert.equal(targetRunDir, childRunDir);
          assert.equal(existsSync(targetRunDir), false, "the child must not exist before the atomic commit");
          assert.equal(existsSync(join(stagingRoot, "artifacts", "technical-brief.md")), true, "the private staging tree must already be complete");
          assert.equal(existsSync(join(stagingRoot, "reviews", "spec-writer.json")), true, "the approving review must be staged before commit");
          throw new Error("simulated crash before atomic publish");
        },
      }), /simulated crash before atomic publish/u);

      assert.equal(existsSync(childRunDir), false, "a pre-commit crash must leave no partial child run");
      assert.equal(existsSync(stagedRoot), false, "a handled failure cleans its private staging tree");
    } finally {
      cleanup(fixture.repo);
    }
  });

  function seedChildForAdopt(fixture, childRunId) {
    const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, dryRun: true });
    const seeded = seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, payload.continuation);
    assert.equal(seeded.eligible, true);
    const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
    writeJson(join(childRunDir, "run.json"), childRunFromPayload(payload.continuation));
    return { childRunDir, continuation: payload.continuation };
  }
});

function createFixture(runId, { status = "blocked", createBranch = true, review, spec } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "factory-continue-"));
  initGitRepo(repo);
  if (createBranch) runGit(repo, ["branch", runId]);
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "story.md"), "story\n", "utf8");
  writeJson(join(runDir, "reviews", "reviewer.json"), review || { subject: runId, summary: "needs continuation" });
  const run = {
    schema_version: 1,
    run_id: runId,
    status,
    branch: runId,
    worktree: join(repo, ".opencode", "worktrees", runId),
    validator: { verdict: "NO-GO", review_ref: "reviews/reviewer.json" },
    gates: {},
    terminal_result: status === "blocked" ? { status: "blocked", run_id: runId, reason: "review blocked", summary: "blocked", artifacts: {} } : null,
  };
  if (spec) {
    writeFileSync(join(runDir, "artifacts", "technical-brief.md"), spec.brief ?? "brief\n", "utf8");
    writeJson(join(runDir, "reviews", "spec-writer.json"), { subject: "spec-writer", verdict: spec.verdict, summary: "spec review" });
    const step = { agent: "spec-writer", status: spec.status, attempts: 1, artifact_ref: "artifacts/technical-brief.md", review_ref: "reviews/spec-writer.json" };
    if (spec.status === "accepted" && spec.bind !== false) {
      step.acceptance = {
        artifact_ref: "artifacts/technical-brief.md",
        // staleArtifact simulates the brief changing after acceptance: the bound
        // hash no longer matches the current file, so reuse must fail closed.
        artifact_hash: spec.staleArtifact ? `sha256:${"0".repeat(64)}` : hashFile(join(runDir, "artifacts", "technical-brief.md")),
        review_ref: "reviews/spec-writer.json",
        review_hash: hashFile(join(runDir, "reviews", "spec-writer.json")),
      };
    }
    run.steps = [step];
  }
  writeJson(join(runDir, "run.json"), run);
  return { repo, runDir, runId };
}

function initGitRepo(repo) {
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "test\n", "utf8");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "init"]);
}

function runCli(repo, args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function runGit(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function gitStdout(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

function hashFile(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function hashArtifactRefs(runDir, refs) {
  return refs.map((ref) => ({ kind: parentArtifactKind(ref), ref, hash: hashFile(join(runDir, ref)) }));
}

function hashEvidenceRefs(runDir, refs) {
  return refs.map((ref) => ({ kind: "evidence", ref, hash: hashFile(join(runDir, ref)) }));
}

function hashReviewRefs(runDir, refs) {
  return refs
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .map((ref) => ({ kind: "review", ref, hash: hashFile(join(runDir, ref)) }));
}

function parentArtifactKind(ref) {
  if (ref === "artifacts/story.md") return "story";
  if (ref === "artifacts/research-map.md") return "research_map";
  if (ref === "artifacts/design-brief.md") return "design_brief";
  if (ref === "artifacts/technical-brief.md") return "technical_brief";
  if (ref === "artifacts/test-report.md") return "test_report";
  if (ref === "artifacts/validation-report.md") return "validation_report";
  if (ref === "artifacts/pr-body.md") return "pr_body";
  return "artifact";
}

function childRunFromPayload(continuation) {
  return {
    schema_version: 1,
    run_id: continuation.target.run_id,
    status: "running",
    branch: continuation.target.branch,
    worktree: continuation.target.worktree,
    gates: {},
    continuation,
  };
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function updateRun(fixture, update) {
  const file = join(fixture.runDir, "run.json");
  const run = JSON.parse(readFileSync(file, "utf8"));
  update(run);
  writeJson(file, run);
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
