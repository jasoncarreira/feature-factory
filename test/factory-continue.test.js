import { after, describe, it as nodeIt } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "./helpers/git-fixture.js";
import { createReviewRecord } from "./helpers/review-record-fixture.js";
import { createRunRecord } from "./helpers/run-record-fixture.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { assertContinuationBindingsCurrent, buildContinuation, continueFactory, persistFactoryRunResumeEnv, recoverDisruptedRun, resumeFactory, startFactory } from "../src/factory.js";
import { validateRun } from "../src/validate.js";
import { assertContinuationReservationAuthority, assertPublishedCarryForwardRun, completeSliceBuilderTaskDispatch, completeSpecialBuilderTaskDispatch, prepareSliceBuilderTaskDispatch, prepareSpecialBuilderTaskDispatch, transitionContinuationAdoption, transitionPanelVerdicts, transitionPrePrFenceEstablished, transitionPrCreated, transitionRunSlice, transitionSliceMerged } from "../src/run-state.js";
import { DURABLE_AUTHORITY_CATALOG, DURABLE_MUTATION_FAMILIES, ISSUE128_BASELINE_ROUTE_INVENTORY, ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG, createDurableCatalogBaseline, emitDurableRecordMutations, emitIssue128FinishAndDiscloseMutations } from "./helpers/durable-record-mutations.js";
import { decodeFeatureCommandPayload } from "../src/feature-command-payload.js";
import { executeCheckedTestExecution } from "../src/test-execution.js";
import { deliveryEnvelopeForSlices, passingInvariantFamilyLedger, withDeliveryEnvelope, writeVerificationArtifactReceipt } from "./helpers/delivery-envelope-fixture.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const currentTestPath = fileURLToPath(import.meta.url);
const issue128WorkerEnv = "OPENCODE_ISSUE128_CONTINUATION_WORKER";
const issue128WorkerChunkEnv = "OPENCODE_ISSUE128_CONTINUATION_CHUNK";
const issue128WorkerChunkCount = 2;
const issue128WorkerTests = Object.freeze({
  "ordinary-continuation": "preserves an ordinary merged A2/S2 row only with its same-binding merged owner",
  "checkpoint-continuation": "preserves a checkpoint-bound merged A2/S2 owner pair and rejects owner drift before publication",
});
const issue128WorkerRecords = Object.freeze({
  "ordinary-continuation": "continuation-carry-forward-accepted-slice-v2",
  "checkpoint-continuation": "checkpoint-carry-forward-accepted-slice-v2",
});
const issue128WorkerRoute = process.env[issue128WorkerEnv] || null;
let currentContinuationTests = false;
const it = (...args) => (currentContinuationTests ? nodeIt : nodeIt.skip)(...args);
if (issue128WorkerRoute !== null && !Object.hasOwn(issue128WorkerTests, issue128WorkerRoute)) {
  throw new Error(`unsupported ${issue128WorkerEnv} route '${issue128WorkerRoute}'`);
}
const issue128WorkerChunkText = process.env[issue128WorkerChunkEnv];
if (issue128WorkerRoute === null && issue128WorkerChunkText !== undefined) {
  throw new Error(`${issue128WorkerChunkEnv} requires ${issue128WorkerEnv}`);
}
if (issue128WorkerRoute !== null && !/^(0|[1-9]\d*)$/u.test(issue128WorkerChunkText || "")) {
  throw new Error(`${issue128WorkerChunkEnv} must be an integer chunk index`);
}
const issue128WorkerChunk = issue128WorkerRoute === null ? null : Number(issue128WorkerChunkText);
if (issue128WorkerChunk !== null && issue128WorkerChunk >= issue128WorkerChunkCount) {
  throw new Error(`${issue128WorkerChunkEnv} must be less than ${issue128WorkerChunkCount}`);
}

describe("factory continue", () => {
  it("rejects a blocked parent that carries an unresolved builder dispatch", () => {
    const fixture = createFixture("blocked-unresolved-dispatch");
    try {
      const head = gitStdout(fixture.repo, ["rev-parse", `${fixture.runId}^{commit}`]);
      const worktree = join(fixture.repo, ".opencode", "worktrees", fixture.runId);
      updateRun(fixture, (run) => {
        run.slices = [{ id: "slice", stack: "backend", depends_on: [], declared_paths: ["slice.txt"], effective_paths: ["slice.txt"], status: "running", attempts: 1, branch: fixture.runId, worktree, dispatch_required: true }];
      });
      const claimStem = createHash("sha256").update(`${fixture.runId}\0slice\0${1}`, "utf8").digest("hex");
      mkdirSync(join(fixture.runDir, "dispatch"), { recursive: true });
      writeJson(join(fixture.runDir, "dispatch", `${claimStem}.json`), {
        schema_version: 1,
        kind: "checked-slice-builder-dispatch-claim",
        run_id: fixture.runId,
        slice_id: "slice",
        attempt: 1,
        agent: "backend-builder",
        branch: fixture.runId,
        worktree,
        head,
        context_hash: `sha256:${"1".repeat(64)}`,
        completion_token_hash: `sha256:${"2".repeat(64)}`,
        claimed_at: "2026-07-18T12:00:00.000Z",
        closure_ref: `dispatch/${claimStem}.closed.json`,
      });

      assert.throws(
        () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "blocked-unresolved-dispatch-next" }),
        /unresolved checked slice builder Task dispatch/u,
      );
    } finally { cleanup(fixture.repo); }
  });

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

  it("derives continuation context from an approving review without prose", async () => {
    const fixture = createFixture("approved-review", {
      review: createReviewRecord({ subject: "approved-review" }),
      spec: { status: "accepted", verdict: "APPROVE" },
    });
    try {
      const result = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "approved-review-next", dryRun: true });

      assert.equal(result.payload.continuation.review.verdict, "APPROVE");
      assert.equal(result.payload.continuation.review.summary, "Review recorded APPROVE for approved-review.");
      assert.deepEqual(result.payload.continuation.review.required_fixes, []);
      assert.doesNotThrow(() => validateRun(childRunFromPayload(result.payload.continuation)));

      const adoptResult = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "approved-review-adopt-next", dryRun: true });
      seedContinuationPlanningArtifacts(fixture.repo, fixture.runDir, adoptResult.payload.continuation);
      const childRunDir = join(fixture.repo, ".opencode", "factory", "approved-review-adopt-next");
      writeJson(join(childRunDir, "run.json"), childRunFromPayload(adoptResult.payload.continuation));
      await assert.doesNotReject(transitionContinuationAdoption(childRunDir, { repoRoot: gitStdout(fixture.repo, ["rev-parse", "--show-toplevel"]) }));
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
          run.slices = [{ id: "api-slice", declared_paths: ["api-slice.txt"], effective_paths: ["api-slice.txt"], status: "blocked", attempts: 0, review_ref: "reviews/api-slice-review.json", blocked_reason: "slice review blocks continuation" }];
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
        run.slices = [{ id: "api-slice", declared_paths: ["api-slice.txt"], effective_paths: ["api-slice.txt"], status: "blocked", attempts: 0, evidence_ref: "evidence/a-slice.json", blocked_reason: "slice evidence blocks continuation" }];
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

describe("continuation planning-artifact reuse", { concurrency: 2 }, () => {
  // Overlap the isolated matrices with independent fixture tests instead of extending the file's serial tail.
  currentContinuationTests = true;
  it("runs ordinary and checkpoint continuation mutation workers concurrently", { skip: issue128WorkerRoute !== null }, async () => {
    const workers = Object.entries(issue128WorkerTests).flatMap(([route, testName]) =>
      Array.from({ length: issue128WorkerChunkCount }, (_, chunk) => runIssue128ContinuationWorker(route, testName, chunk)));
    const results = await Promise.all(workers);
    for (const result of results) {
      const diagnostics = issue128WorkerDiagnostics(result);
      assert.equal(result.error, null, diagnostics);
      assert.equal(result.signal, null, diagnostics);
      assert.equal(result.code, 0, diagnostics);
      result.completion = parseIssue128WorkerCompletion(result.stdout, diagnostics);
      assert.equal(result.completion.route, result.route, diagnostics);
      assert.equal(result.completion.chunk, result.chunk, diagnostics);
      assert.equal(result.completion.chunk_count, issue128WorkerChunkCount, diagnostics);
      assert.deepEqual(result.completion.baseline_ids, result.chunk === 0 ? issue128BaselineIdsForRoute(result.route) : [], diagnostics);
      assert.equal(result.completion.executed, result.completion.mutation_names.length, diagnostics);
      assert.equal(result.completion.mutation_digest, issue128MutationNameDigest(result.completion.mutation_names), diagnostics);
    }
    for (const route of Object.keys(issue128WorkerTests)) {
      const routeCompletions = results.filter((result) => result.route === route).map(({ completion }) => completion);
      assert.deepEqual(routeCompletions.map(({ chunk }) => chunk).sort((a, b) => a - b), [0, 1], `${route}: exact worker chunks`);
      assert.equal(routeCompletions.reduce((sum, { executed }) => sum + executed, 0), 178, `${route}: exact executed mutation count`);
      const expectedNames = issue128MutationNamesForRoute(route);
      assert.equal(expectedNames.length, 178, `${route}: exact emitted mutation count`);
      const observedNames = routeCompletions.flatMap(({ mutation_names: names }) => names);
      assert.equal(new Set(observedNames).size, observedNames.length, `${route}: no duplicate mutation names across chunks`);
      assert.deepEqual([...observedNames].sort(), [...expectedNames].sort(), `${route}: no missing or unexpected mutation names`);
      const observedByName = new Set(observedNames);
      assert.equal(issue128MutationNameDigest(expectedNames.filter((name) => observedByName.has(name))), issue128MutationNameDigest(expectedNames), `${route}: exact emitter-order mutation digest`);
    }
    const expectedBaselineIds = Object.keys(issue128WorkerTests).flatMap(issue128BaselineIdsForRoute);
    const observedBaselineIds = results.flatMap(({ completion }) => completion.baseline_ids);
    assert.equal(new Set(observedBaselineIds).size, observedBaselineIds.length, "no duplicate continuation baseline IDs across chunks or routes");
    assert.deepEqual([...observedBaselineIds].sort(), [...expectedBaselineIds].sort(), "no missing or unexpected continuation baseline IDs");
  });

  currentContinuationTests = false;
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

  currentContinuationTests = true;
  it("rejects every non-v2 continuation selector before reservation or child effects", () => {
    const fixture = createV2Fixture("carry-current-route-only", { accepted: ["A"], mergeOrder: ["A"] });
    const targetRunId = "carry-current-route-only-next";
    try {
      for (const invoke of [
        () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: targetRunId }),
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: targetRunId, dryRun: true }),
      ]) assert.throws(invoke, /requires --carry-forward/u);

      const cli = runCli(fixture.repo, ["factory", "continue", fixture.runId, "--review", "reviewer.json", "--run-id", targetRunId, "--dry-run", "--json"]);
      assert.equal(cli.status, 1);
      assert.equal(cli.stdout, "");
      assert.equal(cli.stderr, "error: factory continue requires --carry-forward\n");
      assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuation-targets"]), "");
      assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "");
      assert.equal(refOid(fixture.repo, `refs/heads/${targetRunId}`), null);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", targetRunId)), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", targetRunId)), false);
    } finally { cleanup(fixture.repo); }
  });

  it("rejects v1 and incomplete continuation payloads before route authority lookup", () => {
    const fixture = createV2Fixture("carry-payload-current-only", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      const continuation = buildContinuation(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: "carry-payload-current-only-next",
        carryForward: true,
      });
      const envelope = (value) => `ffpayload-v1:${Buffer.from(JSON.stringify({
        operator_request: `Continue blocked feature-factory run '${fixture.runId}' as '${value.target.run_id}' using review '${value.review.ref}'.`,
        driver: { mode: "interactive", pr_mode: "ready", post_pr_ci: { enabled: false } },
        continuation: value,
      })).toString("base64url")}`;
      const cases = [
        ["v1", (value) => { value.schema_version = 1; }, "invalid-continuation-schema"],
        ["missing carry-forward", (value) => { delete value.carry_forward; }, "invalid-continuation-carry-forward"],
        ["missing configuration", (value) => { delete value.configuration; }, "invalid-continuation-schema"],
        ["retired draft", (value) => { value.draft_spec_reuse = {}; }, "invalid-continuation"],
        ["retired post-PR", (value) => { value.post_pr = {}; }, "invalid-continuation"],
      ];
      assert.equal(cases.length, 5);
      for (const [label, mutate, reason] of cases) {
        const value = structuredClone(continuation);
        mutate(value);
        assert.deepEqual(decodeFeatureCommandPayload(envelope(value), { repo: fixture.repo }), { ok: false, reason }, label);
      }
      assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuation-targets"]), "");
    } finally { cleanup(fixture.repo); }
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
      assert.deepEqual(JSON.parse(readFileSync(join(fixture.runDir, "plan", "slices.json"), "utf8")).integration_gate.required_commands, [
        { program: "npm", args: ["run", "check"] },
      ]);
      assert.deepEqual(fixture.actualMergeOrder, [fixture.mergeCommits.C, fixture.mergeCommits.A]);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "carry-interleaved-next")), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", "carry-interleaved-next")), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "skills", "feature")), false);
      assert.notEqual(spawnSync("git", ["show-ref", "--verify", "refs/heads/carry-interleaved-next"], { cwd: fixture.repo }).status, 0);
      assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "");
      const cli = runCli(fixture.repo, ["factory", "continue", fixture.runId, "--review", "reviewer.json", "--run-id", "carry-interleaved-cli", "--carry-forward", "--dry-run", "--json"]);
      assert.equal(cli.status, 0, cli.stderr);
      const cliResult = JSON.parse(cli.stdout);
      assert.equal(cliResult.candidate.schema_version, 2);
      assert.equal(cliResult.launchable, false);
      assert.deepEqual(cliResult.candidate.configuration, {
        mode: "interactive", github_account: null, pr_mode: "ready", max_parallel_slices: 3, max_retries: 3,
        post_pr_policy: continuationEligibilityPostPr("disabled", 0).policy,
      });
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "carry-interleaved-cli")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("carries a conflict-merged slice with exact proof sidecars and rejects every tamper", async () => {
    const fixture = await createConflictCarryForwardFixture("carry-conflict-proof");
    const childRunId = "carry-conflict-proof-next";
    try {
      const candidate = buildContinuation(fixture.runId, { cwd: fixture.repo, review: fixture.continuationReviewRef, runId: childRunId, carryForward: true });
      const accepted = candidate.carry_forward.accepted_slices[0];
      assert.deepEqual(accepted.integration_conflict, fixture.conflict);

      for (const [label, mutate, expected] of [
        ["claim bytes", () => writeFileSync(join(fixture.runDir, fixture.conflict.claim_ref), "{}\n"), /special builder|conflict.*claim|dispatch.*claim|hash.*stale/u],
        ["closure bytes", () => writeFileSync(join(fixture.runDir, fixture.conflict.closure_ref), "{}\n"), /special builder|conflict.*closure|dispatch.*closure|hash.*stale/u],
        ["proof bytes", () => updateRun(fixture, (run) => { run.slices[0].integration_conflict.integration_proof.integrated_tree = "f".repeat(40); }), /integrated bytes changed|conflict.*proof/u],
      ]) {
        const claimBytes = readFileSync(join(fixture.runDir, fixture.conflict.claim_ref));
        const closureBytes = readFileSync(join(fixture.runDir, fixture.conflict.closure_ref));
        const runBytes = readFileSync(join(fixture.runDir, "run.json"));
        mutate();
        assert.throws(
          () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: fixture.continuationReviewRef, runId: `${childRunId}-${label.replaceAll(" ", "-")}`, carryForward: true }),
          expected,
          label,
        );
        writeFileSync(join(fixture.runDir, fixture.conflict.claim_ref), claimBytes);
        writeFileSync(join(fixture.runDir, fixture.conflict.closure_ref), closureBytes);
        writeFileSync(join(fixture.runDir, "run.json"), runBytes);
      }

      const result = await continueFactory(fixture.runId, {
        cwd: fixture.repo, review: fixture.continuationReviewRef, runId: childRunId, carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started", run_id: childRunId }),
      });
      const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const child = JSON.parse(readFileSync(join(childRunDir, "run.json"), "utf8"));
      assert.deepEqual(child.slices[0].integration_conflict, fixture.conflict);
      for (const ref of [fixture.conflict.claim_ref, fixture.conflict.closure_ref]) {
        assert.deepEqual(readFileSync(join(childRunDir, ref)), readFileSync(join(fixture.runDir, ref)), ref);
      }
      assert.equal(result.payload.continuation.carry_forward.accepted_slices[0].integration_conflict.resolution_commit, fixture.conflict.resolution_commit);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects a legacy plan without integration_gate at v2 carry-forward construction", () => {
    const fixture = createV2Fixture("carry-legacy-plan", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      const planPath = join(fixture.runDir, "plan", "slices.json");
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      delete plan.integration_gate;
      writeJson(planPath, plan);

      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "carry-legacy-plan-next", carryForward: true, dryRun: true }),
        /plan\.integration_gate: is required/u,
      );
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "carry-legacy-plan-next")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("requires current accepted work-decomposer plan and review authority for v2 construction", () => {
    const fixture = createV2Fixture("carry-unaccepted-decomposition", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      const runPath = join(fixture.runDir, "run.json");
      const run = JSON.parse(readFileSync(runPath, "utf8"));
      run.steps = run.steps.filter((step) => step.agent !== "work-decomposer");
      writeJson(runPath, run);
      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "carry-unaccepted-decomposition-next", carryForward: true, dryRun: true }),
        /accepted work-decomposer plan authority/u,
      );
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "carry-unaccepted-decomposition-next")), false);
    } finally {
      cleanup(fixture.repo);
    }

    const cases = [
      ["plan-ref", (fixture, run) => { run.steps.find((step) => step.agent === "work-decomposer").artifact_ref = "artifacts/plan.json"; }],
      ["plan-hash", (fixture, run) => { run.steps.find((step) => step.agent === "work-decomposer").acceptance.artifact_hash = `sha256:${"0".repeat(64)}`; }],
      ["plan-bytes", (fixture) => {
        const path = join(fixture.runDir, "plan", "slices.json");
        const plan = JSON.parse(readFileSync(path, "utf8"));
        plan.slices[0].acceptance = ["substituted acceptance"];
        writeJson(path, plan);
      }],
      ["review-ref", (_fixture, run) => { run.steps.find((step) => step.agent === "work-decomposer").acceptance.review_ref = "reviews/other.json"; }],
      ["review-hash", (_fixture, run) => { run.steps.find((step) => step.agent === "work-decomposer").acceptance.review_hash = `sha256:${"1".repeat(64)}`; }],
      ["review-bytes", (fixture) => writeJson(join(fixture.runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", verdict: "REJECT" })],
    ];
    for (const [label, mutate] of cases) {
      const fixture = createV2Fixture(`carry-decomposition-${label}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        const runPath = join(fixture.runDir, "run.json");
        const run = JSON.parse(readFileSync(runPath, "utf8"));
        mutate(fixture, run);
        writeJson(runPath, run);
        assert.throws(
          () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true, dryRun: true }),
          /accepted work-decomposer plan authority|bound plan|work-decomposer review|acceptance/u,
          label,
        );
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", `${fixture.runId}-next`)), false, label);
      } finally {
        cleanup(fixture.repo);
      }
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
      ["missing evidence", (fixture) => rmSync(join(fixture.runDir, "evidence", "A.json")), /missing (?:parent )?evidence ref/u],
      ["mutable review", (fixture) => writeFileSync(join(fixture.runDir, "reviews", "A.json"), "{}\n"), /hashes are stale|subject must match/u],
      ["partial successor", (fixture) => updateRun(fixture, (run) => { delete run.slices[0].review_hash; }), /require complete evidence_hash, review_hash, and reviewed_commit bindings/u],
      ["non approve", (fixture) => {
        const reviewPath = join(fixture.runDir, "reviews", "A.json");
        const review = JSON.parse(readFileSync(reviewPath, "utf8"));
        review.verdict = "REJECT";
        review.convergence = "converging";
        review.remaining_fix_count = 1;
        review.required_fixes = ["reject accepted slice"];
        review.remediation_context = { schema_version: 2, fixes: [{ required_fix_index: 0, classification: "narrow-correction", scope_effect: "in-lane", likely_paths: ["A.txt"], fix_owner: "A" }] };
        writeJson(reviewPath, review);
        updateRun(fixture, (run) => {
          run.slices[0].review_hash = hashFile(reviewPath);
          run.slices[0].attempt_reviews[0].review_hash = run.slices[0].review_hash;
          run.slices[0].attempt_reviews[0].verdict = "REJECT";
          run.slices[0].attempt_reviews[0].remaining_fix_count = 1;
        });
      }, /requires APPROVE review/u],
      ["plan drift", (fixture) => {
        const planPath = join(fixture.runDir, "plan", "slices.json");
        const plan = JSON.parse(readFileSync(planPath, "utf8"));
        plan.slices.splice(1, 1);
        plan.delivery_envelope = deliveryEnvelopeForSlices(plan.slices);
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
      ["malformed", (fixture) => updateRun(fixture, (run) => {
        const reviewPath = join(fixture.runDir, "reviews", "A.json");
        const review = JSON.parse(readFileSync(reviewPath, "utf8"));
        review.reviewed_commit = fixture.baseCommit;
        for (const disposition of review.invariant_family_ledger.dispositions) disposition.reviewed_commit = fixture.baseCommit;
        writeJson(reviewPath, review);
        run.slices[0].reviewed_commit = fixture.baseCommit;
        run.slices[0].attempt_reviews[0].reviewed_commit = fixture.baseCommit;
        run.slices[0].review_hash = hashFile(reviewPath);
        run.slices[0].attempt_reviews[0].review_hash = run.slices[0].review_hash;
      }), /review history is stale|sidecar heads must equal reviewed_commit|second parent/u],
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

  it("accepts the exact terminal nonconvergence review as the v2 carry-forward selector", () => {
    const fixture = createV2Fixture("nonconvergent-route", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      const { head, evidenceRef, reviewRef, priorReviewRef, currentReview } = configureNonconvergentRoute(fixture);

      assert.throws(
        () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: reviewRef, runId: "nonconvergent-route-v1" }),
        /requires --carry-forward/u,
      );

      const continuation = buildContinuation(fixture.runId, { cwd: fixture.repo, review: reviewRef, runId: "nonconvergent-route-next", carryForward: true });
      const exactTerminalResult = structuredClone(JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8")).terminal_result);

      assert.equal(continuation.review.ref, reviewRef);
      assert.equal(continuation.review.verdict, "REJECT");
      assert.deepEqual(continuation.review.required_fixes, ["replace the missed category"]);
      assert.deepEqual(continuation.carry_forward.remaining_slice_ids, ["B", "C"]);

      const alternateRef = "reviews/B.alternate.json";
      writeJson(join(fixture.runDir, alternateRef), { subject: "B", verdict: "REJECT", summary: "alternate parent ref", required_fixes: ["other"] });
      updateRun(fixture, (run) => { run.slices[1].review_ref = alternateRef; });
      assert.throws(
        () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: alternateRef, runId: "nonconvergent-route-alternate", carryForward: true }),
        /must equal run\.terminal_result\.nonconvergence\.source_review\.review_ref/u,
      );

      updateRun(fixture, (run) => {
        run.terminal_result = { status: "blocked", run_id: run.run_id, pr_url: null, reason: "generic-block", summary: "generic", artifacts: {} };
      });
      assert.throws(
        () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: alternateRef, runId: "nonconvergent-route-generic", carryForward: true }),
        /must equal run\.terminal_result\.nonconvergence\.source_review\.review_ref/u,
      );

      updateRun(fixture, (run) => { run.slices[1].review_ref = reviewRef; run.terminal_result = exactTerminalResult; });
      writeJson(join(fixture.runDir, reviewRef), {
        subject: "B", attempt: 2, reviewed_commit: head, verdict: "REJECT", convergence: "nonconvergent", late_discovery_strike: false,
        remaining_fix_count: 1, required_fixes: ["rewritten after terminalization"],
        ownership_ratification: { schema_version: 1, paths: [] },
        remediation_context: { schema_version: 2, fixes: [{ required_fix_index: 0, classification: "nonconvergent", scope_effect: "in-lane", likely_paths: ["B.txt"], fix_owner: "B" }] },
      });
      assert.throws(
        () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: reviewRef, runId: "nonconvergent-route-rewritten", carryForward: true }),
        /attempt 2 review history is stale|consume the exact source review bytes/u,
      );
      writeJson(join(fixture.runDir, reviewRef), currentReview);
      writeJson(join(fixture.runDir, priorReviewRef), {
        subject: "B", attempt: 1, reviewed_commit: head, verdict: "REJECT", convergence: "converging", late_discovery_strike: false,
        remaining_fix_count: 1, required_fixes: ["rewritten earlier history"],
        ownership_ratification: { schema_version: 1, paths: [] },
        remediation_context: { schema_version: 2, fixes: [{ required_fix_index: 0, classification: "narrow-correction", scope_effect: "in-lane", likely_paths: ["B.txt"], fix_owner: "B" }] },
      });
      assert.throws(
        () => buildContinuation(fixture.runId, { cwd: fixture.repo, review: reviewRef, runId: "nonconvergent-route-history-rewritten", carryForward: true }),
        /attempt 1 review history is stale/u,
      );
    } finally { cleanup(fixture.repo); }
  });

  it("injects exact terminal nonconvergence evidence into the first child builder dispatch", async () => {
    const fixture = createV2Fixture("nonconvergent-dispatch", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      const { evidenceRef, reviewRef } = configureNonconvergentRoute(fixture);
      const childRunId = "nonconvergent-dispatch-next";
      await continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: reviewRef,
        runId: childRunId,
        carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started", run_id: childRunId }),
      });
      const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const childWorktree = join(fixture.repo, ".opencode", "worktrees", childRunId);
      await transitionRunSlice(childRunDir, "B", { status: "running", attempts: 1, branch: childRunId, worktree: childWorktree });

      const context = await prepareSliceBuilderTaskDispatch(fixture.repo, {
        run_id: childRunId, slice_id: "B", attempt: 1, agent: "backend-builder",
      });
      assert.equal(context.task_context, "fresh");
      assert.deepEqual(context.prior.origin, { kind: "carry-forward-nonconvergence", parent_run_id: fixture.runId });
      assert.equal(context.prior.binding.evidence_ref, evidenceRef);
      assert.equal(JSON.parse(Buffer.from(context.prior.review.bytes, "base64").toString("utf8")).required_fixes[0], "replace the missed category");
      assert.equal(JSON.parse(Buffer.from(context.prior.evidence.bytes, "base64").toString("utf8")).attempt, 2);

      const parentEvidencePath = join(fixture.runDir, evidenceRef);
      const parentEvidenceBytes = readFileSync(parentEvidencePath, "utf8");
      await transitionRunSlice(childRunDir, "C", { status: "running", attempts: 1, branch: childRunId, worktree: childWorktree });
      writeFileSync(parentEvidencePath, `${parentEvidenceBytes}\n`, "utf8");
      await assert.rejects(
        prepareSliceBuilderTaskDispatch(fixture.repo, {
          run_id: childRunId, slice_id: "C", attempt: 1, agent: "backend-builder",
        }),
        /schema-v2 parent evidence|schema-v2 parent run|parent.*stale|review history is stale/u,
      );
      writeFileSync(parentEvidencePath, parentEvidenceBytes, "utf8");
      await assert.rejects(
        prepareSliceBuilderTaskDispatch(fixture.repo, {
          run_id: childRunId, slice_id: "C", attempt: 1, agent: "backend-builder",
        }, {
          claimDispatch: true,
          completionToken: "parent-authority-race-token",
          atomicWriteHooks: { beforeCommit: () => writeFileSync(parentEvidencePath, `${parentEvidenceBytes}\n`, "utf8") },
        }),
        /prior authority changed before claim publication|commit failed/u,
      );
      writeFileSync(parentEvidencePath, parentEvidenceBytes, "utf8");
      const completionToken = "parent-authority-closure-token";
      const claimed = await prepareSliceBuilderTaskDispatch(fixture.repo, {
        run_id: childRunId, slice_id: "B", attempt: 1, agent: "backend-builder",
      }, { claimDispatch: true, completionToken });
      writeFileSync(parentEvidencePath, `${parentEvidenceBytes}\n`, "utf8");
      await assert.rejects(
        completeSliceBuilderTaskDispatch(fixture.repo, {
          run_id: childRunId, slice_id: "B", attempt: 1, agent: "backend-builder",
          claim_ref: claimed.dispatch_claim.ref, claim_hash: claimed.dispatch_claim.hash, completion_token: completionToken,
        }),
        /schema-v2 parent evidence|schema-v2 parent run|parent.*stale|review history is stale/u,
      );
    } finally { cleanup(fixture.repo); }
  });

  it("injects the exact selected ordinary slice REJECT into the child builder dispatch", async () => {
    const fixture = createV2Fixture("slice-review-dispatch", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      const { evidenceRef, reviewRef } = configureConvergingSliceRoute(fixture);
      const childRunId = "slice-review-dispatch-next";
      await continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: reviewRef,
        runId: childRunId,
        carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started", run_id: childRunId }),
      });
      const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const childWorktree = join(fixture.repo, ".opencode", "worktrees", childRunId);
      await transitionRunSlice(childRunDir, "B", { status: "running", attempts: 1, branch: childRunId, worktree: childWorktree });

      const context = await prepareSliceBuilderTaskDispatch(fixture.repo, {
        run_id: childRunId, slice_id: "B", attempt: 1, agent: "backend-builder",
      });
      assert.equal(context.task_context, "fresh");
      assert.deepEqual(context.prior.origin, { kind: "continuation-slice-review", parent_run_id: fixture.runId });
      assert.equal(context.prior.binding.review_ref, reviewRef);
      assert.equal(JSON.parse(Buffer.from(context.prior.review.bytes, "base64").toString("utf8")).required_fixes[0], "apply the selected correction");
      assert.equal(JSON.parse(Buffer.from(context.prior.evidence.bytes, "base64").toString("utf8")).subject, "B");

      const parentReviewPath = join(fixture.runDir, reviewRef);
      const parentReviewBytes = readFileSync(parentReviewPath, "utf8");
      writeFileSync(parentReviewPath, `${parentReviewBytes}\n`, "utf8");
      await assert.rejects(
        prepareSliceBuilderTaskDispatch(fixture.repo, { run_id: childRunId, slice_id: "B", attempt: 1, agent: "backend-builder" }),
        /schema-v2 parent review|parent.*stale|review history is stale/u,
      );
    } finally { cleanup(fixture.repo); }
  });

  it("requires accepted unchanged planning and forbids draft carry-forward before allocation", () => {
    for (const [label, mutate] of [
      ["unaccepted", (fixture) => updateRun(fixture, (run) => { run.steps[0].status = "rejected"; delete run.steps[0].acceptance; })],
      ["changed", (fixture) => writeFileSync(join(fixture.runDir, "artifacts", "technical-brief.md"), "changed after acceptance\n")],
    ]) {
      const fixture = createV2Fixture(`planning-${label}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        mutate(fixture);
        assert.throws(() => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: `${fixture.runId}-next`, carryForward: true }), /accepted unchanged planning|planning_reuse/u, label);
        assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "", label);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("rejects caller-scaffolded v2 children without changing parent or child state", async () => {
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

      await assert.rejects(resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true }), /closed mode\/pr configuration|published carry-forward|exact closed immutable configuration/u);

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
      ["sidecar", ({ parentRunDir }) => writeFileSync(join(parentRunDir, "reviews", "A.json"), "{}\n"), /parent_(?:reviews|evidence) bindings changed|hashes are stale|subject must match/u],
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

  it("binds same-checkpoint B1 source and stored configuration through continuation, claim, and child root", async () => {
    for (const reviewTier of [null, "strict"]) {
      const suffix = reviewTier ?? "null";
      const fixture = createV2Fixture(`checkpoint-b1-${suffix}`, { accepted: ["A"], mergeOrder: ["A"] });
      const childRunId = `checkpoint-b1-${suffix}-next`;
      try {
        const bound = bindCheckpointContinuationFixture(fixture, reviewTier);
        const result = await continueFactory(fixture.runId, {
          cwd: fixture.repo,
          review: "reviewer.json",
          runId: childRunId,
          carryForward: true,
          foregroundLaunchFn: async () => ({ status: "started", run_id: childRunId }),
        });
        const continuation = result.payload.continuation;
        const child = JSON.parse(readFileSync(join(fixture.repo, ".opencode", "factory", childRunId, "run.json"), "utf8"));
        const claim = JSON.parse(gitStdoutPreserve(fixture.repo, ["cat-file", "blob", expectedClaim(continuation).claimRef]));

        assert.deepEqual(continuation.configuration, bound.configuration);
        assert.equal(continuation.checkpoint_source_hash, canonicalHash(bound.source));
        assert.equal(continuation.configuration_hash, canonicalHash(bound.configuration));
        assert.equal(claim.checkpoint_source_hash, continuation.checkpoint_source_hash);
        assert.equal(claim.configuration_hash, continuation.configuration_hash);
        assert.deepEqual(child.checkpoint_source, bound.source);
        assert.equal(reviewTier === null ? !Object.hasOwn(child, "review_tier") : child.review_tier === reviewTier, true);
        assert.deepEqual(continuation.planning_reuse, {
          eligible: true,
          plan_ref: "plan/slices.json",
          plan_hash: bound.source.child_plan_hash,
          review_ref: "reviews/work-decomposer.json",
          review_hash: bound.source.child_disposition_hash,
        });
        assert.equal(child.steps.some((step) => step.agent === "spec-writer"), false);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId, "artifacts", "technical-brief.md")), false);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId, "reviews", "spec-writer.json")), false);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("rejects missing, review-only, stale, and cross-bound S2 owners before ordinary child publication", () => {
    const cases = [
      ["missing", (run) => { run.slices = run.slices.filter(({ id }) => id !== "owner"); }],
      ["review-only", (run) => { const owner = run.slices.find(({ id }) => id === "owner"); owner.status = "review"; delete owner.merge_commit; }],
      ["stale", (run) => { run.slices.find(({ id }) => id === "consumer").attempt_reviews[0].modified_extensions[0].owner_review_hash = `sha256:${"0".repeat(64)}`; }],
      ["cross-bound", (run) => { run.slices.find(({ id }) => id === "consumer").attempt_reviews[0].modified_extensions[0].owner_slice_id = "consumer"; }],
    ];
    for (const [label, mutate] of cases) {
      const fixture = createV2SiblingAuthorityFixture(`issue128-ordinary-${label}`);
      const childRunId = `${fixture.runId}-next`;
      try {
        updateRun(fixture, mutate);
        const parentBytes = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        assert.throws(
          () => continueFactory(fixture.runId, { cwd: fixture.repo, review: fixture.continuationReviewRef, runId: childRunId, carryForward: true, dryRun: true }),
          /owner|sibling|binding|stale|accepted|merged|dependency|unknown/u,
          label,
        );
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), parentBytes, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false, label);
        assert.equal(refOid(fixture.repo, `refs/heads/${childRunId}`), null, label);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("rejects checkpoint B1 configuration conflicts and cross-checkpoint source before allocation", () => {
    const conflict = createV2Fixture("checkpoint-b1-conflict", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      bindCheckpointContinuationFixture(conflict, "strict");
      assert.throws(() => continueFactory(conflict.runId, {
        cwd: conflict.repo, review: "reviewer.json", runId: "checkpoint-b1-v1-next",
      }), /requires --carry-forward/u);
      assert.throws(() => continueFactory(conflict.runId, {
        cwd: conflict.repo, review: "reviewer.json", runId: "checkpoint-b1-conflict-next", carryForward: true, autonomous: true,
      }), /mode conflicts with published immutable configuration/u);
      assert.equal(refOid(conflict.repo, continuationReservationRef("checkpoint-b1-conflict-next")), null);
      assert.notEqual(spawnSync("git", ["show-ref", "--verify", "refs/heads/checkpoint-b1-conflict-next"], { cwd: conflict.repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).status, 0);
      assert.equal(gitStdout(conflict.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "");
      assert.equal(existsSync(join(conflict.repo, ".opencode", "worktrees", "checkpoint-b1-conflict-next")), false);
      assert.equal(existsSync(join(conflict.repo, ".opencode", "factory", "checkpoint-b1-conflict-next")), false);
    } finally { cleanup(conflict.repo); }

    const crossed = createV2Fixture("checkpoint-b1-crossed", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      bindCheckpointContinuationFixture(crossed, null);
      updateRun(crossed, (run) => {
        run.checkpoint_source.checkpoint_id = "checkpoint-002";
        run.checkpoint_source.checkpoint_ordinal = 2;
      });
      assert.throws(() => continueFactory(crossed.runId, {
        cwd: crossed.repo, review: "reviewer.json", runId: "checkpoint-b1-crossed-next", carryForward: true,
      }), /cross-checkpoint/u);
      assert.equal(refOid(crossed.repo, continuationReservationRef("checkpoint-b1-crossed-next")), null);
      assert.notEqual(spawnSync("git", ["show-ref", "--verify", "refs/heads/checkpoint-b1-crossed-next"], { cwd: crossed.repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).status, 0);
      assert.equal(gitStdout(crossed.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "");
      assert.equal(existsSync(join(crossed.repo, ".opencode", "worktrees", "checkpoint-b1-crossed-next")), false);
      assert.equal(existsSync(join(crossed.repo, ".opencode", "factory", "checkpoint-b1-crossed-next")), false);
    } finally { cleanup(crossed.repo); }
  });

  it("atomically publishes and launches the complete canonical child after exact allocation", async () => {
    const fixture = createV2Fixture("allocation-happy", { accepted: ["A", "C"], mergeOrder: ["C", "A"] });
    const childRunId = "allocation-happy-next";
    const transactions = [];
    try {
      let launched;
      const result = await continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        foregroundLaunchFn: async (repo, args) => { launched = { repo, args }; return { status: "started", run_id: childRunId }; },
        refTransactionSpawnSync(file, args, options) {
          transactions.push({ file, args: [...args], input: String(options.input) });
          return spawnSync(file, args, options);
        },
      });
      const expected = expectedClaim(result.payload.continuation);
      const expectedBytes = canonicalJson(expected.claim);
      const expectedDigest = createHash("sha256").update(canonicalJson(expected.parentIdentity)).digest("hex");
      const zero = "0".repeat(40);

      const claimRef = `refs/opencode/continuations/${expectedDigest}`;
      assert.equal(result.status, "started", JSON.stringify(result));
      assert.deepEqual(result.publication, { published: true, replayed: false });
      assert.equal(result.payload.driver.ready, true);
      assert.equal(result.payload.driver.pr_mode, "ready");
      assert.equal(result.payload.driver.mode, "interactive");
      assert.equal(result.payload.driver.github_account, null);
      assert.equal(gitStdout(fixture.repo, ["cat-file", "-t", claimRef]), "blob");
      assert.equal(gitStdoutPreserve(fixture.repo, ["cat-file", "blob", claimRef]), expectedBytes);
      assert.deepEqual(JSON.parse(expectedBytes), expected.claim);
      const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const child = JSON.parse(readFileSync(join(childRunDir, "run.json"), "utf8"));
      assert.equal(gitStdout(fixture.repo, ["show-ref", "--verify", "--hash", expected.claim.child_branch_ref]), result.payload.continuation.carry_forward.start_commit);
      assert.equal(gitStdout(result.payload.continuation.target.worktree, ["rev-parse", "--verify", "HEAD^{commit}"]), result.payload.continuation.carry_forward.start_commit);
      assert.equal(gitStdout(result.payload.continuation.target.worktree, ["symbolic-ref", "HEAD"]), expected.claim.child_branch_ref);
      assert.equal(child.continuation.schema_version, 2);
      assert.equal(child.schema_version, 1);
      assert.equal(child.max_parallel_slices, 3);
      assert.equal(child.max_retries, 3);
      assert.equal(Object.hasOwn(child, "review_tier"), false);
      assert.deepEqual(child.post_pr, continuationEligibilityPostPr("disabled", 0));
      assert.deepEqual(child.gates, {});
      assert.deepEqual(child.slices.map(({ id, status, attempts }) => ({ id, status, attempts })), [
        { id: "A", status: "merged", attempts: 1 }, { id: "B", status: "pending", attempts: 0 }, { id: "C", status: "merged", attempts: 1 },
      ]);
      assert.equal(child.steps[0].attempts, 0);
      assert.equal(child.steps[0].status, "accepted");
      assert.deepEqual(child.steps[1], {
        agent: "work-decomposer", status: "accepted", attempts: 1,
        artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
        acceptance: {
          artifact_ref: "plan/slices.json", artifact_hash: hashFile(join(childRunDir, "plan", "slices.json")),
          review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(childRunDir, "reviews", "work-decomposer.json")),
        },
      });
      assert.deepEqual(child.steps[2], { agent: "test-verifier", status: "blocked", attempts: 0 });
      assert.equal(child.steps.length, 3);
      assert.equal(child.validator, null);
      assert.equal(child.security_review, null);
      assert.equal(child.pr_url, null);
      for (const ref of ["artifacts/test-report.md", "artifacts/validation-report.md", "artifacts/pr-body.md", "artifacts/plan.md"]) {
        assert.equal(existsSync(join(childRunDir, ref)), false, ref);
      }
      assert.deepEqual(readFileSync(join(childRunDir, "reviews", "work-decomposer.json")), readFileSync(join(fixture.runDir, "reviews", "work-decomposer.json")));
      assert.deepEqual(readFileSync(join(childRunDir, "plan", "slices.json")), readFileSync(join(fixture.runDir, "plan", "slices.json")));
      assert.equal(existsSync(join(fixture.repo, ".opencode", "skills", "feature", "SKILL.md")), true);
      assert.equal(launched.repo, gitStdout(fixture.repo, ["rev-parse", "--show-toplevel"]));
      assert.match(launched.args.at(-1), /^ffpayload-v1:/u);
      assertPublishedCarryForwardRun(launched.repo, result.payload.continuation, { driver: result.payload.driver });
      const decoded = decodeFeatureCommandPayload(launched.args.at(-1), { repo: launched.repo });
      assert.equal(decoded.ok, true, JSON.stringify(decoded));
      assert.deepEqual(decoded.payload.driver, result.payload.driver);
      const mismatch = structuredClone(result.payload);
      mismatch.driver.ready = false;
      assert.deepEqual(decodeFeatureCommandPayload(`ffpayload-v1:${Buffer.from(JSON.stringify(mismatch)).toString("base64url")}`, { repo: launched.repo }), { ok: false, reason: "unpublished-or-mismatched-carry-forward" });
      assert.equal(transactions.length, 1);
      assert.deepEqual(transactions[0].args, ["update-ref", "--no-deref", "--stdin"]);
      assert.equal(transactions[0].input, [
        "start",
        `verify ${expected.parentIdentity.parent_branch_ref} ${expected.claim.start_commit}`,
        `update ${claimRef} ${refOid(fixture.repo, claimRef)} ${zero}`,
        `update ${expected.claim.child_branch_ref} ${expected.claim.start_commit} ${zero}`,
        "prepare",
        "commit",
        "",
      ].join("\n"));
    } finally { cleanup(fixture.repo); }
  });

  it("publishes and replays complete multi-attempt carry-forward history", async () => {
    const fixture = createV2Fixture("multi-attempt-publication", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "multi-attempt-publication-next";
    const launches = [];
    try {
      const history = configureMultiAttemptAcceptedSlice(fixture, "A");
      const parentBytes = new Map(history.flatMap((entry) => [entry.evidence_ref, entry.review_ref])
        .map((ref) => [ref, readFileSync(join(fixture.runDir, ref))]));
      const launch = async (repo, args) => {
        launches.push({ repo, payload: args.at(-1) });
        return { status: "started", run_id: childRunId };
      };
      const options = {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        now: "2026-07-18T12:00:00.000Z",
        foregroundLaunchFn: launch,
      };

      const result = await continueFactory(fixture.runId, options);
      const accepted = result.payload.continuation.carry_forward.accepted_slices[0];
      const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const child = JSON.parse(readFileSync(join(childRunDir, "run.json"), "utf8"));
      const childSlice = child.slices.find((slice) => slice.id === "A");

      assert.deepEqual(accepted.attempt_reviews, history);
      assert.deepEqual(childSlice.attempt_reviews, history);
      assert.equal(accepted.attempt_reviews[0].review_ref, "reviews/A.attempt-1.json");
      assert.equal(accepted.attempt_reviews[1].review_ref, "reviews/A.attempt-2.json");
      assert.notEqual(accepted.attempt_reviews[0].review_hash, accepted.attempt_reviews[1].review_hash);
      assert.notEqual(accepted.attempt_reviews[0].evidence_hash, accepted.attempt_reviews[1].evidence_hash);
      for (const [ref, bytes] of parentBytes) assert.deepEqual(readFileSync(join(childRunDir, ref)), bytes, ref);

      const decoded = decodeFeatureCommandPayload(launches[0].payload, { repo: launches[0].repo });
      assert.equal(decoded.ok, true, JSON.stringify(decoded));
      assert.deepEqual(decoded.payload.continuation.carry_forward.accepted_slices[0].attempt_reviews, history);
      const replay = await continueFactory(fixture.runId, options);
      assert.deepEqual(replay.publication, { published: true, replayed: true });
      const replayDecoded = decodeFeatureCommandPayload(launches[1].payload, { repo: launches[1].repo });
      assert.equal(replayDecoded.ok, true, JSON.stringify(replayDecoded));
      assert.deepEqual(replayDecoded.payload.continuation.carry_forward.accepted_slices[0].attempt_reviews, history);
    } finally { cleanup(fixture.repo); }

    for (const [label, mutate, expected] of [
      ["historical deletion", (candidate) => rmSync(join(candidate.runDir, "reviews", "A.attempt-1.json")), /missing.*review|review.*missing/u],
      ["historical byte drift", (candidate) => {
        const path = join(candidate.runDir, "evidence", "A.attempt-1.json");
        writeFileSync(path, `${readFileSync(path, "utf8")} `);
      }, /history is stale|hashes are stale/u],
      ["historical hash drift", (candidate) => updateRun(candidate, (run) => { run.slices[0].attempt_reviews[0].review_hash = `sha256:${"0".repeat(64)}`; }), /history is stale|hashes are stale/u],
    ]) {
      const candidate = createV2Fixture(`multi-attempt-${label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        configureMultiAttemptAcceptedSlice(candidate, "A");
        mutate(candidate);
        assert.throws(
          () => buildContinuation(candidate.runId, { cwd: candidate.repo, review: "reviewer.json", runId: `${candidate.runId}-next`, carryForward: true }),
          expected,
          label,
        );
      } finally { cleanup(candidate.repo); }
    }
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

  it("leaves no child before allocation and exact-replays publication after allocation crashes", async () => {
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

      const launch = async () => ({ status: "started", run_id: childRunId });
      const recovered = await continueFactory(after.runId, { cwd: after.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: launch });
      assert.deepEqual(recovered.publication, { published: true, replayed: false });
      const replay = await continueFactory(after.runId, { cwd: after.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: launch });
      assert.deepEqual(replay.publication, { published: true, replayed: true });
      assert.equal(refOid(after.repo, committed.claimRef), committed.claimOid);
      assert.equal(refOid(after.repo, committed.childBranchRef), committed.startCommit);
      assert.equal(gitStdout(join(after.repo, ".opencode", "worktrees", childRunId), ["rev-parse", "HEAD"]), committed.startCommit);
      assert.equal(existsSync(join(after.repo, ".opencode", "factory", childRunId, "run.json")), true);
    } finally { cleanup(after.repo); }
  });

  it("exact-replays committed refs after interruption of claim-bound worktree reservation", async () => {
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

      const recovered = await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => ({ status: "started", run_id: childRunId }) });
      assert.deepEqual(recovered.publication, { published: true, replayed: false });
      assert.equal(gitStdout(join(fixture.repo, ".opencode", "worktrees", childRunId), ["rev-parse", "HEAD"]), fixture.mergeCommits.A);
      assert.equal(existsSync(reservation.reservationPath), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId, "run.json")), true);
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

  it("rechecks every publication authority and configuration after staging without partial visibility", async () => {
    const cases = [
      ["parent", (fixture) => writeFileSync(join(fixture.runDir, "run.json"), `${readFileSync(join(fixture.runDir, "run.json"), "utf8")} `)],
      ["plan", (fixture) => writeFileSync(join(fixture.runDir, "plan", "slices.json"), "{\"slices\":[]}")],
      ["sidecar", (fixture) => writeFileSync(join(fixture.runDir, "evidence", "A.json"), "{}\n")],
      ["parent branch", (fixture) => runGit(fixture.repo, ["commit", "--allow-empty", "-m", "publication parent race"])],
      ["origin", (fixture) => {
        runGit(fixture.repo, ["checkout", "main"]); runGit(fixture.repo, ["commit", "--allow-empty", "-m", "publication origin race"]);
        runGit(fixture.repo, ["push", "origin", "main:main"]); runGit(fixture.repo, ["checkout", fixture.runId]);
      }],
      ["claim", (fixture, state) => updateRef(fixture.repo, state.allocation.claim_ref, writeBlob(fixture.repo, "{}"))],
      ["worktree", (fixture, state) => runGit(state.continuation.target.worktree, ["checkout", "--detach", fixture.baseCommit])],
      ["config", (_fixture, state) => { state.configuration.pr_mode = "draft"; }],
    ];
    for (const [label, mutate] of cases) {
      const fixture = createV2Fixture(`publication-race-${label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      const childRunId = `${fixture.runId}-next`;
      const options = {
        cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started" }),
      };
      try {
        await assert.rejects(continueFactory(fixture.runId, {
          ...options,
          beforeCarryForwardPublish(state) {
            assert.equal(existsSync(state.targetRunDir), false, `${label}: child invisible before publication`);
            assert.equal(existsSync(join(fixture.repo, ".opencode", "skills", "feature")), false, `${label}: skill not seeded before publication`);
            mutate(fixture, state);
          },
        }), /carry-forward|continuation|parent|plan|sidecar|branch|origin|claim|worktree|configuration|stale|changed/u, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false, label);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("never overwrites a publication-race winner and leaves no staged partial child", async () => {
    const fixture = createV2Fixture("publication-target-race", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "publication-target-race-next";
    const target = join(fixture.repo, ".opencode", "factory", childRunId);
    try {
      await assert.rejects(continueFactory(fixture.runId, {
        cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
        beforeCarryForwardRename() { mkdirSync(target, { recursive: true }); writeFileSync(join(target, "foreign.txt"), "foreign\n"); },
        foregroundLaunchFn: async () => ({ status: "started" }),
      }), /already exists|factory run directory/u);
      assert.equal(readFileSync(join(target, "foreign.txt"), "utf8"), "foreign\n");
      assert.equal(existsSync(join(target, "run.json")), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "skills", "feature")), false);
    } finally { cleanup(fixture.repo); }

    const linked = createV2Fixture("publication-symlink-race", { accepted: ["A"], mergeOrder: ["A"] });
    const linkedRunId = "publication-symlink-race-next";
    const outside = join(linked.repo, "outside-child");
    try {
      mkdirSync(outside);
      await assert.rejects(continueFactory(linked.runId, {
        cwd: linked.repo, review: "reviewer.json", runId: linkedRunId, carryForward: true,
        beforeCarryForwardRename({ targetRunDir }) { symlinkSync(outside, targetRunDir, "dir"); },
        foregroundLaunchFn: async () => ({ status: "started" }),
      }), /already exists|factory run directory/u);
      assert.equal(existsSync(join(outside, "run.json")), false);
      assert.equal(readFileSync(join(linked.runDir, "run.json"), "utf8").includes(linked.runId), true);
    } finally { cleanup(linked.repo); }

    const empty = createV2Fixture("publication-empty-race", { accepted: ["A"], mergeOrder: ["A"] });
    const emptyRunId = "publication-empty-race-next";
    const emptyTarget = join(empty.repo, ".opencode", "factory", emptyRunId);
    try {
      await assert.rejects(continueFactory(empty.runId, {
        cwd: empty.repo, review: "reviewer.json", runId: emptyRunId, carryForward: true,
        afterCarryForwardTargetObservation() { mkdirSync(emptyTarget); },
        foregroundLaunchFn: async () => ({ status: "started" }),
      }), /already exists|will not be overwritten|factory run directory/u);
      assert.equal(existsSync(emptyTarget), true);
      assert.equal(existsSync(join(emptyTarget, "run.json")), false);
      assert.equal(existsSync(join(empty.repo, ".opencode", "skills", "feature")), false);
    } finally { cleanup(empty.repo); }
  });

  it("revalidates parent commands and accepted decomposition after target observation before child rename", async () => {
    const fixture = createV2Fixture("publication-command-race", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "publication-command-race-next";
    const planPath = join(fixture.runDir, "plan", "slices.json");
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    plan.integration_gate.required_commands.unshift({ program: "node", args: ["--test", "test/acceptance.test.js"] });
    writeJson(planPath, plan);
    const parentRunPath = join(fixture.runDir, "run.json");
    const parentRun = JSON.parse(readFileSync(parentRunPath, "utf8"));
    parentRun.steps.find((step) => step.agent === "work-decomposer").acceptance.artifact_hash = hashFile(planPath);
    writeJson(parentRunPath, parentRun);
    let launches = 0;
    try {
      await assert.rejects(continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        afterCarryForwardTargetObservation() {
          const changed = JSON.parse(readFileSync(planPath, "utf8"));
          changed.integration_gate.required_commands[0].args[1] = "test/other.test.js";
          writeJson(planPath, changed);
        },
        foregroundLaunchFn: async () => { launches += 1; return { status: "started" }; },
      }), /plan|decomposition|authority|changed/u);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false);
      assert.equal(launches, 0);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("recovers exact publication across both atomic rename crash boundaries", async () => {
    const before = createV2Fixture("publication-crash-before", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      await assert.rejects(continueFactory(before.runId, {
        cwd: before.repo, review: "reviewer.json", runId: "publication-crash-before-next", carryForward: true,
        beforeCarryForwardRename() { throw new Error("crash before publication rename"); },
        foregroundLaunchFn: async () => ({ status: "started" }),
      }), /crash before publication rename/u);
      assert.equal(existsSync(join(before.repo, ".opencode", "factory", "publication-crash-before-next")), false);
      const retried = await continueFactory(before.runId, { cwd: before.repo, review: "reviewer.json", runId: "publication-crash-before-next", carryForward: true, foregroundLaunchFn: async () => ({ status: "started" }) });
      assert.deepEqual(retried.publication, { published: true, replayed: false });
    } finally { cleanup(before.repo); }

    const after = createV2Fixture("publication-crash-after", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "publication-crash-after-next";
    try {
      await assert.rejects(continueFactory(after.runId, {
        cwd: after.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
        afterCarryForwardPublish() { throw new Error("crash after publication rename"); },
        foregroundLaunchFn: async () => ({ status: "started" }),
      }), /crash after publication rename/u);
      const published = validateRun(JSON.parse(readFileSync(join(after.repo, ".opencode", "factory", childRunId, "run.json"), "utf8")));
      assert.equal(published.run_id, childRunId);
      const replay = await continueFactory(after.runId, { cwd: after.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => ({ status: "started" }) });
      assert.deepEqual(replay.publication, { published: true, replayed: true });
    } finally { cleanup(after.repo); }
  });

  it("closes carry-forward configuration defaults, overrides, conflicts, and replay", async () => {
    const fixture = createV2Fixture("carry-config", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-config-next";
    try {
      const result = await continueFactory(fixture.runId, {
        cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, headless: true,
        ghAccount: "octo-org", draft: true, postPrCi: true, reviewer: "reviewer-login", postPrPollSeconds: 45,
        foregroundLaunchFn: async () => ({ status: "started" }),
      });
      const child = JSON.parse(readFileSync(join(fixture.repo, ".opencode", "factory", childRunId, "run.json"), "utf8"));
      assert.equal(child.mode, "headless");
      assert.equal(child.github_account, "octo-org");
      assert.equal(child.pr_mode, "draft");
      assert.equal(child.post_pr.policy.enabled, true);
      assert.equal(child.post_pr.policy.initial_poll_ms, 45_000);
      assert.deepEqual(child.post_pr.policy.review, { required: true, reviewer_login: "reviewer-login", source: "driver" });
      assert.equal(result.payload.driver.ready, false);
      assert.equal(result.payload.driver.post_pr_ci.initial_poll_ms, 45_000);
      const equalResume = await resumeFactory(childRunId, {
        cwd: fixture.repo,
        dryRun: true,
        headless: true,
        ghAccount: "octo-org",
        draft: true,
        postPrCi: true,
        reviewer: "reviewer-login",
        postPrPollSeconds: 45,
      });
      assert.equal(equalResume.status, "dry-run");
      const beforeResumeConflict = readFileSync(join(fixture.repo, ".opencode", "factory", childRunId, "run.json"));
      for (const [label, conflict] of [
        ["mode", { autonomous: true }],
        ["account", { ghAccount: "different" }],
        ["PR", { ready: true }],
        ["post-PR", { noPostPrCi: true }],
        ["reviewer", { postPrCi: true, reviewer: "different-reviewer" }],
      ]) {
        await assert.rejects(
          resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true, ...conflict }),
          /conflicts with published immutable configuration/u,
          label,
        );
      }
      await assert.rejects(
        startFactory([`resume ${childRunId}`], { cwd: fixture.repo, autonomous: true }),
        /mode conflicts with published immutable configuration/u,
      );
      assert.deepEqual(readFileSync(join(fixture.repo, ".opencode", "factory", childRunId, "run.json")), beforeResumeConflict);
      await assert.rejects(async () => continueFactory(fixture.runId, {
        cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, headless: true,
        ghAccount: "different", draft: true, postPrCi: true, reviewer: "reviewer-login", postPrPollSeconds: 45,
        foregroundLaunchFn: async () => ({ status: "started" }),
      }), /conflicts with published immutable configuration/u);
      assert.equal(JSON.parse(readFileSync(join(fixture.repo, ".opencode", "factory", childRunId, "run.json"), "utf8")).github_account, "octo-org");
    } finally { cleanup(fixture.repo); }

    for (const row of [
      {
        label: "defaults",
        options: {},
        expected: { mode: "interactive", github_account: null, pr_mode: "ready", postPrEnabled: false, phase: "disabled", ready: true },
      },
      {
        label: "autonomous ready enabled",
        options: { autonomous: true, ready: true, postPrCi: true },
        expected: { mode: "autonomous", github_account: null, pr_mode: "ready", postPrEnabled: true, phase: "awaiting-pr", ready: true },
      },
      {
        label: "detached no-draft",
        options: { detached: true, noDraft: true, ghAccount: "explicit-owner" },
        expected: { mode: "headless", github_account: "explicit-owner", pr_mode: "ready", postPrEnabled: false, phase: "disabled", ready: true },
      },
    ]) {
      const matrix = createV2Fixture(`carry-config-${row.label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        const runId = `${matrix.runId}-next`;
        const published = await continueFactory(matrix.runId, {
          cwd: matrix.repo,
          review: "reviewer.json",
          runId,
          carryForward: true,
          ...row.options,
          foregroundLaunchFn: async () => ({ status: "started" }),
          detachedLaunchFn: async () => ({ status: "started" }),
        });
        const child = JSON.parse(readFileSync(join(matrix.repo, ".opencode", "factory", runId, "run.json"), "utf8"));
        assert.equal(child.mode, row.expected.mode, row.label);
        assert.equal(child.github_account, row.expected.github_account, row.label);
        assert.equal(child.pr_mode, row.expected.pr_mode, row.label);
        assert.equal(child.post_pr.policy.enabled, row.expected.postPrEnabled, row.label);
        assert.equal(child.post_pr.phase, row.expected.phase, row.label);
        assert.equal(child.post_pr.attempt, 0, row.label);
        assert.deepEqual(child.post_pr.evidence_refs, [], row.label);
        assert.equal(published.payload.driver.ready, row.expected.ready, row.label);
      } finally { cleanup(matrix.repo); }
    }

    const remoteAccount = createV2Fixture("carry-config-remote-account", { accepted: ["A"], mergeOrder: ["A"] });
    try {
      const localOrigin = gitStdout(remoteAccount.repo, ["config", "--get", "remote.origin.url"]);
      const githubOrigin = "https://github.com/remote-owner/example.git";
      runGit(remoteAccount.repo, ["config", `url.${localOrigin}.insteadOf`, githubOrigin]);
      runGit(remoteAccount.repo, ["remote", "set-url", "origin", githubOrigin]);
      const runId = `${remoteAccount.runId}-next`;
      await continueFactory(remoteAccount.runId, {
        cwd: remoteAccount.repo,
        review: "reviewer.json",
        runId,
        carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started" }),
      });
      const child = JSON.parse(readFileSync(join(remoteAccount.repo, ".opencode", "factory", runId, "run.json"), "utf8"));
      assert.equal(child.github_account, "remote-owner");
    } finally { cleanup(remoteAccount.repo); }

    for (const [label, opts] of [
      ["mode", { autonomous: true, headless: true }], ["PR", { draft: true, ready: true }], ["post-PR", { postPrCi: true, noPostPrCi: true }],
      ["account", { ghAccount: "one", ghAccountOccurrences: 2 }],
    ]) {
      const conflict = createV2Fixture(`carry-config-conflict-${label.replaceAll(" ", "-")}`, { accepted: ["A"], mergeOrder: ["A"] });
      try {
        assert.throws(() => continueFactory(conflict.runId, { cwd: conflict.repo, review: "reviewer.json", runId: `${conflict.runId}-next`, carryForward: true, ...opts }), /conflict|only one|only once|mutually exclusive/u, label);
        assert.equal(gitStdout(conflict.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "", label);
      } finally { cleanup(conflict.repo); }
    }
  });

  it("preserves progressed remaining slices and returns terminal children without relaunch", async () => {
    const fixture = createV2Fixture("carry-progress", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-progress-next";
    let launches = 0;
    const launch = async () => { launches += 1; return { status: "started" }; };
    try {
      await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: launch });
      const childDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const beforeAcceptedMutation = readFileSync(join(childDir, "run.json"));
      await assert.rejects(transitionRunSlice(childDir, "A", (slice) => { slice.status = "running"; slice.attempts += 1; }), /cannot transition from merged|immutable/u);
      assert.deepEqual(readFileSync(join(childDir, "run.json")), beforeAcceptedMutation);
      await transitionRunSlice(childDir, "B", (slice) => { slice.status = "running"; slice.branch = `${childRunId}--B`; slice.worktree = ".opencode/worktrees/B"; slice.attempts = 1; });
      const progressedBytes = readFileSync(join(childDir, "run.json"));
      const resumed = await resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true });
      assert.equal(resumed.payload.resume.schema_version, 2);
      assert.equal(resumed.payload.driver.mode, "interactive");
      assert.equal(resumed.payload.driver.ready, true);
      assertPublishedCarryForwardRun(fixture.repo, JSON.parse(progressedBytes.toString("utf8")).continuation, { driver: resumed.payload.driver });
      const decodedResume = decodeFeatureCommandPayload(`ffpayload-v1:${Buffer.from(JSON.stringify(resumed.payload)).toString("base64url")}`, { repo: fixture.repo });
      assert.equal(decodedResume.ok, true, JSON.stringify(decodedResume));
      assert.equal(Object.hasOwn(decodedResume.payload.driver, "run_id"), false);
      assert.deepEqual(decodedResume.payload.driver, resumed.payload.driver);
      assert.deepEqual(readFileSync(join(childDir, "run.json")), progressedBytes);
      const replay = await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: launch });
      assert.deepEqual(replay.publication, { published: true, replayed: true });
      assert.deepEqual(readFileSync(join(childDir, "run.json")), progressedBytes);
      const terminal = JSON.parse(progressedBytes.toString("utf8"));
      terminal.status = "blocked";
      terminal.terminal_result = { status: "blocked", run_id: childRunId, pr_url: null, reason: "remaining work blocked", summary: "blocked", artifacts: {} };
      writeJson(join(childDir, "run.json"), terminal);
      const terminalReplay = await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: launch });
      assert.equal(terminalReplay.status, "blocked");
      assert.equal(terminalReplay.launched, false);
      assert.equal(launches, 2);
    } finally { cleanup(fixture.repo); }
  });

  it("reproduces the missing public test-verifier placeholder on a published v2 child", async () => {
    const fixture = createV2Fixture("carry-public-test-verifier", { accepted: ["A", "C"], mergeOrder: ["C", "A"] });
    const childRunId = "carry-public-test-verifier-next";
    try {
      await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => ({ status: "started" }) });
      const beforeMerged = runCli(fixture.repo, ["factory", "step", childRunId, "test-verifier", "running", "--attempts", "1", "--json"]);
      assert.notEqual(beforeMerged.status, 0);
      assert.match(beforeMerged.stderr, /test-verifier integration gate requires all slices merged: B/u);

      const childFile = join(fixture.repo, ".opencode", "factory", childRunId, "run.json");
      const child = JSON.parse(readFileSync(childFile, "utf8"));
      Object.assign(child.slices.find((slice) => slice.id === "B"), writeMergedSliceFixture(dirname(childFile), "B", child.continuation.carry_forward.start_commit));
      writeJson(childFile, child);
      const afterMerged = runCli(fixture.repo, ["factory", "step", childRunId, "test-verifier", "running", "--attempts", "1", "--json"]);
      assert.equal(afterMerged.status, 0, afterMerged.stderr);
      assert.equal(JSON.parse(afterMerged.stdout).step.status, "running");
      const childDir = dirname(childFile);
      const head = gitStdout(fixture.repo, ["rev-parse", `refs/heads/${childRunId}^{commit}`]);
      writeFileSync(join(childDir, "artifacts", "test-report.md"), "canonical integration pass\n");
      writeJson(join(childDir, "evidence", "test-verifier.attempt-1.json"), {
        subject: "test-verifier", attempt: 1, status: "pass", review_ready: true, head_sha: head,
        commands: JSON.parse(readFileSync(join(childDir, "plan", "slices.json"), "utf8")).integration_gate.required_commands.map((command) => ({ ...command, status: "pass" })),
      });
      writeJson(join(childDir, "reviews", "test-verifier.attempt-1.json"), {
        subject: "test-verifier", attempt: 1, verdict: "APPROVE", reviewed_head_sha: head, required_fixes: [],
      });
      const beforeCallerEvidence = readFileSync(childFile);
      const accepted = runCli(fixture.repo, [
        "factory", "step", childRunId, "test-verifier", "accepted", "--attempts", "1",
        "--artifact-ref", "artifacts/test-report.md", "--evidence-ref", "evidence/test-verifier.attempt-1.json",
        "--review-ref", "reviews/test-verifier.attempt-1.json", "--json",
      ]);
      assert.notEqual(accepted.status, 0, "caller-authored evidence must not create schema-v2 acceptance authority");
      assert.deepEqual(readFileSync(childFile), beforeCallerEvidence);
      rmSync(join(childDir, "evidence", "test-verifier.attempt-1.json"));
      const checked = await executeCheckedTestExecution(childDir, {
        env: { PATH: "/fixture/bin" }, now: "2026-07-17T12:00:00.000Z",
        spawnFn() {
          const childProcess = new EventEmitter();
          childProcess.stdout = new PassThrough();
          childProcess.stderr = new PassThrough();
          childProcess.kill = () => true;
          queueMicrotask(() => childProcess.emit("close", 0, null));
          return childProcess;
        },
      });
      assert.equal(checked.status, "pass");
      assert.equal(checked.receipt_ref, "evidence/test-verifier.attempt-1.json");
      const acceptedChecked = runCli(fixture.repo, [
        "factory", "step", childRunId, "test-verifier", "accepted", "--attempts", "1",
        "--artifact-ref", "artifacts/test-report.md", "--evidence-ref", checked.receipt_ref,
        "--review-ref", "reviews/test-verifier.attempt-1.json", "--json",
      ]);
      assert.equal(acceptedChecked.status, 0, acceptedChecked.stderr);
      const acceptedStep = JSON.parse(acceptedChecked.stdout).step;
      assert.equal(acceptedStep.execution_claim.state, "completed");
      assert.equal(acceptedStep.execution_claim.status, "pass");
      assert.match(acceptedStep.execution_claim_hash, /^sha256:[0-9a-f]{64}$/u);
      assert.deepEqual(Object.keys(acceptedStep.acceptance).sort(), ["artifact_hash", "artifact_ref", "evidence_hash", "evidence_ref", "review_hash", "review_ref", "reviewed_head_sha"]);
    } finally { cleanup(fixture.repo); }
  });

  it("reproduces schema downgrade and resume-policy override ingress", async () => {
    const fixture = createV2Fixture("carry-schema-ingress", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-schema-ingress-next";
    try {
      const published = await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => ({ status: "started" }) });
      const downgraded = structuredClone(published.payload);
      downgraded.continuation.schema_version = 1;
      delete downgraded.continuation.carry_forward;
      const decodedDowngrade = decodeFeatureCommandPayload(`ffpayload-v1:${Buffer.from(JSON.stringify(downgraded)).toString("base64url")}`, { repo: fixture.repo });
      assert.deepEqual(decodedDowngrade, { ok: false, reason: "invalid-continuation-schema" });

      const resumed = await resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true });
      const downgradedResume = structuredClone(resumed.payload);
      downgradedResume.resume.schema_version = 1;
      delete downgradedResume.driver.post_pr_ci;
      const decodedResume = decodeFeatureCommandPayload(`ffpayload-v1:${Buffer.from(JSON.stringify(downgradedResume)).toString("base64url")}`, { repo: fixture.repo });
      assert.deepEqual(decodedResume, { ok: false, reason: "resume-schema-route-mismatch" });

      const policyOverride = structuredClone(resumed.payload);
      policyOverride.resume.post_pr_policy.enabled = true;
      const decodedPolicy = decodeFeatureCommandPayload(`ffpayload-v1:${Buffer.from(JSON.stringify(policyOverride)).toString("base64url")}`, { repo: fixture.repo });
      assert.deepEqual(decodedPolicy, { ok: false, reason: "resume-policy-route-mismatch" });
    } finally { cleanup(fixture.repo); }
  });

  nodeIt.skip("rejects schema-v1 fallback when a permanent v2 claim already allocates the target", async () => {
    const fixture = createFixture("claim-only-v2-parent");
    const targetRunId = "claim-only-v2-child";
    try {
      const legacyContinuation = buildContinuation(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: targetRunId,
      });
      const claim = {
        schema_version: 2,
        kind: "blocked-run-continuation-claim",
        parent_identity: { schema_version: 2, kind: "blocked-run-continuation-parent" },
        child_run_id: targetRunId,
        child_branch_ref: `refs/heads/${targetRunId}`,
        start_commit: gitStdout(fixture.repo, ["rev-parse", "HEAD"]),
      };
      const oid = writeBlob(fixture.repo, canonicalJson(claim));
      updateRef(fixture.repo, `refs/opencode/continuations/${"a".repeat(64)}`, oid);

      assert.throws(() => buildContinuation(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: targetRunId,
      }), /continuation-schema-route-mismatch/u);
      const encodedContinuation = `ffpayload-v1:${Buffer.from(JSON.stringify({
        operator_request: "forged continuation",
        driver: {},
        continuation: legacyContinuation,
      })).toString("base64url")}`;
      assert.deepEqual(decodeFeatureCommandPayload(encodedContinuation, { repo: fixture.repo }), { ok: false, reason: "continuation-schema-route-mismatch" });
      const encodedResume = `ffpayload-v1:${Buffer.from(JSON.stringify({
        operator_request: `resume ${targetRunId}`,
        driver: {},
        resume: { schema_version: 1, kind: "existing-run-resume", run_id: targetRunId },
        steering: { schema_version: 1, kind: "operator-steering-pointer", run_id: targetRunId, pending: null, uncheckpointed: null, consume: null, raw_message_included: false },
      })).toString("base64url")}`;
      assert.deepEqual(decodeFeatureCommandPayload(encodedResume, { repo: fixture.repo }), { ok: false, reason: "resume-schema-route-mismatch" });
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", targetRunId)), false);
      assert.equal(refOid(fixture.repo, `refs/heads/${targetRunId}`), null);

      const targetRunDir = join(fixture.repo, ".opencode", "factory", targetRunId);
      const targetWorktree = join(fixture.repo, ".opencode", "worktrees", targetRunId);
      mkdirSync(targetRunDir, { recursive: true });
      mkdirSync(targetWorktree, { recursive: true });
      writeJson(join(targetRunDir, "run.json"), createRunRecord({
        run_id: targetRunId,
        status: "running",
        branch: targetRunId,
        worktree: targetWorktree,
        slices: [{ id: "slice", declared_paths: ["slice.txt"], effective_paths: ["slice.txt"], status: "running", attempts: 1 }],
      }));
      const before = readFileSync(join(targetRunDir, "run.json"));
      for (const [label, invoke] of [
        ["direct resume", () => resumeFactory(targetRunId, { cwd: fixture.repo, dryRun: true })],
        ["start resume", () => startFactory([`resume ${targetRunId}`], { cwd: fixture.repo })],
        ["resume check", () => recoverDisruptedRun(targetRunId, { cwd: fixture.repo })],
      ]) {
        await assert.rejects(invoke, /resume-schema-route-mismatch/u, label);
        assert.deepEqual(readFileSync(join(targetRunDir, "run.json")), before, label);
      }
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects a foreign claim targeting an absent v2 child before allocation side effects", () => {
    const fixture = createV2Fixture("carry-foreign-child-claim", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-foreign-child-claim-next";
    try {
      const candidate = buildContinuation(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
      });
      const foreign = expectedClaim(candidate).claim;
      foreign.parent_identity.parent_run_hash = `sha256:${"f".repeat(64)}`;
      const foreignBytes = canonicalJson(foreign);
      const foreignRef = `refs/opencode/continuations/${createHash("sha256").update(canonicalJson(foreign.parent_identity)).digest("hex")}`;
      updateRef(fixture.repo, foreignRef, writeBlob(fixture.repo, foreignBytes));

      assert.throws(() => continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
      }), /foreign schema-v2 claim/u);
      assert.equal(refOid(fixture.repo, `refs/heads/${childRunId}`), null);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", childRunId)), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false);
      assert.deepEqual(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]).split("\n"), [foreignRef]);
      assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuation-targets"]), "");
    } finally {
      cleanup(fixture.repo);
    }
  });

  nodeIt.skip("serializes schema-v1 seed publication against schema-v2 allocation for one target", () => {
    const fixture = createV2Fixture("carry-cross-schema-race", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-cross-schema-race-next";
    try {
      assert.throws(() => continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        beforeContinuationSeedPublish() {
          const sameSchema = buildContinuation(fixture.runId, {
            cwd: fixture.repo,
            review: "reviewer.json",
            runId: childRunId,
          });
          sameSchema.created_at = "2026-07-18T23:59:59.000Z";
          assert.throws(() => assertContinuationReservationAuthority(fixture.repo, sameSchema), /continuation-schema-route-mismatch/u);
          assert.throws(() => continueFactory(fixture.runId, {
            cwd: fixture.repo,
            review: "reviewer.json",
            runId: childRunId,
            carryForward: true,
          }), /already reserved by a conflicting schema or authority/u);
          throw new Error("stop after cross-schema race proof");
        },
      }), /stop after cross-schema race proof/u);

      assert.equal(gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]), "");
      assert.equal(refOid(fixture.repo, `refs/heads/${childRunId}`), null);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", childRunId)), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false);
      const reservations = gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuation-targets"]);
      assert.match(reservations, /^refs\/opencode\/continuation-targets\/[a-f0-9]{64}$/u);
      assert.throws(() => continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        beforeContinuationSeedPublish() { throw new Error("exact schema-v1 reservation replay reached publication"); },
      }), /exact schema-v1 reservation replay reached publication/u);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("reproduces post-publication and recovery authority gaps without launching or writing", async () => {
    for (const [label, mutate, fixtureOptions = {}] of [
      ["parent", (fixture) => writeFileSync(join(fixture.runDir, "run.json"), `${readFileSync(join(fixture.runDir, "run.json"), "utf8")} `)],
      ["plan", (fixture) => writeFileSync(join(fixture.runDir, "plan", "slices.json"), "{\"slices\":[]}")],
      ["sidecar", (fixture) => writeFileSync(join(fixture.runDir, "reviews", "A.json"), "{}\n")],
      ["parent-branch", (fixture) => runGit(fixture.repo, ["commit", "--allow-empty", "-m", "post-publication parent branch race"])],
      ["panel", (fixture) => writeFileSync(join(fixture.runDir, "reviews", "security.json"), "{}\n"), { panels: true }],
      ["origin", (fixture) => {
        runGit(fixture.repo, ["checkout", "main"]); runGit(fixture.repo, ["commit", "--allow-empty", "-m", "post-publication origin race"]);
        runGit(fixture.repo, ["push", "origin", "main:main"]); runGit(fixture.repo, ["checkout", fixture.runId]);
      }],
      ["claim", (fixture, state) => updateRef(fixture.repo, state.allocation.claim_ref, writeBlob(fixture.repo, "{}"))],
      ["child-branch", (fixture, state) => updateRef(fixture.repo, state.allocation.child_branch_ref, fixture.baseCommit)],
      ["worktree", (fixture, state) => runGit(state.continuation.target.worktree, ["checkout", "--detach", fixture.baseCommit])],
    ]) {
      const fixture = createV2Fixture(`carry-post-publication-${label}`, { accepted: ["A"], mergeOrder: ["A"], ...fixtureOptions });
      const childRunId = `${fixture.runId}-next`;
      let launches = 0;
      try {
        await assert.rejects(continueFactory(fixture.runId, {
          cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
          afterCarryForwardPublish(state) { mutate(fixture, state); },
          foregroundLaunchFn: async () => { launches += 1; return { status: "started" }; },
        }), /carry_forward authority changed|origin-base|stale-parent-base|bound plan|parent plan|parent run|parent_evidence|branch|panel|claim|worktree|sidecar|review/u, label);
        assert.equal(launches, 0, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId, "run.json")), true, label);
      } finally { cleanup(fixture.repo); }
    }

    const recovery = createV2Fixture("carry-recovery-authority", { accepted: ["A"], mergeOrder: ["A"] });
    const recoveryChild = "carry-recovery-authority-next";
    try {
      await continueFactory(recovery.runId, { cwd: recovery.repo, review: "reviewer.json", runId: recoveryChild, carryForward: true, foregroundLaunchFn: async () => ({ status: "started" }) });
      const childFile = join(recovery.repo, ".opencode", "factory", recoveryChild, "run.json");
      const before = readFileSync(childFile);
      writeFileSync(join(recovery.runDir, "plan", "slices.json"), "{\"slices\":[]}");
      await assert.rejects(recoverDisruptedRun(recoveryChild, { cwd: recovery.repo }), /carry_forward authority changed|bound plan/u);
      assert.deepEqual(readFileSync(childFile), before);
    } finally { cleanup(recovery.repo); }
  });

  it("rejects resume and semantic writes after merged child history is reset", async () => {
    const fixture = createV2Fixture("carry-merged-history-reset", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-merged-history-reset-next";
    try {
      await continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started" }),
      });
      const childDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const childFile = join(childDir, "run.json");
      const child = JSON.parse(readFileSync(childFile, "utf8"));
      const worktree = child.worktree;
      runGit(worktree, ["commit", "--allow-empty", "-m", "merge remaining B"]);
      const mergedCommit = gitStdout(worktree, ["rev-parse", "HEAD"]);
      Object.assign(child.slices.find((slice) => slice.id === "B"), writeMergedSliceFixture(childDir, "B", mergedCommit));
      writeJson(childFile, child);
      runGit(worktree, ["reset", "--hard", child.continuation.carry_forward.start_commit]);
      const before = readFileSync(childFile);

      await assert.rejects(
        transitionRunSlice(childDir, "C", (slice) => { slice.status = "running"; slice.attempts = 1; }),
        /merged slice 'B'.*not an ancestor of exact clean child HEAD/u,
      );
      await assert.rejects(
        resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true }),
        /merged slice 'B'.*not an ancestor of exact clean child HEAD/u,
      );
      assert.deepEqual(readFileSync(childFile), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("binds one exact clean child HEAD snapshot through semantic run replacement", async () => {
    const fixture = createV2Fixture("carry-semantic-head-race", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-semantic-head-race-next";
    try {
      await continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started" }),
      });
      const childDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const childFile = join(childDir, "run.json");
      const worktree = JSON.parse(readFileSync(childFile, "utf8")).worktree;
      const before = readFileSync(childFile);

      await assert.rejects(
        transitionRunSlice(childDir, "C", (slice) => { slice.status = "running"; slice.attempts = 1; }, {
          atomicWriteHooks: { beforeCommit: () => runGit(worktree, ["commit", "--allow-empty", "-m", "race semantic publication"]) },
        }),
        (error) => error?.cause?.message === "schema-v2 local publication authority changed before mutation",
      );
      assert.deepEqual(readFileSync(childFile), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects multiple permanent claims for one published schema-v2 child", async () => {
    const fixture = createV2Fixture("carry-multiple-claims", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-multiple-claims-next";
    try {
      await continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviewer.json",
        runId: childRunId,
        carryForward: true,
        foregroundLaunchFn: async () => ({ status: "started" }),
      });
      const existingRef = gitStdout(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/continuations"]);
      const existingOid = refOid(fixture.repo, existingRef);
      const duplicate = JSON.parse(gitStdoutPreserve(fixture.repo, ["cat-file", "blob", existingOid]));
      duplicate.parent_identity.parent_run_hash = `sha256:${"f".repeat(64)}`;
      const duplicateOid = writeBlob(fixture.repo, canonicalJson(duplicate));
      updateRef(fixture.repo, `refs/opencode/continuations/${"f".repeat(64)}`, duplicateOid);

      await assert.rejects(
        resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true }),
        /multiple permanent continuation claims target run/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("reproduces internal schema-v2 adoption acceptance", async () => {
    const fixture = createV2Fixture("carry-internal-adoption", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-internal-adoption-next";
    try {
      await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => ({ status: "started" }) });
      const childDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const before = readFileSync(join(childDir, "run.json"));
      await assert.rejects(transitionContinuationAdoption(childDir, { repoRoot: gitStdout(fixture.repo, ["rev-parse", "--show-toplevel"]) }), /schema-v2 carry-forward spec adoption is already canonical and immutable/u);
      assert.deepEqual(readFileSync(join(childDir, "run.json")), before);
    } finally { cleanup(fixture.repo); }
  });

  it("keeps every copied planning byte immutable across v2 mutation, downstream, resume, and launch entry points", async () => {
    const fixture = createV2Fixture("carry-planning-immutable", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-planning-immutable-next";
    let launches = 0;
    try {
      await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => { launches += 1; return { status: "started" }; } });
      const childDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const runFile = join(childDir, "run.json");
      const cases = [
        ["artifacts/story.md", () => transitionRunSlice(childDir, "B", (slice) => { slice.status = "running"; slice.attempts = 1; slice.branch = `${childRunId}--B`; slice.worktree = ".opencode/worktrees/B"; })],
        ["artifacts/research-map.md", () => transitionPanelVerdicts(childDir, { validator: { verdict: "GO", report: "artifacts/story.md", review_ref: "reviews/implementation-validator.json" }, security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" } }, { repoRoot: fixture.repo })],
        ["artifacts/design-brief.md", () => transitionPrePrFenceEstablished(childDir, {})],
        ["artifacts/technical-brief.md", () => transitionPrCreated(childDir, {}, { fenceToken: "missing-fence" })],
        ["reviews/spec-writer.json", () => resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true })],
        ["plan/slices.json", () => transitionRunSlice(childDir, "B", (slice) => { slice.status = "running"; slice.attempts = 1; })],
        ["reviews/work-decomposer.json", () => resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true })],
      ];
      for (const [ref, invoke] of cases) {
        const path = join(childDir, ref);
        const original = readFileSync(path);
        const before = readFileSync(runFile);
        writeFileSync(path, `${original.toString("utf8")}drift\n`);
        await assert.rejects(async () => invoke(), /published inherited planning bytes changed|published inherited spec review bytes changed|published carry-forward plan bytes do not match|published carry-forward child directory is invalid/u, ref);
        assert.deepEqual(readFileSync(runFile), before, ref);
        writeFileSync(path, original);
      }

      const storyPath = join(childDir, "artifacts", "story.md");
      const story = readFileSync(storyPath);
      writeFileSync(storyPath, `${story.toString("utf8")}launch drift\n`);
      await assert.rejects(continueFactory(fixture.runId, {
        cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
        foregroundLaunchFn: async () => { launches += 1; return { status: "started" }; },
      }), /published inherited planning bytes changed/u);
      assert.equal(launches, 1);
      writeFileSync(storyPath, story);

      const designPath = join(childDir, "artifacts", "design-brief.md");
      const design = readFileSync(designPath);
      const beforeEnv = readFileSync(runFile);
      await assert.rejects(persistFactoryRunResumeEnv(childRunId, {
        cwd: fixture.repo,
        resumeEnvHooks: { beforeWrite: () => writeFileSync(designPath, `${design.toString("utf8")}resume env race\n`) },
      }), /published inherited planning bytes changed/u);
      assert.deepEqual(readFileSync(runFile), beforeEnv);
      writeFileSync(designPath, design);
    } finally { cleanup(fixture.repo); }
  });

  it("rechecks complete v2 authority after launch ownership acquisition", async () => {
    for (const kind of ["parent", "origin"]) {
      const fixture = createV2Fixture(`carry-launch-race-${kind}`, { accepted: ["A"], mergeOrder: ["A"] });
      const childRunId = `${fixture.runId}-next`;
      let launches = 0;
      try {
        await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => { launches += 1; return { status: "started" }; } });
        await assert.rejects(continueFactory(fixture.runId, {
          cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true,
          launchHooks: { afterClaimAcquired() {
            if (kind === "parent") writeFileSync(join(fixture.runDir, "run.json"), `${readFileSync(join(fixture.runDir, "run.json"), "utf8")} `);
            else {
              runGit(fixture.repo, ["checkout", "main"]); runGit(fixture.repo, ["commit", "--allow-empty", "-m", "launch origin race"]);
              runGit(fixture.repo, ["push", "origin", "main:main"]); runGit(fixture.repo, ["checkout", fixture.runId]);
            }
          } },
          foregroundLaunchFn: async () => { launches += 1; return { status: "started" }; },
        }), /parent run\.json changed|origin-base|stale-parent-base/u, kind);
        assert.equal(launches, 1, kind);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId, "process-launch.lock", "owner.json")), false, kind);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("rechecks complete v2 authority before recovery mutation", async () => {
    for (const kind of ["origin", "plan", "planning"]) {
      const fixture = createV2Fixture(`carry-recovery-race-${kind}`, { accepted: ["A"], mergeOrder: ["A"] });
      const childRunId = `${fixture.runId}-next`;
      try {
        await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => ({ status: "started" }) });
        const childDir = join(fixture.repo, ".opencode", "factory", childRunId);
        const childFile = join(childDir, "run.json");
        const before = readFileSync(childFile);
        if (kind === "plan") writeFileSync(join(fixture.runDir, "plan", "slices.json"), "{\"slices\":[]}");
        else if (kind === "planning") writeFileSync(join(childDir, "artifacts", "research-map.md"), "drift\n");
        else {
          runGit(fixture.repo, ["checkout", "main"]); runGit(fixture.repo, ["commit", "--allow-empty", "-m", "recovery origin race"]);
          runGit(fixture.repo, ["push", "origin", "main:main"]); runGit(fixture.repo, ["checkout", fixture.runId]);
        }
        await assert.rejects(recoverDisruptedRun(childRunId, { cwd: fixture.repo }), /bound plan|published inherited planning bytes changed|origin-base|stale-parent-base/u, kind);
        assert.deepEqual(readFileSync(childFile), before, kind);
      } finally { cleanup(fixture.repo); }
    }
  });

  it("starts only dependency-ready remaining rows and never consumes adopted attempts", async () => {
    const fixture = createV2Fixture("carry-dependencies", { accepted: ["C"], mergeOrder: ["C"] });
    const childRunId = "carry-dependencies-next";
    try {
      await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => ({ status: "started" }) });
      const childDir = join(fixture.repo, ".opencode", "factory", childRunId);
      const before = JSON.parse(readFileSync(join(childDir, "run.json"), "utf8"));
      assert.deepEqual(before.slices.map(({ id, status, attempts }) => ({ id, status, attempts })), [
        { id: "A", status: "pending", attempts: 0 }, { id: "B", status: "pending", attempts: 0 }, { id: "C", status: "merged", attempts: 1 },
      ]);
      await assert.rejects(transitionRunSlice(childDir, "B", (slice) => { slice.status = "running"; slice.attempts = 1; }), /not dependency-ready: A/u);
      const after = JSON.parse(readFileSync(join(childDir, "run.json"), "utf8"));
      assert.equal(after.slices[1].attempts, 0);
      assert.equal(after.slices[2].attempts, 1);
    } finally { cleanup(fixture.repo); }
  });

  it("rechecks parent origin authority before schema-v2 resume mutation", async () => {
    const fixture = createV2Fixture("carry-resume-origin", { accepted: ["A"], mergeOrder: ["A"] });
    const childRunId = "carry-resume-origin-next";
    try {
      await continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: childRunId, carryForward: true, foregroundLaunchFn: async () => ({ status: "started" }) });
      const childFile = join(fixture.repo, ".opencode", "factory", childRunId, "run.json");
      const before = readFileSync(childFile);
      runGit(fixture.repo, ["checkout", "main"]); runGit(fixture.repo, ["commit", "--allow-empty", "-m", "resume origin moved"]);
      runGit(fixture.repo, ["push", "origin", "main:main"]); runGit(fixture.repo, ["checkout", fixture.runId]);
      await assert.rejects(resumeFactory(childRunId, { cwd: fixture.repo, dryRun: true }), /stale-parent-base-moved|rebaseline-required/u);
      assert.deepEqual(readFileSync(childFile), before);
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

describe("issue 128 continuation executable oracle", { concurrency: true }, () => {
  it("preserves an ordinary merged A2/S2 row only with its same-binding merged owner", { skip: issue128WorkerRoute !== "ordinary-continuation" }, async () => {
    const observedBaselineIds = [];
    if (issue128WorkerChunk === 0) {
      const fixtureName = `issue128-ordinary-sibling-chunk-${issue128WorkerChunk}-of-${issue128WorkerChunkCount}`;
      const fixture = createV2SiblingAuthorityFixture(fixtureName);
      const childRunId = `${fixtureName}-next`;
      try {
        const parent = JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8"));
        const parentConsumer = parent.slices.find(({ id }) => id === "consumer");
        const refs = parent.slices.flatMap((slice) => (slice.attempt_reviews || []).flatMap((entry) => [entry.evidence_ref, entry.review_ref, entry.dispatch_claim_ref, entry.dispatch_closure_ref]));
        const parentBytes = new Map(refs.map((ref) => [ref, readFileSync(join(fixture.runDir, ref))]));

        const result = await continueFactory(fixture.runId, {
          cwd: fixture.repo,
          review: fixture.continuationReviewRef,
          runId: childRunId,
          carryForward: true,
          foregroundLaunchFn: async () => ({ status: "started", run_id: childRunId }),
        });
        const accepted = result.payload.continuation.carry_forward.accepted_slices;
        const childRunDir = join(fixture.repo, ".opencode", "factory", childRunId);
        const child = JSON.parse(readFileSync(join(childRunDir, "run.json"), "utf8"));
        const childConsumer = child.slices.find(({ id }) => id === "consumer");

        assert.deepEqual(accepted.map(({ id }) => id), ["owner", "consumer"]);
        assert.deepEqual(accepted.find(({ id }) => id === "consumer"), fixture.issue128Catalog.source);
        observedBaselineIds.push(fixture.issue128Catalog.id);
        assert.deepEqual(observedBaselineIds, issue128BaselineIdsForRoute("ordinary-continuation"));
        assert.deepEqual(childConsumer.attempt_reviews, parentConsumer.attempt_reviews);
        assert.deepEqual(issue128CarryForwardProjection(childConsumer), fixture.issue128Catalog.source);
        assert.deepEqual(childConsumer.effective_paths, ["src/consumer/**", "src/owner/shared.js"]);
        assert.equal(childConsumer.attempt_reviews[0].modified_extensions[0].authority, "non-conflicting-sibling");
        for (const [ref, bytes] of parentBytes) assert.deepEqual(readFileSync(join(childRunDir, ref)), bytes, ref);
      } finally { cleanup(fixture.repo); }
    }

    const mutationFixture = createV2SiblingAuthorityFixture(`issue128-ordinary-oracle-mutations-chunk-${issue128WorkerChunk}-of-${issue128WorkerChunkCount}`);
    let mutations;
    try {
      mutations = exerciseIssue128ContinuationMutations(mutationFixture, "continuation-carry-forward-accepted-slice-v2", issue128WorkerChunk, issue128WorkerChunkCount);
      assert.equal(mutations.executed, 89);
    } finally { cleanup(mutationFixture.repo); }
    process.stdout.write(`${issue128WorkerCompletion("ordinary-continuation", issue128WorkerChunk, observedBaselineIds, mutations)}\n`);
  });

  it("preserves a checkpoint-bound merged A2/S2 owner pair and rejects owner drift before publication", { skip: issue128WorkerRoute !== "checkpoint-continuation" }, async () => {
    const observedBaselineIds = [];
    if (issue128WorkerChunk === 0) {
      const fixtureName = `issue128-checkpoint-sibling-chunk-${issue128WorkerChunk}-of-${issue128WorkerChunkCount}`;
      const fixture = createV2SiblingAuthorityFixture(fixtureName);
      const childRunId = `${fixtureName}-next`;
      const checkpointRow = ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG.find(({ id }) => id === "checkpoint-carry-forward-accepted-slice-v2");
      try {
        const bound = bindCheckpointContinuationFixture(fixture, "strict");
        const parent = JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8"));
        const parentConsumer = parent.slices.find(({ id }) => id === "consumer");
        const result = await continueFactory(fixture.runId, {
          cwd: fixture.repo,
          review: fixture.continuationReviewRef,
          runId: childRunId,
          carryForward: true,
          foregroundLaunchFn: async () => ({ status: "started", run_id: childRunId }),
        });
        const child = JSON.parse(readFileSync(join(fixture.repo, ".opencode", "factory", childRunId, "run.json"), "utf8"));
        assert.deepEqual(child.checkpoint_source, bound.source);
        assert.deepEqual(result.payload.continuation.carry_forward.accepted_slices.find(({ id }) => id === "consumer"), checkpointRow.source);
        assert.deepEqual(issue128CarryForwardProjection(child.slices.find(({ id }) => id === "consumer")), checkpointRow.source);
        observedBaselineIds.push(checkpointRow.id);
        assert.deepEqual(observedBaselineIds, issue128BaselineIdsForRoute("checkpoint-continuation"));
        assert.deepEqual(child.slices.find(({ id }) => id === "consumer").attempt_reviews, parentConsumer.attempt_reviews);
        assert.equal(result.payload.continuation.carry_forward.accepted_slices.find(({ id }) => id === "consumer").attempt_reviews[0].modified_extensions[0].owner_slice_id, "owner");
      } finally { cleanup(fixture.repo); }

      for (const field of ["owner_reviewed_commit", "owner_diff_base_commit"]) {
        const identity = createV2SiblingAuthorityFixture(`issue128-checkpoint-${field}-chunk-${issue128WorkerChunk}-of-${issue128WorkerChunkCount}`);
        const staleChild = `issue128-checkpoint-stale-${field}-chunk-${issue128WorkerChunk}-next`;
        try {
          bindCheckpointContinuationFixture(identity, null);
          updateRun(identity, (run) => {
            run.slices.find(({ id }) => id === "consumer").attempt_reviews[0].modified_extensions[0][field] = "0".repeat(40);
          });
          const parentBytes = readFileSync(join(identity.runDir, "run.json"), "utf8");
          assert.throws(
            () => continueFactory(identity.runId, { cwd: identity.repo, review: identity.continuationReviewRef, runId: staleChild, carryForward: true, dryRun: true }),
            /owner|sibling|binding|stale|cross-bound/u,
            field,
          );
          assert.equal(readFileSync(join(identity.runDir, "run.json"), "utf8"), parentBytes, field);
          assert.equal(existsSync(join(identity.repo, ".opencode", "factory", staleChild)), false, field);
          assert.equal(refOid(identity.repo, `refs/heads/${staleChild}`), null, field);
        } finally { cleanup(identity.repo); }
      }
    }

    const mutationFixture = createV2SiblingAuthorityFixture(`issue128-checkpoint-stale-chunk-${issue128WorkerChunk}-of-${issue128WorkerChunkCount}`);
    let mutations;
    try {
      bindCheckpointContinuationFixture(mutationFixture, null);
      mutations = exerciseIssue128ContinuationMutations(mutationFixture, "checkpoint-carry-forward-accepted-slice-v2", issue128WorkerChunk, issue128WorkerChunkCount);
      assert.equal(mutations.executed, 89);
    } finally { cleanup(mutationFixture.repo); }
    process.stdout.write(`${issue128WorkerCompletion("checkpoint-continuation", issue128WorkerChunk, observedBaselineIds, mutations)}\n`);
  });

});

function runIssue128ContinuationWorker(route, testName, chunk) {
  return new Promise((resolve) => {
    const env = { ...process.env, [issue128WorkerEnv]: route, [issue128WorkerChunkEnv]: String(chunk) };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--test", "--test-name-pattern", `^${escapeRegExp(testName)}$`, currentTestPath], {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let error = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (childError) => { error = childError; });
    child.on("close", (code, signal) => resolve({ route, chunk, code, signal, error, stdout, stderr }));
  });
}

function issue128WorkerDiagnostics({ route, chunk, code, signal, error, stdout, stderr }) {
  return [
    `${route} chunk ${chunk} worker failed (code=${String(code)}, signal=${String(signal)})`,
    error ? error.stack || error.message : "",
    stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
    stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
  ].filter(Boolean).join("\n");
}

const issue128WorkerCompletionPrefix = "issue128 continuation worker complete: ";

function issue128WorkerCompletion(route, chunk, baselineIds, mutations) {
  return `${issue128WorkerCompletionPrefix}${JSON.stringify({
    route,
    chunk,
    chunk_count: issue128WorkerChunkCount,
    baseline_ids: baselineIds,
    executed: mutations.executed,
    mutation_names: mutations.mutationNames,
    mutation_digest: mutations.mutationDigest,
  })}`;
}

function parseIssue128WorkerCompletion(stdout, diagnostics) {
  const line = stdout.split("\n").find((entry) => entry.includes(issue128WorkerCompletionPrefix));
  assert.ok(line, diagnostics);
  return JSON.parse(line.slice(line.indexOf(issue128WorkerCompletionPrefix) + issue128WorkerCompletionPrefix.length));
}

function issue128MutationNamesForRoute(route) {
  const recordId = issue128WorkerRecords[route];
  const row = ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG.find(({ id }) => id === recordId);
  assert.ok(row, `${route}: registered mutation row`);
  return emitIssue128FinishAndDiscloseMutations(row).map(({ name }) => name);
}

function issue128MutationNameDigest(names) {
  return createHash("sha256").update(names.join("\0"), "utf8").digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

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

// The carry-forward git topology (bare origin, per-slice reviewed commits,
// first-parent merges) depends only on (accepted, mergeOrder), not on runId or
// panels. It is the expensive part — ~13 git subprocesses per fixture — and the
// loop tests rebuild it many times with constant params. Build it once per
// (accepted, mergeOrder) key under a placeholder runId, then clone and rebind
// branches to the caller's runId. Commit SHAs are captured from the template
// and preserved by the copy, so the cloned repo is internally consistent and
// the runDir/run.json (written afterward, unchanged) references real commits.
const V2_TEMPLATE_RUN = "v2template";
const v2Templates = new Map();
const v2TemplateDirs = [];

function configureNonconvergentRoute(fixture) {
  const head = gitStdout(fixture.repo, ["rev-parse", `${fixture.runId}^{commit}`]);
  const evidenceRef = "evidence/B.attempt-2.json";
  const reviewRef = "reviews/B.attempt-2.json";
  const priorEvidenceRef = "evidence/B.attempt-1.json";
  const priorReviewRef = "reviews/B.attempt-1.json";
  writeJson(join(fixture.runDir, priorEvidenceRef), { subject: "B", attempt: 1, status: "pass", review_ready: true, head_sha: head });
  writeJson(join(fixture.runDir, priorReviewRef), {
    subject: "B", attempt: 1, reviewed_commit: head, verdict: "REJECT", convergence: "converging", late_discovery_strike: false,
    remaining_fix_count: 1, required_fixes: ["first correction"],
    ownership_ratification: { schema_version: 1, paths: [] },
    remediation_context: { schema_version: 2, fixes: [{ required_fix_index: 0, classification: "narrow-correction", scope_effect: "in-lane", likely_paths: ["B.txt"], fix_owner: "B" }] },
  });
  writeJson(join(fixture.runDir, evidenceRef), { subject: "B", attempt: 2, status: "pass", review_ready: true, head_sha: head });
  const currentReview = {
    subject: "B", attempt: 2, reviewed_commit: head, verdict: "REJECT", convergence: "nonconvergent", late_discovery_strike: false,
    remaining_fix_count: 1, required_fixes: ["replace the missed category"],
    ownership_ratification: { schema_version: 1, paths: [] },
    remediation_context: { schema_version: 2, fixes: [{ required_fix_index: 0, classification: "nonconvergent", scope_effect: "in-lane", likely_paths: ["B.txt"], fix_owner: "B" }] },
  };
  writeJson(join(fixture.runDir, reviewRef), currentReview);
  const priorReview = {
    attempt: 1,
    evidence_ref: priorEvidenceRef,
    evidence_hash: hashFile(join(fixture.runDir, priorEvidenceRef)),
    review_ref: priorReviewRef,
    review_hash: hashFile(join(fixture.runDir, priorReviewRef)),
    reviewed_commit: head,
    diff_base_commit: head,
    ratified_paths: [],
    verdict: "REJECT",
    convergence: "converging",
    late_discovery_strike: false,
    remaining_fix_count: 1,
  };
  const sourceReview = {
    attempt: 2,
    evidence_ref: evidenceRef,
    evidence_hash: hashFile(join(fixture.runDir, evidenceRef)),
    review_ref: reviewRef,
    review_hash: hashFile(join(fixture.runDir, reviewRef)),
    reviewed_commit: head,
    diff_base_commit: head,
    ratified_paths: [],
    verdict: "REJECT",
    convergence: "nonconvergent",
    late_discovery_strike: false,
    remaining_fix_count: 1,
  };
  updateRun(fixture, (run) => {
    run.slices[1] = {
      ...run.slices[1], status: "blocked", attempts: 2, evidence_ref: evidenceRef, review_ref: reviewRef,
      attempt_reviews: [priorReview, sourceReview], blocked_reason: "slice-review-nonconvergent",
    };
    run.terminal_result = {
      status: "blocked", run_id: fixture.runId, pr_url: null, reason: "slice-review-nonconvergent", summary: "nonconvergent", artifacts: {},
      nonconvergence: {
        schema_version: 1, kind: "slice-review-nonconvergence", slice_id: "B", source_review: sourceReview,
        continuation: { program: "feature-factory", args: ["factory", "continue", fixture.runId, "--review", reviewRef, "--run-id", "<new-run-id>", "--carry-forward", "--json"] },
      },
    };
  });
  return { head, evidenceRef, reviewRef, priorEvidenceRef, priorReviewRef, currentReview, sourceReview };
}

function configureConvergingSliceRoute(fixture) {
  const head = gitStdout(fixture.repo, ["rev-parse", `${fixture.runId}^{commit}`]);
  const evidenceRef = "evidence/B.attempt-1.json";
  const reviewRef = "reviews/B.attempt-1.json";
  writeJson(join(fixture.runDir, evidenceRef), { subject: "B", attempt: 1, status: "pass", review_ready: true, head_sha: head });
  writeJson(join(fixture.runDir, reviewRef), {
    subject: "B", attempt: 1, reviewed_commit: head, verdict: "REJECT", convergence: "converging", late_discovery_strike: false,
    remaining_fix_count: 1, required_fixes: ["apply the selected correction"],
    ownership_ratification: { schema_version: 1, paths: [] },
    remediation_context: { schema_version: 2, fixes: [{ required_fix_index: 0, classification: "narrow-correction", scope_effect: "in-lane", likely_paths: ["B.txt"], fix_owner: "B" }] },
  });
  const source = {
    attempt: 1,
    evidence_ref: evidenceRef,
    evidence_hash: hashFile(join(fixture.runDir, evidenceRef)),
    review_ref: reviewRef,
    review_hash: hashFile(join(fixture.runDir, reviewRef)),
    reviewed_commit: head,
    diff_base_commit: head,
    ratified_paths: [],
    verdict: "REJECT",
    convergence: "converging",
    late_discovery_strike: false,
    remaining_fix_count: 1,
  };
  updateRun(fixture, (run) => {
    run.slices[1] = {
      ...run.slices[1], status: "blocked", attempts: 1, evidence_ref: evidenceRef, review_ref: reviewRef,
      attempt_reviews: [source], blocked_reason: "slice review rejected",
    };
  });
  return { evidenceRef, reviewRef, source };
}

function v2GitTemplate(accepted, mergeOrder) {
  const key = JSON.stringify([accepted, mergeOrder]);
  const cached = v2Templates.get(key);
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "factory-carry-template-"));
  v2TemplateDirs.push(dir);
  initGitRepo(dir);
  runGit(dir, ["init", "--bare", join(dir, ".git", "test-origin.git")]);
  runGit(dir, ["remote", "add", "origin", join(dir, ".git", "test-origin.git")]);
  runGit(dir, ["push", "origin", "main:main"]);
  const baseCommit = gitStdout(dir, ["rev-parse", "main^{commit}"]);
  runGit(dir, ["checkout", "-b", V2_TEMPLATE_RUN, baseCommit]);
  const reviewedCommits = {};
  const mergeCommits = {};
  for (const id of accepted) {
    runGit(dir, ["checkout", "-b", `${V2_TEMPLATE_RUN}--${id}`, baseCommit]);
    writeFileSync(join(dir, `${id}.txt`), `${id}\n`);
    runGit(dir, ["add", `${id}.txt`]);
    runGit(dir, ["commit", "-m", `reviewed ${id}`]);
    reviewedCommits[id] = gitStdout(dir, ["rev-parse", "HEAD"]);
  }
  runGit(dir, ["checkout", V2_TEMPLATE_RUN]);
  for (const id of mergeOrder) {
    runGit(dir, ["merge", "--no-ff", "--no-edit", `${V2_TEMPLATE_RUN}--${id}`]);
    mergeCommits[id] = gitStdout(dir, ["rev-parse", "HEAD"]);
  }
  const template = { dir, baseCommit, reviewedCommits, mergeCommits };
  v2Templates.set(key, template);
  return template;
}

function createV2Fixture(runId, { accepted = ["A"], mergeOrder = accepted, panels = false, fixturePrefix = "factory-carry-forward-" } = {}) {
  const repo = mkdtempSync(join(tmpdir(), fixturePrefix));
  const template = v2GitTemplate(accepted, mergeOrder);
  cpSync(template.dir, repo, { recursive: true });
  // Repoint the copied bare origin at this repo's copy, not the template's.
  runGit(repo, ["remote", "set-url", "origin", join(repo, ".git", "test-origin.git")]);
  const { baseCommit, reviewedCommits, mergeCommits } = template;
  // Recreate the runId-named branches at the captured SHAs, then remove the
  // placeholder branches so no template-named refs linger.
  for (const id of accepted) runGit(repo, ["branch", `${runId}--${id}`, reviewedCommits[id]]);
  const tip = mergeOrder.length ? mergeCommits[mergeOrder[mergeOrder.length - 1]] : baseCommit;
  runGit(repo, ["checkout", "-b", runId, tip]);
  runGit(repo, ["branch", "-D", V2_TEMPLATE_RUN, ...accepted.map((id) => `${V2_TEMPLATE_RUN}--${id}`)]);

  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "evidence"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  mkdirSync(join(runDir, "plan"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "story.md"), "story\n");
  writeFileSync(join(runDir, "artifacts", "research-map.md"), "research\n");
  writeFileSync(join(runDir, "artifacts", "design-brief.md"), "design\n");
  writeFileSync(join(runDir, "artifacts", "technical-brief.md"), "accepted brief\n");
  writeFileSync(join(runDir, "artifacts", "validation-report.md"), "blocked\n");
  writeJson(join(runDir, "reviews", "spec-writer.json"), createReviewRecord({ subject: "spec-writer", verdict: "APPROVE", required_fixes: [], summary: "accepted planning" }));
  writeJson(join(runDir, "reviews", "reviewer.json"), { ...createReviewRecord({ subject: runId, attempt: 1, verdict: "NO-GO", required_fixes: undefined, summary: "needs continuation" }), reviewed_head_sha: tip });
  writeJson(join(runDir, "reviews", "security.json"), { subject: runId, attempt: 1, verdict: "BLOCK", reviewed_head_sha: tip });
  const plan = withDeliveryEnvelope({
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: [
      { id: "A", stack: "backend", paths: ["A.txt"], depends_on: [], acceptance: ["A accepted"], test_plan: ["test A"] },
      { id: "B", stack: "backend", paths: ["B.txt"], depends_on: ["A"], acceptance: ["B accepted"], test_plan: ["test B"] },
      { id: "C", stack: "backend", paths: ["C.txt"], depends_on: [], acceptance: ["C accepted"], test_plan: ["test C"] },
    ],
  });
  writeJson(join(runDir, "plan", "slices.json"), plan);
  writeJson(join(runDir, "reviews", "work-decomposer.json"), createReviewRecord({ subject: "work-decomposer", verdict: "APPROVE", required_fixes: [], summary: "accepted decomposition" }));

  const slices = plan.slices.map((planned) => {
    if (!accepted.includes(planned.id)) return { id: planned.id, stack: planned.stack, depends_on: planned.depends_on, declared_paths: [...planned.paths], effective_paths: [...planned.paths], status: "pending", attempts: 0 };
    const evidenceRef = `evidence/${planned.id}.json`;
    const familyEvidenceRef = `evidence/${planned.id}.family.json`;
    const reviewRef = `reviews/${planned.id}.json`;
    writeJson(join(runDir, evidenceRef), { subject: planned.id, attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommits[planned.id] });
    const evidenceHash = hashFile(join(runDir, evidenceRef));
    const familyEvidence = writeFamilyReceipt(runDir, runId, plan, planned.id, 1, reviewedCommits[planned.id], familyEvidenceRef);
    writeJson(join(runDir, reviewRef), {
      subject: planned.id, attempt: 1, verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0,
      required_fixes: [], ownership_ratification: { schema_version: 1, paths: [] }, remediation_context: { schema_version: 2, fixes: [] }, reviewed_commit: reviewedCommits[planned.id],
      invariant_family_ledger: passingInvariantFamilyLedger({ plan, sliceId: planned.id, reviewedCommit: reviewedCommits[planned.id], evidenceRef: familyEvidenceRef, evidenceHash: familyEvidence.hash }),
    });
    const reviewHash = hashFile(join(runDir, reviewRef));
    const attemptReview = {
      attempt: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash,
      reviewed_commit: reviewedCommits[planned.id], diff_base_commit: baseCommit, ratified_paths: [], verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0,
    };
    return {
      id: planned.id, stack: planned.stack, depends_on: planned.depends_on, declared_paths: [...planned.paths], effective_paths: [...planned.paths], status: "merged", attempts: 1,
      evidence_ref: evidenceRef, evidence_hash: evidenceHash,
      review_ref: reviewRef, review_hash: reviewHash,
      reviewed_commit: reviewedCommits[planned.id], merge_commit: mergeCommits[planned.id],
      attempt_reviews: [attemptReview],
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
    steps: [
      {
        agent: "spec-writer", status: "accepted", attempts: 1, artifact_ref: "artifacts/technical-brief.md", review_ref: "reviews/spec-writer.json",
        acceptance: {
          artifact_ref: "artifacts/technical-brief.md", artifact_hash: hashFile(join(runDir, "artifacts", "technical-brief.md")),
          review_ref: "reviews/spec-writer.json", review_hash: hashFile(join(runDir, "reviews", "spec-writer.json")),
        },
      },
      {
        agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
        acceptance: {
          artifact_ref: "plan/slices.json", artifact_hash: hashFile(join(runDir, "plan", "slices.json")),
          review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(runDir, "reviews", "work-decomposer.json")),
        },
      },
    ],
    validator: {
      verdict: "NO-GO",
      report: "artifacts/validation-report.md",
      report_hash: hashFile(join(runDir, "artifacts", "validation-report.md")),
      review_ref: "reviews/reviewer.json",
      review_hash: hashFile(join(runDir, "reviews", "reviewer.json")),
      reviewed_head_sha: tip,
    },
    security_review: {
      verdict: "BLOCK",
      review_ref: "reviews/security.json",
      review_hash: hashFile(join(runDir, "reviews", "security.json")),
      reviewed_head_sha: tip,
    },
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

function createV2SiblingAuthorityFixture(runId) {
  const fixture = createV2Fixture("issue128-oracle", { accepted: [], mergeOrder: [], fixturePrefix: `${runId}-` });
  const catalog = ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG.find(({ id }) => id === "continuation-carry-forward-accepted-slice-v2");
  const staticRepo = createIssue128ContinuationGit();
  runGit(fixture.repo, ["fetch", staticRepo, "+refs/heads/*:refs/issue128-static/*"]);
  const baseCommit = "8b20ea435c507974bec4acb19f81e17969a8cf23";
  const ownerReviewed = catalog.source.attempt_reviews[0].modified_extensions[0].owner_reviewed_commit;
  const ownerMerge = "84ae9626ea3f547d151a9bc024393e5737805355";
  runGit(fixture.repo, ["update-ref", "refs/heads/issue128-owner", ownerReviewed]);
  runGit(fixture.repo, ["update-ref", "refs/heads/issue128-consumer", catalog.source.reviewed_commit]);
  runGit(fixture.repo, ["update-ref", "refs/heads/issue128-oracle", catalog.source.merge_commit]);
  runGit(fixture.repo, ["update-ref", "refs/heads/main", baseCommit]);
  runGit(fixture.repo, ["checkout", "-q", "issue128-oracle"]);
  runGit(fixture.repo, ["push", "--force", "origin", `${baseCommit}:main`]);
  cleanup(staticRepo);

  const plan = withDeliveryEnvelope({
    slices: [
      { id: "owner", stack: "backend", paths: ["src/owner/**"], depends_on: [], acceptance: ["owner"], test_plan: ["node --test owner"] },
      { id: "consumer", stack: "backend", paths: ["src/consumer/**"], depends_on: ["owner"], acceptance: ["consumer"], test_plan: ["node --test consumer"] },
      { id: "remaining", stack: "backend", paths: ["src/remaining/**"], depends_on: ["consumer"], acceptance: ["remaining"], test_plan: ["node --test remaining"] },
    ],
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
  });
  const planPath = join(fixture.runDir, "plan", "slices.json");
  writeJson(planPath, plan);
  const family = writeFamilyReceipt(fixture.runDir, fixture.runId, plan, "owner", 1, ownerReviewed, "evidence/owner.family.json");
  assert.equal(family.hash, JSON.parse(catalog.external_sources.owner_review.bytes).invariant_family_ledger.dispositions[0].evidence_hash);
  const sidecars = new Map();
  for (const source of Object.values(catalog.external_sources)) {
    if (sidecars.has(source.ref)) continue;
    const path = join(fixture.runDir, source.ref);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source.bytes, "utf8");
    assert.equal(hashFile(path), source.hash);
    sidecars.set(source.ref, { path, bytes: source.bytes, hash: source.hash });
  }
  const extension = catalog.source.attempt_reviews[0].modified_extensions[0];
  const ownerAttempt = {
    attempt: extension.owner_attempt,
    evidence_ref: extension.owner_evidence_ref,
    evidence_hash: extension.owner_evidence_hash,
    review_ref: extension.owner_review_ref,
    review_hash: extension.owner_review_hash,
    reviewed_commit: extension.owner_reviewed_commit,
    diff_base_commit: extension.owner_diff_base_commit,
    ownership_schema_version: 2,
    ratified_paths: [],
    modified_extensions: [],
    verdict: "APPROVE",
    convergence: "converging",
    late_discovery_strike: false,
    remaining_fix_count: 0,
    dispatch_claim_ref: extension.owner_dispatch_claim_ref,
    dispatch_claim_hash: extension.owner_dispatch_claim_hash,
    dispatch_closure_ref: extension.owner_dispatch_closure_ref,
    dispatch_closure_hash: extension.owner_dispatch_closure_hash,
  };
  const fullSlice = (accepted, attempt, branch, mergeCommit) => ({
    id: accepted.id, stack: "backend", depends_on: accepted.id === "consumer" ? ["owner"] : [],
    declared_paths: accepted.declared_paths, effective_paths: accepted.effective_paths, status: "merged", attempts: accepted.attempts,
    branch, worktree: `/tmp/${branch}`, dispatch_required: true,
    dispatch_claim_ref: attempt.dispatch_claim_ref, dispatch_claim_hash: attempt.dispatch_claim_hash,
    dispatch_closure_ref: attempt.dispatch_closure_ref, dispatch_closure_hash: attempt.dispatch_closure_hash,
    evidence_ref: accepted.evidence_ref, evidence_hash: accepted.evidence_hash, review_ref: accepted.review_ref, review_hash: accepted.review_hash,
    reviewed_commit: accepted.reviewed_commit, attempt_reviews: accepted.attempt_reviews, merge_commit: mergeCommit,
  });
  const ownerAccepted = {
    id: "owner", declared_paths: ["src/owner/**"], effective_paths: ["src/owner/**"], attempts: 1,
    attempt_reviews: [ownerAttempt], evidence_ref: ownerAttempt.evidence_ref, evidence_hash: ownerAttempt.evidence_hash,
    review_ref: ownerAttempt.review_ref, review_hash: ownerAttempt.review_hash, reviewed_commit: ownerReviewed, merge_commit: ownerMerge,
  };
  const runPath = join(fixture.runDir, "run.json");
  const run = JSON.parse(readFileSync(runPath, "utf8"));
  run.slices = [
    fullSlice(ownerAccepted, ownerAttempt, "issue128-owner", ownerMerge),
    fullSlice(catalog.source, catalog.source.attempt_reviews[0], "issue128-consumer", catalog.source.merge_commit),
    { id: "remaining", stack: "backend", depends_on: ["consumer"], declared_paths: ["src/remaining/**"], effective_paths: ["src/remaining/**"], status: "pending", attempts: 0 },
  ];
  run.base_commit = baseCommit;
  run.branch = fixture.runId;
  run.worktree = fixture.repo;
  run.validator = null;
  run.security_review = null;
  run.steps.find(({ agent }) => agent === "work-decomposer").acceptance.artifact_hash = hashFile(planPath);
  writeJson(runPath, run);
  fixture.baseCommit = baseCommit;
  fixture.reviewedCommits = { owner: ownerReviewed, consumer: catalog.source.reviewed_commit };
  fixture.mergeCommits = { owner: ownerMerge, consumer: catalog.source.merge_commit };
  fixture.actualMergeOrder = [ownerMerge, catalog.source.merge_commit];
  fixture.issue128Catalog = catalog;
  fixture.issue128Sidecars = sidecars;
  fixture.continuationReviewRef = catalog.source.review_ref;
  assert.deepEqual(issue128CarryForwardProjection(run.slices.find(({ id }) => id === "consumer")), catalog.source, `${runId}: exact accepted source before checked continue`);
  return fixture;
}

function issue128CarryForwardProjection(slice) {
  return {
    id: slice.id,
    declared_paths: slice.declared_paths,
    effective_paths: slice.effective_paths,
    attempts: slice.attempts,
    attempt_reviews: slice.attempt_reviews,
    evidence_ref: slice.evidence_ref,
    evidence_hash: slice.evidence_hash,
    review_ref: slice.review_ref,
    review_hash: slice.review_hash,
    reviewed_commit: slice.reviewed_commit,
    merge_commit: slice.merge_commit,
  };
}

function createIssue128ContinuationGit() {
  const repo = mkdtempSync(join(tmpdir(), "issue128-continuation-git-"));
  mkdirSync(join(repo, "docs"), { recursive: true });
  mkdirSync(join(repo, "src", "owner"), { recursive: true });
  runGit(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  writeFileSync(join(repo, "docs", "consumer.md"), "baseline consumer\n");
  writeFileSync(join(repo, "src", "owner", "shared.js"), "export const shared = 1;\n");
  runGit(repo, ["add", "README.md", "docs/consumer.md", "src/owner/shared.js"]);
  issue128GitCommit(repo, "2026-01-01T00:00:00Z", ["commit", "-q", "-m", "issue 128 baseline"]);
  const base = gitStdout(repo, ["rev-parse", "HEAD"]);
  assert.equal(base, "8b20ea435c507974bec4acb19f81e17969a8cf23");
  runGit(repo, ["branch", "issue128-owner", base]);
  runGit(repo, ["branch", "issue128-sibling", base]);
  runGit(repo, ["checkout", "-q", "issue128-owner"]);
  writeFileSync(join(repo, "src", "owner", "owned.js"), "export const owned = true;\n");
  runGit(repo, ["add", "src/owner/owned.js"]);
  issue128GitCommit(repo, "2026-01-01T00:01:00Z", ["commit", "-q", "-m", "issue 128 owner"]);
  assert.equal(gitStdout(repo, ["rev-parse", "HEAD"]), "ff72597376c2c7c3771198a766a1ba1c049da558");
  runGit(repo, ["checkout", "-q", "main"]);
  issue128GitCommit(repo, "2026-01-01T00:02:00Z", ["merge", "-q", "--no-ff", "-m", "merge issue 128 owner", "issue128-owner"]);
  const ownerMerge = gitStdout(repo, ["rev-parse", "HEAD"]);
  assert.equal(ownerMerge, "84ae9626ea3f547d151a9bc024393e5737805355");
  runGit(repo, ["checkout", "-q", "issue128-sibling"]);
  writeFileSync(join(repo, "src", "owner", "shared.js"), "export const shared = 2;\n");
  runGit(repo, ["add", "src/owner/shared.js"]);
  issue128GitCommit(repo, "2026-01-01T00:07:00Z", ["commit", "-q", "-m", "issue 128 sibling consumer"]);
  assert.equal(gitStdout(repo, ["rev-parse", "HEAD"]), "ddc920e780e08f2a3561d407b880f22a726b7c9d");
  runGit(repo, ["checkout", "-q", "-b", "issue128-sibling-main", ownerMerge]);
  issue128GitCommit(repo, "2026-01-01T00:08:00Z", ["merge", "-q", "--no-ff", "-m", "merge issue 128 sibling consumer", "issue128-sibling"]);
  assert.equal(gitStdout(repo, ["rev-parse", "HEAD"]), "d209b10df237a6893c2aae54e4a36676588feda9");
  return repo;
}

function issue128GitCommit(repo, date, args) {
  const proc = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Issue 128 Oracle", GIT_AUTHOR_EMAIL: "oracle@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: "Issue 128 Oracle", GIT_COMMITTER_EMAIL: "oracle@example.com", GIT_COMMITTER_DATE: date },
  });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function exerciseIssue128ContinuationMutations(fixture, recordId, chunk, chunkCount) {
  const row = ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG.find(({ id }) => id === recordId);
  const cases = emitIssue128FinishAndDiscloseMutations(row);
  const selectedCases = cases.map((mutation, index) => ({ mutation, index })).filter(({ index }) => index % chunkCount === chunk);
  const runPath = join(fixture.runDir, "run.json");
  const originalRun = readFileSync(runPath);
  const originalRunHash = hashFile(runPath);
  const attributionMismatches = [];
  for (const { mutation, index } of selectedCases) {
    restoreIssue128ContinuationBaseline(fixture, runPath, originalRun, originalRunHash, mutation);
    if (mutation.code === "B") {
      const source = row.external_sources[mutation.path[1]];
      const sidecar = fixture.issue128Sidecars.get(source.ref);
      writeFileSync(sidecar.path, `${sidecar.bytes} `);
    } else {
      updateRun(fixture, (run) => {
        const source = run.slices.find(({ id }) => id === (mutation.path[0] === "owner_source" ? "owner" : "consumer"));
        applyIssue128PhysicalMutation(source, mutation);
      });
    }
    const childRunId = `${fixture.runId}-oracle-${index}-next`;
    let rejection = null;
    try {
      continueFactory(fixture.runId, { cwd: fixture.repo, review: fixture.continuationReviewRef, runId: childRunId, carryForward: true, dryRun: true });
    } catch (error) {
      rejection = error;
    }
    const expectedCheck = recordId.startsWith("checkpoint-") ? "continueFactory checkpoint carry-forward authority" : "continueFactory ordinary carry-forward authority";
    assert.equal(mutation.expected_check, expectedCheck, `${mutation.name}: concrete checked continuation consumer`);
    assert.ok(rejection, `${mutation.name}: ${expectedCheck} must reject`);
    if (!new RegExp(mutation.expected_rejection, "iu").test(rejection.message)) {
      attributionMismatches.push(`${mutation.name}: /${mutation.expected_rejection}/ did not match ${JSON.stringify(rejection.message)}`);
    }
    assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", childRunId)), false, mutation.name);
    assert.equal(refOid(fixture.repo, `refs/heads/${childRunId}`), null, mutation.name);
  }
  restoreIssue128ContinuationBaseline(fixture, runPath, originalRun, originalRunHash, selectedCases.at(-1).mutation);
  assert.deepEqual(attributionMismatches, [], `${recordId}: every mutation must reach its target-specific ${cases[0].expected_check} rejection`);
  const mutationNames = selectedCases.map(({ mutation }) => mutation.name);
  return { executed: mutationNames.length, mutationNames, mutationDigest: issue128MutationNameDigest(mutationNames) };
}

function restoreIssue128ContinuationBaseline(fixture, runPath, originalRun, originalRunHash, mutation) {
  writeFileSync(runPath, originalRun);
  assert.deepEqual(readFileSync(runPath), originalRun, `${mutation.name}: exact restored parent run bytes`);
  assert.equal(hashFile(runPath), originalRunHash, `${mutation.name}: exact restored parent run hash`);
  for (const sidecar of fixture.issue128Sidecars.values()) {
    writeFileSync(sidecar.path, sidecar.bytes);
    assert.deepEqual(readFileSync(sidecar.path), Buffer.from(sidecar.bytes), `${mutation.name}: exact restored parent sidecar bytes`);
    assert.equal(hashFile(sidecar.path), sidecar.hash, `${mutation.name}: exact restored parent sidecar hash`);
  }
  if (mutation.code === "B") {
    const source = fixture.issue128Catalog.external_sources[mutation.path[1]];
    assert.equal(source.bytes, mutation.expected, `${mutation.name}: exact sidecar target before physical mutation`);
  }
}

function applyIssue128PhysicalMutation(source, mutation) {
  const path = mutation.path.slice(1);
  let owner = source;
  if (mutation.operation === "unknown-key") {
    for (const segment of path) owner = owner[segment];
    const observedBoundary = mutation.path.length === 1 && mutation.path[0] === "source" ? issue128CarryForwardProjection(owner) : owner;
    assert.deepEqual(observedBoundary, mutation.expected, `${mutation.name}: exact continuation object boundary before unsupported-key insertion`);
    assert.equal(Object.hasOwn(owner, mutation.key), false, `${mutation.name}: unsupported continuation key must be new`);
    owner[mutation.key] = mutation.value;
    assert.equal(owner[mutation.key], mutation.value, `${mutation.name}: unsupported continuation key must be physically inserted`);
    return;
  }
  for (const segment of path.slice(0, -1)) owner = owner[segment];
  const key = path.at(-1);
  assert.deepEqual(owner[key], mutation.expected, `${mutation.name}: exact continuation field before physical mutation`);
  if (mutation.code === "K") delete owner[key];
  else if (mutation.code === "V") owner[key] = typeof owner[key] === "string" ? "invalid" : "invalid-type";
  else if (mutation.code === "R") owner[key] = owner[key].startsWith("evidence/") ? "evidence/missing.json" : owner[key].startsWith("dispatch/") ? "dispatch/missing.json" : "reviews/missing.json";
  else if (mutation.code === "H") owner[key] = `sha256:${"0".repeat(64)}`;
  else if (mutation.code === "D") owner[key] = Array.isArray(owner[key]) ? [...owner[key], "synthetic/path"] : `drift-${owner[key]}`;
  else if (mutation.code === "I") owner[key] = Number.isInteger(owner[key]) ? owner[key] + 1 : owner[key]?.length === 40 ? "0".repeat(40) : "cross-bound-owner";
  else if (mutation.code === "X") owner[key] = "1".repeat(40);
  else throw new Error(`unsupported issue #128 physical mutation ${mutation.code}`);
}

function issue128BaselineIdsForRoute(route) {
  return Object.entries(ISSUE128_BASELINE_ROUTE_INVENTORY)
    .filter(([, assignment]) => assignment.route === route)
    .map(([id]) => id);
}

function bindCheckpointContinuationFixture(fixture, reviewTier) {
  const routingRunId = `${fixture.runId}-routing-parent`;
  const manifestHash = `sha256:${"a".repeat(64)}`;
  const manifestRef = `artifacts/checkpoint-routing-${manifestHash.slice("sha256:".length)}.json`;
  const decompositionReviewPath = join(fixture.runDir, "reviews", "work-decomposer.json");
  const decompositionReview = JSON.parse(readFileSync(decompositionReviewPath, "utf8"));
  decompositionReview.attempt = 1;
  writeJson(decompositionReviewPath, decompositionReview);
  const source = {
    schema_version: 1,
    kind: "delivery-checkpoint-source",
    parent_run_id: routingRunId,
    manifest_ref: manifestRef,
    manifest_hash: manifestHash,
    checkpoint_id: "checkpoint-001",
    checkpoint_ordinal: 1,
    root_child_run_id: fixture.runId,
    source_plan_ref: "plan/slices.json",
    source_plan_hash: `sha256:${"b".repeat(64)}`,
    source_review_ref: "reviews/work-decomposer.json",
    source_review_hash: `sha256:${"b".repeat(64)}`,
    source_review_attempt: 1,
    parent_review_identity_hash: `sha256:${"b".repeat(64)}`,
    child_disposition_hash: hashFile(join(fixture.runDir, "reviews", "work-decomposer.json")),
    admission_probe_hash: `sha256:${"b".repeat(64)}`,
    brief_scope_hash: `sha256:${"b".repeat(64)}`,
    child_plan_hash: hashFile(join(fixture.runDir, "plan", "slices.json")),
    acceptance_mapping_hash: `sha256:${"b".repeat(64)}`,
    initial_base_ref: "refs/remotes/origin/main",
    initial_base_commit: fixture.baseCommit,
  };
  const run = JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8"));
  run.steps.find((step) => step.agent === "work-decomposer").acceptance.review_hash = hashFile(decompositionReviewPath);
  run.mode = "interactive";
  run.github_account = null;
  run.pr_mode = "ready";
  run.max_parallel_slices = 3;
  run.max_retries = 3;
  run.post_pr = continuationEligibilityPostPr("disabled", 0);
  const configuration = {
    mode: run.mode,
    github_account: run.github_account ?? null,
    pr_mode: run.pr_mode,
    max_parallel_slices: run.max_parallel_slices,
    max_retries: run.max_retries,
    post_pr_policy: structuredClone(run.post_pr.policy),
    review_tier: reviewTier,
  };
  run.checkpoint_source = structuredClone(source);
  if (reviewTier === null) delete run.review_tier;
  else run.review_tier = reviewTier;
  writeJson(join(fixture.runDir, "run.json"), run);

  const routingRunDir = join(fixture.repo, ".opencode", "factory", routingRunId);
  mkdirSync(routingRunDir, { recursive: true });
  writeJson(join(routingRunDir, "run.json"), {
    schema_version: 1,
    run_id: routingRunId,
    status: "blocked",
    gates: {},
    checkpoint_progress: {
      schema_version: 1,
      kind: "delivery-checkpoint-progress",
      manifest_ref: manifestRef,
      manifest_hash: manifestHash,
      status: "active",
      entries: [{
        state: "launched",
        checkpoint_id: source.checkpoint_id,
        ordinal: source.checkpoint_ordinal,
        root_child_run_id: source.root_child_run_id,
        branch: source.root_child_run_id,
        worktree: run.worktree,
        base_ref: "refs/remotes/origin/main",
        base_commit: fixture.baseCommit,
        predecessor_checkpoint_id: null,
        predecessor_completed_run_id: null,
        predecessor_merge_commit: null,
        configuration: structuredClone(configuration),
        publication_claim_ref: `refs/opencode/checkpoint-publications/${createHash("sha256").update(source.root_child_run_id).digest("hex")}`,
        publication_claim_oid: "a".repeat(40),
        reserved_at: "2026-07-19T12:00:00.000Z",
        child_run_hash: `sha256:${"b".repeat(64)}`,
        child_plan_hash: source.child_plan_hash,
        brief_scope_hash: source.brief_scope_hash,
        published_at: "2026-07-19T12:01:00.000Z",
        launched_at: "2026-07-19T12:02:00.000Z",
      }],
      final_closure: null,
    },
    terminal_result: {
      status: "blocked",
      run_id: routingRunId,
      pr_url: null,
      reason: "oversized-plan-checkpoint-routing-required",
      summary: "Routed to checkpoints.",
      artifacts: { checkpoint_routing: manifestRef },
    },
  });
  return { source, configuration };
}

async function createConflictCarryForwardFixture(runId) {
  const fixture = createV2Fixture(runId, { accepted: [], mergeOrder: [] });
  const sliceId = "A";
  const branch = `${runId}--${sliceId}`;
  const sliceWorktree = join(fixture.repo, ".opencode", "worktrees", `${runId}-${sliceId}`);
  runGit(fixture.repo, ["branch", branch, fixture.baseCommit]);
  mkdirSync(dirname(sliceWorktree), { recursive: true });
  runGit(fixture.repo, ["worktree", "add", sliceWorktree, branch]);
  writeFileSync(join(sliceWorktree, "A.txt"), "reviewed A bytes\n");
  runGit(sliceWorktree, ["add", "A.txt"]);
  runGit(sliceWorktree, ["commit", "-m", "reviewed conflict A"]);
  const reviewedCommit = gitStdout(sliceWorktree, ["rev-parse", "HEAD"]);

  writeFileSync(join(fixture.repo, "A.txt"), "competing integration A bytes\n");
  runGit(fixture.repo, ["add", "A.txt"]);
  runGit(fixture.repo, ["commit", "-m", "integration baseline for A"]);
  const integrationBaseline = gitStdout(fixture.repo, ["rev-parse", "HEAD"]);
  runGit(fixture.repo, ["branch", "-f", "main", integrationBaseline]);
  runGit(fixture.repo, ["push", "--force", "origin", `${integrationBaseline}:main`]);

  const evidenceRef = "evidence/A.json";
  const familyEvidenceRef = "evidence/A.family.json";
  const reviewRef = "reviews/A.json";
  writeJson(join(fixture.runDir, evidenceRef), { subject: sliceId, attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommit });
  const evidenceHash = hashFile(join(fixture.runDir, evidenceRef));
  const plan = JSON.parse(readFileSync(join(fixture.runDir, "plan", "slices.json"), "utf8"));
  const familyEvidence = writeFamilyReceipt(fixture.runDir, runId, plan, sliceId, 1, reviewedCommit, familyEvidenceRef);
  writeJson(join(fixture.runDir, reviewRef), {
    subject: sliceId, attempt: 1, verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0, required_fixes: [],
    ownership_ratification: { schema_version: 1, paths: [] }, remediation_context: { schema_version: 2, fixes: [] }, reviewed_commit: reviewedCommit,
    invariant_family_ledger: passingInvariantFamilyLedger({ plan, sliceId, reviewedCommit, evidenceRef: familyEvidenceRef, evidenceHash: familyEvidence.hash }),
  });
  const reviewHash = hashFile(join(fixture.runDir, reviewRef));
  const claimStem = createHash("sha256").update(`${runId}\0${sliceId}\0${1}`, "utf8").digest("hex");
  const claimRef = `dispatch/${claimStem}.json`;
  const closureRef = `dispatch/${claimStem}.closed.json`;
  const completionToken = "carry-forward-conflict-slice";
  mkdirSync(join(fixture.runDir, "dispatch"), { recursive: true });
  writeJson(join(fixture.runDir, claimRef), {
    schema_version: 1, kind: "checked-slice-builder-dispatch-claim", run_id: runId, slice_id: sliceId, attempt: 1,
    agent: "backend-builder", branch, worktree: sliceWorktree, head: fixture.baseCommit,
    context_hash: `sha256:${"a".repeat(64)}`, completion_token_hash: `sha256:${createHash("sha256").update(completionToken).digest("hex")}`,
    claimed_at: "2026-07-18T12:00:00.000Z", closure_ref: closureRef,
  });
  const claimHash = hashFile(join(fixture.runDir, claimRef));
  writeJson(join(fixture.runDir, closureRef), {
    schema_version: 1, kind: "checked-slice-builder-dispatch-closure", claim_ref: claimRef, claim_hash: claimHash,
    run_id: runId, slice_id: sliceId, attempt: 1, agent: "backend-builder", branch, worktree: sliceWorktree,
    head: fixture.baseCommit, completion_head: reviewedCommit, context_hash: `sha256:${"a".repeat(64)}`,
    completion_token: completionToken, returned_at: "2026-07-18T12:00:00.000Z",
  });
  const closureHash = hashFile(join(fixture.runDir, closureRef));
  updateRun(fixture, (run) => {
    run.status = "running";
    run.base_commit = integrationBaseline;
    run.terminal_result = null;
    run.validator = null;
    run.security_review = null;
    run.slices[0] = {
      id: sliceId, stack: "backend", depends_on: [], declared_paths: ["A.txt"], effective_paths: ["A.txt"], status: "review", attempts: 1,
      branch, worktree: sliceWorktree, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash,
      reviewed_commit: reviewedCommit, dispatch_required: true, dispatch_claim_ref: claimRef, dispatch_claim_hash: claimHash,
      dispatch_closure_ref: closureRef, dispatch_closure_hash: closureHash,
      attempt_reviews: [{
        attempt: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash,
        reviewed_commit: reviewedCommit, diff_base_commit: fixture.baseCommit, ratified_paths: [], verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0,
        dispatch_claim_ref: claimRef, dispatch_claim_hash: claimHash, dispatch_closure_ref: closureRef, dispatch_closure_hash: closureHash,
      }],
    };
  });

  const merge = spawnSync("git", ["merge", "--no-ff", branch, "-m", "merge conflict A"], { cwd: fixture.repo, encoding: "utf8" });
  assert.notEqual(merge.status, 0, "carry-forward fixture merge must conflict");
  const specialToken = "carry-forward-special-conflict";
  const context = await prepareSpecialBuilderTaskDispatch(fixture.repo, { run_id: runId, route: "integration-conflict", agent: "backend-builder" }, { claimDispatch: true, completionToken: specialToken });
  writeFileSync(join(fixture.repo, "A.txt"), "delegated integrated A bytes\n");
  runGit(fixture.repo, ["add", "A.txt"]);
  runGit(fixture.repo, ["commit", "-m", "delegated conflict A"]);
  const resolutionCommit = gitStdout(fixture.repo, ["rev-parse", "HEAD"]);
  await completeSpecialBuilderTaskDispatch(fixture.repo, {
    run_id: runId, route: "integration-conflict", agent: "backend-builder", claim_ref: context.dispatch_claim.ref,
    claim_hash: context.dispatch_claim.hash, completion_token: specialToken,
  });
  const merged = await transitionSliceMerged(fixture.runDir, sliceId, { merge_commit: resolutionCommit });
  const conflict = merged.slice.integration_conflict || merged.run.integration_conflict;
  updateRun(fixture, (run) => {
    run.status = "blocked";
    run.validator = null;
    run.security_review = null;
    run.terminal_result = { status: "blocked", run_id: runId, reason: "review blocked", summary: "blocked", artifacts: {} };
  });
  return { ...fixture, baseCommit: integrationBaseline, resolutionCommit, conflict, continuationReviewRef: reviewRef };
}

function acceptedManifestRow(fixture, id) {
  const run = JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8"));
  const slice = run.slices.find((candidate) => candidate.id === id);
  return {
    id, declared_paths: structuredClone(slice.declared_paths), effective_paths: structuredClone(slice.effective_paths), attempts: slice.attempts,
    evidence_ref: slice.evidence_ref, evidence_hash: slice.evidence_hash,
    review_ref: slice.review_ref, review_hash: slice.review_hash,
    reviewed_commit: slice.reviewed_commit, merge_commit: slice.merge_commit, attempt_reviews: structuredClone(slice.attempt_reviews),
  };
}

function configureMultiAttemptAcceptedSlice(fixture, id) {
  const runPath = join(fixture.runDir, "run.json");
  const run = JSON.parse(readFileSync(runPath, "utf8"));
  const slice = run.slices.find((candidate) => candidate.id === id);
  const reviewedCommit = slice.reviewed_commit;
  const attemptOne = {
    evidenceRef: `evidence/${id}.attempt-1.json`,
    familyEvidenceRef: `evidence/${id}.family-attempt-1.json`,
    reviewRef: `reviews/${id}.attempt-1.json`,
  };
  const attemptTwo = {
    evidenceRef: `evidence/${id}.attempt-2.json`,
    familyEvidenceRef: `evidence/${id}.family-attempt-2.json`,
    reviewRef: `reviews/${id}.attempt-2.json`,
  };
  writeJson(join(fixture.runDir, attemptOne.evidenceRef), { subject: id, attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommit });
  const plan = JSON.parse(readFileSync(join(fixture.runDir, "plan", "slices.json"), "utf8"));
  const attemptOneFamily = writeFamilyReceipt(fixture.runDir, fixture.runId, plan, id, 1, reviewedCommit, attemptOne.familyEvidenceRef);
  writeJson(join(fixture.runDir, attemptOne.reviewRef), {
    subject: id, attempt: 1, verdict: "REJECT", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 1,
    required_fixes: ["complete the first correction"],
    ownership_ratification: { schema_version: 1, paths: [] },
    remediation_context: { schema_version: 2, fixes: [{ required_fix_index: 0, classification: "narrow-correction", scope_effect: "in-lane", likely_paths: [`${id}.txt`], fix_owner: id }] },
    reviewed_commit: reviewedCommit,
    invariant_family_ledger: passingInvariantFamilyLedger({ plan, sliceId: id, reviewedCommit, evidenceRef: attemptOne.familyEvidenceRef, evidenceHash: attemptOneFamily.hash }),
  });
  writeJson(join(fixture.runDir, attemptTwo.evidenceRef), { subject: id, attempt: 2, status: "pass", review_ready: true, head_sha: reviewedCommit });
  const attemptTwoEvidenceHash = hashFile(join(fixture.runDir, attemptTwo.evidenceRef));
  const attemptTwoFamily = writeFamilyReceipt(fixture.runDir, fixture.runId, plan, id, 2, reviewedCommit, attemptTwo.familyEvidenceRef);
  writeJson(join(fixture.runDir, attemptTwo.reviewRef), {
    subject: id, attempt: 2, verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0,
    required_fixes: [], ownership_ratification: { schema_version: 1, paths: [] }, remediation_context: { schema_version: 2, fixes: [] }, reviewed_commit: reviewedCommit,
    invariant_family_ledger: passingInvariantFamilyLedger({ plan, sliceId: id, reviewedCommit, evidenceRef: attemptTwo.familyEvidenceRef, evidenceHash: attemptTwoFamily.hash }),
  });
  const history = [
    {
      attempt: 1, evidence_ref: attemptOne.evidenceRef, evidence_hash: hashFile(join(fixture.runDir, attemptOne.evidenceRef)),
      review_ref: attemptOne.reviewRef, review_hash: hashFile(join(fixture.runDir, attemptOne.reviewRef)), reviewed_commit: reviewedCommit,
      diff_base_commit: reviewedCommit, ratified_paths: [], verdict: "REJECT", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 1,
    },
    {
      attempt: 2, evidence_ref: attemptTwo.evidenceRef, evidence_hash: attemptTwoEvidenceHash,
      review_ref: attemptTwo.reviewRef, review_hash: hashFile(join(fixture.runDir, attemptTwo.reviewRef)), reviewed_commit: reviewedCommit,
      diff_base_commit: reviewedCommit, ratified_paths: [], verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0,
    },
  ];
  Object.assign(slice, {
    attempts: 2,
    attempt_reviews: history,
    evidence_ref: history[1].evidence_ref,
    evidence_hash: history[1].evidence_hash,
    review_ref: history[1].review_ref,
    review_hash: history[1].review_hash,
    reviewed_commit: reviewedCommit,
  });
  rmSync(join(fixture.runDir, `evidence/${id}.json`));
  rmSync(join(fixture.runDir, `reviews/${id}.json`));
  writeJson(runPath, run);
  return history;
}

function writeMergedSliceFixture(runDir, id, reviewedCommit) {
  const evidenceRef = `evidence/${id}.fixture.json`;
  const familyEvidenceRef = `evidence/${id}.family-fixture.json`;
  const reviewRef = `reviews/${id}.fixture.json`;
  writeJson(join(runDir, evidenceRef), { subject: id, attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommit });
  const evidenceHash = hashFile(join(runDir, evidenceRef));
  const plan = JSON.parse(readFileSync(join(runDir, "plan", "slices.json"), "utf8"));
  const runId = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).run_id;
  const familyEvidence = writeFamilyReceipt(runDir, runId, plan, id, 1, reviewedCommit, familyEvidenceRef);
  writeJson(join(runDir, reviewRef), {
    subject: id, attempt: 1, verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0,
    required_fixes: [], ownership_ratification: { schema_version: 1, paths: [] }, remediation_context: { schema_version: 2, fixes: [] }, reviewed_commit: reviewedCommit,
    invariant_family_ledger: passingInvariantFamilyLedger({ plan, sliceId: id, reviewedCommit, evidenceRef: familyEvidenceRef, evidenceHash: familyEvidence.hash }),
  });
  const reviewHash = hashFile(join(runDir, reviewRef));
  return {
    status: "merged", attempts: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash,
    reviewed_commit: reviewedCommit, merge_commit: reviewedCommit,
    attempt_reviews: [{ attempt: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash, reviewed_commit: reviewedCommit, diff_base_commit: reviewedCommit, ratified_paths: [], verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0 }],
  };
}

function writeFamilyReceipt(runDir, runId, plan, sliceId, attempt, reviewedCommit, evidenceRef) {
  const unit = plan.delivery_envelope.delivery_units.find((candidate) => candidate.slice_id === sliceId);
  const family = unit.invariant_families[0];
  const artifactId = unit.obligations.find((obligation) => obligation.invariant_family_id === family.id).verification_artifact_id;
  return writeVerificationArtifactReceipt({
    runDir, runId, plan, sliceId, attempt, reviewedCommit, artifactId, evidenceRef,
    result: { type: "verification-result", outcome: "pass", summary: `${family.description} passed` },
  });
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

after(() => {
  if (gitRepoTemplate) rmSync(gitRepoTemplate, { recursive: true, force: true });
  for (const dir of v2TemplateDirs) rmSync(dir, { recursive: true, force: true });
});

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
      ...(Object.hasOwn(candidate, "checkpoint_source_hash") ? { checkpoint_source_hash: candidate.checkpoint_source_hash, configuration_hash: candidate.configuration_hash } : {}),
    },
  };
}

function continuationReservationRef(runId) {
  return `refs/opencode/continuation-targets/${createHash("sha256").update(runId).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalHash(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
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
