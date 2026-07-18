import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "./helpers/git-fixture.js";
import { createPanelReviewRecord, createReviewRecord, createSliceReviewRecord } from "./helpers/review-record-fixture.js";
import { createRunRecord } from "./helpers/run-record-fixture.js";
import { publishSyntheticV2Parent } from "./helpers/v2-parent-fixture.js";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSliceReviewBindingCurrent,
  claimCheckedTestExecution,
  completeSliceBuilderTaskDispatch,
  completeCheckedTestExecution,
  heartbeatOnce,
  inspectApprovalHandoffReceipt,
  mutateRunJsonLocked,
  transitionCostUsage,
  transitionGateDecision,
  transitionPanelVerdicts,
  transitionPrePrFenceEstablished,
  transitionLifecycleRun,
  transitionPrCreated,
  transitionRecoverOrphan,
  transitionRunJson,
  transitionRunSlice,
  transitionRunStep,
  transitionSlicesSeed,
  transitionSteeringActionStarted,
  transitionSteeringBoundaryCrossed,
  transitionSteeringConsumed,
  transitionSteeringBoundaryOpened,
  transitionSteeringQueued,
  transitionTerminalResult,
  transitionSliceMerged,
  observeReviewedMergeProof,
  prepareSliceBuilderTaskDispatch,
  RunJsonLockContendedError,
  withRunJsonLock,
} from "../src/run-state.js";
import { MAX_COST_ATTRIBUTION_ENTRIES, recomputeCostAttribution } from "../src/cost-attribution.js";
import { checkRunConsistency } from "../src/validate.js";
import { hashFile } from "../src/refs.js";
import { git } from "../src/git.js";

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

  it("requires exactly one of answer_ref or inline answer on a gate decision", async () => {
    const fixture = createFixture("gate-answer-exclusivity");
    try {
      await transitionGateDecision(fixture.runDir, "story", {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      });
      writeFileSync(join(fixture.runDir, "gates", "story.answer"), "approve\n");

      const base = { status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md" };
      await assert.rejects(
        approveGateDecision(fixture.runDir, "story", { ...base, answer_ref: "gates/story.answer", answer: "approve" }, { now: NOW }),
        /requires exactly one of answer_ref or answer/u,
        "both an answer ref and an inline answer must be rejected",
      );
      await assert.rejects(
        approveGateDecision(fixture.runDir, "story", { ...base }, { now: NOW }),
        /requires exactly one of answer_ref or answer/u,
        "a decision without any answer must be rejected",
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("gates the test-verifier integration step on merged slices and bounded advancing attempts", async () => {
    const fixture = createFixture("test-verifier-gate");
    try {
      writeJson(join(fixture.runDir, "run.json"), {
        ...baseRun(fixture.runId),
        max_retries: 3,
        slices: [
          writeModernReviewedSlice(fixture.runDir, "api", { status: "merged", mergeCommit: "abc123" }),
          { id: "ui", status: "running", attempts: 1 },
        ],
      });

      await assert.rejects(
        transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 1 }),
        /test-verifier integration gate requires all slices merged: ui/u,
        "an unmerged slice must block the integration gate",
      );

      const allMerged = readJson(join(fixture.runDir, "run.json"));
      allMerged.slices[1] = writeModernReviewedSlice(fixture.runDir, "ui", { status: "merged", mergeCommit: "def456" });
      writeJson(join(fixture.runDir, "run.json"), allMerged);
      await assert.rejects(
        transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 0 }),
        /requires a positive attempt number/u,
      );
      await assert.rejects(
        transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 2 }),
        /must advance from attempt 0 to 1/u,
        "the first attempt must be exactly 1",
      );

      const started = await transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 1 });
      assert.equal(started.step.status, "running");
      await transitionRunStep(fixture.runDir, "test-verifier", { status: "rejected", attempts: 1 }, { mustExist: true });
      await assert.rejects(
        transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 3 }, { mustExist: true }),
        /must advance from attempt 1 to 2/u,
        "attempts advance one at a time",
      );

      await transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 2 }, { mustExist: true });
      await transitionRunStep(fixture.runDir, "test-verifier", { status: "rejected", attempts: 2 }, { mustExist: true });
      await transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 3 }, { mustExist: true });
      await transitionRunStep(fixture.runDir, "test-verifier", { status: "rejected", attempts: 3 }, { mustExist: true });
      await assert.rejects(
        transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 4 }, { mustExist: true }),
        /integration gate attempt 4 exceeds max_retries 3/u,
        "the bounded retry ceiling must hold",
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("persists an interactive receipt and exactly redelivers approval without a second boundary", async () => {
    const fixture = createFixture("interactive-redelivery");
    try {
      writeJson(join(fixture.runDir, "run.json"), { ...baseRun(fixture.runId), mode: "interactive" });
      await transitionGateDecision(fixture.runDir, "story", {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      });
      writeFileSync(join(fixture.runDir, "gates", "story.answer"), "approve\n");
      const decision = {
        status: "approved",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      };
      const accepted = await approveGateDecision(fixture.runDir, "story", decision, { now: NOW });
      assert.equal(inspectApprovalHandoffReceipt(fixture.runDir, accepted.run, "story").ok, true);

      const redelivered = await transitionGateDecision(fixture.runDir, "story", decision, { now: "2026-07-08T12:01:00.000Z" });
      assert.equal(redelivered.updated, false);
      assert.equal(redelivered.reason, "redelivered-approved");
      assert.equal(redelivered.run.gates.story.handoff_receipt.kind, "interactive-approval-handoff");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("re-observes inline interactive approval bytes through receipt and consistency consumers", async () => {
    const fixture = createFixture("interactive-inline-consistency");
    try {
      writeJson(join(fixture.runDir, "run.json"), { ...baseRun(fixture.runId), mode: "interactive" });
      await transitionGateDecision(fixture.runDir, "story", {
        status: "pending", artifact: "artifacts/story.md", question_ref: "gates/story.question.md",
      });
      const accepted = await approveGateDecision(fixture.runDir, "story", {
        status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer: "approve",
      }, { now: NOW });

      assert.equal(inspectApprovalHandoffReceipt(fixture.runDir, accepted.run, "story").ok, true);
      assert.equal(checkRunConsistency(fixture.runDir, accepted.run).ok, true);

      const altered = structuredClone(accepted.run);
      altered.gates.story.handoff_receipt.answer_hash = `sha256:${"0".repeat(64)}`;
      assert.equal(inspectApprovalHandoffReceipt(fixture.runDir, altered, "story").ok, false);
      assert.equal(checkRunConsistency(fixture.runDir, altered).ok, false);

      const alteredAnswer = structuredClone(accepted.run);
      alteredAnswer.gates.story.answer = "stop";
      assert.equal(inspectApprovalHandoffReceipt(fixture.runDir, alteredAnswer, "story").ok, false);
      assert.equal(checkRunConsistency(fixture.runDir, alteredAnswer).ok, false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("keeps autonomous approvals receipt-free and exactly redeliverable", async () => {
    const fixture = createFixture("autonomous-redelivery");
    try {
      writeJson(join(fixture.runDir, "run.json"), { ...baseRun(fixture.runId), mode: "autonomous" });
      await transitionGateDecision(fixture.runDir, "story", {
        status: "pending", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer_ref: "gates/story.answer",
      });
      writeFileSync(join(fixture.runDir, "gates", "story.answer"), "approve\n");
      const decision = { status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer_ref: "gates/story.answer" };
      const accepted = await approveGateDecision(fixture.runDir, "story", decision, { now: NOW });
      assert.equal(accepted.run.gates.story.handoff_receipt, undefined);
      const redelivered = await transitionGateDecision(fixture.runDir, "story", decision);
      assert.equal(redelivered.updated, false);
      assert.equal(redelivered.reason, "redelivered-approved");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects redelivery changes to source, note, explicit time, or exact inline answer bytes", async () => {
    const fixture = createFixture("interactive-redelivery-conflicts");
    try {
      writeJson(join(fixture.runDir, "run.json"), { ...baseRun(fixture.runId), mode: "interactive" });
      await transitionGateDecision(fixture.runDir, "story", {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
      });
      const acceptedDecision = {
        status: "approved",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer: "approve",
        approval_source: "human",
        decision_note: "accepted exactly",
        answered_at: NOW,
      };
      await approveGateDecision(fixture.runDir, "story", acceptedDecision, { now: NOW });
      for (const changed of [
        { ...acceptedDecision, approval_source: "override" },
        { ...acceptedDecision, decision_note: "changed" },
        { ...acceptedDecision, answered_at: "2026-07-08T12:00:01.000Z" },
        { ...acceptedDecision, answer: " approve" },
      ]) {
        await assert.rejects(
          transitionGateDecision(fixture.runDir, "story", changed),
          (error) => error?.handoffCode === "approval-snapshot-mismatch",
        );
      }
      assert.equal(readJson(join(fixture.runDir, "run.json")).gates.story.decision_note, "accepted exactly");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects redelivery after archived answer bytes or steering generation change", async () => {
    const fixture = createFixture("interactive-redelivery-durable-conflicts");
    try {
      writeJson(join(fixture.runDir, "run.json"), { ...baseRun(fixture.runId), mode: "interactive" });
      await transitionGateDecision(fixture.runDir, "story", {
        status: "pending", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer_ref: "gates/story.answer",
      });
      writeFileSync(join(fixture.runDir, "gates", "story.answer"), "approve\n");
      const decision = { status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer_ref: "gates/story.answer" };
      const accepted = await approveGateDecision(fixture.runDir, "story", decision, { now: NOW });
      writeFileSync(join(fixture.runDir, accepted.run.gates.story.answer_ref), "approve changed\n");
      await assert.rejects(transitionGateDecision(fixture.runDir, "story", decision), (error) => error?.handoffCode === "approval-snapshot-mismatch");
      writeFileSync(join(fixture.runDir, accepted.run.gates.story.answer_ref), "approve\n");
      const run = readJson(join(fixture.runDir, "run.json"));
      run.steering = { ...run.steering, generation: (run.steering?.generation || 0) + 1 };
      writeJson(join(fixture.runDir, "run.json"), run);
      await assert.rejects(transitionGateDecision(fixture.runDir, "story", decision), (error) => error?.handoffCode === "steering-generation-mismatch");
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

  it("rejects every ordinary checked transition that changes run identity", async () => {
    for (const [key, value] of [
      ["run_id", "other-run"],
      ["base_commit", "b".repeat(40)],
      ["branch", "other-branch"],
      ["worktree", "/tmp/other-worktree"],
    ]) {
      const fixture = createFixture(`identity-${key.replace("_", "-")}`);
      try {
        writeJson(join(fixture.runDir, "run.json"), { ...baseRun(fixture.runId), base_commit: "a".repeat(40), branch: fixture.runId, worktree: `/tmp/${fixture.runId}` });
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(
          transitionRunJson(fixture.runDir, (run) => { run[key] = value; }),
          new RegExp(`run identity field '${key}' is immutable`, "u"),
        );
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
      } finally {
        cleanup(fixture.repo);
      }
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

  it("restores external answer placement when run.json publication fails", async () => {
    const fixture = createFixture("gate-archive-publication-failure");
    try {
      await transitionGateDecision(fixture.runDir, "story", {
        status: "pending", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer_ref: "gates/story.answer",
      });
      writeFileSync(join(fixture.runDir, "gates", "story.answer"), "approve\n");
      const opened = await transitionSteeringBoundaryOpened(fixture.runDir, "gate");
      const runFile = join(fixture.runDir, "run.json");
      const before = readFileSync(runFile, "utf8");

      await assert.rejects(
        transitionGateDecision(fixture.runDir, "story", {
          status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer_ref: "gates/story.answer",
        }, {
          boundaryToken: opened.boundary.token,
          atomicWriteHooks: { beforeCommit() { throw new Error("injected run.json publication failure"); } },
        }),
        /publication failure|commit failed/u,
      );
      assert.equal(readFileSync(runFile, "utf8"), before);
      assert.equal(readFileSync(join(fixture.runDir, "gates", "story.answer"), "utf8"), "approve\n");
      assert.equal(existsSync(join(fixture.runDir, "gates", "story.answer.consumed-1")), false);

      const accepted = await transitionGateDecision(fixture.runDir, "story", {
        status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer_ref: "gates/story.answer",
      }, { boundaryToken: opened.boundary.token, now: NOW });
      assert.equal(accepted.run.gates.story.answer_ref, "gates/story.answer.consumed-1");
      assert.equal(existsSync(join(fixture.runDir, "gates", "story.answer")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("keeps step agent identity immutable and rejects attempt regression atomically", async () => {
    const fixture = createFixture("step-authority");
    try {
      writeJson(join(fixture.runDir, "run.json"), { ...baseRun(fixture.runId), steps: [{ agent: "spec-writer", status: "running", attempts: 2 }] });
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(
        transitionRunStep(fixture.runDir, "spec-writer", { agent: "other-agent", status: "running", attempts: 2 }),
        /agent identity is immutable/u,
      );
      await assert.rejects(
        transitionRunStep(fixture.runDir, "spec-writer", { status: "running", attempts: 1 }),
        /attempts cannot regress from 2 to 1/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("forbids generic creation of inherited acceptance", async () => {
    const fixture = createFixture("step-inherited-authority");
    try {
      writeJson(join(fixture.runDir, "run.json"), { ...baseRun(fixture.runId), steps: [{ agent: "spec-writer", status: "running", attempts: 1 }] });
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(
        transitionRunStep(fixture.runDir, "spec-writer", {
          status: "accepted",
          attempts: 1,
          artifact_ref: "artifacts/story.md",
          inherited_acceptance: { from_run_id: "parent", parent_spec_review_ref: "reviews/spec.json", artifact_hash: HASH, review_hash: HASH },
        }),
        /only be created by checked continuation adoption/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects slice merge without an APPROVE review", async () => {
    const fixture = createFixture("slice-reject");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      prepareSliceMergeState(fixture, { verdict: "REJECT" });
      writeJson(join(fixture.runDir, "reviews", "caller-approved.json"), createReviewRecord({ subject: "slice", verdict: "APPROVE", required_fixes: [] }));

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
      const merge = prepareSliceMergeState(fixture);
      writeFileSync(join(fixture.runDir, "reviews", "slice.json"), "null\n", "utf8");

      await assert.rejects(
        transitionSliceMerged(fixture.runDir, "slice", { merge_commit: merge.mergeCommit }),
        /review_ref must be a JSON object/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects slice merge with a nonexistent branch", async () => {
    const fixture = createFixture("slice-missing-branch");
    try {
      initGitRepo(fixture.repo, ["slice-branch", "caller-branch"]);
      const merge = prepareSliceMergeState(fixture);
      runGit(fixture.repo, ["worktree", "remove", "--force", merge.sliceWorktree]);
      runGit(fixture.repo, ["branch", "-D", "slice-branch"]);
      const integrationHead = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);

      await assert.rejects(
        transitionSliceMerged(fixture.runDir, "slice", { merge_commit: integrationHead, branch: "caller-branch" }),
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
      const integrationHead = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);

      const result = await transitionSliceMerged(fixture.runDir, "slice", { merge_commit: integrationHead.slice(0, 12) }, { now: NOW });

      assert.equal(result.slice.status, "merged");
      assert.equal(result.slice.merge_commit, integrationHead);
      assert.equal(result.run.updated_at, NOW);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects a nonexistent merge commit instead of persisting caller text", async () => {
    const fixture = createFixture("slice-merge-nonexistent-commit");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      prepareSliceMergeState(fixture);
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(
        transitionSliceMerged(fixture.runDir, "slice", { merge_commit: "deadbeef" }),
        /merge commit.*resolve|does not resolve/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects stale, unintegrated, and wrong integration identities for slice merge", async () => {
    const stale = createFixture("slice-merge-stale-commit");
    try {
      initGitRepo(stale.repo, ["slice-branch"]);
      const oldHead = gitOutput(stale.repo, ["rev-parse", "HEAD"]);
      writeFileSync(join(stale.repo, "README.md"), "advanced\n");
      runGit(stale.repo, ["add", "README.md"]);
      runGit(stale.repo, ["commit", "-m", "advance integration"]);
      prepareSliceMergeState(stale);
      await assert.rejects(transitionSliceMerged(stale.runDir, "slice", { merge_commit: oldHead }), /current run.branch head/u);
    } finally {
      cleanup(stale.repo);
    }

    const unintegrated = createFixture("slice-merge-wrong-second-parent");
    try {
      initGitRepo(unintegrated.repo, ["slice-branch"]);
      const valid = prepareSliceMergeState(unintegrated);
      const firstParent = gitOutput(unintegrated.repo, ["rev-parse", `${valid.mergeCommit}^1`]);
      runGit(unintegrated.repo, ["reset", "--hard", firstParent]);
      runGit(unintegrated.repo, ["checkout", "-b", "wrong-parent"]);
      writeFileSync(join(unintegrated.repo, "wrong.txt"), "wrong\n");
      runGit(unintegrated.repo, ["add", "wrong.txt"]);
      runGit(unintegrated.repo, ["commit", "-m", "wrong second parent"]);
      runGit(unintegrated.repo, ["checkout", "main"]);
      runGit(unintegrated.repo, ["merge", "--no-ff", "wrong-parent", "-m", "wrong merge"]);
      const integrationHead = gitOutput(unintegrated.repo, ["rev-parse", "HEAD"]);
      await assert.rejects(transitionSliceMerged(unintegrated.runDir, "slice", { merge_commit: integrationHead }), /second parent must equal reviewed_commit/u);
    } finally {
      cleanup(unintegrated.repo);
    }

    const wrongBranch = createFixture("slice-merge-wrong-run-branch");
    try {
      initGitRepo(wrongBranch.repo, ["slice-branch", "other-branch"]);
      writeFileSync(join(wrongBranch.repo, "README.md"), "advanced\n");
      runGit(wrongBranch.repo, ["add", "README.md"]);
      runGit(wrongBranch.repo, ["commit", "-m", "advance main"]);
      prepareSliceMergeState(wrongBranch);
      const run = readJson(join(wrongBranch.runDir, "run.json"));
      run.branch = "other-branch";
      writeJson(join(wrongBranch.runDir, "run.json"), run);
      const integrationHead = gitOutput(wrongBranch.repo, ["rev-parse", "main"]);
      await assert.rejects(transitionSliceMerged(wrongBranch.runDir, "slice", { merge_commit: integrationHead }), /current run.branch head/u);
    } finally {
      cleanup(wrongBranch.repo);
    }

    const wrongWorktree = createFixture("slice-merge-wrong-worktree-branch");
    try {
      initGitRepo(wrongWorktree.repo, ["slice-branch", "other-branch"]);
      prepareSliceMergeState(wrongWorktree);
      const integrationHead = gitOutput(wrongWorktree.repo, ["rev-parse", "main"]);
      runGit(wrongWorktree.repo, ["checkout", "other-branch"]);
      await assert.rejects(transitionSliceMerged(wrongWorktree.runDir, "slice", { merge_commit: integrationHead }), /run.worktree must be checked out on run.branch/u);
    } finally {
      cleanup(wrongWorktree.repo);
    }
  });

  it("re-observes merge Git identities immediately before replacement", async () => {
    const fixture = createFixture("slice-merge-git-race");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      prepareSliceMergeState(fixture);
      const integrationHead = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      const originalReview = readJson(join(fixture.runDir, "reviews", "slice.json"));
      const originalEvidence = readJson(join(fixture.runDir, "evidence", "slice.json"));
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      for (const [name, mutate] of [
        ["evidence", () => writeFileSync(join(fixture.runDir, "evidence", "slice.json"), `${JSON.stringify(originalEvidence)}\n`)],
        ["review", () => writeFileSync(join(fixture.runDir, "reviews", "slice.json"), `${JSON.stringify(originalReview)}\n`)],
      ]) {
        writeJson(join(fixture.runDir, "evidence", "slice.json"), originalEvidence);
        writeJson(join(fixture.runDir, "reviews", "slice.json"), originalReview);
        await assert.rejects(transitionSliceMerged(fixture.runDir, "slice", { merge_commit: integrationHead }, {
          atomicWriteHooks: { beforeCommit: mutate },
        }), /authority bytes changed|commit failed/u, name);
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, name);
      }
      writeJson(join(fixture.runDir, "evidence", "slice.json"), originalEvidence);
      writeJson(join(fixture.runDir, "reviews", "slice.json"), originalReview);
      await assert.rejects(transitionSliceMerged(fixture.runDir, "slice", { merge_commit: integrationHead }, {
        atomicWriteHooks: {
          beforeCommit() {
            writeFileSync(join(fixture.repo, "race.txt"), "race\n");
            runGit(fixture.repo, ["add", "race.txt"]);
            runGit(fixture.repo, ["commit", "-m", "race integration head"]);
          },
        },
      }), /current run.branch head|merge authority changed|commit failed/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
      runGit(fixture.repo, ["reset", "--hard", integrationHead]);
      const merged = await transitionSliceMerged(fixture.runDir, "slice", { merge_commit: integrationHead });
      assert.equal(merged.slice.merge_commit, integrationHead);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects every reviewed-merge tree divergence and accepts disjoint prior integration", async () => {
    const cases = [
      ["extra path", (repo) => writeFileSync(join(repo, "extra.txt"), "extra\n"), /path set/u],
      ["blob", (repo) => writeFileSync(join(repo, "slice.txt"), "different reviewed blob\n"), /path set|presence, mode, type, or object identity/u],
      ["mode", (repo) => chmodSync(join(repo, "slice.txt"), 0o755), /path set|presence, mode, type, or object identity/u],
      ["type", (repo) => { rmSync(join(repo, "slice.txt")); symlinkSync("target.txt", join(repo, "slice.txt")); }, /path set|presence, mode, type, or object identity/u],
      ["deletion", (repo) => rmSync(join(repo, "slice.txt")), /path set/u],
      ["rename endpoints", (repo) => renameSync(join(repo, "slice.txt"), join(repo, "renamed.txt")), /path set/u],
      ["conflict resolution", (repo) => writeFileSync(join(repo, "slice.txt"), "conflict resolution not reviewed\n"), /path set|presence, mode, type, or object identity/u],
    ];
    for (const [name, mutate, error] of cases) {
      const fixture = createFixture(`merge-divergence-${name.replaceAll(" ", "-")}`);
      try {
        initGitRepo(fixture.repo, ["slice-branch"]);
        const merge = prepareSliceMergeState(fixture);
        const tamperedMerge = rewriteMergeTree(fixture.repo, merge, mutate);
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(transitionSliceMerged(fixture.runDir, "slice", { merge_commit: tamperedMerge }), error, name);
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, name);
      } finally {
        cleanup(fixture.repo);
      }
    }

    const valid = createFixture("merge-valid-disjoint-prior");
    try {
      initGitRepo(valid.repo, ["slice-branch"]);
      const merge = prepareSliceMergeState(valid, { priorIntegration: true });
      const result = await transitionSliceMerged(valid.runDir, "slice", { merge_commit: merge.mergeCommit });
      assert.equal(result.slice.merge_commit, merge.mergeCommit);
      assert.equal(result.run.slices[0].merge_commit, merge.priorCommit);
    } finally {
      cleanup(valid.repo);
    }
  });

  it("shares canonical B0MR review/merge proof without changing merge transition semantics", async () => {
    const valid = createFixture("shared-b0mr-proof-valid");
    try {
      initGitRepo(valid.repo, ["slice-branch"]);
      const prepared = prepareSliceMergeState(valid);
      const run = JSON.parse(readFileSync(join(valid.runDir, "run.json"), "utf8"));
      const slice = run.slices.find((entry) => entry.id === "slice");
      const reviewAuthority = assertSliceReviewBindingCurrent(valid.runDir, "slice", slice);
      const proof = observeReviewedMergeProof(valid.repo, "slice", prepared.mergeCommit, prepared.reviewedCommit);
      assert.equal(reviewAuthority.review.verdict, "APPROVE");
      assert.equal(proof.second_parent, prepared.reviewedCommit);
      assert.equal(proof.first_parent, gitOutput(valid.repo, ["rev-parse", `${prepared.mergeCommit}^1`]));

      const merged = await transitionSliceMerged(valid.runDir, "slice", { merge_commit: prepared.mergeCommit });
      assert.equal(merged.slice.merge_commit, prepared.mergeCommit);
    } finally { cleanup(valid.repo); }

    const tampered = createFixture("shared-b0mr-proof-tampered");
    try {
      initGitRepo(tampered.repo, ["slice-branch"]);
      const prepared = prepareSliceMergeState(tampered);
      const tamperedMerge = rewriteMergeTree(tampered.repo, prepared, (repo) => writeFileSync(join(repo, "slice.txt"), "unreviewed\n"));
      const before = readFileSync(join(tampered.runDir, "run.json"), "utf8");
      assert.throws(() => observeReviewedMergeProof(tampered.repo, "slice", tamperedMerge, prepared.reviewedCommit), /path set|object identity/u);
      await assert.rejects(transitionSliceMerged(tampered.runDir, "slice", { merge_commit: tamperedMerge }), /path set|object identity/u);
      assert.equal(readFileSync(join(tampered.runDir, "run.json"), "utf8"), before);
    } finally { cleanup(tampered.repo); }
  });

  it("rejects a redundant reviewed parent while accepting both valid merge-base shapes", async () => {
    const redundant = createFixture("merge-redundant-reviewed-parent");
    try {
      initGitRepo(redundant.repo, ["slice-branch"]);
      const prepared = prepareSliceMergeState(redundant);
      writeFileSync(join(redundant.repo, "unreviewed.txt"), "unreviewed first-parent bytes\n");
      runGit(redundant.repo, ["add", "unreviewed.txt"]);
      runGit(redundant.repo, ["commit", "-m", "unreviewed first-parent change"]);
      const firstParent = gitOutput(redundant.repo, ["rev-parse", "HEAD"]);
      const craftedMerge = gitOutput(redundant.repo, [
        "commit-tree", `${firstParent}^{tree}`,
        "-p", firstParent,
        "-p", prepared.reviewedCommit,
        "-m", "redundant reviewed parent",
      ]);
      runGit(redundant.repo, ["update-ref", "refs/heads/main", craftedMerge]);
      runGit(redundant.repo, ["reset", "--hard", craftedMerge]);

      assert.equal(gitOutput(redundant.repo, ["merge-base", firstParent, prepared.reviewedCommit]), prepared.reviewedCommit);
      assert.equal(gitOutput(redundant.repo, ["diff", "--name-only", firstParent, craftedMerge]), "");
      assert.match(gitOutput(redundant.repo, ["ls-tree", "--name-only", craftedMerge, "--", "unreviewed.txt"]), /^unreviewed\.txt$/u);
      const before = readFileSync(join(redundant.runDir, "run.json"), "utf8");
      await assert.rejects(
        transitionSliceMerged(redundant.runDir, "slice", { merge_commit: craftedMerge }),
        (error) => error.message === "slice 'slice' reviewed_commit must not be an ancestor of the merge first parent",
      );
      assert.equal(readFileSync(join(redundant.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(redundant.repo);
    }

    for (const [name, priorIntegration, expectedBase] of [
      ["first-parent-base", false, "first-parent"],
      ["diverged-base", true, "neither-parent"],
    ]) {
      const valid = createFixture(`merge-valid-${name}`);
      try {
        initGitRepo(valid.repo, ["slice-branch"]);
        const prepared = prepareSliceMergeState(valid, { priorIntegration });
        const firstParent = gitOutput(valid.repo, ["rev-parse", `${prepared.mergeCommit}^1`]);
        const mergeBase = gitOutput(valid.repo, ["merge-base", firstParent, prepared.reviewedCommit]);
        assert.notEqual(mergeBase, prepared.reviewedCommit, name);
        if (expectedBase === "first-parent") assert.equal(mergeBase, firstParent, name);
        else assert.notEqual(mergeBase, firstParent, name);
        const result = await transitionSliceMerged(valid.runDir, "slice", { merge_commit: prepared.mergeCommit });
        assert.equal(result.slice.merge_commit, prepared.mergeCommit, name);
      } finally {
        cleanup(valid.repo);
      }
    }
  });

  it("treats every magic-leading reviewed filename as a literal tree path", async () => {
    for (const [index, reviewedPath] of [":(literal)payload", ":(glob)payload*"].entries()) {
      const fixture = createFixture(`merge-literal-path-${index}`);
      try {
        initGitRepo(fixture.repo, ["slice-branch"]);
        const merge = prepareSliceMergeState(fixture, { reviewedPath });
        const tamperedMerge = rewriteMergeTree(fixture.repo, merge, (repo) => writeFileSync(join(repo, reviewedPath), "different unreviewed blob\n"));
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(
          transitionSliceMerged(fixture.runDir, "slice", { merge_commit: tamperedMerge }),
          /presence, mode, type, or object identity/u,
          reviewedPath,
        );
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, reviewedPath);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("rejects reviewed-head append and zero or multiple full merge bases", async () => {
    const appended = createFixture("merge-reviewed-head-appended");
    try {
      initGitRepo(appended.repo, ["slice-branch"]);
      const merge = prepareSliceMergeState(appended);
      writeFileSync(join(merge.sliceWorktree, "appended.txt"), "after review\n");
      runGit(merge.sliceWorktree, ["add", "appended.txt"]);
      runGit(merge.sliceWorktree, ["commit", "-m", "append after review"]);
      await assert.rejects(transitionSliceMerged(appended.runDir, "slice", { merge_commit: merge.mergeCommit }), /differs from reviewed_commit/u);
    } finally {
      cleanup(appended.repo);
    }

    for (const [name, bases, expected] of [
      ["zero", "", /requires exactly one full merge base/u],
      ["multiple", `${"a".repeat(40)}\n${"b".repeat(40)}\n`, /requires exactly one full merge base/u],
      ["wrong", `${"0".repeat(40)}\n`, /merge base must be an ancestor of both parents/u],
    ]) {
      const fixture = createFixture(`merge-${name}-bases`);
      try {
        initGitRepo(fixture.repo, ["slice-branch"]);
        const merge = prepareSliceMergeState(fixture);
        const gitFn = (cwd, args) => args[0] === "merge-base" && args[1] === "--all"
          ? { ok: true, status: 0, stdout: bases, stderr: "" }
          : observedGit(cwd, args);
        await assert.rejects(
          transitionSliceMerged(fixture.runDir, "slice", { merge_commit: merge.mergeCommit }, { gitFn }),
          expected,
          name,
        );
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("rejects in-review and merged rows missing modern bindings or attempt history without mutation", async () => {
    for (const missing of ["bindings", "history"]) {
      const fixture = createFixture(`incomplete-review-${missing}`);
      try {
        initGitRepo(fixture.repo, ["slice-branch"]);
        prepareSliceMergeState(fixture);
        const run = readJson(join(fixture.runDir, "run.json"));
        if (missing === "bindings") for (const key of ["evidence_hash", "review_hash", "reviewed_commit"]) delete run.slices[0][key];
        else delete run.slices[0].attempt_reviews;
        writeJson(join(fixture.runDir, "run.json"), run);
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(
          transitionRunSlice(fixture.runDir, "slice", { status: "review", attempts: 1, evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json" }),
          /complete evidence_hash|attempt_reviews|append-only attempt history/u,
          missing,
        );
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
      } finally {
        cleanup(fixture.repo);
      }
    }

    const merged = createFixture("incomplete-merged-history");
    try {
      initGitRepo(merged.repo, ["slice-branch"]);
      const merge = prepareSliceMergeState(merged);
      await transitionSliceMerged(merged.runDir, "slice", { merge_commit: merge.mergeCommit });
      const run = readJson(join(merged.runDir, "run.json"));
      delete run.slices[0].attempt_reviews;
      writeJson(join(merged.runDir, "run.json"), run);
      const before = readFileSync(join(merged.runDir, "run.json"), "utf8");
      await assert.rejects(transitionSliceMerged(merged.runDir, "slice", { merge_commit: merge.mergeCommit }), /attempt_reviews|append-only attempt history/u);
      assert.equal(readFileSync(join(merged.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(merged.repo);
    }
  });

  it("records PR creation from transition-time preconditions only", async () => {
    const fixture = createFixture("pr-created");
    try {
      writeReadyPrRun(fixture);

      const result = await createPrTransition(fixture.runDir, {
        pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/99",
        pr_number: 99,
        repository: "jasoncarreira/opencode-feature-factory",
      });

      assert.equal(result.run.status, "completed");
      assert.equal(result.run.pr_url, "https://github.com/jasoncarreira/opencode-feature-factory/pull/99");
      assert.equal(result.run.terminal_result.draft, false);
      assert.equal(result.run.terminal_result.summary, "PR created.");
      assert.deepEqual(Object.keys(result.run.terminal_result), ["status", "run_id", "pr_url", "pr_number", "pr_node_id", "repository", "operation_id", "head_ref", "head_sha", "base_ref", "base_sha", "draft", "reason", "summary", "artifacts"]);
      assert.deepEqual(
        { pr_url: result.run.terminal_result.pr_url, repository: result.run.terminal_result.repository, pr_number: result.run.terminal_result.pr_number },
        { pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/99", repository: "jasoncarreira/opencode-feature-factory", pr_number: 99 },
      );
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

  it("generic run.json writers reject incomplete schema-v2 continuation injection without mutation", async () => {
    const fixture = createFixture("generic-writer-v2-continuation");
    try {
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(
        transitionRunJson(fixture.runDir, (run) => {
          const continuation = continuationMetadata(run.run_id);
          continuation.schema_version = 2;
          continuation.carry_forward = {
            scope: "full-remaining-plan", plan_ref: "plan/slices.json", plan_hash: HASH,
            start_commit: continuation.parent.commit, accepted_slices: [], remaining_slice_ids: ["slice"],
          };
          run.continuation = continuation;
        }),
        /requires planning_reuse|closed mode\/pr configuration/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally { cleanup(fixture.repo); }
  });

  it("allows default ready PR creation for blocked-run continuations", async () => {
    const fixture = createFixture("pr-continuation-default-ready");
    try {
      writeReadyPrRun(fixture, {
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

  it("reproduces mutable schema-v2 planning and publication configuration through ordinary writers", async () => {
    const fixture = createFixture("v2-immutable-publication");
    try {
      const branch = `${fixture.runId}-branch`;
      initGitRepo(fixture.repo, [branch]);
      runGit(fixture.repo, ["checkout", branch]);
      const run = makeSyntheticV2Run(fixture.runDir, { ...baseRun(fixture.runId), branch, worktree: fixture.repo }, { remaining: ["slice"] });
      writeJson(join(fixture.runDir, "run.json"), run);
      for (const [label, mutate] of [
        ["continuation", (draft) => { draft.continuation.operator_summary = "changed"; }],
        ["mode", (draft) => { draft.mode = "autonomous"; }],
        ["github_account", (draft) => { draft.github_account = "other"; }],
        ["pr_mode", (draft) => { draft.pr_mode = "draft"; }],
        ["max_parallel_slices", (draft) => { draft.max_parallel_slices = 2; }],
        ["max_retries", (draft) => { draft.max_retries = 2; }],
        ["post_pr.policy", (draft) => { draft.post_pr.policy.enabled = true; draft.post_pr.phase = "awaiting-pr"; }],
      ]) {
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(transitionRunJson(fixture.runDir, mutate), new RegExp(`schema-v2.*${label.replace(".", "\\.")}.*immutable|immutable.*${label.replace(".", "\\.")}`, "u"), label);
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, label);
      }

      const beforeSpec = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(transitionRunStep(fixture.runDir, "spec-writer", { status: "running", attempts: 1 }, { mustExist: true }), /schema-v2.*spec-writer.*immutable/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeSpec);

      const beforeDecomposition = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(transitionRunStep(fixture.runDir, "work-decomposer", { status: "accepted", attempts: 2 }, { mustExist: true }), /schema-v2.*work-decomposer.*immutable/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeDecomposition);

      const progressed = await transitionRunSlice(fixture.runDir, "slice", (slice) => {
        slice.status = "running"; slice.attempts = 1; slice.branch = "child--slice"; slice.worktree = ".opencode/worktrees/child--slice";
      });
      assert.equal(progressed.slice.status, "running");
    } finally { cleanup(fixture.repo); }
  });

  it("rejects every later schema-v2 mutation after the parent branch moves", async () => {
    const fixture = createFixture("v2-parent-branch-drift");
    try {
      const branch = `${fixture.runId}-branch`;
      initGitRepo(fixture.repo, [branch]);
      runGit(fixture.repo, ["checkout", branch]);
      const run = makeSyntheticV2Run(fixture.runDir, { ...baseRun(fixture.runId), branch, worktree: fixture.repo }, { remaining: ["slice"] });
      writeJson(join(fixture.runDir, "run.json"), run);
      writeFileSync(join(fixture.repo, "parent-moved.txt"), "moved\n");
      runGit(fixture.repo, ["add", "parent-moved.txt"]);
      runGit(fixture.repo, ["commit", "-m", "move parent authority"]);
      runGit(fixture.repo, ["branch", "-f", run.continuation.parent.branch, "HEAD"]);
      const before = readFileSync(join(fixture.runDir, "run.json"));

      await assert.rejects(
        transitionRunJson(fixture.runDir, (draft) => { draft.review_tier = "strict"; }),
        /parent branch no longer matches continuation parent commit/u,
      );
      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("reproduces v2 downstream sink bypasses without all-merged fresh test authority", async () => {
    const panel = createFixture("v2-panel-bypass");
    try {
      initGitRepo(panel.repo, ["feature"]); runGit(panel.repo, ["checkout", "feature"]);
      const head = gitOutput(panel.repo, ["rev-parse", "HEAD"]);
      mkdirSync(join(panel.runDir, "reviews"), { recursive: true });
      writeFileSync(join(panel.runDir, "artifacts", "validation-report.md"), "GO\n");
      writeJson(join(panel.runDir, "reviews", "implementation-validator.json"), createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: head, verdict: "GO" }));
      writeJson(join(panel.runDir, "reviews", "security-reviewer.json"), createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: head, verdict: "PASS" }));
      writeJson(join(panel.runDir, "run.json"), makeSyntheticV2Run(panel.runDir, { ...baseRun(panel.runId), branch: "feature", worktree: panel.repo }, { remaining: ["slice"] }));
      const before = readFileSync(join(panel.runDir, "run.json"), "utf8");
      await assert.rejects(transitionPanelVerdicts(panel.runDir, {
        validator: { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" },
        security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" },
      }, { repoRoot: panel.repo }), /schema-v2 downstream authority requires all child slices merged.*slice/u);
      assert.equal(readFileSync(join(panel.runDir, "run.json"), "utf8"), before);
    } finally { cleanup(panel.repo); }

    const pending = createFixture("v2-pre-pr-create-bypass");
    try {
      initGitRepo(pending.repo);
      writeJson(join(pending.runDir, "run.json"), makeSyntheticV2Run(pending.runDir, baseRun(pending.runId), { remaining: ["slice"] }));
      writeFileSync(join(pending.runDir, "gates", "pre_pr.question.md"), "approve?\n");
      const before = readFileSync(join(pending.runDir, "run.json"), "utf8");
      await assert.rejects(transitionGateDecision(pending.runDir, "pre_pr", { status: "pending", artifact: "artifacts/story.md", question_ref: "gates/pre_pr.question.md" }), /schema-v2 downstream authority requires all child slices merged.*slice/u);
      assert.equal(readFileSync(join(pending.runDir, "run.json"), "utf8"), before);
    } finally { cleanup(pending.repo); }

    const approval = createFixture("v2-pre-pr-approve-bypass");
    try {
      initGitRepo(approval.repo, ["approval-feature"]);
      runGit(approval.repo, ["checkout", "approval-feature"]);
      writeFileSync(join(approval.runDir, "gates", "pre_pr.question.md"), "approve?\n");
      await transitionGateDecision(approval.runDir, "pre_pr", { status: "pending", artifact: "artifacts/story.md", question_ref: "gates/pre_pr.question.md" });
      const run = makeSyntheticV2Run(approval.runDir, { ...readJson(join(approval.runDir, "run.json")), branch: "approval-feature", worktree: approval.repo }, { remaining: ["slice"] });
      writeJson(join(approval.runDir, "run.json"), run);
      const opened = await transitionSteeringBoundaryOpened(approval.runDir, "gate");
      const before = readFileSync(join(approval.runDir, "run.json"), "utf8");
      await assert.rejects(transitionGateDecision(approval.runDir, "pre_pr", { status: "approved", artifact: "artifacts/story.md", question_ref: "gates/pre_pr.question.md", answer: "approve" }, { boundaryToken: opened.boundary.token }), /schema-v2 downstream authority requires all child slices merged.*slice/u);
      assert.equal(readFileSync(join(approval.runDir, "run.json"), "utf8"), before);
    } finally { cleanup(approval.repo); }

    const fence = createFixture("v2-fence-bypass");
    try {
      writeReadyPrRun(fence, { slices: [{ id: "slice", status: "blocked", attempts: 1, blocked_reason: "blocked" }] });
      const run = makeSyntheticV2Run(fence.runDir, readJson(join(fence.runDir, "run.json")), { remaining: ["slice"] });
      writeJson(join(fence.runDir, "run.json"), run);
      const prepared = preparePrTestOptions(fence.runDir, {});
      const before = readFileSync(join(fence.runDir, "run.json"), "utf8");
      await assert.rejects(transitionPrePrFenceEstablished(fence.runDir, prepared), /schema-v2 downstream authority requires all child slices merged.*slice/u);
      assert.equal(readFileSync(join(fence.runDir, "run.json"), "utf8"), before);
    } finally { cleanup(fence.repo); }

    const pr = createFixture("v2-pr-bypass");
    try {
      writeReadyPrRun(pr);
      const prepared = preparePrTestOptions(pr.runDir, {});
      const fenced = await transitionPrePrFenceEstablished(pr.runDir, prepared);
      const run = makeSyntheticV2Run(pr.runDir, readJson(join(pr.runDir, "run.json")), { remaining: ["slice"] });
      writeJson(join(pr.runDir, "run.json"), run);
      const before = readFileSync(join(pr.runDir, "run.json"), "utf8");
      await assert.rejects(transitionPrCreated(pr.runDir, {}, { ...prepared, fenceToken: fenced.fence.token }), /schema-v2 downstream authority requires fresh accepted test-verifier authority/u);
      assert.equal(readFileSync(join(pr.runDir, "run.json"), "utf8"), before);
    } finally { cleanup(pr.repo); }
  });

  it("admits v2 panels, pre-PR approval, fence, and PR only through fresh child test authority", async () => {
    const fixture = createFixture("v2-fresh-downstream-authority");
    try {
      writeReadyPrRun(fixture);
      const run = makeSyntheticV2Run(fixture.runDir, readJson(join(fixture.runDir, "run.json")), { remaining: ["slice"] });
      run.gates = {};
      run.validator = null;
      run.security_review = null;
      run.steps.push({ agent: "test-verifier", status: "blocked", attempts: 0 });
      writeJson(join(fixture.runDir, "run.json"), run);
      const head = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      writeFileSync(join(fixture.runDir, "artifacts", "test-report.md"), "all tests pass\n");
      const evidenceRef = "evidence/test-verifier.attempt-1.json";
      const reviewRef = "reviews/test-verifier.attempt-1.json";
      const review = { subject: "test-verifier", attempt: 1, verdict: "APPROVE", reviewed_head_sha: head, required_fixes: [] };
      writeJson(join(fixture.runDir, reviewRef), review);

      const beforeDirect = readFileSync(join(fixture.runDir, "run.json"));
      await assert.rejects(transitionRunStep(fixture.runDir, "test-verifier", {
        status: "accepted", attempts: 1, artifact_ref: "artifacts/test-report.md", evidence_ref: evidenceRef, review_ref: reviewRef,
      }, { mustExist: true }), /must transition from running|running.*same attempt/u);
      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), beforeDirect);

      const started = await transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 1 }, { mustExist: true });
      assert.deepEqual(started.step, { agent: "test-verifier", status: "running", attempts: 1 });
      const claimed = await claimCheckedTestExecution(fixture.runDir, { now: NOW, nonce: "123e4567-e89b-42d3-a456-426614174000" });
      const emptyStream = { captured_bytes: 0, sha256: `sha256:${createHash("sha256").digest("hex")}`, truncated: false };
      const receipt = {
        schema_version: 1, kind: "checked-test-execution-receipt", subject: "test-verifier", run_id: fixture.runId, attempt: 1,
        claim_nonce: claimed.claim.nonce, plan_ref: claimed.claim.plan_ref, plan_hash: claimed.claim.plan_hash, head_sha: head,
        started_at: NOW, completed_at: NOW, duration_ms: 0, status: "pass", review_ready: true,
        commands: claimed.authority.commands.map((command, index) => ({ index, ...command, outcome: "exited", status: "pass", exit_code: 0, signal: null, error_code: null, duration_ms: 0, stdout: emptyStream, stderr: emptyStream })),
      };
      await completeCheckedTestExecution(fixture.runDir, claimed.claim, claimed.authority, receipt, { now: NOW });
      for (const [label, mutate, expected] of [
        ["review_ready", (value) => { delete value.review_ready; }, /review_ready|receipt/u],
        ["commands omitted", (value) => { value.commands = []; }, /commands|receipt/u],
        ["command substituted", (value) => { value.commands[0].args = ["--test", "test/other.test.js"]; }, /commands|receipt/u],
        ["evidence head", (value) => { value.head_sha = "b".repeat(40); }, /head_sha|receipt/u],
      ]) {
        const invalid = structuredClone(receipt);
        mutate(invalid);
        writeJson(join(fixture.runDir, evidenceRef), invalid);
        const before = readFileSync(join(fixture.runDir, "run.json"));
        await assert.rejects(transitionRunStep(fixture.runDir, "test-verifier", {
          status: "accepted", attempts: 1, artifact_ref: "artifacts/test-report.md", evidence_ref: evidenceRef, review_ref: reviewRef,
        }, { mustExist: true }), expected, label);
        assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), before, label);
      }
      writeJson(join(fixture.runDir, evidenceRef), receipt);
      for (const [label, invalidReview, expected] of [
        ["review subject", { ...review, subject: "other" }, /review must bind subject, attempt, and APPROVE/u],
        ["review attempt", { ...review, attempt: 2 }, /review must bind subject, attempt, and APPROVE/u],
        ["review head", { ...review, reviewed_head_sha: "b".repeat(40) }, /reviewed_head_sha.*current clean child/u],
      ]) {
        writeJson(join(fixture.runDir, reviewRef), invalidReview);
        await assert.rejects(transitionRunStep(fixture.runDir, "test-verifier", {
          status: "accepted", attempts: 1, artifact_ref: "artifacts/test-report.md", evidence_ref: evidenceRef, review_ref: reviewRef,
        }, { mustExist: true }), expected, label);
      }
      writeJson(join(fixture.runDir, reviewRef), review);
      const accepted = await transitionRunStep(fixture.runDir, "test-verifier", {
        status: "accepted", attempts: 1, artifact_ref: "artifacts/test-report.md",
        evidence_ref: evidenceRef, review_ref: reviewRef,
      }, { mustExist: true });
      assert.deepEqual(accepted.step.acceptance, {
        artifact_ref: "artifacts/test-report.md", artifact_hash: hashFile(join(fixture.runDir, "artifacts", "test-report.md")),
        evidence_ref: evidenceRef, evidence_hash: hashFile(join(fixture.runDir, evidenceRef)),
        review_ref: reviewRef, review_hash: hashFile(join(fixture.runDir, reviewRef)), reviewed_head_sha: head,
      });

      const panelInput = {
        validator: { verdict: "GO", report: "artifacts/story.md", review_ref: "reviews/implementation-validator.json" },
        security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" },
      };
      const acceptedRunBytes = readFileSync(join(fixture.runDir, "run.json"));
      writeJson(join(fixture.runDir, evidenceRef), { ...receipt, commands: receipt.commands.map((command, index) => index === 0 ? { ...command, status: "fail", exit_code: 1 } : command), status: "fail", review_ready: false });
      await assert.rejects(transitionPanelVerdicts(fixture.runDir, panelInput, { repoRoot: fixture.repo }), /receipt|acceptance bytes or head are stale/u);
      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), acceptedRunBytes);
      writeJson(join(fixture.runDir, evidenceRef), receipt);

      runGit(fixture.repo, ["commit", "--allow-empty", "-m", "integration moved after test acceptance"]);
      await assert.rejects(transitionPanelVerdicts(fixture.runDir, panelInput, { repoRoot: fixture.repo }), /receipt|current authority|acceptance bytes or head are stale/u);
      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), acceptedRunBytes);
      runGit(fixture.repo, ["reset", "--hard", head]);

      const beforeRace = readFileSync(join(fixture.runDir, "run.json"));
      await assert.rejects(transitionPanelVerdicts(fixture.runDir, panelInput, {
        repoRoot: fixture.repo,
        atomicWriteHooks: { beforeCommit: () => writeFileSync(join(fixture.runDir, "artifacts", "test-report.md"), "raced test result\n") },
      }), (error) => error?.message === "protected file commit failed" && error?.cause?.message === "schema-v2 test-verifier acceptance bytes or head are stale");
      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), beforeRace);
      writeFileSync(join(fixture.runDir, "artifacts", "test-report.md"), "all tests pass\n");

      const panels = await transitionPanelVerdicts(fixture.runDir, panelInput, { repoRoot: fixture.repo });
      assert.equal(panels.run.validator.verdict, "GO");
      assert.equal(panels.run.security_review.verdict, "PASS");

      await transitionGateDecision(fixture.runDir, "pre_pr", { status: "pending", artifact: "artifacts/story.md", question_ref: "gates/story.question.md" });
      const approved = await approveGateDecision(fixture.runDir, "pre_pr", { status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer: "approve" });
      assert.equal(approved.run.gates.pre_pr.status, "approved");
      const prepared = preparePrTestOptions(fixture.runDir, {});
      const fenced = await transitionPrePrFenceEstablished(fixture.runDir, prepared);
      assert.equal(fenced.fence.head_sha, gitOutput(fixture.repo, ["rev-parse", "HEAD"]));
      const created = await transitionPrCreated(fixture.runDir, {}, { ...prepared, fenceToken: fenced.fence.token });
      assert.equal(created.status, "completed");
      assert.equal(created.pr_url, "https://github.com/jasoncarreira/opencode-feature-factory/pull/99");
    } finally { cleanup(fixture.repo); }
  });

  it("allows explicit draft PR creation for blocked-run continuations", async () => {
    const fixture = createFixture("pr-continuation-draft");
    try {
      writeReadyPrRun(fixture, {
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

  it("allows explicit draft PR recording for ordinary runs with the draft summary", async () => {
    const fixture = createFixture("pr-ordinary-draft");
    try {
      writeReadyPrRun(fixture);

      const result = await createPrTransition(fixture.runDir, {
        pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/105",
        pr_number: 105,
        repository: "jasoncarreira/opencode-feature-factory",
        draft: true,
      });

      assert.equal(result.run.status, "completed");
      assert.equal(result.run.terminal_result.draft, true);
      assert.equal(result.run.terminal_result.summary, "Draft PR created.");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects PR creation without an approved pre_pr gate and mutates nothing", async () => {
    const fixture = createFixture("pr-gate-missing");
    try {
      writeReadyPrRun(fixture, { gates: {} });
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");

      await assert.rejects(
        createPrTransition(fixture.runDir, {
          pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/106",
          pr_number: 106,
          repository: "jasoncarreira/opencode-feature-factory",
        }),
        /pr-created requires approved pre_pr gate/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, "a rejected pr-created must not mutate run state");
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
        /repository does not match the fenced operation/u,
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
        review: createReviewRecord({ subject: "feature-branch", verdict: "NO-GO", required_fixes: [] }),
        message: /validator verdict GO or GO-WITH-NITS/u,
      },
      {
        runId: "pr-security-block",
        overrides: { security_review: { verdict: "BLOCK", review_ref: "reviews/security-reviewer.json" } },
        review: createReviewRecord({ subject: "feature-branch", verdict: "BLOCK", required_fixes: [] }),
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
      const sliceWorktree = join(fixture.repo, ".opencode", "worktrees", "remediation-slice");
      mkdirSync(join(fixture.repo, ".opencode", "worktrees"), { recursive: true });
      runGit(fixture.repo, ["worktree", "add", sliceWorktree, "slice-branch"]);
      runGit(fixture.repo, ["checkout", "-b", "feature-run"]);
      const run = readJson(join(fixture.runDir, "run.json"));
      run.branch = "feature-run";
      run.worktree = fixture.repo;
      run.base_ref = "main";
      run.base_commit = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      run.pr_mode = "ready";
      writeJson(join(fixture.runDir, "run.json"), run);
      seedBuilderDispatchAuthority(fixture);
      await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 1, branch: "slice-branch", worktree: sliceWorktree });
      await approveGate(fixture, "story", "story.md");
      assertConsistent(fixture);
      await approveGate(fixture, "brief", "brief.md");
      assertConsistent(fixture);

      let attemptOneHead;
      await closeBuilderDispatch(fixture, 1, () => {
        writeFileSync(join(sliceWorktree, "feature.txt"), "attempt 1\n");
        runGit(sliceWorktree, ["add", "feature.txt"]);
        runGit(sliceWorktree, ["commit", "-m", "slice attempt 1"]);
        attemptOneHead = gitOutput(sliceWorktree, ["rev-parse", "HEAD"]);
      });

      mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
      mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
      writeJson(join(fixture.runDir, "evidence", "slice.attempt-1.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: attemptOneHead });
      writeJson(join(fixture.runDir, "reviews", "slice.attempt-1.json"), createV2SliceReviewRecord({ subject: "slice", attempt: 1, reviewedCommit: attemptOneHead, verdict: "REJECT", requiredFixes: ["adjust implementation"] }));
      await transitionRunSlice(fixture.runDir, "slice", {
        status: "review",
        attempts: 1,
        branch: "slice-branch",
        worktree: sliceWorktree,
        evidence_ref: "evidence/slice.attempt-1.json",
        review_ref: "reviews/slice.attempt-1.json",
      });
      assertConsistent(fixture);

      await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 2 });
      let attemptTwoHead;
      await closeBuilderDispatch(fixture, 2, () => {
        writeFileSync(join(sliceWorktree, "feature.txt"), "attempt 2\n");
        runGit(sliceWorktree, ["add", "feature.txt"]);
        runGit(sliceWorktree, ["commit", "-m", "slice attempt 2"]);
        attemptTwoHead = gitOutput(sliceWorktree, ["rev-parse", "HEAD"]);
      });
      assert.notEqual(attemptTwoHead, attemptOneHead);

      writeJson(join(fixture.runDir, "evidence", "slice.attempt-2.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 2, head_sha: attemptTwoHead, previous_head: attemptOneHead });
      writeJson(join(fixture.runDir, "reviews", "slice.attempt-2.json"), createV2SliceReviewRecord({ subject: "slice", attempt: 2, reviewedCommit: attemptTwoHead }));
      await transitionRunSlice(fixture.runDir, "slice", {
        status: "review",
        attempts: 2,
        branch: "slice-branch",
        evidence_ref: "evidence/slice.attempt-2.json",
        review_ref: "reviews/slice.attempt-2.json",
      });
      assertConsistent(fixture);

      runGit(fixture.repo, ["merge", "--no-ff", "slice-branch", "-m", "merge remediated slice"]);
      const integrationHead = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      await transitionSliceMerged(fixture.runDir, "slice", { merge_commit: integrationHead });
      assertConsistent(fixture);

      writeFileSync(join(fixture.runDir, "artifacts", "validation-report.md"), "GO\n");
      writeJson(join(fixture.runDir, "reviews", "implementation-validator.json"), createPanelReviewRecord({ subject: "feature-run", attempt: 1, reviewedHeadSha: integrationHead, verdict: "GO" }));
      writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), createPanelReviewRecord({ subject: "feature-run", attempt: 1, reviewedHeadSha: integrationHead, verdict: "PASS" }));
      await transitionPanelVerdicts(fixture.runDir, {
        validator: { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" },
        security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" },
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

  it("guards all B0M.3 authority from generic mutation while permitting exact no-ops and metadata", async () => {
    const protectedMutations = [
      ["slices", (run) => { run.slices[0].attempts = 2; }, /checked slice transitions/u],
      ["validator", (run) => { run.validator = { verdict: "GO", report: "artifacts/story.md", review_ref: "reviews/implementation-validator.json" }; }, /checked panel verdict transition/u],
      ["security", (run) => { run.security_review = { verdict: "PASS", review_ref: "reviews/security-reviewer.json" }; }, /checked panel verdict transition/u],
      ["boundary", (run) => { run.steering.boundary.token = "changed-token"; }, /checked steering transitions/u],
      ["action claim", (run) => { run.steering.action_claim.token = "changed-token"; }, /acknowledgement is pending|checked steering transitions/u],
      ["last action", (run) => { run.steering.last_action.token = "changed-token"; }, /checked steering transitions/u],
      ["pr_url", (run) => { run.pr_url = "https://github.com/acme/repo/pull/7"; }, /transitionPrCreated/u],
      ["completed", (run) => { run.status = "completed"; run.pr_url = "https://github.com/acme/repo/pull/7"; run.terminal_result = { status: "completed", run_id: run.run_id, pr_url: run.pr_url }; }, /transitionPrCreated|completed terminal transitions/u],
    ];
    for (const [label, mutate, error] of protectedMutations) {
      const fixture = createFixture(`generic-${label.replaceAll(" ", "-")}`);
      try {
        const run = readJson(join(fixture.runDir, "run.json"));
        run.steering = {
          schema_version: 1, generation: 1, pending: null, uncheckpointed: null,
          boundary: { kind: "dispatch", token: "dispatch-token", generation: 1, state_hash: HASH, created_at: NOW },
          action_claim: null, last_action: null, pr_fence: null, history: [],
        };
        if (label === "action claim") {
          run.steering.boundary = null;
          run.steering.action_claim = { kind: "dispatch", token: "dispatch-token", generation: 1, claimed_at: NOW };
        }
        if (label === "last action") {
          run.steering.boundary = null;
          run.steering.last_action = { kind: "dispatch", token: "dispatch-token", generation: 1, outcome: "started", claimed_at: NOW, resolved_at: NOW };
        }
        writeJson(join(fixture.runDir, "run.json"), run);
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(transitionRunJson(fixture.runDir, mutate), error, label);
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, label);
      } finally {
        cleanup(fixture.repo);
      }
    }

    const fixture = createFixture("generic-noop-metadata");
    try {
      const noOp = await transitionRunJson(fixture.runDir, (run) => { run.slices = structuredClone(run.slices); });
      assert.equal(noOp.updated, false);
      const metadata = await transitionRunJson(fixture.runDir, (run) => { run.updated_at = NOW; });
      assert.equal(metadata.run.updated_at, NOW);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("seeds only canonical pending slices and permanently fences reseed after start", async () => {
    const fixture = createFixture("checked-slice-seed");
    const projection = [{ id: "backend", stack: "backend", depends_on: [], status: "pending", attempts: 0 }];
    try {
      writeJson(join(fixture.runDir, "run.json"), { ...baseRun(fixture.runId), slices: [] });
      writeSeedPlan(fixture.runDir, projection);
      const seeded = await transitionSlicesSeed(fixture.runDir, projection, { from: "plan/slices.json" });
      assert.deepEqual(seeded.run.slices, projection);
      const bytes = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      const replay = await transitionSlicesSeed(fixture.runDir, projection, { from: "plan/slices.json" });
      assert.equal(replay.updated, false);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), bytes);
      const replacement = [{ id: "backend-next", stack: "backend", depends_on: [], status: "pending", attempts: 0 }];
      writeSeedPlan(fixture.runDir, replacement);
      const reseeded = await transitionSlicesSeed(fixture.runDir, replacement, { from: "plan/slices.json" });
      assert.deepEqual(reseeded.run.slices, replacement);
      await transitionRunSlice(fixture.runDir, "backend-next", { status: "running", attempts: 1 });
      const started = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(transitionSlicesSeed(fixture.runDir, replacement, { from: "plan/slices.json", force: true }), /after work has started/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), started);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("requires the exact run-relative plan source instead of projection-only seed authority", async () => {
    const fixture = createFixture("checked-slice-seed-source-required");
    const projection = [{ id: "backend", stack: "backend", depends_on: [], status: "pending", attempts: 0 }];
    try {
      writeJson(join(fixture.runDir, "run.json"), { ...baseRun(fixture.runId), slices: [] });
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(
        transitionSlicesSeed(fixture.runDir, projection),
        /exact run-relative plan source 'plan\/slices\.json' is required/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
      writeSeedPlan(fixture.runDir, projection);
      for (const [label, options, error] of [
        ["alternate", { from: "plan/alternate.json" }, /exact run-relative plan source/u],
        ["absolute", { from: join(fixture.runDir, "plan", "slices.json") }, /exact run-relative plan source/u],
        ["wrong repo", { from: "plan/slices.json", repoRoot: join(fixture.repo, "other-repo") }, /repoRoot does not own/u],
      ]) {
        await assert.rejects(transitionSlicesSeed(fixture.runDir, projection, options), error, label);
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, label);
      }
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("binds exact plan and review bytes when accepting work-decomposer", async () => {
    const fixture = createFixture("work-decomposer-plan-acceptance");
    const plan = {
      integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
      slices: [{ id: "backend", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["AC1"], test_plan: ["node --test"] }],
    };
    try {
      mkdirSync(join(fixture.runDir, "plan"), { recursive: true });
      mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
      writeJson(join(fixture.runDir, "plan", "slices.json"), plan);
      writeJson(join(fixture.runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", verdict: "APPROVE" });
      writeJson(join(fixture.runDir, "run.json"), {
        ...baseRun(fixture.runId),
        slices: [{ id: "backend", stack: "backend", depends_on: [], status: "pending", attempts: 0 }],
        steps: [{ agent: "work-decomposer", status: "running", attempts: 1 }],
      });

      const accepted = await transitionRunStep(fixture.runDir, "work-decomposer", {
        status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
      }, { mustExist: true });
      assert.deepEqual(accepted.step.acceptance, {
        artifact_ref: "plan/slices.json",
        artifact_hash: hashFile(join(fixture.runDir, "plan", "slices.json")),
        review_ref: "reviews/work-decomposer.json",
        review_hash: hashFile(join(fixture.runDir, "reviews", "work-decomposer.json")),
      });
      await transitionRunStep(fixture.runDir, "work-decomposer", { status: "rejected", attempts: 1 }, { mustExist: true });
      await transitionRunStep(fixture.runDir, "work-decomposer", { status: "running", attempts: 2 }, { mustExist: true });
      const beforeRace = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(transitionRunStep(fixture.runDir, "work-decomposer", {
        status: "accepted", attempts: 2, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
      }, {
        mustExist: true,
        atomicWriteHooks: { beforeCommit: () => writeJson(join(fixture.runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", verdict: "REJECT" }) },
      }), (error) => error?.message === "protected file commit failed" && /review bytes changed/u.test(error?.cause?.message));
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeRace);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rehashes accepted decomposition before test-verifier dispatch", async () => {
    const fixture = createFixture("test-verifier-decomposition-recheck");
    const projection = [writeModernReviewedSlice(fixture.runDir, "backend", { status: "merged", mergeCommit: "abc123" })];
    try {
      writeSeedPlan(fixture.runDir, projection);
      mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
      writeJson(join(fixture.runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", verdict: "APPROVE" });
      writeJson(join(fixture.runDir, "run.json"), {
        ...baseRun(fixture.runId),
        slices: projection,
        steps: [
          {
            agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
            acceptance: {
              artifact_ref: "plan/slices.json", artifact_hash: hashFile(join(fixture.runDir, "plan", "slices.json")),
              review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(fixture.runDir, "reviews", "work-decomposer.json")),
            },
          },
          { agent: "test-verifier", status: "blocked", attempts: 0 },
        ],
      });
      writeJson(join(fixture.runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", verdict: "REJECT" });
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(
        transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 1 }, { mustExist: true }),
        /accepted work-decomposer review bytes changed after acceptance/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rechecks required-command plan bytes after observation and before seed publication", async () => {
    const fixture = createFixture("checked-slice-seed-plan-race");
    const projection = [{ id: "backend", stack: "backend", depends_on: [], status: "pending", attempts: 0 }];
    const planPath = join(fixture.runDir, "plan", "slices.json");
    try {
      writeJson(join(fixture.runDir, "run.json"), { ...baseRun(fixture.runId), slices: [] });
      mkdirSync(join(fixture.runDir, "plan"), { recursive: true });
      writeJson(planPath, {
        integration_gate: { required_commands: [{ program: "node", args: ["--test", "test/acceptance.test.js"] }, { program: "npm", args: ["run", "check"] }] },
        slices: [{ id: "backend", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["AC1"], test_plan: ["node --test"] }],
      });
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");

      await assert.rejects(
        transitionSlicesSeed(fixture.runDir, projection, {
          from: "plan/slices.json",
          atomicWriteHooks: {
            beforeCommit() {
              writeJson(planPath, {
                integration_gate: { required_commands: [{ program: "node", args: ["--test", "test/other.test.js"] }, { program: "npm", args: ["run", "check"] }] },
                slices: [{ id: "backend", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["AC1"], test_plan: ["node --test"] }],
              });
            },
          },
        }),
        /protected file commit failed/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects pending reseed when any existing pending slice carries progress", async () => {
    const progress = {
      branch: "slice-branch",
      worktree: "/tmp/slice",
      evidence_ref: "evidence/slice.json",
      review_ref: "reviews/slice.json",
      merge_commit: "a".repeat(40),
      blocked_reason: "blocked before start",
      updated_at: NOW,
    };
    for (const [field, value] of Object.entries(progress)) {
      for (const force of [false, true]) {
        const fixture = createFixture(`pending-progress-${field}-${force}`);
        try {
          const pending = { id: "slice", stack: "backend", depends_on: [], status: "pending", attempts: 0, [field]: value };
          writeJson(join(fixture.runDir, "run.json"), { ...baseRun(fixture.runId), slices: [pending] });
          const replacement = [{ id: "replacement", stack: "backend", depends_on: [], status: "pending", attempts: 0 }];
          writeSeedPlan(fixture.runDir, replacement);
          const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
          await assert.rejects(
            transitionSlicesSeed(fixture.runDir, replacement, { from: "plan/slices.json", force }),
            /slice progress after work has started/u,
            `${field}:${force}`,
          );
          assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, `${field}:${force}`);
        } finally {
          cleanup(fixture.repo);
        }
      }
    }
  });

  it("rejects exact-byte sidecar drift after initial observation and before replacement", async () => {
    const slice = createFixture("slice-byte-drift");
    try {
      initGitRepo(slice.repo, ["slice-branch"]);
      runGit(slice.repo, ["checkout", "slice-branch"]);
      const sliceHead = gitOutput(slice.repo, ["rev-parse", "HEAD"]);
      writeJson(join(slice.runDir, "run.json"), { ...baseRun(slice.runId), branch: "slice-branch", worktree: slice.repo, slices: [{ id: "slice", status: "running", attempts: 1, branch: "slice-branch", worktree: slice.repo }] });
      seedBuilderDispatchAuthority(slice);
      await closeBuilderDispatch(slice, 1);
      mkdirSync(join(slice.runDir, "evidence"), { recursive: true });
      mkdirSync(join(slice.runDir, "reviews"), { recursive: true });
      const evidence = { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: sliceHead };
      const review = createV2SliceReviewRecord({ subject: "slice", attempt: 1, reviewedCommit: sliceHead });
      writeJson(join(slice.runDir, "evidence", "slice.json"), evidence);
      writeJson(join(slice.runDir, "reviews", "slice.json"), review);
      const before = readFileSync(join(slice.runDir, "run.json"), "utf8");
      for (const [name, mutate] of [
        ["evidence", () => writeFileSync(join(slice.runDir, "evidence", "slice.json"), `${JSON.stringify(evidence)}\n`)],
        ["review", () => writeFileSync(join(slice.runDir, "reviews", "slice.json"), `${JSON.stringify(review)}\n`)],
      ]) {
        writeJson(join(slice.runDir, "evidence", "slice.json"), evidence);
        writeJson(join(slice.runDir, "reviews", "slice.json"), review);
        await assert.rejects(transitionRunSlice(slice.runDir, "slice", {
          status: "review", attempts: 1, evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json",
        }, { atomicWriteHooks: { beforeCommit: mutate } }), /authority bytes changed|commit failed/u, name);
        assert.equal(readFileSync(join(slice.runDir, "run.json"), "utf8"), before, name);
      }
    } finally {
      cleanup(slice.repo);
    }

    const panel = createFixture("panel-byte-drift");
    try {
      initGitRepo(panel.repo, ["feature"]);
      runGit(panel.repo, ["checkout", "feature"]);
      const panelHead = gitOutput(panel.repo, ["rev-parse", "HEAD"]);
      writeJson(join(panel.runDir, "run.json"), { ...baseRun(panel.runId), branch: "feature", worktree: panel.repo });
      mkdirSync(join(panel.runDir, "reviews"), { recursive: true });
      writeFileSync(join(panel.runDir, "artifacts", "validation-report.md"), "GO\n");
      writeJson(join(panel.runDir, "reviews", "implementation-validator.json"), createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: panelHead, verdict: "GO" }));
      writeJson(join(panel.runDir, "reviews", "security-reviewer.json"), createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: panelHead, verdict: "PASS" }));
      const before = readFileSync(join(panel.runDir, "run.json"), "utf8");
      const validator = createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: panelHead, verdict: "GO" });
      const security = createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: panelHead, verdict: "PASS" });
      for (const [name, mutate] of [
        ["report", () => writeFileSync(join(panel.runDir, "artifacts", "validation-report.md"), "GO changed\n")],
        ["validator", () => writeFileSync(join(panel.runDir, "reviews", "implementation-validator.json"), `${JSON.stringify(validator)}\n`)],
        ["security", () => writeFileSync(join(panel.runDir, "reviews", "security-reviewer.json"), `${JSON.stringify(security)}\n`)],
      ]) {
        writeFileSync(join(panel.runDir, "artifacts", "validation-report.md"), "GO\n");
        writeJson(join(panel.runDir, "reviews", "implementation-validator.json"), validator);
        writeJson(join(panel.runDir, "reviews", "security-reviewer.json"), security);
        await assert.rejects(transitionPanelVerdicts(panel.runDir, {
          validator: { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" },
          security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" },
        }, { atomicWriteHooks: { beforeCommit: mutate } }), /authority bytes changed|commit failed/u, name);
        assert.equal(readFileSync(join(panel.runDir, "run.json"), "utf8"), before, name);
      }
    } finally {
      cleanup(panel.repo);
    }
  });

  it("enforces slice lifecycle identity, attempts, rejected retries, blocking, and current sidecars", async () => {
    const fixture = createFixture("slice-lifecycle");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      runGit(fixture.repo, ["checkout", "slice-branch"]);
      const head = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      writeJson(join(fixture.runDir, "run.json"), {
        ...baseRun(fixture.runId),
        branch: "slice-branch",
        worktree: fixture.repo,
        slices: [{ id: "slice", stack: "backend", depends_on: [], status: "pending", attempts: 0 }],
      });
      seedBuilderDispatchAuthority(fixture);
      await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 1, branch: "slice-branch", worktree: fixture.repo });
      await closeBuilderDispatch(fixture, 1);
      await assert.rejects(transitionRunSlice(fixture.runDir, "slice", { id: "other", status: "running", attempts: 1 }), /id is immutable/u);
      await assert.rejects(transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 0 }), /attempts cannot regress|positive/u);
      mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
      mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
      writeJson(join(fixture.runDir, "evidence", "slice-1.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: head });
      writeJson(join(fixture.runDir, "reviews", "slice-1.json"), {
        subject: "slice", attempt: 1, reviewed_commit: head, verdict: "REJECT", convergence: "converging",
        remaining_fix_count: 1, required_fixes: ["fix the rejected slice"],
        remediation_context: { schema_version: 1, fixes: [{ required_fix_index: 0, classification: "narrow-correction" }] },
      });
      const beforeV1Publication = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(
        transitionRunSlice(fixture.runDir, "slice", { status: "review", attempts: 1, evidence_ref: "evidence/slice-1.json", review_ref: "reviews/slice-1.json" }),
        /must equal 2/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeV1Publication);
      writeJson(join(fixture.runDir, "reviews", "slice-1.json"), createV2SliceReviewRecord({ subject: "slice", attempt: 1, reviewedCommit: head, verdict: "REJECT", requiredFixes: ["fix the rejected slice"] }));
      await transitionRunSlice(fixture.runDir, "slice", { status: "review", attempts: 1, evidence_ref: "evidence/slice-1.json", review_ref: "reviews/slice-1.json" });
      await assert.rejects(transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 1 }), /advance exactly to attempt 2/u);
      const retry = await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 2 });
      assert.equal(retry.slice.attempts, 2);
      assert.equal(Object.hasOwn(retry.slice, "review_ref"), false);
      await closeBuilderDispatch(fixture, 2);
      writeJson(join(fixture.runDir, "evidence", "slice-2.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 2, head_sha: head });
      writeJson(join(fixture.runDir, "reviews", "slice-2.json"), createV2SliceReviewRecord({ subject: "slice", attempt: 2, reviewedCommit: head }));
      await transitionRunSlice(fixture.runDir, "slice", { status: "review", attempts: 2, evidence_ref: "evidence/slice-2.json", review_ref: "reviews/slice-2.json" });
      await assert.rejects(transitionRunSlice(fixture.runDir, "slice", { status: "blocked", blocked_reason: "" }), /blocked_reason/u);
      await assert.rejects(transitionRunSlice(fixture.runDir, "slice", { status: "blocked", blocked_reason: "blocked", review_ref: "reviews/other.json" }), /cannot create or change retained review_ref/u);
      const blocked = await transitionRunSlice(fixture.runDir, "slice", { status: "blocked", blocked_reason: "review rejected" });
      assert.equal(blocked.slice.review_ref, "reviews/slice-2.json");
      await assert.rejects(transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 3 }), /cannot transition from blocked/u);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("routes a sibling-owned fix before consuming or dispatching the reviewed slice's next attempt", async () => {
    const fixture = createFixture("slice-sibling-fix-route");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      runGit(fixture.repo, ["checkout", "slice-branch"]);
      const head = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      writeJson(join(fixture.runDir, "run.json"), {
        ...baseRun(fixture.runId),
        branch: "slice-branch",
        worktree: fixture.repo,
        slices: [{ id: "slice", stack: "backend", depends_on: [], status: "pending", attempts: 0 }],
      });
      seedBuilderDispatchAuthority(fixture);
      const planPath = join(fixture.runDir, "plan", "slices.json");
      const plan = readJson(planPath);
      plan.slices.push({ id: "sibling", stack: "backend", paths: ["test/**"], depends_on: [], acceptance: ["sibling works"], test_plan: ["test sibling"] });
      writeJson(planPath, plan);
      const run = readJson(join(fixture.runDir, "run.json"));
      run.slices.push({ id: "sibling", stack: "backend", depends_on: [], status: "pending", attempts: 0 });
      run.steps.find((step) => step.agent === "work-decomposer").acceptance.artifact_hash = hashFile(planPath);
      writeJson(join(fixture.runDir, "run.json"), run);

      await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 1, branch: "slice-branch", worktree: fixture.repo });
      await closeBuilderDispatch(fixture, 1);
      mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
      writeJson(join(fixture.runDir, "evidence", "slice-1.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: head });
      writeJson(join(fixture.runDir, "reviews", "slice-1.json"), createV2SliceReviewRecord({
        subject: "slice",
        attempt: 1,
        reviewedCommit: head,
        verdict: "REJECT",
        requiredFixes: ["repair the sibling-owned test contract"],
        scopeEffect: "sibling-owned",
        likelyPaths: ["test/sibling.test.js"],
        fixOwner: "sibling",
      }));
      await transitionRunSlice(fixture.runDir, "slice", { status: "review", attempts: 1, evidence_ref: "evidence/slice-1.json", review_ref: "reviews/slice-1.json" });

      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(
        transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 2 }),
        /cannot consume another attempt[\s\S]*0:sibling-owned:sibling/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
      assert.equal(readJson(join(fixture.runDir, "run.json")).slices.find((slice) => slice.id === "slice").attempts, 1);

      // Simulate a pre-B3 caller having already advanced durable state. The
      // checked dispatch seam must independently reject the same reviewed route.
      const forced = readJson(join(fixture.runDir, "run.json"));
      const forcedSlice = forced.slices.find((slice) => slice.id === "slice");
      forcedSlice.status = "running";
      forcedSlice.attempts = 2;
      for (const key of ["evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash"]) delete forcedSlice[key];
      writeJson(join(fixture.runDir, "run.json"), forced);
      const dispatchFilesBefore = readdirSync(join(fixture.runDir, "dispatch")).sort();
      await assert.rejects(
        prepareSliceBuilderTaskDispatch(fixture.repo, { run_id: fixture.runId, slice_id: "slice", attempt: 2, agent: "backend-builder" }),
        /cannot consume another attempt[\s\S]*0:sibling-owned:sibling/u,
      );
      assert.deepEqual(readdirSync(join(fixture.runDir, "dispatch")).sort(), dispatchFilesBefore);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("re-observes slice sidecars at merge commit time and leaves the fence reusable", async () => {
    const fixture = createFixture("slice-merge-sidecar-race");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      prepareSliceMergeState(fixture);
      const integrationHead = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      const originalReview = readJson(join(fixture.runDir, "reviews", "slice.json"));
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(transitionSliceMerged(fixture.runDir, "slice", { merge_commit: integrationHead }, {
        atomicWriteHooks: { beforeCommit() { writeJson(join(fixture.runDir, "reviews", "slice.json"), { subject: "slice", verdict: "REJECT" }); } },
      }), /requires APPROVE review|commit failed/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
      writeJson(join(fixture.runDir, "reviews", "slice.json"), originalReview);
      const merged = await transitionSliceMerged(fixture.runDir, "slice", { merge_commit: integrationHead });
      assert.equal(merged.slice.status, "merged");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("records both panels atomically, re-observes matching replay, and rejects commit-time drift", async () => {
    const fixture = createFixture("panel-atomic");
    const input = {
      validator: { verdict: "GO-WITH-NITS", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" },
      security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" },
    };
    try {
      initGitRepo(fixture.repo, ["feature"]);
      runGit(fixture.repo, ["checkout", "feature"]);
      const head = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      writeJson(join(fixture.runDir, "run.json"), { ...baseRun(fixture.runId), branch: "feature", worktree: fixture.repo });
      mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
      writeFileSync(join(fixture.runDir, "artifacts", "validation-report.md"), "GO-WITH-NITS\n");
      writeJson(join(fixture.runDir, "reviews", "implementation-validator.json"), createPanelReviewRecord({ subject: "feature", attempt: 2, reviewedHeadSha: head, verdict: "GO-WITH-NITS" }));
      writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), createPanelReviewRecord({ subject: "feature", attempt: 2, reviewedHeadSha: head, verdict: "PASS" }));
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(transitionPanelVerdicts(fixture.runDir, input, {
        atomicWriteHooks: { beforeCommit() { writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), createPanelReviewRecord({ subject: "feature", attempt: 2, reviewedHeadSha: head, verdict: "BLOCK" })); } },
      }), /security review verdict must exactly match|commit failed/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
      writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), createPanelReviewRecord({ subject: "feature", attempt: 2, reviewedHeadSha: head, verdict: "PASS" }));
      const recorded = await transitionPanelVerdicts(fixture.runDir, input);
      assert.deepEqual({ verdict: recorded.run.validator.verdict, report: recorded.run.validator.report, review_ref: recorded.run.validator.review_ref }, input.validator);
      assert.deepEqual({ verdict: recorded.run.security_review.verdict, review_ref: recorded.run.security_review.review_ref }, input.security_review);
      assert.equal(recorded.run.validator.reviewed_head_sha, head);
      assert.equal(recorded.run.security_review.reviewed_head_sha, head);
      const recordedBytes = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      const replay = await transitionPanelVerdicts(fixture.runDir, input);
      assert.equal(replay.updated, false);
      writeFileSync(join(fixture.runDir, "artifacts", "validation-report.md"), "");
      await assert.rejects(transitionPanelVerdicts(fixture.runDir, input), /validator report must be nonempty/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), recordedBytes);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("upgrades legacy panels together and rejects stale, different, dirty, or moved panel heads", async () => {
    const legacy = createFixture("legacy-panel-upgrade");
    const input = {
      validator: { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" },
      security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" },
    };
    try {
      initGitRepo(legacy.repo, ["feature"]);
      runGit(legacy.repo, ["checkout", "feature"]);
      const head = gitOutput(legacy.repo, ["rev-parse", "HEAD"]);
      mkdirSync(join(legacy.runDir, "reviews"), { recursive: true });
      writeFileSync(join(legacy.runDir, "artifacts", "validation-report.md"), "GO\n");
      writeJson(join(legacy.runDir, "reviews", "implementation-validator.json"), createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: head, verdict: "GO" }));
      writeJson(join(legacy.runDir, "reviews", "security-reviewer.json"), createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: head, verdict: "PASS" }));
      writeJson(join(legacy.runDir, "run.json"), { ...baseRun(legacy.runId), branch: "feature", worktree: legacy.repo, validator: input.validator, security_review: input.security_review });
      const upgraded = await transitionPanelVerdicts(legacy.runDir, input);
      assert.equal(upgraded.run.validator.reviewed_head_sha, head);
      assert.equal(upgraded.run.security_review.reviewed_head_sha, head);
      assert.match(upgraded.run.validator.report_hash, /^sha256:[0-9a-f]{64}$/u);

      const exactBytes = readFileSync(join(legacy.runDir, "run.json"), "utf8");
      const replay = await transitionPanelVerdicts(legacy.runDir, input);
      assert.equal(replay.updated, false);
      assert.equal(readFileSync(join(legacy.runDir, "run.json"), "utf8"), exactBytes);

      writeFileSync(join(legacy.repo, "dirty.txt"), "dirty\n");
      await assert.rejects(transitionPanelVerdicts(legacy.runDir, input), /clean integration worktree/u);
      rmSync(join(legacy.repo, "dirty.txt"));

      writeFileSync(join(legacy.repo, "moved.txt"), "moved\n");
      runGit(legacy.repo, ["add", "moved.txt"]);
      runGit(legacy.repo, ["commit", "-m", "move integration head"]);
      await assert.rejects(transitionPanelVerdicts(legacy.runDir, input), /reviewed_head_sha values must equal the current integration head/u);
      assert.equal(readFileSync(join(legacy.runDir, "run.json"), "utf8"), exactBytes);
    } finally {
      cleanup(legacy.repo);
    }

    const different = createFixture("different-panel-heads");
    try {
      initGitRepo(different.repo, ["feature"]);
      runGit(different.repo, ["checkout", "feature"]);
      const head = gitOutput(different.repo, ["rev-parse", "HEAD"]);
      mkdirSync(join(different.runDir, "reviews"), { recursive: true });
      writeFileSync(join(different.runDir, "artifacts", "validation-report.md"), "GO\n");
      writeJson(join(different.runDir, "reviews", "implementation-validator.json"), createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: head, verdict: "GO" }));
      writeJson(join(different.runDir, "reviews", "security-reviewer.json"), createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: "0".repeat(40), verdict: "PASS" }));
      writeJson(join(different.runDir, "run.json"), { ...baseRun(different.runId), branch: "feature", worktree: different.repo });
      await assert.rejects(transitionPanelVerdicts(different.runDir, input), /reviewed_head_sha values must equal the current integration head/u);
      assert.equal(readJson(join(different.runDir, "run.json")).validator, undefined);
      assert.equal(readJson(join(different.runDir, "run.json")).security_review, undefined);
    } finally {
      cleanup(different.repo);
    }
  });

  it("rejects migration when only one legacy panel row exists", async () => {
    for (const [existingPanel, counterpart] of [["validator", undefined], ["validator", null], ["security_review", undefined], ["security_review", null]]) {
      const fixture = createFixture(`single-legacy-panel-${existingPanel}-${counterpart === null ? "null" : "absent"}`);
      try {
        const { input, legacyValidator, legacySecurity } = prepareLegacyPanelState(fixture);
        const run = readJson(join(fixture.runDir, "run.json"));
        run.validator = existingPanel === "validator" ? legacyValidator : counterpart;
        run.security_review = existingPanel === "security_review" ? legacySecurity : counterpart;
        writeJson(join(fixture.runDir, "run.json"), run);
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        const label = `${existingPanel}/${counterpart === null ? "null" : "absent"}`;
        await assert.rejects(transitionPanelVerdicts(fixture.runDir, input), /legacy panel upgrade requires both existing rows and an exact replay/u, label);
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, label);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("requires an exact base-field replay before upgrading legacy panel rows", async () => {
    const variations = [
      ["validator verdict", (input) => { input.validator.verdict = "GO-WITH-NITS"; }],
      ["validator report", (input) => { input.validator.report = "artifacts/alternate-validation-report.md"; }],
      ["validator review_ref", (input) => { input.validator.review_ref = "reviews/alternate-implementation-validator.json"; }],
      ["security verdict", (input) => { input.security_review.verdict = "BLOCK"; }],
      ["security review_ref", (input) => { input.security_review.review_ref = "reviews/alternate-security-reviewer.json"; }],
    ];
    for (const [name, change] of variations) {
      const fixture = createFixture(`legacy-panel-field-${name.replaceAll(" ", "-")}`);
      try {
        const { input, head } = prepareLegacyPanelState(fixture);
        writeFileSync(join(fixture.runDir, "artifacts", "alternate-validation-report.md"), "GO alternate\n");
        writeJson(join(fixture.runDir, "reviews", "alternate-implementation-validator.json"), createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: head, verdict: "GO" }));
        writeJson(join(fixture.runDir, "reviews", "alternate-security-reviewer.json"), createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: head, verdict: "PASS" }));
        const changed = structuredClone(input);
        change(changed);
        if (name === "validator verdict") writeJson(join(fixture.runDir, "reviews", "implementation-validator.json"), createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: head, verdict: "GO-WITH-NITS" }));
        if (name === "security verdict") writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: head, verdict: "BLOCK" }));
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(transitionPanelVerdicts(fixture.runDir, changed), /legacy panel upgrade requires both existing rows and an exact replay|validator review_ref must be reviews\/implementation-validator\.json/u, name);
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, name);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("keeps completed legacy panel rows read-only before observing sidecars", async () => {
    for (const [name, mutateSidecars] of [
      ["intact", () => {}],
      ["missing", (fixture) => rmSync(join(fixture.runDir, "reviews", "security-reviewer.json"))],
      ["changed", (fixture) => writeFileSync(join(fixture.runDir, "reviews", "implementation-validator.json"), "changed legacy review bytes\n")],
    ]) {
      const fixture = createFixture(`terminal-legacy-panel-${name}`);
      try {
        const { input } = prepareLegacyPanelState(fixture);
        const run = readJson(join(fixture.runDir, "run.json"));
        run.status = "completed";
        run.pr_url = "https://github.com/acme/repo/pull/1";
        run.terminal_result = {
          status: "completed",
          run_id: run.run_id,
          pr_url: run.pr_url,
          pr_number: 1,
          repository: "acme/repo",
          draft: false,
        };
        writeJson(join(fixture.runDir, "run.json"), run);
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        mutateSidecars(fixture);
        await assert.rejects(
          transitionPanelVerdicts(fixture.runDir, input),
          (error) => error.message === "legacy completed run is read-only",
          name,
        );
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, name);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("re-observes successor panel bytes before a completed exact no-op", async () => {
    const fixture = createFixture("terminal-successor-panel-replay");
    try {
      const { input } = prepareLegacyPanelState(fixture);
      await transitionPanelVerdicts(fixture.runDir, input);
      const run = readJson(join(fixture.runDir, "run.json"));
      run.status = "completed";
      run.pr_url = "https://github.com/acme/repo/pull/1";
      run.terminal_result = {
        status: "completed",
        run_id: run.run_id,
        pr_url: run.pr_url,
        pr_number: 1,
        repository: "acme/repo",
        draft: false,
      };
      writeJson(join(fixture.runDir, "run.json"), run);

      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      const replay = await transitionPanelVerdicts(fixture.runDir, input);
      assert.equal(replay.updated, false);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);

      writeFileSync(join(fixture.runDir, "artifacts", "validation-report.md"), "changed successor report bytes\n");
      await assert.rejects(transitionPanelVerdicts(fixture.runDir, input), /persisted panel successor binding is stale/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects integration movement before the pre-PR fence", async () => {
    const fixture = createFixture("pre-pr-panel-head-moved");
    try {
      writeReadyPrRun(fixture);
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      writeFileSync(join(fixture.repo, "moved-before-fence.txt"), "moved\n");
      runGit(fixture.repo, ["add", "moved-before-fence.txt"]);
      runGit(fixture.repo, ["commit", "-m", "move before fence"]);
      await assert.rejects(transitionPrePrFenceEstablished(fixture.runDir, preparePrTestOptions(fixture.runDir)), /reviewed_head_sha values must equal the current integration head/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("repeats merged-slice and panel byte checks at PR commit time without consuming the fence", async () => {
    const fixture = createFixture("pr-current-sidecars");
    const input = {
      pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/111",
      pr_number: 111,
      repository: "jasoncarreira/opencode-feature-factory",
    };
    try {
      writeReadyPrRun(fixture);
      const originalEvidence = readJson(join(fixture.runDir, "evidence", "slice.json"));
      const prepared = preparePrTestOptions(fixture.runDir, input);
      const fence = await transitionPrePrFenceEstablished(fixture.runDir, prepared);
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(transitionPrCreated(fixture.runDir, {}, {
        ...prepared,
        fenceToken: fence.fence.token,
        atomicWriteHooks: { beforeCommit() { writeJson(join(fixture.runDir, "evidence", "slice.json"), { subject: "slice", status: "fail", review_ready: true }); } },
      }), /evidence must be pass and review_ready|commit failed/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
      writeJson(join(fixture.runDir, "evidence", "slice.json"), originalEvidence);
      const completed = await transitionPrCreated(fixture.runDir, {}, { ...prepared, fenceToken: fence.fence.token });
      assert.equal(completed.run.status, "completed");
    } finally {
      cleanup(fixture.repo);
    }

    const panelFixture = createFixture("pr-current-panel-sidecars");
    try {
      writeReadyPrRun(panelFixture);
      const prepared = preparePrTestOptions(panelFixture.runDir, input);
      const fence = await transitionPrePrFenceEstablished(panelFixture.runDir, prepared);
      const before = readFileSync(join(panelFixture.runDir, "run.json"), "utf8");
      await assert.rejects(transitionPrCreated(panelFixture.runDir, {}, {
        ...prepared,
        fenceToken: fence.fence.token,
        atomicWriteHooks: { beforeCommit() { writeJson(join(panelFixture.runDir, "reviews", "implementation-validator.json"), { subject: "feature-branch", verdict: "NO-GO" }); } },
      }), /validator review verdict GO or GO-WITH-NITS|commit failed/u);
      assert.equal(readFileSync(join(panelFixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(panelFixture.repo);
    }
  });

  it("protects pre-PR fence and PR publication from commit-boundary byte drift", async () => {
    const fixture = createFixture("pr-publication-byte-drift");
    const input = {
      pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/112",
      pr_number: 112,
      repository: "jasoncarreira/opencode-feature-factory",
    };
    let sliceEvidence;
    let sliceReview;
    let validatorReview;
    let securityReview;
    let dispatchClaim;
    let dispatchClosure;
    let dispatchClaimPath;
    let dispatchClosurePath;
    let futureDispatchPath;
    const restore = () => {
      writeFileSync(join(fixture.runDir, "artifacts", "story.md"), "story\n");
      writeJson(join(fixture.runDir, "evidence", "slice.json"), sliceEvidence);
      writeJson(join(fixture.runDir, "reviews", "slice.json"), sliceReview);
      writeJson(join(fixture.runDir, "reviews", "implementation-validator.json"), validatorReview);
      writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), securityReview);
      writeFileSync(dispatchClaimPath, dispatchClaim);
      writeFileSync(dispatchClosurePath, dispatchClosure);
      rmSync(futureDispatchPath, { force: true });
    };
    const mutations = [
      ["slice evidence", () => writeFileSync(join(fixture.runDir, "evidence", "slice.json"), `${JSON.stringify(sliceEvidence)}\n`)],
      ["slice review", () => writeFileSync(join(fixture.runDir, "reviews", "slice.json"), `${JSON.stringify(sliceReview)}\n`)],
      ["validator report", () => writeFileSync(join(fixture.runDir, "artifacts", "story.md"), "story changed\n")],
      ["validator review", () => writeFileSync(join(fixture.runDir, "reviews", "implementation-validator.json"), `${JSON.stringify(validatorReview)}\n`)],
      ["security review", () => writeFileSync(join(fixture.runDir, "reviews", "security-reviewer.json"), `${JSON.stringify(securityReview)}\n`)],
      ["dispatch claim", () => writeFileSync(dispatchClaimPath, `${dispatchClaim}\n`)],
      ["dispatch closure", () => writeFileSync(dispatchClosurePath, `${dispatchClosure}\n`)],
      ["missing dispatch claim", () => rmSync(dispatchClaimPath)],
      ["missing dispatch closure", () => rmSync(dispatchClosurePath)],
      ["future dispatch orphan", () => writeJson(futureDispatchPath, {})],
    ];
    try {
      writeReadyPrRun(fixture);
      ({ claimPath: dispatchClaimPath, closurePath: dispatchClosurePath } = bindReadyPrSliceDispatch(fixture));
      futureDispatchPath = join(fixture.runDir, "dispatch", `${createHash("sha256").update(`${fixture.runId}\0slice\0${2}`, "utf8").digest("hex")}.json`);
      sliceEvidence = readJson(join(fixture.runDir, "evidence", "slice.json"));
      sliceReview = readJson(join(fixture.runDir, "reviews", "slice.json"));
      validatorReview = readJson(join(fixture.runDir, "reviews", "implementation-validator.json"));
      securityReview = readJson(join(fixture.runDir, "reviews", "security-reviewer.json"));
      dispatchClaim = readFileSync(dispatchClaimPath, "utf8");
      dispatchClosure = readFileSync(dispatchClosurePath, "utf8");
      const beforeFence = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      for (const [name, mutate] of mutations) {
        restore();
        await assert.rejects(transitionPrePrFenceEstablished(fixture.runDir, preparePrTestOptions(fixture.runDir, input, {
          atomicWriteHooks: { beforeCommit: mutate },
        })), /authority bytes changed|commit failed/u, `fence:${name}`);
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeFence, `fence:${name}`);
      }

      restore();
      const prepared = preparePrTestOptions(fixture.runDir, input);
      const fence = await transitionPrePrFenceEstablished(fixture.runDir, prepared);
      const fencedBytes = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      for (const [name, mutate] of mutations) {
        restore();
        await assert.rejects(transitionPrCreated(fixture.runDir, {}, {
          ...prepared,
          fenceToken: fence.fence.token,
          atomicWriteHooks: { beforeCommit: mutate },
        }), /authority bytes changed|commit failed/u, `pr:${name}`);
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), fencedBytes, `pr:${name}`);
      }
      restore();
      const completed = await transitionPrCreated(fixture.runDir, {}, { ...prepared, fenceToken: fence.fence.token });
      assert.equal(completed.run.status, "completed");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("re-observes verified PR head identities immediately before replacement", async () => {
    const fixture = createFixture("pr-head-git-race");
    try {
      initGitRepo(fixture.repo, ["feature-branch"]);
      runGit(fixture.repo, ["checkout", "feature-branch"]);
      const head = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      writeReadyPrRun(fixture, { branch: "feature-branch", worktree: fixture.repo, base_commit: head });
      const input = {
        pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/113",
        pr_number: 113,
        repository: "jasoncarreira/opencode-feature-factory",
        head_sha: head,
      };
      const prepared = preparePrTestOptions(fixture.runDir, input);
      const fence = await transitionPrePrFenceEstablished(fixture.runDir, prepared);
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(transitionPrCreated(fixture.runDir, {}, {
        ...prepared,
        fenceToken: fence.fence.token,
        atomicWriteHooks: {
          beforeCommit() {
            writeFileSync(join(fixture.repo, "pr-race.txt"), "race\n");
            runGit(fixture.repo, ["add", "pr-race.txt"]);
            runGit(fixture.repo, ["commit", "-m", "race PR head"]);
          },
        },
      }), /local, worktree, and origin head equality|changed before publication|commit failed/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
      runGit(fixture.repo, ["reset", "--hard", head]);
      const completed = await transitionPrCreated(fixture.runDir, {}, { ...prepared, fenceToken: fence.fence.token });
      assert.equal(completed.run.terminal_result.head_sha, head);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("keeps checked steering boundary, claim, and last-action writers executable", async () => {
    const fixture = createFixture("steering-canonical-writers");
    try {
      const opened = await transitionSteeringBoundaryOpened(fixture.runDir, "dispatch", { token: "dispatch-token" });
      assert.deepEqual(Object.keys(opened.boundary), ["kind", "token", "generation", "state_hash", "created_at"]);
      const crossed = await transitionSteeringBoundaryCrossed(fixture.runDir, "dispatch", opened.boundary.token);
      assert.deepEqual(Object.keys(crossed.action_claim), ["kind", "token", "generation", "claimed_at"]);
      const started = await transitionSteeringActionStarted(fixture.runDir, "dispatch", opened.boundary.token);
      assert.deepEqual(Object.keys(started.action), ["kind", "token", "generation", "outcome", "claimed_at", "resolved_at"]);
      assert.equal(started.action.outcome, "started");
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
      assert.deepEqual(Object.keys(result.run.terminal_result), ["status", "run_id", "pr_url", "reason", "summary", "artifacts"]);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("writes each non-completed terminal variant through transitionTerminalResult with only common keys", async () => {
    for (const status of ["blocked", "partial", "needs-human"]) {
      const fixture = createFixture(`terminal-${status}`);
      try {
        const result = await terminalTransition(fixture.runDir, {
          status,
          pr_url: null,
          reason: `${status}-reason`,
          summary: `${status} summary`,
          artifacts: { report: "artifacts/report.md" },
        });
        assert.equal(result.run.status, status);
        assert.deepEqual(result.run.terminal_result, {
          status,
          pr_url: null,
          reason: `${status}-reason`,
          summary: `${status} summary`,
          artifacts: { report: "artifacts/report.md" },
          run_id: fixture.runId,
        });
        assert.deepEqual(Object.keys(result.run.terminal_result).sort(), ["status", "run_id", "pr_url", "reason", "summary", "artifacts"].sort());
      } finally {
        cleanup(fixture.repo);
      }
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

  it("fails immediately without owner inspection or recovery when reclaimMode is never", async () => {
    const fixture = createFixture("never-reclaim-lock");
    const lockDir = join(fixture.runDir, "run-json.lock");
    const owner = { pid: 999999, hostname: hostname(), acquired_at: NOW, nonce: "12121212-1212-4212-8212-121212121212" };
    const calls = [];
    try {
      mkdirSync(lockDir);
      writeJson(join(lockDir, "owner.json"), owner);

      await assert.rejects(
        withRunJsonLock(fixture.runDir, () => { calls.push("callback"); }, {
          reclaimMode: "never",
          timeoutMs: 60000,
          processAliveFn: () => { calls.push("inspect-owner"); return false; },
          lockHooks: {
            onContended: () => calls.push("contended"),
            onBeforeReclaimClaim: () => calls.push("before-reclaim"),
            onReclaimClaimed: () => calls.push("reclaimed"),
          },
        }),
        (error) => {
          assert.equal(error instanceof RunJsonLockContendedError, true);
          assert.equal(error.code, "RUN_JSON_LOCK_CONTENDED");
          assert.equal(error.lockDir, lockDir);
          return true;
        },
      );

      assert.deepEqual(calls, []);
      assert.deepEqual(readJson(join(lockDir, "owner.json")), owner);
      assert.deepEqual(readdirSync(fixture.runDir).filter((entry) => entry.includes("reclaim") || entry.includes("quarantine")), []);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("accepts only the exact run-json lock reclaim modes", async () => {
    const fixture = createFixture("reclaim-mode-validation");
    try {
      await assert.rejects(
        withRunJsonLock(fixture.runDir, () => {}, { reclaimMode: "Never" }),
        /reclaimMode must be dead-owner or never/u,
      );
      assert.equal(existsSync(join(fixture.runDir, "run-json.lock")), false);
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
      await assert.rejects(first, (error) => {
        assert.equal(error?.code === "EEXIST" || /lock ownership changed before owner publication/u.test(error?.message), true);
        return true;
      });
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
      ["true-string", hostname(), () => "true"],
      ["false-string", hostname(), () => "false"],
      ["boxed-boolean", hostname(), () => new Boolean(false)],
      ["object", hostname(), () => ({})],
      ["array", hostname(), () => []],
      ["number", hostname(), () => 0],
      ["null", hostname(), () => null],
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

  it("clears heartbeat evidence only for literal-false legacy liveness", async () => {
    const cases = [
      ["live", () => true, false, /fresh-heartbeat/u],
      ["absent", () => false, true, null],
      ["string", () => "false", false, /indeterminate-heartbeat-process/u],
      ["boxed", () => new Boolean(false), false, /indeterminate-heartbeat-process/u],
      ["object", () => ({ status: "dead" }), false, /indeterminate-heartbeat-process/u],
      ["array", () => [], false, /indeterminate-heartbeat-process/u],
      ["number", () => 0, false, /indeterminate-heartbeat-process/u],
      ["null", () => null, false, /indeterminate-heartbeat-process/u],
      ["undefined", () => undefined, false, /indeterminate-heartbeat-process/u],
      ["throw", () => { throw new Error("probe failed"); }, false, /indeterminate-heartbeat-process/u],
    ];
    for (const [name, processAliveFn, recoverable, rejection] of cases) {
      const fixture = createFixture(`heartbeat-liveness-${name}`);
      try {
        writeJson(join(fixture.runDir, "heartbeat.json"), heartbeat(fixture.runId));
        if (recoverable) {
          const result = await transitionRecoverOrphan(fixture.runDir, "confirmed absent", { now: NOW, processAliveFn });
          assert.equal(result.recovery.reason, "dead-heartbeat-process");
          assert.equal(readJson(join(fixture.runDir, "heartbeat.json")).pid, null);
          assert.equal(readJson(join(fixture.runDir, "run.json")).status, "needs-human");
        } else {
          await assert.rejects(
            transitionRecoverOrphan(fixture.runDir, "must stay running", { now: NOW, processAliveFn }),
            rejection,
          );
          assert.equal(readJson(join(fixture.runDir, "heartbeat.json")).pid, process.pid);
          assert.equal(readJson(join(fixture.runDir, "run.json")).status, "running");
        }
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("does not clear stale heartbeat evidence while its process is live", async () => {
    const fixture = createFixture("heartbeat-live-stale");
    try {
      writeJson(join(fixture.runDir, "heartbeat.json"), {
        ...heartbeat(fixture.runId),
        last_tick_at: "2026-07-08T11:00:00.000Z",
      });
      await assert.rejects(
        transitionRecoverOrphan(fixture.runDir, "must stay running", { now: NOW, processAliveFn: () => true }),
        /stale-heartbeat/u,
      );
      assert.equal(readJson(join(fixture.runDir, "heartbeat.json")).pid, process.pid);
      assert.equal(readJson(join(fixture.runDir, "run.json")).status, "running");
    } finally {
      cleanup(fixture.repo);
    }
  });
});

function deferredPromise() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function writeModernReviewedSlice(runDir, id, { status = "review", mergeCommit, reviewedCommit = "a".repeat(40) } = {}) {
  const evidenceRef = `evidence/${id}.fixture.json`;
  const reviewRef = `reviews/${id}.fixture.json`;
  mkdirSync(join(runDir, "evidence"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  writeJson(join(runDir, evidenceRef), { subject: id, attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommit });
  writeJson(join(runDir, reviewRef), createV2SliceReviewRecord({ subject: id, attempt: 1, reviewedCommit }));
  const evidenceHash = hashFile(join(runDir, evidenceRef));
  const reviewHash = hashFile(join(runDir, reviewRef));
  const history = { attempt: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash, reviewed_commit: reviewedCommit, verdict: "APPROVE", convergence: "converging", remaining_fix_count: 0 };
  return {
    id, stack: "backend", depends_on: [], status, attempts: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash,
    reviewed_commit: reviewedCommit, attempt_reviews: [history], ...(status === "merged" ? { merge_commit: mergeCommit ?? reviewedCommit } : {}),
  };
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

function seedBuilderDispatchAuthority(fixture) {
  mkdirSync(join(fixture.runDir, "plan"), { recursive: true });
  mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
  writeFileSync(join(fixture.runDir, "artifacts", "technical-brief.md"), "accepted brief\n");
  writeJson(join(fixture.runDir, "plan", "slices.json"), {
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: [{ id: "slice", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["works"], test_plan: ["node --test"] }],
  });
  writeJson(join(fixture.runDir, "reviews", "spec-writer.json"), { subject: "spec-writer", verdict: "APPROVE", required_fixes: [] });
  writeJson(join(fixture.runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", verdict: "APPROVE", required_fixes: [] });
  const run = readJson(join(fixture.runDir, "run.json"));
  run.slices = run.slices.map((slice) => slice.id === "slice" ? { ...slice, stack: "backend", depends_on: slice.depends_on || [] } : slice);
  run.steps = [{
    agent: "spec-writer", status: "accepted", attempts: 1, artifact_ref: "artifacts/technical-brief.md", review_ref: "reviews/spec-writer.json",
    acceptance: {
      artifact_ref: "artifacts/technical-brief.md", artifact_hash: hashFile(join(fixture.runDir, "artifacts", "technical-brief.md")),
      review_ref: "reviews/spec-writer.json", review_hash: hashFile(join(fixture.runDir, "reviews", "spec-writer.json")),
    },
  }, {
    agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
    acceptance: {
      artifact_ref: "plan/slices.json", artifact_hash: hashFile(join(fixture.runDir, "plan", "slices.json")),
      review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(fixture.runDir, "reviews", "work-decomposer.json")),
    },
  }];
  writeJson(join(fixture.runDir, "run.json"), run);
}

function createV2SliceReviewRecord({ scopeEffect = "in-lane", likelyPaths = ["src/fix.js"], fixOwner = "slice", ...input } = {}) {
  const review = createSliceReviewRecord(input);
  review.remediation_context = {
    schema_version: 2,
    fixes: review.remediation_context.fixes.map((fix) => ({
      ...fix,
      scope_effect: scopeEffect,
      likely_paths: [...likelyPaths],
      fix_owner: fixOwner,
    })),
  };
  return review;
}

async function closeBuilderDispatch(fixture, attempt, taskWork = () => {}) {
  const completionToken = `run-state-completion-${attempt}`;
  const context = await prepareSliceBuilderTaskDispatch(fixture.repo, {
    run_id: fixture.runId, slice_id: "slice", attempt, agent: "backend-builder",
  }, { claimDispatch: true, completionToken });
  await taskWork();
  await completeSliceBuilderTaskDispatch(fixture.repo, {
    run_id: fixture.runId,
    slice_id: "slice",
    attempt,
    agent: "backend-builder",
    claim_ref: context.dispatch_claim.ref,
    claim_hash: context.dispatch_claim.hash,
    completion_token: completionToken,
  });
}

function prepareSliceMergeState(fixture, { verdict = "APPROVE", subject = "slice", writeReview = true, priorIntegration = false, reviewedPath = "slice.txt" } = {}) {
  mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
  mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
  const sliceWorktree = join(fixture.repo, ".opencode", "worktrees", "slice");
  mkdirSync(join(fixture.repo, ".opencode", "worktrees"), { recursive: true });
  runGit(fixture.repo, ["worktree", "add", sliceWorktree, "slice-branch"]);
  writeFileSync(join(sliceWorktree, reviewedPath), "reviewed slice bytes\n");
  runGit(sliceWorktree, ["add", "-A"]);
  runGit(sliceWorktree, ["commit", "-m", "reviewed slice"]);
  const reviewedCommit = gitOutput(sliceWorktree, ["rev-parse", "HEAD"]);
  writeJson(join(fixture.runDir, "evidence", "slice.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: reviewedCommit });
  const requiredFixes = verdict === "REJECT" ? ["fix rejected slice"] : [];
  const review = createV2SliceReviewRecord({ subject, verdict, attempt: 1, reviewedCommit, requiredFixes });
  writeJson(join(fixture.runDir, "reviews", "slice.json"), review);
  const evidenceHash = hashFile(join(fixture.runDir, "evidence", "slice.json"));
  const reviewHash = hashFile(join(fixture.runDir, "reviews", "slice.json"));
  const attemptReview = {
    attempt: 1,
    evidence_ref: "evidence/slice.json",
    evidence_hash: evidenceHash,
    review_ref: "reviews/slice.json",
    review_hash: reviewHash,
    reviewed_commit: reviewedCommit,
    verdict,
    convergence: review.convergence,
    remaining_fix_count: review.remaining_fix_count,
  };
  const slices = [{
    id: "slice", status: "review", attempts: 1, branch: "slice-branch", worktree: sliceWorktree,
    evidence_ref: "evidence/slice.json", evidence_hash: evidenceHash,
    review_ref: "reviews/slice.json", review_hash: reviewHash, reviewed_commit: reviewedCommit,
    attempt_reviews: [attemptReview],
  }];
  let priorCommit = null;
  if (priorIntegration) {
    writeFileSync(join(fixture.repo, "prior.txt"), "disjoint prior integration\n");
    runGit(fixture.repo, ["add", "prior.txt"]);
    runGit(fixture.repo, ["commit", "-m", "disjoint prior integration"]);
    priorCommit = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
    slices.unshift({
      id: "prior", status: "merged", attempts: 1, merge_commit: priorCommit,
      evidence_ref: attemptReview.evidence_ref, evidence_hash: attemptReview.evidence_hash,
      review_ref: attemptReview.review_ref, review_hash: attemptReview.review_hash, reviewed_commit: attemptReview.reviewed_commit,
      attempt_reviews: [{ ...attemptReview }],
    });
  }
  writeJson(join(fixture.runDir, "run.json"), {
    ...baseRun(fixture.runId),
    branch: "main",
    worktree: fixture.repo,
    slices,
  });
  if (!writeReview) rmSync(join(fixture.runDir, "reviews", "slice.json"));
  runGit(fixture.repo, ["merge", "--no-ff", "slice-branch", "-m", "merge reviewed slice"]);
  return { reviewedCommit, mergeCommit: gitOutput(fixture.repo, ["rev-parse", "HEAD"]), sliceWorktree, priorCommit };
}

function prepareLegacyPanelState(fixture) {
  initGitRepo(fixture.repo, ["feature"]);
  runGit(fixture.repo, ["checkout", "feature"]);
  const head = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
  mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
  writeFileSync(join(fixture.runDir, "artifacts", "validation-report.md"), "GO\n");
  writeJson(join(fixture.runDir, "reviews", "implementation-validator.json"), createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: head, verdict: "GO" }));
  writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: head, verdict: "PASS" }));
  const legacyValidator = { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" };
  const legacySecurity = { verdict: "PASS", review_ref: "reviews/security-reviewer.json" };
  writeJson(join(fixture.runDir, "run.json"), { ...baseRun(fixture.runId), branch: "feature", worktree: fixture.repo, validator: legacyValidator, security_review: legacySecurity });
  return { head, legacyValidator, legacySecurity, input: { validator: structuredClone(legacyValidator), security_review: structuredClone(legacySecurity) } };
}

async function approveGate(fixture, gate, artifactFile) {
  const artifactRef = `artifacts/${artifactFile}`;
  const questionRef = `gates/${gate}.question.md`;
  const answerRef = `gates/${gate}.answer`;
  if (!artifactFile.endsWith("story.md") && !existsSync(join(fixture.runDir, artifactRef))) writeFileSync(join(fixture.runDir, artifactRef), `${gate}\n`);
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
  const prepared = preparePrTestOptions(runDir, input, options);
  const fenced = await transitionPrePrFenceEstablished(runDir, prepared);
  return transitionPrCreated(runDir, {}, { ...prepared, fenceToken: fenced.fence.token });
}

async function establishFenceAndExpectFailure(runDir, input, options = {}) {
  const prepared = preparePrTestOptions(runDir, input, options);
  const fenced = await transitionPrePrFenceEstablished(runDir, prepared);
  return transitionPrCreated(runDir, {}, { ...prepared, fenceToken: fenced.fence.token });
}

function preparePrTestOptions(runDir, requested = {}, options = {}) {
  const runPath = join(runDir, "run.json");
  const run = readJson(runPath);
  if (requested.draft !== undefined) {
    run.pr_mode = requested.draft ? "draft" : "ready";
    writeJson(runPath, run);
  }
  const current = readJson(runPath);
  const repo = current.worktree;
  const gitFn = options.gitFn || ((cwd, args) => {
    if (args.join(" ") === "config --get remote.origin.url") return { ok: true, status: 0, stdout: "https://github.com/jasoncarreira/opencode-feature-factory.git\n", stderr: "" };
    if (args[0] === "ls-remote") {
      const ref = args[3].slice("refs/heads/".length);
      const sha = ref === current.base_ref ? current.base_commit : gitOutput(repo, ["rev-parse", `refs/heads/${ref}`]);
      return { ok: true, status: 0, stdout: `${sha}\trefs/heads/${ref}\n`, stderr: "" };
    }
    return git(cwd, args);
  });
  const observePrOperation = options.observePrOperation || ((identity) => ({
    disposition: "open",
    reason: null,
    pull_request: {
      pr_url: requested.pr_url || "https://github.com/jasoncarreira/opencode-feature-factory/pull/99",
      pr_number: requested.pr_number || 99,
      pr_node_id: "PR_test_operation",
      repository: requested.repository || identity.repository,
      draft: identity.draft,
      body: "",
      state: "open",
      merged_at: null,
      head_ref: identity.head_ref,
      head_sha: identity.head_sha,
      head_repository: identity.repository,
      base_ref: identity.base_ref,
      base_sha: identity.base_sha,
      base_repository: identity.repository,
    },
  }));
  return { ...options, repoRoot: repo, gitFn, observePrOperation };
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
  if (!existsSync(join(fixture.repo, ".git"))) initGitRepo(fixture.repo);
  const branch = overrides.branch || "feature-branch";
  const branchExists = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: fixture.repo }).status === 0;
  if (!branchExists) runGit(fixture.repo, ["branch", branch]);
  runGit(fixture.repo, ["checkout", branch]);
  const head = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
  mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
  mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
  writeJson(join(fixture.runDir, "evidence", "slice.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: head });
  writeJson(join(fixture.runDir, "reviews", "slice.json"), createV2SliceReviewRecord({ subject: "slice", attempt: 1, reviewedCommit: head }));
  writeJson(join(fixture.runDir, "reviews", "implementation-validator.json"), createPanelReviewRecord({ subject: branch, attempt: 1, reviewedHeadSha: head, verdict: overrides.validator?.verdict || "GO" }));
  writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), createPanelReviewRecord({ subject: branch, attempt: 1, reviewedHeadSha: head, verdict: overrides.security_review?.verdict || "PASS" }));
  const validator = {
    verdict: "GO", report: "artifacts/story.md", review_ref: "reviews/implementation-validator.json",
    report_hash: hashFile(join(fixture.runDir, "artifacts", "story.md")), review_hash: hashFile(join(fixture.runDir, "reviews", "implementation-validator.json")), reviewed_head_sha: head,
    ...(overrides.validator || {}),
  };
  const securityReview = {
    verdict: "PASS", review_ref: "reviews/security-reviewer.json",
    review_hash: hashFile(join(fixture.runDir, "reviews", "security-reviewer.json")), reviewed_head_sha: head,
    ...(overrides.security_review || {}),
  };
  const slice = {
    id: "slice", status: "merged", attempts: 1, branch: "slice-branch", worktree: fixture.repo,
    evidence_ref: "evidence/slice.json", evidence_hash: hashFile(join(fixture.runDir, "evidence", "slice.json")),
    review_ref: "reviews/slice.json", review_hash: hashFile(join(fixture.runDir, "reviews", "slice.json")), reviewed_commit: head,
    merge_commit: head, updated_at: NOW,
  };
  slice.attempt_reviews = [{
    attempt: 1,
    evidence_ref: slice.evidence_ref,
    evidence_hash: slice.evidence_hash,
    review_ref: slice.review_ref,
    review_hash: slice.review_hash,
    reviewed_commit: head,
    verdict: "APPROVE",
    convergence: "converging",
    remaining_fix_count: 0,
  }];
  const sanitizedOverrides = { ...overrides };
  delete sanitizedOverrides.branch;
  delete sanitizedOverrides.worktree;
  delete sanitizedOverrides.validator;
  delete sanitizedOverrides.security_review;
  delete sanitizedOverrides.slices;
  if (sanitizedOverrides.continuation) {
    sanitizedOverrides.continuation = structuredClone(sanitizedOverrides.continuation);
    sanitizedOverrides.continuation.target.branch = branch;
    sanitizedOverrides.continuation.target.worktree = fixture.repo;
  }
  const slices = overrides.slices
    ? overrides.slices.map((override) => {
      if (override.id !== "slice" || !["review", "merged"].includes(override.status)) return override;
      const modern = { ...slice, ...override };
      if (modern.status === "review") delete modern.merge_commit;
      return modern;
    })
    : [slice];
  writeJson(join(fixture.runDir, "run.json"), {
    ...baseRun(fixture.runId),
    branch,
    base_ref: "main",
    base_commit: gitOutput(fixture.repo, ["rev-parse", "refs/heads/main"]),
    worktree: fixture.repo,
    pr_mode: "ready",
    gates: { pre_pr: { status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer: "approve", answered_at: NOW } },
    slices,
    validator,
    security_review: securityReview,
    ...sanitizedOverrides,
  });
}

function bindReadyPrSliceDispatch(fixture) {
  const runPath = join(fixture.runDir, "run.json");
  const run = readJson(runPath);
  const slice = run.slices[0];
  const stem = createHash("sha256").update(`${run.run_id}\0${slice.id}\0${slice.attempts}`, "utf8").digest("hex");
  const claimRef = `dispatch/${stem}.json`;
  const closureRef = `dispatch/${stem}.closed.json`;
  const token = "ready-pr-dispatch-capability";
  mkdirSync(join(fixture.runDir, "dispatch"), { recursive: true });
  const claimPath = join(fixture.runDir, claimRef);
  const closurePath = join(fixture.runDir, closureRef);
  const claim = {
    schema_version: 1, kind: "checked-slice-builder-dispatch-claim", run_id: run.run_id, slice_id: slice.id, attempt: slice.attempts,
    agent: "backend-builder", branch: slice.branch, worktree: slice.worktree, head: slice.reviewed_commit,
    context_hash: `sha256:${"1".repeat(64)}`, completion_token_hash: `sha256:${createHash("sha256").update(token).digest("hex")}`,
    claimed_at: NOW, closure_ref: closureRef,
  };
  writeJson(claimPath, claim);
  const claimHash = hashFile(claimPath);
  writeJson(closurePath, {
    schema_version: 1, kind: "checked-slice-builder-dispatch-closure", claim_ref: claimRef, claim_hash: claimHash,
    run_id: run.run_id, slice_id: slice.id, attempt: slice.attempts, agent: "backend-builder", branch: slice.branch,
    worktree: slice.worktree, head: slice.reviewed_commit, completion_head: slice.reviewed_commit, context_hash: claim.context_hash, completion_token: token, returned_at: NOW,
  });
  Object.assign(slice, {
    stack: "backend", depends_on: [], dispatch_required: true, dispatch_claim_ref: claimRef, dispatch_claim_hash: claimHash,
    dispatch_closure_ref: closureRef, dispatch_closure_hash: hashFile(closurePath),
  });
  Object.assign(slice.attempt_reviews.at(-1), {
    dispatch_claim_ref: slice.dispatch_claim_ref,
    dispatch_claim_hash: slice.dispatch_claim_hash,
    dispatch_closure_ref: slice.dispatch_closure_ref,
    dispatch_closure_hash: slice.dispatch_closure_hash,
  });
  writeJson(runPath, run);
  return { claimPath, closurePath };
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
      run_ref: ".opencode/factory/parent-run/run.json",
      run_hash: HASH,
      branch: "parent-branch",
      commit: "a".repeat(40),
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
      base_commit: "b".repeat(40),
    },
    parent_artifacts: [{ kind: "validation_report", ref: "artifacts/validation-report.md", hash: HASH }],
    parent_evidence: [],
    parent_reviews: [{ kind: "review", ref: "reviews/implementation-validator.json", hash: HASH }],
  };
}

function makeSyntheticV2Run(runDir, input, { accepted = [], remaining = [] } = {}) {
  const run = structuredClone(input);
  run.branch = run.branch || `${run.run_id}-branch`;
  run.worktree = run.worktree || `/tmp/${run.run_id}-worktree`;
  run.base_ref = run.base_ref || "main";
  run.base_commit = run.base_commit || "b".repeat(40);
  const acceptedSet = new Set(accepted);
  run.slices = (run.slices || []).map((slice) => acceptedSet.has(slice.id) ? {
    id: slice.id,
    stack: slice.stack || "backend",
    depends_on: slice.depends_on || [],
    status: "merged",
    attempts: slice.attempts,
    evidence_ref: slice.evidence_ref,
    evidence_hash: slice.evidence_hash,
    review_ref: slice.review_ref,
    review_hash: slice.review_hash,
    reviewed_commit: slice.reviewed_commit,
    merge_commit: slice.merge_commit,
  } : { ...slice, stack: slice.stack || "backend", depends_on: slice.depends_on || [] });
  mkdirSync(join(runDir, "plan"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "technical-brief.md"), "accepted synthetic brief\n");
  writeJson(join(runDir, "reviews", "spec-writer.json"), { subject: "spec-writer", attempt: 1, verdict: "APPROVE" });
  const plan = {
    integration_gate: { required_commands: [{ program: "node", args: ["--test", "test/integration.test.js"] }, { program: "npm", args: ["run", "check"] }] },
    slices: run.slices.map((slice) => ({ id: slice.id, stack: slice.stack, paths: [`${slice.id}.txt`], depends_on: slice.depends_on, acceptance: [`${slice.id} accepted`], test_plan: [`test ${slice.id}`] })),
  };
  writeJson(join(runDir, "plan", "slices.json"), plan);
  writeJson(join(runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE" });
  const briefHash = hashFile(join(runDir, "artifacts", "technical-brief.md"));
  const specReviewHash = hashFile(join(runDir, "reviews", "spec-writer.json"));
  const startCommit = "a".repeat(40);
  const continuation = continuationMetadata(run.run_id);
  continuation.schema_version = 2;
  continuation.parent.commit = startCommit;
  continuation.target = { run_id: run.run_id, branch: run.branch, worktree: run.worktree, base_ref: run.base_ref || "main", base_commit: run.base_commit || "b".repeat(40) };
  continuation.parent_artifacts.push({ kind: "technical_brief", ref: "artifacts/technical-brief.md", hash: briefHash });
  const parentReviewPath = join(runDir, continuation.review.ref);
  if (!existsSync(parentReviewPath)) writeJson(parentReviewPath, { subject: continuation.parent.run_id, attempt: 1, verdict: "NO-GO" });
  const parentReviewHash = hashFile(parentReviewPath);
  continuation.review.hash = parentReviewHash;
  continuation.parent_reviews[0].hash = parentReviewHash;
  continuation.parent_reviews.push({ kind: "review", ref: "reviews/spec-writer.json", hash: specReviewHash });
  continuation.planning_reuse = {
    eligible: true,
    spec_review_ref: "reviews/spec-writer.json",
    spec_review_hash: specReviewHash,
    spec_artifact_ref: "artifacts/technical-brief.md",
    spec_artifact_hash: briefHash,
    child_spec_review_ref: "reviews/spec-writer.json",
  };
  continuation.configuration = {
    mode: run.mode || "headless", github_account: run.github_account ?? null, pr_mode: run.pr_mode || "ready",
    max_parallel_slices: 3, max_retries: 3,
    post_pr_policy: structuredClone((run.post_pr || { policy: { enabled: false, wait_ms: 3_600_000, initial_poll_ms: 30_000, max_poll_ms: 120_000, check_start_grace_ms: 300_000, max_transient_errors: 12, review: { required: false, reviewer_login: null, source: "none" } } }).policy),
  };
  continuation.carry_forward = {
    scope: "full-remaining-plan",
    plan_ref: "plan/slices.json",
    plan_hash: hashFile(join(runDir, "plan", "slices.json")),
    start_commit: startCommit,
    accepted_slices: run.slices.filter((slice) => acceptedSet.has(slice.id)).map((slice) => ({
      id: slice.id,
      attempts: slice.attempts,
      evidence_ref: slice.evidence_ref,
      evidence_hash: slice.evidence_hash,
      review_ref: slice.review_ref,
      review_hash: slice.review_hash,
      reviewed_commit: slice.reviewed_commit,
      merge_commit: slice.merge_commit,
    })),
    remaining_slice_ids: [...remaining],
  };
  run.mode = run.mode || "headless";
  run.github_account = run.github_account ?? null;
  run.pr_mode = run.pr_mode || "ready";
  run.max_parallel_slices = 3;
  run.max_retries = 3;
  run.continuation = continuation;
  run.post_pr = run.post_pr || {
    schema_version: 1,
    policy: { enabled: false, wait_ms: 3_600_000, initial_poll_ms: 30_000, max_poll_ms: 120_000, check_start_grace_ms: 300_000, max_transient_errors: 12, review: { required: false, reviewer_login: null, source: "none" } },
    phase: "disabled", attempt: 0, observation: null, remediation: null, evidence_refs: [], continuation_review: null, terminal_fact: null, pr_operation: null,
  };
  run.continuation.configuration.mode = run.mode;
  run.continuation.configuration.github_account = run.github_account;
  run.continuation.configuration.pr_mode = run.pr_mode;
  run.continuation.configuration.post_pr_policy = structuredClone(run.post_pr.policy);
  run.steps = [
    {
      agent: "spec-writer", status: "accepted", attempts: 0,
      artifact_ref: "artifacts/technical-brief.md", review_ref: "reviews/spec-writer.json",
      acceptance: { artifact_ref: "artifacts/technical-brief.md", artifact_hash: briefHash, review_ref: "reviews/spec-writer.json", review_hash: specReviewHash },
      inherited_acceptance: { from_run_id: continuation.parent.run_id, parent_spec_review_ref: "reviews/spec-writer.json", artifact_hash: briefHash, review_hash: specReviewHash },
    },
    {
      agent: "work-decomposer", status: "accepted", attempts: 1,
      artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
      acceptance: {
        artifact_ref: "plan/slices.json", artifact_hash: hashFile(join(runDir, "plan", "slices.json")),
        review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(runDir, "reviews", "work-decomposer.json")),
      },
    },
  ];
  const inheritedReport = join(runDir, "artifacts", "validation-report.md");
  if (!existsSync(inheritedReport)) writeFileSync(inheritedReport, "synthetic parent validation report\n");
  publishSyntheticV2Parent(runDir, continuation);
  return run;
}

// The init + config + README-commit base is identical across all ~40 callers;
// only `branches` vary. Build it once per process and cpSync per repo, then add
// the (cheap) per-call branches. The copied .git carries the committed identity
// forward, so later commits in a fixture are unchanged and the base commit is
// byte-identical to a fresh init.
let runStateGitBase = null;

function runStateGitBase_() {
  if (!runStateGitBase) {
    const repo = mkdtempSync(join(tmpdir(), "run-state-git-template-"));
    runGit(repo, ["init", "-b", "main"]);
    runGit(repo, ["config", "user.email", "test@example.com"]);
    runGit(repo, ["config", "user.name", "Test"]);
    writeFileSync(join(repo, "README.md"), "test\n");
    runGit(repo, ["add", "README.md"]);
    runGit(repo, ["commit", "-m", "init"]);
    runStateGitBase = repo;
  }
  return runStateGitBase;
}

after(() => { if (runStateGitBase) rmSync(runStateGitBase, { recursive: true, force: true }); });

function initGitRepo(repo, branches = []) {
  cpSync(runStateGitBase_(), repo, { recursive: true });
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

function observedGit(cwd, args) {
  const proc = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  return { ok: proc.status === 0, status: proc.status, stdout: proc.stdout || "", stderr: proc.stderr || "" };
}

function rewriteMergeTree(repo, merge, mutate) {
  const firstParent = gitOutput(repo, ["rev-parse", `${merge.mergeCommit}^1`]);
  runGit(repo, ["reset", "--hard", merge.mergeCommit]);
  mutate(repo);
  runGit(repo, ["add", "-A", "--", ".", ":(exclude,top,glob).opencode/**"]);
  const tree = gitOutput(repo, ["write-tree"]);
  const tampered = gitOutput(repo, ["commit-tree", tree, "-p", firstParent, "-p", merge.reviewedCommit, "-m", "tampered merge tree"]);
  runGit(repo, ["update-ref", "refs/heads/main", tampered]);
  runGit(repo, ["reset", "--hard", tampered]);
  return tampered;
}

function baseRun(runId) {
  return createRunRecord({
    run_id: runId,
    slices: [{ id: "slice", status: "running", attempts: 1 }],
  });
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

function writeSeedPlan(runDir, projection) {
  mkdirSync(join(runDir, "plan"), { recursive: true });
  writeJson(join(runDir, "plan", "slices.json"), {
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: projection.map((slice) => ({
      id: slice.id,
      stack: slice.stack,
      paths: [`${slice.id}.txt`],
      depends_on: slice.depends_on,
      acceptance: [`${slice.id} accepted`],
      test_plan: [`test ${slice.id}`],
    })),
  });
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
