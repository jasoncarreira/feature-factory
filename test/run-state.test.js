import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "./helpers/git-fixture.js";
import { createPanelReviewRecord, createReviewRecord, createSliceAttemptReview, createSliceReviewRecord } from "./helpers/review-record-fixture.js";
import { createRunRecord } from "./helpers/run-record-fixture.js";
import { publishSyntheticV2Parent } from "./helpers/v2-parent-fixture.js";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSliceAttemptHistoryCurrent,
  assertSliceReviewBindingCurrent,
  classifyWholeStoryTestRoute,
  claimCheckedTestExecution,
  completeSliceBuilderTaskDispatch,
  completeSpecialBuilderTaskDispatch,
  completeCheckedTestExecution,
  heartbeatOnce,
  inspectApprovalHandoffReceipt,
  mutateRunJsonLocked,
  transitionCostUsage,
  transitionCheckpointProgressChildPublished,
  transitionCheckpointProgressClosed,
  transitionCheckpointProgressLaunched,
  transitionCheckpointProgressMerged,
  transitionCheckpointProgressReserved,
  transitionGateDecision,
  transitionIntegrationAmendment,
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
  prepareSpecialBuilderTaskDispatch,
  RunJsonLockContendedError,
  withRunJsonLock,
} from "../src/run-state.js";
import { MAX_COST_ATTRIBUTION_ENTRIES, recomputeCostAttribution } from "../src/cost-attribution.js";
import { assertIntegrationAmendmentConsistency, checkRunConsistency, integrationAmendmentId } from "../src/validate.js";
import { hashFile, hashValue } from "../src/refs.js";
import { git } from "../src/git.js";
import { deliveryEnvelopeForSlices, passingInvariantFamilyLedger, withDeliveryEnvelope, writeVerificationArtifactReceipt } from "./helpers/delivery-envelope-fixture.js";

const NOW = "2026-07-08T12:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;
const ISSUE128_PUBLICATION_STATE_MODEL = Object.freeze({
  verdict: Object.freeze({ APPROVE: "admit-only-if-eligible", REJECT: "publish-empty-authority-after-exact-disclosure" }),
  git_status: Object.freeze({ A: "eligible-added", M: "eligible-content-modification", D: "deny", "R-source": "deny", "R-destination": "deny", "C-source": "deny", "C-destination": "deny", T: "deny", U: "deny", X: "deny", B: "deny", malformed: "deny", unobservable: "deny" }),
  tree_form: Object.freeze({ absent: "eligible-only-as-added-baseline", "100644 blob": "eligible-regular-file", "100755 blob": "eligible-regular-file", "mode-changed": "deny", symlink: "deny", submodule: "deny", other: "deny" }),
  owner_cardinality: Object.freeze({ 0: "eligible", 1: "eligible-only-for-qualified-content-modification", ">1": "deny" }),
  sole_owner_state: Object.freeze({ pending: "deny", running: "deny", "review-APPROVE": "eligible", "review-REJECT": "deny", merged: "eligible", blocked: "deny" }),
  owner_diff: Object.freeze({ touching: "deny", "non-touching": "eligible", unobservable: "deny" }),
  freshness: Object.freeze({ current: "eligible", "missing-ref": "deny", "ref-drift": "deny", "hash-drift": "deny", "byte-drift": "deny", "history-stale": "deny", "cross-bound": "deny" }),
});
const CONTROL_PLANE_PATH_CASES = Object.freeze([
  { name: "opencode-skills", path: ".opencode/skills/local/SKILL.md" },
  { name: "opencode-agents", path: ".opencode/agents/security.md" },
  { name: "opencode-other", path: ".opencode/runtime-policy.json" },
  { name: "claude-dot-directory", path: ".claude/settings.json" },
  { name: "cursor-dot-directory", path: ".cursor/rules/project.mdc" },
  { name: "codex-dot-directory", path: ".codex/config.toml" },
  { name: "gemini-dot-directory", path: ".gemini/settings.json" },
  { name: "agents-dot-directory", path: ".agents/config.json" },
  { name: "generic-root-dot-directory", path: ".future-control/policy.conf" },
  { name: "github-workflow", path: ".github/workflows/release.yml" },
  { name: "github-action", path: ".github/actions/setup/action.yml" },
  { name: "github-other", path: ".github/dependabot.yml" },
  { name: "gitea-root", path: ".gitea/workflows/ci.yml" },
  { name: "gitlab-root", path: ".gitlab/issue_templates/bug.md" },
  { name: "circleci-root", path: ".circleci/config.yml" },
  { name: "buildkite-root", path: ".buildkite/pipeline.yml" },
  { name: "teamcity-root", path: ".teamcity/settings.kts" },
  { name: "drone-directory", path: ".drone/pipeline.yml" },
  { name: "woodpecker-directory", path: ".woodpecker/pipeline.yml" },
  { name: "agents-instructions", path: "AGENTS.md" },
  { name: "agents-override-instructions", path: "AGENTS.override.md" },
  { name: "claude-instructions", path: "CLAUDE.md" },
  { name: "codex-instructions", path: "CODEX.md" },
  { name: "gemini-instructions", path: "GEMINI.md" },
  { name: "copilot-instructions", path: "COPILOT.md" },
  { name: "cursor-instructions", path: ".cursorrules" },
  { name: "forgejo-root", path: ".forgejo/workflows/ci.yml" },
  { name: "travis-provider", path: ".travis.yml" },
  { name: "drone-provider", path: ".drone.yml" },
  { name: "woodpecker-provider", path: ".woodpecker.yml" },
  { name: "azure-provider", path: "azure-pipelines.yml" },
  { name: "jenkins-provider", path: "Jenkinsfile" },
  { name: "bitrise-provider", path: "bitrise.yml" },
  { name: "appveyor-provider", path: "appveyor.yml" },
  { name: "aws-build-provider", path: "buildspec.yml" },
  { name: "google-build-provider", path: "cloudbuild.yaml" },
  { name: "codefresh-provider", path: "codefresh.yml" },
  { name: "wercker-provider", path: "wercker.yml" },
  { name: "shippable-provider", path: "shippable.yml" },
  { name: "container-build-file", path: "Containerfile" },
  { name: "earthly-build-file", path: "Earthfile" },
  { name: "deno-manifest", path: "deno.json" },
  { name: "nix-flake", path: "flake.nix" },
  { name: "generic-unknown-root-file", path: "future-provider.conf" },
  { name: "agent-assets", path: "assets/agent/new-agent.md" },
  { name: "skill-assets", path: "assets/skills/new-skill/SKILL.md" },
  { name: "command-assets", path: "assets/command/deploy.md" },
  { name: "dependency-manifest", path: "package.json" },
  { name: "build-manifest", path: "Makefile" },
  { name: "deployment-manifest", path: "deploy/app.yaml" },
  { name: "migration-artifact", path: "migrations/001.sql" },
  { name: "generated-artifact", path: "dist/output.js" },
]);

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

  it("rejects an incomplete test-verifier projection before creating an attempt", async () => {
    const fixture = createFixture("test-verifier-gate");
    try {
      writeJson(join(fixture.runDir, "run.json"), {
        ...baseRun(fixture.runId),
        max_retries: 3,
        slices: [
          writeModernReviewedSlice(fixture.runDir, "api", { status: "merged", mergeCommit: "abc123" }),
          { id: "ui", declared_paths: ["ui/**"], effective_paths: ["ui/**"], status: "running", attempts: 1 },
        ],
      });

      await assert.rejects(
        transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 1 }),
        /complete merged slice projection/u,
        "an unmerged slice must block the integration gate",
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
        /inherited_acceptance is immutable/u,
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

  it("rejects a merge whose Git path proof includes commits hidden from ownership review", async () => {
    const fixture = createFixture("slice-merge-hidden-predispatch-poison");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      const prepared = prepareSliceMergeState(fixture, {
        reviewedPath: "src/consumer.js",
        preDispatchPath: "src/owner.js",
      });
      const beforeRun = readFileSync(join(fixture.runDir, "run.json"));
      const beforeHead = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);

      await assert.rejects(
        transitionSliceMerged(fixture.runDir, "slice", { merge_commit: prepared.mergeCommit }),
        /merge base must equal its authorized baseline|merge path set must exactly equal its ownership-reviewed path set/u,
      );

      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), beforeRun);
      assert.equal(gitOutput(fixture.repo, ["rev-parse", "HEAD"]), beforeHead);
      assert.equal(readJson(join(fixture.runDir, "run.json")).slices[0].status, "review");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects a delivery-envelope merge when the APPROVE review lacks active ledger authority", async () => {
    const fixture = createFixture("slice-merge-missing-ledger-authority");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      const prepared = prepareSliceMergeState(fixture);
      const reviewPath = join(fixture.runDir, "reviews", "slice.json");
      const review = readJson(reviewPath);
      delete review.invariant_family_ledger;
      writeJson(reviewPath, review);
      const runPath = join(fixture.runDir, "run.json");
      const run = readJson(runPath);
      run.slices[0].review_hash = hashFile(reviewPath);
      run.slices[0].attempt_reviews[0].review_hash = run.slices[0].review_hash;
      writeJson(runPath, run);
      const before = readFileSync(runPath, "utf8");

      await assert.rejects(
        transitionSliceMerged(fixture.runDir, "slice", { merge_commit: prepared.mergeCommit }),
        /merge requires active approving invariant-family review authority: invariant-family-ledger-required/u,
      );
      assert.equal(readFileSync(runPath, "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("delegates textual integration conflicts and accepts only exact fresh integrated tests and panels", async () => {
    const fixture = createFixture("delegated-integration-conflict");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      const merge = prepareSliceMergeState(fixture, { reviewedPath: "README.md", integrationConflict: true });
      await assert.rejects(
        prepareSpecialBuilderTaskDispatch(fixture.repo, { run_id: fixture.runId, route: "integration-conflict", agent: "frontend-builder" }),
        /agent must match the effective conflict owner stack/u,
      );
      const token = "delegated-conflict-completion";
      const context = await prepareSpecialBuilderTaskDispatch(fixture.repo, {
        run_id: fixture.runId, route: "integration-conflict", agent: "backend-builder",
      }, { claimDispatch: true, completionToken: token });
      assert.equal(context.authority.conflict.integration_baseline, merge.integrationBaseline);
      assert.equal(context.authority.conflict.feature_head, merge.integrationBaseline);
      assert.equal(context.authority.conflict.merge_head, merge.reviewedCommit);
      assert.deepEqual(context.authority.conflict.conflict_paths, ["README.md"]);
      assert.deepEqual(context.authority.conflict.effective_owner, { slice_id: "slice", stack: "backend", kind: "sole-owner" });

      writeFileSync(join(fixture.repo, "README.md"), "builder-authored integrated resolution\n");
      runGit(fixture.repo, ["add", "README.md"]);
      runGit(fixture.repo, ["commit", "-m", "resolve delegated integration conflict"]);
      const resolutionHead = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      const closed = await completeSpecialBuilderTaskDispatch(fixture.repo, {
        run_id: fixture.runId, route: "integration-conflict", agent: "backend-builder",
        claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash, completion_token: token,
      });
      assert.equal(closed.completion_head, resolutionHead);
      assert.equal(closed.integration_proof.integrated_entries[0].path, "README.md");

      const integrated = await transitionSliceMerged(fixture.runDir, "slice", { merge_commit: resolutionHead });
      assert.equal(integrated.slice.status, "merged");
      assert.equal(classifyWholeStoryTestRoute(fixture.runDir, integrated.run), "delegated-conflict");
      assert.equal(classifyWholeStoryTestRoute(fixture.runDir, {
        ...integrated.run,
        continuation: { schema_version: 2, kind: "blocked-run-continuation" },
      }), "schema-v2+delegated-conflict", "combined schema-v2/conflict shape retains one exclusive checked route");
      assert.equal(integrated.run.special_builder_dispatch, undefined);
      assert.equal(integrated.slice.integration_conflict.status, "pending-integrated-review");
      assert.equal(integrated.slice.integration_conflict.resolution_commit, resolutionHead);
      await assert.rejects(
        transitionPanelVerdicts(fixture.runDir, { validator: { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" }, security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" } }),
        (error) => error?.message === "panel verdicts require fresh integrated conflict tests and review",
      );

      await transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 1 });
      const claimed = await claimCheckedTestExecution(fixture.runDir, { now: NOW, nonce: "123e4567-e89b-42d3-a456-426614174001" });
      const emptyStream = { captured_bytes: 0, sha256: `sha256:${createHash("sha256").digest("hex")}`, truncated: false };
      const receipt = {
        schema_version: 1, kind: "checked-test-execution-receipt", subject: "test-verifier", run_id: fixture.runId, attempt: 1,
        claim_nonce: claimed.claim.nonce, plan_ref: claimed.claim.plan_ref, plan_hash: claimed.claim.plan_hash, head_sha: resolutionHead, timeout_ms: claimed.claim.timeout_ms,
        started_at: NOW, completed_at: NOW, duration_ms: 0, status: "pass", review_ready: true,
        commands: claimed.authority.commands.map((command, index) => ({ index, ...command, outcome: "exited", status: "pass", exit_code: 0, signal: null, error_code: null, duration_ms: 0, stdout: emptyStream, stderr: emptyStream })),
      };
      await completeCheckedTestExecution(fixture.runDir, claimed.claim, claimed.authority, receipt, { now: NOW });
      writeFileSync(join(fixture.runDir, "artifacts", "test-report.md"), "integrated conflict tests pass\n");
      writeJson(join(fixture.runDir, "reviews", "test-verifier.attempt-1.json"), { subject: "test-verifier", attempt: 1, verdict: "APPROVE", reviewed_head_sha: resolutionHead, required_fixes: [] });
      const accepted = await transitionRunStep(fixture.runDir, "test-verifier", {
        status: "accepted", attempts: 1, artifact_ref: "artifacts/test-report.md", evidence_ref: claimed.claim.receipt_ref, review_ref: "reviews/test-verifier.attempt-1.json",
      }, { mustExist: true });
      assert.equal(accepted.run.slices[0].integration_conflict.status, "accepted");
      assert.equal(accepted.run.slices[0].integration_conflict.test_acceptance.reviewed_head_sha, resolutionHead);
      assert.deepEqual(accepted.run.slices[0].integration_conflict.test_acceptance, accepted.step.acceptance);
      assert.deepEqual(accepted.run.slices[0].integration_conflict.test_execution_claim, accepted.step.execution_claim);
      assert.equal(accepted.run.slices[0].integration_conflict.test_execution_claim_hash, accepted.step.execution_claim_hash);
      assert.deepEqual(accepted.run.slices[0].integration_conflict.test_artifact_snapshot, {
        ref: `artifacts/integration-conflicts/${createHash("sha256").update(`slice\0${resolutionHead}`, "utf8").digest("hex")}.test-report.md`,
        hash: accepted.step.acceptance.artifact_hash,
      });

      writeFileSync(join(fixture.runDir, "artifacts", "validation-report.md"), "GO\n");
      writeJson(join(fixture.runDir, "reviews", "implementation-validator.json"), createPanelReviewRecord({ subject: "main", attempt: 1, reviewedHeadSha: resolutionHead, verdict: "GO" }));
      writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), createPanelReviewRecord({ subject: "main", attempt: 1, reviewedHeadSha: resolutionHead, verdict: "PASS" }));
      const panels = await transitionPanelVerdicts(fixture.runDir, {
        validator: { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" },
        security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" },
      });
      assert.equal(panels.run.validator.reviewed_head_sha, resolutionHead);
      assert.equal(panels.run.security_review.reviewed_head_sha, resolutionHead);

      const originalPlanBytes = readFileSync(join(fixture.runDir, "plan", "slices.json"));
      const originalPlanHash = `sha256:${createHash("sha256").update(originalPlanBytes).digest("hex")}`;
      const combined = makeSyntheticV2Run(fixture.runDir, panels.run, { accepted: [], remaining: ["slice"] });
      writeFileSync(join(fixture.runDir, "plan", "slices.json"), originalPlanBytes);
      combined.continuation.carry_forward.plan_hash = originalPlanHash;
      combined.steps.find(({ agent }) => agent === "work-decomposer").acceptance.artifact_hash = originalPlanHash;
      const acceptedConflict = structuredClone(panels.run.slices[0].integration_conflict);
      const combinedPlannedSlice = JSON.parse(originalPlanBytes).slices[0];
      combined.slices[0].stack = combinedPlannedSlice.stack;
      combined.slices[0].depends_on = structuredClone(combinedPlannedSlice.depends_on);
      combined.slices[0].declared_paths = structuredClone(combinedPlannedSlice.paths);
      combined.slices[0].effective_paths = structuredClone(combinedPlannedSlice.paths);
      combined.slices[0].integration_conflict = structuredClone(acceptedConflict);
      combined.steps.push({ agent: "test-verifier", status: "blocked", attempts: 1 });
      writeJson(join(fixture.runDir, "run.json"), combined);
      assert.equal(classifyWholeStoryTestRoute(fixture.runDir, combined), "schema-v2+delegated-conflict");

      const startedCombined = await transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: 2 }, { mustExist: true });
      assert.equal(startedCombined.step.status, "running");
      assert.equal(startedCombined.step.attempts, 2);

      const parentCommit = combined.continuation.parent.commit;
      const movedParent = gitOutput(fixture.repo, ["commit-tree", `${resolutionHead}^{tree}`, "-p", resolutionHead, "-m", "move combined parent"]);
      runGit(fixture.repo, ["branch", "-f", combined.continuation.parent.branch, movedParent]);
      await assert.rejects(
        claimCheckedTestExecution(fixture.runDir, { now: NOW, nonce: "123e4567-e89b-42d3-a456-426614174002" }),
        (error) => error?.message === "schema-v2 parent branch no longer matches continuation parent commit",
      );
      runGit(fixture.repo, ["branch", "-f", combined.continuation.parent.branch, parentCommit]);

      const combinedBytes = readFileSync(join(fixture.runDir, "run.json"));
      const staleConflict = readJson(join(fixture.runDir, "run.json"));
      staleConflict.slices[0].integration_conflict.closure_hash = `sha256:${"f".repeat(64)}`;
      writeJson(join(fixture.runDir, "run.json"), staleConflict);
      await assert.rejects(
        claimCheckedTestExecution(fixture.runDir, { now: NOW, nonce: "123e4567-e89b-42d3-a456-426614174003" }),
        (error) => error?.message === "integration-conflict durable dispatch binding is stale",
      );
      writeFileSync(join(fixture.runDir, "run.json"), combinedBytes);

      const combinedClaim = await claimCheckedTestExecution(fixture.runDir, { now: NOW, nonce: "123e4567-e89b-42d3-a456-426614174004" });
      assert.equal(combinedClaim.claim.state, "active");
      const combinedReceipt = {
        schema_version: 1, kind: "checked-test-execution-receipt", subject: "test-verifier", run_id: fixture.runId, attempt: 2,
        claim_nonce: combinedClaim.claim.nonce, plan_ref: combinedClaim.claim.plan_ref, plan_hash: combinedClaim.claim.plan_hash,
        head_sha: resolutionHead, timeout_ms: combinedClaim.claim.timeout_ms, started_at: NOW, completed_at: NOW, duration_ms: 0,
        status: "pass", review_ready: true,
        commands: combinedClaim.authority.commands.map((command, index) => ({ index, ...command, outcome: "exited", status: "pass", exit_code: 0, signal: null, error_code: null, duration_ms: 0, stdout: emptyStream, stderr: emptyStream })),
      };
      const combinedCompletion = await completeCheckedTestExecution(fixture.runDir, combinedClaim.claim, combinedClaim.authority, combinedReceipt, { now: NOW });
      assert.equal(combinedCompletion.status, "pass");
      writeFileSync(join(fixture.runDir, "artifacts", "test-report.md"), "combined route tests pass\n");
      writeJson(join(fixture.runDir, "reviews", "test-verifier.attempt-2.json"), { subject: "test-verifier", attempt: 2, verdict: "APPROVE", reviewed_head_sha: resolutionHead, required_fixes: [] });
      const combinedAcceptance = await transitionRunStep(fixture.runDir, "test-verifier", {
        status: "accepted", attempts: 2, artifact_ref: "artifacts/test-report.md",
        evidence_ref: combinedClaim.claim.receipt_ref, review_ref: "reviews/test-verifier.attempt-2.json",
      }, { mustExist: true });
      assert.equal(combinedAcceptance.step.execution_claim.status, "pass");
      assert.equal(combinedAcceptance.step.acceptance.evidence_hash, combinedCompletion.receipt_hash);
      assert.equal(combinedAcceptance.step.acceptance.reviewed_head_sha, resolutionHead);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("retains two sequential delegated conflict proofs without a singular run-level fence", async () => {
    const fixture = createFixture("two-delegated-integration-conflicts");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      prepareSliceMergeState(fixture, { reviewedPath: "first.txt", integrationConflict: true });
      seedPendingSlice(fixture, { sliceId: "slice-two", reviewedPath: "second.txt" });
      const first = await resolveDelegatedConflict(fixture, "slice", "first.txt", "first conflict resolution", 1);

      prepareAdditionalSliceConflict(fixture, { sliceId: "slice-two", branch: "slice-two-branch", reviewedPath: "second.txt" });
      const second = await resolveDelegatedConflict(fixture, "slice-two", "second.txt", "second conflict resolution", 2);
      await acceptIntegratedConflict(fixture, second, 1);

      const run = readJson(join(fixture.runDir, "run.json"));
      assert.equal(Object.hasOwn(run, "integration_conflict"), false);
      assert.deepEqual(run.slices.map((slice) => ({ id: slice.id, status: slice.integration_conflict?.status, resolution: slice.integration_conflict?.resolution_commit })), [
        { id: "slice", status: "accepted", resolution: first },
        { id: "slice-two", status: "accepted", resolution: second },
      ]);
      assert.notEqual(run.slices[0].integration_conflict.claim_ref, run.slices[1].integration_conflict.claim_ref);
      assert.equal(run.special_builder_dispatch, undefined);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects rename/modify and rename/rename conflicts from checked delegation authority", async () => {
    for (const topology of ["rename-modify", "rename-rename"]) {
      const fixture = createFixture(`integration-conflict-${topology}`);
      try {
        initGitRepo(fixture.repo, ["slice-branch"]);
        prepareSliceMergeState(fixture, { reviewedPath: "renamed-by-slice.txt", integrationConflict: true, conflictTopology: topology });
        await assert.rejects(
          prepareSpecialBuilderTaskDispatch(fixture.repo, { run_id: fixture.runId, route: "integration-conflict", agent: "backend-builder" }),
          /rename or copy endpoint on a merge parent diff/u,
          topology,
        );
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  for (const { name, path: privilegedPath } of CONTROL_PLANE_PATH_CASES) {
    it(`enforces centralized control-plane integration admission for ${name}`, async () => {
      const declared = createFixture(`integration-declared-${name}`);
      try {
        initGitRepo(declared.repo, ["slice-branch"]);
        prepareSliceMergeState(declared, { reviewedPath: privilegedPath, integrationConflict: true });
        const context = await prepareSpecialBuilderTaskDispatch(declared.repo, { run_id: declared.runId, route: "integration-conflict", agent: "backend-builder" });
        assert.deepEqual(context.authority.conflict.conflict_paths, [privilegedPath]);
      } finally {
        cleanup(declared.repo);
      }

      const undeclared = createFixture(`integration-undeclared-${name}`);
      try {
        initGitRepo(undeclared.repo, ["slice-branch"]);
        prepareSliceMergeState(undeclared, { reviewedPath: privilegedPath, integrationConflict: true });
        makeConflictPathUndeclared(undeclared, privilegedPath);
        await assert.rejects(
          prepareSpecialBuilderTaskDispatch(undeclared.repo, { run_id: undeclared.runId, route: "integration-conflict", agent: "backend-builder" }),
          /privileged control-plane conflict path requires explicit declared plan ownership/u,
        );
      } finally {
        cleanup(undeclared.repo);
      }
    });
  }

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

  it("treats canonical magic-leading filenames literally and rejects invalid ownership filenames", async () => {
    for (const [index, reviewedPath] of [":(literal)payload", ":(glob)payload*"].entries()) {
      const fixture = createFixture(`merge-literal-path-${index}`);
      try {
        initGitRepo(fixture.repo, ["slice-branch"]);
        const merge = prepareSliceMergeState(fixture, { reviewedPath });
        const tamperedMerge = rewriteMergeTree(fixture.repo, merge, (repo) => writeFileSync(join(repo, reviewedPath), "different unreviewed blob\n"));
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(
          transitionSliceMerged(fixture.runDir, "slice", { merge_commit: tamperedMerge }),
          /presence, mode, type, or object identity|canonical ownership path|invalid ownership path/u,
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

  it("rejects legacy continuation state before PR fence or PR effects", async () => {
    const fixture = createFixture("pr-legacy-continuation-rejected");
    try {
      writeReadyPrRun(fixture, {
        continuation: continuationMetadata(fixture.runId),
      });
      const before = readFileSync(join(fixture.runDir, "run.json"));
      await assert.rejects(
        createPrTransition(fixture.runDir, {
          pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/103",
          pr_number: 103,
          repository: "jasoncarreira/opencode-feature-factory",
        }),
        /run\.continuation\.schema_version: must equal 2/u,
      );
      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), before);
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

  it("treats checkpoint_source runs as ordinary lifecycle records without consulting parent claims or refs", async () => {
    const fixture = createFixture("checkpoint-source-ordinary-writer");
    try {
      const run = readJson(join(fixture.runDir, "run.json"));
      run.checkpoint_source = checkpointSource("missing-routing-parent", fixture.runId);
      writeJson(join(fixture.runDir, "run.json"), run);

      const transitioned = await transitionRunJson(fixture.runDir, (draft) => {
        draft.review_tier = "strict";
      }, {
        gitFn() { throw new Error("ordinary writer consulted checkpoint Git authority"); },
      });

      assert.equal(transitioned.run.review_tier, "strict");
      assert.deepEqual(transitioned.run.checkpoint_source, run.checkpoint_source);
    } finally {
      cleanup(fixture.repo);
    }
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
      }, { repoRoot: panel.repo }), /complete merged slice projection/u);
      assert.equal(readFileSync(join(panel.runDir, "run.json"), "utf8"), before);
    } finally { cleanup(panel.repo); }

    const pending = createFixture("v2-pre-pr-create-bypass");
    try {
      initGitRepo(pending.repo);
      writeJson(join(pending.runDir, "run.json"), makeSyntheticV2Run(pending.runDir, baseRun(pending.runId), { remaining: ["slice"] }));
      writeFileSync(join(pending.runDir, "gates", "pre_pr.question.md"), "approve?\n");
      const before = readFileSync(join(pending.runDir, "run.json"), "utf8");
      await assert.rejects(transitionGateDecision(pending.runDir, "pre_pr", { status: "pending", artifact: "artifacts/story.md", question_ref: "gates/pre_pr.question.md" }), /complete merged slice projection/u);
      assert.equal(readFileSync(join(pending.runDir, "run.json"), "utf8"), before);
    } finally { cleanup(pending.repo); }

    const fence = createFixture("v2-fence-bypass");
    try {
      writeReadyPrRun(fence, { slices: [{ id: "slice", status: "blocked", attempts: 1, blocked_reason: "blocked" }] });
      const run = makeSyntheticV2Run(fence.runDir, readJson(join(fence.runDir, "run.json")), { remaining: ["slice"] });
      writeJson(join(fence.runDir, "run.json"), run);
      const prepared = preparePrTestOptions(fence.runDir, {});
      const before = readFileSync(join(fence.runDir, "run.json"), "utf8");
      await assert.rejects(transitionPrePrFenceEstablished(fence.runDir, prepared), /complete merged slice projection/u);
      assert.equal(readFileSync(join(fence.runDir, "run.json"), "utf8"), before);
    } finally { cleanup(fence.repo); }

  });

  it("admits v2 panels, pre-PR approval, fence, and PR only through fresh child test authority", async () => {
    const fixture = createFixture("v2-fresh-downstream-authority");
    try {
      writeReadyPrRun(fixture);
      const run = makeSyntheticV2Run(fixture.runDir, readJson(join(fixture.runDir, "run.json")), { remaining: ["slice"] });
      run.gates = {};
      run.validator = null;
      run.security_review = null;
      run.steps = run.steps.filter((step) => step.agent !== "test-verifier");
      run.steps.push({ agent: "test-verifier", status: "blocked", attempts: 0 });
      rmSync(join(fixture.runDir, "evidence", "test-verifier.attempt-1.json"));
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
        claim_nonce: claimed.claim.nonce, plan_ref: claimed.claim.plan_ref, plan_hash: claimed.claim.plan_hash, head_sha: head, timeout_ms: claimed.claim.timeout_ms,
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

      const acceptedV2RunBytes = readFileSync(join(fixture.runDir, "run.json"));
      const incompleteAfterAcceptance = readJson(join(fixture.runDir, "run.json"));
      incompleteAfterAcceptance.slices[0].status = "review";
      delete incompleteAfterAcceptance.slices[0].merge_commit;
      writeJson(join(fixture.runDir, "run.json"), incompleteAfterAcceptance);
      await assert.rejects(
        transitionRunJson(fixture.runDir, (draft) => { draft.review_tier = "strict"; }),
        /complete merged slice projection/u,
      );
      writeFileSync(join(fixture.runDir, "run.json"), acceptedV2RunBytes);

      const beforeMissingPanels = readFileSync(join(fixture.runDir, "run.json"));
      await assert.rejects(
        transitionGateDecision(fixture.runDir, "pre_pr", { status: "pending", artifact: "artifacts/story.md", question_ref: "gates/story.question.md" }),
        (error) => error?.message === "schema-v2 pre-PR gate requires fresh passing child panels before pre_pr pending",
      );
      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), beforeMissingPanels);

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
        transitionCostUsage(fixture.runDir, { agent: "backend-builder", input_tokens: 1 }, { now: NOW, id: "active-cost", livenessProbe: (pid) => ({ status: pid === process.pid ? "live" : "absent" }) }),
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
        mkdirSync(join(sliceWorktree, "extension"), { recursive: true });
        writeFileSync(join(sliceWorktree, "extension", "feature.txt"), "attempt 1\n");
        runGit(sliceWorktree, ["add", "extension/feature.txt"]);
        runGit(sliceWorktree, ["commit", "-m", "slice attempt 1"]);
        attemptOneHead = gitOutput(sliceWorktree, ["rev-parse", "HEAD"]);
      });

      mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
      mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
      writeJson(join(fixture.runDir, "evidence", "slice.attempt-1.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: attemptOneHead,
        ownership_disclosure: [{ path: "extension/feature.txt", rationale: "The slice implementation requires the adjacent feature entry point." }] });
      writeJson(join(fixture.runDir, "reviews", "slice.attempt-1.json"), createV2SliceReviewRecord({
        runDir: fixture.runDir, evidenceRef: "evidence/slice.attempt-1.json",
        subject: "slice", attempt: 1, reviewedCommit: attemptOneHead, verdict: "REJECT", requiredFixes: ["adjust implementation"],
        scopeEffect: "unowned-extension", likelyPaths: ["extension/feature.txt"],
      }));
      await transitionRunSlice(fixture.runDir, "slice", {
        status: "review",
        attempts: 1,
        branch: "slice-branch",
        worktree: sliceWorktree,
        evidence_ref: "evidence/slice.attempt-1.json",
        review_ref: "reviews/slice.attempt-1.json",
      });
      let ownership = readJson(join(fixture.runDir, "run.json")).slices[0];
      assert.deepEqual(ownership.effective_paths, ["src/**"]);
      assert.equal(ownership.attempt_reviews[0].diff_base_commit, run.base_commit);
      assert.deepEqual(ownership.attempt_reviews[0].ratified_paths, []);
      assertConsistent(fixture);

      await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 2 });
      assert.deepEqual(readJson(join(fixture.runDir, "run.json")).slices[0].effective_paths, ["src/**"], "retry clears effective ownership to the exact declared lane");
      let attemptTwoHead;
      const attemptTwoContext = await closeBuilderDispatch(fixture, 2, () => {
        writeFileSync(join(sliceWorktree, "extension", "feature.txt"), "attempt 2\n");
        runGit(sliceWorktree, ["add", "extension/feature.txt"]);
        runGit(sliceWorktree, ["commit", "-m", "slice attempt 2"]);
        attemptTwoHead = gitOutput(sliceWorktree, ["rev-parse", "HEAD"]);
      });
      assert.deepEqual(attemptTwoContext.slice.ownership, {
        declared_paths: ["src/**"], effective_paths: ["src/**"], forecast_unowned_extension_paths: ["extension/feature.txt"], disclosure_required_for_actual_unexpected_paths: true,
      });
      assert.notEqual(attemptTwoHead, attemptOneHead);

      writeJson(join(fixture.runDir, "evidence", "slice.attempt-2.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 2, head_sha: attemptTwoHead, previous_head: attemptOneHead,
        ownership_disclosure: [{ path: "extension/feature.txt", rationale: "The slice implementation requires the adjacent feature entry point." }] });
      writeJson(join(fixture.runDir, "reviews", "slice.attempt-2.json"), createV2SliceReviewRecord({ runDir: fixture.runDir, evidenceRef: "evidence/slice.attempt-2.json", subject: "slice", attempt: 2, reviewedCommit: attemptTwoHead, ratifiedPaths: ["extension/feature.txt"] }));
      const untampered = readJson(join(fixture.runDir, "run.json"));
      const tamperedBaseline = structuredClone(untampered);
      tamperedBaseline.slices[0].attempt_reviews[0].diff_base_commit = attemptOneHead;
      writeJson(join(fixture.runDir, "run.json"), tamperedBaseline);
      await assert.rejects(
        transitionRunSlice(fixture.runDir, "slice", {
          status: "review", attempts: 2, branch: "slice-branch", evidence_ref: "evidence/slice.attempt-2.json", review_ref: "reviews/slice.attempt-2.json",
        }),
        /stored diff baseline must equal the first checked dispatch commit/u,
      );
      writeJson(join(fixture.runDir, "run.json"), untampered);
      await transitionRunSlice(fixture.runDir, "slice", {
        status: "review",
        attempts: 2,
        branch: "slice-branch",
        evidence_ref: "evidence/slice.attempt-2.json",
        review_ref: "reviews/slice.attempt-2.json",
      });
      ownership = readJson(join(fixture.runDir, "run.json")).slices[0];
      assert.deepEqual(ownership.effective_paths, ["src/**", "extension/feature.txt"]);
      assert.equal(ownership.attempt_reviews[1].diff_base_commit, run.base_commit, "remediation review keeps the first dispatch baseline");
      assert.deepEqual(ownership.attempt_reviews[1].ratified_paths, ["extension/feature.txt"]);
      assertConsistent(fixture);

      runGit(fixture.repo, ["merge", "--no-ff", "slice-branch", "-m", "merge remediated slice"]);
      const integrationHead = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      await transitionSliceMerged(fixture.runDir, "slice", { merge_commit: integrationHead });
      await assert.rejects(
        transitionRunJson(fixture.runDir, (draft) => { draft.slices[0].effective_paths = ["src/**"]; }),
        /slices can only be changed by checked slice transitions/u,
      );
      assert.deepEqual(readJson(join(fixture.runDir, "run.json")).slices[0].effective_paths, ["src/**", "extension/feature.txt"]);
      assertConsistent(fixture);

      const checked = await acceptIntegratedConflict(fixture, integrationHead, 1);
      assert.equal(checked.step.execution_claim.status, "pass");
      assert.equal(checked.step.acceptance.reviewed_head_sha, integrationHead);
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
      assert.deepEqual(seeded.run.slices, projection.map((slice) => ({ ...slice, declared_paths: ["backend.txt"], effective_paths: ["backend.txt"] })));
      const bytes = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      const replay = await transitionSlicesSeed(fixture.runDir, projection, { from: "plan/slices.json" });
      assert.equal(replay.updated, false);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), bytes);
      const replacement = [{ id: "backend-next", stack: "backend", depends_on: [], status: "pending", attempts: 0 }];
      writeSeedPlan(fixture.runDir, replacement);
      const reseeded = await transitionSlicesSeed(fixture.runDir, replacement, { from: "plan/slices.json" });
      assert.deepEqual(reseeded.run.slices, replacement.map((slice) => ({ ...slice, declared_paths: ["backend-next.txt"], effective_paths: ["backend-next.txt"] })));
      await transitionRunSlice(fixture.runDir, "backend-next", { status: "running", attempts: 1 });
      const started = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(transitionSlicesSeed(fixture.runDir, replacement, { from: "plan/slices.json", force: true }), /after work has started/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), started);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects trailing-slash and unsupported-glob plans before seed or acceptance", async () => {
    for (const lane of ["src/", "src/*.js", "src/**/api.js"]) {
      for (const route of ["seed", "accept"]) {
        const fixture = createFixture(`invalid-plan-lane-${route}-${lane.replaceAll(/[^A-Za-z0-9]/gu, "-")}`);
        const projection = [{ id: "backend", stack: "backend", depends_on: [], status: "pending", attempts: 0 }];
        try {
          mkdirSync(join(fixture.runDir, "plan"), { recursive: true });
          writeJson(join(fixture.runDir, "plan", "slices.json"), withDeliveryEnvelope({
            integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
            slices: [{ id: "backend", stack: "backend", paths: [lane], depends_on: [], acceptance: ["AC1"], test_plan: ["node --test"] }],
          }));
          const run = { ...baseRun(fixture.runId), slices: route === "seed" ? [] : projection.map((slice) => ({ ...slice, declared_paths: ["src/**"], effective_paths: ["src/**"] })) };
          if (route === "accept") {
            mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
            writeJson(join(fixture.runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", verdict: "APPROVE" });
            run.steps = [{ agent: "work-decomposer", status: "running", attempts: 1 }];
          }
          writeJson(join(fixture.runDir, "run.json"), run);
          const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
          const transition = route === "seed"
            ? transitionSlicesSeed(fixture.runDir, projection, { from: "plan/slices.json" })
            : transitionRunStep(fixture.runDir, "work-decomposer", { status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json" }, { mustExist: true });
          await assert.rejects(transition, /invalid or ambiguous ownership lane/u, `${route}:${lane}`);
          assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, `${route}:${lane}`);
        } finally {
          cleanup(fixture.repo);
        }
      }
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
    const plan = withDeliveryEnvelope({
      integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
      slices: [{ id: "backend", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["AC1"], test_plan: ["node --test"] }],
    });
    try {
      mkdirSync(join(fixture.runDir, "plan"), { recursive: true });
      mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
      writeJson(join(fixture.runDir, "plan", "slices.json"), plan);
      writeJson(join(fixture.runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", verdict: "APPROVE" });
      writeJson(join(fixture.runDir, "run.json"), {
        ...baseRun(fixture.runId),
        slices: [{ id: "backend", stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status: "pending", attempts: 0 }],
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

  it("requires active approving ledger authority and re-observes its evidence before review publication", async () => {
    const fixture = createFixture("delivery-extension-publication");
    const planPath = join(fixture.runDir, "plan", "slices.json");
    const familyEvidencePath = join(fixture.runDir, "evidence", "slice-family.json");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      runGit(fixture.repo, ["checkout", "slice-branch"]);
      const head = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      writeJson(join(fixture.runDir, "run.json"), {
        ...baseRun(fixture.runId), branch: "slice-branch", worktree: fixture.repo, slices: [],
      });
      const projection = [{ id: "slice", stack: "backend", depends_on: [], status: "pending", attempts: 0 }];
      writeSeedPlan(fixture.runDir, projection);
      const seeded = await transitionSlicesSeed(fixture.runDir, projection, { from: "plan/slices.json" });
      assert.deepEqual(seeded.run.slices[0].declared_paths, ["slice.txt"]);

      seedBuilderDispatchAuthority(fixture);
      const acceptedRun = readJson(join(fixture.runDir, "run.json"));
      acceptedRun.slices[0].declared_paths = ["src/**"];
      acceptedRun.slices[0].effective_paths = ["src/**"];
      writeJson(join(fixture.runDir, "run.json"), acceptedRun);
      await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 1, branch: "slice-branch", worktree: fixture.repo });
      await closeBuilderDispatch(fixture, 1);
      mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
      writeJson(join(fixture.runDir, "evidence", "slice.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: head });
      const acceptedPlan = readJson(planPath);
      const checkedFamilyEvidence = writeVerificationArtifactReceipt({
        runDir: fixture.runDir, runId: fixture.runId, plan: acceptedPlan, sliceId: "slice", attempt: 1, reviewedCommit: head,
        artifactId: "fixture-artifact-1", evidenceRef: "evidence/slice-family.json",
        result: { type: "verification-result", outcome: "pass", summary: "Verify slice behavior passed" },
      });
      const passingLedger = passingInvariantFamilyLedger({
        plan: acceptedPlan,
        sliceId: "slice",
        reviewedCommit: head,
        evidenceRef: "evidence/slice-family.json",
        evidenceHash: checkedFamilyEvidence.hash,
      });
      const transition = () => transitionRunSlice(fixture.runDir, "slice", {
        status: "review", attempts: 1, evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json",
      });
      for (const [name, mutate, reason] of [
        ["absent ledger", (review) => { delete review.invariant_family_ledger; }, /invariant-family-ledger-required/u],
        ["missing family", (review) => { review.invariant_family_ledger.dispositions = []; }, /invariant-family-disposition-missing:fixture-family-1/u],
        ["failed result", (review) => { review.invariant_family_ledger.dispositions[0].result.outcome = "fail"; }, /claimed result does not match/u],
        ["skipped result", (review) => { review.invariant_family_ledger.dispositions[0].result.outcome = "skipped"; }, /claimed result does not match/u],
        ["unresolved finding", (review) => { review.invariant_family_ledger.dispositions[0].unresolved_findings = ["still unresolved"]; }, /invariant-family-unresolved-findings:fixture-family-1/u],
      ]) {
        const review = createV2SliceReviewRecord({ subject: "slice", attempt: 1, reviewedCommit: head });
        review.invariant_family_ledger = structuredClone(passingLedger);
        mutate(review);
        writeJson(join(fixture.runDir, "reviews", "slice.json"), review);
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(transition(), reason, name);
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, name);
      }

      const review = createV2SliceReviewRecord({ subject: "slice", attempt: 1, reviewedCommit: head });
      review.invariant_family_ledger = passingLedger;
      writeJson(join(fixture.runDir, "reviews", "slice.json"), review);
      const beforeRace = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(transitionRunSlice(fixture.runDir, "slice", {
        status: "review", attempts: 1, evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json",
      }, {
        atomicWriteHooks: { beforeCommit: () => writeJson(familyEvidencePath, { subject: "slice", family: "fixture-family-1", observed: false }) },
      }), /invariant family ledger evidence hash is stale|commit failed/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeRace);

      writeFileSync(familyEvidencePath, `${JSON.stringify(checkedFamilyEvidence.receipt, null, 2)}\n`);
      const published = await transition();
      assert.equal(published.slice.status, "review");
      assert.equal(published.slice.review_hash, hashFile(join(fixture.runDir, "reviews", "slice.json")));
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects REJECT review publication without an invariant-family ledger and mutates nothing", async () => {
    const fixture = createFixture("reject-publication-missing-ledger");
    try {
      const prepared = await prepareRejectReviewPublication(fixture);
      delete prepared.review.invariant_family_ledger;
      writeJson(prepared.reviewPath, prepared.review);
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");

      await assert.rejects(
        publishPreparedSliceReview(fixture),
        /publication requires complete current invariant-family review ledger: invariant-family-ledger-required/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects REJECT review publication with a missing family disposition and mutates nothing", async () => {
    const fixture = createFixture("reject-publication-missing-family");
    try {
      const prepared = await prepareRejectReviewPublication(fixture);
      prepared.review.invariant_family_ledger.dispositions = [];
      writeJson(prepared.reviewPath, prepared.review);
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");

      await assert.rejects(
        publishPreparedSliceReview(fixture),
        /publication requires complete current invariant-family review ledger: invariant-family-disposition-missing:fixture-family-1/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("publishes a complete failing REJECT ledger without granting merge authority", async () => {
    const fixture = createFixture("reject-publication-complete-failing-ledger");
    try {
      const prepared = await prepareRejectReviewPublication(fixture);
      const [disposition] = prepared.review.invariant_family_ledger.dispositions;
      disposition.result = { type: "verification-result", outcome: "fail", summary: "The invariant failed" };
      disposition.unresolved_findings = ["The invariant remains unresolved"];
      const plan = readJson(join(fixture.runDir, "plan", "slices.json"));
      const checked = writeVerificationArtifactReceipt({
        runDir: fixture.runDir, runId: fixture.runId, plan, sliceId: "slice", attempt: 1,
        reviewedCommit: prepared.review.reviewed_commit, artifactId: "fixture-artifact-1",
        evidenceRef: disposition.evidence_ref, result: disposition.result,
      });
      disposition.evidence_hash = checked.hash;
      writeJson(prepared.reviewPath, prepared.review);

      const published = await publishPreparedSliceReview(fixture);
      assert.equal(published.slice.status, "review");
      assert.equal(published.slice.review_ref, "reviews/slice.json");
      assert.equal(published.slice.review_hash, hashFile(prepared.reviewPath));
      assert.equal(published.slice.attempt_reviews[0].ownership_schema_version, 2);
      assert.deepEqual(published.slice.attempt_reviews[0].ratified_paths, []);
      assert.deepEqual(published.slice.attempt_reviews[0].modified_extensions, []);
      assert.deepEqual(published.slice.effective_paths, published.slice.declared_paths);
      const beforeMerge = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(
        transitionSliceMerged(fixture.runDir, "slice", { merge_commit: "abc123" }),
        /merge requires APPROVE review/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeMerge);
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
      writeJson(planPath, withDeliveryEnvelope({
        integration_gate: { required_commands: [{ program: "node", args: ["--test", "test/acceptance.test.js"] }, { program: "npm", args: ["run", "check"] }] },
        slices: [{ id: "backend", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["AC1"], test_plan: ["node --test"] }],
      }));
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");

      await assert.rejects(
        transitionSlicesSeed(fixture.runDir, projection, {
          from: "plan/slices.json",
          atomicWriteHooks: {
            beforeCommit() {
              writeJson(planPath, withDeliveryEnvelope({
                integration_gate: { required_commands: [{ program: "node", args: ["--test", "test/other.test.js"] }, { program: "npm", args: ["run", "check"] }] },
                slices: [{ id: "backend", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["AC1"], test_plan: ["node --test"] }],
              }));
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
          const pending = { id: "slice", stack: "backend", depends_on: [], declared_paths: ["slice.txt"], effective_paths: ["slice.txt"], status: "pending", attempts: 0, [field]: value };
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
      writeJson(join(slice.runDir, "run.json"), { ...baseRun(slice.runId), branch: "slice-branch", worktree: slice.repo, slices: [{ id: "slice", declared_paths: ["src/**"], effective_paths: ["src/**"], status: "running", attempts: 1, branch: "slice-branch", worktree: slice.repo }] });
      seedBuilderDispatchAuthority(slice);
      await closeBuilderDispatch(slice, 1);
      mkdirSync(join(slice.runDir, "evidence"), { recursive: true });
      mkdirSync(join(slice.runDir, "reviews"), { recursive: true });
      const evidence = { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: sliceHead };
      writeJson(join(slice.runDir, "evidence", "slice.json"), evidence);
      const review = createV2SliceReviewRecord({ runDir: slice.runDir, evidenceRef: "evidence/slice.json", subject: "slice", attempt: 1, reviewedCommit: sliceHead });
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
        slices: [{ id: "slice", stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status: "pending", attempts: 0 }],
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
      writeJson(join(fixture.runDir, "reviews", "slice-1.json"), createV2SliceReviewRecord({ runDir: fixture.runDir, evidenceRef: "evidence/slice-1.json", subject: "slice", attempt: 1, reviewedCommit: head, verdict: "REJECT", requiredFixes: ["fix the rejected slice"] }));
      await transitionRunSlice(fixture.runDir, "slice", { status: "review", attempts: 1, evidence_ref: "evidence/slice-1.json", review_ref: "reviews/slice-1.json" });
      await assert.rejects(transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 1 }), /advance exactly to attempt 2/u);
      const retry = await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 2 });
      assert.equal(retry.slice.attempts, 2);
      assert.equal(Object.hasOwn(retry.slice, "review_ref"), false);
      await closeBuilderDispatch(fixture, 2);
      writeJson(join(fixture.runDir, "evidence", "slice-2.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 2, head_sha: head });
      writeJson(join(fixture.runDir, "reviews", "slice-2.json"), createV2SliceReviewRecord({ runDir: fixture.runDir, evidenceRef: "evidence/slice-2.json", subject: "slice", attempt: 2, reviewedCommit: head }));
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
        slices: [{ id: "slice", stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status: "pending", attempts: 0 }],
      });
      seedBuilderDispatchAuthority(fixture);
      const planPath = join(fixture.runDir, "plan", "slices.json");
      const plan = readJson(planPath);
      plan.slices.push({ id: "sibling", stack: "backend", paths: ["test/**"], depends_on: [], acceptance: ["sibling works"], test_plan: ["test sibling"] });
      plan.delivery_envelope = deliveryEnvelopeForSlices(plan.slices);
      writeJson(planPath, plan);
      const run = readJson(join(fixture.runDir, "run.json"));
      run.slices.push({ id: "sibling", stack: "backend", depends_on: [], declared_paths: ["test/**"], effective_paths: ["test/**"], status: "pending", attempts: 0 });
      run.steps.find((step) => step.agent === "work-decomposer").acceptance.artifact_hash = hashFile(planPath);
      writeJson(join(fixture.runDir, "run.json"), run);

      await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 1, branch: "slice-branch", worktree: fixture.repo });
      await closeBuilderDispatch(fixture, 1);
      mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
      writeJson(join(fixture.runDir, "evidence", "slice-1.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: head });
      writeJson(join(fixture.runDir, "reviews", "slice-1.json"), createV2SliceReviewRecord({
        runDir: fixture.runDir,
        evidenceRef: "evidence/slice-1.json",
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

  for (const { name, path: changedPath } of CONTROL_PLANE_PATH_CASES) {
    it(`enforces centralized control-plane ownership ratification for ${name}`, async () => {
      const fixture = createFixture(`ownership-control-plane-${name}`);
      try {
        initGitRepo(fixture.repo, ["slice-branch"]);
        runGit(fixture.repo, ["checkout", "slice-branch"]);
        writeJson(join(fixture.runDir, "run.json"), {
          ...baseRun(fixture.runId), branch: "slice-branch", worktree: fixture.repo,
          slices: [{ id: "slice", stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status: "pending", attempts: 0 }],
        });
        seedBuilderDispatchAuthority(fixture);
        await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 1, branch: "slice-branch", worktree: fixture.repo });
        let reviewedCommit;
        await closeBuilderDispatch(fixture, 1, () => {
          mkdirSync(join(fixture.repo, ...changedPath.split("/").slice(0, -1)), { recursive: true });
          writeFileSync(join(fixture.repo, changedPath), `${name}\n`);
          runGit(fixture.repo, ["add", "-f", "--", changedPath]);
          runGit(fixture.repo, ["commit", "-m", `change ${name} control-plane path`]);
          reviewedCommit = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
        });
        mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
        writeJson(join(fixture.runDir, "evidence", "slice.json"), {
          subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: reviewedCommit,
          ownership_disclosure: [{ path: changedPath, rationale: `The ${name} fixture probes centralized privileged-path enforcement.` }],
        });
        writeJson(join(fixture.runDir, "reviews", "slice.json"), createV2SliceReviewRecord({ runDir: fixture.runDir, evidenceRef: "evidence/slice.json", subject: "slice", attempt: 1, reviewedCommit, ratifiedPaths: [changedPath] }));
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(
          transitionRunSlice(fixture.runDir, "slice", { status: "review", attempts: 1, evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json" }),
          /privileged control-plane path/u,
        );
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
      } finally {
        cleanup(fixture.repo);
      }
    });
  }

  it("derives exact v2 authority for a disclosed content-only modification of a pre-existing unowned file", async () => {
    const fixture = createFixture("ownership-modified-unowned-v2");
    try {
      initGitRepo(fixture.repo);
      mkdirSync(join(fixture.repo, "docs"), { recursive: true });
      writeFileSync(join(fixture.repo, "docs", "pre-existing.md"), "baseline bytes\n");
      chmodSync(join(fixture.repo, "docs", "pre-existing.md"), 0o755);
      runGit(fixture.repo, ["add", "docs/pre-existing.md"]);
      runGit(fixture.repo, ["commit", "-m", "seed unowned file"]);
      runGit(fixture.repo, ["branch", "slice-branch"]);
      const sliceWorktree = join(fixture.repo, ".opencode", "worktrees", "slice");
      mkdirSync(join(fixture.repo, ".opencode", "worktrees"), { recursive: true });
      runGit(fixture.repo, ["worktree", "add", sliceWorktree, "slice-branch"]);
      writeJson(join(fixture.runDir, "run.json"), {
        ...baseRun(fixture.runId), branch: "main", worktree: fixture.repo,
        slices: [{ id: "slice", stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status: "pending", attempts: 0 }],
      });
      seedBuilderDispatchAuthority(fixture);
      await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 1, branch: "slice-branch", worktree: sliceWorktree });
      let reviewedCommit;
      await closeBuilderDispatch(fixture, 1, () => {
        writeFileSync(join(sliceWorktree, "docs", "pre-existing.md"), "reviewed bytes\n");
        runGit(sliceWorktree, ["add", "docs/pre-existing.md"]);
        runGit(sliceWorktree, ["commit", "-m", "modify unowned file"]);
        reviewedCommit = gitOutput(sliceWorktree, ["rev-parse", "HEAD"]);
      });
      mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
      const rationale = "The existing documentation file must change with this slice behavior.";
      writeJson(join(fixture.runDir, "evidence", "slice.json"), {
        subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: reviewedCommit,
        ownership_disclosure: [{ path: "docs/pre-existing.md", rationale }],
      });
      const successorReview = createV2SliceReviewRecord({
        runDir: fixture.runDir, evidenceRef: "evidence/slice.json", subject: "slice", attempt: 1, reviewedCommit,
      });
      writeJson(join(fixture.runDir, "reviews", "slice.json"), successorReview);
      for (const [status, expected] of [
        ["A", /must be absent at the first checked dispatch baseline/u],
        ["D", /unsafe Git change kind 'deleted'/u],
        ["T", /unsafe Git change kind 'type-changed'/u],
        ["U", /unsafe Git change kind 'unmerged'/u],
        ["X", /unsafe Git change kind 'unknown'/u],
        ["B", /unsafe Git change kind 'broken'/u],
        ["Q", /change kinds contain an invalid status/u],
        [null, /slice ownership change kinds cannot be observed/u],
      ]) {
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(
          transitionRunSlice(fixture.runDir, "slice", {
            status: "review", attempts: 1, evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json",
          }, {
            gitFn(cwd, args) {
              if (args[0] === "diff" && args[1] === "--name-status") {
                return status === null
                  ? { ok: false, status: 1, stdout: "", stderr: "unobservable" }
                  : { ok: true, status: 0, stdout: `${status}\0docs/pre-existing.md\0`, stderr: "" };
              }
              return observedGit(cwd, args);
            },
          }),
          expected,
          status ?? "unobservable",
        );
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, status ?? "unobservable");
      }
      for (const [name, statusBytes, expectedKind] of [
        ["rename-source", "R100\0docs/pre-existing.md\0docs/other.md\0", "renamed"],
        ["rename-destination", "R100\0docs/other.md\0docs/pre-existing.md\0", "renamed"],
        ["copy-source", "C100\0docs/pre-existing.md\0docs/other.md\0", "copied"],
        ["copy-destination", "C100\0docs/other.md\0docs/pre-existing.md\0", "copied"],
        ["rename-source-then-modified", "R100\0docs/pre-existing.md\0docs/other.md\0M\0docs/pre-existing.md\0", "renamed"],
        ["rename-destination-then-modified", "R100\0docs/other.md\0docs/pre-existing.md\0M\0docs/pre-existing.md\0", "renamed"],
        ["copy-source-then-modified", "C100\0docs/pre-existing.md\0docs/other.md\0M\0docs/pre-existing.md\0", "copied"],
        ["copy-destination-then-modified", "C100\0docs/other.md\0docs/pre-existing.md\0M\0docs/pre-existing.md\0", "copied"],
      ]) {
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(
          transitionRunSlice(fixture.runDir, "slice", {
            status: "review", attempts: 1, evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json",
          }, {
            gitFn(cwd, args) {
              if (args[0] === "diff" && args[1] === "--name-status") return { ok: true, status: 0, stdout: statusBytes, stderr: "" };
              return observedGit(cwd, args);
            },
          }),
          new RegExp(`unsafe Git change kind '${expectedKind}'`, "u"),
          name,
        );
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, name);
      }
      for (const [name, treeResult, expected] of [
        ["absent", { ok: true, status: 0, stdout: "", stderr: "" }, /must remain a private regular file/u],
        ["submodule", { ok: true, status: 0, stdout: `160000 commit ${"a".repeat(40)}\tdocs/pre-existing.md\0`, stderr: "" }, /must remain a private regular file/u],
        ["other", { ok: true, status: 0, stdout: `040000 tree ${"a".repeat(40)}\tdocs/pre-existing.md\0`, stderr: "" }, /must remain a private regular file/u],
        ["malformed", { ok: true, status: 0, stdout: "malformed\0", stderr: "" }, /tree entry 'docs\/pre-existing\.md' is malformed or ambiguous/u],
        ["unobservable", { ok: false, status: 1, stdout: "", stderr: "unobservable" }, /cannot observe ratification tree entry/u],
      ]) {
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(
          transitionRunSlice(fixture.runDir, "slice", {
            status: "review", attempts: 1, evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json",
          }, {
            gitFn(cwd, args) {
              if (args[0] === "ls-tree" && args[2] === reviewedCommit && args.at(-1) === ":(literal)docs/pre-existing.md") return treeResult;
              return observedGit(cwd, args);
            },
          }),
          expected,
          name,
        );
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, name);
      }
      writeJson(join(fixture.runDir, "reviews", "slice.json"), {
        ...successorReview,
        ownership_ratification: { schema_version: 1, paths: ["docs/pre-existing.md"] },
      });
      const beforeLegacyPublication = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(
        transitionRunSlice(fixture.runDir, "slice", {
          status: "review", attempts: 1, evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json",
        }),
        /new checked review publication requires pathless ownership_ratification schema_version 2/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeLegacyPublication);
      writeJson(join(fixture.runDir, "reviews", "slice.json"), successorReview);

      const published = await transitionRunSlice(fixture.runDir, "slice", {
        status: "review", attempts: 1, evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json",
      });
      assert.deepEqual(published.slice.effective_paths, ["src/**", "docs/pre-existing.md"]);
      assert.equal(published.slice.attempt_reviews[0].ownership_schema_version, 2);
      assert.deepEqual(published.slice.attempt_reviews[0].ratified_paths, ["docs/pre-existing.md"]);
      assert.deepEqual(published.slice.attempt_reviews[0].modified_extensions, [
        { kind: "modified-extension", path: "docs/pre-existing.md", rationale, authority: "unowned" },
      ]);
      assert.match(gitOutput(fixture.repo, ["ls-tree", reviewedCommit, "docs/pre-existing.md"]), /^100755 blob /u);

      runGit(fixture.repo, ["merge", "--no-ff", "slice-branch", "-m", "merge modified unowned file"]);
      const mergeCommit = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      const runPath = join(fixture.runDir, "run.json");
      const evidencePath = join(fixture.runDir, "evidence", "slice.json");
      const originalRunBytes = readFileSync(runPath, "utf8");
      const originalEvidenceBytes = readFileSync(evidencePath, "utf8");
      const changedEvidence = readJson(evidencePath);
      changedEvidence.ownership_disclosure[0].rationale = "A different rationale must not inherit the reviewed authority.";
      writeJson(evidencePath, changedEvidence);
      const changedRun = readJson(runPath);
      const changedSlice = changedRun.slices.find((slice) => slice.id === "slice");
      changedSlice.evidence_hash = hashFile(evidencePath);
      changedSlice.attempt_reviews[0].evidence_hash = changedSlice.evidence_hash;
      writeJson(runPath, changedRun);
      const tamperedRunBytes = readFileSync(runPath, "utf8");
      await assert.rejects(
        transitionSliceMerged(fixture.runDir, "slice", { merge_commit: mergeCommit }),
        /modified-extension evidence is stale|persisted modified-extension authority is stale|review history is stale/u,
      );
      assert.equal(readFileSync(runPath, "utf8"), tamperedRunBytes);
      writeFileSync(evidencePath, originalEvidenceBytes);
      writeFileSync(runPath, originalRunBytes);
      const merged = await transitionSliceMerged(fixture.runDir, "slice", { merge_commit: mergeCommit });
      assert.equal(merged.slice.status, "merged");
      assert.deepEqual(merged.slice.effective_paths, ["src/**", "docs/pre-existing.md"]);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("keeps an immutable historical v1 review mergeable only through its original policy", async () => {
    const fixture = createFixture("ownership-historical-v1-merge");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      const prepared = prepareSliceMergeState(fixture, { reviewedPath: "extension/slice.txt" });
      const reviewPath = join(fixture.runDir, "reviews", "slice.json");
      const review = readJson(reviewPath);
      review.ownership_ratification = { schema_version: 1, paths: [] };
      writeJson(reviewPath, review);
      const runPath = join(fixture.runDir, "run.json");
      const run = readJson(runPath);
      const slice = run.slices.find((candidate) => candidate.id === "slice");
      const history = slice.attempt_reviews[0];
      const planPath = join(fixture.runDir, "plan", "slices.json");
      const plan = readJson(planPath);
      plan.slices[0].paths = ["src/**"];
      writeJson(planPath, plan);
      run.steps.find((step) => step.agent === "work-decomposer").acceptance.artifact_hash = hashFile(planPath);
      slice.declared_paths = ["src/**"];
      slice.effective_paths = ["src/**", "extension/slice.txt"];
      history.ratified_paths = ["extension/slice.txt"];
      delete history.ownership_schema_version;
      delete history.modified_extensions;
      const evidencePath = join(fixture.runDir, "evidence", "slice.json");
      const evidence = readJson(evidencePath);
      evidence.ownership_disclosure = [{
        path: "extension/slice.txt",
        rationale: "The historical review disclosed its newly added unowned extension.",
      }];
      writeJson(evidencePath, evidence);
      slice.evidence_hash = hashFile(evidencePath);
      history.evidence_hash = slice.evidence_hash;
      review.ownership_ratification = { schema_version: 1, paths: ["extension/slice.txt"] };
      const unit = plan.delivery_envelope.delivery_units.find((candidate) => candidate.slice_id === "slice");
      const familyEvidence = writeVerificationArtifactReceipt({
        runDir: fixture.runDir, runId: fixture.runId, plan, sliceId: "slice", attempt: 1,
        reviewedCommit: prepared.reviewedCommit, artifactId: unit.verification_artifacts[0].id,
        evidenceRef: "evidence/slice-family.json",
        result: { type: "verification-result", outcome: "pass", summary: `${unit.invariant_families[0].description} passed` },
      });
      review.invariant_family_ledger = passingInvariantFamilyLedger({
        plan, sliceId: "slice", reviewedCommit: prepared.reviewedCommit,
        evidenceRef: "evidence/slice-family.json", evidenceHash: familyEvidence.hash,
      });
      writeJson(reviewPath, review);
      slice.review_hash = hashFile(reviewPath);
      history.review_hash = slice.review_hash;
      writeJson(runPath, run);

      const validRunBytes = readFileSync(runPath);
      const validEvidenceBytes = readFileSync(evidencePath);
      for (const [label, ownershipDisclosure] of [
        ["missing", undefined],
        ["inaccurate", [{ path: "extension/other.txt", rationale: "This path was not in the reviewed diff." }]],
      ]) {
        const invalidEvidence = readJson(evidencePath);
        if (ownershipDisclosure === undefined) delete invalidEvidence.ownership_disclosure;
        else invalidEvidence.ownership_disclosure = ownershipDisclosure;
        writeJson(evidencePath, invalidEvidence);
        const invalidRun = readJson(runPath);
        const invalidSlice = invalidRun.slices.find((candidate) => candidate.id === "slice");
        invalidSlice.evidence_hash = hashFile(evidencePath);
        invalidSlice.attempt_reviews[0].evidence_hash = invalidSlice.evidence_hash;
        writeJson(runPath, invalidRun);
        const before = readFileSync(runPath);
        await assert.rejects(
          transitionSliceMerged(fixture.runDir, "slice", { merge_commit: prepared.mergeCommit }),
          /ownership_disclosure/u,
          label,
        );
        assert.deepEqual(readFileSync(runPath), before, label);
        writeFileSync(evidencePath, validEvidenceBytes);
        writeFileSync(runPath, validRunBytes);
      }

      const merged = await transitionSliceMerged(fixture.runDir, "slice", { merge_commit: prepared.mergeCommit });
      assert.equal(merged.slice.status, "merged");
      assert.equal(Object.hasOwn(merged.slice.attempt_reviews[0], "ownership_schema_version"), false);
      assert.equal(Object.hasOwn(merged.slice.attempt_reviews[0], "modified_extensions"), false);
      assert.deepEqual(merged.slice.attempt_reviews[0].ratified_paths, ["extension/slice.txt"]);
      assert.deepEqual(merged.slice.effective_paths, ["src/**", "extension/slice.txt"]);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("freezes sole non-touching sibling authority and defers modifying merge until that owner merges unchanged", async () => {
    const fixture = createFixture("ownership-modified-sibling-v2");
    try {
      const prepared = await prepareSiblingModificationFixture(fixture);
      const run = readJson(join(fixture.runDir, "run.json"));
      const owner = run.slices.find((slice) => slice.id === "owner");
      const modifier = run.slices.find((slice) => slice.id === "modifier");
      const ownerAttempt = owner.attempt_reviews[0];
      const rationale = "The modifier must update the existing sibling-owned compatibility fixture.";
      assert.equal(owner.status, "review");
      assert.deepEqual(modifier.effective_paths, ["src/**", "test/shared.test.js"]);
      assert.deepEqual(modifier.attempt_reviews[0].modified_extensions, [{
        kind: "modified-extension",
        path: "test/shared.test.js",
        rationale,
        authority: "non-conflicting-sibling",
        owner_slice_id: "owner",
        owner_attempt: 1,
        owner_evidence_ref: owner.evidence_ref,
        owner_evidence_hash: owner.evidence_hash,
        owner_review_ref: owner.review_ref,
        owner_review_hash: owner.review_hash,
        owner_dispatch_claim_ref: ownerAttempt.dispatch_claim_ref,
        owner_dispatch_claim_hash: ownerAttempt.dispatch_claim_hash,
        owner_dispatch_closure_ref: ownerAttempt.dispatch_closure_ref,
        owner_dispatch_closure_hash: ownerAttempt.dispatch_closure_hash,
        owner_reviewed_commit: owner.reviewed_commit,
        owner_diff_base_commit: ownerAttempt.diff_base_commit,
      }]);

      runGit(fixture.repo, ["merge", "--no-ff", "modifier-branch", "-m", "integrate modifier first"]);
      const modifierIntegration = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      const beforeDeniedMerge = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(
        transitionSliceMerged(fixture.runDir, "modifier", { merge_commit: modifierIntegration }),
        /cannot merge sibling-owned path 'test\/shared\.test\.js' while owner 'owner' remains in review/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeDeniedMerge);

      runGit(fixture.repo, ["reset", "--hard", prepared.baseline]);
      runGit(fixture.repo, ["merge", "--no-ff", "owner-branch", "-m", "integrate owner"]);
      const ownerIntegration = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      const ownerMerged = await transitionSliceMerged(fixture.runDir, "owner", { merge_commit: ownerIntegration });
      assert.equal(ownerMerged.slice.status, "merged");
      runGit(fixture.repo, ["worktree", "remove", prepared.ownerWorktree]);
      runGit(fixture.repo, ["branch", "-D", "owner-branch"]);
      runGit(fixture.repo, ["merge", "--no-ff", "modifier-branch", "-m", "integrate modifier after owner"]);
      const combinedIntegration = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      const modifierMerged = await transitionSliceMerged(fixture.runDir, "modifier", { merge_commit: combinedIntegration });
      assert.equal(modifierMerged.slice.status, "merged");
      assert.deepEqual(modifierMerged.slice.attempt_reviews[0].modified_extensions, modifier.attempt_reviews[0].modified_extensions);
      assert.deepEqual(modifierMerged.slice.effective_paths, ["src/**", "test/shared.test.js"]);
      assert.equal(prepared.modifierReviewedCommit, modifier.reviewed_commit);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("publishes the same frozen sibling provenance when the sole owner is already merged", async () => {
    const fixture = createFixture("ownership-modified-sibling-owner-merged");
    try {
      const prepared = await prepareSiblingModificationFixture(fixture, { publishModifier: false });
      runGit(fixture.repo, ["merge", "--no-ff", "owner-branch", "-m", "integrate owner before modifier review"]);
      const ownerMerge = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      await transitionSliceMerged(fixture.runDir, "owner", { merge_commit: ownerMerge });
      runGit(fixture.repo, ["worktree", "remove", prepared.ownerWorktree]);
      runGit(fixture.repo, ["branch", "-D", "owner-branch"]);
      const runPath = join(fixture.runDir, "run.json");
      const validRun = readFileSync(runPath);
      const invalid = readJson(runPath);
      invalid.slices.find((slice) => slice.id === "owner").merge_commit = prepared.baseline;
      writeJson(runPath, invalid);
      const before = readFileSync(runPath);
      await assert.rejects(
        transitionRunSlice(fixture.runDir, "modifier", {
          status: "review", attempts: 1, evidence_ref: "evidence/modifier.json", review_ref: "reviews/modifier.json",
        }),
        /merge commit must have exactly two ordered parents/u,
      );
      assert.deepEqual(readFileSync(runPath), before);
      writeFileSync(runPath, validRun);
      const published = await transitionRunSlice(fixture.runDir, "modifier", {
        status: "review", attempts: 1, evidence_ref: "evidence/modifier.json", review_ref: "reviews/modifier.json",
      });
      assert.equal(published.slice.attempt_reviews[0].modified_extensions[0].authority, "non-conflicting-sibling");
      assert.equal(published.slice.attempt_reviews[0].modified_extensions[0].owner_slice_id, "owner");
      assert.deepEqual(published.slice.effective_paths, ["src/**", "test/shared.test.js"]);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("denies every incomplete, stale, touching, or ineligible sole-sibling authority state without publication", async () => {
    const cases = [
      {
        name: "pending",
        expected: /owner 'owner' is not in review or merged/u,
        mutate: async (fixture) => {
          const run = readJson(join(fixture.runDir, "run.json"));
          const owner = run.slices.find((slice) => slice.id === "owner");
          run.slices[run.slices.indexOf(owner)] = {
            id: "owner", stack: "backend", depends_on: [], declared_paths: ["test/**"], effective_paths: ["test/**"], status: "pending", attempts: 0,
          };
          writeJson(join(fixture.runDir, "run.json"), run);
        },
      },
      {
        name: "running",
        expected: /owner 'owner' is not in review or merged/u,
        mutate: async (fixture) => {
          const run = readJson(join(fixture.runDir, "run.json"));
          const owner = run.slices.find((slice) => slice.id === "owner");
          owner.status = "running";
          owner.attempts = 2;
          owner.effective_paths = [...owner.declared_paths];
          for (const key of ["evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "dispatch_required", "dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash"]) delete owner[key];
          writeJson(join(fixture.runDir, "run.json"), run);
        },
      },
      {
        name: "blocked",
        expected: /owner 'owner' is not in review or merged/u,
        mutate: async (fixture) => { await transitionRunSlice(fixture.runDir, "owner", { status: "blocked", blocked_reason: "owner blocked" }); },
      },
      {
        name: "missing-ref",
        expected: /missing reviews ref/u,
        mutate: async (fixture) => { rmSync(join(fixture.runDir, "reviews", "owner.json")); },
      },
      {
        name: "ref-drift",
        expected: /must equal the current attempt_reviews review_ref/u,
        mutate: async (fixture) => {
          const run = readJson(join(fixture.runDir, "run.json"));
          run.slices.find((slice) => slice.id === "owner").review_ref = "reviews/modifier.json";
          writeJson(join(fixture.runDir, "run.json"), run);
        },
      },
      {
        name: "hash-drift",
        expected: /successor review hashes are stale/u,
        mutate: async (fixture) => {
          const run = readJson(join(fixture.runDir, "run.json"));
          const owner = run.slices.find((slice) => slice.id === "owner");
          owner.review_hash = `sha256:${"f".repeat(64)}`;
          owner.attempt_reviews[0].review_hash = owner.review_hash;
          writeJson(join(fixture.runDir, "run.json"), run);
        },
      },
      {
        name: "byte-drift",
        expected: /successor review hashes are stale/u,
        mutate: async (fixture) => {
          const path = join(fixture.runDir, "reviews", "owner.json");
          writeFileSync(path, `${readFileSync(path, "utf8")} `);
        },
      },
      {
        name: "history-stale",
        expected: /must equal the current attempt_reviews evidence_hash/u,
        mutate: async (fixture) => {
          const run = readJson(join(fixture.runDir, "run.json"));
          run.slices.find((slice) => slice.id === "owner").attempt_reviews[0].evidence_hash = `sha256:${"f".repeat(64)}`;
          writeJson(join(fixture.runDir, "run.json"), run);
        },
      },
      {
        name: "cross-bound",
        expected: /history is cross-bound|stored diff baseline must equal the first checked dispatch commit/u,
        mutate: async (fixture, prepared) => {
          const run = readJson(join(fixture.runDir, "run.json"));
          run.slices.find((slice) => slice.id === "owner").attempt_reviews[0].diff_base_commit = gitOutput(fixture.repo, ["rev-parse", `${prepared.baseline}^`]);
          writeJson(join(fixture.runDir, "run.json"), run);
        },
      },
      {
        name: "unobservable",
        expected: /requires existing branch 'owner-branch'/u,
        mutate: async (fixture, prepared) => {
          runGit(fixture.repo, ["worktree", "remove", prepared.ownerWorktree]);
          runGit(fixture.repo, ["branch", "-D", "owner-branch"]);
        },
      },
    ];

    for (const { name, expected, mutate } of cases) {
      const fixture = createFixture(`ownership-sibling-${name}`);
      try {
        const prepared = await prepareSiblingModificationFixture(fixture, { publishModifier: false });
        await mutate(fixture, prepared);
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(
          transitionRunSlice(fixture.runDir, "modifier", {
            status: "review", attempts: 1, evidence_ref: "evidence/modifier.json", review_ref: "reviews/modifier.json",
          }),
          expected,
          name,
        );
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, name);
      } finally {
        cleanup(fixture.repo);
      }
    }

    for (const [name, options, expected] of [
      ["review-REJECT", { ownerVerdict: "REJECT", publishModifier: false }, /review is not APPROVE/u],
      ["touching", { ownerTouchesShared: true, publishModifier: false }, /reviewed diff touches it/u],
    ]) {
      const fixture = createFixture(`ownership-sibling-${name}`);
      try {
        await prepareSiblingModificationFixture(fixture, options);
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(
          transitionRunSlice(fixture.runDir, "modifier", {
            status: "review", attempts: 1, evidence_ref: "evidence/modifier.json", review_ref: "reviews/modifier.json",
          }),
          expected,
          name,
        );
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, name);
      } finally {
        cleanup(fixture.repo);
      }
    }

    const unobservable = createFixture("ownership-sibling-full-diff-unobservable");
    try {
      const prepared = await prepareSiblingModificationFixture(unobservable, { publishModifier: false });
      const before = readFileSync(join(unobservable.runDir, "run.json"), "utf8");
      await assert.rejects(
        transitionRunSlice(unobservable.runDir, "modifier", {
          status: "review", attempts: 1, evidence_ref: "evidence/modifier.json", review_ref: "reviews/modifier.json",
        }, {
          gitFn(cwd, args) {
            if (args[0] === "diff" && args[1] === "--name-only" && args.at(-1) === prepared.ownerReviewedCommit) {
              return { ok: false, status: 1, stdout: "", stderr: "unobservable sibling full diff" };
            }
            return observedGit(cwd, args);
          },
        }),
        /full sibling reviewed diff cannot be observed/u,
      );
      assert.equal(readFileSync(join(unobservable.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(unobservable.repo);
    }
  });

  it("executes the closed issue-128 publication model and exact REJECT disclosure boundary", async () => {
    assert.deepEqual(ISSUE128_PUBLICATION_STATE_MODEL, {
      verdict: { APPROVE: "admit-only-if-eligible", REJECT: "publish-empty-authority-after-exact-disclosure" },
      git_status: { A: "eligible-added", M: "eligible-content-modification", D: "deny", "R-source": "deny", "R-destination": "deny", "C-source": "deny", "C-destination": "deny", T: "deny", U: "deny", X: "deny", B: "deny", malformed: "deny", unobservable: "deny" },
      tree_form: { absent: "eligible-only-as-added-baseline", "100644 blob": "eligible-regular-file", "100755 blob": "eligible-regular-file", "mode-changed": "deny", symlink: "deny", submodule: "deny", other: "deny" },
      owner_cardinality: { 0: "eligible", 1: "eligible-only-for-qualified-content-modification", ">1": "deny" },
      sole_owner_state: { pending: "deny", running: "deny", "review-APPROVE": "eligible", "review-REJECT": "deny", merged: "eligible", blocked: "deny" },
      owner_diff: { touching: "deny", "non-touching": "eligible", unobservable: "deny" },
      freshness: { current: "eligible", "missing-ref": "deny", "ref-drift": "deny", "hash-drift": "deny", "byte-drift": "deny", "history-stale": "deny", "cross-bound": "deny" },
    });

    const fixture = createFixture("ownership-reject-disclosure-model");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      runGit(fixture.repo, ["checkout", "slice-branch"]);
      writeJson(join(fixture.runDir, "run.json"), {
        ...baseRun(fixture.runId), branch: "slice-branch", worktree: fixture.repo,
        slices: [{ id: "slice", stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status: "pending", attempts: 0 }],
      });
      seedBuilderDispatchAuthority(fixture);
      await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 1, branch: "slice-branch", worktree: fixture.repo });
      let reviewedCommit;
      await closeBuilderDispatch(fixture, 1, () => {
        mkdirSync(join(fixture.repo, "docs"), { recursive: true });
        writeFileSync(join(fixture.repo, "docs", "a.md"), "a\n");
        writeFileSync(join(fixture.repo, "docs", "z.md"), "z\n");
        runGit(fixture.repo, ["add", "docs/a.md", "docs/z.md"]);
        runGit(fixture.repo, ["commit", "-m", "add disclosed reject paths"]);
        reviewedCommit = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      });
      mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
      const evidencePath = join(fixture.runDir, "evidence", "slice.json");
      const reviewPath = join(fixture.runDir, "reviews", "slice.json");
      writeJson(reviewPath, createV2SliceReviewRecord({
        runDir: fixture.runDir, evidenceRef: "evidence/slice.json", subject: "slice", attempt: 1, reviewedCommit,
        verdict: "REJECT", requiredFixes: ["Repair the rejected implementation"],
      }));
      const validDisclosure = [
        { path: "docs/a.md", rationale: "The first documentation fixture is required by this rejected attempt." },
        { path: "docs/z.md", rationale: "The second documentation fixture is required by this rejected attempt." },
      ];
      // The factory derives the out-of-lane set, so the builder no longer echoes
      // it back. What still rejects is missing prose for a derived path - named
      // specifically rather than reported as a set mismatch - and malformed
      // rationale content.
      const invalidCases = [
        ["missing", undefined, /must explain changed path 'docs\/a\.md'/u],
        ["wrong-path", [validDisclosure[0], { ...validDisclosure[1], path: "docs/y.md" }], /must explain changed path 'docs\/z\.md'/u],
        ["empty-rationale", [{ ...validDisclosure[0], rationale: "" }, validDisclosure[1]], /nonempty normalized text/u],
        ["non-nfc-rationale", [{ ...validDisclosure[0], rationale: "Cafe\u0301 rationale" }, validDisclosure[1]], /nonempty normalized text/u],
      ];
      for (const [name, ownershipDisclosure, expected] of invalidCases) {
        const evidence = { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: reviewedCommit };
        if (ownershipDisclosure !== undefined) evidence.ownership_disclosure = ownershipDisclosure;
        writeJson(evidencePath, evidence);
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(publishPreparedSliceReview(fixture), expected, name);
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, name);
      }
      for (const codePoint of [...Array.from({ length: 32 }, (_unused, index) => index), 0x7f, ...Array.from({ length: 32 }, (_unused, index) => 0x80 + index)]) {
        writeJson(evidencePath, {
          subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: reviewedCommit,
          ownership_disclosure: [{ ...validDisclosure[0], rationale: `Control${String.fromCodePoint(codePoint)}rationale` }, validDisclosure[1]],
        });
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(publishPreparedSliceReview(fixture), /nonempty normalized text/u, `U+${codePoint.toString(16).padStart(4, "0")}`);
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, `U+${codePoint.toString(16).padStart(4, "0")}`);
      }
      // Set-shape disagreements the builder used to be rejected for are now
      // absorbed: an extra path that is actually in-lane is ignored, and order
      // and duplication come from the derived set rather than the input.
      const absorbedCases = [
        ["extra", [...validDisclosure, { path: "docs/zz.md", rationale: "Extra path that is not out-of-lane." }]],
        ["unsorted", [...validDisclosure].reverse()],
        ["duplicate", [validDisclosure[0], validDisclosure[0], validDisclosure[1]]],
      ];
      const pristineRun = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      for (const [name, ownershipDisclosure] of absorbedCases) {
        writeJson(evidencePath, { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: reviewedCommit, ownership_disclosure: ownershipDisclosure });
        const absorbed = await publishPreparedSliceReview(fixture);
        assert.deepEqual(absorbed.slice.attempt_reviews[0].modified_extensions, [], name);
        assert.deepEqual(absorbed.slice.effective_paths, ["src/**"], name);
        writeFileSync(join(fixture.runDir, "run.json"), pristineRun);
      }

      writeJson(evidencePath, { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: reviewedCommit, ownership_disclosure: validDisclosure });
      const published = await publishPreparedSliceReview(fixture);
      assert.deepEqual(published.slice.attempt_reviews[0].ratified_paths, []);
      assert.deepEqual(published.slice.attempt_reviews[0].modified_extensions, []);
      assert.deepEqual(published.slice.effective_paths, ["src/**"]);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("re-derives every persisted v2 sibling authority field in history and consistency readers", async () => {
    const fixture = createFixture("ownership-v2-field-reobservation");
    try {
      await prepareSiblingModificationFixture(fixture);
      const runPath = join(fixture.runDir, "run.json");
      const original = readJson(runPath);
      const extension = original.slices.find((slice) => slice.id === "modifier").attempt_reviews[0].modified_extensions[0];
      const fieldMutations = Object.keys(extension).map((key) => [key, (value) => {
        value[key] = typeof value[key] === "number" ? value[key] + 1 : `${value[key]}-stale`;
      }]);
      fieldMutations.push(
        ["ownership_schema_version", (_extension, entry) => { entry.ownership_schema_version = 1; }],
        ["ratified_paths", (_extension, entry) => { entry.ratified_paths = ["test/other.test.js"]; }],
        ["modified_extensions", (_extension, entry) => { entry.modified_extensions = []; }],
      );
      for (const [field, mutate] of fieldMutations) {
        const candidate = structuredClone(original);
        const slice = candidate.slices.find((item) => item.id === "modifier");
        const entry = slice.attempt_reviews[0];
        mutate(entry.modified_extensions[0], entry);
        writeJson(runPath, candidate);
        assert.throws(() => assertSliceAttemptHistoryCurrent(fixture.runDir, "modifier", slice), /stale|invalid|unsafe|authority|must equal|must exactly|must be/u, field);
        assert.equal(checkRunConsistency(fixture.runDir, candidate).ok, false, field);
      }
      writeJson(runPath, original);
      assert.doesNotThrow(() => assertSliceAttemptHistoryCurrent(fixture.runDir, "modifier", original.slices.find((slice) => slice.id === "modifier")));
      assert.equal(checkRunConsistency(fixture.runDir, original).ok, true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("re-observes every frozen sibling authority source before accepting persisted v2 history", async () => {
    const cases = [
      ["owner-evidence-result", (fixture, run, owner, extension) => {
        const evidencePath = join(fixture.runDir, owner.evidence_ref);
        const evidence = readJson(evidencePath);
        evidence.status = "fail";
        writeJson(evidencePath, evidence);
        owner.evidence_hash = hashFile(evidencePath);
        owner.attempt_reviews[0].evidence_hash = owner.evidence_hash;
        extension.owner_evidence_hash = owner.evidence_hash;
      }, /evidence authority is stale|review authority is stale/u],
      ["checked-invariant-receipt", (fixture, run, owner, extension) => {
        const reviewPath = join(fixture.runDir, owner.review_ref);
        const review = readJson(reviewPath);
        const ledgerEntry = review.invariant_family_ledger.dispositions[0];
        const receiptPath = join(fixture.runDir, ledgerEntry.evidence_ref);
        const receipt = readJson(receiptPath);
        receipt.review_ready = false;
        writeJson(receiptPath, receipt);
        const receiptHash = hashFile(receiptPath);
        ledgerEntry.evidence_hash = receiptHash;
        const claimPath = join(fixture.runDir, ledgerEntry.evidence_ref.replace(/\.json$/u, ".claim.json"));
        const claim = readJson(claimPath);
        claim.receipt_hash = receiptHash;
        writeJson(claimPath, claim);
        writeJson(reviewPath, review);
        owner.review_hash = hashFile(reviewPath);
        owner.attempt_reviews[0].review_hash = owner.review_hash;
        extension.owner_review_hash = owner.review_hash;
      }, /review_ready|invariant-family checked receipt authority is stale or cross-bound/u],
      ["dispatch-claim-binding", (fixture, run, owner, extension) => {
        const entry = owner.attempt_reviews[0];
        const claimPath = join(fixture.runDir, entry.dispatch_claim_ref);
        const closurePath = join(fixture.runDir, entry.dispatch_closure_ref);
        const claim = readJson(claimPath);
        claim.branch = "cross-bound-owner-branch";
        writeJson(claimPath, claim);
        entry.dispatch_claim_hash = hashFile(claimPath);
        const closure = readJson(closurePath);
        closure.branch = claim.branch;
        closure.claim_hash = entry.dispatch_claim_hash;
        writeJson(closurePath, closure);
        entry.dispatch_closure_hash = hashFile(closurePath);
        owner.dispatch_claim_hash = entry.dispatch_claim_hash;
        owner.dispatch_closure_hash = entry.dispatch_closure_hash;
        extension.owner_dispatch_claim_hash = entry.dispatch_claim_hash;
        extension.owner_dispatch_closure_hash = entry.dispatch_closure_hash;
      }, /dispatch claim authority is stale or cross-bound/u],
      ["dispatch-completion-head", (fixture, run, owner, extension) => {
        const entry = owner.attempt_reviews[0];
        const closurePath = join(fixture.runDir, entry.dispatch_closure_ref);
        const closure = readJson(closurePath);
        closure.completion_head = entry.diff_base_commit;
        writeJson(closurePath, closure);
        entry.dispatch_closure_hash = hashFile(closurePath);
        owner.dispatch_closure_hash = entry.dispatch_closure_hash;
        extension.owner_dispatch_closure_hash = entry.dispatch_closure_hash;
      }, /dispatch closure authority is stale or cross-bound/u],
      ["reviewed-worktree-head", (fixture, _run, owner) => {
        writeFileSync(join(owner.worktree, "unreviewed-source.txt"), "unreviewed\n");
      }, /reviewed branch\/worktree head is stale/u],
    ];

    for (const [name, mutate, expected] of cases) {
      const fixture = createFixture(`ownership-v2-source-${name}`);
      try {
        await prepareSiblingModificationFixture(fixture);
        const runPath = join(fixture.runDir, "run.json");
        const run = readJson(runPath);
        const owner = run.slices.find((slice) => slice.id === "owner");
        const modifier = run.slices.find((slice) => slice.id === "modifier");
        const extension = modifier.attempt_reviews[0].modified_extensions[0];
        mutate(fixture, run, owner, extension);
        writeJson(runPath, run);
        const before = readFileSync(runPath, "utf8");
        assert.throws(() => assertSliceAttemptHistoryCurrent(fixture.runDir, "modifier", modifier), expected, name);
        assert.equal(checkRunConsistency(fixture.runDir, run).ok, false, name);
        assert.equal(readFileSync(runPath, "utf8"), before, name);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("denies every persisted v2 sibling field drift at merge without mutating durable state", async () => {
    const fixture = createFixture("ownership-v2-merge-fields");
    try {
      const prepared = await prepareSiblingModificationFixture(fixture);
      runGit(fixture.repo, ["merge", "--no-ff", "owner-branch", "-m", "integrate owner for field drift test"]);
      const ownerMerge = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      await transitionSliceMerged(fixture.runDir, "owner", { merge_commit: ownerMerge });
      runGit(fixture.repo, ["merge", "--no-ff", "modifier-branch", "-m", "integrate modifier for field drift test"]);
      const modifierMerge = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      const runPath = join(fixture.runDir, "run.json");
      const original = readJson(runPath);

      for (const [name, mutate] of persistedV2FieldMutationCases({ sibling: true })) {
        const candidate = structuredClone(original);
        const modifier = candidate.slices.find((slice) => slice.id === "modifier");
        const entry = modifier.attempt_reviews[0];
        mutate(entry, entry.modified_extensions[0]);
        writeJson(runPath, candidate);
        const before = readFileSync(runPath, "utf8");
        await assert.rejects(
          transitionSliceMerged(fixture.runDir, "modifier", { merge_commit: modifierMerge }),
          /stale|invalid|unsafe|must equal|must exactly|modified-extension|integer from 2|not allowed/u,
          name,
        );
        assert.equal(readFileSync(runPath, "utf8"), before, name);
        assert.equal(modifier.reviewed_commit, prepared.modifierReviewedCommit, name);
      }
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("denies every frozen sibling source drift at merge without mutating durable state", async () => {
    for (const [name, mutate] of persistedSiblingSourceMutationCases()) {
      const fixture = createFixture(`ownership-v2-merge-source-${name}`);
      try {
        await prepareSiblingModificationFixture(fixture);
        runGit(fixture.repo, ["merge", "--no-ff", "owner-branch", "-m", "integrate owner for source drift test"]);
        const ownerMerge = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
        await transitionSliceMerged(fixture.runDir, "owner", { merge_commit: ownerMerge });
        runGit(fixture.repo, ["merge", "--no-ff", "modifier-branch", "-m", "integrate modifier for source drift test"]);
        const modifierMerge = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
        const runPath = join(fixture.runDir, "run.json");
        const run = readJson(runPath);
        mutate(fixture, run, run.slices.find((slice) => slice.id === "owner"));
        const before = readFileSync(runPath, "utf8");
        await assert.rejects(
          transitionSliceMerged(fixture.runDir, "modifier", { merge_commit: modifierMerge }),
          /stale|cross-bound|review_ready|authority|binding/u,
          name,
        );
        assert.equal(readFileSync(runPath, "utf8"), before, name);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("denies every applicable owner U2 field drift in integration amendment consistency", async () => {
    const fixture = await prepareReportedIntegrationAmendmentFixture("amendment-owner-u2-fields");
    try {
      const runPath = join(fixture.runDir, "run.json");
      const original = readJson(runPath);
      const originalOwner = original.slices.find((slice) => slice.id === "owner");
      assert.equal(original.integration_amendment.status, "reported");
      assert.equal(originalOwner.attempt_reviews[0].modified_extensions[0].authority, "unowned");
      assert.doesNotThrow(() => assertIntegrationAmendmentConsistency(fixture.runDir, original));
      runGit(fixture.repo, ["worktree", "remove", originalOwner.worktree]);
      runGit(fixture.repo, ["branch", "-D", originalOwner.branch]);
      assert.doesNotThrow(() => assertIntegrationAmendmentConsistency(fixture.runDir, original));

      for (const [name, mutate] of persistedV2FieldMutationCases({ sibling: false })) {
        const candidate = structuredClone(original);
        const owner = candidate.slices.find((slice) => slice.id === "owner");
        const entry = owner.attempt_reviews[0];
        mutate(entry, entry.modified_extensions[0]);
        writeJson(runPath, candidate);
        const before = readFileSync(runPath, "utf8");
        assert.throws(
          () => assertIntegrationAmendmentConsistency(fixture.runDir, candidate),
          /snapshot is stale|stale|invalid|must equal|modified-extension/u,
          name,
        );
        assert.equal(readFileSync(runPath, "utf8"), before, name);
      }
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("denies every progressed-consumer S2 field drift in integration amendment consistency", async () => {
    const fixture = await prepareReportedIntegrationAmendmentFixture("amendment-consumer-s2-fields", { progressedConsumer: true });
    try {
      const runPath = join(fixture.runDir, "run.json");
      const original = readJson(runPath);
      const originalConsumer = original.slices.find((slice) => slice.id === "consumer");
      const originalOwner = original.slices.find((slice) => slice.id === "owner");
      assert.equal(originalConsumer.status, "running");
      assert.equal(originalConsumer.attempt_reviews[0].modified_extensions[0].authority, "non-conflicting-sibling");
      assert.doesNotThrow(() => assertIntegrationAmendmentConsistency(fixture.runDir, original));
      runGit(fixture.repo, ["worktree", "remove", originalOwner.worktree]);
      runGit(fixture.repo, ["branch", "-D", originalOwner.branch]);
      assert.doesNotThrow(() => assertIntegrationAmendmentConsistency(fixture.runDir, original));

      for (const [name, mutate] of persistedV2FieldMutationCases({ sibling: true })) {
        const candidate = structuredClone(original);
        const consumer = candidate.slices.find((slice) => slice.id === "consumer");
        const entry = consumer.attempt_reviews[0];
        mutate(entry, entry.modified_extensions[0]);
        writeJson(runPath, candidate);
        const before = readFileSync(runPath, "utf8");
        assert.throws(
          () => assertIntegrationAmendmentConsistency(fixture.runDir, candidate),
          /consumer attempt 1 review authority is stale|stale|invalid|must equal|modified-extension/u,
          name,
        );
        assert.equal(readFileSync(runPath, "utf8"), before, name);
      }
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("denies every progressed-consumer S2 owner-source drift without mutating durable state", async () => {
    for (const [name, mutate] of persistedSiblingSourceMutationCases()) {
      const fixture = await prepareReportedIntegrationAmendmentFixture(`amendment-consumer-s2-source-${name}`, { progressedConsumer: true });
      try {
        const runPath = join(fixture.runDir, "run.json");
        const run = readJson(runPath);
        const owner = run.slices.find((slice) => slice.id === "owner");
        assert.doesNotThrow(() => assertIntegrationAmendmentConsistency(fixture.runDir, run), `${name}:baseline`);
        runGit(fixture.repo, ["worktree", "remove", owner.worktree]);
        runGit(fixture.repo, ["branch", "-D", owner.branch]);
        assert.doesNotThrow(() => assertIntegrationAmendmentConsistency(fixture.runDir, run), `${name}:cleaned`);
        mutate(fixture, run, owner);
        const before = readFileSync(runPath, "utf8");
        assert.throws(
          () => assertIntegrationAmendmentConsistency(fixture.runDir, run),
          /stale|cross-bound|review_ready|authority|binding/u,
          name,
        );
        assert.equal(readFileSync(runPath, "utf8"), before, name);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("denies a progressed amendment consumer with a non-feature baseline without mutating durable state", async () => {
    const fixture = await prepareReportedIntegrationAmendmentFixture("amendment-progressed-consumer-baseline", { progressedConsumer: true });
    try {
      const runPath = join(fixture.runDir, "run.json");
      const run = readJson(runPath);
      const consumer = run.slices.find((slice) => slice.id === "consumer");
      consumer.authorized_baseline_commit = run.integration_amendment.admission.owner.reviewed_commit;
      writeJson(runPath, run);
      const before = readFileSync(runPath, "utf8");
      assert.throws(() => assertIntegrationAmendmentConsistency(fixture.runDir, run), /authorized baseline is not an exact checked feature head/u);
      assert.equal(readFileSync(runPath, "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects unsafe APPROVE extension kinds and added sibling-owned files", async () => {
    for (const [name, changedPath, addSibling, expected, kind = "file", disclosedPaths = [changedPath]] of [
      ["sibling", "test/sibling.test.js", true, /cannot be inside a sibling ownership lane/u],
      ["mode", "docs/mode.md", false, /must be content-only with unchanged mode/u, "mode"],
      ["symlink", "docs/link.md", false, /cannot ratify symlink or submodule path 'docs\/link\.md'/u, "symlink"],
      ["deleted", "docs/deleted.md", false, /unsafe Git change kind 'deleted'/u, "delete"],
      ["renamed", "docs/new.md", false, /unsafe Git change kind 'renamed'/u, "rename", ["docs/new.md", "docs/old.md"]],
      ["copied", "docs/copied.md", false, /unsafe Git change kind 'copied'/u, "copy"],
    ]) {
      const fixture = createFixture(`ownership-ratification-${name}`);
      try {
        initGitRepo(fixture.repo, ["slice-branch"]);
        runGit(fixture.repo, ["checkout", "slice-branch"]);
        if (["delete", "rename", "copy", "modify", "mode"].includes(kind)) {
          const originalPath = kind === "rename" ? "docs/old.md" : kind === "copy" ? "docs/original.md" : changedPath;
          mkdirSync(join(fixture.repo, "docs"), { recursive: true });
          writeFileSync(join(fixture.repo, originalPath), "baseline path\n");
          runGit(fixture.repo, ["add", originalPath]);
          runGit(fixture.repo, ["commit", "-m", `seed ${name} path`]);
        }
        writeJson(join(fixture.runDir, "run.json"), {
          ...baseRun(fixture.runId), branch: "slice-branch", worktree: fixture.repo,
          slices: [{ id: "slice", stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status: "pending", attempts: 0 }],
        });
        seedBuilderDispatchAuthority(fixture);
        if (addSibling) {
          const planPath = join(fixture.runDir, "plan", "slices.json");
          const plan = readJson(planPath);
          plan.slices.push({ id: "sibling", stack: "backend", paths: ["test/**"], depends_on: [], acceptance: ["sibling"], test_plan: ["sibling"] });
          plan.delivery_envelope = deliveryEnvelopeForSlices(plan.slices);
          writeJson(planPath, plan);
          const run = readJson(join(fixture.runDir, "run.json"));
          run.slices.push({ id: "sibling", stack: "backend", depends_on: [], declared_paths: ["test/**"], effective_paths: ["test/**"], status: "pending", attempts: 0 });
          run.steps.find((step) => step.agent === "work-decomposer").acceptance.artifact_hash = hashFile(planPath);
          writeJson(join(fixture.runDir, "run.json"), run);
        }
        await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 1, branch: "slice-branch", worktree: fixture.repo });
        let reviewedCommit;
        await closeBuilderDispatch(fixture, 1, () => {
          mkdirSync(join(fixture.repo, ...changedPath.split("/").slice(0, -1)), { recursive: true });
          if (kind === "symlink") symlinkSync("../README.md", join(fixture.repo, changedPath));
          else if (kind === "delete") rmSync(join(fixture.repo, changedPath));
          else if (kind === "rename") runGit(fixture.repo, ["mv", "docs/old.md", changedPath]);
          else if (kind === "copy") cpSync(join(fixture.repo, "docs", "original.md"), join(fixture.repo, changedPath));
          else if (kind === "mode") chmodSync(join(fixture.repo, changedPath), 0o755);
          else writeFileSync(join(fixture.repo, changedPath), `${name}\n`);
          if (kind !== "rename") runGit(fixture.repo, ["add", "-A", "--", ...disclosedPaths]);
          runGit(fixture.repo, ["commit", "-m", `change ${name} path`]);
          reviewedCommit = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
        });
        mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
        writeJson(join(fixture.runDir, "evidence", "slice.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: reviewedCommit,
          ownership_disclosure: disclosedPaths.map((path) => ({ path, rationale: `The rejected ${name} path was observed and requires explicit ownership review.` })) });
        writeJson(join(fixture.runDir, "reviews", "slice.json"), createV2SliceReviewRecord({ runDir: fixture.runDir, evidenceRef: "evidence/slice.json", subject: "slice", attempt: 1, reviewedCommit, ratifiedPaths: disclosedPaths }));
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(
          transitionRunSlice(fixture.runDir, "slice", { status: "review", attempts: 1, evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json" }),
          expected,
          name,
        );
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("rejects ambiguous APPROVE ratification claimed by two sibling plan lanes without mutating the run", async () => {
    const fixture = createFixture("ownership-ratification-ambiguous-siblings");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      runGit(fixture.repo, ["checkout", "slice-branch"]);
      writeJson(join(fixture.runDir, "run.json"), {
        ...baseRun(fixture.runId), branch: "slice-branch", worktree: fixture.repo,
        slices: [{ id: "slice", stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status: "pending", attempts: 0 }],
      });
      seedBuilderDispatchAuthority(fixture);
      const planPath = join(fixture.runDir, "plan", "slices.json");
      const plan = readJson(planPath);
      plan.slices.push(
        { id: "sibling-a", stack: "backend", paths: ["docs/**"], depends_on: [], acceptance: ["a"], test_plan: ["a"] },
        { id: "sibling-b", stack: "backend", paths: ["docs/ambiguous.md"], depends_on: [], acceptance: ["b"], test_plan: ["b"] },
      );
      plan.delivery_envelope = deliveryEnvelopeForSlices(plan.slices);
      writeJson(planPath, plan);
      const run = readJson(join(fixture.runDir, "run.json"));
      run.slices.push(
        { id: "sibling-a", stack: "backend", depends_on: [], declared_paths: ["docs/**"], effective_paths: ["docs/**"], status: "pending", attempts: 0 },
        { id: "sibling-b", stack: "backend", depends_on: [], declared_paths: ["docs/ambiguous.md"], effective_paths: ["docs/ambiguous.md"], status: "pending", attempts: 0 },
      );
      run.steps.find((step) => step.agent === "work-decomposer").acceptance.artifact_hash = hashFile(planPath);
      writeJson(join(fixture.runDir, "run.json"), run);
      await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 1, branch: "slice-branch", worktree: fixture.repo });
      let reviewedCommit;
      await closeBuilderDispatch(fixture, 1, () => {
        mkdirSync(join(fixture.repo, "docs"), { recursive: true });
        writeFileSync(join(fixture.repo, "docs", "ambiguous.md"), "ambiguous\n");
        runGit(fixture.repo, ["add", "docs/ambiguous.md"]);
        runGit(fixture.repo, ["commit", "-m", "change ambiguous path"]);
        reviewedCommit = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      });
      mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
      writeJson(join(fixture.runDir, "evidence", "slice.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: reviewedCommit,
        ownership_disclosure: [{ path: "docs/ambiguous.md", rationale: "The ambiguous documentation path was observed and requires explicit ownership review." }] });
      writeJson(join(fixture.runDir, "reviews", "slice.json"), createV2SliceReviewRecord({ runDir: fixture.runDir, evidenceRef: "evidence/slice.json", subject: "slice", attempt: 1, reviewedCommit, ratifiedPaths: ["docs/ambiguous.md"] }));
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");

      await assert.rejects(
        transitionRunSlice(fixture.runDir, "slice", { status: "review", attempts: 1, evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json" }),
        /ambiguous plan ownership[\s\S]*sibling-a[\s\S]*sibling-b/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("resets approved ratified ownership on review-to-blocked while rejecting caller-authored ownership", async () => {
    const fixture = createFixture("approved-ratification-blocked-reset");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      runGit(fixture.repo, ["checkout", "slice-branch"]);
      writeJson(join(fixture.runDir, "run.json"), {
        ...baseRun(fixture.runId), branch: "slice-branch", worktree: fixture.repo,
        slices: [{ id: "slice", stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status: "pending", attempts: 0 }],
      });
      seedBuilderDispatchAuthority(fixture);
      await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 1, branch: "slice-branch", worktree: fixture.repo });
      let reviewedCommit;
      await closeBuilderDispatch(fixture, 1, () => {
        mkdirSync(join(fixture.repo, "extension"), { recursive: true });
        writeFileSync(join(fixture.repo, "extension", "adjacent.txt"), "ratified\n");
        runGit(fixture.repo, ["add", "extension/adjacent.txt"]);
        runGit(fixture.repo, ["commit", "-m", "change ratified adjacent path"]);
        reviewedCommit = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      });
      mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
      writeJson(join(fixture.runDir, "evidence", "slice.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: reviewedCommit,
        ownership_disclosure: [{ path: "extension/adjacent.txt", rationale: "The adjacent file is required to expose this slice behavior." }] });
      writeJson(join(fixture.runDir, "reviews", "slice.json"), createV2SliceReviewRecord({ runDir: fixture.runDir, evidenceRef: "evidence/slice.json", subject: "slice", attempt: 1, reviewedCommit, ratifiedPaths: ["extension/adjacent.txt"] }));
      const beforeDisclosure = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      writeJson(join(fixture.runDir, "evidence", "slice.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: reviewedCommit,
        ownership_disclosure: [{ path: "extension/adjacent.txt", rationale: " not normalized " }] });
      await assert.rejects(
        transitionRunSlice(fixture.runDir, "slice", { status: "review", attempts: 1, evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json" }),
        /rationale must be nonempty normalized text/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeDisclosure);
      writeJson(join(fixture.runDir, "evidence", "slice.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: reviewedCommit,
        ownership_disclosure: [{ path: "extension/adjacent.txt", rationale: "The adjacent file is required to expose this slice behavior." }] });
      await transitionRunSlice(fixture.runDir, "slice", { status: "review", attempts: 1, evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json" });
      assert.deepEqual(readJson(join(fixture.runDir, "run.json")).slices[0].effective_paths, ["src/**", "extension/adjacent.txt"]);
      const beforeMutation = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(
        transitionRunSlice(fixture.runDir, "slice", { status: "blocked", blocked_reason: "stopped", effective_paths: ["src/**", "caller.txt"] }),
        /effective_paths is managed by checked review publication/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeMutation);

      const blocked = await transitionRunSlice(fixture.runDir, "slice", { status: "blocked", blocked_reason: "stopped" });
      assert.deepEqual(blocked.slice.effective_paths, ["src/**"]);
      assert.deepEqual(blocked.slice.attempt_reviews[0].ratified_paths, ["extension/adjacent.txt"]);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("re-observes accepted plan and slice HEAD at review publication commit time", async () => {
    for (const [name, mutate, expected] of [
      ["plan", (fixture) => {
        const planPath = join(fixture.runDir, "plan", "slices.json");
        const plan = readJson(planPath);
        plan.slices[0].acceptance = ["raced plan"];
        writeJson(planPath, plan);
      }, /plan ref\/hash does not match exact plan bytes|review authority changed|commit failed/u],
      ["head", (fixture) => {
        writeFileSync(join(fixture.repo, "src-race.txt"), "moved\n");
        runGit(fixture.repo, ["add", "src-race.txt"]);
        runGit(fixture.repo, ["commit", "-m", "move slice head during publication"]);
      }, /current branch head differs from checked slice head|reviewed_commit must equal the current slice head|review authority changed|commit failed/u],
    ]) {
      const fixture = createFixture(`slice-review-publication-${name}-race`);
      try {
        initGitRepo(fixture.repo, ["slice-branch"]);
        runGit(fixture.repo, ["checkout", "slice-branch"]);
        writeJson(join(fixture.runDir, "run.json"), {
          ...baseRun(fixture.runId), branch: "slice-branch", worktree: fixture.repo,
          slices: [{ id: "slice", stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status: "pending", attempts: 0 }],
        });
        seedBuilderDispatchAuthority(fixture);
        await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 1, branch: "slice-branch", worktree: fixture.repo });
        await closeBuilderDispatch(fixture, 1);
        const reviewedCommit = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
        mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
        writeJson(join(fixture.runDir, "evidence", "slice.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: reviewedCommit });
        writeJson(join(fixture.runDir, "reviews", "slice.json"), createV2SliceReviewRecord({ runDir: fixture.runDir, evidenceRef: "evidence/slice.json", subject: "slice", attempt: 1, reviewedCommit }));
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");

        await assert.rejects(
          transitionRunSlice(fixture.runDir, "slice", { status: "review", attempts: 1, evidence_ref: "evidence/slice.json", review_ref: "reviews/slice.json" }, {
            atomicWriteHooks: { beforeCommit: () => mutate(fixture) },
          }),
          expected,
          name,
        );
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, name);
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("re-observes accepted plan at merge publication commit time", async () => {
    const fixture = createFixture("slice-merge-plan-publication-race");
    try {
      initGitRepo(fixture.repo, ["slice-branch"]);
      const prepared = prepareSliceMergeState(fixture);
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");

      await assert.rejects(transitionSliceMerged(fixture.runDir, "slice", { merge_commit: prepared.mergeCommit }, {
        atomicWriteHooks: { beforeCommit() {
          const planPath = join(fixture.runDir, "plan", "slices.json");
          const plan = readJson(planPath);
          plan.slices[0].acceptance = ["raced merge plan"];
          writeJson(planPath, plan);
        } },
      }), /plan ref\/hash does not match exact plan bytes|merge authority changed|commit failed/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
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
      const planPath = join(fixture.runDir, "plan", "slices.json");
      const originalPlan = readFileSync(planPath, "utf8");
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      writeJson(planPath, withDeliveryEnvelope({ ...readJson(planPath), integration_gate: { required_commands: [{ program: "node", args: ["--test"] }, { program: "npm", args: ["run", "check"] }] } }));
      await assert.rejects(
        transitionSliceMerged(fixture.runDir, "slice", { merge_commit: integrationHead }),
        /plan ref\/hash does not match exact plan bytes/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
      writeFileSync(planPath, originalPlan);
      await assert.rejects(transitionSliceMerged(fixture.runDir, "slice", { merge_commit: integrationHead }, {
        atomicWriteHooks: { beforeCommit() { writeJson(join(fixture.runDir, "reviews", "slice.json"), { subject: "slice", verdict: "REJECT" }); } },
      }), /requires APPROVE review|commit failed/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
      writeJson(join(fixture.runDir, "reviews", "slice.json"), originalReview);
      const familyEvidencePath = join(fixture.runDir, "evidence", "slice-family.json");
      const originalFamilyEvidence = readFileSync(familyEvidencePath, "utf8");
      await assert.rejects(transitionSliceMerged(fixture.runDir, "slice", { merge_commit: integrationHead }, {
        atomicWriteHooks: { beforeCommit() { writeJson(familyEvidencePath, { subject: "slice", family: "fixture-family", status: "drifted" }); } },
      }), /invariant family ledger evidence hash is stale|commit failed/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
      writeFileSync(familyEvidencePath, originalFamilyEvidence);
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
      writeReadyPrRun(fixture, { branch: "feature", validator: { verdict: "GO-WITH-NITS" } });
      const head = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
      const run = readJson(join(fixture.runDir, "run.json"));
      delete run.validator;
      delete run.security_review;
      writeJson(join(fixture.runDir, "run.json"), run);
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

  it("rejects incomplete panel rows without mutation, upgrade, or read-only authority", async () => {
    for (const shape of ["both", "validator-only", "security-only", "terminal-both"]) {
      const fixture = createFixture(`incomplete-panel-${shape}`);
      try {
        const { input, legacyValidator, legacySecurity } = prepareLegacyPanelState(fixture);
        const run = readJson(join(fixture.runDir, "run.json"));
        if (shape === "validator-only") delete run.security_review;
        if (shape === "security-only") delete run.validator;
        if (shape === "terminal-both") {
          run.status = "completed";
          run.pr_url = "https://github.com/acme/repo/pull/1";
          run.terminal_result = { status: "completed", run_id: run.run_id, pr_url: run.pr_url, pr_number: 1, repository: "acme/repo", draft: false };
        }
        if (shape === "validator-only") run.validator = legacyValidator;
        if (shape === "security-only") run.security_review = legacySecurity;
        writeJson(join(fixture.runDir, "run.json"), run);
        const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        await assert.rejects(
          transitionPanelVerdicts(fixture.runDir, input),
          /report_hash, review_hash, reviewed_head_sha must all be present|review_hash, reviewed_head_sha must all be present/u,
          shape,
        );
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before, shape);
      } finally {
        cleanup(fixture.repo);
      }
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
      await assert.rejects(transitionPrePrFenceEstablished(fixture.runDir, preparePrTestOptions(fixture.runDir)), /completed checked execution claim no longer matches current authority|reviewed_head_sha values must equal the current integration head/u);
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
      }, { timeoutMs: 5, retryDelayMs: 1, livenessProbe: () => ({ status: "absent" }) });

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
          livenessProbe: () => { calls.push("inspect-owner"); return { status: "absent" }; },
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
          livenessProbe: () => {
            livenessChecks += 1;
            return { status: livenessChecks < 3 ? "absent" : "live" };
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
        withRunJsonLock(fixture.runDir, () => {}, { timeoutMs: 5, retryDelayMs: 1, staleLockMs: 1, livenessProbe: () => ({ status: "live" }) }),
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
          withRunJsonLock(fixture.runDir, () => {}, { timeoutMs: 5, retryDelayMs: 1, missingOwnerStealMs, livenessProbe: () => ({ status: "absent" }) }),
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
        livenessProbe: () => ({ status: "absent" }),
        lockHooks: {
          onReclaimClaimed: async () => { firstClaimed.resolve(); await releaseFirstClaim.promise; },
          onReclaimRenamed: async () => { firstRenamed.resolve(); await releaseFirstRename.promise; },
        },
      });
      await firstClaimed.promise;
      const second = withRunJsonLock(fixture.runDir, () => callback(secondEntered, releaseSecondCallback), {
        timeoutMs: 5000,
        retryDelayMs: 1,
        livenessProbe: () => ({ status: "absent" }),
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
        livenessProbe: () => ({ status: "absent" }),
        lockHooks: {
          onBeforeReclaimClaim: async () => { delayedObserved.resolve(); await releaseDelayedClaim.promise; },
          onReclaimAbandoned: () => delayedAbandoned.resolve(),
        },
      });
      await delayedObserved.promise;
      const winner = withRunJsonLock(fixture.runDir, () => { winnerCallbackEntered = true; }, {
        timeoutMs: 5000,
        retryDelayMs: 1,
        livenessProbe: () => ({ status: "absent" }),
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
      ["remote", "remote-host.invalid", () => ({ status: "absent" })],
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
    for (const [name, ownerHostname, livenessProbe] of cases) {
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
          withRunJsonLock(fixture.runDir, () => {}, { timeoutMs: 5, retryDelayMs: 1, livenessProbe }),
          /timed out waiting for run\.json lock/u,
        );
        assert.equal(readJson(join(lockDir, "owner.json")).nonce, "66666666-6666-4666-8666-666666666666");
      } finally {
        cleanup(fixture.repo);
      }
    }
  });

  it("clears heartbeat evidence only for canonical absent liveness", async () => {
    const cases = [
      ["live", () => ({ status: "live" }), false, /fresh-heartbeat/u],
      ["absent", () => ({ status: "absent" }), true, null],
      ["string", () => "false", false, /indeterminate-heartbeat-process/u],
      ["boxed", () => new Boolean(false), false, /indeterminate-heartbeat-process/u],
      ["object", () => ({ status: "dead" }), false, /indeterminate-heartbeat-process/u],
      ["array", () => [], false, /indeterminate-heartbeat-process/u],
      ["number", () => 0, false, /indeterminate-heartbeat-process/u],
      ["null", () => null, false, /indeterminate-heartbeat-process/u],
      ["undefined", () => undefined, false, /indeterminate-heartbeat-process/u],
      ["throw", () => { throw new Error("probe failed"); }, false, /indeterminate-heartbeat-process/u],
    ];
    for (const [name, livenessProbe, recoverable, rejection] of cases) {
      const fixture = createFixture(`heartbeat-liveness-${name}`);
      try {
        writeJson(join(fixture.runDir, "heartbeat.json"), heartbeat(fixture.runId));
        if (recoverable) {
          const result = await transitionRecoverOrphan(fixture.runDir, "confirmed absent", { now: NOW, livenessProbe });
          assert.equal(result.recovery.reason, "dead-heartbeat-process");
          assert.equal(readJson(join(fixture.runDir, "heartbeat.json")).pid, null);
          assert.equal(readJson(join(fixture.runDir, "run.json")).status, "needs-human");
        } else {
          await assert.rejects(
            transitionRecoverOrphan(fixture.runDir, "must stay running", { now: NOW, livenessProbe }),
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
        transitionRecoverOrphan(fixture.runDir, "must stay running", { now: NOW, livenessProbe: () => ({ status: "live" }) }),
        /stale-heartbeat/u,
      );
      assert.equal(readJson(join(fixture.runDir, "heartbeat.json")).pid, process.pid);
      assert.equal(readJson(join(fixture.runDir, "run.json")).status, "running");
    } finally {
      cleanup(fixture.repo);
    }
  });

  describe("checkpoint routing parent progress", () => {
    it("advances every exact state, replays idempotently, and keeps terminal authority immutable", async () => {
      const fixture = createCheckpointProgressFixture("checkpoint-parent-progress");
      try {
        const terminal = structuredClone(readJson(join(fixture.runDir, "run.json")).terminal_result);
        const planning = structuredClone(readJson(join(fixture.runDir, "run.json")).steps);
        const transitions = [
          [transitionCheckpointProgressReserved, checkpointProgressEntry("reserved", 1)],
          [transitionCheckpointProgressChildPublished, checkpointProgressEntry("child-published", 1)],
          [transitionCheckpointProgressLaunched, checkpointProgressEntry("launched", 1)],
          [transitionCheckpointProgressMerged, checkpointProgressEntry("merged", 1)],
          [transitionCheckpointProgressReserved, checkpointProgressEntry("reserved", 2)],
          [transitionCheckpointProgressChildPublished, checkpointProgressEntry("child-published", 2)],
          [transitionCheckpointProgressLaunched, checkpointProgressEntry("launched", 2)],
          [transitionCheckpointProgressMerged, checkpointProgressEntry("merged", 2)],
        ];

        for (const [transition, entry] of transitions) {
          const changed = await transition(fixture.runDir, entry, { now: "2026-07-19T12:10:00.000Z" });
          assert.equal(changed.updated, true, entry.state);
          const beforeReplay = readFileSync(join(fixture.runDir, "run.json"), "utf8");
          const replay = await transition(fixture.runDir, entry, { now: "2026-07-19T12:11:00.000Z" });
          assert.equal(replay.updated, false, `${entry.state} replay`);
          assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeReplay, `${entry.state} replay bytes`);
          assert.deepEqual(replay.run.terminal_result, terminal);
          assert.deepEqual(replay.run.steps, planning);
        }

        const closure = checkpointFinalClosureBinding();
        const closed = await transitionCheckpointProgressClosed(fixture.runDir, closure, { now: "2026-07-19T12:12:00.000Z" });
        assert.equal(closed.updated, true);
        assert.equal(closed.checkpoint_progress.status, "closed");
        assert.deepEqual(closed.checkpoint_progress.final_closure, closure);
        assert.deepEqual(closed.run.terminal_result, terminal);
        assert.deepEqual(closed.run.steps, planning);
        const beforeReplay = readFileSync(join(fixture.runDir, "run.json"), "utf8");
        const replay = await transitionCheckpointProgressClosed(fixture.runDir, closure);
        assert.equal(replay.updated, false);
        assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeReplay);
      } finally {
        cleanup(fixture.repo);
      }
    });

    it("rejects skipped, reversed, conflicting, and noncontiguous progress", async () => {
      const fixture = createCheckpointProgressFixture("checkpoint-parent-conflicts");
      try {
        await assert.rejects(
          transitionCheckpointProgressChildPublished(fixture.runDir, checkpointProgressEntry("child-published", 1)),
          /skip directly/u,
        );
        await assert.rejects(
          transitionCheckpointProgressReserved(fixture.runDir, checkpointProgressEntry("reserved", 2)),
          /contiguous after merged predecessors/u,
        );
        const reserved = checkpointProgressEntry("reserved", 1);
        await transitionCheckpointProgressReserved(fixture.runDir, reserved);
        const conflict = checkpointProgressEntry("child-published", 1);
        conflict.base_commit = "f".repeat(40);
        await assert.rejects(
          transitionCheckpointProgressChildPublished(fixture.runDir, conflict),
          /field 'base_commit' is immutable/u,
        );
        await transitionCheckpointProgressChildPublished(fixture.runDir, checkpointProgressEntry("child-published", 1));
        await transitionCheckpointProgressLaunched(fixture.runDir, checkpointProgressEntry("launched", 1));
        await assert.rejects(
          transitionCheckpointProgressChildPublished(fixture.runDir, checkpointProgressEntry("child-published", 1)),
          /cannot transition 'launched' -> 'child-published'/u,
        );
        const conflictingReplay = checkpointProgressEntry("launched", 1);
        conflictingReplay.launched_at = "2026-07-19T12:02:01.000Z";
        await assert.rejects(
          transitionCheckpointProgressLaunched(fixture.runDir, conflictingReplay),
          /replay conflicts/u,
        );
      } finally {
        cleanup(fixture.repo);
      }
    });

    it("closes only after every manifest checkpoint is merged", async () => {
      const fixture = createCheckpointProgressFixture("checkpoint-parent-close-eligibility");
      try {
        for (const state of ["reserved", "child-published", "launched", "merged"]) {
          const transition = {
            reserved: transitionCheckpointProgressReserved,
            "child-published": transitionCheckpointProgressChildPublished,
            launched: transitionCheckpointProgressLaunched,
            merged: transitionCheckpointProgressMerged,
          }[state];
          await transition(fixture.runDir, checkpointProgressEntry(state, 1));
        }
        await assert.rejects(
          transitionCheckpointProgressClosed(fixture.runDir, checkpointFinalClosureBinding()),
          /every manifest checkpoint to be merged/u,
        );
        assert.equal(readJson(join(fixture.runDir, "run.json")).checkpoint_progress.status, "active");
      } finally {
        cleanup(fixture.repo);
      }
    });

    it("runs the race hook immediately before replacement and refuses stale parent authority", async () => {
      const fixture = createCheckpointProgressFixture("checkpoint-parent-race");
      try {
        await assert.rejects(
          transitionCheckpointProgressReserved(fixture.runDir, checkpointProgressEntry("reserved", 1), {
            checkpointProgressHooks: {
              beforeReplace() {
                const run = readJson(join(fixture.runDir, "run.json"));
                run.terminal_result.summary = "raced terminal authority";
                writeJson(join(fixture.runDir, "run.json"), run);
              },
            },
          }),
          (error) => error?.message === "protected file commit failed"
            && /parent authority changed before progress publication/u.test(error.cause?.message),
        );
        const raced = readJson(join(fixture.runDir, "run.json"));
        assert.equal(raced.terminal_result.summary, "raced terminal authority");
        assert.deepEqual(raced.checkpoint_progress.entries, []);
      } finally {
        cleanup(fixture.repo);
      }
    });
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
  const history = { attempt: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash, reviewed_commit: reviewedCommit, diff_base_commit: reviewedCommit, ownership_schema_version: 2, ratified_paths: [], modified_extensions: [], verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0 };
  return {
    id, stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status, attempts: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash,
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

function createCheckpointProgressFixture(runId) {
  const fixture = createFixture(runId);
  const manifest = {
    schema_version: 1,
    kind: "delivery-checkpoint-routing-manifest",
    checkpoints: [1, 2].map((ordinal) => ({
      id: `checkpoint-${String(ordinal).padStart(3, "0")}`,
      ordinal,
      child_plan_hash: HASH,
      brief_scope_hash: HASH,
    })),
  };
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const manifestRef = `artifacts/checkpoint-routing-${manifestHash.slice("sha256:".length)}.json`;
  writeFileSync(join(fixture.runDir, manifestRef), bytes);
  writeJson(join(fixture.runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    status: "blocked",
    updated_at: "2026-07-19T12:00:00.000Z",
    gates: {},
    slices: [],
    steps: [{ agent: "work-decomposer", status: "blocked", attempts: 0 }],
    checkpoint_progress: {
      schema_version: 1,
      kind: "delivery-checkpoint-progress",
      manifest_ref: manifestRef,
      manifest_hash: manifestHash,
      status: "active",
      entries: [],
      final_closure: null,
    },
    terminal_result: {
      status: "blocked",
      run_id: runId,
      pr_url: null,
      reason: "oversized-plan-checkpoint-routing-required",
      summary: "Oversized plan routed to two checkpoints.",
      artifacts: { checkpoint_routing: manifestRef },
    },
  });
  return { ...fixture, manifestRef, manifestHash };
}

function checkpointProgressEntry(state, ordinal) {
  const childRunId = `checkpoint-child-${ordinal}`;
  const entry = {
    state,
    checkpoint_id: `checkpoint-${String(ordinal).padStart(3, "0")}`,
    ordinal,
    root_child_run_id: childRunId,
    branch: childRunId,
    worktree: `/tmp/${childRunId}`,
    base_ref: "refs/remotes/origin/main",
    base_commit: ordinal === 1 ? "a".repeat(40) : "c".repeat(40),
    predecessor_checkpoint_id: ordinal === 1 ? null : `checkpoint-${String(ordinal - 1).padStart(3, "0")}`,
    predecessor_completed_run_id: ordinal === 1 ? null : `checkpoint-child-${ordinal - 1}`,
    predecessor_merge_commit: ordinal === 1 ? null : "c".repeat(40),
    configuration: checkpointProgressConfiguration(),
    publication_claim_ref: `refs/opencode/checkpoint-publications/${createHash("sha256").update(childRunId).digest("hex")}`,
    publication_claim_oid: "a".repeat(40),
    reserved_at: "2026-07-19T12:00:00.000Z",
  };
  if (state === "reserved") return entry;
  Object.assign(entry, {
    child_run_hash: HASH,
    child_plan_hash: HASH,
    brief_scope_hash: HASH,
    published_at: "2026-07-19T12:01:00.000Z",
  });
  if (state === "child-published") return entry;
  entry.launched_at = "2026-07-19T12:02:00.000Z";
  if (state === "launched") return entry;
  return Object.assign(entry, {
    completed_child_run_id: childRunId,
    completed_child_run_hash: HASH,
    checkpoint_source_hash: HASH,
    configuration_hash: HASH,
    lineage: [{ run_id: childRunId, run_hash: HASH, parent_run_id: null, continuation_claim_ref: null, continuation_claim_oid: null }],
    pull_request: {
      pr_url: `https://github.com/acme/repo/pull/${ordinal}`,
      pr_number: ordinal,
      pr_node_id: `PR_checkpoint_${ordinal}`,
      repository: "acme/repo",
      operation_id: `ffpr-v1-${"d".repeat(64)}`,
      head_ref: childRunId,
      head_sha: "b".repeat(40),
      base_ref: "main",
      base_sha: "a".repeat(40),
      draft: false,
      merge_commit: "c".repeat(40),
    },
    remote_main: { ref: "refs/heads/main", commit: "c".repeat(40), observed_at: "2026-07-19T12:03:00.000Z" },
    merged_at: "2026-07-19T12:04:00.000Z",
  });
}

function checkpointProgressConfiguration() {
  return {
    mode: "interactive",
    github_account: null,
    pr_mode: "ready",
    max_parallel_slices: 3,
    max_retries: 3,
    post_pr_policy: {
      enabled: false,
      wait_ms: 3_600_000,
      initial_poll_ms: 30_000,
      max_poll_ms: 120_000,
      check_start_grace_ms: 300_000,
      max_transient_errors: 12,
      review: { required: false, reviewer_login: null, source: "none" },
    },
    review_tier: null,
  };
}

function checkpointSource(parentRunId, rootChildRunId) {
  return {
    schema_version: 1,
    kind: "delivery-checkpoint-source",
    parent_run_id: parentRunId,
    manifest_ref: `artifacts/checkpoint-routing-${"a".repeat(64)}.json`,
    manifest_hash: HASH,
    checkpoint_id: "checkpoint-001",
    checkpoint_ordinal: 1,
    root_child_run_id: rootChildRunId,
    source_plan_ref: "plan/slices.json",
    source_plan_hash: HASH,
    source_review_ref: "reviews/work-decomposer.json",
    source_review_hash: HASH,
    source_review_attempt: 1,
    parent_review_identity_hash: HASH,
    child_disposition_hash: HASH,
    admission_probe_hash: HASH,
    brief_scope_hash: HASH,
    child_plan_hash: HASH,
    acceptance_mapping_hash: HASH,
    initial_base_ref: "refs/remotes/origin/main",
    initial_base_commit: "a".repeat(40),
  };
}

function checkpointFinalClosureBinding() {
  return { ref: "artifacts/checkpoint-final-closure.json", hash: HASH, closed_at: "2026-07-19T12:05:00.000Z" };
}

function seedBuilderDispatchAuthority(fixture) {
  mkdirSync(join(fixture.runDir, "plan"), { recursive: true });
  mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
  writeFileSync(join(fixture.runDir, "artifacts", "technical-brief.md"), "accepted brief\n");
  writeJson(join(fixture.runDir, "plan", "slices.json"), withDeliveryEnvelope({
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: [{ id: "slice", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["works"], test_plan: ["node --test"] }],
  }));
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

async function prepareRejectReviewPublication(fixture) {
  initGitRepo(fixture.repo, ["slice-branch"]);
  runGit(fixture.repo, ["checkout", "slice-branch"]);
  const reviewedCommit = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
  seedBuilderDispatchAuthority(fixture);
  await transitionRunSlice(fixture.runDir, "slice", { status: "running", attempts: 1, branch: "slice-branch", worktree: fixture.repo });
  await closeBuilderDispatch(fixture, 1);
  mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
  mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
  const evidenceRef = "evidence/slice.json";
  const familyEvidenceRef = "evidence/slice.family.json";
  const reviewPath = join(fixture.runDir, "reviews", "slice.json");
  writeJson(join(fixture.runDir, evidenceRef), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: reviewedCommit });
  const plan = readJson(join(fixture.runDir, "plan", "slices.json"));
  const checkedFamilyEvidence = writeVerificationArtifactReceipt({
    runDir: fixture.runDir, runId: fixture.runId, plan, sliceId: "slice", attempt: 1, reviewedCommit,
    artifactId: "fixture-artifact-1", evidenceRef: familyEvidenceRef,
    result: { type: "verification-result", outcome: "pass", summary: "Verify slice behavior passed" },
  });
  const review = createV2SliceReviewRecord({
    subject: "slice",
    verdict: "REJECT",
    attempt: 1,
    reviewedCommit,
    requiredFixes: ["Repair the rejected invariant"],
  });
  review.invariant_family_ledger = passingInvariantFamilyLedger({
    plan,
    sliceId: "slice",
    reviewedCommit,
    evidenceRef: familyEvidenceRef,
    evidenceHash: checkedFamilyEvidence.hash,
  });
  writeJson(reviewPath, review);
  return { review, reviewPath };
}

function publishPreparedSliceReview(fixture) {
  return transitionRunSlice(fixture.runDir, "slice", {
    status: "review",
    attempts: 1,
    evidence_ref: "evidence/slice.json",
    review_ref: "reviews/slice.json",
  });
}

function createV2SliceReviewRecord({ runDir, evidenceRef, scopeEffect = "in-lane", likelyPaths = ["src/fix.js"], fixOwner = "slice", ...input } = {}) {
  const review = createSliceReviewRecord(input);
  review.ownership_ratification = { schema_version: 2, kind: "factory-derived-modified-extension" };
  review.remediation_context = {
    schema_version: 2,
    fixes: review.remediation_context.fixes.map((fix) => ({
      ...fix,
      scope_effect: scopeEffect,
      likely_paths: [...likelyPaths],
      fix_owner: fixOwner,
    })),
  };
  if (["APPROVE", "REJECT"].includes(review.verdict) && runDir && evidenceRef) {
    const plan = readJson(join(runDir, "plan", "slices.json"));
    const familyEvidenceRef = evidenceRef.replace(/\.json$/u, ".family.json");
    const unit = plan.delivery_envelope.delivery_units.find((candidate) => candidate.slice_id === review.subject);
    const family = unit.invariant_families[0];
    const artifactId = unit.obligations.find((obligation) => obligation.invariant_family_id === family.id).verification_artifact_id;
    const checkedFamilyEvidence = writeVerificationArtifactReceipt({
      runDir, runId: readJson(join(runDir, "run.json")).run_id, plan, sliceId: review.subject,
      attempt: review.attempt, reviewedCommit: review.reviewed_commit, artifactId, evidenceRef: familyEvidenceRef,
      result: { type: "verification-result", outcome: "pass", summary: `${family.description} passed` },
    });
    review.invariant_family_ledger = passingInvariantFamilyLedger({
      plan,
      sliceId: review.subject,
      reviewedCommit: review.reviewed_commit,
      evidenceRef: familyEvidenceRef,
      evidenceHash: checkedFamilyEvidence.hash,
    });
  }
  return review;
}

function persistedV2FieldMutationCases({ sibling }) {
  const cases = [
    ["ownership_schema_version", (entry) => { entry.ownership_schema_version = 1; }],
    ["ratified_paths", (entry) => { entry.ratified_paths = ["docs/stale-extension.md"]; }],
    ["modified_extensions", (entry) => { entry.modified_extensions = []; }],
    ["kind", (_entry, extension) => { extension.kind = "stale-extension"; }],
    ["path", (_entry, extension) => { extension.path = `${extension.path}.stale`; }],
    ["rationale", (_entry, extension) => { extension.rationale = `${extension.rationale} Stale.`; }],
    ["authority", (_entry, extension) => { extension.authority = sibling ? "unowned" : "non-conflicting-sibling"; }],
  ];
  if (!sibling) return cases;
  return cases.concat([
    ["owner_slice_id", (_entry, extension) => { extension.owner_slice_id = "other-owner"; }],
    ["owner_attempt", (_entry, extension) => { extension.owner_attempt += 1; }],
    ["owner_evidence_ref", (_entry, extension) => { extension.owner_evidence_ref = "evidence/stale-owner.json"; }],
    ["owner_evidence_hash", (_entry, extension) => { extension.owner_evidence_hash = `sha256:${"0".repeat(64)}`; }],
    ["owner_review_ref", (_entry, extension) => { extension.owner_review_ref = "reviews/stale-owner.json"; }],
    ["owner_review_hash", (_entry, extension) => { extension.owner_review_hash = `sha256:${"1".repeat(64)}`; }],
    ["owner_dispatch_claim_ref", (_entry, extension) => { extension.owner_dispatch_claim_ref = "dispatch/stale-owner.json"; }],
    ["owner_dispatch_claim_hash", (_entry, extension) => { extension.owner_dispatch_claim_hash = `sha256:${"2".repeat(64)}`; }],
    ["owner_dispatch_closure_ref", (_entry, extension) => { extension.owner_dispatch_closure_ref = "dispatch/stale-owner.closed.json"; }],
    ["owner_dispatch_closure_hash", (_entry, extension) => { extension.owner_dispatch_closure_hash = `sha256:${"3".repeat(64)}`; }],
    ["owner_reviewed_commit", (_entry, extension) => { extension.owner_reviewed_commit = extension.owner_diff_base_commit; }],
    ["owner_diff_base_commit", (_entry, extension) => { extension.owner_diff_base_commit = extension.owner_reviewed_commit; }],
  ]);
}

function persistedSiblingSourceMutationCases() {
  return [
    ["owner-evidence-status", (fixture, _run, owner) => {
      const path = join(fixture.runDir, owner.evidence_ref);
      const evidence = readJson(path);
      evidence.status = "fail";
      writeJson(path, evidence);
    }],
    ["owner-evidence-review-ready", (fixture, _run, owner) => {
      const path = join(fixture.runDir, owner.evidence_ref);
      const evidence = readJson(path);
      evidence.review_ready = false;
      writeJson(path, evidence);
    }],
    ["owner-invariant-receipt", (fixture, _run, owner) => {
      const review = readJson(join(fixture.runDir, owner.review_ref));
      const path = join(fixture.runDir, review.invariant_family_ledger.dispositions[0].evidence_ref);
      const receipt = readJson(path);
      receipt.review_ready = false;
      writeJson(path, receipt);
    }],
    ["owner-dispatch-claim-identity", (fixture, _run, owner) => {
      const path = join(fixture.runDir, owner.attempt_reviews[0].dispatch_claim_ref);
      const claim = readJson(path);
      claim.branch = "cross-bound-owner-branch";
      writeJson(path, claim);
    }],
    ["owner-dispatch-completion-head", (fixture, _run, owner) => {
      const entry = owner.attempt_reviews[0];
      const path = join(fixture.runDir, entry.dispatch_closure_ref);
      const closure = readJson(path);
      closure.completion_head = entry.diff_base_commit;
      writeJson(path, closure);
    }],
  ];
}

async function prepareSiblingModificationFixture(fixture, {
  publishModifier = true,
  ownerVerdict = "APPROVE",
  ownerTouchesShared = false,
  beforeModifier = async () => {},
} = {}) {
  initGitRepo(fixture.repo);
  mkdirSync(join(fixture.repo, "test"), { recursive: true });
  writeFileSync(join(fixture.repo, "test", "shared.test.js"), "baseline shared bytes\n");
  runGit(fixture.repo, ["add", "test/shared.test.js"]);
  runGit(fixture.repo, ["commit", "-m", "seed sibling-owned shared file"]);
  const baseline = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
  runGit(fixture.repo, ["branch", "owner-branch"]);
  runGit(fixture.repo, ["branch", "modifier-branch"]);
  const worktreesRoot = join(fixture.repo, ".opencode", "worktrees");
  const ownerWorktree = join(worktreesRoot, "owner");
  const modifierWorktree = join(worktreesRoot, "modifier");
  mkdirSync(worktreesRoot, { recursive: true });
  runGit(fixture.repo, ["worktree", "add", ownerWorktree, "owner-branch"]);
  runGit(fixture.repo, ["worktree", "add", modifierWorktree, "modifier-branch"]);

  const plan = withDeliveryEnvelope({
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: [
      { id: "owner", stack: "backend", paths: ["test/**"], depends_on: [], acceptance: ["owner works"], test_plan: ["test owner"] },
      { id: "modifier", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["modifier works"], test_plan: ["test modifier"] },
    ],
  });
  mkdirSync(join(fixture.runDir, "plan"), { recursive: true });
  mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
  mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
  writeFileSync(join(fixture.runDir, "artifacts", "technical-brief.md"), "accepted sibling brief\n");
  writeJson(join(fixture.runDir, "plan", "slices.json"), plan);
  writeJson(join(fixture.runDir, "reviews", "spec-writer.json"), { subject: "spec-writer", verdict: "APPROVE", required_fixes: [] });
  writeJson(join(fixture.runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", verdict: "APPROVE", required_fixes: [] });
  writeJson(join(fixture.runDir, "run.json"), {
    ...baseRun(fixture.runId),
    branch: "main",
    worktree: fixture.repo,
    slices: [
      { id: "owner", stack: "backend", depends_on: [], declared_paths: ["test/**"], effective_paths: ["test/**"], status: "pending", attempts: 0 },
      { id: "modifier", stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status: "pending", attempts: 0 },
    ],
    steps: [{
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
    }],
  });

  await transitionRunSlice(fixture.runDir, "owner", { status: "running", attempts: 1, branch: "owner-branch", worktree: ownerWorktree });
  let ownerReviewedCommit;
  await closeBuilderDispatch(fixture, 1, () => {
    const ownerPath = ownerTouchesShared ? "test/shared.test.js" : "test/owner-only.test.js";
    writeFileSync(join(ownerWorktree, ownerPath), "owner reviewed bytes\n");
    runGit(ownerWorktree, ["add", ownerPath]);
    runGit(ownerWorktree, ["commit", "-m", "review owner without shared path"]);
    ownerReviewedCommit = gitOutput(ownerWorktree, ["rev-parse", "HEAD"]);
  }, "owner");
  writeJson(join(fixture.runDir, "evidence", "owner.json"), {
    subject: "owner", status: "pass", review_ready: true, attempt: 1, head_sha: ownerReviewedCommit,
  });
  writeJson(join(fixture.runDir, "reviews", "owner.json"), createV2SliceReviewRecord({
    runDir: fixture.runDir, evidenceRef: "evidence/owner.json", subject: "owner", attempt: 1, reviewedCommit: ownerReviewedCommit,
    verdict: ownerVerdict, requiredFixes: ownerVerdict === "REJECT" ? ["Repair the owner review finding"] : [],
    fixOwner: "owner", likelyPaths: ["test/owner-only.test.js"],
  }));
  await transitionRunSlice(fixture.runDir, "owner", {
    status: "review", attempts: 1, evidence_ref: "evidence/owner.json", review_ref: "reviews/owner.json",
  });

  await beforeModifier({ fixture, baseline, ownerReviewedCommit, ownerWorktree, modifierWorktree });

  await transitionRunSlice(fixture.runDir, "modifier", { status: "running", attempts: 1, branch: "modifier-branch", worktree: modifierWorktree });
  let modifierReviewedCommit;
  await closeBuilderDispatch(fixture, 1, () => {
    writeFileSync(join(modifierWorktree, "test", "shared.test.js"), "modifier reviewed bytes\n");
    runGit(modifierWorktree, ["add", "test/shared.test.js"]);
    runGit(modifierWorktree, ["commit", "-m", "modify sibling-owned shared file"]);
    modifierReviewedCommit = gitOutput(modifierWorktree, ["rev-parse", "HEAD"]);
  }, "modifier");
  const rationale = "The modifier must update the existing sibling-owned compatibility fixture.";
  writeJson(join(fixture.runDir, "evidence", "modifier.json"), {
    subject: "modifier", status: "pass", review_ready: true, attempt: 1, head_sha: modifierReviewedCommit,
    ownership_disclosure: [{ path: "test/shared.test.js", rationale }],
  });
  writeJson(join(fixture.runDir, "reviews", "modifier.json"), createV2SliceReviewRecord({
    runDir: fixture.runDir, evidenceRef: "evidence/modifier.json", subject: "modifier", attempt: 1, reviewedCommit: modifierReviewedCommit,
  }));
  if (publishModifier) {
    await transitionRunSlice(fixture.runDir, "modifier", {
      status: "review", attempts: 1, evidence_ref: "evidence/modifier.json", review_ref: "reviews/modifier.json",
    });
  }
  return { baseline, ownerReviewedCommit, modifierReviewedCommit, ownerWorktree, modifierWorktree };
}

async function closeBuilderDispatch(fixture, attempt, taskWork = () => {}, sliceId = "slice") {
  const completionToken = `run-state-completion-${attempt}`;
  const context = await prepareSliceBuilderTaskDispatch(fixture.repo, {
    run_id: fixture.runId, slice_id: sliceId, attempt, agent: "backend-builder",
  }, { claimDispatch: true, completionToken });
  await taskWork();
  await completeSliceBuilderTaskDispatch(fixture.repo, {
    run_id: fixture.runId,
    slice_id: sliceId,
    attempt,
    agent: "backend-builder",
    claim_ref: context.dispatch_claim.ref,
    claim_hash: context.dispatch_claim.hash,
    completion_token: completionToken,
  });
  return context;
}

function prepareSliceMergeState(fixture, { verdict = "APPROVE", subject = "slice", writeReview = true, priorIntegration = false, reviewedPath = "slice.txt", preDispatchPath = null, integrationConflict = false, conflictTopology = null } = {}) {
  mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
  mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
  if (conflictTopology) {
    writeFileSync(join(fixture.repo, "rename-source.txt"), `shared line\n${Array.from({ length: 20 }, (_, index) => `stable ${index}`).join("\n")}\n`);
    runGit(fixture.repo, ["add", "rename-source.txt"]);
    runGit(fixture.repo, ["commit", "-m", "seed rename conflict source"]);
    runGit(fixture.repo, ["branch", "-f", "slice-branch", "HEAD"]);
  }
  const sliceWorktree = join(fixture.repo, ".opencode", "worktrees", "slice");
  mkdirSync(join(fixture.repo, ".opencode", "worktrees"), { recursive: true });
  runGit(fixture.repo, ["worktree", "add", sliceWorktree, "slice-branch"]);
  if (preDispatchPath) {
    mkdirSync(join(sliceWorktree, ...preDispatchPath.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(sliceWorktree, preDispatchPath), "caller-controlled pre-dispatch poison\n");
    runGit(sliceWorktree, ["add", preDispatchPath]);
    runGit(sliceWorktree, ["commit", "-m", "caller-controlled pre-dispatch poison"]);
  }
  const diffBaseCommit = gitOutput(sliceWorktree, ["rev-parse", "HEAD"]);
  if (conflictTopology) {
    runGit(sliceWorktree, ["mv", "rename-source.txt", reviewedPath]);
    writeFileSync(join(sliceWorktree, reviewedPath), `slice changes shared line\n${Array.from({ length: 20 }, (_, index) => `stable ${index}`).join("\n")}\n`);
  }
  else {
    mkdirSync(join(sliceWorktree, ...reviewedPath.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(sliceWorktree, reviewedPath), "reviewed slice bytes\n");
  }
  runGit(sliceWorktree, ["add", "-A"]);
  runGit(sliceWorktree, ["commit", "-m", "reviewed slice"]);
  const reviewedCommit = gitOutput(sliceWorktree, ["rev-parse", "HEAD"]);
  const declaredPaths = conflictTopology ? ["rename-source.txt", reviewedPath] : [reviewedPath];
  const plan = withDeliveryEnvelope({
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: [
      ...(priorIntegration ? [{ id: "prior", stack: "backend", paths: ["prior.txt"], depends_on: [], acceptance: ["prior"], test_plan: ["prior"] }] : []),
      { id: "slice", stack: "backend", paths: declaredPaths, depends_on: [], acceptance: ["slice"], test_plan: ["slice"] },
    ],
  });
  mkdirSync(join(fixture.runDir, "plan"), { recursive: true });
  writeJson(join(fixture.runDir, "plan", "slices.json"), plan);
  writeJson(join(fixture.runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", verdict: "APPROVE" });
  writeJson(join(fixture.runDir, "evidence", "slice.json"), { subject: "slice", status: "pass", review_ready: true, attempt: 1, head_sha: reviewedCommit });
  const family = plan.delivery_envelope.delivery_units.find((unit) => unit.slice_id === "slice").invariant_families[0];
  const artifactId = plan.delivery_envelope.delivery_units.find((unit) => unit.slice_id === "slice").obligations[0].verification_artifact_id;
  const checkedFamilyEvidence = writeVerificationArtifactReceipt({
    runDir: fixture.runDir, runId: fixture.runId, plan, sliceId: "slice", attempt: 1, reviewedCommit,
    artifactId, evidenceRef: "evidence/slice-family.json",
    result: { type: "verification-result", outcome: "pass", summary: `${family.description} passed` },
  });
  const evidenceHash = hashFile(join(fixture.runDir, "evidence", "slice.json"));
  const requiredFixes = verdict === "REJECT" ? ["fix rejected slice"] : [];
  const review = createV2SliceReviewRecord({ subject, verdict, attempt: 1, reviewedCommit, requiredFixes });
  if (verdict === "APPROVE") {
    review.invariant_family_ledger = passingInvariantFamilyLedger({
      plan,
      sliceId: "slice",
      reviewedCommit,
      evidenceRef: "evidence/slice-family.json",
      evidenceHash: checkedFamilyEvidence.hash,
    });
  }
  writeJson(join(fixture.runDir, "reviews", "slice.json"), review);
  const reviewHash = hashFile(join(fixture.runDir, "reviews", "slice.json"));
  const attemptReview = {
    attempt: 1,
    evidence_ref: "evidence/slice.json",
    evidence_hash: evidenceHash,
    review_ref: "reviews/slice.json",
    review_hash: reviewHash,
    reviewed_commit: reviewedCommit,
    diff_base_commit: diffBaseCommit,
    ownership_schema_version: 2,
    ratified_paths: [],
    modified_extensions: [],
    verdict,
    convergence: review.convergence,
    late_discovery_strike: review.late_discovery_strike,
    remaining_fix_count: review.remaining_fix_count,
  };
  const slices = [{
    id: "slice", stack: "backend", depends_on: [], declared_paths: declaredPaths, effective_paths: declaredPaths, status: "review", attempts: 1, branch: "slice-branch", worktree: sliceWorktree,
    ...(preDispatchPath ? { authorized_baseline_commit: diffBaseCommit } : {}),
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
      id: "prior", stack: "backend", depends_on: [], declared_paths: ["prior.txt"], effective_paths: ["prior.txt"], status: "merged", attempts: 1, merge_commit: priorCommit,
      evidence_ref: attemptReview.evidence_ref, evidence_hash: attemptReview.evidence_hash,
      review_ref: attemptReview.review_ref, review_hash: attemptReview.review_hash, reviewed_commit: attemptReview.reviewed_commit,
      attempt_reviews: [{ ...attemptReview }],
    });
  }
  const claimStem = createHash("sha256").update(`${fixture.runId}\0slice\0${1}`, "utf8").digest("hex");
  const claimRef = `dispatch/${claimStem}.json`;
  const closureRef = `dispatch/${claimStem}.closed.json`;
  const completionToken = "prepare-slice-merge-state";
  mkdirSync(join(fixture.runDir, "dispatch"), { recursive: true });
  writeJson(join(fixture.runDir, claimRef), {
    schema_version: 1, kind: "checked-slice-builder-dispatch-claim", run_id: fixture.runId, slice_id: "slice", attempt: 1,
    agent: "backend-builder", branch: "slice-branch", worktree: sliceWorktree, head: diffBaseCommit,
    context_hash: HASH, completion_token_hash: `sha256:${createHash("sha256").update(completionToken).digest("hex")}`,
    claimed_at: NOW, closure_ref: closureRef,
  });
  const claimHash = hashFile(join(fixture.runDir, claimRef));
  writeJson(join(fixture.runDir, closureRef), {
    schema_version: 1, kind: "checked-slice-builder-dispatch-closure", claim_ref: claimRef, claim_hash: claimHash,
    run_id: fixture.runId, slice_id: "slice", attempt: 1, agent: "backend-builder", branch: "slice-branch", worktree: sliceWorktree,
    head: diffBaseCommit, completion_head: reviewedCommit, context_hash: HASH, completion_token: completionToken, returned_at: NOW,
  });
  Object.assign(slices.at(-1), {
    dispatch_required: true, dispatch_claim_ref: claimRef, dispatch_claim_hash: claimHash,
    dispatch_closure_ref: closureRef, dispatch_closure_hash: hashFile(join(fixture.runDir, closureRef)),
  });
  Object.assign(attemptReview, {
    dispatch_claim_ref: claimRef, dispatch_claim_hash: claimHash,
    dispatch_closure_ref: closureRef, dispatch_closure_hash: hashFile(join(fixture.runDir, closureRef)),
  });
  writeJson(join(fixture.runDir, "run.json"), {
    ...baseRun(fixture.runId),
    branch: "main",
    worktree: fixture.repo,
    slices,
    steps: [{
      agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
      acceptance: {
        artifact_ref: "plan/slices.json", artifact_hash: hashFile(join(fixture.runDir, "plan", "slices.json")),
        review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(fixture.runDir, "reviews", "work-decomposer.json")),
      },
    }],
  });
  if (!writeReview) rmSync(join(fixture.runDir, "reviews", "slice.json"));
  if (integrationConflict) {
    if (conflictTopology === "rename-modify") {
      writeFileSync(join(fixture.repo, "rename-source.txt"), `integration changes shared line\n${Array.from({ length: 20 }, (_, index) => `stable ${index}`).join("\n")}\n`);
      runGit(fixture.repo, ["add", "rename-source.txt"]);
    } else if (conflictTopology === "rename-rename") {
      runGit(fixture.repo, ["mv", "rename-source.txt", "renamed-by-integration.txt"]);
    } else {
      mkdirSync(join(fixture.repo, ...reviewedPath.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(join(fixture.repo, reviewedPath), "competing integration bytes\n");
      runGit(fixture.repo, ["add", reviewedPath]);
    }
    runGit(fixture.repo, ["commit", "-m", "competing integration change"]);
    const integrationBaseline = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
    const merge = spawnSync("git", ["merge", "--no-ff", "slice-branch", "-m", "merge reviewed slice"], { cwd: fixture.repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    assert.notEqual(merge.status, 0, "fixture merge must conflict");
    return { reviewedCommit, mergeCommit: null, sliceWorktree, priorCommit, integrationBaseline };
  }
  runGit(fixture.repo, ["merge", "--no-ff", "slice-branch", "-m", "merge reviewed slice"]);
  return { reviewedCommit, mergeCommit: gitOutput(fixture.repo, ["rev-parse", "HEAD"]), sliceWorktree, priorCommit };
}

async function resolveDelegatedConflict(fixture, sliceId, path, contents, sequence) {
  const token = `delegated-conflict-${sequence}`;
  const context = await prepareSpecialBuilderTaskDispatch(fixture.repo, {
    run_id: fixture.runId, route: "integration-conflict", agent: "backend-builder",
  }, { claimDispatch: true, completionToken: token });
  writeFileSync(join(fixture.repo, path), `${contents}\n`);
  runGit(fixture.repo, ["add", path]);
  runGit(fixture.repo, ["commit", "-m", contents]);
  const resolutionHead = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
  await completeSpecialBuilderTaskDispatch(fixture.repo, {
    run_id: fixture.runId, route: "integration-conflict", agent: "backend-builder",
    claim_ref: context.dispatch_claim.ref, claim_hash: context.dispatch_claim.hash, completion_token: token,
  });
  await transitionSliceMerged(fixture.runDir, sliceId, { merge_commit: resolutionHead });
  return resolutionHead;
}

async function acceptIntegratedConflict(fixture, head, attempt) {
  await transitionRunStep(fixture.runDir, "test-verifier", { status: "running", attempts: attempt });
  const claimed = await claimCheckedTestExecution(fixture.runDir, { now: NOW, nonce: `123e4567-e89b-42d3-a456-${String(attempt).padStart(12, "0")}` });
  const emptyStream = { captured_bytes: 0, sha256: `sha256:${createHash("sha256").digest("hex")}`, truncated: false };
  const receipt = {
    schema_version: 1, kind: "checked-test-execution-receipt", subject: "test-verifier", run_id: fixture.runId, attempt,
    claim_nonce: claimed.claim.nonce, plan_ref: claimed.claim.plan_ref, plan_hash: claimed.claim.plan_hash, head_sha: head, timeout_ms: claimed.claim.timeout_ms,
    started_at: NOW, completed_at: NOW, duration_ms: 0, status: "pass", review_ready: true,
    commands: claimed.authority.commands.map((command, index) => ({ index, ...command, outcome: "exited", status: "pass", exit_code: 0, signal: null, error_code: null, duration_ms: 0, stdout: emptyStream, stderr: emptyStream })),
  };
  await completeCheckedTestExecution(fixture.runDir, claimed.claim, claimed.authority, receipt, { now: NOW });
  writeFileSync(join(fixture.runDir, "artifacts", "test-report.md"), `integrated conflict tests ${attempt} pass\n`);
  const reviewRef = `reviews/test-verifier.attempt-${attempt}.json`;
  writeJson(join(fixture.runDir, reviewRef), { subject: "test-verifier", attempt, verdict: "APPROVE", reviewed_head_sha: head, required_fixes: [] });
  return transitionRunStep(fixture.runDir, "test-verifier", {
    status: "accepted", attempts: attempt, artifact_ref: "artifacts/test-report.md", evidence_ref: claimed.claim.receipt_ref, review_ref: reviewRef,
  }, { mustExist: true });
}

function prepareAdditionalSliceConflict(fixture, { sliceId, branch, reviewedPath }) {
  const baseline = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
  runGit(fixture.repo, ["branch", branch, baseline]);
  const worktree = join(fixture.repo, ".opencode", "worktrees", sliceId);
  runGit(fixture.repo, ["worktree", "add", worktree, branch]);
  writeFileSync(join(worktree, reviewedPath), `reviewed ${sliceId} bytes\n`);
  runGit(worktree, ["add", reviewedPath]);
  runGit(worktree, ["commit", "-m", `reviewed ${sliceId}`]);
  const reviewedCommit = gitOutput(worktree, ["rev-parse", "HEAD"]);
  const evidenceRef = `evidence/${sliceId}.json`;
  const reviewRef = `reviews/${sliceId}.json`;
  writeJson(join(fixture.runDir, evidenceRef), { subject: sliceId, status: "pass", review_ready: true, attempt: 1, head_sha: reviewedCommit });
  writeJson(join(fixture.runDir, reviewRef), createV2SliceReviewRecord({ runDir: fixture.runDir, evidenceRef, subject: sliceId, attempt: 1, reviewedCommit }));
  const evidenceHash = hashFile(join(fixture.runDir, evidenceRef));
  const reviewHash = hashFile(join(fixture.runDir, reviewRef));
  const claimStem = createHash("sha256").update(`${fixture.runId}\0${sliceId}\0${1}`, "utf8").digest("hex");
  const claimRef = `dispatch/${claimStem}.json`;
  const closureRef = `dispatch/${claimStem}.closed.json`;
  const completionToken = `prepare-${sliceId}`;
  writeJson(join(fixture.runDir, claimRef), {
    schema_version: 1, kind: "checked-slice-builder-dispatch-claim", run_id: fixture.runId, slice_id: sliceId, attempt: 1,
    agent: "backend-builder", branch, worktree, head: baseline, context_hash: HASH,
    completion_token_hash: `sha256:${createHash("sha256").update(completionToken).digest("hex")}`, claimed_at: NOW, closure_ref: closureRef,
  });
  const claimHash = hashFile(join(fixture.runDir, claimRef));
  writeJson(join(fixture.runDir, closureRef), {
    schema_version: 1, kind: "checked-slice-builder-dispatch-closure", claim_ref: claimRef, claim_hash: claimHash,
    run_id: fixture.runId, slice_id: sliceId, attempt: 1, agent: "backend-builder", branch, worktree, head: baseline,
    completion_head: reviewedCommit, context_hash: HASH, completion_token: completionToken, returned_at: NOW,
  });
  const closureHash = hashFile(join(fixture.runDir, closureRef));
  const attemptReview = {
    attempt: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash,
    reviewed_commit: reviewedCommit, diff_base_commit: baseline, ownership_schema_version: 2, ratified_paths: [], modified_extensions: [],
    verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0,
    dispatch_claim_ref: claimRef, dispatch_claim_hash: claimHash, dispatch_closure_ref: closureRef, dispatch_closure_hash: closureHash,
  };
  const planPath = join(fixture.runDir, "plan", "slices.json");
  const run = readJson(join(fixture.runDir, "run.json"));
  const sliceIndex = run.slices.findIndex((slice) => slice.id === sliceId);
  assert.notEqual(sliceIndex, -1, "additional slice must be planned before the first integrated acceptance");
  run.slices[sliceIndex] = {
    id: sliceId, stack: "backend", depends_on: ["slice"], declared_paths: [reviewedPath], effective_paths: [reviewedPath], status: "review", attempts: 1,
    branch, worktree, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash, reviewed_commit: reviewedCommit,
    attempt_reviews: [attemptReview], dispatch_required: true, dispatch_claim_ref: claimRef, dispatch_claim_hash: claimHash, dispatch_closure_ref: closureRef, dispatch_closure_hash: closureHash,
  };
  writeJson(join(fixture.runDir, "run.json"), run);
  writeFileSync(join(fixture.repo, reviewedPath), `competing ${sliceId} bytes\n`);
  runGit(fixture.repo, ["add", reviewedPath]);
  runGit(fixture.repo, ["commit", "-m", `competing ${sliceId} change`]);
  const merge = spawnSync("git", ["merge", "--no-ff", branch, "-m", `merge ${sliceId}`], { cwd: fixture.repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.notEqual(merge.status, 0, "additional slice merge must conflict");
}

function seedPendingSlice(fixture, { sliceId, reviewedPath }) {
  const planPath = join(fixture.runDir, "plan", "slices.json");
  const plan = readJson(planPath);
  plan.slices.push({ id: sliceId, stack: "backend", paths: [reviewedPath], depends_on: ["slice"], acceptance: [sliceId], test_plan: [sliceId] });
  plan.delivery_envelope = deliveryEnvelopeForSlices(plan.slices);
  writeJson(planPath, plan);
  const run = readJson(join(fixture.runDir, "run.json"));
  for (const slice of run.slices.filter((candidate) => candidate.review_ref)) {
    const reviewPath = join(fixture.runDir, slice.review_ref);
    const review = readJson(reviewPath);
    for (const disposition of review.invariant_family_ledger?.dispositions || []) {
      const checked = writeVerificationArtifactReceipt({
        runDir: fixture.runDir,
        runId: fixture.runId,
        plan,
        sliceId: slice.id,
        attempt: slice.attempts,
        reviewedCommit: slice.reviewed_commit,
        artifactId: disposition.verification_artifact_id,
        evidenceRef: disposition.evidence_ref,
        result: disposition.result,
      });
      disposition.evidence_hash = checked.hash;
    }
    writeJson(reviewPath, review);
    slice.review_hash = hashFile(reviewPath);
    for (const history of slice.attempt_reviews || []) {
      if (history.review_ref === slice.review_ref) history.review_hash = slice.review_hash;
    }
  }
  run.slices.push({ id: sliceId, stack: "backend", depends_on: ["slice"], declared_paths: [reviewedPath], effective_paths: [reviewedPath], status: "pending", attempts: 0 });
  run.steps.find((step) => step.agent === "work-decomposer").acceptance.artifact_hash = hashFile(planPath);
  writeJson(join(fixture.runDir, "run.json"), run);
}

function makeConflictPathUndeclared(fixture, path) {
  const planPath = join(fixture.runDir, "plan", "slices.json");
  const plan = readJson(planPath);
  plan.slices[0].paths = ["src/**"];
  writeJson(planPath, plan);
  const evidencePath = join(fixture.runDir, "evidence", "slice.json");
  const reviewPath = join(fixture.runDir, "reviews", "slice.json");
  const evidence = readJson(evidencePath);
  evidence.ownership_disclosure = [{ path, rationale: "The adversarial fixture models a formerly ratified control-plane excursion." }];
  writeJson(evidencePath, evidence);
  const review = readJson(reviewPath);
  review.ownership_ratification = { schema_version: 1, paths: [path] };
  writeJson(reviewPath, review);
  const run = readJson(join(fixture.runDir, "run.json"));
  const slice = run.slices[0];
  slice.declared_paths = ["src/**"];
  slice.effective_paths = ["src/**", path];
  slice.evidence_hash = hashFile(evidencePath);
  slice.review_hash = hashFile(reviewPath);
  delete slice.attempt_reviews[0].ownership_schema_version;
  delete slice.attempt_reviews[0].modified_extensions;
  Object.assign(slice.attempt_reviews[0], { ratified_paths: [path], evidence_hash: slice.evidence_hash, review_hash: slice.review_hash });
  run.steps.find((step) => step.agent === "work-decomposer").acceptance.artifact_hash = hashFile(planPath);
  writeJson(join(fixture.runDir, "run.json"), run);
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
    if (args.join(" ") === "config --get remote.origin.url" || args.join(" ") === "config --get-all remote.origin.url") {
      return { ok: true, status: 0, stdout: "https://github.com/jasoncarreira/opencode-feature-factory.git\n", stderr: "" };
    }
    if (args[0] === "fetch" && args.at(-1).startsWith("+refs/heads/main:")) {
      return git(cwd, ["update-ref", args.at(-1).split(":").at(-1), current.base_commit]);
    }
    if (args[0] === "ls-remote") {
      const ref = args.at(-1).slice("refs/heads/".length);
      const sha = ref === "main" ? current.base_commit : gitOutput(repo, ["rev-parse", `refs/heads/${ref}`]);
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
    id: "slice", stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status: "merged", attempts: 1, branch: "slice-branch", worktree: fixture.repo,
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
    diff_base_commit: head,
    ownership_schema_version: 2,
    ratified_paths: [],
    modified_extensions: [],
    verdict: "APPROVE",
    convergence: "converging",
    late_discovery_strike: false,
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
  mkdirSync(join(fixture.runDir, "plan"), { recursive: true });
  const planPath = join(fixture.runDir, "plan", "slices.json");
  const plan = withDeliveryEnvelope({
    slices: slices.map((candidate) => ({
      id: candidate.id,
      stack: candidate.stack || "backend",
      paths: candidate.declared_paths || ["src/**"],
      depends_on: candidate.depends_on || [],
      acceptance: [`${candidate.id} works`],
      test_plan: [`test ${candidate.id}`],
    })),
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
  });
  writeJson(planPath, plan);
  const decompositionReviewRef = "reviews/work-decomposer.json";
  writeJson(join(fixture.runDir, decompositionReviewRef), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] });
  const receiptRef = "evidence/test-verifier.attempt-1.json";
  const testReviewRef = "reviews/test-verifier.attempt-1.json";
  const testArtifactRef = "artifacts/test-report.md";
  const nonce = "123e4567-e89b-42d3-a456-426614174127";
  const emptyStream = { captured_bytes: 0, sha256: `sha256:${createHash("sha256").digest("hex")}`, truncated: false };
  const receipt = {
    schema_version: 1, kind: "checked-test-execution-receipt", subject: "test-verifier", run_id: fixture.runId, attempt: 1,
    claim_nonce: nonce, plan_ref: "plan/slices.json", plan_hash: hashFile(planPath), head_sha: head, timeout_ms: plan.integration_gate.timeout_ms,
    started_at: NOW, completed_at: NOW, duration_ms: 0, status: "pass", review_ready: true,
    commands: plan.integration_gate.required_commands.map((command, index) => ({ index, ...command, outcome: "exited", status: "pass", exit_code: 0, signal: null, error_code: null, duration_ms: 0, stdout: emptyStream, stderr: emptyStream })),
  };
  writeJson(join(fixture.runDir, receiptRef), receipt);
  const claim = {
    schema_version: 1, kind: "checked-test-execution-claim", state: "completed", nonce, run_id: fixture.runId, attempt: 1,
    plan_ref: "plan/slices.json", plan_hash: hashFile(planPath), head_sha: head, timeout_ms: plan.integration_gate.timeout_ms, receipt_ref: receiptRef,
    claimed_at: NOW, completed_at: NOW, status: "pass", receipt_hash: hashFile(join(fixture.runDir, receiptRef)),
  };
  writeFileSync(join(fixture.runDir, testArtifactRef), "checked integration passed\n");
  writeJson(join(fixture.runDir, testReviewRef), { subject: "test-verifier", attempt: 1, verdict: "APPROVE", reviewed_head_sha: head, required_fixes: [] });
  const steps = [{
    agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: decompositionReviewRef,
    acceptance: { artifact_ref: "plan/slices.json", artifact_hash: hashFile(planPath), review_ref: decompositionReviewRef, review_hash: hashFile(join(fixture.runDir, decompositionReviewRef)) },
  }, {
    agent: "test-verifier", status: "accepted", attempts: 1, artifact_ref: testArtifactRef, evidence_ref: receiptRef, review_ref: testReviewRef,
    execution_claim: claim, execution_claim_hash: hashValue(claim),
    acceptance: {
      artifact_ref: testArtifactRef, artifact_hash: hashFile(join(fixture.runDir, testArtifactRef)), evidence_ref: receiptRef,
      evidence_hash: hashFile(join(fixture.runDir, receiptRef)), review_ref: testReviewRef, review_hash: hashFile(join(fixture.runDir, testReviewRef)), reviewed_head_sha: head,
    },
  }];
  const questionRef = "gates/story.question.md";
  writeFileSync(join(fixture.runDir, questionRef), "approve story?\n");
  const checkedAuthorityHash = hashValue({
    test_execution_claim_hash: hashValue(claim),
    test_acceptance: steps[1].acceptance,
    validator: { report_hash: validator.report_hash, review_hash: validator.review_hash, reviewed_head_sha: validator.reviewed_head_sha },
    security_review: { review_hash: securityReview.review_hash, reviewed_head_sha: securityReview.reviewed_head_sha },
  });
  writeJson(join(fixture.runDir, "run.json"), {
    ...baseRun(fixture.runId),
    branch,
    base_ref: "main",
    base_commit: gitOutput(fixture.repo, ["rev-parse", "refs/heads/main"]),
    worktree: fixture.repo,
    pr_mode: "ready",
    gates: { pre_pr: {
      status: "approved", artifact: "artifacts/story.md", question_ref: questionRef, answer: "approve", answered_at: NOW,
      pending_snapshot: {
        question_ref: questionRef, question_hash: hashFile(join(fixture.runDir, questionRef)),
        artifact_ref: "artifacts/story.md", artifact_hash: hashFile(join(fixture.runDir, "artifacts", "story.md")),
        created_at: NOW, checked_authority_hash: checkedAuthorityHash,
      },
    } },
    slices,
    steps,
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
    declared_paths: [`${slice.id}.txt`],
    effective_paths: [`${slice.id}.txt`],
    status: "merged",
    attempts: slice.attempts,
    evidence_ref: slice.evidence_ref,
    evidence_hash: slice.evidence_hash,
    review_ref: slice.review_ref,
    review_hash: slice.review_hash,
    reviewed_commit: slice.reviewed_commit,
    merge_commit: slice.merge_commit,
    attempt_reviews: slice.attempt_reviews,
  } : { ...slice, stack: slice.stack || "backend", depends_on: slice.depends_on || [], declared_paths: [`${slice.id}.txt`], effective_paths: [`${slice.id}.txt`] });
  mkdirSync(join(runDir, "plan"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "technical-brief.md"), "accepted synthetic brief\n");
  writeJson(join(runDir, "reviews", "spec-writer.json"), { subject: "spec-writer", attempt: 1, verdict: "APPROVE" });
  const plan = withDeliveryEnvelope({
    integration_gate: { required_commands: [{ program: "node", args: ["--test", "test/integration.test.js"] }, { program: "npm", args: ["run", "check"] }] },
    slices: run.slices.map((slice) => ({ id: slice.id, stack: slice.stack, paths: [`${slice.id}.txt`], depends_on: slice.depends_on, acceptance: [`${slice.id} accepted`], test_plan: [`test ${slice.id}`] })),
  });
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

async function prepareReportedIntegrationAmendmentFixture(runId, { progressedConsumer = false } = {}) {
  const fixture = createFixture(runId);
  initGitRepo(fixture.repo, ["owner-branch"]);
  writeFileSync(join(fixture.repo, ".gitignore"), ".opencode/\n");
  mkdirSync(join(fixture.repo, "src", "owner"), { recursive: true });
  mkdirSync(join(fixture.repo, "docs"), { recursive: true });
  writeFileSync(join(fixture.repo, "src", "owner", "shared.js"), "export const shared = 1;\n");
  writeFileSync(join(fixture.repo, "docs", "owner-extension.md"), "owner baseline\n");
  runGit(fixture.repo, ["add", ".gitignore", "src/owner/shared.js", "docs/owner-extension.md"]);
  runGit(fixture.repo, ["commit", "-m", "seed amendment owner baseline"]);
  runGit(fixture.repo, ["branch", "-f", "owner-branch", "HEAD"]);
  const base = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
  const ownerWorktree = join(fixture.repo, ".opencode", "worktrees", "owner-branch");
  mkdirSync(join(fixture.repo, ".opencode", "worktrees"), { recursive: true });
  runGit(fixture.repo, ["worktree", "add", ownerWorktree, "owner-branch"]);
  mkdirSync(join(ownerWorktree, "src", "owner"), { recursive: true });
  writeFileSync(join(ownerWorktree, "src", "owner", "api.js"), "export const value = 1;\n");
  writeFileSync(join(ownerWorktree, "docs", "owner-extension.md"), "owner extension\n");
  runGit(ownerWorktree, ["add", "src/owner/api.js", "docs/owner-extension.md"]);
  runGit(ownerWorktree, ["commit", "-m", "owner implementation"]);
  const reviewedCommit = gitOutput(ownerWorktree, ["rev-parse", "HEAD"]);
  const featureBranch = `${runId}-feature`;
  runGit(fixture.repo, ["checkout", "-b", featureBranch, base]);
  runGit(fixture.repo, ["merge", "--no-ff", "owner-branch", "-m", "merge owner implementation"]);
  const baseline = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
  const baselineTree = gitOutput(fixture.repo, ["rev-parse", `${baseline}^{tree}`]);
  for (const dir of ["plan", "evidence", "reviews", "dispatch"]) mkdirSync(join(fixture.runDir, dir), { recursive: true });
  const plan = withDeliveryEnvelope({
    slices: [
      { id: "owner", stack: "backend", paths: ["src/owner/**"], depends_on: [], acceptance: ["owner works"], test_plan: ["node --test test/owner.test.js"] },
      { id: "consumer", stack: "backend", paths: ["src/consumer/**"], depends_on: ["owner"], acceptance: ["consumer works"], test_plan: ["node --test test/consumer.test.js"] },
    ],
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
  });
  writeJson(join(fixture.runDir, "plan", "slices.json"), plan);
  writeJson(join(fixture.runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] });
  const family = writeVerificationArtifactReceipt({
    runDir: fixture.runDir, runId, plan, sliceId: "owner", attempt: 1, reviewedCommit,
    artifactId: "fixture-artifact-1", evidenceRef: "evidence/owner-family.json",
    result: { type: "verification-result", outcome: "pass", summary: "Verify owner behavior passed" },
  });
  const ownerExtensionPath = "docs/owner-extension.md";
  const ownerExtensionRationale = "The owner requires this private documentation extension for the amendment fixture.";
  writeJson(join(fixture.runDir, "evidence", "owner.json"), {
    subject: "owner", attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommit,
    ownership_disclosure: [{ path: ownerExtensionPath, rationale: ownerExtensionRationale }],
  });
  const ownerReview = createSliceReviewRecord({ subject: "owner", attempt: 1, reviewedCommit });
  ownerReview.ownership_ratification = { schema_version: 2, kind: "factory-derived-modified-extension" };
  ownerReview.invariant_family_ledger = passingInvariantFamilyLedger({ plan, sliceId: "owner", reviewedCommit, evidenceRef: family.ref, evidenceHash: family.hash });
  writeJson(join(fixture.runDir, "reviews", "owner.json"), ownerReview);
  const claimStem = createHash("sha256").update(`${runId}\0owner\0${1}`, "utf8").digest("hex");
  const claimRef = `dispatch/${claimStem}.json`;
  const closureRef = `dispatch/${claimStem}.closed.json`;
  const token = "integration-amendment-owner-token";
  writeJson(join(fixture.runDir, claimRef), {
    schema_version: 1, kind: "checked-slice-builder-dispatch-claim", run_id: runId, slice_id: "owner", attempt: 1,
    agent: "backend-builder", branch: "owner-branch", worktree: ownerWorktree, head: base,
    context_hash: HASH, completion_token_hash: `sha256:${createHash("sha256").update(token).digest("hex")}`,
    claimed_at: NOW, closure_ref: closureRef,
  });
  const claimHash = hashFile(join(fixture.runDir, claimRef));
  writeJson(join(fixture.runDir, closureRef), {
    schema_version: 1, kind: "checked-slice-builder-dispatch-closure", claim_ref: claimRef, claim_hash: claimHash,
    run_id: runId, slice_id: "owner", attempt: 1, agent: "backend-builder", branch: "owner-branch", worktree: ownerWorktree,
    head: base, completion_head: reviewedCommit, context_hash: HASH, completion_token: token, returned_at: NOW,
  });
  const dispatch = { dispatch_claim_ref: claimRef, dispatch_claim_hash: claimHash, dispatch_closure_ref: closureRef, dispatch_closure_hash: hashFile(join(fixture.runDir, closureRef)) };
  const legacyOrderedAttemptReview = createSliceAttemptReview({
    attempt: 1, evidenceRef: "evidence/owner.json", evidenceHash: hashFile(join(fixture.runDir, "evidence", "owner.json")),
    reviewRef: "reviews/owner.json", reviewHash: hashFile(join(fixture.runDir, "reviews", "owner.json")), reviewedCommit, diffBaseCommit: base,
    ratifiedPaths: [ownerExtensionPath],
  });
  const { ratified_paths: ownerRatifiedPaths, verdict: ownerVerdict, convergence: ownerConvergence,
    late_discovery_strike: ownerLateDiscoveryStrike, remaining_fix_count: ownerRemainingFixCount, ...ownerAttemptIdentity } = legacyOrderedAttemptReview;
  const attemptReview = { ...ownerAttemptIdentity, ownership_schema_version: 2, ratified_paths: ownerRatifiedPaths, modified_extensions: [{
    kind: "modified-extension", path: ownerExtensionPath, rationale: ownerExtensionRationale, authority: "unowned",
  }], verdict: ownerVerdict, convergence: ownerConvergence, late_discovery_strike: ownerLateDiscoveryStrike,
    remaining_fix_count: ownerRemainingFixCount, ...dispatch };
  const owner = {
    id: "owner", stack: "backend", depends_on: [], declared_paths: ["src/owner/**"], effective_paths: ["src/owner/**", ownerExtensionPath], status: "merged",
    branch: "owner-branch", worktree: ownerWorktree, attempts: 1, dispatch_required: true, ...dispatch, attempt_reviews: [attemptReview],
    evidence_ref: attemptReview.evidence_ref, evidence_hash: attemptReview.evidence_hash, review_ref: attemptReview.review_ref,
    review_hash: attemptReview.review_hash, reviewed_commit: reviewedCommit, merge_commit: baseline,
  };
  const consumer = { id: "consumer", stack: "backend", depends_on: ["owner"], declared_paths: ["src/consumer/**"], effective_paths: ["src/consumer/**"], status: "pending", attempts: 0 };
  writeJson(join(fixture.runDir, "run.json"), {
    schema_version: 1, run_id: runId, status: "running", branch: featureBranch, worktree: fixture.repo, gates: {}, slices: [owner, consumer],
    steps: [{ agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
      acceptance: { artifact_ref: "plan/slices.json", artifact_hash: hashFile(join(fixture.runDir, "plan", "slices.json")), review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(fixture.runDir, "reviews", "work-decomposer.json")) } }],
  });
  const unit = plan.delivery_envelope.delivery_units.find((entry) => entry.slice_id === "consumer");
  const artifact = unit.verification_artifacts[0];
  const admission = {
    baseline_ref: `refs/heads/${featureBranch}`, baseline_commit: baseline, baseline_tree: baselineTree, worktree: fixture.repo,
    probe: { schema_version: 1, kind: "integration-amendment-probe", delivery_unit_id: unit.id, consumer_slice_id: "consumer", verification_artifact_id: artifact.id,
      test_plan_index: artifact.test_plan_index, test_plan_entry: artifact.test_plan_entry, program: "node", args: ["--test", "test/consumer.test.js"], timeout_ms: artifact.timeout_ms, substrate: "feature-baseline" },
    owner: Object.fromEntries(["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts", "attempt_reviews", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "merge_commit"].map((key) => [key, structuredClone(owner[key])])),
    consumer: structuredClone(consumer),
  };
  const identity = { schema_version: 1, kind: "integration-amendment-identity", run_id: runId, defect_path: "src/owner/api.js", admission };
  const amendmentId = integrationAmendmentId(identity);
  const nonce = "integration-amendment-report-nonce";
  const receiptRef = `evidence/integration-amendment-${amendmentId}.report.receipt.json`;
  const stream = { captured_bytes: 0, sha256: `sha256:${createHash("sha256").update("").digest("hex")}`, truncated: false };
  const receipt = { schema_version: 1, kind: "integration-amendment-execution-receipt", phase: "report", subject: `integration-amendment:${amendmentId}:report`, run_id: runId,
    amendment_id: amendmentId, claim_nonce: nonce, probe: admission.probe, head_sha: baseline, tree_sha: baselineTree, cwd: fixture.repo, timeout_ms: artifact.timeout_ms,
    started_at: NOW, completed_at: NOW, duration_ms: 1, status: "fail", review_ready: true,
    commands: [{ index: 0, program: "node", args: ["--test", "test/consumer.test.js"], outcome: "exited", status: "fail", exit_code: 1, signal: null, error_code: null, duration_ms: 1, stdout: stream, stderr: stream }] };
  writeJson(join(fixture.runDir, receiptRef), receipt);
  writeJson(join(fixture.runDir, "evidence", "integration-amendment.report.claim.json"), {
    schema_version: 1, kind: "integration-amendment-execution-claim", phase: "report", subject: receipt.subject, state: "completed", nonce, amendment_id: amendmentId,
    identity, run_id: runId, probe: admission.probe, head_sha: baseline, tree_sha: baselineTree, cwd: fixture.repo, timeout_ms: artifact.timeout_ms,
    receipt_ref: receiptRef, claimed_at: NOW, completed_at: NOW, status: "fail", receipt_hash: hashFile(join(fixture.runDir, receiptRef)),
  });
  await transitionIntegrationAmendment(fixture.runDir, { action: "report", owner_slice_id: "owner", consumer_slice_id: "consumer", defect_path: "src/owner/api.js", verification_artifact_id: artifact.id }, { repoRoot: fixture.repo, now: NOW });
  if (progressedConsumer) {
    const consumerBranch = "consumer-branch";
    const consumerWorktree = join(fixture.repo, ".opencode", "worktrees", consumerBranch);
    runGit(fixture.repo, ["branch", consumerBranch, baseline]);
    runGit(fixture.repo, ["worktree", "add", consumerWorktree, consumerBranch]);
    writeFileSync(join(consumerWorktree, "src", "owner", "shared.js"), "export const shared = 2;\n");
    runGit(consumerWorktree, ["add", "src/owner/shared.js"]);
    runGit(consumerWorktree, ["commit", "-m", "consumer modifies sibling-owned shared file"]);
    const consumerReviewedCommit = gitOutput(consumerWorktree, ["rev-parse", "HEAD"]);
    const consumerRationale = "The consumer must update the sibling-owned shared compatibility module.";
    const consumerFamily = writeVerificationArtifactReceipt({
      runDir: fixture.runDir, runId, plan, sliceId: "consumer", attempt: 1, reviewedCommit: consumerReviewedCommit,
      artifactId: plan.delivery_envelope.delivery_units.find((entry) => entry.slice_id === "consumer").verification_artifacts[0].id,
      evidenceRef: "evidence/consumer-family.json",
      result: { type: "verification-result", outcome: "pass", summary: "Verify consumer behavior passed" },
    });
    writeJson(join(fixture.runDir, "evidence", "consumer.json"), {
      subject: "consumer", attempt: 1, status: "pass", review_ready: true, head_sha: consumerReviewedCommit,
      ownership_disclosure: [{ path: "src/owner/shared.js", rationale: consumerRationale }],
    });
    const consumerReview = createSliceReviewRecord({ subject: "consumer", attempt: 1, reviewedCommit: consumerReviewedCommit });
    consumerReview.ownership_ratification = { schema_version: 2, kind: "factory-derived-modified-extension" };
    consumerReview.invariant_family_ledger = passingInvariantFamilyLedger({
      plan, sliceId: "consumer", reviewedCommit: consumerReviewedCommit,
      evidenceRef: consumerFamily.ref, evidenceHash: consumerFamily.hash,
    });
    writeJson(join(fixture.runDir, "reviews", "consumer.json"), consumerReview);
    const consumerClaimStem = createHash("sha256").update(`${runId}\0consumer\0${1}`, "utf8").digest("hex");
    const consumerClaimRef = `dispatch/${consumerClaimStem}.json`;
    const consumerClosureRef = `dispatch/${consumerClaimStem}.closed.json`;
    const consumerToken = "integration-amendment-consumer-token";
    writeJson(join(fixture.runDir, consumerClaimRef), {
      schema_version: 1, kind: "checked-slice-builder-dispatch-claim", run_id: runId, slice_id: "consumer", attempt: 1,
      agent: "backend-builder", branch: consumerBranch, worktree: consumerWorktree, head: baseline,
      context_hash: HASH, completion_token_hash: `sha256:${createHash("sha256").update(consumerToken).digest("hex")}`,
      claimed_at: NOW, closure_ref: consumerClosureRef,
    });
    const consumerClaimHash = hashFile(join(fixture.runDir, consumerClaimRef));
    writeJson(join(fixture.runDir, consumerClosureRef), {
      schema_version: 1, kind: "checked-slice-builder-dispatch-closure", claim_ref: consumerClaimRef, claim_hash: consumerClaimHash,
      run_id: runId, slice_id: "consumer", attempt: 1, agent: "backend-builder", branch: consumerBranch, worktree: consumerWorktree,
      head: baseline, completion_head: consumerReviewedCommit, context_hash: HASH, completion_token: consumerToken, returned_at: NOW,
    });
    const consumerDispatch = {
      dispatch_claim_ref: consumerClaimRef,
      dispatch_claim_hash: consumerClaimHash,
      dispatch_closure_ref: consumerClosureRef,
      dispatch_closure_hash: hashFile(join(fixture.runDir, consumerClosureRef)),
    };
    const run = readJson(join(fixture.runDir, "run.json"));
    const currentOwner = run.slices.find((slice) => slice.id === "owner");
    const ownerEntry = currentOwner.attempt_reviews[0];
    const consumerExtension = {
      kind: "modified-extension", path: "src/owner/shared.js", rationale: consumerRationale, authority: "non-conflicting-sibling",
      owner_slice_id: "owner", owner_attempt: 1,
      owner_evidence_ref: ownerEntry.evidence_ref, owner_evidence_hash: ownerEntry.evidence_hash,
      owner_review_ref: ownerEntry.review_ref, owner_review_hash: ownerEntry.review_hash,
      owner_dispatch_claim_ref: ownerEntry.dispatch_claim_ref, owner_dispatch_claim_hash: ownerEntry.dispatch_claim_hash,
      owner_dispatch_closure_ref: ownerEntry.dispatch_closure_ref, owner_dispatch_closure_hash: ownerEntry.dispatch_closure_hash,
      owner_reviewed_commit: ownerEntry.reviewed_commit, owner_diff_base_commit: ownerEntry.diff_base_commit,
    };
    const consumerAttemptReview = {
      attempt: 1,
      evidence_ref: "evidence/consumer.json", evidence_hash: hashFile(join(fixture.runDir, "evidence", "consumer.json")),
      review_ref: "reviews/consumer.json", review_hash: hashFile(join(fixture.runDir, "reviews", "consumer.json")),
      reviewed_commit: consumerReviewedCommit, diff_base_commit: baseline, ownership_schema_version: 2,
      ratified_paths: ["src/owner/shared.js"], modified_extensions: [consumerExtension],
      verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0,
      ...consumerDispatch,
    };
    Object.assign(run.slices.find((slice) => slice.id === "consumer"), {
      status: "running", attempts: 2, branch: consumerBranch, worktree: consumerWorktree,
      authorized_baseline_commit: baseline, attempt_reviews: [consumerAttemptReview],
    });
    writeJson(join(fixture.runDir, "run.json"), run);
  }
  return { ...fixture, baseline, reviewedCommit };
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
    slices: [{ id: "slice", declared_paths: ["src/**"], effective_paths: ["src/**"], status: "running", attempts: 1 }],
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
  writeJson(join(runDir, "plan", "slices.json"), withDeliveryEnvelope({
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: projection.map((slice) => ({
      id: slice.id,
      stack: slice.stack,
      paths: slice.declared_paths || [`${slice.id}.txt`],
      depends_on: slice.depends_on,
      acceptance: [`${slice.id} accepted`],
      test_plan: [`test ${slice.id}`],
    })),
  }));
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
