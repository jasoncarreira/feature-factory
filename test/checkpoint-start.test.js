import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildCheckpointRoutingManifest, checkpointRoutingArtifact } from "../src/delivery-envelope/checkpoint-routing.js";
import { evaluateDeliveryEnvelopeAdmission } from "../src/delivery-envelope/admission-extension.js";
import { attachCheckpointCompletionRecovery, cleanupRun, closeFactoryCheckpointRoute, continueFactory, recordFactoryCheckpointMerged, resumeFactory, startFactoryCheckpoint } from "../src/factory.js";
import { runCliCommand } from "../src/cli.js";
import { decodeFeatureCommandPayload } from "../src/feature-command-payload.js";
import { transitionCheckpointProgressLaunched, transitionCheckpointProgressMerged } from "../src/run-state.js";
import { validateRunDir } from "../src/validate.js";
import { execFileSync } from "./helpers/git-fixture.js";

describe("B4.3 normal checkpoint child start", () => {
  it("publishes complete normal configuration and launches with only an ordinary resume payload", async () => {
    const fixture = createFixture("normal-launch", { reviewTier: "strict" });
    let payload;
    try {
      const freshMain = advanceRemoteMain(fixture, "fresh-main.txt");
      const result = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo,
        runId: "normal-launch-child",
        autonomous: true,
        draft: true,
        ghAccount: "acme",
        postPrCi: true,
        reviewer: "mimirbot",
        now: "2026-07-19T12:00:00.000Z",
        foregroundLaunchFn: async (_repo, commandArgs) => {
          const decoded = decodeFeatureCommandPayload(commandArgs.at(-1), { repo: fixture.repo });
          assert.equal(decoded.ok, true, JSON.stringify(decoded));
          payload = decoded.payload;
          return { status: "launched", run_id: "normal-launch-child" };
        },
      });

      assert.deepEqual(result, { status: "launched", run_id: "normal-launch-child" });
      const parent = readJson(join(fixture.parentRunDir, "run.json"));
      const progress = parent.checkpoint_progress.entries[0];
      assert.equal(progress.state, "launched");
      assert.equal(progress.base_commit, freshMain);
      assert.deepEqual(progress.configuration, {
        mode: "autonomous",
        github_account: "acme",
        pr_mode: "draft",
        max_parallel_slices: 3,
        max_retries: 3,
        post_pr_policy: {
          enabled: true,
          wait_ms: 3_600_000,
          initial_poll_ms: 30_000,
          max_poll_ms: 120_000,
          check_start_grace_ms: 300_000,
          max_transient_errors: 12,
          review: { required: true, reviewer_login: "mimirbot", source: "driver" },
        },
        review_tier: "strict",
      });
      assert.match(progress.child_run_hash, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(progress.child_plan_hash, fixture.manifest.checkpoints[0].child_plan_hash);
      assert.equal(progress.brief_scope_hash, fixture.manifest.checkpoints[0].brief_scope_hash);

      const child = readJson(join(fixture.repo, ".opencode", "factory", "normal-launch-child", "run.json"));
      assert.equal(child.mode, "autonomous");
      assert.equal(child.github_account, "acme");
      assert.equal(child.pr_mode, "draft");
      assert.equal(child.review_tier, "strict");
      assert.deepEqual(child.post_pr.policy, progress.configuration.post_pr_policy);
      assert.equal(child.base_ref, "refs/remotes/origin/main");
      assert.equal(child.base_commit, freshMain);
      assert.equal(child.checkpoint, undefined);
      assert.equal(child.continuation, undefined);
      assert.equal(child.checkpoint_source.root_child_run_id, "normal-launch-child");

      assert.deepEqual(Object.keys(payload).sort(), ["continuation", "driver", "operator_request", "resume", "steering"]);
      assert.equal(payload.operator_request, "resume normal-launch-child");
      assert.equal(payload.resume.kind, "existing-run-resume");
      assert.equal(payload.resume.schema_version, 1);
      assert.equal(payload.driver.mode, "autonomous");
      assert.equal(payload.driver.pr_mode, "draft");
      assert.equal(payload.driver.reviewer, "mimirbot");
      for (const key of ["checkpoint", "checkpoint_reservation", "checkpoint_request"]) assert.equal(Object.hasOwn(payload, key), false);

      assert.equal(refExists(fixture.repo, progress.publication_claim_ref), true);
      const claimBytes = git(fixture.repo, "cat-file", "blob", progress.publication_claim_oid);
      assert.deepEqual(Buffer.from(claimBytes), canonicalBytes(JSON.parse(claimBytes)));
    } finally {
      fixture.cleanup();
    }
  });

  it("copies the exact approved disposition and preserves explicit null review tier through child-published replay", async () => {
    const fixture = createFixture("exact-disposition");
    try {
      const options = {
        cwd: fixture.repo,
        runId: "exact-disposition-child",
        dryRun: true,
        now: "2026-07-19T12:01:00.000Z",
      };
      const first = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", options);
      assert.equal(first.status, "dry-run");
      assert.equal(first.payload.resume.kind, "existing-run-resume");
      assert.equal(Object.hasOwn(first.payload, "checkpoint"), false);

      const parent = readJson(join(fixture.parentRunDir, "run.json"));
      assert.equal(parent.checkpoint_progress.entries[0].state, "child-published");
      assert.equal(parent.checkpoint_progress.entries[0].configuration.review_tier, null);
      const childDir = join(fixture.repo, ".opencode", "factory", "exact-disposition-child");
      const child = readJson(join(childDir, "run.json"));
      assert.equal(Object.hasOwn(child, "review_tier"), false);
      assert.deepEqual(
        readFileSync(join(childDir, "reviews", "work-decomposer.json")),
        canonicalBytes(fixture.manifest.checkpoints[0].child_disposition),
      );

      let launches = 0;
      await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        ...options,
        dryRun: false,
        foregroundLaunchFn: async () => { launches += 1; return { status: "launched" }; },
      });
      assert.equal(launches, 1);
      assert.equal(readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries[0].state, "launched");
    } finally {
      fixture.cleanup();
    }
  });

  it("carries an actually published checkpoint child forward from its exact decomposition without fabricating spec authority", async () => {
    const fixture = createFixture("published-b1", { reviewTier: "strict" });
    const sourceRunId = "published-b1-child";
    const targetRunId = "published-b1-continuation";
    const sourceRunDir = join(fixture.repo, ".opencode", "factory", sourceRunId);
    const targetRunDir = join(fixture.repo, ".opencode", "factory", targetRunId);
    let decodedPayload;
    try {
      await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo,
        runId: sourceRunId,
        now: "2026-07-19T12:01:00.000Z",
        foregroundLaunchFn: async () => ({ status: "launched", run_id: sourceRunId }),
      });

      const routingParent = readJson(join(fixture.parentRunDir, "run.json"));
      const storedConfiguration = routingParent.checkpoint_progress.entries[0].configuration;
      const published = readJson(join(sourceRunDir, "run.json"));
      const checkpointSource = structuredClone(published.checkpoint_source);
      const sourcePlan = readFileSync(join(sourceRunDir, "plan", "slices.json"));
      const sourceDisposition = readFileSync(join(sourceRunDir, "reviews", "work-decomposer.json"));
      const sourceDecompositionStep = structuredClone(published.steps.find((step) => step.agent === "work-decomposer"));
      const continuationReviewRef = "reviews/continuation.json";
      writeJson(join(sourceRunDir, continuationReviewRef), {
        subject: sourceRunId,
        attempt: 1,
        summary: "Continue the blocked checkpoint child.",
        required_fixes: ["Complete the remaining checkpoint slice"],
      });
      published.status = "blocked";
      published.updated_at = "2026-07-19T12:02:00.000Z";
      published.validator = { verdict: "NO-GO", review_ref: continuationReviewRef };
      published.terminal_result = {
        status: "blocked",
        run_id: sourceRunId,
        pr_url: null,
        reason: "validation blocked",
        summary: "Continue before PR creation.",
        artifacts: {},
      };
      writeJson(join(sourceRunDir, "run.json"), published);
      assert.equal(validateRunDir(sourceRunDir).ok, true);
      assert.deepEqual({
        mode: published.mode,
        github_account: published.github_account ?? null,
        pr_mode: published.pr_mode,
        max_parallel_slices: published.max_parallel_slices,
        max_retries: published.max_retries,
        post_pr_policy: published.post_pr.policy,
        review_tier: published.review_tier ?? null,
      }, storedConfiguration);

      const result = await continueFactory(sourceRunId, {
        cwd: fixture.repo,
        review: continuationReviewRef,
        runId: targetRunId,
        carryForward: true,
        now: "2026-07-19T12:03:00.000Z",
        foregroundLaunchFn: async (_repo, commandArgs) => {
          const decoded = decodeFeatureCommandPayload(commandArgs.at(-1), { repo: git(fixture.repo, "rev-parse", "--show-toplevel").trim() });
          assert.equal(decoded.ok, true, JSON.stringify(decoded));
          decodedPayload = decoded.payload;
          return { status: "launched", run_id: targetRunId };
        },
      });
      const continuation = result.payload.continuation;
      const child = readJson(join(targetRunDir, "run.json"));
      const claimRef = `refs/opencode/continuations/${createHash("sha256").update(canonicalJson(continuationParentIdentity(continuation))).digest("hex")}`;
      const claim = JSON.parse(git(fixture.repo, "cat-file", "blob", claimRef));

      assert.deepEqual(continuation.planning_reuse, {
        eligible: true,
        plan_ref: "plan/slices.json",
        plan_hash: hashBytes(sourcePlan),
        review_ref: "reviews/work-decomposer.json",
        review_hash: hashBytes(sourceDisposition),
      });
      assert.deepEqual(decodedPayload.continuation.planning_reuse, continuation.planning_reuse);
      assert.deepEqual(continuation.configuration, storedConfiguration);
      assert.equal(continuation.checkpoint_source_hash, hashCanonicalValue(checkpointSource));
      assert.equal(continuation.configuration_hash, hashCanonicalValue(storedConfiguration));
      assert.equal(claim.checkpoint_source_hash, continuation.checkpoint_source_hash);
      assert.equal(claim.configuration_hash, continuation.configuration_hash);
      assert.deepEqual(child.checkpoint_source, checkpointSource);
      assert.deepEqual(child.continuation.configuration, storedConfiguration);
      assert.equal(child.review_tier, "strict");
      assert.deepEqual(child.steps.find((step) => step.agent === "work-decomposer"), sourceDecompositionStep);
      assert.deepEqual(readFileSync(join(targetRunDir, "plan", "slices.json")), sourcePlan);
      assert.deepEqual(readFileSync(join(targetRunDir, "reviews", "work-decomposer.json")), sourceDisposition);
      assert.equal(child.steps.some((step) => step.agent === "spec-writer"), false);
      assert.equal(existsSync(join(targetRunDir, "artifacts", "technical-brief.md")), false);
      assert.equal(existsSync(join(targetRunDir, "reviews", "spec-writer.json")), false);
      assert.equal(validateRunDir(targetRunDir).ok, true);
    } finally {
      fixture.cleanup();
    }
  });

  it("reconciles an exact reserved publication without changing its immutable claim", async () => {
    const fixture = createFixture("reserved-replay");
    const options = {
      cwd: fixture.repo,
      runId: "reserved-replay-child",
      dryRun: true,
      now: "2026-07-19T12:02:00.000Z",
    };
    try {
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        ...options,
        beforeRefTransaction: () => { throw new Error("interrupt after reservation"); },
      }), /interrupt after reservation/u);
      const reserved = readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries[0];
      assert.equal(reserved.state, "reserved");
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "reserved-replay-child")), false);

      const replay = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", options);
      const published = readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries[0];
      assert.equal(replay.status, "dry-run");
      assert.equal(published.state, "child-published");
      assert.equal(published.publication_claim_oid, reserved.publication_claim_oid);
      assert.equal(published.reserved_at, reserved.reserved_at);
    } finally {
      fixture.cleanup();
    }
  });

  it("enforces strict sequence, one child identity, and immutable replay configuration", async () => {
    const fixture = createFixture("strict-sequence", { reviewTier: "standard" });
    try {
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        cwd: fixture.repo, runId: "skipped-child", dryRun: true,
      }), /not the strict next checkpoint/u);
      assert.deepEqual(readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries, []);

      await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "strict-child", dryRun: true,
      });
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        cwd: fixture.repo, runId: "early-second", dryRun: true,
      }), /requires merged predecessor/u);
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "other-child", dryRun: true,
      }), /conflicting child run/u);
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "strict-child", dryRun: true, draft: true,
      }), /persisted immutable configuration/u);
    } finally {
      fixture.cleanup();
    }
  });

  it("uses ordinary launch ownership to prevent a concurrent checkpoint-start retry from launching twice", async () => {
    const fixture = createFixture("launch-retry");
    let launches = 0;
    let releaseLaunch;
    let markEntered;
    const entered = new Promise((resolve) => { markEntered = resolve; });
    const release = new Promise((resolve) => { releaseLaunch = resolve; });
    const options = {
      cwd: fixture.repo,
      runId: "launch-retry-child",
      now: "2026-07-19T12:03:00.000Z",
      foregroundLaunchFn: async () => {
        launches += 1;
        markEntered();
        await release;
        return { status: "launched" };
      },
    };
    try {
      const first = startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", options);
      await entered;
      const retry = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", options);
      assert.equal(retry.status, "recovery-required");
      assert.equal(retry.reason_code, "launch-claim-conflict");
      assert.equal(launches, 1);
      releaseLaunch();
      await first;
      assert.equal(readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries[0].state, "launched");
    } finally {
      releaseLaunch?.();
      fixture.cleanup();
    }
  });

  it("reconciles child-published progress when the checkpoint child is resumed directly", async () => {
    const fixture = createFixture("direct-resume");
    try {
      await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "direct-resume-child", dryRun: true,
      });
      assert.equal(readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries[0].state, "child-published");

      let launches = 0;
      await resumeFactory("direct-resume-child", {
        cwd: fixture.repo,
        foregroundLaunchFn: async () => {
          launches += 1;
          assert.equal(readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries[0].state, "launched");
          return { status: "launched", run_id: "direct-resume-child" };
        },
      });
      assert.equal(launches, 1);
      assert.equal(readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries[0].state, "launched");
    } finally {
      fixture.cleanup();
    }
  });

  it("returns merged progress without invoking any launch path", async () => {
    const fixture = createFixture("merged-replay");
    const options = {
      cwd: fixture.repo,
      runId: "merged-replay-child",
      dryRun: true,
      now: "2026-07-19T12:04:00.000Z",
    };
    try {
      await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", options);
      const published = readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries[0];
      const launched = { ...published, state: "launched", launched_at: "2026-07-19T12:04:01.000Z" };
      await transitionCheckpointProgressLaunched(fixture.parentRunDir, launched, { now: launched.launched_at });
      const child = readJson(join(fixture.repo, ".opencode", "factory", "merged-replay-child", "run.json"));
      const mergedAt = "2026-07-19T12:04:03.000Z";
      const completedHash = hashBytes("completed child");
      await transitionCheckpointProgressMerged(fixture.parentRunDir, {
        ...launched,
        state: "merged",
        completed_child_run_id: launched.root_child_run_id,
        completed_child_run_hash: completedHash,
        checkpoint_source_hash: hashCanonical(child.checkpoint_source),
        configuration_hash: hashCanonical(launched.configuration),
        lineage: [{ run_id: launched.root_child_run_id, run_hash: completedHash, parent_run_id: null, continuation_claim_ref: null, continuation_claim_oid: null }],
        pull_request: {
          pr_url: "https://github.com/acme/repo/pull/7",
          pr_number: 7,
          pr_node_id: "PR_checkpoint_7",
          repository: "acme/repo",
          operation_id: `ffpr-v1-${"a".repeat(64)}`,
          head_ref: launched.root_child_run_id,
          head_sha: fixture.baseCommit,
          base_ref: "main",
          base_sha: fixture.baseCommit,
          draft: false,
          merge_commit: fixture.baseCommit,
        },
        remote_main: { ref: "refs/heads/main", commit: fixture.baseCommit, observed_at: "2026-07-19T12:04:02.000Z" },
        merged_at: mergedAt,
      }, { now: mergedAt });

      let launches = 0;
      const replay = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo,
        runId: "merged-replay-child",
        foregroundLaunchFn: async () => { launches += 1; },
      });
      assert.deepEqual(replay, {
        status: "merged",
        run_id: "merged-replay-child",
        checkpoint_id: "checkpoint-001",
        launched: false,
        replayed: true,
      });
      assert.equal(launches, 0);
    } finally {
      fixture.cleanup();
    }
  });

  it("records and exactly replays root completion through the public lifecycle", async () => {
    const fixture = createFixture("record-root");
    try {
      await launchCheckpoint(fixture, "checkpoint-001", "record-root-child");
      terminalizeCheckpointChild(fixture, "record-root-child", 11);
      const options = completionOptions(fixture, "record-root-child", 11);

      await assert.rejects(recordFactoryCheckpointMerged(fixture.parentRunId, "checkpoint-001", {
        ...options,
        beforeCheckpointMergedTransition: () => { throw new Error("crash before merged parent write"); },
      }), /crash before merged parent write/u);
      assert.equal(readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries[0].state, "launched");
      await assert.rejects(recordFactoryCheckpointMerged(fixture.parentRunId, "checkpoint-001", {
        ...options,
        afterCheckpointMergedTransition: () => { throw new Error("crash after merged parent write"); },
      }), /crash after merged parent write/u);
      assert.equal(readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries[0].state, "merged");
      const replay = await recordFactoryCheckpointMerged(fixture.parentRunId, "checkpoint-001", options);

      assert.equal(replay.updated, false);
      assert.equal(replay.replayed, true);
      assert.equal(readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries[0].state, "merged");
    } finally {
      fixture.cleanup();
    }
  });

  it("routes checkpoint-record-merged through the CLI and exactly replays the command", async () => {
    const fixture = createFixture("record-cli");
    const originalLog = console.log;
    try {
      await launchCheckpoint(fixture, "checkpoint-001", "record-cli-child");
      terminalizeCheckpointChild(fixture, "record-cli-child", 17);
      const outputs = [];
      console.log = (value) => outputs.push(String(value));
      const dependencies = { factoryOptions: completionOptions(fixture, "record-cli-child", 17) };
      await runCliCommand(["factory", "checkpoint-record-merged", fixture.parentRunId, "checkpoint-001", "--json"], dependencies);
      await runCliCommand(["factory", "checkpoint-record-merged", fixture.parentRunId, "checkpoint-001", "--json"], dependencies);
      assert.equal(JSON.parse(outputs[0]).updated, true);
      assert.equal(JSON.parse(outputs[1]).replayed, true);
    } finally {
      console.log = originalLog;
      fixture.cleanup();
    }
  });

  it("records a terminal child-published predecessor before starting the next checkpoint", async () => {
    const fixture = createFixture("predecessor-fallback");
    try {
      await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "predecessor-first", dryRun: true, now: "2026-07-19T12:00:00.000Z",
      });
      terminalizeCheckpointChild(fixture, "predecessor-first", 12);
      const result = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        ...completionOptions(fixture, "predecessor-first", 12),
        runId: "predecessor-second",
        dryRun: true,
      });

      assert.equal(result.status, "dry-run");
      const entries = readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries;
      assert.equal(entries[0].state, "merged");
      assert.equal(entries[1].state, "child-published");
      assert.equal(entries[1].predecessor_completed_run_id, "predecessor-first");
    } finally {
      fixture.cleanup();
    }
  });

  it("reconciles a terminal child-published child before merged recording and retries idempotently", async () => {
    const fixture = createFixture("terminal-child-published");
    try {
      await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "terminal-child-published-child", dryRun: true, now: "2026-07-19T12:00:00.000Z",
      });
      terminalizeCheckpointChild(fixture, "terminal-child-published-child", 21);
      const options = completionOptions(fixture, "terminal-child-published-child", 21);
      await assert.rejects(recordFactoryCheckpointMerged(fixture.parentRunId, "checkpoint-001", {
        ...options,
        beforeCheckpointMergedTransition: () => { throw new Error("interrupt after launched reconciliation"); },
      }), /interrupt after launched reconciliation/u);
      assert.equal(readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries[0].state, "launched");

      const retried = await recordFactoryCheckpointMerged(fixture.parentRunId, "checkpoint-001", options);
      assert.equal(retried.updated, true);
      assert.equal(readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries[0].state, "merged");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects predecessor reservation when canonical main is force-pushed after the fresh fetch", async () => {
    const fixture = createFixture("predecessor-force-push");
    try {
      const mergeCommit = advanceRemoteMain(fixture, "predecessor-merge.txt");
      await launchCheckpoint(fixture, "checkpoint-001", "force-push-first");
      terminalizeCheckpointChild(fixture, "force-push-first", 22);
      const options = completionOptions(fixture, "force-push-first", 22);
      const baseObserve = options.observeCheckpointPrOperation;
      options.observeCheckpointPrOperation = (input) => {
        const observation = baseObserve(input);
        observation.pull_request.merge_commit_sha = mergeCommit;
        return observation;
      };
      delete options.observeCheckpointRemoteMain;
      delete options.isCheckpointAncestor;
      await recordFactoryCheckpointMerged(fixture.parentRunId, "checkpoint-001", options);

      let forced = false;
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        ...options,
        runId: "force-push-second",
        dryRun: true,
        afterCheckpointRemoteFetch: ({ phase }) => {
          if (phase !== "reservation-publication" || forced) return;
          forced = true;
          git(fixture.repo, "push", "--force", "origin", `${fixture.baseCommit}:refs/heads/main`);
        },
      }), (error) => errorChainMatches(error, /canonical remote main changed|not an ancestor|reservation base changed/u));
      assert.equal(forced, true);
      assert.equal(readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries.length, 1);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a reopened predecessor PR at the reservation publication sink", async () => {
    const fixture = createFixture("predecessor-reopened");
    try {
      await launchCheckpoint(fixture, "checkpoint-001", "reopened-first");
      terminalizeCheckpointChild(fixture, "reopened-first", 23);
      await recordFactoryCheckpointMerged(fixture.parentRunId, "checkpoint-001", completionOptions(fixture, "reopened-first", 23));
      const options = completionOptions(fixture, "reopened-first", 23);
      const baseObserve = options.observeCheckpointPrOperation;
      let observations = 0;
      let reopened = false;
      options.observeCheckpointPrOperation = (input) => {
        const result = baseObserve(input);
        observations += 1;
        if (reopened) result.disposition = "open";
        return result;
      };
      options.checkpointProgressHooks = { beforeReplace: () => { reopened = true; } };
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        ...options, runId: "reopened-second", dryRun: true,
      }), (error) => errorChainMatches(error, /freshly checked GitHub merged disposition/u));
      assert.equal(observations, 2);
      assert.equal(readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries.length, 1);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a changed PR operation at the merged parent publication sink", async () => {
    const fixture = createFixture("merge-operation-changed");
    try {
      await launchCheckpoint(fixture, "checkpoint-001", "merge-operation-child");
      terminalizeCheckpointChild(fixture, "merge-operation-child", 24);
      const options = completionOptions(fixture, "merge-operation-child", 24);
      const baseObserve = options.observeCheckpointPrOperation;
      let observations = 0;
      let changed = false;
      options.observeCheckpointPrOperation = (input) => {
        const result = baseObserve(input);
        observations += 1;
        if (changed) result.pull_request.pr_node_id = "PR_changed_at_sink";
        return result;
      };
      options.checkpointProgressHooks = { beforeReplace: () => { changed = true; } };
      await assert.rejects(recordFactoryCheckpointMerged(fixture.parentRunId, "checkpoint-001", options),
        (error) => errorChainMatches(error, /stale or conflicts|changed before parent publication/u));
      assert.equal(observations, 2);
      assert.equal(readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries[0].state, "launched");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects divergent remote main between merged-progress construction and publication", async () => {
    const fixture = createFixture("merge-main-diverged");
    try {
      await launchCheckpoint(fixture, "checkpoint-001", "merge-main-diverged-child");
      terminalizeCheckpointChild(fixture, "merge-main-diverged-child", 27);
      const options = completionOptions(fixture, "merge-main-diverged-child", 27);
      const builtMain = "1".repeat(40);
      const sinkMain = "2".repeat(40);
      let currentMain = builtMain;
      options.observeCheckpointRemoteMain = ({ ref }) => ({ ref, commit: currentMain, observed_at: options.now });
      options.isCheckpointAncestor = ({ ancestor, descendant }) => !(ancestor === builtMain && descendant === sinkMain);
      options.checkpointProgressHooks = { beforeReplace: () => { currentMain = sinkMain; } };
      const parentBefore = readFileSync(join(fixture.parentRunDir, "run.json"));

      await assert.rejects(recordFactoryCheckpointMerged(fixture.parentRunId, "checkpoint-001", options),
        (error) => errorChainMatches(error, /fresh checkpoint remote main diverges/u));
      assert.equal(readFileSync(join(fixture.parentRunDir, "run.json")).equals(parentBefore), true);
      assert.equal(readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.entries[0].state, "launched");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a reopened recorded PR at the final closure publication sink", async () => {
    const fixture = createFixture("closure-reopened");
    try {
      await launchCheckpoint(fixture, "checkpoint-001", "closure-first");
      terminalizeCheckpointChild(fixture, "closure-first", 25);
      await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        ...completionOptions(fixture, "closure-first", 25),
        runId: "closure-second",
        foregroundLaunchFn: async () => ({ status: "launched" }),
      });
      terminalizeCheckpointChild(fixture, "closure-second", 26);
      await recordFactoryCheckpointMerged(fixture.parentRunId, "checkpoint-002", completionOptions(fixture, "closure-second", 26));

      const options = completionOptions(fixture, "closure-second", 26);
      const baseObserve = options.observeCheckpointPrOperation;
      let observations = 0;
      let reopened = false;
      options.observeCheckpointPrOperation = (input) => {
        const result = baseObserve(input);
        observations += 1;
        if (reopened) result.disposition = "open";
        return result;
      };
      options.checkpointProgressHooks = { beforeReplace: () => { reopened = true; } };
      await assert.rejects(closeFactoryCheckpointRoute(fixture.parentRunId, options),
        (error) => errorChainMatches(error, /freshly checked GitHub merged disposition/u));
      assert.equal(observations, 3);
      assert.equal(readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.status, "active");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects divergent remote main between final-closure construction and publication", async () => {
    const fixture = createFixture("closure-main-diverged");
    try {
      await launchCheckpoint(fixture, "checkpoint-001", "closure-main-first");
      terminalizeCheckpointChild(fixture, "closure-main-first", 28);
      await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        ...completionOptions(fixture, "closure-main-first", 28),
        runId: "closure-main-second",
        foregroundLaunchFn: async () => ({ status: "launched" }),
      });
      terminalizeCheckpointChild(fixture, "closure-main-second", 29);
      await recordFactoryCheckpointMerged(fixture.parentRunId, "checkpoint-002", completionOptions(fixture, "closure-main-second", 29));

      const options = completionOptions(fixture, "closure-main-second", 29);
      const builtMain = "3".repeat(40);
      const sinkMain = "4".repeat(40);
      let currentMain = builtMain;
      options.observeCheckpointRemoteMain = ({ ref }) => ({ ref, commit: currentMain, observed_at: options.now });
      options.isCheckpointAncestor = ({ ancestor, descendant }) => !(ancestor === builtMain && descendant === sinkMain);
      options.checkpointProgressHooks = { beforeReplace: () => { currentMain = sinkMain; } };
      const parentBefore = readFileSync(join(fixture.parentRunDir, "run.json"));

      await assert.rejects(closeFactoryCheckpointRoute(fixture.parentRunId, options),
        (error) => errorChainMatches(error, /fresh checkpoint remote main diverges/u));
      assert.equal(readFileSync(join(fixture.parentRunDir, "run.json")).equals(parentBefore), true);
      const progress = readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress;
      assert.equal(progress.status, "active");
      assert.equal(progress.final_closure, null);
    } finally {
      fixture.cleanup();
    }
  });

  it("uses final fallback, closes from parent records, and replays after every child target is removed", async () => {
    const fixture = createFixture("final-fallback");
    try {
      await launchCheckpoint(fixture, "checkpoint-001", "final-first");
      terminalizeCheckpointChild(fixture, "final-first", 13);
      await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        ...completionOptions(fixture, "final-first", 13),
        runId: "final-second",
        dryRun: true,
      });
      terminalizeCheckpointChild(fixture, "final-second", 14);

      await assert.rejects(closeFactoryCheckpointRoute(fixture.parentRunId, {
        ...completionOptions(fixture, "final-second", 14),
        beforeCheckpointFinalClosureCommit: () => { throw new Error("crash before parent write"); },
      }), /crash before parent write/u);
      assert.equal(readJson(join(fixture.parentRunDir, "run.json")).checkpoint_progress.status, "active");

      await assert.rejects(closeFactoryCheckpointRoute(fixture.parentRunId, {
        ...completionOptions(fixture, "final-second", 14),
        afterCheckpointFinalClosureCommit: () => { throw new Error("crash after parent write"); },
      }), /crash after parent write/u);
      const closedParent = readJson(join(fixture.parentRunDir, "run.json"));
      assert.equal(closedParent.checkpoint_progress.status, "closed");
      const closureRef = closedParent.checkpoint_progress.final_closure.ref;
      const closure = readJson(join(fixture.parentRunDir, closureRef));
      assert.equal(Object.hasOwn(closure, "reservation_oid"), false);
      assert.match(closureRef, /^artifacts\/checkpoint-final-closure-[0-9a-f]{64}\.json$/u);

      for (const runId of ["final-first", "final-second"]) removeCheckpointTargets(fixture, runId);
      const replay = await closeFactoryCheckpointRoute(fixture.parentRunId, completionOptions(fixture, "final-second", 14, "2026-07-19T12:20:00.000Z"));
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.closure, closure);
      const cleanup = await cleanupRun(fixture.parentRunId, { cwd: fixture.repo, dryRun: true });
      assert.equal(cleanup.dry_run, true);
    } finally {
      fixture.cleanup();
    }
  });

  it("scopes locked-lineage and recorded-entry PR observations to their persisted accounts", async () => {
    const fixture = createFixture("account-scoped-observers");
    const captures = [];
    try {
      await withAmbientGithubEnvironment(async () => {
        await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
          cwd: fixture.repo,
          runId: "account-scoped-first",
          ghAccount: "acme",
          now: "2026-07-19T12:00:00.000Z",
          foregroundLaunchFn: async () => ({ status: "launched" }),
        });
        terminalizeCheckpointChild(fixture, "account-scoped-first", 31);
        await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
          ...scopedCompletionOptions(fixture, "account-scoped-first", 31, captures),
          runId: "account-scoped-second",
          ghAccount: "acme",
          foregroundLaunchFn: async () => ({ status: "launched" }),
        });
        terminalizeCheckpointChild(fixture, "account-scoped-second", 32);
        await recordFactoryCheckpointMerged(
          fixture.parentRunId,
          "checkpoint-002",
          scopedCompletionOptions(fixture, "account-scoped-second", 32, captures, "2026-07-19T12:20:00.000Z"),
        );

        const lineageCaptureCount = captures.length;
        assert.equal(lineageCaptureCount, 6);
        for (const runId of ["account-scoped-first", "account-scoped-second"]) removeCheckpointTargets(fixture, runId);
        await closeFactoryCheckpointRoute(
          fixture.parentRunId,
          scopedCompletionOptions(fixture, "account-scoped-second", 32, captures, "2026-07-19T12:30:00.000Z"),
        );
        assert.equal(captures.length - lineageCaptureCount, 4);
        assert.equal(process.env.GH_CONFIG_DIR, "/ambient/checkpoint-global-gh");
      });

      for (const capture of captures) {
        assert.equal(capture.args[0], "api");
        assert.equal(capture.gh_config_dir, join(homedir(), ".config", "opencode-feature-factory", "gh", "acme"));
        assert.equal(capture.gh_host, "github.com");
        assert.deepEqual(capture.auth_environment, {
          GH_TOKEN: null,
          GITHUB_TOKEN: null,
          GH_ENTERPRISE_TOKEN: null,
          GITHUB_ENTERPRISE_TOKEN: null,
        });
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("denies missing and invalid recorded-entry accounts before spawning", async () => {
    for (const [label, account] of [["missing", null], ["invalid", "invalid!"]]) {
      const fixture = createFixture(`recorded-account-${label}`);
      let spawns = 0;
      try {
        await launchCheckpoint(fixture, "checkpoint-001", `${label}-first`);
        terminalizeCheckpointChild(fixture, `${label}-first`, 41);
        await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
          ...completionOptions(fixture, `${label}-first`, 41),
          runId: `${label}-second`,
          foregroundLaunchFn: async () => ({ status: "launched" }),
        });
        terminalizeCheckpointChild(fixture, `${label}-second`, 42);
        await recordFactoryCheckpointMerged(fixture.parentRunId, "checkpoint-002", completionOptions(fixture, `${label}-second`, 42));
        for (const runId of [`${label}-first`, `${label}-second`]) removeCheckpointTargets(fixture, runId);

        const parentPath = join(fixture.parentRunDir, "run.json");
        const parent = readJson(parentPath);
        for (const entry of parent.checkpoint_progress.entries) {
          entry.configuration.github_account = account;
          entry.configuration_hash = hashCanonicalValue(entry.configuration);
        }
        writeJson(parentPath, parent);

        const options = completionOptions(fixture, `${label}-second`, 42);
        delete options.observeCheckpointPrOperation;
        options.executeGithub = async () => {
          spawns += 1;
          return { exitCode: 0, signal: null, stdout: "unexpected spawn" };
        };
        await assert.rejects(
          closeFactoryCheckpointRoute(fixture.parentRunId, options),
          /freshly checked GitHub merged disposition/u,
        );
        assert.equal(spawns, 0);
        const progress = readJson(parentPath).checkpoint_progress;
        assert.equal(progress.status, "active");
        assert.equal(progress.final_closure, null);
      } finally {
        fixture.cleanup();
      }
    }
  });

  it("gates ordinary cleanup on the exact durable merged lineage identity", async () => {
    const fixture = createFixture("cleanup-authority");
    try {
      await launchCheckpoint(fixture, "checkpoint-001", "cleanup-child");
      terminalizeCheckpointChild(fixture, "cleanup-child", 15);
      await assert.rejects(cleanupRun("cleanup-child", { cwd: fixture.repo, dryRun: true }), /parent durable merged entry/u);

      await recordFactoryCheckpointMerged(fixture.parentRunId, "checkpoint-001", completionOptions(fixture, "cleanup-child", 15));
      const cleanup = await cleanupRun("cleanup-child", { cwd: fixture.repo, dryRun: true });
      assert.equal(cleanup.dry_run, true);
      assert.equal(cleanup.run_id, "cleanup-child");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects cleanup of a routing parent until checkpoint progress is closed", async () => {
    const fixture = createFixture("active-parent-cleanup");
    try {
      await assert.rejects(cleanupRun(fixture.parentRunId, { cwd: fixture.repo, dryRun: true }), /requires closed checkpoint progress/u);
      assert.equal(existsSync(fixture.parentRunDir), true);
    } finally {
      fixture.cleanup();
    }
  });

  it("returns an explicit recovery command when durable child terminalization cannot update its parent", async () => {
    const fixture = createFixture("callback-recovery");
    try {
      await launchCheckpoint(fixture, "checkpoint-001", "callback-child");
      terminalizeCheckpointChild(fixture, "callback-child", 16);
      rmSync(join(fixture.parentRunDir, "run.json"));
      const terminal = readJson(join(fixture.repo, ".opencode", "factory", "callback-child", "run.json"));

      const result = await attachCheckpointCompletionRecovery({ status: "completed" }, terminal, { cwd: fixture.repo });
      assert.equal(result.status, "completed");
      assert.equal(result.checkpoint_completion.status, "recovery-required");
      assert.equal(result.checkpoint_completion.recovery_command,
        `feature-factory factory checkpoint-record-merged ${fixture.parentRunId} checkpoint-001 --json`);
      assert.equal(terminal.status, "completed");
    } finally {
      fixture.cleanup();
    }
  });
});

async function launchCheckpoint(fixture, checkpointId, runId) {
  return startFactoryCheckpoint(fixture.parentRunId, checkpointId, {
    cwd: fixture.repo,
    runId,
    now: "2026-07-19T12:00:00.000Z",
    foregroundLaunchFn: async () => ({ status: "launched", run_id: runId }),
  });
}

function terminalizeCheckpointChild(fixture, runId, prNumber) {
  const path = join(fixture.repo, ".opencode", "factory", runId, "run.json");
  const run = readJson(path);
  const prUrl = `https://github.com/acme/repo/pull/${prNumber}`;
  writeJson(path, {
    ...run,
    status: "completed",
    updated_at: "2026-07-19T12:05:00.000Z",
    pr_url: prUrl,
    terminal_result: {
      status: "completed",
      run_id: runId,
      reason: null,
      summary: "PR created.",
      artifacts: {},
      pr_url: prUrl,
      pr_number: prNumber,
      pr_node_id: `PR_checkpoint_${prNumber}`,
      repository: "acme/repo",
      operation_id: `ffpr-v1-${String(prNumber).padStart(64, "0")}`,
      head_ref: runId,
      head_sha: fixture.baseCommit,
      base_ref: "main",
      base_sha: fixture.baseCommit,
      draft: false,
    },
  });
}

function completionOptions(fixture, runId, prNumber, observedAt = "2026-07-19T12:10:00.000Z") {
  const prUrl = `https://github.com/acme/repo/pull/${prNumber}`;
  return {
    cwd: fixture.repo,
    now: observedAt,
    observeCheckpointPrOperation: (input) => ({
      disposition: "merged",
      pull_request: {
        pr_url: input.pr_url ?? prUrl,
        pr_number: input.pr_number ?? prNumber,
        pr_node_id: input.pr_node_id ?? `PR_checkpoint_${prNumber}`,
        repository: input.repository,
        head_ref: input.head_ref,
        head_sha: input.head_sha,
        base_ref: input.base_ref,
        base_sha: input.base_sha,
        draft: input.draft,
        merge_commit_sha: fixture.baseCommit,
        merged_at: "2026-07-19T12:06:00.000Z",
      },
    }),
    observeCheckpointRemoteMain: ({ ref }) => ({ ref, commit: fixture.baseCommit, observed_at: observedAt }),
    isCheckpointAncestor: () => true,
  };
}

function scopedCompletionOptions(fixture, runId, prNumber, captures, observedAt = "2026-07-19T12:10:00.000Z") {
  const options = completionOptions(fixture, runId, prNumber, observedAt);
  delete options.observeCheckpointPrOperation;
  options.executeGithub = checkpointGithubExecutor(fixture, captures);
  return options;
}

function checkpointGithubExecutor(fixture, captures) {
  return async (input) => {
    captures.push({
      args: [...input.args],
      gh_config_dir: input.env?.GH_CONFIG_DIR ?? null,
      gh_host: input.env?.GH_HOST ?? null,
      auth_environment: Object.fromEntries(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
        .map((key) => [key, input.env?.[key] ?? null])),
    });
    const endpoint = new URL(input.args[4], "https://api.github.com/");
    const qualifiedHead = endpoint.searchParams.get("head");
    const headRef = qualifiedHead.slice(qualifiedHead.indexOf(":") + 1);
    const tuple = checkpointPullRequestTuple(fixture, headRef);
    const body = [{
      html_url: tuple.pr_url,
      number: tuple.pr_number,
      node_id: tuple.pr_node_id,
      draft: tuple.draft,
      body: `<!-- opencode-feature-factory:pr-operation=${tuple.operation_id} -->`,
      state: "closed",
      merged_at: tuple.merged_at ?? (tuple.pr_number === 32 ? "2026-07-19T12:16:00.000Z" : "2026-07-19T12:06:00.000Z"),
      merge_commit_sha: tuple.merge_commit ?? fixture.baseCommit,
      head: { ref: tuple.head_ref, sha: tuple.head_sha, repo: { full_name: tuple.repository } },
      base: { ref: tuple.base_ref, sha: tuple.base_sha, repo: { full_name: tuple.repository } },
    }];
    return {
      exitCode: 0,
      signal: null,
      stdout: `HTTP/2 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}`,
    };
  };
}

function checkpointPullRequestTuple(fixture, headRef) {
  const parent = readJson(join(fixture.parentRunDir, "run.json"));
  const recorded = parent.checkpoint_progress.entries.find((entry) => entry.pull_request?.head_ref === headRef)?.pull_request;
  if (recorded) return recorded;
  const run = readJson(join(fixture.repo, ".opencode", "factory", headRef, "run.json"));
  return run.terminal_result;
}

async function withAmbientGithubEnvironment(fn) {
  const values = {
    GH_CONFIG_DIR: "/ambient/checkpoint-global-gh",
    GH_TOKEN: "ambient-gh-token",
    GITHUB_TOKEN: "ambient-github-token",
    GH_ENTERPRISE_TOKEN: "ambient-gh-enterprise-token",
    GITHUB_ENTERPRISE_TOKEN: "ambient-github-enterprise-token",
  };
  const prior = Object.fromEntries(Object.keys(values).map((key) => [key, Object.hasOwn(process.env, key) ? process.env[key] : undefined]));
  try {
    Object.assign(process.env, values);
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function removeCheckpointTargets(fixture, runId) {
  const runDir = join(fixture.repo, ".opencode", "factory", runId);
  if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
  const worktree = join(fixture.repo, ".opencode", "worktrees", runId);
  if (existsSync(worktree)) git(fixture.repo, "worktree", "remove", "--force", worktree);
  try { git(fixture.repo, "branch", "-D", runId); } catch { /* already absent */ }
}

function createFixture(name, { reviewTier = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), `checkpoint-start-${name}-`));
  const repo = join(root, "repo");
  const remote = join(root, "origin.git");
  mkdirSync(repo);
  git(root, "init", "--bare", "-b", "main", remote);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "fixture");
  const baseCommit = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "config", "url.file://" + remote + "/.insteadOf", "https://github.com/acme/repo.git");
  git(repo, "remote", "add", "origin", "https://github.com/acme/repo.git");
  git(repo, "push", "-u", "origin", "main");

  const routing = routingFixture();
  const parentRunId = `parent-${name}`;
  const parentRunDir = join(repo, ".opencode", "factory", parentRunId);
  for (const directory of ["artifacts", "plan", "reviews"]) mkdirSync(join(parentRunDir, directory), { recursive: true });
  writeJson(join(parentRunDir, "plan", "slices.json"), routing.plan);
  writeJson(join(parentRunDir, "reviews", "work-decomposer.json"), routing.review);
  const manifest = buildCheckpointRoutingManifest({
    plan: routing.plan,
    planHash: routing.planHash,
    admissionResult: routing.admissionResult,
    decompositionAuthority: routing.decompositionAuthority,
  });
  const artifact = checkpointRoutingArtifact(manifest);
  writeFileSync(join(parentRunDir, artifact.ref), artifact.bytes);
  writeJson(join(parentRunDir, "run.json"), {
    schema_version: 1,
    run_id: parentRunId,
    status: "blocked",
    base_ref: "refs/heads/main",
    base_commit: baseCommit,
    branch: "main",
    worktree: repo,
    pr_url: null,
    ...(reviewTier === null ? {} : { review_tier: reviewTier }),
    gates: {},
    slices: [],
    steps: [{
      agent: "work-decomposer",
      status: "accepted",
      attempts: 1,
      artifact_ref: "plan/slices.json",
      review_ref: "reviews/work-decomposer.json",
      acceptance: {
        artifact_ref: "plan/slices.json",
        artifact_hash: routing.planHash,
        review_ref: "reviews/work-decomposer.json",
        review_hash: routing.reviewHash,
      },
    }, { agent: "test-verifier", status: "blocked", attempts: 0 }],
    checkpoint_progress: {
      schema_version: 1,
      kind: "delivery-checkpoint-progress",
      manifest_ref: artifact.ref,
      manifest_hash: artifact.hash,
      status: "active",
      entries: [],
      final_closure: null,
    },
    terminal_result: {
      status: "blocked",
      run_id: parentRunId,
      pr_url: null,
      reason: "oversized-plan-checkpoint-routing-required",
      summary: "Oversized plan routed to sequential checkpoints.",
      artifacts: { checkpoint_routing: artifact.ref },
    },
  });
  return {
    root,
    repo,
    remote,
    parentRunId,
    parentRunDir,
    baseCommit,
    manifest,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function routingFixture() {
  const plan = parentPlan();
  plan.delivery_envelope.checkpoint_plan = checkpointPlan(plan);
  const planHash = hashBytes(`${JSON.stringify(plan, null, 2)}\n`);
  const admissionResult = evaluateDeliveryEnvelopeAdmission({ plan });
  const identityFields = {
    schema_version: 1,
    subject: "work-decomposer",
    attempt: 1,
    plan_ref: "plan/slices.json",
    plan_hash: planHash,
    review_ref: "reviews/work-decomposer.json",
  };
  const reviewIdentity = { ...identityFields, identity_hash: hashCanonical(identityFields) };
  const summaries = plan.delivery_envelope.checkpoint_plan.checkpoints.map((checkpoint) => {
    const projection = acceptanceProjection(plan.delivery_envelope.checkpoint_plan, checkpoint);
    return {
      checkpoint_id: checkpoint.id,
      ordinal: checkpoint.ordinal,
      brief_scope_hash: hashCanonical(checkpoint.brief_scope),
      child_plan_hash: hashCanonical(checkpoint.child_plan),
      acceptance_mapping_hash: hashCanonical(projection),
    };
  });
  const review = {
    schema_version: 1,
    subject: "work-decomposer",
    attempt: 1,
    verdict: "APPROVE-CHECKPOINT",
    required_fixes: [],
    admission_probe: {
      schema_version: 1,
      kind: "delivery-plan-admission-probe",
      status: "valid",
      decision: "checkpoint",
      plan_ref: "plan/slices.json",
      plan_hash: planHash,
      reasons: [...admissionResult.reasons],
      checkpoint_plan_hash: hashCanonical(plan.delivery_envelope.checkpoint_plan),
      checkpoints: summaries,
    },
    review_identity: reviewIdentity,
    checkpoint_dispositions: summaries.map((summary) => ({
      schema_version: 1,
      kind: "checkpoint-child-decomposition-review",
      subject: "work-decomposer",
      attempt: 1,
      verdict: "APPROVE",
      required_fixes: [],
      checkpoint_id: summary.checkpoint_id,
      checkpoint_ordinal: summary.ordinal,
      reviewed_plan_ref: "plan/slices.json",
      reviewed_plan_hash: summary.child_plan_hash,
      child_plan_hash: summary.child_plan_hash,
      brief_scope_hash: summary.brief_scope_hash,
      acceptance_mapping_hash: summary.acceptance_mapping_hash,
      parent_review_identity: structuredClone(reviewIdentity),
    })),
  };
  const reviewHash = hashBytes(`${JSON.stringify(review, null, 2)}\n`);
  return {
    plan,
    planHash,
    admissionResult,
    review,
    reviewHash,
    decompositionAuthority: {
      plan_ref: "plan/slices.json",
      plan_hash: planHash,
      review_ref: "reviews/work-decomposer.json",
      review_hash: reviewHash,
      attempt: 1,
      review,
    },
  };
}

function parentPlan() {
  const testPlan = Array.from({ length: 6 }, (_, index) => `test api ${index + 1}`);
  return {
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: [{ id: "api", stack: "backend", paths: ["src/api.js"], depends_on: [], acceptance: ["AC1", "AC2"], test_plan: testPlan }],
    delivery_envelope: {
      schema_version: 1,
      delivery_units: [{
        id: "api-unit",
        slice_id: "api",
        invariant_families: [{ id: "api-family-1", description: "API family 1" }, { id: "api-family-2", description: "API family 2" }],
        obligations: testPlan.map((entry, index) => ({
          id: `api-obligation-${index + 1}`,
          description: `API obligation ${index + 1}`,
          invariant_family_id: `api-family-${(index % 2) + 1}`,
          verification_artifact_id: `api-artifact-${index + 1}`,
        })),
        verification_artifacts: testPlan.map((entry, index) => ({ id: `api-artifact-${index + 1}`, test_plan_index: index, test_plan_entry: entry })),
      }],
    },
  };
}

function checkpointPlan(plan) {
  const slice = plan.slices[0];
  const unit = plan.delivery_envelope.delivery_units[0];
  const inventory = slice.acceptance.map((text, index) => ({ id: `acceptance-${String(index + 1).padStart(6, "0")}`, source_slice_id: slice.id, source_index: index, text }));
  const checkpoints = unit.invariant_families.map((family, index) => {
    const id = `checkpoint-${String(index + 1).padStart(3, "0")}`;
    const obligations = unit.obligations.filter((obligation) => obligation.invariant_family_id === family.id);
    const artifactIds = new Set(obligations.map((obligation) => obligation.verification_artifact_id));
    const artifacts = unit.verification_artifacts.filter((artifact) => artifactIds.has(artifact.id));
    const acceptance = [inventory[index].text];
    return {
      id,
      ordinal: index + 1,
      prerequisite_checkpoint_id: index === 0 ? null : `checkpoint-${String(index).padStart(3, "0")}`,
      acceptance_ids: [inventory[index].id],
      brief_scope: {
        title: `Deliver API family ${index + 1}`,
        source_delivery_unit_id: unit.id,
        source_slice_id: slice.id,
        source_slice_dependencies: [],
        stack: slice.stack,
        paths: [...slice.paths],
        acceptance,
        invariant_family: structuredClone(family),
        obligations: structuredClone(obligations),
        verification_artifacts: structuredClone(artifacts),
      },
      child_plan: {
        integration_gate: structuredClone(plan.integration_gate),
        slices: [{ id: slice.id, stack: slice.stack, paths: [...slice.paths], depends_on: [], acceptance, test_plan: artifacts.map((artifact) => artifact.test_plan_entry) }],
        delivery_envelope: {
          schema_version: 1,
          delivery_units: [{
            id: unit.id,
            slice_id: slice.id,
            invariant_families: [structuredClone(family)],
            obligations: structuredClone(obligations),
            verification_artifacts: artifacts.map((artifact, artifactIndex) => ({ ...structuredClone(artifact), test_plan_index: artifactIndex })),
          }],
        },
      },
    };
  });
  const mappings = inventory.map((row, index) => {
    const checkpoint = checkpoints[index];
    const family = checkpoint.brief_scope.invariant_family;
    const obligations = checkpoint.brief_scope.obligations;
    const artifacts = checkpoint.brief_scope.verification_artifacts;
    return {
      acceptance_id: row.id,
      policy: "single-owner",
      checkpoint_ids: [checkpoint.id],
      assignments: [{
        checkpoint_id: checkpoint.id,
        invariant_family_id: family.id,
        obligation_ids: obligations.map((obligation) => obligation.id),
        verification_artifact_ids: artifacts.map((artifact) => artifact.id),
        test_plan_entries: artifacts.map((artifact) => artifact.test_plan_entry),
      }],
    };
  });
  return { schema_version: 1, kind: "delivery-checkpoint-plan", acceptance_inventory: inventory, acceptance_mappings: mappings, checkpoints };
}

function acceptanceProjection(plan, checkpoint) {
  const inventory = new Map(plan.acceptance_inventory.map((row) => [row.id, row]));
  const mappings = new Map(plan.acceptance_mappings.map((row) => [row.acceptance_id, row]));
  return {
    acceptance_ids: structuredClone(checkpoint.acceptance_ids),
    acceptance_inventory: checkpoint.acceptance_ids.map((id) => structuredClone(inventory.get(id))),
    acceptance_mappings: checkpoint.acceptance_ids.map((id) => structuredClone(mappings.get(id))),
  };
}

function advanceRemoteMain(fixture, filename) {
  const clone = join(fixture.root, `clone-${filename}`);
  git(fixture.root, "clone", fixture.remote, clone);
  git(clone, "config", "user.email", "remote@example.com");
  git(clone, "config", "user.name", "Remote");
  writeFileSync(join(clone, filename), "advance\n");
  git(clone, "add", filename);
  git(clone, "commit", "-m", `advance ${filename}`);
  git(clone, "push", "origin", "main");
  return git(clone, "rev-parse", "HEAD").trim();
}

function refExists(repo, ref) {
  try { git(repo, "rev-parse", "--verify", ref); return true; } catch { return false; }
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function errorChainMatches(error, pattern) {
  for (let current = error; current; current = current.cause) {
    if (pattern.test(String(current.message))) return true;
  }
  return false;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function hashCanonical(value) {
  return hashBytes(canonicalBytes(value));
}

function hashBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function continuationParentIdentity(continuation) {
  return {
    schema_version: 2,
    kind: "blocked-run-continuation-parent",
    parent_run_id: continuation.parent.run_id,
    parent_run_ref: continuation.parent.run_ref,
    parent_run_hash: continuation.parent.run_hash,
    parent_branch_ref: `refs/heads/${continuation.parent.branch}`,
    target_base_ref: continuation.target.base_ref,
    target_base_commit: continuation.target.base_commit,
    plan_ref: continuation.carry_forward.plan_ref,
    plan_hash: continuation.carry_forward.plan_hash,
    start_commit: continuation.carry_forward.start_commit,
  };
}

function hashCanonicalValue(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
