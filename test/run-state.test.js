import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  heartbeatOnce,
  mutateRunJsonLocked,
  transitionCostUsage,
  transitionGateDecision,
  transitionPrePrFenceEstablished,
  transitionLifecycleRun,
  transitionPrCreated,
  transitionRecoverOrphan,
  transitionRunJson,
  transitionRunSlice,
  transitionSteeringConsumed,
  transitionSteeringBoundaryOpened,
  transitionSteeringQueued,
  transitionTerminalResult,
  transitionSliceMerged,
  withRunJsonLock,
} from "../src/run-state.js";
import { MAX_COST_ATTRIBUTION_ENTRIES, recomputeCostAttribution } from "../src/cost-attribution.js";
import { checkRunConsistency } from "../src/validate.js";

const NOW = "2026-07-08T12:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;

describe("simplified run-state transitions", () => {
  it("approves gates through transition-time pending snapshot checks", async () => {
    const fixture = createFixture("gate-approve");
    try {
      await transitionGateDecision(fixture.runDir, "story", {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      });
      writeFileSync(join(fixture.runDir, "gates", "story.answer"), "approve\n");

      const result = await approveGateDecision(fixture.runDir, "story", {
        status: "approved",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      }, { now: NOW });

      assert.equal(result.run.gates.story.status, "approved");
      assert.equal(result.run.gates.story.approval_source, "external-driver");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects answers when pending gate material changed", async () => {
    const fixture = createFixture("stale-gate");
    try {
      await transitionGateDecision(fixture.runDir, "story", {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      });
      writeFileSync(join(fixture.runDir, "gates", "story.answer"), "approve\n");
      writeFileSync(join(fixture.runDir, "gates", "story.question.md"), "changed?\n");

      await assert.rejects(
        approveGateDecision(fixture.runDir, "story", {
          status: "approved",
          artifact: "artifacts/story.md",
          question_ref: "gates/story.question.md",
          answer_ref: "gates/story.answer",
        }),
        /current pending snapshot question_hash is stale/u,
      );
      assert.equal(readJson(join(fixture.runDir, "run.json")).gates.story.status, "pending");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects missing external answer refs", async () => {
    const fixture = createFixture("missing-answer");
    try {
      await transitionGateDecision(fixture.runDir, "story", {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      });
      await assert.rejects(
        approveGateDecision(fixture.runDir, "story", {
          status: "approved",
          artifact: "artifacts/story.md",
          question_ref: "gates/story.question.md",
          answer_ref: "gates/story.answer",
        }),
        /answer_hash|missing gates ref/u,
      );
      assert.equal(readJson(join(fixture.runDir, "run.json")).gates.story.status, "pending");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects direct approved-gate writes outside transitionGateDecision", async () => {
    const fixture = createFixture("direct-gate");
    try {
      await assert.rejects(
        transitionRunJson(fixture.runDir, (run) => {
          run.gates.story = { status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer: "approve" };
        }),
        /approved gate transitions must use transitionGateDecision/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects direct pending gate decisions outside transitionGateDecision", async () => {
    const fixture = createFixture("direct-changes-gate");
    try {
      await transitionGateDecision(fixture.runDir, "story", {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      });

      await assert.rejects(
        transitionRunJson(fixture.runDir, (run) => {
          run.gates.story = { ...run.gates.story, status: "changes_requested", answer: "changes: revise scope", answered_at: NOW };
        }),
        /pending gate decisions must use transitionGateDecision/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("allows changes_requested gate decisions through transitionGateDecision", async () => {
    const fixture = createFixture("changes-gate");
    try {
      await transitionGateDecision(fixture.runDir, "story", {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      });
      writeFileSync(join(fixture.runDir, "gates", "story.answer"), "changes: revise scope\n");

      const result = await transitionGateDecision(fixture.runDir, "story", {
        status: "changes_requested",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      }, { now: NOW });

      assert.equal(result.run.gates.story.status, "changes_requested");
      assert.equal(result.run.gates.story.answer, "changes: revise scope");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects changes answers without a body", async () => {
    const fixture = createFixture("empty-changes-gate");
    try {
      await transitionGateDecision(fixture.runDir, "story", {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      });
      writeFileSync(join(fixture.runDir, "gates", "story.answer"), "changes:   \n");

      await assert.rejects(
        transitionGateDecision(fixture.runDir, "story", {
          status: "changes_requested",
          artifact: "artifacts/story.md",
          question_ref: "gates/story.question.md",
          answer_ref: "gates/story.answer",
        }),
        /answer must be exactly approve, stop, or start with changes:/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("archives consumed answers and refuses stale answers after re-pending", async () => {
    const fixture = createFixture("gate-answer-lifecycle");
    try {
      await transitionGateDecision(fixture.runDir, "story", {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      });
      writeFileSync(join(fixture.runDir, "gates", "story.answer"), "approve\n");

      let result = await approveGateDecision(fixture.runDir, "story", {
        status: "approved",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      }, { now: NOW });

      assert.equal(result.run.gates.story.answer_ref, "gates/story.answer.consumed-1");
      assert.equal(existsSync(join(fixture.runDir, "gates", "story.answer")), false);
      assert.equal(existsSync(join(fixture.runDir, "gates", "story.answer.consumed-1")), true);

      writeFileSync(join(fixture.runDir, "gates", "story.question.md"), "approve again?\n");
      await transitionGateDecision(fixture.runDir, "story", {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      });

      await assert.rejects(
        approveGateDecision(fixture.runDir, "story", {
          status: "approved",
          artifact: "artifacts/story.md",
          question_ref: "gates/story.question.md",
          answer_ref: "gates/story.answer",
        }),
        /missing gates ref/u,
      );

      writeFileSync(join(fixture.runDir, "gates", "story.answer"), "approve\n");
      result = await approveGateDecision(fixture.runDir, "story", {
        status: "approved",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      }, { now: NOW });
      assert.equal(result.run.gates.story.answer_ref, "gates/story.answer.consumed-2");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects slice merge without an APPROVE review", async () => {
    const fixture = createFixture("slice-reject");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      prepareSliceMergeState(fixture, { verdict: "REJECT" });
      writeJson(join(fixture.runDir, "reviews", "caller-approved.json"), { subject: "slice", verdict: "APPROVE", required_fixes: [] });

      await assert.rejects(
        transitionSliceMerged(fixture.runDir, "slice", { merge_commit: "abc123", review_ref: "reviews/caller-approved.json" }),
        /requires APPROVE review/u,
      );
      assert.equal(readJson(join(fixture.runDir, "run.json")).slices[0].status, "review");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects slice review transitions without observed evidence", async () => {
    const fixture = createFixture("slice-review-missing-evidence");
    try {
      await assert.rejects(
        transitionRunSlice(fixture.runDir, "slice", { status: "review", attempts: 1, evidence_ref: "evidence/missing.json" }),
        /missing evidence ref/u,
      );
      assert.equal(readJson(join(fixture.runDir, "run.json")).slices[0].status, "running");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects slice merge with a missing review file", async () => {
    const fixture = createFixture("slice-missing-review");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      prepareSliceMergeState(fixture, { writeReview: false });

      await assert.rejects(
        transitionSliceMerged(fixture.runDir, "slice", { merge_commit: "abc123" }),
        /missing reviews ref/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects literal-null evidence and review JSON with clean precondition errors", async () => {
    const fixture = createFixture("null-json-preconditions");
    try {
      mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
      mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
      writeFileSync(join(fixture.runDir, "evidence", "slice.json"), "null\n", "utf8");

      await assert.rejects(
        transitionRunSlice(fixture.runDir, "slice", { status: "review", attempts: 1, evidence_ref: "evidence/slice.json" }),
        /evidence_ref must be a JSON object/u,
      );

      initGitRepo(fixture.repo, ["slice-branch"]);
      writeJson(join(fixture.runDir, "evidence", "slice.json"), { subject: "slice", status: "pass", review_ready: true });
      writeFileSync(join(fixture.runDir, "reviews", "slice.json"), "null\n", "utf8");
      writeJson(join(fixture.runDir, "run.json"), {
        ...baseRun(fixture.runId),
        slices: [{ id: "slice", status: "review", attempts: 1, branch: "slice-branch", evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json", merge_commit: null }],
      });

      await assert.rejects(
        transitionSliceMerged(fixture.runDir, "slice", { merge_commit: "abc123" }),
        /review_ref must be a JSON object/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects slice merge with a nonexistent branch", async () => {
    const fixture = createFixture("slice-missing-branch");
    try {
      initGitRepo(fixture.repo, ["caller-branch"]);
      prepareSliceMergeState(fixture);

      await assert.rejects(
        transitionSliceMerged(fixture.runDir, "slice", { merge_commit: "abc123", branch: "caller-branch" }),
        /requires existing branch 'slice-branch'/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("records slice merge after transition-time preconditions", async () => {
    const fixture = createFixture("slice-merged");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      prepareSliceMergeState(fixture);

      const result = await transitionSliceMerged(fixture.runDir, "slice", { merge_commit: "abc123" }, { now: NOW });

      assert.equal(result.slice.status, "merged");
      assert.equal(result.slice.merge_commit, "abc123");
      assert.equal(result.run.updated_at, NOW);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("records PR creation from transition-time preconditions only", async () => {
    const fixture = createFixture("pr-created");
    try {
      writeJson(join(fixture.runDir, "run.json"), {
        ...baseRun(fixture.runId),
        gates: { pre_pr: { status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer: "approve", answered_at: NOW } },
        slices: [{ id: "slice", status: "merged", attempts: 1, branch: "slice-branch", evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json", merge_commit: "abc123" }],
        validator: { verdict: "GO", report: "artifacts/story.md", review_ref: "reviews/implementation-validator.json" },
        security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" },
      });
      mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
      writeJson(join(fixture.runDir, "reviews", "implementation-validator.json"), { subject: "feature-branch", verdict: "GO" });
      writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), { subject: "feature-branch", verdict: "PASS" });

      const result = await createPrTransition(fixture.runDir, {
        pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/99",
        pr_number: 99,
        repository: "jasoncarreira/opencode-feature-factory",
      });

      assert.equal(result.run.status, "completed");
      assert.equal(result.run.pr_url, "https://github.com/jasoncarreira/opencode-feature-factory/pull/99");
      assert.equal(result.run.terminal_result.draft, false);
      assert.equal(result.run.terminal_result.summary, "PR created.");
      await assert.rejects(
        transitionRunJson(fixture.runDir, (run) => {
          run.updated_at = NOW;
        }),
        /terminal run 'completed' cannot be mutated/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("allows default ready PR creation for blocked-run continuations", async () => {
    const fixture = createFixture("pr-continuation-default-ready");
    try {
      writeReadyPrRun(fixture, {
        branch: "continuation-branch",
        worktree: "/tmp/continuation-worktree",
        continuation: continuationMetadata(fixture.runId),
      });

      const result = await createPrTransition(fixture.runDir, {
        pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/103",
        pr_number: 103,
        repository: "jasoncarreira/opencode-feature-factory",
      });

      assert.equal(result.run.status, "completed");
      assert.equal(result.run.terminal_result.draft, false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("allows explicit draft PR creation for blocked-run continuations", async () => {
    const fixture = createFixture("pr-continuation-draft");
    try {
      writeReadyPrRun(fixture, {
        branch: "continuation-branch",
        worktree: "/tmp/continuation-worktree",
        continuation: continuationMetadata(fixture.runId),
      });

      const result = await createPrTransition(fixture.runDir, {
        pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/104",
        pr_number: 104,
        repository: "jasoncarreira/opencode-feature-factory",
        draft: true,
      });

      assert.equal(result.run.status, "completed");
      assert.equal(result.run.terminal_result.draft, true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects PR creation when repository disagrees with the PR URL", async () => {
    const fixture = createFixture("pr-repository-mismatch");
    try {
      writeReadyPrRun(fixture);

      await assert.rejects(
        establishFenceAndExpectFailure(fixture.runDir, {
          pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/104",
          pr_number: 104,
          repository: "other-owner/other-repo",
        }),
        /repository to match the GitHub PR URL/u,
      );
      const run = readJson(join(fixture.runDir, "run.json"));
      assert.equal(run.status, "running");
      assert.equal(run.pr_url, undefined);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects PR creation while slices are still in flight", async () => {
    const fixture = createFixture("pr-slice-review");
    try {
      writeReadyPrRun(fixture, { slices: [{ id: "slice", status: "review", attempts: 1 }] });

      await assert.rejects(
        establishFenceAndExpectFailure(fixture.runDir, {
          pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/100",
          pr_number: 100,
          repository: "jasoncarreira/opencode-feature-factory",
        }),
        /all slices to be merged or blocked/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects PR creation when a passing validator report is missing", async () => {
    const fixture = createFixture("pr-missing-report");
    try {
      writeReadyPrRun(fixture, { validator: { verdict: "GO", report: "artifacts/missing.md" } });

      await assert.rejects(
        establishFenceAndExpectFailure(fixture.runDir, {
          pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/101",
          pr_number: 101,
          repository: "jasoncarreira/opencode-feature-factory",
        }),
        /missing artifacts ref/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("keeps validator NO-GO and security BLOCK runs out of PR-created state", async () => {
    const cases = [
      {
        runId: "pr-validator-no-go",
        overrides: { validator: { verdict: "NO-GO", report: "artifacts/story.md", review_ref: "reviews/implementation-validator.json" } },
        review: { subject: "feature-branch", verdict: "NO-GO" },
        message: /validator verdict GO or GO-WITH-NITS/u,
      },
      {
        runId: "pr-security-block",
        overrides: { security_review: { verdict: "BLOCK", review_ref: "reviews/security-reviewer.json" } },
        review: { subject: "feature-branch", verdict: "BLOCK" },
        message: /security_review verdict PASS/u,
      },
    ];

    for (const item of cases) {
      const fixture = createFixture(item.runId);
      try {
        writeReadyPrRun(fixture, {
          branch: "continuation-branch",
          worktree: "/tmp/continuation-worktree",
          continuation: continuationMetadata(fixture.runId),
          ...item.overrides,
        });
        if (item.runId === "pr-validator-no-go") writeJson(join(fixture.runDir, "reviews", "implementation-validator.json"), item.review);
        else writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), item.review);

        await assert.rejects(
          establishFenceAndExpectFailure(fixture.runDir, {
            pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/105",
            pr_number: 105,
            repository: "jasoncarreira/opencode-feature-factory",
          }),
          item.message,
        );
        let run = readJson(join(fixture.runDir, "run.json"));
        assert.equal(run.status, "running");
        assert.equal(run.pr_url, undefined);

        const blocked = await terminalTransition(fixture.runDir, { status: "blocked", reason: "review gate did not pass", artifacts: {} });
        assert.equal(blocked.run.status, "blocked");
        assert.equal(blocked.run.pr_url, undefined);
        run = readJson(join(fixture.runDir, "run.json"));
        assert.equal(run.terminal_result.pr_url, undefined);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("persists cost usage through a locked run.json transition", async () => {
    const fixture = createFixture("cost-usage");
    try {
      const result = await transitionCostUsage(fixture.runDir, {
        run_id: "caller-supplied-wrong-run",
        agent: "backend-builder",
        slice_id: "slice",
        provider: "opencode",
        model: "gpt-5.5",
        input_tokens: 100,
        output_tokens: 25,
        total_tokens: 125,
        cost_total: 0.42,
        cost_currency: "USD",
      }, { now: NOW, id: "usage-1" });

      assert.equal(result.updated, true);
      assert.equal(result.run.updated_at, NOW);
      assert.equal(result.cost_attribution.entries[0].id, "usage-1");
      assert.equal(result.cost_attribution.entries[0].run_id, fixture.runId);
      assert.equal(result.cost_attribution.totals.total_tokens, 125);
      assert.equal(result.cost_attribution.by_slice.slice.cost_total, 0.42);
      assert.deepEqual(readJson(join(fixture.runDir, "run.json")).cost_attribution, result.cost_attribution);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("does not consume pending steering when recording cost usage", async () => {
    const fixture = createFixture("cost-pending-steering");
    try {
      await transitionSteeringQueued(fixture.runDir, "reconsider the next build wave", { now: NOW, id: "cost-pending" });
      const steeringBefore = snapshotPendingSteering(fixture);

      const result = await transitionCostUsage(fixture.runDir, {
        agent: "backend-builder",
        slice_id: "slice",
        input_tokens: 20,
        output_tokens: 5,
      }, { now: "2026-07-08T12:01:00.000Z", id: "usage-with-pending" });

      assert.equal(result.updated, true);
      assert.equal(result.cost_attribution.entries.at(-1).id, "usage-with-pending");
      assertPendingSteeringUnchanged(fixture, steeringBefore);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("does not mutate terminal runs when recording cost usage", async () => {
    const fixture = createFixture("cost-terminal");
    try {
      await terminalTransition(fixture.runDir, { status: "blocked", reason: "done", artifacts: {} }, { now: NOW });

      await assert.rejects(
        transitionCostUsage(fixture.runDir, { agent: "backend-builder", input_tokens: 1 }, { now: NOW, id: "late-cost" }),
        /terminal run 'blocked' cannot be mutated/u,
      );
      assert.equal(readJson(join(fixture.runDir, "run.json")).cost_attribution, undefined);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects cost usage while a fresh heartbeat is active", async () => {
    const fixture = createFixture("cost-active-heartbeat");
    try {
      writeJson(join(fixture.runDir, "heartbeat.json"), heartbeat(fixture.runId));
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");

      await assert.rejects(
        transitionCostUsage(fixture.runDir, { agent: "backend-builder", input_tokens: 1 }, { now: NOW, id: "active-cost", processAliveFn: (pid) => pid === process.pid }),
        /cost-record requires inactive heartbeat: active-heartbeat/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects cost usage beyond the entry cap without rewriting run.json", async () => {
    const fixture = createFixture("cost-cap");
    try {
      const cost_attribution = recomputeCostAttribution({ entries: Array.from({ length: MAX_COST_ATTRIBUTION_ENTRIES }, (_, index) => ({
        id: `usage-${index}`,
        recorded_at: NOW,
        run_id: fixture.runId,
        agent: "backend-builder",
        slice_id: "slice",
        provider: "opencode",
        model: "gpt-5.5",
        input_tokens: 1,
        cost_total: 0.001,
        cost_currency: "USD",
      })) }, { now: NOW });
      writeJson(join(fixture.runDir, "run.json"), { ...baseRun(fixture.runId), cost_attribution });
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");

      await assert.rejects(
        transitionCostUsage(fixture.runDir, { agent: "backend-builder", provider: "opencode", model: "gpt-5.5", input_tokens: 1, cost_total: 0.001, cost_currency: "USD" }, { now: NOW, id: "overflow" }),
        /cost attribution entries must have at most 1000 entries/u,
      );

      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
      assert.equal(readJson(join(fixture.runDir, "run.json")).cost_attribution.entries.length, MAX_COST_ATTRIBUTION_ENTRIES);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("keeps consistency green through fix-in-place slice remediation", async () => {
    const fixture = createFixture("remediation-regression");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      await approveGate(fixture, "story", "story.md");
      assertConsistent(fixture);
      await approveGate(fixture, "brief", "brief.md");
      assertConsistent(fixture);

      runGit(fixture.repo, ["checkout", "slice-branch"]);
      writeFileSync(join(fixture.repo, "feature.txt"), "attempt 1\n");
      runGit(fixture.repo, ["add", "feature.txt"]);
      runGit(fixture.repo, ["commit", "-m", "slice attempt 1"]);
      const attemptOneHead = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);

      mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
      mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
      writeJson(join(fixture.runDir, "evidence", "slice.attempt-1.json"), { subject: "slice", status: "pass", review_ready: true, head: attemptOneHead });
      writeJson(join(fixture.runDir, "reviews", "slice.attempt-1.json"), { subject: "slice", verdict: "REJECT", required_fixes: ["adjust implementation"] });
      await transitionRunSlice(fixture.runDir, "slice", {
        status: "review",
        attempts: 1,
        branch: "slice-branch",
        evidence_ref: "evidence/slice.attempt-1.json",
        review_ref: "reviews/slice.attempt-1.json",
      });
      assertConsistent(fixture);

      writeFileSync(join(fixture.repo, "feature.txt"), "attempt 2\n");
      runGit(fixture.repo, ["add", "feature.txt"]);
      runGit(fixture.repo, ["commit", "-m", "slice attempt 2"]);
      const attemptTwoHead = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      assert.notEqual(attemptTwoHead, attemptOneHead);

      writeJson(join(fixture.runDir, "evidence", "slice.attempt-2.json"), { subject: "slice", status: "pass", review_ready: true, head: attemptTwoHead, previous_head: attemptOneHead });
      writeJson(join(fixture.runDir, "reviews", "slice.attempt-2.json"), { subject: "slice", verdict: "APPROVE", required_fixes: [] });
      await transitionRunSlice(fixture.runDir, "slice", {
        status: "review",
        attempts: 2,
        branch: "slice-branch",
        evidence_ref: "evidence/slice.attempt-2.json",
        review_ref: "reviews/slice.attempt-2.json",
      });
      assertConsistent(fixture);

      await transitionSliceMerged(fixture.runDir, "slice", { merge_commit: attemptTwoHead });
      assertConsistent(fixture);

      writeFileSync(join(fixture.runDir, "artifacts", "validation-report.md"), "GO\n");
      writeJson(join(fixture.runDir, "reviews", "implementation-validator.json"), { subject: "slice-branch", verdict: "GO" });
      writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), { subject: "slice-branch", verdict: "PASS" });
      await transitionRunJson(fixture.runDir, (run) => {
        run.validator = { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" };
        run.security_review = { verdict: "PASS", review_ref: "reviews/security-reviewer.json" };
      });
      assertConsistent(fixture);

      await approveGate(fixture, "pre_pr", "validation-report.md");
      assertConsistent(fixture);

      await createPrTransition(fixture.runDir, {
        pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/102",
        pr_number: 102,
        repository: "jasoncarreira/opencode-feature-factory",
      });
      assertConsistent(fixture);
      assert.equal(readJson(join(fixture.runDir, "run.json")).status, "completed");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("recovers orphaned running runs to needs-human", async () => {
    const fixture = createFixture("recover");
    try {
      const result = await transitionRecoverOrphan(fixture.runDir, "process was killed", { now: NOW });
      assert.equal(result.run.status, "needs-human");
      assert.equal(result.run.terminal_result.reason, "process was killed");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("queues and consumes steering through locked transitions", async () => {
    const fixture = createFixture("steering-transition");
    try {
      const queued = await transitionSteeringQueued(fixture.runDir, "steer safely", { now: NOW });
      assert.equal(queued.run.steering.pending.hash.startsWith("sha256:"), true);
      const consumed = await transitionSteeringConsumed(fixture.runDir, { ref: queued.steering.ref, hash: queued.steering.hash }, { now: "2026-07-08T12:01:00.000Z" });
      assert.equal(consumed.steering.trust, "untrusted-operator-data");
      assert.equal(consumed.run.steering.pending, null);
      assert.equal(consumed.run.steering.history.at(-1).event, "consumed");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("does not consume pending steering in generic low-level transitions", async () => {
    const transitions = [
      ["transitionRunJson", transitionRunJson],
      ["transitionLifecycleRun", transitionLifecycleRun],
      ["mutateRunJsonLocked", mutateRunJsonLocked],
    ];

    for (const [name, transition] of transitions) {
      const fixture = createFixture(`pending-${name}`);
      try {
        await transitionSteeringQueued(fixture.runDir, `keep steering pending through ${name}`, { now: NOW, id: `pending-${name}` });
        const steeringBefore = snapshotPendingSteering(fixture);
        const updatedAt = "2026-07-08T12:01:00.000Z";

        const result = await transition(fixture.runDir, (run) => {
          run.updated_at = updatedAt;
        });

        assert.equal(result.updated, true, `${name} should perform its requested state transition`);
        assert.equal(result.run.updated_at, updatedAt);
        assertPendingSteeringUnchanged(fixture, steeringBefore);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("does not consume pending steering on heartbeat ticks", async () => {
    const fixture = createFixture("heartbeat-pending-steering");
    try {
      await transitionSteeringQueued(fixture.runDir, "adjust work after the current wait", { now: NOW, id: "heartbeat-pending" });
      const steeringBefore = snapshotPendingSteering(fixture);
      writeJson(join(fixture.runDir, "heartbeat.json"), heartbeat(fixture.runId));

      const result = await heartbeatOnce(fixture.runDir, { now: Date.parse("2026-07-08T12:01:00.000Z") });

      assert.equal(result.updated, true);
      assert.equal(result.run.heartbeat_at, "2026-07-08T12:01:00.000Z");
      assertPendingSteeringUnchanged(fixture, steeringBefore);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("heartbeat ticks only liveness state", async () => {
    const fixture = createFixture("heartbeat");
    try {
      writeJson(join(fixture.runDir, "heartbeat.json"), heartbeat(fixture.runId));

      const result = await heartbeatOnce(fixture.runDir, { now: Date.parse(NOW) });

      assert.equal(result.updated, true);
      assert.equal(result.run.heartbeat_at, NOW);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("steals a run-json lock from a dead owner", async () => {
    const fixture = createFixture("steal-dead-lock");
    try {
      const lockDir = join(fixture.runDir, "run-json.lock");
      mkdirSync(lockDir);
      writeJson(join(lockDir, "owner.json"), { pid: 999999, hostname: hostname(), acquired_at: NOW, nonce: "11111111-1111-4111-8111-111111111111" });

      let observedOwner = null;
      await withRunJsonLock(fixture.runDir, ({ owner }) => {
        observedOwner = owner;
      }, { timeoutMs: 5, retryDelayMs: 1, processAliveFn: () => false });

      assert.equal(observedOwner.stolen_from.pid, 999999);
      assert.equal(observedOwner.stolen_from.hostname, hostname());
      assert.equal(observedOwner.stolen_from.nonce, undefined);
      assert.match(observedOwner.nonce, /^[0-9a-f-]{36}$/u);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("revalidates dead-owner liveness immediately before quarantine removal", async () => {
    const fixture = createFixture("reclaim-liveness-change");
    const lockDir = join(fixture.runDir, "run-json.lock");
    let livenessChecks = 0;
    let quarantine = null;
    let callbackEntered = false;
    try {
      mkdirSync(lockDir);
      writeJson(join(lockDir, "owner.json"), {
        pid: 999999,
        hostname: hostname(),
        acquired_at: NOW,
        nonce: "99999999-9999-4999-8999-999999999999",
      });

      await assert.rejects(
        withRunJsonLock(fixture.runDir, () => { callbackEntered = true; }, {
          timeoutMs: 5000,
          retryDelayMs: 1,
          processAliveFn: () => {
            livenessChecks += 1;
            return livenessChecks < 3 ? false : true;
          },
          lockHooks: {
            onReclaimRenamed: ({ quarantine: path }) => { quarantine = path; },
          },
        }),
        /owner is no longer definitively dead before removal/u,
      );

      assert.equal(livenessChecks, 3);
      assert.equal(callbackEntered, false);
      assert.equal(existsSync(lockDir), false);
      assert.ok(quarantine);
      assert.equal(existsSync(quarantine), true, "changed-owner quarantine must remain for manual recovery");
      assert.equal(readJson(join(quarantine, "owner.json")).nonce, "99999999-9999-4999-8999-999999999999");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("does not steal an aged run-json lock from a live owner", async () => {
    const fixture = createFixture("live-lock");
    try {
      const lockDir = join(fixture.runDir, "run-json.lock");
      mkdirSync(lockDir);
      writeJson(join(lockDir, "owner.json"), { pid: process.pid, hostname: hostname(), acquired_at: "2000-01-01T00:00:00.000Z", nonce: "22222222-2222-4222-8222-222222222222" });

      await assert.rejects(
        withRunJsonLock(fixture.runDir, () => {}, { timeoutMs: 5, retryDelayMs: 1, staleLockMs: 1, processAliveFn: () => true }),
        /timed out waiting for run\.json lock/u,
      );
      assert.equal(readJson(join(lockDir, "owner.json")).nonce, "22222222-2222-4222-8222-222222222222");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("fails closed when a paused pre-publication acquirer resumes into a successor lock", async () => {
    const fixture = createFixture("publication-gap");
    const firstCreated = deferredPromise();
    const releaseFirst = deferredPromise();
    const successorEntered = deferredPromise();
    const releaseSuccessor = deferredPromise();
    try {
      const first = withRunJsonLock(fixture.runDir, () => {}, {
        timeoutMs: 5000,
        lockHooks: { onLockCreated: async () => { firstCreated.resolve(); await releaseFirst.promise; } },
      });
      await firstCreated.promise;
      rmSync(join(fixture.runDir, "run-json.lock"), { recursive: true, force: true });

      const successor = withRunJsonLock(fixture.runDir, async ({ owner }) => {
        successorEntered.resolve(owner.nonce);
        await releaseSuccessor.promise;
      }, { timeoutMs: 5000 });
      const successorNonce = await successorEntered.promise;
      releaseFirst.resolve();
      await assert.rejects(first, /lock ownership changed before owner publication/u);
      assert.equal(readJson(join(fixture.runDir, "run-json.lock", "owner.json")).nonce, successorNonce);

      releaseSuccessor.resolve();
      await successor;
      assert.equal(existsSync(join(fixture.runDir, "run-json.lock")), false);
    } finally {
      releaseFirst.resolve();
      releaseSuccessor.resolve();
      cleanup(fixture.repo);
    }
  });

  it("cleans up only the lock carrying the callback owner's nonce", async () => {
    const fixture = createFixture("nonce-cleanup");
    const lockDir = join(fixture.runDir, "run-json.lock");
    try {
      const successorNonce = "33333333-3333-4333-8333-333333333333";
      await withRunJsonLock(fixture.runDir, async ({ owner }) => {
        assert.notEqual(owner.nonce, successorNonce);
        writeJson(join(lockDir, "owner.json"), { ...owner, nonce: successorNonce });
      });
      assert.equal(readJson(join(lockDir, "owner.json")).nonce, successorNonce);
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
      cleanup(fixture.repo);
    }
  });

  it("reclaims an old ownerless lock left by a crash", async () => {
    const fixture = createFixture("ownerless-lock");
    let callbackEntered = false;
    try {
      const lockDir = join(fixture.runDir, "run-json.lock");
      mkdirSync(lockDir);
      await new Promise((resolve) => setTimeout(resolve, 10));

      await withRunJsonLock(fixture.runDir, () => { callbackEntered = true; }, {
        timeoutMs: 5000,
        retryDelayMs: 1,
        missingOwnerStealMs: 1,
      });

      assert.equal(callbackEntered, true);
      assert.equal(existsSync(lockDir), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("fails closed for a fresh ownerless lock and invalid owner publication", async () => {
    for (const [name, owner, missingOwnerStealMs] of [
      ["fresh-ownerless", null, 60000],
      ["invalid", { pid: 999999, hostname: "dead", acquired_at: NOW }, 1],
    ]) {
      const fixture = createFixture(`invalid-lock-${name}`);
      try {
        const lockDir = join(fixture.runDir, "run-json.lock");
        mkdirSync(lockDir);
        if (owner) writeJson(join(lockDir, "owner.json"), owner);
        await assert.rejects(
          withRunJsonLock(fixture.runDir, () => {}, { timeoutMs: 5, retryDelayMs: 1, missingOwnerStealMs, processAliveFn: () => false }),
          /timed out waiting for run\.json lock/u,
        );
        assert.equal(existsSync(lockDir), true);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("does not delete invalid successor evidence published while acquisition is paused", async () => {
    const fixture = createFixture("invalid-publication-race");
    const created = deferredPromise();
    const release = deferredPromise();
    const lockDir = join(fixture.runDir, "run-json.lock");
    try {
      const acquiring = withRunJsonLock(fixture.runDir, () => {}, {
        timeoutMs: 5000,
        lockHooks: { onLockCreated: async () => { created.resolve(); await release.promise; } },
      });
      await created.promise;
      writeJson(join(lockDir, "owner.json"), { invalid: true });
      release.resolve();
      await assert.rejects(acquiring, /EEXIST/u);
      assert.deepEqual(readJson(join(lockDir, "owner.json")), { invalid: true });
    } finally {
      release.resolve();
      rmSync(lockDir, { recursive: true, force: true });
      cleanup(fixture.repo);
    }
  });

  it("allows only one exact-lock reclaimer and never removes its successor", async () => {
    const fixture = createFixture("two-reclaimers");
    const lockDir = join(fixture.runDir, "run-json.lock");
    const firstClaimed = deferredPromise();
    const releaseFirstClaim = deferredPromise();
    const firstRenamed = deferredPromise();
    const releaseFirstRename = deferredPromise();
    const secondContended = deferredPromise();
    const secondCreated = deferredPromise();
    const releaseSecondPublication = deferredPromise();
    const secondEntered = deferredPromise();
    const releaseSecondCallback = deferredPromise();
    const secondCleaning = deferredPromise();
    const releaseSecondCleanup = deferredPromise();
    const firstEntered = deferredPromise();
    let activeCallbacks = 0;
    let maxActiveCallbacks = 0;
    try {
      mkdirSync(lockDir);
      writeJson(join(lockDir, "owner.json"), {
        pid: 999999,
        hostname: hostname(),
        acquired_at: NOW,
        nonce: "55555555-5555-4555-8555-555555555555",
      });
      const callback = async (entered, release = null) => {
        activeCallbacks += 1;
        maxActiveCallbacks = Math.max(maxActiveCallbacks, activeCallbacks);
        entered.resolve();
        if (release) await release.promise;
        activeCallbacks -= 1;
      };
      const first = withRunJsonLock(fixture.runDir, () => callback(firstEntered), {
        timeoutMs: 5000,
        retryDelayMs: 1,
        processAliveFn: () => false,
        lockHooks: {
          onReclaimClaimed: async () => { firstClaimed.resolve(); await releaseFirstClaim.promise; },
          onReclaimRenamed: async () => { firstRenamed.resolve(); await releaseFirstRename.promise; },
        },
      });
      await firstClaimed.promise;
      const second = withRunJsonLock(fixture.runDir, () => callback(secondEntered, releaseSecondCallback), {
        timeoutMs: 5000,
        retryDelayMs: 1,
        processAliveFn: () => false,
        lockHooks: {
          onContended: () => secondContended.resolve(),
          onLockCreated: async () => { secondCreated.resolve(); await releaseSecondPublication.promise; },
          onBeforeCleanup: async () => { secondCleaning.resolve(); await releaseSecondCleanup.promise; },
        },
      });
      await secondContended.promise;
      releaseFirstClaim.resolve();
      await firstRenamed.promise;
      await secondCreated.promise;
      releaseSecondPublication.resolve();
      await secondEntered.promise;
      releaseFirstRename.resolve();
      releaseSecondCallback.resolve();
      await secondCleaning.promise;
      assert.equal(activeCallbacks, 0);
      assert.equal(existsSync(lockDir), true, "successor lock must remain during its cleanup barrier");
      releaseSecondCleanup.resolve();
      await second;
      await firstEntered.promise;
      await first;
      assert.equal(maxActiveCallbacks, 1);
      assert.equal(existsSync(lockDir), false);
    } finally {
      for (const barrier of [releaseFirstClaim, releaseFirstRename, releaseSecondPublication, releaseSecondCallback, releaseSecondCleanup]) barrier.resolve();
      rmSync(lockDir, { recursive: true, force: true });
      cleanup(fixture.repo);
    }
  });

  it("binds a delayed reclaim claim outside the replaceable lock pathname", async () => {
    const fixture = createFixture("observation-claim-race");
    const lockDir = join(fixture.runDir, "run-json.lock");
    const delayedObserved = deferredPromise();
    const releaseDelayedClaim = deferredPromise();
    const winnerRemoved = deferredPromise();
    const releaseWinnerRemoved = deferredPromise();
    const delayedAbandoned = deferredPromise();
    const successorEntered = deferredPromise();
    const releaseSuccessor = deferredPromise();
    let delayedCallbackEntered = false;
    let winnerCallbackEntered = false;
    try {
      mkdirSync(lockDir);
      writeJson(join(lockDir, "owner.json"), {
        pid: 999999,
        hostname: hostname(),
        acquired_at: NOW,
        nonce: "88888888-8888-4888-8888-888888888888",
      });
      const delayed = withRunJsonLock(fixture.runDir, () => { delayedCallbackEntered = true; }, {
        timeoutMs: 5000,
        retryDelayMs: 1,
        processAliveFn: () => false,
        lockHooks: {
          onBeforeReclaimClaim: async () => { delayedObserved.resolve(); await releaseDelayedClaim.promise; },
          onReclaimAbandoned: () => delayedAbandoned.resolve(),
        },
      });
      await delayedObserved.promise;
      const winner = withRunJsonLock(fixture.runDir, () => { winnerCallbackEntered = true; }, {
        timeoutMs: 5000,
        retryDelayMs: 1,
        processAliveFn: () => false,
        lockHooks: { onReclaimRemoved: async () => { winnerRemoved.resolve(); await releaseWinnerRemoved.promise; } },
      });
      await winnerRemoved.promise;
      const successor = withRunJsonLock(fixture.runDir, async () => {
        successorEntered.resolve();
        await releaseSuccessor.promise;
      }, { timeoutMs: 5000 });
      await successorEntered.promise;
      const successorOwner = readFileSync(join(lockDir, "owner.json"));
      releaseDelayedClaim.resolve();
      await delayedAbandoned.promise;
      assert.deepEqual(readFileSync(join(lockDir, "owner.json")), successorOwner);
      assert.deepEqual(readdirSync(lockDir), ["owner.json"]);
      assert.equal(delayedCallbackEntered, false);
      assert.equal(winnerCallbackEntered, false);

      releaseWinnerRemoved.resolve();
      releaseSuccessor.resolve();
      await successor;
      await Promise.all([winner, delayed]);
      assert.equal(winnerCallbackEntered, true);
      assert.equal(delayedCallbackEntered, true);
      assert.equal(existsSync(lockDir), false);
    } finally {
      for (const barrier of [releaseDelayedClaim, releaseWinnerRemoved, releaseSuccessor]) barrier.resolve();
      rmSync(lockDir, { recursive: true, force: true });
      cleanup(fixture.repo);
    }
  });

  it("fails closed for remote and indeterminate owner liveness", async () => {
    const cases = [
      ["remote", "remote-host.invalid", () => false],
      ["undefined", hostname(), () => undefined],
      ["unknown-status", hostname(), () => ({ status: "unknown" })],
      ["eperm", hostname(), () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); }],
      ["probe-error", hostname(), () => { throw new Error("probe failed"); }],
    ];
    for (const [name, ownerHostname, processAliveFn] of cases) {
      const fixture = createFixture(`indeterminate-${name}`);
      const lockDir = join(fixture.runDir, "run-json.lock");
      try {
        mkdirSync(lockDir);
        writeJson(join(lockDir, "owner.json"), {
          pid: 999999,
          hostname: ownerHostname,
          acquired_at: NOW,
          nonce: "66666666-6666-4666-8666-666666666666",
        });
        await assert.rejects(
          withRunJsonLock(fixture.runDir, () => {}, { timeoutMs: 5, retryDelayMs: 1, processAliveFn }),
          /timed out waiting for run\.json lock/u,
        );
        assert.equal(readJson(join(lockDir, "owner.json")).nonce, "66666666-6666-4666-8666-666666666666");
      } finally {
        cleanup(fixture.repo);
      }
    }
  });
});

function deferredPromise() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createFixture(runId) {
  const repo = mkdtempSync(join(tmpdir(), "run-state-simplified-"));
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "gates"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "story.md"), "story\n");
  writeFileSync(join(runDir, "gates", "story.question.md"), "approve?\n");
  writeJson(join(runDir, "run.json"), baseRun(runId));
  return { repo, runDir, runId };
}

function prepareSliceMergeState(fixture, { verdict = "APPROVE", subject = "slice", writeReview = true } = {}) {
  mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
  mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
  writeJson(join(fixture.runDir, "evidence", "slice.json"), { subject: "slice", status: "pass", review_ready: true });
  if (writeReview) writeJson(join(fixture.runDir, "reviews", "slice.json"), { subject, verdict, required_fixes: [] });
  writeJson(join(fixture.runDir, "run.json"), {
    ...baseRun(fixture.runId),
    slices: [{ id: "slice", status: "review", attempts: 1, branch: "slice-branch", evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json", merge_commit: null }],
  });
}

async function approveGate(fixture, gate, artifactFile) {
  const artifactRef = `artifacts/${artifactFile}`;
  const questionRef = `gates/${gate}.question.md`;
  const answerRef = `gates/${gate}.answer`;
  if (!artifactFile.endsWith("story.md")) writeFileSync(join(fixture.runDir, artifactRef), `${gate}\n`);
  writeFileSync(join(fixture.runDir, questionRef), `approve ${gate}?\n`);
  await transitionGateDecision(fixture.runDir, gate, {
    status: "pending",
    artifact: artifactRef,
    question_ref: questionRef,
    answer_ref: answerRef,
  });
  writeFileSync(join(fixture.runDir, answerRef), "approve\n");
  await approveGateDecision(fixture.runDir, gate, {
    status: "approved",
    artifact: artifactRef,
    question_ref: questionRef,
    answer_ref: answerRef,
  }, { now: NOW });
}

async function approveGateDecision(runDir, gate, decision, options = {}) {
  const opened = await transitionSteeringBoundaryOpened(runDir, "gate", options);
  return transitionGateDecision(runDir, gate, decision, { ...options, boundaryToken: opened.boundary.token });
}

async function createPrTransition(runDir, input, options = {}) {
  const fenced = await transitionPrePrFenceEstablished(runDir, options);
  return transitionPrCreated(runDir, input, { ...options, fenceToken: fenced.fence.token });
}

async function establishFenceAndExpectFailure(runDir, input, options = {}) {
  const fenced = await transitionPrePrFenceEstablished(runDir, options);
  return transitionPrCreated(runDir, input, { ...options, fenceToken: fenced.fence.token });
}

async function terminalTransition(runDir, terminalResult, options = {}) {
  const opened = await transitionSteeringBoundaryOpened(runDir, "terminal", options);
  return transitionTerminalResult(runDir, terminalResult, { ...options, boundaryToken: opened.boundary.token });
}

function assertConsistent(fixture) {
  const result = checkRunConsistency(fixture.runDir, readJson(join(fixture.runDir, "run.json")));
  if (result.ok) return;
  const errors = result.checks.flatMap((check) => check.errors || []).map((error) => `${error.path}: ${error.message}`).join("\n");
  assert.fail(errors || "run consistency failed");
}

function writeReadyPrRun(fixture, overrides = {}) {
  mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
  writeJson(join(fixture.runDir, "reviews", "implementation-validator.json"), { subject: "feature-branch", verdict: "GO" });
  writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), { subject: "feature-branch", verdict: "PASS" });
  writeJson(join(fixture.runDir, "run.json"), {
    ...baseRun(fixture.runId),
    gates: { pre_pr: { status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer: "approve", answered_at: NOW } },
    slices: [{ id: "slice", status: "merged", attempts: 1, branch: "slice-branch", evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json", merge_commit: "abc123" }],
    validator: { verdict: "GO", report: "artifacts/story.md", review_ref: "reviews/implementation-validator.json" },
    security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" },
    ...overrides,
  });
}

function continuationMetadata(targetRunId) {
  return {
    schema_version: 1,
    kind: "blocked-run-continuation",
    created_at: "2026-07-08T12:00:00.000Z",
    operator_summary: "Continue blocked parent run from implementation-validator review.",
    parent: {
      run_id: "parent-run",
      status: "blocked",
      run_ref: "runs/parent-run/run.json",
      run_hash: HASH,
      branch: "parent-branch",
      commit: "abc123",
      worktree: "/tmp/parent-worktree",
    },
    review: {
      kind: "validator",
      ref: "reviews/implementation-validator.json",
      hash: HASH,
      subject: "parent-run",
      summary: "Validator required fixes before PR creation.",
      required_fixes: ["address validation failure"],
      source: "run.validator.review_ref",
    },
    target: {
      run_id: targetRunId,
      branch: "continuation-branch",
      worktree: "/tmp/continuation-worktree",
      base_ref: "main",
      base_commit: "def456",
    },
    parent_artifacts: [{ kind: "validation_report", ref: "artifacts/validation-report.md", hash: HASH }],
    parent_evidence: [],
    parent_reviews: [{ kind: "review", ref: "reviews/implementation-validator.json", hash: HASH }],
  };
}

function initGitRepo(repo, branches = []) {
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "test\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "init"]);
  for (const branch of branches) runGit(repo, ["branch", branch]);
}

function runGit(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function gitOutput(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

function baseRun(runId) {
  return {
    schema_version: 1,
    run_id: runId,
    status: "running",
    gates: {},
    slices: [{ id: "slice", status: "running", attempts: 1 }],
  };
}

function heartbeat(runId) {
  return {
    schema_version: 1,
    run_id: runId,
    phase: "builder-wave",
    pid: process.pid,
    last_tick_at: "2026-07-08T11:59:00.000Z",
    interval_ms: 30000,
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function snapshotPendingSteering(fixture) {
  const run = readJson(join(fixture.runDir, "run.json"));
  const steeringDir = join(fixture.runDir, "steering");
  assert.ok(run.steering?.pending, "fixture must have pending steering metadata");
  return {
    pending: run.steering.pending,
    history: run.steering.history,
    file: readFileSync(join(fixture.runDir, run.steering.pending.ref), "utf8"),
    files: readdirSync(steeringDir).sort(),
  };
}

function assertPendingSteeringUnchanged(fixture, before) {
  const run = readJson(join(fixture.runDir, "run.json"));
  const steeringDir = join(fixture.runDir, "steering");
  const files = readdirSync(steeringDir).sort();

  assert.deepEqual(run.steering.pending, before.pending);
  assert.equal(run.steering.pending.ref, before.pending.ref);
  assert.equal(run.steering.pending.hash, before.pending.hash);
  assert.deepEqual(run.steering.history, before.history);
  assert.equal(readFileSync(join(fixture.runDir, before.pending.ref), "utf8"), before.file);
  assert.deepEqual(files, before.files);
  assert.equal(files.some((file) => file.startsWith("consumed-")), false);
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
