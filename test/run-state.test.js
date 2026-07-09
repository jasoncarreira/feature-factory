import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  heartbeatOnce,
  transitionGateDecision,
  transitionPrCreated,
  transitionRecoverOrphan,
  transitionRunJson,
  transitionRunSlice,
  transitionTerminalResult,
  transitionSliceMerged,
  withRunJsonLock,
} from "../src/run-state.js";
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

      const result = await transitionGateDecision(fixture.runDir, "story", {
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
        transitionGateDecision(fixture.runDir, "story", {
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
        transitionGateDecision(fixture.runDir, "story", {
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

      let result = await transitionGateDecision(fixture.runDir, "story", {
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
        transitionGateDecision(fixture.runDir, "story", {
          status: "approved",
          artifact: "artifacts/story.md",
          question_ref: "gates/story.question.md",
          answer_ref: "gates/story.answer",
        }),
        /missing gates ref/u,
      );

      writeFileSync(join(fixture.runDir, "gates", "story.answer"), "approve\n");
      result = await transitionGateDecision(fixture.runDir, "story", {
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

      const result = await transitionPrCreated(fixture.runDir, {
        pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/99",
        pr_number: 99,
        repository: "jasoncarreira/opencode-feature-factory",
      });

      assert.equal(result.run.status, "completed");
      assert.equal(result.run.pr_url, "https://github.com/jasoncarreira/opencode-feature-factory/pull/99");
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

  it("allows default draft PR creation for blocked-run continuations", async () => {
    const fixture = createFixture("pr-continuation-default-draft");
    try {
      writeReadyPrRun(fixture, {
        branch: "continuation-branch",
        worktree: "/tmp/continuation-worktree",
        continuation: continuationMetadata(fixture.runId),
      });

      const result = await transitionPrCreated(fixture.runDir, {
        pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/103",
        pr_number: 103,
        repository: "jasoncarreira/opencode-feature-factory",
      });

      assert.equal(result.run.status, "completed");
      assert.equal(result.run.terminal_result.draft, true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects non-draft PR creation for blocked-run continuations", async () => {
    const fixture = createFixture("pr-continuation-no-draft");
    try {
      writeReadyPrRun(fixture, {
        branch: "continuation-branch",
        worktree: "/tmp/continuation-worktree",
        continuation: continuationMetadata(fixture.runId),
      });

      await assert.rejects(
        transitionPrCreated(fixture.runDir, {
          pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/104",
          pr_number: 104,
          repository: "jasoncarreira/opencode-feature-factory",
          draft: false,
        }),
        /requires draft PR for blocked-run-continuation/u,
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
        transitionPrCreated(fixture.runDir, {
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
        transitionPrCreated(fixture.runDir, {
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
          transitionPrCreated(fixture.runDir, {
            pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/105",
            pr_number: 105,
            repository: "jasoncarreira/opencode-feature-factory",
          }),
          item.message,
        );
        let run = readJson(join(fixture.runDir, "run.json"));
        assert.equal(run.status, "running");
        assert.equal(run.pr_url, undefined);

        const blocked = await transitionTerminalResult(fixture.runDir, { status: "blocked", reason: "review gate did not pass", artifacts: {} });
        assert.equal(blocked.run.status, "blocked");
        assert.equal(blocked.run.pr_url, undefined);
        run = readJson(join(fixture.runDir, "run.json"));
        assert.equal(run.terminal_result.pr_url, undefined);
      } finally {
        cleanup(fixture.repo);
      }
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

      await transitionPrCreated(fixture.runDir, {
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
      writeJson(join(lockDir, "owner.json"), { pid: 999999, hostname: "old-host", acquired_at: NOW });

      let observedOwner = null;
      await withRunJsonLock(fixture.runDir, ({ owner }) => {
        observedOwner = owner;
      }, { timeoutMs: 5, retryDelayMs: 1, processAliveFn: () => false });

      assert.equal(observedOwner.stolen_from.pid, 999999);
      assert.equal(observedOwner.stolen_from.hostname, "old-host");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("does not steal a run-json lock from a live owner", async () => {
    const fixture = createFixture("live-lock");
    try {
      const lockDir = join(fixture.runDir, "run-json.lock");
      mkdirSync(lockDir);
      writeJson(join(lockDir, "owner.json"), { pid: process.pid, hostname: "live-host", acquired_at: new Date().toISOString() });

      await assert.rejects(
        withRunJsonLock(fixture.runDir, () => {}, { timeoutMs: 5, retryDelayMs: 1, staleLockMs: 60000, processAliveFn: () => true }),
        /timed out waiting for run\.json lock/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });
});

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
  await transitionGateDecision(fixture.runDir, gate, {
    status: "approved",
    artifact: artifactRef,
    question_ref: questionRef,
    answer_ref: answerRef,
  }, { now: NOW });
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

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
