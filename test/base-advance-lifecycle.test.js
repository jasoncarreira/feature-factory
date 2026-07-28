import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { advanceFactoryRunBase, resumeFactory } from "../src/factory.js";
import { classifyWholeStoryTestRoute, completeSpecialBuilderTaskDispatch, claimCheckedTestExecution, prepareSpecialBuilderTaskDispatch, transitionGateDecision, transitionPanelVerdicts, transitionPrePrFenceEstablished, transitionRunBaseAdvance, transitionSliceMerged, transitionSteeringBoundaryOpened } from "../src/run-state.js";
import { computePrOperationId } from "../src/github.js";
import { captureRepresentativeAuthorityInventory, createBaseAdvanceTransitionFixture, git, installRepresentativeAuthorityInventory, output } from "./helpers/base-advance-transition/fixture.js";
import { approvePreservedCandidate, completeFinalCheckedTest, completeIntegratedConflictCheckedTest, configureReadyPostPrReview, installApprovedLifecycleSlice, LIFECYCLE_REVIEWER, publishIndependentPanels, publishPrePrApproval, recordOpenReadyPr, requestConfiguredReviewer } from "./helpers/base-advance-lifecycle/fixture.js";
import { spawnSync } from "./helpers/git-fixture.js";

describe("active-run base advancement lifecycle compatibility", () => {
  it("preserves an overlapping rejected candidate and leaves review, ownership, checks, and merge proof mandatory", async () => {
    const fixture = createBaseAdvanceTransitionFixture("preserved-overlap");
    try {
      const inventory = installRepresentativeAuthorityInventory(fixture);
      writeFileSync(join(fixture.publisher, "candidate.txt"), "upstream overlapping candidate bytes\n");
      git(fixture.publisher, ["add", "candidate.txt"]);
      git(fixture.publisher, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "advance overlapping candidate path"]);
      git(fixture.publisher, ["push", "origin", "main"]);
      const target = output(fixture.publisher, ["rev-parse", "HEAD"]);
      const before = captureRepresentativeAuthorityInventory(fixture, inventory);

      const advanced = await advanceFactoryRunBase(fixture.runId, { cwd: fixture.repo });
      const run = fixture.readRun();

      assert.equal(advanced.base_commit, target);
      assert.deepEqual(captureRepresentativeAuthorityInventory(fixture, inventory), before);
      assert.deepEqual(run.slices.map((slice) => ({ id: slice.id, status: slice.status, paths: slice.effective_paths, verdict: slice.attempt_reviews.at(-1).verdict })), [
        { id: "candidate", status: "review", paths: ["candidate.txt", "staged.txt", "untracked.txt"], verdict: "REJECT" },
      ]);
      await assert.rejects(transitionSliceMerged(fixture.runDir, "candidate", { merge_commit: target }), /requires APPROVE review/u);
      await assert.rejects(claimCheckedTestExecution(fixture.runDir), /exactly one test-verifier step/u);
      await assert.rejects(
        transitionPanelVerdicts(fixture.runDir, { validator: { verdict: "GO", report: "artifacts/story.md", review_ref: "reviews/spec-writer.json" }, security_review: { verdict: "PASS", review_ref: "reviews/work-decomposer.json" } }),
        /reviewed_head_sha|test execution|receipt|panel|validator review_ref/u,
      );
      assert.equal(fixture.readRun().slices[0].status, "review");

      const approved = approvePreservedCandidate(fixture, inventory);
      assert.equal(approved.reviewedCommit, inventory.candidateHead);
      const merge = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "merge", "--no-ff", inventory.candidate, "-m", "merge preserved candidate"], {
        cwd: fixture.worktree,
        encoding: "utf8",
      });
      assert.notEqual(merge.status, 0, "overlapping candidate must enter the delegated textual-conflict route");
      const completionToken = "preserved-overlap-conflict";
      const context = await prepareSpecialBuilderTaskDispatch(fixture.repo, {
        run_id: fixture.runId,
        route: "integration-conflict",
        agent: "backend-builder",
      }, { claimDispatch: true, completionToken });
      assert.deepEqual(context.authority.conflict.conflict_paths, ["candidate.txt"]);
      assert.deepEqual(context.authority.conflict.current_slice, {
        id: "candidate",
        stack: "backend",
        reviewed_commit: inventory.candidateHead,
        effective_paths: ["candidate.txt", "staged.txt", "untracked.txt"],
      });
      assert.deepEqual(context.authority.conflict.effective_owner, { slice_id: "candidate", stack: "backend", kind: "sole-owner" });

      writeFileSync(join(fixture.worktree, "candidate.txt"), "delegated integrated candidate bytes\n");
      git(fixture.worktree, ["add", "candidate.txt"]);
      git(fixture.worktree, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "resolve preserved candidate conflict"]);
      const resolutionHead = output(fixture.worktree, ["rev-parse", "HEAD"]);
      const closed = await completeSpecialBuilderTaskDispatch(fixture.repo, {
        run_id: fixture.runId,
        route: "integration-conflict",
        agent: "backend-builder",
        claim_ref: context.dispatch_claim.ref,
        claim_hash: context.dispatch_claim.hash,
        completion_token: completionToken,
      });
      assert.equal(closed.completion_head, resolutionHead);
      assert.equal(closed.integration_proof.resolution_commit, resolutionHead);
      assert.deepEqual(closed.integration_proof.conflict_paths, ["candidate.txt"]);
      assert.equal(closed.integration_proof.integrated_entries[0].path, "candidate.txt");

      git(inventory.candidateWorktree, ["reset", "--hard", inventory.candidateHead]);
      git(inventory.candidateWorktree, ["clean", "-fd"]);
      const integrated = await transitionSliceMerged(fixture.runDir, "candidate", { merge_commit: resolutionHead }, { repoRoot: fixture.repo });
      assert.equal(integrated.slice.status, "merged");
      assert.equal(integrated.slice.integration_conflict.status, "pending-integrated-review");
      assert.equal(integrated.slice.integration_conflict.claim_ref, context.dispatch_claim.ref);
      assert.equal(integrated.slice.integration_conflict.closure_ref, closed.closure_ref);
      assert.deepEqual(integrated.slice.integration_conflict.integration_proof, closed.integration_proof);
      await assert.rejects(
        transitionPanelVerdicts(fixture.runDir, { validator: { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" }, security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" } }),
        /require fresh integrated conflict tests and review/u,
      );

      const checked = await completeIntegratedConflictCheckedTest(fixture, resolutionHead);
      assert.equal(checked.completed.status, "pass");
      assert.equal(checked.receipt.head_sha, resolutionHead);
      assert.equal(checked.accepted.run.slices[0].integration_conflict.status, "accepted");
      assert.equal(checked.accepted.run.slices[0].integration_conflict.test_acceptance.reviewed_head_sha, resolutionHead);
      assert.equal(checked.accepted.run.slices[0].integration_conflict.owner_slice_id, "candidate");
    } finally {
      fixture.cleanup();
    }
  });

  it("resumes, integrates, checks, panels, fences, records an open ready PR, and requests the exact reviewer at the advanced base", async () => {
    const fixture = createBaseAdvanceTransitionFixture("complete-lifecycle");
    try {
      const postPr = configureReadyPostPrReview(fixture);
      const target = fixture.advance();
      const advanced = await advanceFactoryRunBase(fixture.runId, { cwd: fixture.repo });
      let launches = 0;
      const resumed = await resumeFactory(fixture.runId, {
        cwd: fixture.repo,
        foregroundLaunchFn: async () => {
          launches += 1;
          return { status: "launched", launched: true };
        },
      });
      assert.equal(advanced.base_commit, target);
      assert.deepEqual(resumed, { status: "launched", launched: true });
      assert.equal(launches, 1);
      assert.deepEqual(fixture.readRun().post_pr, postPr);

      const candidate = installApprovedLifecycleSlice(fixture);
      await assert.rejects(
        publishIndependentPanels(fixture, candidate.integrationHead),
        /complete merged slice projection/u,
      );
      const merged = await transitionSliceMerged(fixture.runDir, candidate.sliceId, { merge_commit: candidate.integrationHead }, { repoRoot: fixture.repo });
      assert.equal(merged.slice.status, "merged");
      assert.equal(merged.slice.merge_commit, candidate.integrationHead);
      assert.equal(classifyWholeStoryTestRoute(fixture.runDir, merged.run), "ordinary-fresh");
      await assert.rejects(transitionPrePrFenceEstablished(fixture.runDir, { repoRoot: fixture.repo }), /pre_pr gate|test-verifier|panel|validator|security/u);

      const checked = await completeFinalCheckedTest(fixture, candidate.integrationHead);
      assert.equal(checked.completed.status, "pass");
      assert.equal(checked.claimed.authority.head_sha, candidate.integrationHead);
      assert.deepEqual(checked.receipt.commands.map(({ program, args }) => [program, args]), [["npm", ["run", "check"]]]);
      assert.equal(checked.accepted.run.steps.find((step) => step.agent === "test-verifier").status, "accepted");
      await assert.rejects(transitionPrePrFenceEstablished(fixture.runDir, { repoRoot: fixture.repo }), /pre_pr gate|panel|validator|security/u);

      const panels = await publishIndependentPanels(fixture, candidate.integrationHead);
      assert.deepEqual(
        { validator: panels.run.validator.verdict, validator_head: panels.run.validator.reviewed_head_sha, security: panels.run.security_review.verdict, security_head: panels.run.security_review.reviewed_head_sha },
        { validator: "GO", validator_head: candidate.integrationHead, security: "PASS", security_head: candidate.integrationHead },
      );
      await assert.rejects(
        transitionPrePrFenceEstablished(fixture.runDir, { repoRoot: fixture.repo }),
        /pr-created requires approved pre_pr gate/u,
      );
      await publishPrePrApproval(fixture);
      const driftedMain = fixture.advance("post-review canonical main drift\n");
      const pr = await recordOpenReadyPr(fixture, driftedMain, candidate.integrationHead);
      assert.equal(pr.recorded.disposition, "open");
      assert.equal(pr.recorded.status, "running");
      assert.equal(pr.recorded.pr_url, pr.pullRequest.pr_url);
      assert.equal(pr.fence.base_sha, driftedMain);
      assert.equal(pr.fence.head_sha, candidate.integrationHead);
      assert.equal(pr.fence.draft, false);
      assert.equal(pr.fence.operation_id, computePrOperationId({
        base_commit: target,
        branch: fixture.runId,
        created_at: pr.fence.created_at,
        repository: pr.fence.repository,
        run_id: fixture.runId,
      }));
      assert.equal(pr.operationMarker, `<!-- opencode-feature-factory:pr-operation=${pr.fence.operation_id} -->`);
      assert.equal(pr.observedPull.body, `${pr.operationMarker}\n`);
      assert.deepEqual(pr.observationCalls, [
        ["api", "--method", "GET", "--include", `repos/${pr.fence.repository}/pulls?state=all&head=example%3A${fixture.runId}&base=main&per_page=100`, "--header", "Accept:application/vnd.github+json"],
        ["api", "--method", "GET", "--include", `repos/${pr.fence.repository}/pulls?state=all&head=example%3A${fixture.runId}&base=main&per_page=100`, "--header", "Accept:application/vnd.github+json"],
      ]);

      const reviewer = await requestConfiguredReviewer(fixture);
      assert.equal(reviewer.result.action, "reviewer-requested");
      assert.deepEqual(reviewer.calls, [
        ["pr", "edit", "100", "--repo", pr.fence.repository, "--add-reviewer", LIFECYCLE_REVIEWER],
      ]);
      const finalRun = fixture.readRun();
      assert.equal(finalRun.base_commit, target);
      assert.equal(finalRun.post_pr.pr_operation.base_sha, driftedMain);
      assert.equal(finalRun.pr_mode, "ready");
      assert.equal(finalRun.pr_url, pr.pullRequest.pr_url);
      assert.equal(finalRun.post_pr.policy.review.reviewer_login, LIFECYCLE_REVIEWER);
      assert.equal(finalRun.post_pr.observation.review_request.status, "requested");
      assert.deepEqual(finalRun.post_pr.pr_operation, pr.pullRequest);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a canonical origin that moves after Git advancement without publishing the moved base", async () => {
    const fixture = createBaseAdvanceTransitionFixture("lifecycle-origin-moved");
    try {
      const firstTarget = fixture.advance("first target\n");
      const before = readFileSync(join(fixture.runDir, "run.json"));
      await assert.rejects(
        transitionRunBaseAdvance(fixture.runDir, {
          repoRoot: fixture.repo,
          baseAdvanceHooks: { beforeBind: () => fixture.advance("moved target\n") },
        }),
        (error) => error.code === "BASE_ADVANCE_TARGET_MOVED",
      );
      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), before);
      assert.equal(output(fixture.worktree, ["rev-parse", "HEAD"]), firstTarget);
      assert.equal(fixture.readRun().base_commit, fixture.base);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when current canonical main no longer descends from the immutable recorded base", async () => {
    const fixture = createBaseAdvanceTransitionFixture("lifecycle-non-ancestor-main");
    try {
      fixture.advance();
      await advanceFactoryRunBase(fixture.runId, { cwd: fixture.repo });
      const candidate = installApprovedLifecycleSlice(fixture);
      await transitionSliceMerged(fixture.runDir, candidate.sliceId, { merge_commit: candidate.integrationHead }, { repoRoot: fixture.repo });
      await completeFinalCheckedTest(fixture, candidate.integrationHead);
      await publishIndependentPanels(fixture, candidate.integrationHead);
      await publishPrePrApproval(fixture);

      git(fixture.publisher, ["checkout", "--orphan", "divergent-main"]);
      git(fixture.publisher, ["rm", "-rf", "."]);
      writeFileSync(join(fixture.publisher, "divergent.txt"), "unrelated canonical history\n");
      git(fixture.publisher, ["add", "divergent.txt"]);
      git(fixture.publisher, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "replace canonical history"]);
      git(fixture.publisher, ["push", "--force", "origin", "HEAD:main"]);
      git(fixture.worktree, ["push", "-u", "origin", `HEAD:refs/heads/${fixture.runId}`]);

      await assert.rejects(
        transitionPrePrFenceEstablished(fixture.runDir, { repoRoot: fixture.repo }),
        (error) => error.code === "BASE_ADVANCE_NON_FAST_FORWARD" && /recorded base commit.*ancestor.*canonical origin\/main/u.test(error.message),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects draft mode when the selected route is ordinary-fresh", async () => {
    const fixture = createBaseAdvanceTransitionFixture("lifecycle-ordinary-draft");
    try {
      fixture.advance();
      await advanceFactoryRunBase(fixture.runId, { cwd: fixture.repo });
      const candidate = installApprovedLifecycleSlice(fixture);
      await transitionSliceMerged(fixture.runDir, candidate.sliceId, { merge_commit: candidate.integrationHead }, { repoRoot: fixture.repo });
      await completeFinalCheckedTest(fixture, candidate.integrationHead);
      await publishIndependentPanels(fixture, candidate.integrationHead);
      await publishPrePrApproval(fixture);
      git(fixture.worktree, ["push", "-u", "origin", `HEAD:refs/heads/${fixture.runId}`]);
      const run = fixture.readRun();
      run.pr_mode = "draft";
      writeFileSync(join(fixture.runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);

      await assert.rejects(
        transitionPrePrFenceEstablished(fixture.runDir, { repoRoot: fixture.repo }),
        /pr-fence denied: ordinary-fresh-ready-required/u,
      );
      assert.equal(fixture.readRun().steering?.pr_fence, null);
    } finally {
      fixture.cleanup();
    }
  });

  it("routes unavailable, moving, and cleanup-failed PR main observations through the bounded canonical seam", async () => {
    const cases = [
      ["unavailable", "BASE_ADVANCE_ORIGIN_UNAVAILABLE", { gitOptions: { spawnSync: failCanonicalPrCommand("ls-remote") } }],
      ["cleanup", "BASE_ADVANCE_TEMP_REF_CLEANUP_FAILED", { gitOptions: { spawnSync: failCanonicalPrCommand("cleanup") } }],
      ["moving", "BASE_ADVANCE_TARGET_MOVED", null],
    ];
    for (const [name, code, staticOptions] of cases) {
      const fixture = await createFenceReadyOrdinaryFixture(`lifecycle-pr-origin-${name}`);
      try {
        const canonicalOriginOptions = staticOptions || { beforeFinalAdvertisement: () => fixture.advance("moved during PR observation\n") };
        await assert.rejects(
          transitionPrePrFenceEstablished(fixture.runDir, { repoRoot: fixture.repo, canonicalOriginOptions }),
          (error) => error.code === code,
          name,
        );
        assert.equal(fixture.readRun().steering?.pr_fence, null, name);
      } finally {
        fixture.cleanup();
      }
    }
  });
});

async function createFenceReadyOrdinaryFixture(name) {
  const fixture = createBaseAdvanceTransitionFixture(name);
  fixture.advance();
  await advanceFactoryRunBase(fixture.runId, { cwd: fixture.repo });
  const candidate = installApprovedLifecycleSlice(fixture);
  await transitionSliceMerged(fixture.runDir, candidate.sliceId, { merge_commit: candidate.integrationHead }, { repoRoot: fixture.repo });
  await completeFinalCheckedTest(fixture, candidate.integrationHead);
  await publishIndependentPanels(fixture, candidate.integrationHead);
  await publishPrePrApproval(fixture);
  git(fixture.worktree, ["push", "-u", "origin", `HEAD:refs/heads/${fixture.runId}`]);
  return fixture;
}

function failCanonicalPrCommand(mode) {
  return (file, args, options) => {
    if (mode === "ls-remote" && args[0] === "ls-remote") return { status: 2, stdout: "", stderr: "unavailable" };
    if (mode === "cleanup" && args[0] === "update-ref" && args[1] === "-d" && args[2].startsWith("refs/opencode/base-advance-origin/")) {
      return { status: 128, stdout: "", stderr: "cleanup failed" };
    }
    return spawnSync(file, args, options);
  };
}
