import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "./helpers/git-fixture.js";
import { createReviewRecord } from "./helpers/review-record-fixture.js";
import { createRunRecord } from "./helpers/run-record-fixture.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adoptContinuation, assertContinuationBindingsCurrent, buildContinuation, continueFactory, resumeFactory, seedContinuationPlanningArtifacts } from "../src/factory.js";
import { validateRun } from "../src/validate.js";
import { transitionContinuationAdoption } from "../src/run-state.js";
import { DURABLE_AUTHORITY_CATALOG, DURABLE_MUTATION_FAMILIES, createDurableCatalogBaseline, emitDurableRecordMutations } from "./helpers/durable-record-mutations.js";

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
        review: createReviewRecord({ subject: "security-parent-source", verdict: undefined, required_fixes: undefined, summary: "security review blocks continuation" }),
        patchRun(run) {
          run.security_review = { verdict: "BLOCK", review_ref: "reviews/security-reviewer.json" };
        },
        expected: { kind: "security_review", source: "run.security_review.review_ref", subject: "security-parent-source" },
        expectedReviews: ["reviews/reviewer.json", "reviews/security-reviewer.json"],
      },
      {
        name: "step-parent-source",
        reviewRef: "reviews/spec-review.json",
        review: createReviewRecord({ subject: "spec-writer", verdict: undefined, required_fixes: undefined, summary: "step review blocks continuation" }),
        patchRun(run) {
          run.steps = [{ agent: "spec-writer", status: "blocked", review_ref: "reviews/spec-review.json" }];
        },
        expected: { kind: "step", source: "run.steps.spec-writer.review_ref", subject: "spec-writer" },
        expectedReviews: ["reviews/reviewer.json", "reviews/spec-review.json"],
      },
      {
        name: "slice-parent-source",
        reviewRef: "reviews/api-slice-review.json",
        review: createReviewRecord({ subject: "api-slice", verdict: undefined, required_fixes: undefined, summary: "slice review blocks continuation" }),
        patchRun(run) {
          run.slices = [{ id: "api-slice", status: "blocked", review_ref: "reviews/api-slice-review.json", blocked_reason: "slice review blocks continuation" }];
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
        run.slices = [{ id: "api-slice", status: "blocked", evidence_ref: "evidence/a-slice.json", blocked_reason: "slice evidence blocks continuation" }];
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

  it("enforces exact --new-pr admission before continuation side effects", () => {
    const ordinary = createFixture("ordinary-new-pr");
    try {
      assert.throws(() => continueFactory(ordinary.runId, { cwd: ordinary.repo, review: "reviewer.json", runId: "ordinary-new-pr-next", newPr: true, dryRun: true }), /only for a blocked parent with pr_url/u);
      assert.equal(existsSync(join(ordinary.repo, ".opencode", "factory", "ordinary-new-pr-next")), false);
    } finally { cleanup(ordinary.repo); }

    const postPr = createFixture("post-pr-needs-new-pr");
    try {
      updateRun(postPr, (run) => { run.pr_url = "https://github.com/acme/widgets/pull/7"; });
      const before = readFileSync(join(postPr.runDir, "run.json"), "utf8");
      assert.throws(() => continueFactory(postPr.runId, { cwd: postPr.repo, review: "reviewer.json", runId: "post-pr-needs-new-pr-next", dryRun: true }), /requires --new-pr/u);
      assert.equal(readFileSync(join(postPr.runDir, "run.json"), "utf8"), before);
      assert.equal(existsSync(join(postPr.repo, ".opencode", "factory", "post-pr-needs-new-pr-next")), false);
      assert.equal(gitStdout(postPr.repo, ["rev-parse", "--verify", `refs/heads/${postPr.runId}^{commit}`]), gitStdout(postPr.repo, ["rev-parse", "--verify", "main^{commit}"]));
    } finally { cleanup(postPr.repo); }
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
      writeJson(join(unreferenced.runDir, "reviews", "unreferenced.json"), createReviewRecord({ subject: unreferenced.runId, verdict: undefined, required_fixes: undefined, summary: "not linked" }));
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

      const postPr = JSON.parse(runCli(fixture.repo, ["factory", "continue", fixture.runId, "--review", "reviewer.json", "--run-id", "post-pr-next", "--post-pr-ci", "--post-pr-wait-minutes", "90", "--post-pr-poll-seconds", "45", "--dry-run", "--json"]).stdout);
      assert.deepEqual(postPr.payload.driver.post_pr_ci, { enabled: true, wait_ms: 5400000, initial_poll_ms: 45000 });
      const invalidTiming = runCli(fixture.repo, ["factory", "continue", fixture.runId, "--review", "reviewer.json", "--run-id", "invalid-post-pr-next", "--post-pr-wait-minutes", "90", "--dry-run", "--json"]);
      assert.notEqual(invalidTiming.status, 0);
      assert.match(invalidTiming.stderr, /timing flags require --post-pr-ci/u);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("returns an awaitable foreground launch and preserves continuation payload arguments", async () => {
    const fixture = createFixture("foreground-continue");
    const binDir = join(fixture.repo, "bin");
    const script = join(binDir, "opencode");
    mkdirSync(binDir);
    writeFileSync(script, "#!/usr/bin/env node\nprocess.stdout.write('continued\\n');\n", "utf8");
    const { chmodSync } = await import("node:fs");
    chmodSync(script, 0o755);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${binDir}:${previousPath || ""}`;
      const launch = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "foreground-continue-next" });
      assert.equal(typeof launch?.then, "function");
      await launch;
    } finally {
      process.env.PATH = previousPath;
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

  it("seeds a rejected brief only as a hash-bound unaccepted draft", () => {
    const fixture = createFixture("reuse-rejected", { spec: { status: "rejected", verdict: "REJECT" } });
    try {
      seedPlanningArtifacts(fixture.runDir); // the rejected brief IS present on disk
      const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "reuse-rejected-next", dryRun: true });
      const childRunDir = join(fixture.repo, ".opencode", "factory", "reuse-rejected-next");

      assert.equal(payload.continuation.planning_reuse.eligible, false);
      assert.match(payload.continuation.planning_reuse.reason, /rejected|not accepted|amendment input only/i);
      assert.equal(payload.continuation.draft_spec_reuse.artifact_ref, "artifacts/technical-brief.md");
      assert.equal(payload.continuation.draft_spec_reuse.parent_step_attempts, 1);
      assert.equal(payload.continuation.draft_spec_reuse.max_retries, 3);
      assert.equal(payload.continuation.draft_spec_reuse.remaining_attempts, 2);

      const seeded = seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, payload.continuation);
      assert.equal(seeded.eligible, true);
      assert.equal(seeded.draft, true);
      assert.deepEqual(seeded.artifacts, ["artifacts/technical-brief.md"]);
      assert.equal(readFileSync(join(childRunDir, "artifacts", "technical-brief.md"), "utf8"), "brief\n");
      // A draft carries no review or acceptance authority.
      assert.equal(existsSync(join(childRunDir, "reviews", "spec-writer.json")), false, "no approving review to carry");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("reuses a draft recorded through the documented rejected-step CLI", () => {
    const fixture = createFixture("reuse-cli-rejected", { status: "running", spec: { status: "running", verdict: "REJECT", attempts: 1 } });
    try {
      writeJson(join(fixture.runDir, "reviews", "spec-writer.attempt-1.json"), createReviewRecord({ subject: "spec-writer", verdict: "REJECT", summary: "spec review", required_fixes: [] }));
      const rejected = runCli(fixture.repo, [
        "factory", "step", fixture.runId, "spec-writer", "rejected",
        "--attempts", "1",
        "--artifact-ref", "artifacts/technical-brief.md",
        "--review-ref", "reviews/spec-writer.attempt-1.json",
        "--json",
      ]);
      assert.equal(rejected.status, 0, rejected.stderr);
      const rejectedRun = JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8"));
      assert.equal(rejectedRun.steps[0].artifact_ref, "artifacts/technical-brief.md");
      writeJson(join(fixture.runDir, "run.json"), {
        ...rejectedRun,
        status: "blocked",
        terminal_result: { status: "blocked", run_id: fixture.runId, reason: "review blocked", summary: "blocked", artifacts: {} },
      });

      const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "reuse-cli-rejected-next", dryRun: true });
      assert.equal(payload.continuation.draft_spec_reuse.artifact_ref, "artifacts/technical-brief.md");
      assert.equal(payload.continuation.draft_spec_reuse.parent_step_attempts, 1);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("fails atomically when a draft changes after the continuation payload is built", () => {
    const fixture = createFixture("draft-stale", { spec: { status: "rejected", verdict: "REJECT" } });
    try {
      const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "draft-stale-next", dryRun: true });
      writeFileSync(join(fixture.runDir, "artifacts", "technical-brief.md"), "changed\n", "utf8");
      assert.throws(
        () => seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, payload.continuation),
        /changed since payload build/u,
      );
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "draft-stale-next")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("refuses draft continuation when the parent spec retry budget is exhausted", () => {
    const fixture = createFixture("draft-exhausted", { spec: { status: "blocked", verdict: "REJECT", attempts: 3 }, maxRetries: 3 });
    try {
      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "draft-exhausted-next", dryRun: true }),
        /retry budget is exhausted/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("does not emit draft reuse metadata for an in-flight parent spec step", () => {
    const fixture = createFixture("draft-running", { spec: { status: "running", verdict: "REJECT", attempts: 1 }, maxRetries: 3 });
    try {
      const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "draft-running-next", dryRun: true });
      assert.equal(payload.continuation.planning_reuse.eligible, false);
      assert.equal(payload.continuation.draft_spec_reuse, undefined);
      assert.equal(seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, payload.continuation).eligible, false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("requires the child spec attempt to continue from the inherited parent attempt", () => {
    const fixture = createFixture("draft-attempt", { spec: { status: "rejected", verdict: "REJECT", attempts: 1 }, maxRetries: 3 });
    try {
      const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "draft-attempt-next", dryRun: true });
      seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, payload.continuation);
      const childRunDir = join(fixture.repo, ".opencode", "factory", "draft-attempt-next");
      writeJson(join(childRunDir, "run.json"), {
        ...childRunFromPayload(payload.continuation),
        steps: [{ agent: "spec-writer", status: "rejected", attempts: 0, artifact_ref: "artifacts/technical-brief.md" }],
      });

      const reset = runCli(fixture.repo, ["factory", "step", "draft-attempt-next", "spec-writer", "running", "--attempts", "1", "--json"]);
      assert.notEqual(reset.status, 0);
      assert.match(reset.stderr, /advance from inherited attempt 1 to 2/u);

      const continued = runCli(fixture.repo, ["factory", "step", "draft-attempt-next", "spec-writer", "running", "--attempts", "2", "--json"]);
      assert.equal(continued.status, 0, continued.stderr);
      const step = JSON.parse(readFileSync(join(childRunDir, "run.json"), "utf8")).steps[0];
      assert.equal(step.status, "running");
      assert.equal(step.attempts, 2);
      assert.equal(step.acceptance, undefined);
      assert.equal(step.inherited_acceptance, undefined);
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
        /missing or not a regular file|parent_artifacts bindings changed/u,
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
      writeJson(join(fixture.runDir, "reviews", "spec-writer.json"), createReviewRecord({ subject: "spec-writer", verdict: "APPROVE", summary: "ok", required_fixes: [] }));
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

  it("preserves accepted -> rejected -> accepted with a fresh binding and atomic failed re-acceptance", () => {
    const fixture = createFixture("bind-clear");
    try {
      writeFileSync(join(fixture.runDir, "artifacts", "technical-brief.md"), "brief\n", "utf8");
      writeJson(join(fixture.runDir, "reviews", "spec-writer.json"), createReviewRecord({ subject: "spec-writer", verdict: "APPROVE", summary: "ok", required_fixes: [] }));
      updateRun(fixture, (run) => {
        run.status = "running";
        run.terminal_result = null;
        run.steps = [{ agent: "spec-writer", status: "running", attempts: 0 }];
      });
      const readStep = () => JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8")).steps[0];

      // accepted(A) → binds
      assert.equal(runCli(fixture.repo, ["factory", "step", fixture.runId, "spec-writer", "accepted", "--artifact-ref", "artifacts/technical-brief.md", "--review-ref", "reviews/spec-writer.json", "--json"]).status, 0);
      const firstHash = readStep().acceptance.artifact_hash;

      // rejected → the prior binding must be cleared (no stale provenance on a non-accepted step)
      assert.equal(runCli(fixture.repo, ["factory", "step", fixture.runId, "spec-writer", "rejected", "--json"]).status, 0);
      assert.equal(readStep().acceptance, undefined, "a non-accepted transition must clear the binding");
      assert.equal(readStep().inherited_acceptance, undefined, "a non-accepted transition must clear inherited acceptance");

      writeFileSync(join(fixture.runDir, "artifacts", "technical-brief.md"), "brief revised\n", "utf8");
      assert.equal(runCli(fixture.repo, ["factory", "step", fixture.runId, "spec-writer", "accepted", "--artifact-ref", "artifacts/technical-brief.md", "--review-ref", "reviews/spec-writer.json", "--json"]).status, 0);
      assert.equal(readStep().status, "accepted");
      assert.notEqual(readStep().acceptance.artifact_hash, firstHash, "re-acceptance must bind the current artifact bytes");
      assert.equal(readStep().acceptance.artifact_hash, hashFile(join(fixture.runDir, "artifacts", "technical-brief.md")));

      assert.equal(runCli(fixture.repo, ["factory", "step", fixture.runId, "spec-writer", "rejected", "--json"]).status, 0);
      const beforeFailed = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      assert.notEqual(runCli(fixture.repo, ["factory", "step", fixture.runId, "spec-writer", "accepted", "--artifact-ref", "artifacts/missing.md", "--json"]).status, 0);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeFailed, "failed acceptance must leave run.json unchanged");
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
      assert.equal(runCli(fixture.repo, ["factory", "step", "adopt-ok-next", "spec-writer", "rejected", "--json"]).status, 0);
      const rejected = JSON.parse(readFileSync(join(child.childRunDir, "run.json"), "utf8")).steps[0];
      assert.equal(rejected.acceptance, undefined);
      assert.equal(rejected.inherited_acceptance, undefined);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rechecks parent and seeded-child adoption authority immediately before run replacement", async () => {
    const cases = [
      ["parent manifest", (fixture) => join(fixture.runDir, "run.json")],
      ["selected parent review", (fixture) => join(fixture.runDir, "reviews", "reviewer.json")],
      ["parent story artifact", (fixture) => join(fixture.runDir, "artifacts", "story.md")],
      ["parent technical brief", (fixture) => join(fixture.runDir, "artifacts", "technical-brief.md")],
      ["parent context evidence", (fixture) => join(fixture.runDir, "evidence", "context.json")],
      ["parent spec review", (fixture) => join(fixture.runDir, "reviews", "spec-writer.json")],
      ["seeded child artifact", (_fixture, child) => join(child.childRunDir, "artifacts", "technical-brief.md")],
      ["seeded child review", (_fixture, child) => join(child.childRunDir, "reviews", "spec-writer.json")],
    ];

    for (const [name, targetFile] of cases) {
      const fixture = createFixture(`adopt-authority-race-${name.replaceAll(" ", "-")}`, { spec: { status: "accepted", verdict: "APPROVE" } });
      try {
        mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
        writeJson(join(fixture.runDir, "evidence", "context.json"), { subject: "spec-writer", status: "pass" });
        updateRun(fixture, (run) => { run.steps[0].evidence_ref = "evidence/context.json"; });
        const child = seedChildForAdopt(fixture, `${fixture.runId}-next`);
        assert.deepEqual(child.continuation.parent_evidence, [{
          kind: "evidence",
          ref: "evidence/context.json",
          hash: hashFile(join(fixture.runDir, "evidence", "context.json")),
        }], `${name} fixture must bind parent context evidence`);
        const childRunFile = join(child.childRunDir, "run.json");
        const childArtifactFile = join(child.childRunDir, "artifacts", "technical-brief.md");
        const childReviewFile = join(child.childRunDir, "reviews", "spec-writer.json");
        const beforeRun = readFileSync(childRunFile, "utf8");
        const beforeArtifact = readFileSync(childArtifactFile, "utf8");
        const beforeReview = readFileSync(childReviewFile, "utf8");
        const target = targetFile(fixture, child);
        const racedBytes = `${readFileSync(target, "utf8")} `;

        await assert.rejects(
          transitionContinuationAdoption(child.childRunDir, {
            repoRoot: gitStdout(fixture.repo, ["rev-parse", "--show-toplevel"]),
            atomicWriteHooks: { beforeCommit: () => writeFileSync(target, racedBytes, "utf8") },
          }),
          /continuation adoption authority changed|continuation parent|selected review|parent_reviews binding|protected file commit failed/u,
          name,
        );
        assert.equal(readFileSync(childRunFile, "utf8"), beforeRun, `${name} must not publish inherited acceptance`);
        assert.equal(readFileSync(target, "utf8"), racedBytes, `${name} mutation must not be silently rolled back`);
        if (target !== childArtifactFile) assert.equal(readFileSync(childArtifactFile, "utf8"), beforeArtifact, `${name} must preserve seeded artifact bytes`);
        if (target !== childReviewFile) assert.equal(readFileSync(childReviewFile, "utf8"), beforeReview, `${name} must preserve seeded review bytes`);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("adopts factory-canonicalized review whitespace without weakening byte or semantic bindings", async () => {
    const runId = "adopt-canonical-review-whitespace";
    const fixture = createFixture(runId, {
      review: createReviewRecord({
        subject: `  ${runId}  `,
        verdict: "  BLOCK  ",
        summary: "  needs canonical continuation  ",
        required_fixes: ["  preserve exact authority bytes  "],
      }),
      spec: { status: "accepted", subject: "  spec-writer  ", verdict: "  APPROVE  " },
    });
    try {
      const canonicalRepo = gitStdout(fixture.repo, ["rev-parse", "--show-toplevel"]);
      const direct = seedChildForAdopt(fixture, `${runId}-direct`);
      assert.equal(direct.continuation.review.subject, runId);
      assert.equal(direct.continuation.review.summary, "needs canonical continuation");
      assert.equal(direct.continuation.review.verdict, "BLOCK");
      assert.deepEqual(direct.continuation.review.required_fixes, ["preserve exact authority bytes"]);
      const directResult = await transitionContinuationAdoption(direct.childRunDir, { repoRoot: canonicalRepo });
      assert.equal(directResult.step.status, "accepted");

      const wrapped = seedChildForAdopt(fixture, `${runId}-wrapped`);
      const wrappedResult = await adoptContinuation(`${runId}-wrapped`, { cwd: fixture.repo });
      assert.equal(wrappedResult.status, "adopted");
      assert.equal(wrappedResult.step.status, "accepted");

      const semanticDrift = seedChildForAdopt(fixture, `${runId}-semantic-drift`);
      const semanticRunFile = join(semanticDrift.childRunDir, "run.json");
      const semanticRun = JSON.parse(readFileSync(semanticRunFile, "utf8"));
      semanticRun.continuation.review.summary = "different canonical meaning";
      writeJson(semanticRunFile, semanticRun);
      await assert.rejects(
        transitionContinuationAdoption(semanticDrift.childRunDir, { repoRoot: canonicalRepo }),
        /selected review summary is stale|selected review identity is stale/u,
      );

      const byteDrift = seedChildForAdopt(fixture, `${runId}-byte-drift`);
      const selectedReviewFile = join(fixture.runDir, "reviews", "reviewer.json");
      writeFileSync(selectedReviewFile, `${readFileSync(selectedReviewFile, "utf8")} `, "utf8");
      await assert.rejects(
        transitionContinuationAdoption(byteDrift.childRunDir, { repoRoot: canonicalRepo }),
        /selected review hash mismatch/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects direct continuation adoption when parent authority disappeared without changing child run.json", async () => {
    const fixture = createFixture("adopt-direct-stale-parent", { spec: { status: "accepted", verdict: "APPROVE" } });
    try {
      const child = seedChildForAdopt(fixture, "adopt-direct-stale-parent-next");
      const childRunFile = join(child.childRunDir, "run.json");
      const before = readFileSync(childRunFile, "utf8");
      rmSync(join(fixture.runDir, "run.json"), { force: true });

      await assert.rejects(
        transitionContinuationAdoption(child.childRunDir),
        /parent run\.json|continuation parent/u,
      );
      assert.equal(readFileSync(childRunFile, "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects direct continuation adoption when selected parent review bytes are stale", async () => {
    const fixture = createFixture("adopt-direct-stale-review", { spec: { status: "accepted", verdict: "APPROVE" } });
    try {
      const child = seedChildForAdopt(fixture, "adopt-direct-stale-review-next");
      const childRunFile = join(child.childRunDir, "run.json");
      const before = readFileSync(childRunFile, "utf8");
      writeJson(join(fixture.runDir, "reviews", "reviewer.json"), createReviewRecord({ subject: fixture.runId, verdict: undefined, required_fixes: undefined, summary: "changed after observation" }));

      await assert.rejects(
        transitionContinuationAdoption(child.childRunDir),
        /selected review hash mismatch|parent_reviews binding is stale/u,
      );
      assert.equal(readFileSync(childRunFile, "utf8"), before);
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

  it("re-observes all eleven continuation catalog authorities before seed effects", () => {
    const cases = [
      {
        id: "continuation-envelope", setup: () => createFixture("authority-envelope"),
        mutate: ({ continuation }) => { continuation.operator_summary = "other run"; }, match: /operator_summary/u,
      },
      {
        id: "continuation-parent-binding", setup: () => createFixture("authority-parent"),
        mutate: ({ fixture }) => updateRun(fixture, (run) => { run.updated_at = "2026-07-08T12:01:00.000Z"; }), match: /parent run\.json changed/u,
      },
      {
        id: "continuation-selected-review", setup: () => createFixture("authority-selected-review"),
        mutate: ({ fixture }) => writeJson(join(fixture.runDir, "reviews", "reviewer.json"), createReviewRecord({ subject: fixture.runId, verdict: undefined, required_fixes: undefined, summary: "changed" })), match: /selected review changed/u,
      },
      {
        id: "continuation-target-binding", setup: () => createFixture("authority-target"),
        mutate: ({ continuation }) => { continuation.target.base_commit = "f".repeat(40); }, match: /target base binding/u,
      },
      {
        id: "continuation-parent-artifact-sidecar", setup: () => createFixture("authority-artifact"),
        mutate: ({ fixture }) => writeFileSync(join(fixture.runDir, "artifacts", "story.md"), "changed story\n"), match: /parent_artifacts bindings changed/u,
      },
      {
        id: "continuation-parent-evidence-sidecar",
        setup: () => {
          const fixture = createFixture("authority-evidence");
          mkdirSync(join(fixture.runDir, "evidence"));
          writeJson(join(fixture.runDir, "evidence", "spec.json"), { subject: "spec-writer", status: "fail" });
          updateRun(fixture, (run) => { run.steps = [{ agent: "spec-writer", status: "blocked", attempts: 1, evidence_ref: "evidence/spec.json" }]; });
          return fixture;
        },
        mutate: ({ fixture }) => writeJson(join(fixture.runDir, "evidence", "spec.json"), { subject: "spec-writer", status: "changed" }), match: /parent_evidence bindings changed/u,
      },
      {
        id: "continuation-parent-review-sidecar",
        setup: () => {
          const fixture = createFixture("authority-parent-review");
          writeJson(join(fixture.runDir, "reviews", "security.json"), createReviewRecord({ subject: fixture.runId, verdict: "BLOCK", summary: "blocked", required_fixes: [] }));
          updateRun(fixture, (run) => { run.security_review = { verdict: "BLOCK", review_ref: "reviews/security.json" }; });
          return fixture;
        },
        mutate: ({ fixture }) => writeJson(join(fixture.runDir, "reviews", "security.json"), createReviewRecord({ subject: fixture.runId, verdict: "BLOCK", summary: "changed", required_fixes: [] })), match: /parent_reviews bindings changed/u,
      },
      {
        id: "continuation-planning-reuse-ineligible", setup: () => createFixture("authority-ineligible"),
        mutate: ({ continuation }) => { continuation.planning_reuse.eligible = true; }, match: /spec_review_ref|planning_reuse/u,
      },
      {
        id: "continuation-planning-reuse-eligible", setup: () => createFixture("authority-eligible", { spec: { status: "accepted", verdict: "APPROVE" } }),
        mutate: ({ continuation }) => { continuation.planning_reuse.spec_artifact_hash = `sha256:${"0".repeat(64)}`; }, match: /planning_reuse binding/u,
      },
      {
        id: "continuation-draft-reuse", setup: () => createFixture("authority-draft", { spec: { status: "rejected", verdict: "REJECT" } }),
        mutate: ({ continuation }) => { continuation.draft_spec_reuse.artifact_hash = `sha256:${"0".repeat(64)}`; }, match: /draft_spec_reuse binding/u,
      },
      {
        id: "continuation-post-pr-binding", setup: () => createFixture("authority-post-pr"),
        mutate: ({ continuation }) => { continuation.post_pr = structuredClone(catalogRecord("continuation-post-pr-binding").source); }, match: /post_pr binding/u,
      },
    ];
    assert.deepEqual(cases.map(({ id }) => id), DURABLE_AUTHORITY_CATALOG.find(({ id }) => id === "continuation-planning-draft-reuse").records.map(({ id }) => id));
    for (const testCase of cases) {
      const fixture = testCase.setup();
      try {
        const childRunId = `${fixture.runId}-next`;
        const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, dryRun: true });
        const continuation = structuredClone(payload.continuation);
        testCase.mutate({ fixture, continuation });
        assert.throws(() => seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, continuation), testCase.match, testCase.id);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false, `${testCase.id} failure must leave child seed absent`);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("rejects every generated continuation mutation that requires checked byte or identity re-observation", () => {
    const records = DURABLE_AUTHORITY_CATALOG.find(({ id }) => id === "continuation-planning-draft-reuse").records;
    let checkedCases = 0;
    for (const record of records) {
      for (const target of record.descriptor.targets) {
        const exclusions = Object.fromEntries(DURABLE_MUTATION_FAMILIES.filter((family) => family !== target.family).map((family) => [family, "isolated target emission"]));
        const mutationCase = emitDurableRecordMutations(record.source, { ...record.descriptor, targets: [target], exclusions }, record.externalSources)[0];
        const catalogFixture = createDurableCatalogBaseline(record);
        const catalogRun = replaceCatalogContinuationRecord(catalogFixture.run, record.canonicalPath, mutationCase.record);
        try {
          validateRun(catalogRun);
          // Structural mutations stop at validateRun; only the cases that remain
          // well-shaped reach the checked seed consumer below.
        } catch {
          continue;
        }

        checkedCases += 1;
        const fixture = createContinuationAuthorityFixture(record.id, checkedCases);
        try {
          const childRunId = `${fixture.runId}-next`;
          const { payload } = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, dryRun: true });
          const continuation = structuredClone(payload.continuation);
          if (record.id === "continuation-post-pr-binding") continuation.post_pr = structuredClone(record.source);
          const actualRecord = continuationRecordAt(continuation, record.canonicalPath);
          if (mutationCase.family === "wrong-bytes") mutateContinuationAuthorityBytes(fixture, continuation, record.id, actualRecord, target);
          else applyCatalogTargetValue(actualRecord, target, mutationCase.record);

          assert.throws(
            () => seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, continuation),
            /continuation|ValidationError|must|binding|changed|stale|cross-bound|hash|review|target/u,
            mutationCase.name,
          );
          assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false, `${mutationCase.name} must leave child seed absent`);
        } finally {
          cleanup(fixture.repo);
        }
      }
    }
    assert.equal(checkedCases, 31, "all 31 structurally valid continuation authority mutations must reach the checked seed consumer");
  });

  it("builds and rechecks one canonical v2 carry-forward in PLAN order without allocating resources", () => {
    const fixture = createV2Fixture("carry-interleaved", { accepted: ["A", "C"], mergeOrder: ["C", "A"] });
    try {
      const result = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "carry-interleaved-next", carryForward: true, dryRun: true });
      const carry = result.candidate.carry_forward;
      assert.equal(result.status, "dry-run");
      assert.equal(result.launchable, false);
      assert.equal(result.payload, undefined);
      assert.equal(result.candidate.schema_version, 2);
      assert.deepEqual(carry, {
        scope: "full-remaining-plan",
        plan_ref: "plan/slices.json",
        plan_hash: hashFile(join(fixture.runDir, "plan", "slices.json")),
        start_commit: fixture.mergeCommits.A,
        accepted_slices: [acceptedManifestRow(fixture, "A"), acceptedManifestRow(fixture, "C")],
        remaining_slice_ids: ["B"],
      });
      assert.deepEqual(fixture.actualMergeOrder, [fixture.mergeCommits.C, fixture.mergeCommits.A]);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "carry-interleaved-next")), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", "carry-interleaved-next")), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "skills", "feature")), false);
      assert.notEqual(spawnSync("git", ["show-ref", "--verify", "refs/heads/carry-interleaved-next"], { cwd: fixture.repo }).status, 0);
      assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "");
      assert.throws(() => seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, result.candidate), /B1\.3 resource transaction/u);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "carry-interleaved-next")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("accepts zero merged slices only when start_commit equals the recorded base", () => {
    const fixture = createV2Fixture("carry-zero", { accepted: [], mergeOrder: [] });
    try {
      const continuation = buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "carry-zero-next", carryForward: true });
      assert.equal(continuation.carry_forward.start_commit, fixture.baseCommit);
      assert.deepEqual(continuation.carry_forward.accepted_slices, []);
      assert.deepEqual(continuation.carry_forward.remaining_slice_ids, ["A", "B", "C"]);

      runGit(fixture.repo, ["commit", "--allow-empty", "-m", "unrecorded parent commit"]);
      updateRun(fixture, (run) => { run.updated_at = "2026-07-08T12:02:00.000Z"; });
      assert.throws(
        () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "carry-zero-drift", carryForward: true }),
        /zero accepted slices requires start_commit equal target\.base_commit/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("privately rejects every v2 closed-shape and partition forgery", () => {
    const cases = [
      ["outer unknown", (value) => { value.carry_forward.extra = true; }],
      ["accepted unknown", (value) => { value.carry_forward.accepted_slices[0].status = "merged"; }],
      ["missing plan hash", (value) => { delete value.carry_forward.plan_hash; }],
      ["duplicate accepted", (value) => { value.carry_forward.accepted_slices.push(structuredClone(value.carry_forward.accepted_slices[0])); }],
      ["duplicate remaining", (value) => { value.carry_forward.remaining_slice_ids.push("B"); }],
      ["partition overlap", (value) => { value.carry_forward.remaining_slice_ids = ["A"]; }],
      ["partition omission", (value) => { value.carry_forward.remaining_slice_ids = ["B"]; }],
      ["partition unknown", (value) => { value.carry_forward.remaining_slice_ids = ["B", "unknown"]; }],
      ["empty remaining", (value) => { value.carry_forward.remaining_slice_ids = []; }],
      ["wrong plan ref", (value) => { value.carry_forward.plan_ref = "plan/other.json"; }],
      ["start mismatch", (value) => { value.carry_forward.start_commit = "d".repeat(40); }],
    ];
    for (const [label, mutate] of cases) {
      const fixture = createV2Fixture(`private-shape-${label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        const candidate = buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true });
        mutate(candidate);
        assert.throws(
          () => assertContinuationBindingsCurrent(fixture.repo, fixture.runDir, candidate),
          /carry_forward|partition|closed shape|candidate/u,
          label,
        );
      } finally { cleanup(fixture.repo); }
    }
  });

  it("fails closed on missing/mutable sidecars, partial successor tuples, non-APPROVE, and plan drift", () => {
    const cases = [
      ["missing evidence", (fixture) => rmSync(join(fixture.runDir, "evidence", "A.json")), /missing parent evidence ref/u],
      ["mutable review", (fixture) => writeFileSync(join(fixture.runDir, "reviews", "A.json"), "{}\n"), /hashes are stale|subject must match/u],
      ["partial successor", (fixture) => updateRun(fixture, (run) => { delete run.slices[0].review_hash; }), /all present or all absent/u],
      ["non approve", (fixture) => {
        const reviewPath = join(fixture.runDir, "reviews", "A.json");
        const review = JSON.parse(readFileSync(reviewPath, "utf8"));
        review.verdict = "REJECT";
        writeJson(reviewPath, review);
        updateRun(fixture, (run) => { run.slices[0].review_hash = hashFile(reviewPath); });
      }, /requires APPROVE review/u],
      ["plan drift", (fixture) => {
        const planPath = join(fixture.runDir, "plan", "slices.json");
        const plan = JSON.parse(readFileSync(planPath, "utf8"));
        plan.slices.splice(1, 1);
        writeJson(planPath, plan);
      }, /exactly classify the bound plan/u],
    ];
    for (const [label, mutate, expected] of cases) {
      const fixture = createV2Fixture(`carry-${label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        mutate(fixture);
        assert.throws(() => buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true }), expected, label);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("rejects non-ancestor, extra, missing, and malformed first-parent merge authority", () => {
    const cases = [
      ["non ancestor", (fixture) => {
        runGit(fixture.repo, ["checkout", "--orphan", "orphan-base"]);
        runGit(fixture.repo, ["rm", "-rf", "."]);
        writeFileSync(join(fixture.repo, "orphan.txt"), "orphan\n");
        runGit(fixture.repo, ["add", "orphan.txt"]);
        runGit(fixture.repo, ["commit", "-m", "orphan"]);
        const orphan = gitStdout(fixture.repo, ["rev-parse", "HEAD"]);
        runGit(fixture.repo, ["checkout", fixture.runId]);
        updateRun(fixture, (run) => { run.base_commit = orphan; });
      }, /not an ancestor|must descend from target\.base_commit/u],
      ["extra", (fixture) => { runGit(fixture.repo, ["commit", "--allow-empty", "-m", "extra"]); }, /all and only accepted merge commits/u],
      ["missing", (fixture) => updateRun(fixture, (run) => { run.slices[0].merge_commit = fixture.baseCommit; }), /all and only accepted merge commits|unique full commits/u],
      ["malformed", (fixture) => updateRun(fixture, (run) => { run.slices[0].reviewed_commit = fixture.baseCommit; }), /sidecar heads must equal reviewed_commit|second parent/u],
    ];
    for (const [label, mutate, expected] of cases) {
      const fixture = createV2Fixture(`chain-${label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        mutate(fixture);
        assert.throws(() => buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true }), expected, label);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("enforces ordered origin-base outcomes", () => {
    const moved = createV2Fixture("origin-moved", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      runGit(moved.repo, ["checkout", "main"]);
      writeFileSync(join(moved.repo, "remote-only.txt"), "moved\n");
      runGit(moved.repo, ["add", "remote-only.txt"]);
      runGit(moved.repo, ["commit", "-m", "move origin"]);
      runGit(moved.repo, ["push", "origin", "main:main"]);
      runGit(moved.repo, ["checkout", moved.runId]);
      assert.throws(() => buildContinuation(moved.runId, { cwd: moved.repo, review: "reviewer.json", runId: "origin-moved-next", carryForward: true }), (error) => error.code === "stale-parent-base-moved");
    } finally { cleanup(moved.repo); }

    const contains = createV2Fixture("origin-contains", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      runGit(contains.repo, ["push", "origin", `${contains.runId}:main`]);
      assert.throws(() => buildContinuation(contains.runId, { cwd: contains.repo, review: "reviewer.json", runId: "origin-contains-next", carryForward: true }), (error) => error.code === "rebaseline-required");
    } finally { cleanup(contains.repo); }

    const unavailable = createV2Fixture("origin-unavailable", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      runGit(unavailable.repo, ["remote", "remove", "origin"]);
      assert.throws(() => buildContinuation(unavailable.runId, { cwd: unavailable.repo, review: "reviewer.json", runId: "origin-unavailable-next", carryForward: true }), (error) => error.code === "origin-base-unavailable");
    } finally { cleanup(unavailable.repo); }
  });

  it("does not mutate process-global FETCH_HEAD while observing origin", () => {
    const fixture = createV2Fixture("origin-fetch-head", { accepted: ["A"], mergeOrder: ["A"] });
    const fetchHead = join(fixture.repo, ".git", "FETCH_HEAD");
    try {
      writeFileSync(fetchHead, "sentinel fetch head\n");
      const commands = [];
      buildContinuation(fixture.runId, {
        cwd: fixture.repo, review: "reviewer.json", runId: "origin-fetch-head-next", carryForward: true,
        originSpawnSync(file, args, options) {
          commands.push([...args]);
          return spawnSync(file, args, options);
        },
      });
      assert.equal(readFileSync(fetchHead, "utf8"), "sentinel fetch head\n");
      const fetches = commands.filter((args) => args[0] === "fetch");
      assert.equal(fetches.length, 2);
      for (const args of fetches) {
        assert.equal(args.includes("--no-write-fetch-head"), true);
        assert.match(args.at(-1), /^[0-9a-f]{40}$/u);
      }
    } finally { cleanup(fixture.repo); }
  });

  it("fails closed for malformed, missing, multiple, and unfetchable origin observations", () => {
    const cases = [
      ["malformed", () => ({ status: 0, stdout: "not-an-oid\trefs/heads/main\n", stderr: "" })],
      ["missing", () => ({ status: 2, stdout: "", stderr: "missing" })],
      ["multiple", () => ({ status: 0, stdout: `${"a".repeat(40)}\trefs/heads/main\n${"b".repeat(40)}\trefs/heads/main\n`, stderr: "" })],
      ["unfetchable", (file, args, options) => args[0] === "fetch" ? { status: 1, stdout: "", stderr: "unfetchable" } : spawnSync(file, args, options)],
    ];
    for (const [label, originSpawnSync] of cases) {
      const fixture = createV2Fixture(`origin-${label}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        assert.throws(
          () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true, originSpawnSync }),
          (error) => error.code === "origin-base-unavailable",
          label,
        );
      } finally { cleanup(fixture.repo); }
    }

    const invalid = createV2Fixture("origin-invalid-ref", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      updateRun(invalid, (run) => { run.base_ref = "refs/remotes/upstream/main"; });
      assert.throws(
        () => buildContinuation(invalid.runId, { cwd: invalid.repo, review: "reviewer.json", runId: "origin-invalid-ref-next", carryForward: true }),
        (error) => error.code === "origin-base-invalid",
      );
    } finally { cleanup(invalid.repo); }
  });

  it("re-observes origin after a deterministic remote race before returning", () => {
    const fixture = createV2Fixture("origin-recheck-race", { accepted: ["A"], mergeOrder: ["A"] });
    let observations = 0;
    try {
      assert.throws(
        () => buildContinuation(fixture.runId, {
          cwd: fixture.repo, review: "reviewer.json", runId: "origin-recheck-race-next", carryForward: true,
          beforeOriginFetch() {
            observations += 1;
            if (observations === 1) runGit(fixture.repo, ["push", "origin", `${fixture.runId}:main`]);
          },
        }),
        (error) => error.code === "rebaseline-required",
      );
      assert.equal(observations, 2);
    } finally { cleanup(fixture.repo); }
  });

  it("rejects nonzero post-PR attempts even in otherwise eligible pre-PR phases", () => {
    for (const phase of ["disabled", "awaiting-pr"]) {
      const fixture = createV2Fixture(`eligibility-${phase}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        updateRun(fixture, (run) => { run.post_pr = continuationEligibilityPostPr(phase, 1); });
        assert.throws(
          () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true }),
          /attempt.*zero|pre-PR/u,
        );
      } finally { cleanup(fixture.repo); }
    }
  });

  it("enforces the complete pre-PR carry-forward eligibility boundary without mutation", () => {
    const cases = [
      ["root pr_url", (run) => { run.pr_url = "https://github.com/acme/repo/pull/7"; }],
      ["terminal pr_url", (run) => { run.terminal_result.pr_url = "https://github.com/acme/repo/pull/7"; }],
      ["steering pr_fence", (run) => { run.steering = continuationEligibilitySteeringFence(); }],
      ["post-pr phase", (run) => { run.post_pr = { ...continuationEligibilityPostPr("awaiting-pr"), phase: "observing" }; }],
      ["disabled nonzero attempt", (run) => { run.post_pr = continuationEligibilityPostPr("disabled", 1); }],
      ["awaiting-pr nonzero attempt", (run) => { run.post_pr = continuationEligibilityPostPr("awaiting-pr", 1); }],
      ["observation", (run) => { run.post_pr = { ...continuationEligibilityPostPr("disabled"), observation: {} }; }],
      ["remediation", (run) => { run.post_pr = { ...continuationEligibilityPostPr("disabled"), remediation: {} }; }],
      ["continuation review", (run) => { run.post_pr = { ...continuationEligibilityPostPr("disabled"), continuation_review: {} }; }],
      ["terminal fact", (run) => { run.post_pr = { ...continuationEligibilityPostPr("disabled"), terminal_fact: {} }; }],
      ["PR operation", (run) => { run.post_pr = { ...continuationEligibilityPostPr("disabled"), pr_operation: {} }; }],
      ["evidence refs", (run) => { run.post_pr = { ...continuationEligibilityPostPr("disabled"), evidence_refs: [{ ref: "evidence/post-pr.json", hash: `sha256:${"a".repeat(64)}` }] }; }],
      ["malformed post-pr", (run) => { run.post_pr = { phase: "disabled", attempt: 0 }; }],
    ];
    for (const [label, mutate] of cases) {
      const fixture = createV2Fixture(`eligibility-${label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        updateRun(fixture, mutate);
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        assert.throws(
          () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true }),
          /pre-PR|post-PR|before PR|ValidationError|requires --new-pr|must|allowed only/u,
          label,
        );
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", `${fixture.runId}-next`)), false, label);
      } finally { cleanup(fixture.repo); }
    }

    for (const phase of ["disabled", "awaiting-pr"]) {
      const fixture = createV2Fixture(`eligible-${phase}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        updateRun(fixture, (run) => { run.post_pr = continuationEligibilityPostPr(phase, 0); });
        const candidate = buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true });
        assert.equal(candidate.carry_forward.remaining_slice_ids.length, 2, phase);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("rejects an all-merged parent because no remaining slice exists", () => {
    const fixture = createV2Fixture("eligibility-all-merged", { accepted: ["A", "B", "C"], mergeOrder: ["A", "B", "C"] });
    try {
      assert.throws(
        () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "eligibility-all-merged-next", carryForward: true }),
        /at least one nonmerged slice/u,
      );
    } finally { cleanup(fixture.repo); }
  });

  it("explicitly fences v2 adoption and resume without changing parent or child state", async () => {
    const fixture = createV2Fixture("v2-consumer-fence", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "v2-consumer-fence-next";
    try {
      const candidate = buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true });
      const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
      mkdirSync(childRunDir, { recursive: true });
      writeJson(join(childRunDir, "run.json"), createRunRecord({
        run_id: childRunId,
        branch: childRunId,
        worktree: candidate.target.worktree,
        continuation: candidate,
      }));
      const parentBefore = readFileSync(join(fixture.runDir, "run.json"));
      const childBefore = readFileSync(join(childRunDir, "run.json"));

      await assert.rejects(adoptContinuation(childRunId, { cwd: fixture.repo }), /before B1\.4 publication/u);
      await assert.rejects(resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true }), /schema_version: must equal 1|carry_forward: is not allowed/u);

      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), parentBefore);
      assert.deepEqual(readFileSync(join(childRunDir, "run.json")), childBefore);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", childRunId)), false);
      assert.notEqual(spawnSync("git", ["show-ref", "--verify", `refs/heads/${childRunId}`], { cwd: fixture.repo }).status, 0);
    } finally { cleanup(fixture.repo); }
  });

  it("rechecks optional panels and deterministic parent/plan/branch mutations before returning", () => {
    const panel = createV2Fixture("carry-panels", { accepted: ["A"], mergeOrder: ["A"], panels: true });
    try {
      const continuation = buildContinuation(panel.runId, { cwd: panel.repo, review: "reviewer.json", runId: "carry-panels-next", carryForward: true });
      assert.equal(continuation.carry_forward.start_commit, panel.mergeCommits.A);
      writeFileSync(join(panel.runDir, "reviews", "security.json"), "{}\n");
      assert.throws(() => buildContinuation(panel.runId, { cwd: panel.repo, review: "reviewer.json", runId: "carry-panels-stale", carryForward: true }), /security.*hash|verdict/u);
    } finally { cleanup(panel.repo); }

    for (const [label, mutate, expected] of [
      ["plan", ({ parentRunDir }) => writeFileSync(join(parentRunDir, "plan", "slices.json"), "{\"slices\":[]}"), /bound plan|plan\/slices\.json|carry_forward/u],
      ["sidecar", ({ parentRunDir }) => writeFileSync(join(parentRunDir, "reviews", "A.json"), "{}\n"), /parent_reviews bindings changed|hashes are stale|subject must match/u],
      ["branch", ({ continuation }) => runGit(continuation.parent.worktree, ["commit", "--allow-empty", "-m", "branch drift"]), /branch\/commit binding is stale/u],
    ]) {
      const fixture = createV2Fixture(`recheck-${label}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        assert.throws(() => buildContinuation(fixture.runId, {
          cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true,
          beforeCarryForwardReturn: mutate,
        }), expected, label);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("atomically allocates the canonical claim, child branch, and exact worktree without semantic publication", async () => {
    const fixture = createV2Fixture("allocation-happy", { accepted: ["A", "C"], mergeOrder: ["C", "A"] });
    const childRunId = "allocation-happy-next";
    const transactions = [];
    try {
      const result = continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        refTransactionSpawnSync(file, args, options) {
          transactions.push({ file, args: [...args], input: String(options.input) });
          return spawnSync(file, args, options);
        },
      });
      const expected = expectedClaim(result.candidate);
      const expectedBytes = canonicalJson(expected.claim);
      const expectedDigest = createHash("sha256").update(canonicalJson(expected.parentIdentity)).digest("hex");
      const zero = "0".repeat(40);

      assert.equal(result.status, "allocated");
      assert.equal(result.launchable, false);
      assert.equal(result.payload, undefined);
      assert.equal(result.claim_ref, `refs/opencode/continuations/${expectedDigest}`);
      assert.equal(result.child_branch_ref, `refs/heads/${childRunId}`);
      assert.equal(result.start_commit, result.candidate.carry_forward.start_commit);
      assert.equal(result.replayed, false);
      assert.equal(result.worktree_recovered, false);
      assert.equal(gitStdout(fixture.repo, ["cat-file", "-t", result.claim_ref]), "blob");
      assert.equal(gitStdoutPreserve(fixture.repo, ["cat-file", "blob", result.claim_ref]), expectedBytes);
      assert.deepEqual(JSON.parse(expectedBytes), expected.claim);
      assert.equal(gitStdout(fixture.repo, ["show-ref", "--verify", "--hash", result.child_branch_ref]), result.start_commit);
      assert.equal(gitStdout(result.worktree, ["rev-parse", "--verify", "HEAD^{commit}"]), result.start_commit);
      assert.equal(gitStdout(result.worktree, ["symbolic-ref", "HEAD"]), result.child_branch_ref);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "skills", "feature")), false);
      assert.equal(transactions.length, 1);
      assert.deepEqual(transactions[0].args, ["update-ref", "--no-deref", "--stdin"]);
      assert.equal(transactions[0].input, [
        "start",
        `verify ${expected.parentIdentity.parent_branch_ref} ${result.start_commit}`,
        `update ${result.claim_ref} ${result.claim_oid} ${zero}`,
        `update ${result.child_branch_ref} ${result.start_commit} ${zero}`,
        "prepare",
        "commit",
        "",
      ].join("\n"));
      await assert.rejects(adoptContinuation(childRunId, { cwd: fixture.repo }), /run not found/u);
      await assert.rejects(resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true }), /run not found/u);
    } finally { cleanup(fixture.repo); }
  });

  it("runs the full final recheck after candidate build and rejects every authority mutation without resources", () => {
    const cases = [
      ["parent", (fixture) => writeFileSync(join(fixture.runDir, "run.json"), `${readFileSync(join(fixture.runDir, "run.json"), "utf8")} `)],
      ["plan", (fixture) => writeFileSync(join(fixture.runDir, "plan", "slices.json"), "{\"slices\":[]}")],
      ["sidecar", (fixture) => writeFileSync(join(fixture.runDir, "reviews", "A.json"), "{}\n")],
      ["branch", (fixture) => runGit(fixture.repo, ["commit", "--allow-empty", "-m", "allocation branch race"])],
      ["origin", (fixture) => {
        runGit(fixture.repo, ["checkout", "main"]);
        runGit(fixture.repo, ["commit", "--allow-empty", "-m", "allocation origin race"]);
        runGit(fixture.repo, ["push", "origin", "main:main"]);
        runGit(fixture.repo, ["checkout", fixture.runId]);
      }],
    ];
    for (const [label, mutate] of cases) {
      const fixture = createV2Fixture(`allocation-recheck-${label}`, { accepted: ["A"], mergeOrder: ["A"] });
      const childRunId = `${fixture.runId}-next`;
      try {
        assert.throws(() => continueFactory(fixture.runId, {
          cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
          beforeRefTransaction: () => mutate(fixture),
        }), /continuation|parent|plan|review|branch|origin|stale/u, label);
        assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "", label);
        assert.equal(refOid(fixture.repo, `refs/heads/${childRunId}`), null, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", childRunId)), false, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false, label);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("atomically rejects a parent branch move after final recheck and before the ref transaction executes", () => {
    const fixture = createV2Fixture("allocation-parent-transaction-race", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "allocation-parent-transaction-race-next";
    const parentRef = `refs/heads/${fixture.runId}`;
    let raced = false;
    try {
      assert.throws(() => continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        refTransactionSpawnSync(file, args, options) {
          if (!raced) {
            raced = true;
            updateRef(fixture.repo, parentRef, fixture.baseCommit);
          }
          return spawnSync(file, args, options);
        },
      }), /parent|transaction|verify|conflict/u);
      assert.equal(raced, true);
      assert.equal(refOid(fixture.repo, parentRef), fixture.baseCommit);
      assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "");
      assert.equal(refOid(fixture.repo, `refs/heads/${childRunId}`), null);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", childRunId)), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false);
    } finally { cleanup(fixture.repo); }
  });

  it("leaves neither ref on a pre-transaction crash and exact-replays both refs after a post-transaction crash", () => {
    const before = createV2Fixture("allocation-crash-before", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      assert.throws(() => continueFactory(before.runId, {
        cwd: before.repo, review: "reviewer.json", runId: "allocation-crash-before-next", carryForward: true,
        beforeRefTransaction: () => { throw new Error("crash before transaction"); },
      }), /crash before transaction/u);
      assert.equal(gitStdout(before.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "");
      assert.equal(refOid(before.repo, "refs/heads/allocation-crash-before-next"), null);
    } finally { cleanup(before.repo); }

    const after = createV2Fixture("allocation-crash-after", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "allocation-crash-after-next";
    let committed;
    try {
      assert.throws(() => continueFactory(after.runId, {
        cwd: after.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
        afterRefTransaction: (state) => { committed = state; throw new Error("crash after transaction"); },
      }), /crash after transaction/u);
      assert.equal(refOid(after.repo, committed.claimRef), committed.claimOid);
      assert.equal(refOid(after.repo, committed.childBranchRef), committed.startCommit);
      assert.equal(existsSync(join(after.repo, ".opencode", "worktrees", childRunId)), false);

      const recovered = continueFactory(after.runId, { cwd: after.repo, review: "reviewer.json", runId: childRunId, carryForward: true });
      assert.equal(recovered.replayed, true);
      assert.equal(recovered.worktree_recovered, false);
      const replay = continueFactory(after.runId, { cwd: after.repo, review: "reviewer.json", runId: childRunId, carryForward: true });
      assert.equal(replay.replayed, true);
      assert.equal(replay.worktree_recovered, true);
      assert.equal(refOid(after.repo, committed.claimRef), committed.claimOid);
      assert.equal(refOid(after.repo, committed.childBranchRef), committed.startCommit);
      assert.equal(gitStdout(replay.worktree, ["rev-parse", "HEAD"]), committed.startCommit);
      assert.equal(existsSync(join(after.repo, ".opencode", "factory", childRunId)), false);
    } finally { cleanup(after.repo); }
  });

  it("exact-replays committed refs after interruption of claim-bound worktree reservation", () => {
    const fixture = createV2Fixture("allocation-worktree-reservation-crash", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "allocation-worktree-reservation-crash-next";
    let reservation;
    try {
      assert.throws(() => continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        afterWorktreeReserve(state) {
          reservation = state;
          throw new Error("interrupted after claim-bound worktree reservation");
        },
      }), /interrupted after claim-bound worktree reservation/u);
      assert.equal(existsSync(reservation.reservationPath), true);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", childRunId)), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false);
      assert.equal(refOid(fixture.repo, `refs/heads/${childRunId}`), fixture.mergeCommits.A);
      assert.notEqual(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "");

      const recovered = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true });
      assert.equal(recovered.replayed, true);
      assert.equal(recovered.worktree_recovered, true);
      assert.equal(gitStdout(recovered.worktree, ["rev-parse", "HEAD"]), fixture.mergeCommits.A);
      assert.equal(existsSync(reservation.reservationPath), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false);
    } finally { cleanup(fixture.repo); }
  });

  it("rejects half states and every non-exact replay without overwriting or repair", () => {
    const cases = [
      ["only claim", ({ repo, expected }) => updateRef(repo, expected.claimRef, writeBlob(repo, canonicalJson(expected.claim)))],
      ["only branch", ({ repo, candidate }) => updateRef(repo, `refs/heads/${candidate.target.run_id}`, candidate.carry_forward.start_commit)],
      ["wrong object", ({ repo, candidate, expected }) => {
        updateRef(repo, expected.claimRef, candidate.carry_forward.start_commit);
        updateRef(repo, expected.claim.child_branch_ref, candidate.carry_forward.start_commit);
      }],
      ["wrong child", ({ repo, candidate, expected }) => {
        const wrong = { ...expected.claim, child_run_id: "different-child" };
        updateRef(repo, expected.claimRef, writeBlob(repo, canonicalJson(wrong)));
        updateRef(repo, expected.claim.child_branch_ref, candidate.carry_forward.start_commit);
      }],
      ["extra field", ({ repo, candidate, expected }) => {
        updateRef(repo, expected.claimRef, writeBlob(repo, canonicalJson({ ...expected.claim, extra: true })));
        updateRef(repo, expected.claim.child_branch_ref, candidate.carry_forward.start_commit);
      }],
      ["missing field", ({ repo, candidate, expected }) => {
        const missing = { ...expected.claim };
        delete missing.start_commit;
        updateRef(repo, expected.claimRef, writeBlob(repo, canonicalJson(missing)));
        updateRef(repo, expected.claim.child_branch_ref, candidate.carry_forward.start_commit);
      }],
      ["noncanonical bytes", ({ repo, candidate, expected }) => {
        updateRef(repo, expected.claimRef, writeBlob(repo, `${JSON.stringify(expected.claim, null, 2)}\n`));
        updateRef(repo, expected.claim.child_branch_ref, candidate.carry_forward.start_commit);
      }],
      ["wrong branch target", ({ repo, fixture, expected }) => {
        updateRef(repo, expected.claimRef, writeBlob(repo, canonicalJson(expected.claim)));
        updateRef(repo, expected.claim.child_branch_ref, fixture.baseCommit);
      }],
    ];
    for (const [label, arrange] of cases) {
      const fixture = createV2Fixture(`allocation-conflict-${label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      const childRunId = `${fixture.runId}-next`;
      try {
        const candidate = buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true });
        const expected = expectedClaim(candidate);
        arrange({ repo: fixture.repo, fixture, candidate, expected });
        const beforeClaim = refOid(fixture.repo, expected.claimRef);
        const beforeBranch = refOid(fixture.repo, expected.claim.child_branch_ref);
        assert.throws(
          () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true }),
          /conflict|only one registered ref/u,
          label,
        );
        assert.equal(refOid(fixture.repo, expected.claimRef), beforeClaim, label);
        assert.equal(refOid(fixture.repo, expected.claim.child_branch_ref), beforeBranch, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", childRunId)), false, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false, label);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("loses deterministic claim or branch races atomically without creating the other ref", () => {
    for (const racedRef of ["claim", "branch"]) {
      const fixture = createV2Fixture(`allocation-race-${racedRef}`, { accepted: ["A"], mergeOrder: ["A"] });
      const childRunId = `${fixture.runId}-next`;
      let expected;
      try {
        assert.throws(() => continueFactory(fixture.runId, {
          cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
          beforeRefTransaction(state) {
            expected = state;
            if (racedRef === "claim") updateRef(fixture.repo, state.claimRef, writeBlob(fixture.repo, "{}"));
            else updateRef(fixture.repo, state.childBranchRef, fixture.baseCommit);
          },
        }), /transaction conflicted|only one registered ref|conflict/u, racedRef);
        const claim = refOid(fixture.repo, expected.claimRef);
        const branch = refOid(fixture.repo, expected.childBranchRef);
        if (racedRef === "claim") {
          assert.equal(claim, writeBlob(fixture.repo, "{}"));
          assert.equal(branch, null);
        } else {
          assert.equal(claim, null);
          assert.equal(branch, fixture.baseCommit);
        }
        assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", childRunId)), false);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("preserves a foreign target worktree and the committed claim tombstone on worktree conflict", () => {
    const fixture = createV2Fixture("allocation-foreign-worktree", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "allocation-foreign-worktree-next";
    const target = join(fixture.repo, ".opencode", "worktrees", childRunId);
    try {
      const candidate = buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true });
      const expected = expectedClaim(candidate);
      runGit(fixture.repo, ["worktree", "add", target, "main"]);

      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true }),
        /worktree conflicts|branch-mismatch/u,
      );
      assert.equal(gitStdout(target, ["symbolic-ref", "HEAD"]), "refs/heads/main");
      assert.equal(gitStdout(target, ["rev-parse", "HEAD"]), fixture.baseCommit);
      assert.equal(refOid(fixture.repo, expected.claimRef), writeBlob(fixture.repo, canonicalJson(expected.claim)));
      assert.equal(refOid(fixture.repo, expected.claim.child_branch_ref), candidate.carry_forward.start_commit);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false);
    } finally { cleanup(fixture.repo); }
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

function createFixture(runId, { status = "blocked", createBranch = true, review, spec, maxRetries } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "factory-continue-"));
  initGitRepo(repo);
  if (createBranch) runGit(repo, ["branch", runId]);
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "story.md"), "story\n", "utf8");
  writeJson(join(runDir, "reviews", "reviewer.json"), review || createReviewRecord({ subject: runId, verdict: undefined, required_fixes: undefined, summary: "needs continuation" }));
  const run = createRunRecord({
    run_id: runId,
    status,
    branch: runId,
    worktree: join(repo, ".opencode", "worktrees", runId),
    validator: { verdict: "NO-GO", review_ref: "reviews/reviewer.json" },
    terminal_result: status === "blocked" ? { status: "blocked", run_id: runId, reason: "review blocked", summary: "blocked", artifacts: {} } : null,
  });
  if (maxRetries !== undefined) run.max_retries = maxRetries;
  if (spec) {
    writeFileSync(join(runDir, "artifacts", "technical-brief.md"), spec.brief ?? "brief\n", "utf8");
    writeJson(join(runDir, "reviews", "spec-writer.json"), createReviewRecord({ subject: spec.subject ?? "spec-writer", verdict: spec.verdict, summary: spec.summary ?? "spec review", required_fixes: [] }));
    const step = { agent: "spec-writer", status: spec.status, attempts: spec.attempts ?? 1, artifact_ref: "artifacts/technical-brief.md", review_ref: "reviews/spec-writer.json" };
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

function createV2Fixture(runId, { accepted = ["A"], mergeOrder = accepted, panels = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "factory-carry-forward-"));
  initGitRepo(repo);
  const origin = join(repo, ".git", "test-origin.git");
  runGit(repo, ["init", "--bare", origin]);
  runGit(repo, ["remote", "add", "origin", origin]);
  runGit(repo, ["push", "origin", "main:main"]);
  const baseCommit = gitStdout(repo, ["rev-parse", "main^{commit}"]);
  runGit(repo, ["checkout", "-b", runId, baseCommit]);

  const reviewedCommits = {};
  const mergeCommits = {};
  for (const id of accepted) {
    runGit(repo, ["checkout", "-b", `${runId}--${id}`, baseCommit]);
    writeFileSync(join(repo, `${id}.txt`), `${id}\n`);
    runGit(repo, ["add", `${id}.txt`]);
    runGit(repo, ["commit", "-m", `reviewed ${id}`]);
    reviewedCommits[id] = gitStdout(repo, ["rev-parse", "HEAD"]);
  }
  runGit(repo, ["checkout", runId]);
  for (const id of mergeOrder) {
    runGit(repo, ["merge", "--no-ff", "--no-edit", `${runId}--${id}`]);
    mergeCommits[id] = gitStdout(repo, ["rev-parse", "HEAD"]);
  }

  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "evidence"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  mkdirSync(join(runDir, "plan"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "story.md"), "story\n");
  writeJson(join(runDir, "reviews", "reviewer.json"), createReviewRecord({ subject: runId, verdict: undefined, required_fixes: undefined, summary: "needs continuation" }));
  const plan = {
    slices: [
      { id: "A", stack: "backend", paths: ["A.txt"], depends_on: [], acceptance: ["A accepted"], test_plan: ["test A"] },
      { id: "B", stack: "backend", paths: ["B.txt"], depends_on: ["A"], acceptance: ["B accepted"], test_plan: ["test B"] },
      { id: "C", stack: "backend", paths: ["C.txt"], depends_on: [], acceptance: ["C accepted"], test_plan: ["test C"] },
    ],
  };
  writeJson(join(runDir, "plan", "slices.json"), plan);

  const slices = plan.slices.map((planned) => {
    if (!accepted.includes(planned.id)) return { id: planned.id, stack: planned.stack, depends_on: planned.depends_on, status: "pending", attempts: 0 };
    const evidenceRef = `evidence/${planned.id}.json`;
    const reviewRef = `reviews/${planned.id}.json`;
    writeJson(join(runDir, evidenceRef), { subject: planned.id, attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommits[planned.id] });
    writeJson(join(runDir, reviewRef), { subject: planned.id, attempt: 1, verdict: "APPROVE", reviewed_commit: reviewedCommits[planned.id] });
    return {
      id: planned.id, stack: planned.stack, depends_on: planned.depends_on, status: "merged", attempts: 1,
      evidence_ref: evidenceRef, evidence_hash: hashFile(join(runDir, evidenceRef)),
      review_ref: reviewRef, review_hash: hashFile(join(runDir, reviewRef)),
      reviewed_commit: reviewedCommits[planned.id], merge_commit: mergeCommits[planned.id],
    };
  });
  const run = createRunRecord({
    run_id: runId,
    status: "blocked",
    base_ref: "main",
    base_commit: baseCommit,
    branch: runId,
    worktree: repo,
    slices,
    validator: { verdict: "NO-GO", review_ref: "reviews/reviewer.json" },
    terminal_result: { status: "blocked", run_id: runId, reason: "review blocked", summary: "blocked", artifacts: {} },
  });
  if (panels) {
    const startCommit = gitStdout(repo, ["rev-parse", `${runId}^{commit}`]);
    writeFileSync(join(runDir, "artifacts", "validation-report.md"), "validation\n");
    writeJson(join(runDir, "reviews", "reviewer.json"), { subject: runId, attempt: 1, verdict: "NO-GO", reviewed_head_sha: startCommit, summary: "needs continuation" });
    writeJson(join(runDir, "reviews", "security.json"), { subject: runId, attempt: 1, verdict: "BLOCK", reviewed_head_sha: startCommit });
    run.validator = {
      verdict: "NO-GO", report: "artifacts/validation-report.md", review_ref: "reviews/reviewer.json",
      report_hash: hashFile(join(runDir, "artifacts", "validation-report.md")), review_hash: hashFile(join(runDir, "reviews", "reviewer.json")), reviewed_head_sha: startCommit,
    };
    run.security_review = { verdict: "BLOCK", review_ref: "reviews/security.json", review_hash: hashFile(join(runDir, "reviews", "security.json")), reviewed_head_sha: startCommit };
  }
  writeJson(join(runDir, "run.json"), run);
  const actualMergeOrder = gitStdout(repo, ["rev-list", "--first-parent", "--reverse", `${baseCommit}..${runId}`]).split("\n").filter(Boolean);
  return { repo, runDir, runId, baseCommit, reviewedCommits, mergeCommits, actualMergeOrder };
}

function acceptedManifestRow(fixture, id) {
  const run = JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8"));
  const slice = run.slices.find((candidate) => candidate.id === id);
  return {
    id, attempts: slice.attempts,
    evidence_ref: slice.evidence_ref, evidence_hash: slice.evidence_hash,
    review_ref: slice.review_ref, review_hash: slice.review_hash,
    reviewed_commit: slice.reviewed_commit, merge_commit: slice.merge_commit,
  };
}

function continuationEligibilityPostPr(phase, attempt = 0) {
  return {
    schema_version: 1,
    policy: {
      enabled: phase !== "disabled",
      wait_ms: 3_600_000,
      initial_poll_ms: 30_000,
      max_poll_ms: 120_000,
      check_start_grace_ms: 300_000,
      max_transient_errors: 12,
      review: { required: false, reviewer_login: null, source: "none" },
    },
    phase,
    attempt,
    observation: null,
    remediation: null,
    evidence_refs: [],
    continuation_review: null,
    terminal_fact: null,
    pr_operation: null,
  };
}

function continuationEligibilitySteeringFence() {
  return {
    schema_version: 1,
    generation: 0,
    pending: null,
    uncheckpointed: null,
    boundary: null,
    action_claim: null,
    last_action: null,
    pr_fence: { token: "pre-pr-token", generation: 0, state_hash: `sha256:${"a".repeat(64)}`, created_at: "2026-07-08T12:00:00.000Z" },
    history: [],
  };
}

// Every fixture (createFixture and createV2Fixture) starts from the identical
// init + config + README-commit repo, so it is built once per process and
// copied per fixture; five git subprocesses per fixture become one recursive
// copy. The copied .git carries the committed identity forward, so later
// commits in a fixture use the same author. The template is never handed to a
// test and is removed at process end.
let gitRepoTemplate = null;

function gitRepoTemplate_() {
  if (!gitRepoTemplate) {
    const repo = mkdtempSync(join(tmpdir(), "factory-continue-template-"));
    runGit(repo, ["init", "-b", "main"]);
    runGit(repo, ["config", "user.email", "test@example.com"]);
    runGit(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "README.md"), "test\n", "utf8");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "init"]);
    gitRepoTemplate = repo;
  }
  return gitRepoTemplate;
}

after(() => { if (gitRepoTemplate) rmSync(gitRepoTemplate, { recursive: true, force: true }); });

function initGitRepo(repo) {
  cpSync(gitRepoTemplate_(), repo, { recursive: true });
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

function gitStdoutPreserve(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout;
}

function expectedClaim(candidate) {
  const parentIdentity = {
    schema_version: 2,
    kind: "blocked-run-continuation-parent",
    parent_run_id: candidate.parent.run_id,
    parent_run_ref: candidate.parent.run_ref,
    parent_run_hash: candidate.parent.run_hash,
    parent_branch_ref: `refs/heads/${candidate.parent.branch}`,
    target_base_ref: candidate.target.base_ref,
    target_base_commit: candidate.target.base_commit,
    plan_ref: candidate.carry_forward.plan_ref,
    plan_hash: candidate.carry_forward.plan_hash,
    start_commit: candidate.carry_forward.start_commit,
  };
  const claimRef = `refs/opencode/continuations/${createHash("sha256").update(canonicalJson(parentIdentity)).digest("hex")}`;
  return {
    parentIdentity,
    claimRef,
    claim: {
      schema_version: 2,
      kind: "blocked-run-continuation-claim",
      parent_identity: parentIdentity,
      child_run_id: candidate.target.run_id,
      child_branch_ref: `refs/heads/${candidate.target.branch}`,
      start_commit: candidate.carry_forward.start_commit,
    },
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function writeBlob(repo, bytes) {
  const proc = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: repo,
    encoding: "utf8",
    input: bytes,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

function updateRef(repo, ref, oid) {
  runGit(repo, ["update-ref", ref, oid]);
}

function refOid(repo, ref) {
  const proc = spawnSync("git", ["show-ref", "--verify", "--hash", ref], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  return proc.status === 0 ? proc.stdout.trim() : null;
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
  return createRunRecord({
    run_id: continuation.target.run_id,
    branch: continuation.target.branch,
    worktree: continuation.target.worktree,
    ...(continuation.draft_spec_reuse ? { max_retries: continuation.draft_spec_reuse.max_retries } : {}),
    continuation,
  });
}

function catalogRecord(id) {
  return DURABLE_AUTHORITY_CATALOG.flatMap((authorityClass) => authorityClass.records).find((record) => record.id === id);
}

function createContinuationAuthorityFixture(recordId, index) {
  const spec = recordId === "continuation-draft-reuse"
    ? { status: "rejected", verdict: "REJECT" }
    : recordId === "continuation-planning-reuse-ineligible" || recordId === "continuation-post-pr-binding"
      ? undefined
      : { status: "accepted", verdict: "APPROVE" };
  const fixture = createFixture(`catalog-consumer-${index}`, { spec });
  mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
  writeJson(join(fixture.runDir, "evidence", "context.json"), { subject: "spec-writer", status: "fail" });
  writeJson(join(fixture.runDir, "reviews", "security.json"), createReviewRecord({ subject: fixture.runId, verdict: "BLOCK", summary: "blocked", required_fixes: [] }));
  updateRun(fixture, (run) => {
    run.security_review = { verdict: "BLOCK", review_ref: "reviews/security.json" };
    if (run.steps?.[0]) run.steps[0].evidence_ref = "evidence/context.json";
    else run.steps = [{ agent: "context-reader", status: "blocked", attempts: 1, evidence_ref: "evidence/context.json" }];
  });
  return fixture;
}

function replaceCatalogContinuationRecord(run, canonicalPath, value) {
  const next = structuredClone(run);
  let owner = next;
  for (const segment of canonicalPath.slice(0, -1)) owner = owner[segment];
  owner[canonicalPath.at(-1)] = structuredClone(value);
  return next;
}

function continuationRecordAt(continuation, canonicalPath) {
  if (canonicalPath.length === 1) return continuation;
  let value = continuation;
  for (const segment of canonicalPath.slice(1)) value = value[segment];
  return value;
}

function applyCatalogTargetValue(actualRecord, target, mutatedCatalogRecord) {
  const value = valueAtPath(mutatedCatalogRecord, target.path);
  let owner = actualRecord;
  for (const segment of target.path.slice(0, -1)) owner = owner[segment];
  owner[target.path.at(-1)] = structuredClone(value);
}

function valueAtPath(value, path) {
  let current = value;
  for (const segment of path) current = current[segment];
  return current;
}

function mutateContinuationAuthorityBytes(fixture, continuation, recordId, actualRecord, target) {
  let ref;
  if (target.sidecar === "parent-run") {
    const file = join(fixture.runDir, "run.json");
    writeFileSync(file, `${readFileSync(file, "utf8")} `, "utf8");
    return;
  }
  if (target.sidecar === "selected-review") ref = continuation.review.ref;
  else if (recordId === "continuation-planning-reuse-eligible" && target.sidecar === "review") ref = continuation.planning_reuse.spec_review_ref;
  else if (recordId === "continuation-planning-reuse-eligible" && target.sidecar === "artifact") ref = continuation.planning_reuse.spec_artifact_ref;
  else if (recordId === "continuation-draft-reuse") ref = continuation.draft_spec_reuse.artifact_ref;
  else ref = actualRecord?.ref;
  if (!ref || recordId === "continuation-post-pr-binding") return;
  writeFileSync(join(fixture.runDir, ref), "tampered-sidecar-bytes", "utf8");
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
