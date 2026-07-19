import assert from "node:assert/strict";
import { execFileSync } from "./helpers/git-fixture.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCliCommand } from "../src/cli.js";
import { buildCheckpointRoutingManifest, checkpointRoutingArtifact } from "../src/delivery-envelope/checkpoint-routing.js";
import { evaluateDeliveryEnvelopeAdmission } from "../src/delivery-envelope/admission-extension.js";
import { buildContinuation, closeFactoryCheckpointRoute, continueFactory, recoverDisruptedRun, resumeFactory, startFactoryCheckpoint } from "../src/factory.js";
import { decodeFeatureCommandPayload, encodeFeatureCommandPayload } from "../src/feature-command-payload.js";
import { hashValue } from "../src/refs.js";
import { transitionRunStep } from "../src/run-state.js";
import { createSliceAttemptReview, createSliceReviewRecord } from "./helpers/review-record-fixture.js";
import { validateRun } from "../src/validate.js";
import { passingInvariantFamilyLedger, writeVerificationArtifactReceipt } from "./helpers/delivery-envelope-fixture.js";

describe("checked checkpoint child start", () => {
  it("binds ordinal 1 to exact reviewed parent, manifest, request, and current main with no-replace reservations", async () => {
    const fixture = createFixture("checkpoint-parent-one");
    try {
      const launched = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo,
        runId: "checkpoint-child-one",
        checkpointLaunchFn: (value) => value,
      });
      assert.equal(launched.binding.parent_run_id, fixture.parentRunId);
      assert.equal(launched.binding.manifest_ref, fixture.artifact.ref);
      assert.equal(launched.binding.manifest_hash, fixture.artifact.hash);
      assert.equal(launched.binding.checkpoint_id, "checkpoint-001");
      assert.equal(launched.binding.checkpoint_ordinal, 1);
      assert.equal(launched.binding.child_run_id, "checkpoint-child-one");
      assert.equal(launched.binding.base_ref, "refs/heads/main");
      assert.equal(launched.binding.base_commit, fixture.baseCommit);
      assert.equal(launched.binding.predecessor_checkpoint_id, null);
      assert.deepEqual(launched.payload.checkpoint, launched.binding);
      assert.deepEqual(launched.payload.checkpoint_request, fixture.manifest.checkpoints[0].request);
      assert.equal(launched.payload.checkpoint_reservation.state, "launching");
      assert.equal(checkpointReservationClaim(fixture, launched.binding).state, "launched");
      assert.match(launched.commandArgs.at(-1), /^ffpayload-v1:/u);
      const decoded = decodeFeatureCommandPayload(launched.commandArgs.at(-1), { repo: fixture.repo });
      assert.equal(decoded.ok, true, JSON.stringify(decoded));
      assert.deepEqual(decoded.payload.checkpoint, launched.binding);
      assert.equal(decoded.payload.checkpoint_reservation.worktree, launched.payload.checkpoint_reservation.worktree);
      const incompleteReservation = structuredClone(launched.payload);
      delete incompleteReservation.checkpoint_reservation.worktree;
      assert.deepEqual(decodeFeatureCommandPayload(encodeFeatureCommandPayload(incompleteReservation), { repo: fixture.repo }), {
        ok: false,
        reason: "invalid-checkpoint-authority",
      });

      const routeRef = `refs/opencode/checkpoint-routes/${createHash("sha256").update(`${fixture.parentRunId}\0checkpoint-001`, "utf8").digest("hex")}`;
      git(fixture.repo, ["update-ref", "-d", routeRef]);
      assert.deepEqual(decodeFeatureCommandPayload(launched.commandArgs.at(-1), { repo: fixture.repo }), {
        ok: false,
        reason: "invalid-checkpoint-authority",
      });

      await assert.rejects(
        startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
          cwd: fixture.repo, runId: "checkpoint-child-one", checkpointLaunchFn: (value) => value,
        }),
        /already reserved|already has a child run/u,
      );
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("starts the reviewed first checkpoint through the public factory command at the fetched remote base", async () => {
    const fixture = createFixture("checkpoint-parent-cli-authority-chain");
    const output = [];
    const originalLog = console.log;
    let launches = 0;
    try {
      const remoteMain = advanceRemoteMain(fixture, "cli-authority-chain-base.txt");
      console.log = (...values) => output.push(values.join(" "));
      await runCliCommand([
        "factory", "checkpoint-start", fixture.parentRunId, "checkpoint-001",
        "--run-id", "checkpoint-cli-authority-child", "--json",
      ], {
        factoryOptions: {
          cwd: fixture.repo,
          checkpointLaunchFn: ({ binding, reservation, child_worktree }) => {
            launches += 1;
            assert.equal(binding.base_commit, remoteMain);
            assert.equal(git(child_worktree, ["rev-parse", "HEAD"]), remoteMain);
            assert.equal(reservation.claim.state, "launching");
            return { binding, reservation, child_worktree };
          },
        },
      });

      const result = JSON.parse(output.at(-1));
      const run = JSON.parse(readFileSync(join(fixture.repo, ".opencode", "factory", "checkpoint-cli-authority-child", "run.json"), "utf8"));
      assert.equal(launches, 1);
      assert.equal(result.binding.base_commit, remoteMain);
      assert.equal(result.binding.child_run_id, "checkpoint-cli-authority-child");
      assert.equal(run.checkpoint.child_run_id, "checkpoint-cli-authority-child");
      assert.equal(run.base_commit, remoteMain);
      assert.equal(checkpointReservationClaim(fixture, run.checkpoint).state, "launched");
    } finally {
      console.log = originalLog;
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects a shape-valid forged initial checkpoint reservation payload", async () => {
    const fixture = createFixture("checkpoint-parent-payload-authority");
    try {
      const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-payload-authority-child", checkpointLaunchFn: (value) => value,
      });
      const runPath = join(fixture.repo, ".opencode", "factory", started.binding.child_run_id, "run.json");
      const claimBefore = checkpointReservationClaim(fixture, started.binding);
      const forged = structuredClone(started.payload);
      forged.checkpoint_reservation.worktree = join(fixture.repo, ".opencode", "worktrees", "other-registered-worktree");

      assert.deepEqual(decodeFeatureCommandPayload(encodeFeatureCommandPayload(forged), { repo: fixture.repo }), {
        ok: false,
        reason: "invalid-checkpoint-authority",
      });
      assert.deepEqual(checkpointReservationClaim(fixture, started.binding), claimBefore);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects a launched checkpoint reservation that no longer has its verified child manifest", async () => {
    const fixture = createFixture("checkpoint-parent-missing-launched-child");
    try {
      const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-missing-launched-child", checkpointLaunchFn: (value) => value,
      });
      const runPath = join(fixture.repo, ".opencode", "factory", started.binding.child_run_id, "run.json");
      rmSync(runPath, { force: true });
      assert.deepEqual(decodeFeatureCommandPayload(started.commandArgs.at(-1), { repo: fixture.repo }), {
        ok: false,
        reason: "invalid-checkpoint-authority",
      });
      assert.equal(checkpointReservationClaim(fixture, started.binding).state, "launched");
      assert.equal(existsSync(runPath), false);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("normalizes a normal Step 0 parent base_ref of main to canonical remote refs/heads/main", async () => {
    const fixture = createFixture("checkpoint-parent-short-main");
    try {
      const path = join(fixture.parentRunDir, "run.json");
      const parent = JSON.parse(readFileSync(path, "utf8"));
      parent.base_ref = "main";
      writeJson(path, parent);
      const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-short-main-child", checkpointLaunchFn: (value) => value,
      });
      assert.equal(started.binding.base_ref, "refs/heads/main");
      assert.equal(started.binding.base_commit, fixture.baseCommit);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("prepares the checkpoint child branch and worktree at freshly fetched remote main despite stale local main", async () => {
    const fixture = createFixture("checkpoint-parent-prepared-child");
    try {
      const localMain = git(fixture.repo, ["rev-parse", "refs/heads/main"]);
      const remoteMain = advanceRemoteMain(fixture, "prepared-child-base.txt");
      assert.notEqual(remoteMain, localMain);
      const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo,
        runId: "checkpoint-prepared-child",
        checkpointLaunchFn: (value) => {
          assert.equal(git(fixture.repo, ["rev-parse", "refs/heads/checkpoint-prepared-child"]), remoteMain);
          const worktree = join(fixture.repo, ".opencode", "worktrees", "checkpoint-prepared-child");
          assert.equal(git(worktree, ["rev-parse", "HEAD"]), remoteMain);
          const bootstrap = JSON.parse(readFileSync(join(fixture.repo, ".opencode", "factory", "checkpoint-prepared-child", "run.json"), "utf8"));
          assert.equal(bootstrap.checkpoint.child_run_id, "checkpoint-prepared-child");
          assert.equal(bootstrap.base_commit, remoteMain);
          assert.equal(bootstrap.branch, "checkpoint-prepared-child");
          assert.equal(bootstrap.worktree, value.reservation.claim.worktree);
          return value;
        },
      });
      assert.equal(started.binding.base_commit, remoteMain);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("atomically blocks branch drift after remote observation and launches nothing", async () => {
    const fixture = createFixture("checkpoint-parent-prelaunch-branch-race");
    let launches = 0;
    try {
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo,
        runId: "checkpoint-prelaunch-branch-race",
        beforeCheckpointLaunchCas: () => {
          const base = git(fixture.repo, ["rev-parse", "refs/heads/checkpoint-prelaunch-branch-race"]);
          const tree = git(fixture.repo, ["rev-parse", `${base}^{tree}`]);
          const raced = git(fixture.repo, ["commit-tree", tree, "-p", base, "-m", "branch race"]);
          git(fixture.repo, ["update-ref", "refs/heads/checkpoint-prelaunch-branch-race", raced, base]);
        },
        checkpointLaunchFn: (value) => { launches += 1; return value; },
      }), /prelaunch branch|transaction|concurrently|worktree.*HEAD|branch/u);
      assert.equal(launches, 0);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("blocks registered-worktree dirt after remote observation and launches nothing", async () => {
    const fixture = createFixture("checkpoint-parent-prelaunch-worktree-race");
    let launches = 0;
    try {
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo,
        runId: "checkpoint-prelaunch-worktree-race",
        beforeCheckpointLaunchCas: ({ candidate }) => writeFileSync(join(candidate.child_worktree, "raced.txt"), "race\n"),
        checkpointLaunchFn: (value) => { launches += 1; return value; },
      }), /worktree must be clean/u);
      assert.equal(launches, 0);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("excludes checkpoint-routing parents from every ordinary continuation mode before target side effects", () => {
    for (const route of [{}, { carryForward: true }, { newPr: true }]) {
      const fixture = createFixture(`checkpoint-parent-no-continuation-${Object.keys(route)[0] || "v1"}`);
      const child = `forbidden-${Object.keys(route)[0] || "v1"}`;
      try {
        assert.throws(() => continueFactory(fixture.parentRunId, { cwd: fixture.repo, runId: child, review: "reviews/work-decomposer.json", ...route }), /excluded from every ordinary continuation route/u);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", child)), false);
        assert.equal(gitResult(fixture.repo, ["show-ref", "--verify", "--quiet", `refs/heads/${child}`]).ok, false);
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    }
  });

  it("excludes checkpoint children from every continuation construction path before side effects", async () => {
    const fixture = createFixture("checkpoint-child-no-continuation");
    let launches = 0;
    try {
      const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-child-no-continuation-parent", checkpointLaunchFn: (value) => value,
      });
      const variants = [
        ["direct-build", () => buildContinuation(started.binding.child_run_id, { cwd: fixture.repo, runId: "forbidden-direct-build", review: "reviews/work-decomposer.json" })],
        ["dry-schema1", () => continueFactory(started.binding.child_run_id, { cwd: fixture.repo, runId: "forbidden-dry-schema1", review: "reviews/work-decomposer.json", dryRun: true, postPrWaitMinutes: 1 })],
        ["schema1", () => continueFactory(started.binding.child_run_id, { cwd: fixture.repo, runId: "forbidden-schema1", review: "reviews/work-decomposer.json", foregroundLaunchFn: () => { launches += 1; } })],
        ["carry-forward", () => continueFactory(started.binding.child_run_id, { cwd: fixture.repo, runId: "forbidden-carry-forward", review: "reviews/work-decomposer.json", carryForward: true, dryRun: true, ghAccountOccurrences: 2 })],
        ["allocation-replay", () => continueFactory(started.binding.child_run_id, { cwd: fixture.repo, runId: "forbidden-allocation-replay", review: "reviews/work-decomposer.json", carryForward: true, foregroundLaunchFn: () => { launches += 1; } })],
        ["new-pr", () => continueFactory(started.binding.child_run_id, { cwd: fixture.repo, runId: "forbidden-new-pr", review: "reviews/work-decomposer.json", newPr: true, foregroundLaunchFn: () => { launches += 1; } })],
      ];
      for (const [label, invoke] of variants) {
        const target = `forbidden-${label}`;
        assert.throws(invoke, /checkpoint child runs are excluded from every ordinary continuation route/u, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", target)), false, label);
        assert.equal(existsSync(join(fixture.repo, ".opencode", "worktrees", target)), false, label);
        assert.equal(gitResult(fixture.repo, ["show-ref", "--verify", "--quiet", `refs/heads/${target}`]).ok, false, label);
        const targetRef = `refs/opencode/continuation-targets/${createHash("sha256").update(target, "utf8").digest("hex")}`;
        assert.equal(gitResult(fixture.repo, ["show-ref", "--verify", "--quiet", targetRef]).ok, false, label);
      }
      assert.equal(launches, 0);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("accepts checkpoint test-verifier only from the complete exact passing checked execution tuple", async () => {
    for (const variant of ["absent", "fail", "stale", "wrong-command", "pass"]) {
      const fixture = createFixture(`checkpoint-test-acceptance-${variant}`);
      try {
        const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
          cwd: fixture.repo, runId: `checkpoint-test-acceptance-${variant}-child`, checkpointLaunchFn: (value) => value,
        });
        publishCompletedChild(fixture, started.binding, started.binding.base_commit);
        const runDir = join(fixture.repo, ".opencode", "factory", started.binding.child_run_id);
        const runPath = join(runDir, "run.json");
        const run = JSON.parse(readFileSync(runPath, "utf8"));
        run.status = "running";
        run.pr_url = null;
        run.terminal_result = null;
        const step = run.steps.find((candidate) => candidate.agent === "test-verifier");
        step.status = "running";
        delete step.acceptance;
        if (variant === "absent") {
          delete step.execution_claim;
          delete step.execution_claim_hash;
        } else if (variant === "fail") {
          step.status = "rejected";
          step.execution_claim.status = "fail";
          step.execution_claim_hash = hashValue(step.execution_claim);
        } else if (variant === "stale") {
          const receiptPath = join(runDir, step.evidence_ref);
          const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
          receipt.completed_at = "2026-07-19T10:00:02.000Z";
          writeJson(receiptPath, receipt);
        } else if (variant === "wrong-command") {
          const receiptPath = join(runDir, step.evidence_ref);
          const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
          receipt.commands[0].program = "pnpm";
          writeJson(receiptPath, receipt);
          step.execution_claim.receipt_hash = hashFile(receiptPath);
          step.execution_claim_hash = hashValue(step.execution_claim);
        }
        writeJson(runPath, run);
        const transition = () => transitionRunStep(runDir, "test-verifier", (current) => ({ ...current, status: "accepted" }), { repoRoot: fixture.repo });
        if (variant === "pass") {
          const accepted = await transition();
          assert.equal(accepted.step.status, "accepted");
          assert.equal(accepted.step.acceptance.evidence_ref, "evidence/test-verifier.attempt-1.json");
          assert.equal(accepted.step.acceptance.reviewed_head_sha, started.binding.base_commit);
          assert.equal(accepted.step.execution_claim.status, "pass");
        } else {
          await assert.rejects(transition, /completed checked execution|running at the same positive attempt|receipt hash is stale|commands differ|exactly pass/u, variant);
        }
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    }
  });

  it("rejects checkpoint runs whose top-level base differs from run.checkpoint", () => {
    const fixture = createFixture("checkpoint-parent-mismatched-top-base");
    try {
      const binding = checkpointBinding(fixture, "checkpoint-mismatched-top-base-child");
      assert.throws(() => validateRun({
        schema_version: 1,
        run_id: binding.child_run_id,
        status: "running",
        base_ref: "main",
        base_commit: "f".repeat(40),
        branch: binding.child_run_id,
        worktree: join(fixture.repo, ".opencode", "worktrees", binding.child_run_id),
        checkpoint: binding,
        gates: {},
        slices: [],
        steps: [],
      }), /base_ref.*checkpoint|base_commit.*checkpoint/u);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects alternate checkpoint branch and worktree identities", () => {
    const fixture = createFixture("checkpoint-parent-alternate-identity");
    try {
      const binding = checkpointBinding(fixture, "checkpoint-alternate-identity-child");
      const base = {
        schema_version: 1, run_id: binding.child_run_id, status: "running",
        base_ref: binding.base_ref, base_commit: binding.base_commit, branch: binding.child_run_id,
        worktree: join(fixture.repo, ".opencode", "worktrees", binding.child_run_id), checkpoint: binding,
        gates: {}, slices: [], steps: [],
      };
      assert.throws(() => validateRun({ ...base, branch: "alternate-branch" }), /run\.branch.*checkpoint\.child_run_id/u);
      assert.throws(() => validateRun({ ...base, worktree: "relative-worktree" }), /registered checkpoint reservation worktree/u);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("resumes a valid remote-based checkpoint when local main is stale", async () => {
    const fixture = createFixture("checkpoint-parent-resume-stale-local");
    try {
      const localMain = git(fixture.repo, ["rev-parse", "refs/heads/main"]);
      const remoteMain = advanceRemoteMain(fixture, "resume-remote-base.txt");
      const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-resume-stale-local", checkpointLaunchFn: (value) => value,
      });
      publishRunningCheckpointChild(fixture, started);
      assert.equal(git(fixture.repo, ["rev-parse", "refs/heads/main"]), localMain);
      assert.equal(started.binding.base_commit, remoteMain);
      const resumed = await resumeFactory(started.binding.child_run_id, { cwd: fixture.repo, dryRun: true });
      assert.equal(resumed.status, "dry-run");
      assert.equal(resumed.payload.checkpoint.base_commit, remoteMain);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("routes a reserved checkpoint only through checkpoint-start replay before checking remote advancement", async () => {
    const fixture = createFixture("checkpoint-parent-resume-prelaunch-advance");
    try {
      const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-resume-prelaunch-advance", checkpointLaunchFn: (value) => value,
      });
      rewriteCheckpointReservation(fixture, started.binding, "reserved");
      publishRunningCheckpointChild(fixture, started);
      advanceRemoteMain(fixture, "prelaunch-advance.txt");
      const resumed = await resumeFactory(started.binding.child_run_id, { cwd: fixture.repo, dryRun: true });
      assert.equal(resumed.status, "checkpoint-start-required");
      assert.equal(resumed.reason_code, "checkpoint-reservation-reserved");
      assert.equal(resumed.reservation_state, "reserved");
      assert.match(resumed.reason, /factory checkpoint-start exact replay/u);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("preserves launched checkpoint identity across remote-main advance without rebasing", async () => {
    const fixture = createFixture("checkpoint-parent-resume-launched-advance");
    try {
      const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-resume-launched-advance", checkpointLaunchFn: (value) => value,
      });
      publishRunningCheckpointChild(fixture, started);
      const originalBase = started.binding.base_commit;
      const remoteMain = advanceRemoteMain(fixture, "launched-advance.txt");
      const resumed = await resumeFactory(started.binding.child_run_id, { cwd: fixture.repo, dryRun: true });
      assert.equal(resumed.status, "dry-run");
      assert.notEqual(remoteMain, originalBase);
      assert.equal(resumed.payload.checkpoint.base_commit, originalBase);
      assert.equal(git(fixture.repo, ["rev-parse", `refs/heads/${started.binding.child_run_id}`]), originalBase);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("routes concurrent reserved, launching, and unknown ordinary resume and recovery without launch", async () => {
    for (const state of ["reserved", "launching", "unknown"]) {
      const fixture = createFixture(`checkpoint-ordinary-resume-${state}`);
      let launches = 0;
      try {
        const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
          cwd: fixture.repo, runId: `checkpoint-ordinary-resume-${state}-child`, checkpointLaunchFn: (value) => value,
        });
        rewriteCheckpointReservation(fixture, started.binding, state);
        const runPath = join(fixture.repo, ".opencode", "factory", started.binding.child_run_id, "run.json");
        const beforeRun = readFileSync(runPath);
        const beforeClaim = checkpointReservationClaim(fixture, started.binding);
        const [resume, recovery] = await Promise.all([
          resumeFactory(started.binding.child_run_id, {
            cwd: fixture.repo,
            foregroundLaunchFn: async () => { launches += 1; return { status: "launched" }; },
          }),
          recoverDisruptedRun(started.binding.child_run_id, { cwd: fixture.repo }),
        ]);
        const expectedStatus = state === "reserved" ? "checkpoint-start-required" : "recovery-required";
        const expectedReason = state === "reserved" ? "checkpoint-reservation-reserved" : "checkpoint-reservation-reconciliation-required";
        for (const result of [resume, recovery]) {
          assert.equal(result.status, expectedStatus, `${state} status`);
          assert.equal(result.reason_code, expectedReason, `${state} reason`);
          assert.equal(result.reservation_state, state, `${state} reservation`);
          assert.equal(result.launched, false, `${state} launch result`);
        }
        assert.equal(launches, 0, state);
        assert.deepEqual(readFileSync(runPath), beforeRun, state);
        assert.deepEqual(checkpointReservationClaim(fixture, started.binding), beforeClaim, state);
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    }
  });

  it("allows concurrent ordinary resumes to launch an exactly launched checkpoint only once", async () => {
    const fixture = createFixture("checkpoint-ordinary-resume-launched");
    let launches = 0;
    try {
      const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-ordinary-resume-launched-child", checkpointLaunchFn: (value) => value,
      });
      const invoke = () => resumeFactory(started.binding.child_run_id, {
        cwd: fixture.repo,
        foregroundLaunchFn: async () => {
          launches += 1;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
          return { status: "launched", run_id: started.binding.child_run_id };
        },
      });
      const results = await Promise.all([invoke(), invoke()]);
      assert.equal(launches, 1);
      assert.equal(results.filter((result) => result.status === "launched").length, 1);
      assert.equal(results.filter((result) => result.status === "recovery-required" || result.status === "already-running").length, 1);
      assert.equal(checkpointReservationClaim(fixture, started.binding).state, "launched");
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("routes divergent remote main safely without changing launched checkpoint identity", async () => {
    const fixture = createFixture("checkpoint-parent-resume-divergent-main");
    try {
      const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-resume-divergent-main", checkpointLaunchFn: (value) => value,
      });
      publishRunningCheckpointChild(fixture, started);
      const branchHead = git(fixture.repo, ["rev-parse", `refs/heads/${started.binding.child_run_id}`]);
      advanceRemoteMain(fixture, "resume-divergence.txt", { diverge: true });
      await assert.rejects(resumeFactory(started.binding.child_run_id, { cwd: fixture.repo, dryRun: true }), /diverged.*persisted checkpoint base.*preserve the run identity/u);
      assert.equal(git(fixture.repo, ["rev-parse", `refs/heads/${started.binding.child_run_id}`]), branchHead);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("requires every predecessor completed normal PR and a verified merge commit on current main", async () => {
    const fixture = createFixture("checkpoint-parent-two");
    try {
      const first = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-child-one", checkpointLaunchFn: (value) => value,
      });
      writeFileSync(join(first.child_worktree, "child.txt"), "child\n");
      git(first.child_worktree, ["add", "child.txt"]);
      git(first.child_worktree, ["commit", "-m", "checkpoint child"]);
      const childHead = git(first.child_worktree, ["rev-parse", "HEAD"]);
      git(fixture.repo, ["merge", "--no-ff", "checkpoint-child-one", "-m", "merge checkpoint child"]);
      const mergeCommit = git(fixture.repo, ["rev-parse", "HEAD"]);
      git(fixture.repo, ["push", "origin", "main"]);
      publishCompletedChild(fixture, first.binding, childHead);

      await assert.rejects(
        startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
          cwd: fixture.repo, runId: "checkpoint-child-two", checkpointLaunchFn: (value) => value,
        }),
        /--predecessor-merge-commit/u,
      );
      const second = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        cwd: fixture.repo, runId: "checkpoint-child-two", predecessorMergeCommit: mergeCommit,
        observePredecessorPrOperation: async () => canonicalMergedObservation(fixture, { binding: first.binding, mergeCommit }),
        checkpointLaunchFn: (value) => value,
      });
      assert.equal(second.binding.predecessor_checkpoint_id, "checkpoint-001");
      assert.equal(second.binding.predecessor_child_run_id, "checkpoint-child-one");
      assert.equal(second.binding.predecessor_merge_commit, mergeCommit);
      assert.equal(second.binding.base_commit, mergeCommit);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects a shape-valid completed predecessor that skipped the normal pipeline", async () => {
    const fixture = createFixture("checkpoint-parent-incomplete");
    try {
      const first = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-child-incomplete", checkpointLaunchFn: (value) => value,
      });
      writeFileSync(join(first.child_worktree, "incomplete.txt"), "incomplete\n");
      git(first.child_worktree, ["add", "incomplete.txt"]);
      git(first.child_worktree, ["commit", "-m", "incomplete checkpoint child"]);
      const childHead = git(first.child_worktree, ["rev-parse", "HEAD"]);
      git(fixture.repo, ["merge", "--no-ff", "checkpoint-child-incomplete", "-m", "merge incomplete child"]);
      const mergeCommit = git(fixture.repo, ["rev-parse", "HEAD"]);
      publishCompletedChild(fixture, first.binding, childHead, { completePipeline: false });

      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        cwd: fixture.repo, runId: "checkpoint-child-two", predecessorMergeCommit: mergeCommit,
        checkpointLaunchFn: (value) => value,
      }), /full normal pipeline|merged slices|test-verifier|Gate 3/u);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects a completed predecessor whose reservation claim is forged against run.checkpoint", async () => {
    const fixture = createFixture("checkpoint-parent-forged-reservation");
    try {
      const predecessor = await createCompletedPredecessor(fixture, "checkpoint-child-forged-reservation");
      rewriteCheckpointReservation(fixture, predecessor.binding, "launched", {
        binding: { ...predecessor.binding, base_commit: predecessor.childHead },
      });
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        cwd: fixture.repo, runId: "checkpoint-child-two", predecessorMergeCommit: predecessor.mergeCommit,
        observePredecessorPrOperation: async () => canonicalMergedObservation(fixture, predecessor),
        checkpointLaunchFn: (value) => value,
      }), /reservation.*binding|exact.*checkpoint|forged/u);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("accepts a completed predecessor only with an exact launched reservation", async () => {
    for (const state of ["reserved", "launching", "unknown", "launched"]) {
      const fixture = createFixture(`checkpoint-parent-predecessor-${state}`);
      try {
        const predecessor = await createCompletedPredecessor(fixture, `checkpoint-child-${state}`);
        rewriteCheckpointReservation(fixture, predecessor.binding, state);
        const start = () => startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
          cwd: fixture.repo, runId: `checkpoint-child-two-${state}`, predecessorMergeCommit: predecessor.mergeCommit,
          observePredecessorPrOperation: async () => canonicalMergedObservation(fixture, predecessor),
          checkpointLaunchFn: (value) => value,
        });
        if (state === "launched") {
          const accepted = await start();
          assert.equal(accepted.binding.predecessor_child_run_id, predecessor.binding.child_run_id);
        } else {
          await assert.rejects(start, new RegExp(`reservation.*launched|${state}.*reconciliation`, "u"));
        }
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    }
  });

  it("recovers an exact reservation after a crash before launch without duplicating launch", async () => {
    const fixture = createFixture("checkpoint-parent-reservation-recovery");
    let launches = 0;
    try {
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo,
        runId: "checkpoint-recovery-child",
        beforeCheckpointLaunch: () => { throw new Error("injected pre-launch crash"); },
        checkpointLaunchFn: (value) => { launches += 1; return value; },
      }), /injected pre-launch crash/u);
      const recovered = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo,
        runId: "checkpoint-recovery-child",
        checkpointLaunchFn: (value) => { launches += 1; return value; },
      });
      assert.equal(recovered.binding.child_run_id, "checkpoint-recovery-child");
      assert.equal(launches, 1);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("admits only one launch when exact reservation contenders race after observation", async () => {
    const fixture = createFixture("checkpoint-parent-reservation-race");
    let releaseFirst;
    let firstReserved;
    let launches = 0;
    const reserved = new Promise((resolve) => { firstReserved = resolve; });
    const release = new Promise((resolve) => { releaseFirst = resolve; });
    try {
      const first = startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-race-child",
        beforeCheckpointLaunch: async () => { firstReserved(); await release; },
        checkpointLaunchFn: (value) => { launches += 1; return value; },
      });
      await reserved;
      const second = startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-race-child",
        checkpointLaunchFn: (value) => { launches += 1; return value; },
      });
      await second;
      releaseFirst();
      await assert.rejects(first, /changed concurrently|state transition/u);
      assert.equal(launches, 1);
    } finally {
      releaseFirst?.();
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("adopts an exact completed child without launching it again", async () => {
    const fixture = createFixture("checkpoint-parent-child-adoption");
    let launches = 0;
    try {
      const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-adopted-child", checkpointLaunchFn: (value) => { launches += 1; return value; },
      });
      publishCompletedChild(fixture, started.binding, fixture.baseCommit, { completePipeline: false });
      const adopted = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-adopted-child", checkpointLaunchFn: (value) => { launches += 1; return value; },
      });
      assert.equal(adopted.replayed, true);
      assert.equal(adopted.adopted, true);
      assert.equal(launches, 1);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("refuses to infer launch success from an existing child and launching reservation", async () => {
    const fixture = createFixture("checkpoint-parent-launching-adoption");
    let launches = 0;
    try {
      const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-launching-adoption-child", checkpointLaunchFn: (value) => { launches += 1; return value; },
      });
      rewriteCheckpointReservation(fixture, started.binding, "launching");
      publishCompletedChild(fixture, started.binding, fixture.baseCommit, { completePipeline: false });
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-launching-adoption-child", checkpointLaunchFn: (value) => { launches += 1; return value; },
      }), /launch outcome is indeterminate/u);
      assert.equal(launches, 1);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("never creates a fresh reservation around an already-published child", async () => {
    const fixture = createFixture("checkpoint-parent-fresh-adoption");
    try {
      const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-fresh-adoption-child", checkpointLaunchFn: (value) => value,
      });
      publishCompletedChild(fixture, started.binding, fixture.baseCommit, { completePipeline: false });
      deleteCheckpointReservation(fixture, started.binding);
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-fresh-adoption-child", checkpointLaunchFn: (value) => value,
      }), /existing child.*pre-existing.*reservation|fresh reservation/u);
      const { childRef, routeRef } = checkpointReservationRefs(fixture, started.binding);
      assert.equal(gitResult(fixture.repo, ["show-ref", "--verify", "--quiet", childRef]).ok, false);
      assert.equal(gitResult(fixture.repo, ["show-ref", "--verify", "--quiet", routeRef]).ok, false);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects an adoption reservation that does not predate durable child creation", async () => {
    const fixture = createFixture("checkpoint-parent-late-adoption-reservation");
    try {
      const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-late-adoption-child", checkpointLaunchFn: (value) => value,
      });
      publishCompletedChild(fixture, started.binding, fixture.baseCommit, { completePipeline: false });
      const run = JSON.parse(readFileSync(join(fixture.repo, ".opencode", "factory", started.binding.child_run_id, "run.json"), "utf8"));
      const late = new Date(Date.parse(run.created_at) + 1000).toISOString();
      rewriteCheckpointReservation(fixture, started.binding, "launched", { reserved_at: late });
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-late-adoption-child", checkpointLaunchFn: (value) => value,
      }), /reservation must predate durable child creation/u);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects local-only main even when local PR metadata claims the predecessor merged", async () => {
    const fixture = createFixture("checkpoint-parent-local-main-only");
    try {
      const predecessor = await createCompletedPredecessor(fixture, "checkpoint-child-local-main-only", { pushMain: false });
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        cwd: fixture.repo, runId: "checkpoint-child-two", predecessorMergeCommit: predecessor.mergeCommit,
        observePredecessorPrOperation: async () => canonicalMergedObservation(fixture, predecessor),
        checkpointLaunchFn: (value) => value,
      }), /canonical.*origin|remote main|origin.*main/u);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("fetches canonical remote main instead of trusting a stale remote-tracking ref", async () => {
    const fixture = createFixture("checkpoint-parent-stale-tracking");
    try {
      const staleTracking = git(fixture.repo, ["rev-parse", "refs/remotes/origin/main"]);
      const remoteMain = advanceRemoteMain(fixture, "remote-advance.txt");
      assert.notEqual(remoteMain, staleTracking);
      assert.equal(git(fixture.repo, ["rev-parse", "refs/remotes/origin/main"]), staleTracking);
      const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-remote-main-child", checkpointLaunchFn: (value) => value,
      });
      assert.equal(started.binding.base_ref, "refs/heads/main");
      assert.equal(started.binding.base_commit, remoteMain);
      assert.equal(git(fixture.repo, ["rev-parse", "refs/remotes/origin/main"]), staleTracking);
      assertNoCheckpointBaseRefs(fixture);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects a configured remote-tracking base ref even when it currently matches origin", async () => {
    const fixture = createFixture("checkpoint-parent-remote-tracking-ref");
    try {
      const path = join(fixture.parentRunDir, "run.json");
      const parent = JSON.parse(readFileSync(path, "utf8"));
      parent.base_ref = "refs/remotes/origin/main";
      writeJson(path, parent);
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-tracking-child", checkpointLaunchFn: (value) => value,
      }), /canonical remote refs\/heads\/main|remote-tracking/u);
      assertNoCheckpointBaseRefs(fixture);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects and cleans up when canonical remote main advances before launch", async () => {
    const fixture = createFixture("checkpoint-parent-remote-race");
    let launches = 0;
    try {
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo,
        runId: "checkpoint-remote-race-child",
        beforeCheckpointLaunch: () => advanceRemoteMain(fixture, "raced-main.txt"),
        checkpointLaunchFn: (value) => { launches += 1; return value; },
      }), /canonical remote main changed before checkpoint launch/u);
      assert.equal(launches, 0);
      assertNoCheckpointBaseRefs(fixture);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects a remote-main race inside the checked fetch observation", async () => {
    const fixture = createFixture("checkpoint-parent-fetch-race");
    let raced = false;
    try {
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo,
        runId: "checkpoint-fetch-race-child",
        afterCheckpointRemoteFetch: ({ phase }) => {
          if (phase === "pre-launch" && !raced) {
            raced = true;
            advanceRemoteMain(fixture, "fetch-raced-main.txt");
          }
        },
        checkpointLaunchFn: (value) => value,
      }), /canonical remote main changed while checkpoint authority was being observed/u);
      assert.equal(raced, true);
      assertNoCheckpointBaseRefs(fixture);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects divergent remote main before launch", async () => {
    const fixture = createFixture("checkpoint-parent-remote-divergence-before-launch");
    try {
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo,
        runId: "checkpoint-divergent-main-child",
        beforeCheckpointLaunch: () => advanceRemoteMain(fixture, "divergent-main.txt", { diverge: true }),
        checkpointLaunchFn: (value) => value,
      }), /canonical remote main no longer descends|changed before checkpoint launch/u);
      assertNoCheckpointBaseRefs(fixture);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects noncanonical origins and predecessor repositories that differ from origin", async () => {
    const noncanonical = createFixture("checkpoint-parent-wrong-origin");
    try {
      git(noncanonical.repo, ["remote", "set-url", "origin", `file://${noncanonical.originPath}`]);
      await assert.rejects(startFactoryCheckpoint(noncanonical.parentRunId, "checkpoint-001", {
        cwd: noncanonical.repo, runId: "checkpoint-wrong-origin-child", checkpointLaunchFn: (value) => value,
      }), /canonical GitHub|canonical GitHub HTTPS or SSH/u);
    } finally {
      rmSync(noncanonical.repo, { recursive: true, force: true });
    }

    const wrongRepository = createFixture("checkpoint-parent-wrong-repository");
    try {
      const predecessor = await createCompletedPredecessor(wrongRepository, "checkpoint-child-wrong-repository");
      const otherOrigin = "https://github.com/other/repo.git";
      git(wrongRepository.repo, ["config", `url.file://${wrongRepository.originPath}/.insteadOf`, otherOrigin]);
      git(wrongRepository.repo, ["remote", "set-url", "origin", otherOrigin]);
      await assert.rejects(startFactoryCheckpoint(wrongRepository.parentRunId, "checkpoint-002", {
        cwd: wrongRepository.repo, runId: "checkpoint-child-two", predecessorMergeCommit: predecessor.mergeCommit,
        observePredecessorPrOperation: async () => canonicalMergedObservation(wrongRepository, predecessor),
        checkpointLaunchFn: (value) => value,
      }), /repository does not match the canonical GitHub origin/u);
      assertNoCheckpointBaseRefs(wrongRepository);
    } finally {
      rmSync(wrongRepository.repo, { recursive: true, force: true });
    }
  });

  it("rejects a local-only predecessor merge when canonical GitHub observation is absent", async () => {
    const fixture = createFixture("checkpoint-parent-local-only");
    try {
      const predecessor = await createCompletedPredecessor(fixture, "checkpoint-child-local-only");
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        cwd: fixture.repo, runId: "checkpoint-child-two", predecessorMergeCommit: predecessor.mergeCommit,
        observePredecessorPrOperation: async () => ({ disposition: "absent", reason: null, pull_request: null }),
        checkpointLaunchFn: (value) => value,
      }), /canonical.*pull request|GitHub.*merged|remote.*merge/u);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects canonical remote merge divergence from the exact predecessor merge commit", async () => {
    const fixture = createFixture("checkpoint-parent-remote-divergence");
    try {
      const predecessor = await createCompletedPredecessor(fixture, "checkpoint-child-divergent");
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        cwd: fixture.repo, runId: "checkpoint-child-two", predecessorMergeCommit: predecessor.mergeCommit,
        observePredecessorPrOperation: async () => canonicalMergedObservation(fixture, predecessor, "f".repeat(40)),
        checkpointLaunchFn: (value) => value,
      }), /canonical.*merge commit|remote.*diverg/u);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("final closure rejects absent, open, closed-unmerged, wrong-head, wrong-repository, and nonancestor PR authority", async () => {
    for (const [label, observation] of [
      ["absent", () => ({ disposition: "absent", reason: null, pull_request: null })],
      ["open", (route) => ({ ...route.observation, disposition: "open" })],
      ["closed", (route) => ({ ...route.observation, disposition: "closed" })],
      ["wrong-head", (route) => ({ ...route.observation, pull_request: { ...route.observation.pull_request, head_sha: fixtureCommit(route.fixture) } })],
      ["wrong-repository", (route) => ({ ...route.observation, pull_request: { ...route.observation.pull_request, repository: "other/repo" } })],
      ["nonancestor", (route) => ({ ...route.observation, pull_request: { ...route.observation.pull_request, merge_commit_sha: route.fixture.baseCommit } })],
    ]) {
      const route = await createCompletedFinalRoute(`checkpoint-final-reject-${label}`);
      try {
        await assert.rejects(closeFactoryCheckpointRoute(route.fixture.parentRunId, {
          cwd: route.fixture.repo,
          observePredecessorPrOperation: async () => observation(route),
        }), /merged pull request|head_sha|repository|contain the exact child head|ancestor/u, label);
        assert.equal(checkpointFinalClosureRef(route.fixture), null, label);
      } finally {
        rmSync(route.fixture.repo, { recursive: true, force: true });
      }
    }
  });

  it("create-publishes and exactly replays final checkpoint closure", async () => {
    const route = await createCompletedFinalRoute("checkpoint-final-success");
    try {
      const options = { cwd: route.fixture.repo, observePredecessorPrOperation: async () => route.observation };
      const first = await closeFactoryCheckpointRoute(route.fixture.parentRunId, options);
      const replay = await closeFactoryCheckpointRoute(route.fixture.parentRunId, options);
      assert.equal(first.status, "closed");
      assert.equal(first.replayed, false);
      assert.equal(first.closure.kind, "delivery-checkpoint-final-closure");
      assert.equal(first.closure.final_checkpoint_id, "checkpoint-002");
      assert.equal(first.closure.child_run_id, route.final.binding.child_run_id);
      assert.equal(first.closure.merge_commit, route.mergeCommit);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.closure, first.closure);
    } finally {
      rmSync(route.fixture.repo, { recursive: true, force: true });
    }
  });

  it("exactly replays stored final closure after canonical remote main advances by descendants", async () => {
    const route = await createCompletedFinalRoute("checkpoint-final-descendant-replay");
    try {
      const options = { cwd: route.fixture.repo, observePredecessorPrOperation: async () => route.observation };
      const first = await closeFactoryCheckpointRoute(route.fixture.parentRunId, options);
      const originalRefOid = checkpointFinalClosureRef(route.fixture);
      const storedRemoteMain = first.closure.remote_main_commit;
      const storedClosedAt = first.closure.closed_at;
      advanceRemoteMain(route.fixture, "final-descendant-replay.txt");
      const replay = await closeFactoryCheckpointRoute(route.fixture.parentRunId, options);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.closure, first.closure);
      assert.equal(replay.closure.remote_main_commit, storedRemoteMain);
      assert.equal(replay.closure.closed_at, storedClosedAt);
      assert.equal(checkpointFinalClosureRef(route.fixture), originalRefOid);
    } finally {
      rmSync(route.fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects final closure replay when canonical remote main diverges from stored authority", async () => {
    const route = await createCompletedFinalRoute("checkpoint-final-replay-divergence");
    try {
      const options = { cwd: route.fixture.repo, observePredecessorPrOperation: async () => route.observation };
      await closeFactoryCheckpointRoute(route.fixture.parentRunId, options);
      const originalRefOid = checkpointFinalClosureRef(route.fixture);
      replaceRemoteMainFrom(route.fixture, route.fixture.baseCommit, "final-replay-divergence.txt");
      await assert.rejects(closeFactoryCheckpointRoute(route.fixture.parentRunId, options), /ancestor|stored final closure|canonical predecessor PR merge commit/u);
      assert.equal(checkpointFinalClosureRef(route.fixture), originalRefOid);
    } finally {
      rmSync(route.fixture.repo, { recursive: true, force: true });
    }
  });

  it("serializes concurrent descendant final closure replays to exact stored authority", async () => {
    const route = await createCompletedFinalRoute("checkpoint-final-concurrent-replay");
    try {
      const options = { cwd: route.fixture.repo, observePredecessorPrOperation: async () => route.observation };
      const first = await closeFactoryCheckpointRoute(route.fixture.parentRunId, options);
      advanceRemoteMain(route.fixture, "final-concurrent-replay.txt");
      const replays = await Promise.all([
        closeFactoryCheckpointRoute(route.fixture.parentRunId, options),
        closeFactoryCheckpointRoute(route.fixture.parentRunId, options),
      ]);
      assert.deepEqual(replays.map((result) => result.replayed), [true, true]);
      assert.deepEqual(replays[0].closure, first.closure);
      assert.deepEqual(replays[1].closure, first.closure);
    } finally {
      rmSync(route.fixture.repo, { recursive: true, force: true });
    }
  });

  it("wires factory checkpoint-close to the create-only final closure transition", async () => {
    const route = await createCompletedFinalRoute("checkpoint-final-cli");
    const output = [];
    const originalLog = console.log;
    let publications = 0;
    try {
      console.log = (...values) => output.push(values.join(" "));
      await runCliCommand(["factory", "checkpoint-close", route.fixture.parentRunId, "--json"], {
        factoryOptions: {
          cwd: route.fixture.repo,
          observePredecessorPrOperation: async () => route.observation,
          beforeCheckpointFinalClosureCommit: () => { publications += 1; },
        },
      });
      const result = JSON.parse(output.at(-1));
      assert.equal(publications, 1);
      assert.equal(result.status, "closed");
      assert.equal(result.replayed, false);
      assert.equal(result.closure.child_run_id, route.final.binding.child_run_id);
      assert.equal(result.ref, "[redacted]");
      assert.match(checkpointFinalClosureRef(route.fixture), /^[0-9a-f]{40}$/u);
    } finally {
      console.log = originalLog;
      rmSync(route.fixture.repo, { recursive: true, force: true });
    }
  });

  it("serializes final closure contenders to one exact terminal record", async () => {
    const route = await createCompletedFinalRoute("checkpoint-final-contention");
    try {
      // The production default is intentionally short; both contenders need a
      // bounded test window because the first holds this fixture's run lock
      // across checked Git/GitHub observations under full-suite load.
      const options = {
        cwd: route.fixture.repo,
        observePredecessorPrOperation: async () => route.observation,
        timeoutMs: 15_000,
        retryDelayMs: 25,
      };
      const results = await Promise.all([
        closeFactoryCheckpointRoute(route.fixture.parentRunId, options),
        closeFactoryCheckpointRoute(route.fixture.parentRunId, options),
      ]);
      assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
      assert.equal(results[0].ref, results[1].ref);
      assert.deepEqual(results[0].closure, results[1].closure);
    } finally {
      rmSync(route.fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects remote-main and child-branch races before final closure publication", async () => {
    for (const race of ["remote", "branch"]) {
      const route = await createCompletedFinalRoute(`checkpoint-final-race-${race}`);
      try {
        await assert.rejects(closeFactoryCheckpointRoute(route.fixture.parentRunId, {
          cwd: route.fixture.repo,
          observePredecessorPrOperation: async () => route.observation,
          beforeCheckpointFinalClosureCommit: () => {
            if (race === "remote") advanceRemoteMain(route.fixture, "final-close-race.txt");
            else {
              const ref = `refs/heads/${route.final.binding.child_run_id}`;
              const head = git(route.fixture.repo, ["rev-parse", ref]);
              git(route.fixture.repo, ["update-ref", ref, route.final.binding.base_commit, head]);
            }
          },
        }), /remote main changed|final child manifest changed|transaction|concurrently|branch/u, race);
        assert.equal(checkpointFinalClosureRef(route.fixture), null, race);
      } finally {
        rmSync(route.fixture.repo, { recursive: true, force: true });
      }
    }
  });

  it("rejects reviewed source or manifest drift inside the reservation interval", async () => {
    const fixture = createFixture("checkpoint-parent-race");
    try {
      await assert.rejects(
        startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
          cwd: fixture.repo,
          runId: "checkpoint-raced-child",
          checkpointLaunchFn: (value) => value,
          beforeCheckpointReservation: () => writeFileSync(join(fixture.parentRunDir, fixture.artifact.ref), "{}\n"),
        }),
        /parent or manifest authority changed/u,
      );
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });
});

function createFixture(parentRunId) {
  const repo = mkdtempSync(join(tmpdir(), "checkpoint-start-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "fixture"]);
  const baseCommit = git(repo, ["rev-parse", "HEAD"]);
  const originPath = join(repo, ".git", "checkpoint-origin.git");
  const originUrl = "https://github.com/acme/repo.git";
  git(repo, ["init", "--bare", "--initial-branch=main", originPath]);
  git(repo, ["config", `url.file://${originPath}/.insteadOf`, originUrl]);
  git(repo, ["remote", "add", "origin", originUrl]);
  git(repo, ["push", "-u", "origin", "main"]);
  const parentRunDir = join(repo, ".opencode", "factory", parentRunId);
  for (const directory of ["plan", "reviews", "artifacts"]) mkdirSync(join(parentRunDir, directory), { recursive: true });
  const plan = checkpointPlan();
  writeJson(join(parentRunDir, "plan", "slices.json"), plan);
  const review = { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] };
  writeJson(join(parentRunDir, "reviews", "work-decomposer.json"), review);
  const planHash = hashFile(join(parentRunDir, "plan", "slices.json"));
  const reviewHash = hashFile(join(parentRunDir, "reviews", "work-decomposer.json"));
  const admissionResult = evaluateDeliveryEnvelopeAdmission({ plan });
  const manifest = buildCheckpointRoutingManifest({
    plan, planHash, admissionResult,
    decompositionAuthority: {
      plan_ref: "plan/slices.json", plan_hash: planHash,
      review_ref: "reviews/work-decomposer.json", review_hash: reviewHash,
      attempt: 1, review,
    },
  });
  const artifact = checkpointRoutingArtifact(manifest);
  writeFileSync(join(parentRunDir, artifact.ref), artifact.bytes);
  writeJson(join(parentRunDir, "run.json"), {
    schema_version: 1, run_id: parentRunId, status: "blocked", base_ref: "refs/heads/main", base_commit: baseCommit,
    branch: "main", worktree: repo, gates: {}, slices: [],
    steps: [{
      agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
      acceptance: { artifact_ref: "plan/slices.json", artifact_hash: planHash, review_ref: "reviews/work-decomposer.json", review_hash: reviewHash },
    }, { agent: "test-verifier", status: "blocked", attempts: 0 }],
    terminal_result: {
      status: "blocked", run_id: parentRunId, pr_url: null, reason: "oversized-plan-checkpoint-routing-required",
      summary: "Oversized plan routed to 2 sequential independently shippable checkpoints.",
      artifacts: { checkpoint_routing: artifact.ref },
    },
  });
  return { repo, parentRunId, parentRunDir, baseCommit, plan, manifest, artifact, originPath, originUrl };
}

function publishCompletedChild(fixture, binding, headSha, { completePipeline = true } = {}) {
  const runDir = join(fixture.repo, ".opencode", "factory", binding.child_run_id);
  mkdirSync(runDir, { recursive: true });
  if (completePipeline) {
    const worktree = checkpointReservationClaim(fixture, binding).worktree;
    if (!existsSync(worktree)) {
      mkdirSync(join(fixture.repo, ".opencode", "worktrees"), { recursive: true });
      git(fixture.repo, ["worktree", "add", worktree, binding.child_run_id]);
    }
    for (const directory of ["plan", "reviews", "evidence", "artifacts"]) mkdirSync(join(runDir, directory), { recursive: true });
    const plan = {
      slices: [{ id: "backend", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["works"], test_plan: ["node --version"] }],
      integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
      delivery_envelope: { schema_version: 1, delivery_units: [{ id: "backend-unit", slice_id: "backend", invariant_families: [{ id: "behavior", description: "Behavior" }], obligations: [{ id: "behavior-check", description: "Check behavior", invariant_family_id: "behavior", verification_artifact_id: "backend-tests" }], verification_artifacts: [{ id: "backend-tests", test_plan_index: 0, test_plan_entry: "node --version" }] }] },
    };
    writeJson(join(runDir, "plan", "slices.json"), plan);
    writeJson(join(runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] });
    writeJson(join(runDir, "evidence", "backend.json"), { subject: "backend", attempt: 1, status: "pass", review_ready: true, head_sha: headSha });
    const familyEvidence = writeVerificationArtifactReceipt({
      runDir, runId: binding.child_run_id, plan, sliceId: "backend", attempt: 1, reviewedCommit: headSha,
      artifactId: "backend-tests", evidenceRef: "evidence/backend-family.json",
      result: { type: "verification-result", outcome: "pass", summary: "Behavior passed" },
    });
    const sliceReview = createSliceReviewRecord({ subject: "backend", attempt: 1, reviewedCommit: headSha });
    sliceReview.invariant_family_ledger = passingInvariantFamilyLedger({ plan, sliceId: "backend", reviewedCommit: headSha, evidenceRef: familyEvidence.ref, evidenceHash: familyEvidence.hash });
    writeJson(join(runDir, "reviews", "backend.json"), sliceReview);
    writeFileSync(join(runDir, "artifacts", "test-report.md"), "# Test report\n\nPASS\n");
    const receiptRef = "evidence/test-verifier.attempt-1.json";
    const claim = {
      schema_version: 1, kind: "checked-test-execution-claim", state: "active", nonce: "123e4567-e89b-42d3-a456-426614174000",
      run_id: binding.child_run_id, attempt: 1, plan_ref: "plan/slices.json", plan_hash: hashFile(join(runDir, "plan", "slices.json")),
      head_sha: headSha, receipt_ref: receiptRef, claimed_at: "2026-07-19T10:00:00.000Z",
    };
    const stream = { captured_bytes: 0, sha256: `sha256:${createHash("sha256").digest("hex")}`, truncated: false };
    const receipt = {
      schema_version: 1, kind: "checked-test-execution-receipt", subject: "test-verifier", run_id: binding.child_run_id,
      attempt: 1, claim_nonce: claim.nonce, plan_ref: claim.plan_ref, plan_hash: claim.plan_hash, head_sha: headSha,
      started_at: "2026-07-19T10:00:00.000Z", completed_at: "2026-07-19T10:00:01.000Z", duration_ms: 1000,
      status: "pass", review_ready: true,
      commands: [{ index: 0, program: "npm", args: ["run", "check"], outcome: "exited", status: "pass", exit_code: 0, signal: null, error_code: null, duration_ms: 1000, stdout: stream, stderr: stream }],
    };
    writeJson(join(runDir, receiptRef), receipt);
    const completedClaim = { ...claim, state: "completed", completed_at: receipt.completed_at, status: "pass", receipt_hash: hashFile(join(runDir, receiptRef)) };
    writeJson(join(runDir, "reviews", "test-verifier.json"), { subject: "test-verifier", attempt: 1, verdict: "APPROVE", reviewed_head_sha: headSha });
    writeFileSync(join(runDir, "artifacts", "validation-report.md"), "GO\n");
    writeJson(join(runDir, "reviews", "implementation-validator.json"), { subject: binding.child_run_id, attempt: 1, verdict: "GO", reviewed_head_sha: headSha });
    writeJson(join(runDir, "reviews", "security-reviewer.json"), { subject: binding.child_run_id, attempt: 1, verdict: "PASS", reviewed_head_sha: headSha });
    const evidenceRef = "evidence/backend.json"; const reviewRef = "reviews/backend.json";
    const testReviewRef = "reviews/test-verifier.json"; const testArtifactRef = "artifacts/test-report.md";
    const attemptReview = createSliceAttemptReview({ evidenceRef, evidenceHash: hashFile(join(runDir, evidenceRef)), reviewRef, reviewHash: hashFile(join(runDir, reviewRef)), reviewedCommit: headSha });
    const run = {
      schema_version: 1, run_id: binding.child_run_id, status: "completed", created_at: new Date(Date.now() + 1000).toISOString(), base_ref: binding.base_ref, base_commit: binding.base_commit,
      branch: binding.child_run_id, worktree, gates: { pre_pr: { status: "approved" } }, checkpoint: binding,
      slices: [{ id: "backend", stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status: "merged", attempts: 1, attempt_reviews: [attemptReview], evidence_ref: evidenceRef, evidence_hash: hashFile(join(runDir, evidenceRef)), review_ref: reviewRef, review_hash: hashFile(join(runDir, reviewRef)), reviewed_commit: headSha, merge_commit: headSha }],
      steps: [
        { agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json", acceptance: { artifact_ref: "plan/slices.json", artifact_hash: claim.plan_hash, review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(runDir, "reviews", "work-decomposer.json")) } },
        { agent: "test-verifier", status: "accepted", attempts: 1, artifact_ref: testArtifactRef, evidence_ref: receiptRef, review_ref: testReviewRef, execution_claim: completedClaim, execution_claim_hash: hashValue(completedClaim), acceptance: { artifact_ref: testArtifactRef, artifact_hash: hashFile(join(runDir, testArtifactRef)), evidence_ref: receiptRef, evidence_hash: hashFile(join(runDir, receiptRef)), review_ref: testReviewRef, review_hash: hashFile(join(runDir, testReviewRef)), reviewed_head_sha: headSha } },
      ],
      validator: { verdict: "GO", report: "artifacts/validation-report.md", report_hash: hashFile(join(runDir, "artifacts", "validation-report.md")), review_ref: "reviews/implementation-validator.json", review_hash: hashFile(join(runDir, "reviews", "implementation-validator.json")), reviewed_head_sha: headSha },
      security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json", review_hash: hashFile(join(runDir, "reviews", "security-reviewer.json")), reviewed_head_sha: headSha },
      pr_url: "https://github.com/acme/repo/pull/1",
      terminal_result: { status: "completed", run_id: binding.child_run_id, reason: null, summary: "PR created.", artifacts: {}, pr_url: "https://github.com/acme/repo/pull/1", pr_number: 1, pr_node_id: "PR_checkpoint_1", repository: "acme/repo", operation_id: `ffpr-v1-${"d".repeat(64)}`, head_ref: binding.child_run_id, head_sha: headSha, base_ref: "main", base_sha: binding.base_commit, draft: false },
    };
    validateRun(run);
    writeJson(join(runDir, "run.json"), run);
    return;
  }
  writeJson(join(runDir, "run.json"), {
    schema_version: 1, run_id: binding.child_run_id, status: "completed", created_at: new Date(Date.now() + 1000).toISOString(), branch: binding.child_run_id,
    worktree: checkpointReservationClaim(fixture, binding).worktree, base_ref: binding.base_ref, base_commit: binding.base_commit, gates: {}, checkpoint: binding,
    pr_url: "https://github.com/acme/repo/pull/1",
    terminal_result: {
      status: "completed", run_id: binding.child_run_id, reason: null, summary: "PR created.", artifacts: {},
      pr_url: "https://github.com/acme/repo/pull/1", pr_number: 1, pr_node_id: "PR_checkpoint_1", repository: "acme/repo",
      operation_id: `ffpr-v1-${"d".repeat(64)}`, head_ref: binding.child_run_id, head_sha: headSha,
      base_ref: "main", base_sha: binding.base_commit, draft: false,
    },
  });
}

function publishRunningCheckpointChild(fixture, started) {
  const runDir = join(fixture.repo, ".opencode", "factory", started.binding.child_run_id);
  mkdirSync(runDir, { recursive: true });
  const run = {
    schema_version: 1,
    run_id: started.binding.child_run_id,
    status: "running",
    created_at: new Date(Date.now() + 1000).toISOString(),
    base_ref: started.binding.base_ref,
    base_commit: started.binding.base_commit,
    branch: started.binding.child_run_id,
    worktree: started.child_worktree,
    checkpoint: started.binding,
    gates: {},
    slices: [],
    steps: [],
  };
  validateRun(run);
  writeJson(join(runDir, "run.json"), run);
  return run;
}

async function createCompletedPredecessor(fixture, childRunId, { pushMain = true } = {}) {
  const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
    cwd: fixture.repo, runId: childRunId, checkpointLaunchFn: (value) => value,
  });
  writeFileSync(join(started.child_worktree, `${childRunId}.txt`), "child\n");
  git(started.child_worktree, ["add", `${childRunId}.txt`]);
  git(started.child_worktree, ["commit", "-m", `checkpoint child ${childRunId}`]);
  const childHead = git(started.child_worktree, ["rev-parse", "HEAD"]);
  git(fixture.repo, ["merge", "--no-ff", childRunId, "-m", `merge ${childRunId}`]);
  const mergeCommit = git(fixture.repo, ["rev-parse", "HEAD"]);
  if (pushMain) git(fixture.repo, ["push", "origin", "main"]);
  publishCompletedChild(fixture, started.binding, childHead);
  return { binding: started.binding, childHead, mergeCommit };
}

async function createCompletedFinalRoute(label) {
  const fixture = createFixture(label);
  const predecessor = await createCompletedPredecessor(fixture, `${label}-one`);
  const final = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
    cwd: fixture.repo,
    runId: `${label}-two`,
    predecessorMergeCommit: predecessor.mergeCommit,
    observePredecessorPrOperation: async () => canonicalMergedObservation(fixture, predecessor),
    checkpointLaunchFn: (value) => value,
  });
  writeFileSync(join(final.child_worktree, `${label}.txt`), "final\n");
  git(final.child_worktree, ["add", `${label}.txt`]);
  git(final.child_worktree, ["commit", "-m", `final checkpoint ${label}`]);
  const childHead = git(final.child_worktree, ["rev-parse", "HEAD"]);
  git(fixture.repo, ["merge", "--no-ff", final.binding.child_run_id, "-m", `merge ${label}`]);
  const mergeCommit = git(fixture.repo, ["rev-parse", "HEAD"]);
  git(fixture.repo, ["push", "origin", "main"]);
  publishCompletedChild(fixture, final.binding, childHead);
  const observation = canonicalMergedObservation(fixture, { binding: final.binding, mergeCommit });
  return { fixture, predecessor, final, childHead, mergeCommit, observation };
}

function checkpointFinalClosureRef(fixture) {
  const ref = `refs/opencode/checkpoint-final-closures/${createHash("sha256").update(fixture.parentRunId, "utf8").digest("hex")}`;
  const result = gitResult(fixture.repo, ["rev-parse", "--verify", ref]);
  return result.ok ? result.stdout.trim() : null;
}

function fixtureCommit(fixture) {
  return git(fixture.repo, ["rev-parse", "refs/heads/main^1"]);
}

function canonicalMergedObservation(fixture, predecessor, mergeCommitSha = predecessor.mergeCommit) {
  const terminal = JSON.parse(readFileSync(join(fixture.repo, ".opencode", "factory", predecessor.binding.child_run_id, "run.json"), "utf8")).terminal_result;
  return {
    disposition: "merged", reason: null,
    pull_request: {
      pr_url: terminal.pr_url, pr_number: terminal.pr_number, pr_node_id: terminal.pr_node_id,
      repository: terminal.repository, draft: terminal.draft, state: "merged", merged_at: "2026-07-19T12:00:00Z",
      head_ref: terminal.head_ref, head_sha: terminal.head_sha, head_repository: terminal.repository,
      base_ref: terminal.base_ref, base_sha: terminal.base_sha, base_repository: terminal.repository,
      merge_commit_sha: mergeCommitSha,
    },
  };
}

function checkpointPlan() {
  return {
    slices: [{ id: "backend", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["works"], test_plan: ["node --test", "node --version", "node -p 1", "node -p 2", "node -p 3", "node -p 4"] }],
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    delivery_envelope: {
      schema_version: 1,
      delivery_units: [{
        id: "backend-unit", slice_id: "backend",
        invariant_families: [{ id: "behavior", description: "Behavior" }, { id: "security", description: "Security" }],
        obligations: [
          ...[1, 2, 3].map((number) => ({ id: `behavior-${number}`, description: `Behavior ${number}`, invariant_family_id: "behavior", verification_artifact_id: `artifact-${number}` })),
          ...[1, 2, 3].map((number) => ({ id: `security-${number}`, description: `Security ${number}`, invariant_family_id: "security", verification_artifact_id: `artifact-${number + 3}` })),
        ],
        verification_artifacts: [
          { id: "artifact-1", test_plan_index: 0, test_plan_entry: "node --test" },
          { id: "artifact-2", test_plan_index: 1, test_plan_entry: "node --version" },
          { id: "artifact-3", test_plan_index: 2, test_plan_entry: "node -p 1" },
          { id: "artifact-4", test_plan_index: 3, test_plan_entry: "node -p 2" },
          { id: "artifact-5", test_plan_index: 4, test_plan_entry: "node -p 3" },
          { id: "artifact-6", test_plan_index: 5, test_plan_entry: "node -p 4" },
        ],
      }],
    },
  };
}

function git(cwd, args, options = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", ...options }).trim();
}

function gitResult(cwd, args) {
  try { return { ok: true, stdout: git(cwd, args) }; }
  catch { return { ok: false, stdout: "" }; }
}

function checkpointReservationRefs(fixture, binding) {
  return {
    childRef: `refs/opencode/checkpoint-targets/${createHash("sha256").update(binding.child_run_id, "utf8").digest("hex")}`,
    routeRef: `refs/opencode/checkpoint-routes/${createHash("sha256").update(`${fixture.parentRunId}\0${binding.checkpoint_id}`, "utf8").digest("hex")}`,
  };
}

function checkpointBinding(fixture, childRunId) {
  return {
    schema_version: 1,
    kind: "delivery-checkpoint-child",
    parent_run_id: fixture.parentRunId,
    parent_run_ref: `.opencode/factory/${fixture.parentRunId}/run.json`,
    parent_run_hash: hashFile(join(fixture.parentRunDir, "run.json")),
    manifest_ref: fixture.artifact.ref,
    manifest_hash: fixture.artifact.hash,
    checkpoint_id: "checkpoint-001",
    checkpoint_ordinal: 1,
    child_run_id: childRunId,
    base_ref: "refs/heads/main",
    base_commit: fixture.baseCommit,
    predecessor_checkpoint_id: null,
    predecessor_child_run_id: null,
    predecessor_merge_commit: null,
  };
}

function deleteCheckpointReservation(fixture, binding) {
  const { childRef, routeRef } = checkpointReservationRefs(fixture, binding);
  git(fixture.repo, ["update-ref", "-d", childRef]);
  git(fixture.repo, ["update-ref", "-d", routeRef]);
}

function rewriteCheckpointReservation(fixture, binding, state, overrides = {}) {
  const { childRef, routeRef } = checkpointReservationRefs(fixture, binding);
  const oid = git(fixture.repo, ["rev-parse", "--verify", childRef]);
  const current = JSON.parse(git(fixture.repo, ["cat-file", "blob", oid]));
  const claim = { ...current, ...overrides, state };
  for (const key of ["launching_at", "launched_at", "failed_at", "reason"]) delete claim[key];
  if (state === "launching") claim.launching_at = current.launched_at ?? current.reserved_at;
  if (state === "launched") claim.launched_at = current.launched_at ?? current.reserved_at;
  if (state === "unknown") {
    claim.failed_at = "2026-07-19T12:00:03.000Z";
    claim.reason = "launch-outcome-indeterminate";
  }
  const nextOid = git(fixture.repo, ["hash-object", "-w", "--stdin"], { input: `${JSON.stringify(claim)}\n` });
  git(fixture.repo, ["update-ref", childRef, nextOid, oid]);
  git(fixture.repo, ["update-ref", routeRef, nextOid, oid]);
}

function checkpointReservationClaim(fixture, binding) {
  const { childRef } = checkpointReservationRefs(fixture, binding);
  const oid = git(fixture.repo, ["rev-parse", "--verify", childRef]);
  return JSON.parse(git(fixture.repo, ["cat-file", "blob", oid]));
}

function advanceRemoteMain(fixture, filename, { diverge = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-remote-advance-"));
  const clone = join(root, "clone");
  try {
    git(root, ["clone", fixture.originPath, clone]);
    git(clone, ["config", "user.email", "remote@example.com"]);
    git(clone, ["config", "user.name", "Remote"]);
    if (diverge) git(clone, ["checkout", "--orphan", "divergent-main"]);
    writeFileSync(join(clone, filename), `${filename}\n`);
    git(clone, ["add", filename]);
    git(clone, ["commit", "-m", `remote ${filename}`]);
    const commit = git(clone, ["rev-parse", "HEAD"]);
    git(clone, ["push", ...(diverge ? ["--force"] : []), "origin", "HEAD:main"]);
    return commit;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function replaceRemoteMainFrom(fixture, baseCommit, filename) {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-remote-replace-"));
  const clone = join(root, "clone");
  try {
    git(root, ["clone", fixture.originPath, clone]);
    git(clone, ["config", "user.email", "remote@example.com"]);
    git(clone, ["config", "user.name", "Remote"]);
    git(clone, ["checkout", "--detach", baseCommit]);
    writeFileSync(join(clone, filename), `${filename}\n`);
    git(clone, ["add", filename]);
    git(clone, ["commit", "-m", `replace remote ${filename}`]);
    const commit = git(clone, ["rev-parse", "HEAD"]);
    git(clone, ["push", "--force", "origin", "HEAD:main"]);
    return commit;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertNoCheckpointBaseRefs(fixture) {
  assert.equal(git(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/checkpoint-base-observations"]), "");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hashFile(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}
