import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  persistFactoryRunCreatedEnv,
  persistFactoryRunResumeEnv,
  recoverDisruptedRun,
  runActiveHeartbeatTickForTest,
  startHeartbeat,
  stopHeartbeat,
  writeSteering,
} from "../src/factory.js";
import {
  hashRunState,
  heartbeatOnce,
  transitionCostUsage,
  transitionGateDecision,
  transitionPrePrFenceCleared,
  transitionPrePrFenceEstablished,
  transitionPrCreated,
  transitionRecoverOrphan,
  transitionRunJson,
  transitionSteeringAcknowledged,
  transitionSteeringActionAborted,
  transitionSteeringActionStarted,
  transitionSteeringBoundaryCrossed,
  transitionSteeringBoundaryOpened,
  transitionSteeringConsumed,
  transitionSteeringQueued,
  transitionTerminalResult,
  withRunJsonLock,
} from "../src/run-state.js";

const NOW = "2026-07-10T12:00:00.000Z";
const LATER = "2026-07-10T12:10:00.000Z";
const PR_URL = "https://github.com/acme/project/pull/77";
const CLI = new URL("../src/cli.js", import.meta.url).pathname;

describe("lock-protected steering boundaries", () => {
  it("exposes validated boundary commands and rejects direct terminal CLI bypass", () => {
    const fixture = createFixture("boundary-cli");
    try {
      let proc = runCli(fixture.repo, ["factory", "terminal", fixture.runId, "blocked", "--reason", "done", "--json"]);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /requires --boundary-token/u);

      proc = runCli(fixture.repo, ["factory", "boundary-open", fixture.runId, "dispatch", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const token = JSON.parse(proc.stdout).boundary.token;
      proc = runCli(fixture.repo, ["factory", "boundary-cross", fixture.runId, "dispatch", "--boundary-token", token, "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const claim = JSON.parse(proc.stdout).action_claim;
      proc = runCli(fixture.repo, ["factory", "action-started", fixture.runId, "dispatch", "--action-token", claim.token, "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      assert.equal(JSON.parse(proc.stdout).action.outcome, "started");

      proc = runCli(fixture.repo, ["factory", "boundary-open", fixture.runId, "remediation", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const remediationToken = JSON.parse(proc.stdout).boundary.token;
      proc = runCli(fixture.repo, ["factory", "boundary-cross", fixture.runId, "remediation", "--boundary-token", remediationToken, "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const remediationClaim = JSON.parse(proc.stdout).action_claim;
      proc = runCli(fixture.repo, ["factory", "action-abort", fixture.runId, "remediation", "--action-token", remediationClaim.token, "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      assert.equal(JSON.parse(proc.stdout).action.outcome, "aborted");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("rejects direct, pending, uncheckpointed, and stale terminal/action crossings", async () => {
    const fixture = createFixture("boundary-guards");
    try {
      await assert.rejects(
        transitionTerminalResult(fixture.runDir, { status: "blocked", reason: "done" }),
        /lock-protected boundary observation/u,
      );
      const queued = await transitionSteeringQueued(fixture.runDir, "change the next action", { now: NOW, id: "pending" });
      await assert.rejects(transitionSteeringBoundaryOpened(fixture.runDir, "dispatch"), /pending steering/u);
      const consumed = await transitionSteeringConsumed(fixture.runDir, queued.steering, { now: "2026-07-10T12:01:00.000Z" });
      await assert.rejects(transitionSteeringBoundaryOpened(fixture.runDir, "remediation"), /acknowledgement is pending/u);
      await assert.rejects(transitionRunJson(fixture.runDir, (run) => { run.updated_at = NOW; }), /acknowledgement is pending/u);
      await transitionSteeringAcknowledged(fixture.runDir, consumed.steering, { now: "2026-07-10T12:02:00.000Z" });
      const opened = await transitionSteeringBoundaryOpened(fixture.runDir, "dispatch", { now: "2026-07-10T12:03:00.000Z", token: "dispatch-token-1" });
      await transitionRunJson(fixture.runDir, (run) => { run.updated_at = "2026-07-10T12:04:00.000Z"; });
      await assert.rejects(transitionSteeringBoundaryCrossed(fixture.runDir, "dispatch", opened.boundary.token), /observation is stale/u);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("validates contended hooks and bounds them without disturbing the real holder", async () => {
    const fixture = createFixture("lock-hook-contract");
    const holder = await acquireHolder(fixture.runDir);
    const ownerPath = join(fixture.runDir, "run-json.lock", "owner.json");
    const ownerBytes = bytes(ownerPath);
    const neverRelease = deferred();
    try {
      for (const lockHooks of [null, [], { onContended: "invalid" }]) {
        await assert.rejects(
          withRunJsonLock(fixture.runDir, async () => {}, { lockHooks }),
          /lockHooks must be an object|lockHooks\.onContended must be a function/u,
        );
        assertBytes(ownerPath, ownerBytes);
      }

      const rejectedEntry = deferred();
      await assert.rejects(
        withRunJsonLock(fixture.runDir, async () => {}, {
          timeoutMs: 500,
          lockHooks: { onContended: () => { rejectedEntry.resolve(); throw new Error("hook rejected on purpose"); } },
        }),
        /hook rejected on purpose/u,
      );
      await bounded(rejectedEntry.promise, "rejecting hook entry");
      assertBytes(ownerPath, ownerBytes);

      const neverEntry = deferred();
      await assert.rejects(
        withRunJsonLock(fixture.runDir, async () => {}, {
          timeoutMs: 50,
          staleLockMs: 1,
          processAliveFn: () => false,
          lockHooks: { onContended: async () => { neverEntry.resolve(); await neverRelease.promise; } },
        }),
        /timed out waiting for run\.json lock/u,
      );
      await bounded(neverEntry.promise, "nonresolving hook entry");
      assert.equal(existsSync(join(fixture.runDir, "run-json.lock")), true);
      assertBytes(ownerPath, ownerBytes);
    } finally {
      neverRelease.resolve();
      await finishRace(fixture, holder);
      cleanupFixture(fixture);
    }
  });

  it("orders steering ahead of gate approval and preserves answer and winner sidecars", async () => {
    const fixture = await createPendingGateFixture("gate-queue-race");
    const holder = await acquireHolder(fixture.runDir);
    const queueLane = lane("gate-queue-winner");
    const approvalLane = lane("gate-approval-loser");
    const queue = tracked(transitionSteeringQueued(fixture.runDir, "steer before approval", laneOptions(queueLane, { id: "gate-race", now: "2026-07-10T12:01:00.000Z" })));
    const approval = tracked(transitionGateDecision(fixture.runDir, "story", fixture.approval, laneOptions(approvalLane, {
      boundaryToken: fixture.boundary.token,
      now: "2026-07-10T12:02:00.000Z",
    })));
    try {
      await allEntered(queueLane, approvalLane);
      queueLane.release.resolve();
      holder.release.resolve();
      const queued = await queue.promise;
      assert.equal(approval.settled, false);
      const runBeforeLoser = bytes(fixture.runPath);
      const answerBeforeLoser = bytes(fixture.answerPath);
      const sidecarPath = join(fixture.runDir, queued.steering.ref);
      const sidecarBeforeLoser = bytes(sidecarPath);

      approvalLane.release.resolve();
      await assert.rejects(approval.promise, /gate rejected: pending steering/u);
      assertBytes(fixture.runPath, runBeforeLoser);
      assertBytes(fixture.answerPath, answerBeforeLoser);
      assertBytes(sidecarPath, sidecarBeforeLoser);
      const run = readJson(fixture.runPath);
      assert.equal(run.gates.story.status, "pending");
      assert.equal(run.steering.pending.id, "gate-race");
      assert.deepEqual(readdirSync(join(fixture.runDir, "gates")).sort(), ["story.answer", "story.question.md"]);
    } finally {
      await finishRace(fixture, holder, queueLane, approvalLane, queue, approval);
      cleanupFixture(fixture);
    }
  });

  for (const kind of ["dispatch", "remediation"]) {
    it(`orders steering ahead of a ${kind} boundary cross`, async () => {
      const fixture = createFixture(`${kind}-cross-race`);
      const opened = await transitionSteeringBoundaryOpened(fixture.runDir, kind, { token: `${kind}-boundary-token` });
      const holder = await acquireHolder(fixture.runDir);
      const queueLane = lane(`${kind}-queue-winner`);
      const crossLane = lane(`${kind}-cross-loser`);
      const queue = tracked(transitionSteeringQueued(fixture.runDir, `${kind} replacement`, laneOptions(queueLane, { id: `${kind}-replacement`, now: NOW })));
      const cross = tracked(transitionSteeringBoundaryCrossed(fixture.runDir, kind, opened.boundary.token, laneOptions(crossLane)));
      try {
        await allEntered(queueLane, crossLane);
        queueLane.release.resolve();
        holder.release.resolve();
        const queued = await queue.promise;
        assert.equal(cross.settled, false);
        const runBeforeLoser = bytes(fixture.runPath);
        const sidecarPath = join(fixture.runDir, queued.steering.ref);
        const sidecarBeforeLoser = bytes(sidecarPath);
        crossLane.release.resolve();
        await assert.rejects(cross.promise, /pending steering/u);
        assertBytes(fixture.runPath, runBeforeLoser);
        assertBytes(sidecarPath, sidecarBeforeLoser);
        const run = readJson(fixture.runPath);
        assert.equal(run.steering.pending.id, `${kind}-replacement`);
        assert.equal(run.steering.action_claim, null);
        assert.equal(readJson(sidecarPath).id, run.steering.pending.id);
        assert.equal(rawSha256(sidecarBeforeLoser), run.steering.pending.hash);
      } finally {
        await finishRace(fixture, holder, queueLane, crossLane, queue, cross);
        cleanupFixture(fixture);
      }
    });

    it(`enforces exact ${kind} start and abort claims under contention`, async () => {
      const startFixture = createFixture(`${kind}-start-race`);
      let startRace = [];
      try {
        const claim = await seedActionClaim(startFixture, kind);
        await assertInvalidActionClaims(startFixture, kind, claim, "started");
        const holder = await acquireHolder(startFixture.runDir);
        const queueLane = lane(`${kind}-blocked-queue`);
        const startLane = lane(`${kind}-exact-start`);
        const queueId = `${kind}-blocked-start`;
        const queueSidecarPath = pendingSidecarPath(startFixture.runDir, queueId, NOW);
        const queue = tracked(transitionSteeringQueued(startFixture.runDir, "must wait for action start", laneOptions(queueLane, { id: queueId, now: NOW })));
        const started = tracked(transitionSteeringActionStarted(startFixture.runDir, kind, claim.token, laneOptions(startLane)));
        startRace = [holder, queueLane, startLane, queue, started];
        await allEntered(queueLane, startLane);
        const runBeforeQueue = bytes(startFixture.runPath);
        const sidecarBeforeQueue = bytes(queueSidecarPath);
        queueLane.release.resolve();
        holder.release.resolve();
        await assert.rejects(queue.promise, /awaiting start acknowledgement/u);
        assertBytes(startFixture.runPath, runBeforeQueue);
        assertBytes(queueSidecarPath, sidecarBeforeQueue);
        assert.equal(started.settled, false);
        assert.equal(readJson(startFixture.runPath).steering.action_claim.token, claim.token);
        assert.equal(pendingSidecars(startFixture.runDir).length, 0);
        startLane.release.resolve();
        const resolution = await started.promise;
        assert.equal(resolution.action.outcome, "started");
        assert.equal(resolution.run.steering.action_claim, null);
      } finally {
        await finishRace(startFixture, ...startRace);
        cleanupFixture(startFixture);
      }

      const abortFixture = createFixture(`${kind}-abort-race`);
      let abortRace = [];
      try {
        const claim = await seedActionClaim(abortFixture, kind);
        seedInactiveHeartbeat(abortFixture, "2026-07-10T11:00:00.000Z");
        await assertInvalidActionClaims(abortFixture, kind, claim, "aborted");
        const holder = await acquireHolder(abortFixture.runDir);
        const genericLane = lane(`${kind}-generic-loser`);
        const abortLane = lane(`${kind}-exact-abort`);
        const generic = tracked(transitionRunJson(abortFixture.runDir, (run) => { run.forbidden_marker = kind; }, laneOptions(genericLane)));
        const aborted = tracked(transitionSteeringActionAborted(abortFixture.runDir, kind, claim.token, laneOptions(abortLane, { now: "2026-07-10T12:05:00.000Z" })));
        abortRace = [holder, genericLane, abortLane, generic, aborted];
        await allEntered(genericLane, abortLane);
        const runBeforeGeneric = bytes(abortFixture.runPath);
        const heartbeatBeforeGeneric = bytes(abortFixture.heartbeatPath);
        genericLane.release.resolve();
        holder.release.resolve();
        await assert.rejects(generic.promise, /action start acknowledgement is pending/u);
        assertBytes(abortFixture.runPath, runBeforeGeneric);
        assertBytes(abortFixture.heartbeatPath, heartbeatBeforeGeneric);
        assert.equal(aborted.settled, false);
        abortLane.release.resolve();
        const resolution = await aborted.promise;
        assert.equal(resolution.action.outcome, "aborted");
        assert.equal(resolution.run.forbidden_marker, undefined);
        assert.equal(readJson(abortFixture.heartbeatPath).pid, null);
        assert.equal(readJson(abortFixture.heartbeatPath).last_tick_at, "2026-07-10T12:05:00.000Z");
      } finally {
        await finishRace(abortFixture, ...abortRace);
        cleanupFixture(abortFixture);
      }
    });
  }

  it("orders a fence ahead of every finite pre-PR sibling writer", async () => {
    const cases = [
      {
        name: "steering queue",
        invoke: (fixture, options) => writeSteering(fixture.runId, "late steering", { ...options, cwd: fixture.repo, id: "fenced-queue" }),
        rejected: /active pre-PR fence/u,
        absent: (fixture, run) => {
          assert.equal(run.steering?.pending ?? null, null);
          assert.equal(pendingSidecars(fixture.runDir).length, 0);
        },
      },
      {
        name: "generic transition",
        invoke: (fixture, options) => transitionRunJson(fixture.runDir, (run) => { run.forbidden_marker = "generic"; }, options),
        rejected: /active pre-PR fence/u,
        absent: (_fixture, run) => assert.equal(run.forbidden_marker, undefined),
      },
      {
        name: "cost usage",
        invoke: (fixture, options) => transitionCostUsage(fixture.runDir, { agent: "validator", total_tokens: 1 }, options),
        rejected: /active pre-PR fence/u,
        absent: (_fixture, run) => assert.equal(run.cost_attribution, undefined),
      },
      {
        name: "heartbeatOnce",
        invoke: (fixture, options) => heartbeatOnce(fixture.runDir, { now: Date.parse(LATER) }, options),
        rejected: /heartbeat tick rejected: active pre-PR fence/u,
        absent: (_fixture, run, original) => assert.equal(run.heartbeat_at, original.heartbeat_at),
      },
      {
        name: "startHeartbeat",
        invoke: (fixture, options) => startHeartbeat(fixture.runId, { phase: "builder-wave", intervalMs: 60000 }, { ...options, cwd: fixture.repo, now: LATER }),
        rejected: /active pre-PR fence/u,
        absent: (fixture) => assert.equal(existsSync(fixture.heartbeatPath), false),
      },
      {
        name: "created env",
        invoke: (fixture, options) => persistFactoryRunCreatedEnv(fixture.runId, { ...options, cwd: fixture.repo, now: LATER }),
        rejected: /active pre-PR fence/u,
        absent: (_fixture, run) => assert.equal(run.debug_snapshot?.created_with, undefined),
      },
      {
        name: "resume env",
        invoke: (fixture, options) => persistFactoryRunResumeEnv(fixture.runId, { ...options, cwd: fixture.repo, now: LATER }),
        rejected: /active pre-PR fence/u,
        absent: (_fixture, run) => {
          assert.equal(run.debug_snapshot?.last_resumed_with, undefined);
          assert.equal(run.debug_snapshot?.resume_count, undefined);
        },
      },
      {
        name: "orphan recovery",
        setup: (fixture) => seedInactiveHeartbeat(fixture, NOW, 987654321, 60000),
        options: { processAliveFn: () => false },
        invoke: (fixture, options) => transitionRecoverOrphan(fixture.runDir, "must not recover", { ...options, now: LATER }),
        rejected: /recover rejected: active pre-PR fence/u,
        absent: (fixture, run) => {
          assert.equal(run.status, "running");
          assert.equal(run.terminal_result ?? null, null);
          assert.equal(readJson(fixture.heartbeatPath).pid, 987654321);
        },
      },
    ];

    for (const writer of cases) {
      const fixture = createReadyPrFixture(`fence-${safeName(writer.name)}`);
      writer.setup?.(fixture);
      const original = readJson(fixture.runPath);
      const originalHeartbeat = bytes(fixture.heartbeatPath);
      const holder = await acquireHolder(fixture.runDir);
      const fenceLane = lane(`${writer.name}-fence`);
      const siblingLane = lane(`${writer.name}-sibling`);
      const fence = tracked(transitionPrePrFenceEstablished(fixture.runDir, laneOptions(fenceLane, { ...writer.options, token: `fence-${safeName(writer.name)}-token`, now: LATER })));
      const sibling = tracked(writer.invoke(fixture, laneOptions(siblingLane, { ...writer.options, timeoutMs: 5000 })));
      try {
        await allEntered(fenceLane, siblingLane);
        fenceLane.release.resolve();
        holder.release.resolve();
        const established = await fence.promise;
        assert.equal(sibling.settled, false, writer.name);
        const runBeforeLoser = bytes(fixture.runPath);
        const heartbeatBeforeLoser = bytes(fixture.heartbeatPath);
        siblingLane.release.resolve();
        await assert.rejects(sibling.promise, writer.rejected, writer.name);
        assertBytes(fixture.runPath, runBeforeLoser, writer.name);
        assertBytes(fixture.heartbeatPath, heartbeatBeforeLoser, writer.name);
        assertBytes(fixture.heartbeatPath, originalHeartbeat, `${writer.name} original heartbeat`);
        const run = readJson(fixture.runPath);
        assert.equal(run.steering.pr_fence.token, established.fence.token, writer.name);
        assert.equal(run.steering.pr_fence.state_hash, established.fence.state_hash, writer.name);
        writer.absent(fixture, run, original);
      } finally {
        await stopIfActive(fixture);
        await finishRace(fixture, holder, fenceLane, siblingLane, fence, sibling);
        cleanupFixture(fixture);
      }
    }
  });

  it("runs the actual active heartbeat tick once without overlap and lets the fence win", async () => {
    const fixture = createReadyPrFixture("active-runtime-tick-race");
    let race = [];
    const secondHookEntered = { value: false };
    try {
      await startHeartbeat(fixture.runId, { phase: "builder-wave", intervalMs: 60000 }, { cwd: fixture.repo, now: NOW });
      const holder = await acquireHolder(fixture.runDir);
      const tickLane = lane("active-runtime-tick");
      const fenceLane = lane("active-runtime-fence");
      const tick = tracked(runActiveHeartbeatTickForTest(fixture.runId, laneOptions(tickLane, { cwd: fixture.repo, timeoutMs: 5000 })));
      const secondTick = tracked(runActiveHeartbeatTickForTest(fixture.runId, {
        cwd: fixture.repo,
        timeoutMs: 5000,
        lockHooks: { onContended: () => { secondHookEntered.value = true; } },
      }));
      const fence = tracked(transitionPrePrFenceEstablished(fixture.runDir, laneOptions(fenceLane, { token: "active-runtime-fence-token", now: LATER })));
      race = [holder, tickLane, fenceLane, tick, secondTick, fence];
      await allEntered(tickLane, fenceLane);
      fenceLane.release.resolve();
      holder.release.resolve();
      const established = await fence.promise;
      assert.equal(tick.settled, false);
      assert.equal(secondTick.settled, false);
      const runBeforeTick = bytes(fixture.runPath);
      const heartbeatBeforeTick = bytes(fixture.heartbeatPath);
      tickLane.release.resolve();
      assert.deepEqual(await tick.promise, { continue: false, reason: "pre-pr-fence-active" });
      await assert.rejects(secondTick.promise, /controlled heartbeat tick did not run.*already in progress/u);
      assert.equal(secondHookEntered.value, false);
      assertBytes(fixture.runPath, runBeforeTick);
      assertBytes(fixture.heartbeatPath, heartbeatBeforeTick);
      assert.equal(readJson(fixture.runPath).steering.pr_fence.token, established.fence.token);
      await assert.rejects(runActiveHeartbeatTickForTest(fixture.runId, { cwd: fixture.repo }), /no active heartbeat runtime/u);
    } finally {
      await stopIfActive(fixture);
      await finishRace(fixture, ...race);
      cleanupFixture(fixture);
    }
  });

  it("classifies stopHeartbeat as sidecar-only under an established fence", async () => {
    const fixture = createReadyPrFixture("stop-heartbeat-exclusion");
    try {
      seedInactiveHeartbeat(fixture, NOW, process.pid, 60000);
      const established = await transitionPrePrFenceEstablished(fixture.runDir, { token: "stop-exclusion-fence", now: LATER });
      const runBeforeStop = bytes(fixture.runPath);
      const heartbeatBeforeStop = bytes(fixture.heartbeatPath);
      const stopped = await stopHeartbeat(fixture.runId, {}, { cwd: fixture.repo, now: "2026-07-10T12:11:00.000Z" });
      assert.equal(stopped.pid, null);
      assert.notDeepEqual(bytes(fixture.heartbeatPath), heartbeatBeforeStop);
      assertBytes(fixture.runPath, runBeforeStop);
      const run = readJson(fixture.runPath);
      assert.equal(run.steering.pr_fence.token, established.fence.token);
      assert.equal(run.steering.pr_fence.state_hash, established.fence.state_hash);
      assert.equal(readJson(fixture.heartbeatPath).last_tick_at, "2026-07-10T12:11:00.000Z");
    } finally {
      await stopIfActive(fixture);
      cleanupFixture(fixture);
    }
  });

  it("fences the real disrupted-recovery worktree manifest update", async () => {
    const fixture = createRecoveryFixture("recovery-worktree-race", { omitWorktree: true });
    const holder = await acquireHolder(fixture.runDir);
    const fenceLane = lane("recovery-worktree-fence");
    const recoveryLane = lane("recovery-worktree-update");
    const fence = tracked(transitionPrePrFenceEstablished(fixture.runDir, laneOptions(fenceLane, { token: "recovery-worktree-fence", now: LATER })));
    const recovery = tracked(recoverDisruptedRun(fixture.runId, { ...laneOptions(recoveryLane), cwd: fixture.repo, now: LATER }));
    try {
      await allEntered(fenceLane, recoveryLane);
      fenceLane.release.resolve();
      holder.release.resolve();
      const established = await fence.promise;
      assert.equal(recovery.settled, false);
      const runBeforeRecovery = bytes(fixture.runPath);
      recoveryLane.release.resolve();
      await assert.rejects(recovery.promise, /recovery worktree update rejected: active pre-PR fence/u);
      assertBytes(fixture.runPath, runBeforeRecovery);
      const run = readJson(fixture.runPath);
      assert.equal(run.worktree, undefined);
      assert.equal(run.steering.pr_fence.token, established.fence.token);
      assert.equal(existsSync(fixture.worktree), true, "real pre-lock worktree creation should have occurred");
    } finally {
      await finishRace(fixture, holder, fenceLane, recoveryLane, fence, recovery);
      cleanupRecoveryFixture(fixture);
    }
  });

  it("fences real disrupted-recovery terminalization before heartbeat cleanup", async () => {
    const fixture = createRecoveryFixture("recovery-terminal-race", { deleteBranch: true });
    seedInactiveHeartbeat(fixture, NOW, 987654321, 60000);
    const holder = await acquireHolder(fixture.runDir);
    const fenceLane = lane("recovery-terminal-fence");
    const recoveryLane = lane("recovery-terminal-writer");
    const fence = tracked(transitionPrePrFenceEstablished(fixture.runDir, laneOptions(fenceLane, { token: "recovery-terminal-fence", now: LATER, processAliveFn: () => false })));
    const recovery = tracked(recoverDisruptedRun(fixture.runId, { ...laneOptions(recoveryLane), cwd: fixture.repo, now: LATER, processAliveFn: () => false }));
    try {
      await allEntered(fenceLane, recoveryLane);
      fenceLane.release.resolve();
      holder.release.resolve();
      const established = await fence.promise;
      assert.equal(recovery.settled, false);
      const runBeforeRecovery = bytes(fixture.runPath);
      const heartbeatBeforeRecovery = bytes(fixture.heartbeatPath);
      recoveryLane.release.resolve();
      await assert.rejects(recovery.promise, /recovery terminalization rejected: active pre-PR fence/u);
      assertBytes(fixture.runPath, runBeforeRecovery);
      assertBytes(fixture.heartbeatPath, heartbeatBeforeRecovery);
      const run = readJson(fixture.runPath);
      assert.equal(run.status, "running");
      assert.equal(run.terminal_result, null);
      assert.equal(run.steering.pr_fence.token, established.fence.token);
      assert.equal(readJson(fixture.heartbeatPath).pid, 987654321);
    } finally {
      await finishRace(fixture, holder, fenceLane, recoveryLane, fence, recovery);
      cleanupRecoveryFixture(fixture);
    }
  });

  it("orders missing, old, stale-hash, mismatched, winner, and duplicate fence clears", async () => {
    const fixture = createReadyPrFixture("exact-fence-clear-race");
    let race = [];
    try {
      const old = await transitionPrePrFenceEstablished(fixture.runDir, { token: "old-fence-token", now: NOW });
      await transitionPrePrFenceCleared(fixture.runDir, old.fence.token, { now: "2026-07-10T12:01:00.000Z" });
      const staleHash = hashRunState(readJson(fixture.runPath));
      const active = await transitionPrePrFenceEstablished(fixture.runDir, { token: "active-fence-token", now: "2026-07-10T12:02:00.000Z" });
      const holder = await acquireHolder(fixture.runDir);
      const specs = [
        { name: "missing", token: undefined, rejected: /boundary token must be a non-empty string/u },
        { name: "old", token: old.fence.token, rejected: /token mismatch/u },
        { name: "stale-hash", token: active.fence.token, options: { expectedCurrentHash: staleHash }, rejected: /stale run\.json transition/u },
        { name: "mismatched", token: "never-valid-fence", rejected: /token mismatch/u },
        { name: "winner", token: active.fence.token },
        { name: "duplicate", token: active.fence.token, rejected: /active pre-PR fence/u },
      ].map((spec) => {
        const contenderLane = lane(`fence-clear-${spec.name}`);
        const contender = tracked(transitionPrePrFenceCleared(fixture.runDir, spec.token, laneOptions(contenderLane, { ...spec.options, now: LATER })));
        return { ...spec, lane: contenderLane, contender };
      });
      race = [holder, ...specs.flatMap((spec) => [spec.lane, spec.contender])];
      await allEntered(...specs.map((spec) => spec.lane));
      const missingBefore = bytes(fixture.runPath);
      specs[0].lane.release.resolve();
      holder.release.resolve();

      for (const spec of specs.slice(0, 4)) {
        const before = spec === specs[0] ? missingBefore : bytes(fixture.runPath);
        if (spec !== specs[0]) {
          spec.lane.release.resolve();
        }
        await assert.rejects(spec.contender.promise, spec.rejected, spec.name);
        assertBytes(fixture.runPath, before, spec.name);
        assert.equal(readJson(fixture.runPath).steering.pr_fence.token, active.fence.token);
      }

      assert.equal(specs[4].contender.settled, false);
      assert.equal(specs[5].contender.settled, false);
      specs[4].lane.release.resolve();
      const cleared = await specs[4].contender.promise;
      assert.equal(cleared.fence, null);
      const clearedBytes = bytes(fixture.runPath);
      specs[5].lane.release.resolve();
      await assert.rejects(specs[5].contender.promise, specs[5].rejected);
      assertBytes(fixture.runPath, clearedBytes);
      assert.equal(readJson(fixture.runPath).steering.pr_fence, null);
      assert.equal(readJson(fixture.runPath).pr_url ?? null, null);
      const queued = await transitionSteeringQueued(fixture.runDir, "queue after exact recovery", { id: "post-clear-steering" });
      assert.equal(queued.steering.id, "post-clear-steering");
    } finally {
      await finishRace(fixture, ...race);
      cleanupFixture(fixture);
    }
  });

  it("still requires a live exact fence for PR creation", async () => {
    const fixture = createReadyPrFixture("pr-fence-contract");
    try {
      await assert.rejects(transitionPrCreated(fixture.runDir, prInput()), /active pre-PR fence/u);
      const established = await transitionPrePrFenceEstablished(fixture.runDir, { token: "pr-create-fence" });
      await assert.rejects(transitionPrCreated(fixture.runDir, prInput(), { fenceToken: "wrong-fence-token" }), /token mismatch/u);
      const completed = await transitionPrCreated(fixture.runDir, prInput(), { fenceToken: established.fence.token });
      assert.equal(completed.run.status, "completed");
    } finally {
      cleanupFixture(fixture);
    }
  });
});

async function assertInvalidActionClaims(fixture, kind, claim, outcome) {
  const transition = outcome === "started" ? transitionSteeringActionStarted : transitionSteeringActionAborted;
  const heartbeatBefore = bytes(fixture.heartbeatPath);
  for (const [label, requestedKind, token, rejected] of [
    ["missing", kind, undefined, /boundary token must be a non-empty string/u],
    ["wrong", kind, `wrong-${kind}-token`, /token mismatch/u],
    ["cross-kind", kind === "dispatch" ? "remediation" : "dispatch", claim.token, /token mismatch/u],
  ]) {
    const runBefore = bytes(fixture.runPath);
    await assert.rejects(transition(fixture.runDir, requestedKind, token, { now: LATER }), rejected, label);
    assertBytes(fixture.runPath, runBefore, label);
    assertBytes(fixture.heartbeatPath, heartbeatBefore, label);
  }

  const originalRun = bytes(fixture.runPath);
  const stale = readJson(fixture.runPath);
  stale.steering.generation += 1;
  writeJson(fixture.runPath, stale);
  const staleBytes = bytes(fixture.runPath);
  await assert.rejects(transition(fixture.runDir, kind, claim.token, { now: LATER }), /action start claim is stale/u);
  assertBytes(fixture.runPath, staleBytes, "generation-stale");
  assertBytes(fixture.heartbeatPath, heartbeatBefore, "generation-stale heartbeat");
  writeFileSync(fixture.runPath, originalRun);
}

async function seedActionClaim(fixture, kind) {
  const opened = await transitionSteeringBoundaryOpened(fixture.runDir, kind, { token: `${kind}-action-token` });
  const crossed = await transitionSteeringBoundaryCrossed(fixture.runDir, kind, opened.boundary.token);
  return crossed.action_claim;
}

async function createPendingGateFixture(runId) {
  const fixture = createFixture(runId);
  mkdirSync(join(fixture.runDir, "artifacts"), { recursive: true });
  mkdirSync(join(fixture.runDir, "gates"), { recursive: true });
  writeFileSync(join(fixture.runDir, "artifacts", "story.md"), "story\n", "utf8");
  writeFileSync(join(fixture.runDir, "gates", "story.question.md"), "approve?\n", "utf8");
  const approval = {
    status: "approved",
    artifact: "artifacts/story.md",
    question_ref: "gates/story.question.md",
    answer_ref: "gates/story.answer",
    approval_source: "external-driver",
  };
  await transitionGateDecision(fixture.runDir, "story", { ...approval, status: "pending" }, { now: NOW });
  fixture.answerPath = join(fixture.runDir, "gates", "story.answer");
  writeFileSync(fixture.answerPath, "approve\n", "utf8");
  fixture.boundary = (await transitionSteeringBoundaryOpened(fixture.runDir, "gate", { token: "gate-approval-token" })).boundary;
  fixture.approval = approval;
  return fixture;
}

function createFixture(runId) {
  const repo = mkdtempSync(join(tmpdir(), "steering-boundary-"));
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    status: "running",
    gates: {},
    steps: [],
    slices: [{ id: "slice", status: "running", attempts: 1 }],
  });
  return fixturePaths({ repo, runDir, runId });
}

function createReadyPrFixture(runId) {
  const fixture = createFixture(runId);
  for (const dir of ["artifacts", "reviews"]) mkdirSync(join(fixture.runDir, dir), { recursive: true });
  writeFileSync(join(fixture.runDir, "artifacts", "validation-report.md"), "GO\n", "utf8");
  writeJson(join(fixture.runDir, "reviews", "implementation-validator.json"), { subject: "feature", verdict: "GO" });
  writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), { subject: "feature", verdict: "PASS" });
  writeJson(fixture.runPath, readyRun(runId));
  return fixture;
}

function readyRun(runId) {
  return {
    schema_version: 1,
    run_id: runId,
    status: "running",
    pr_url: null,
    gates: { pre_pr: { status: "approved", artifact: "artifacts/validation-report.md", question_ref: "gates/pre_pr.question.md", answer: "approve", answered_at: NOW } },
    steps: [{ agent: "implementation", status: "running", attempts: 1 }],
    slices: [{ id: "slice", status: "merged", attempts: 1, merge_commit: "abc123" }],
    validator: { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" },
    security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" },
    terminal_result: null,
  };
}

function createRecoveryFixture(runId, { omitWorktree = false, deleteBranch = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), `steering-recovery-${runId}-`));
  initGitRepo(repo);
  const baseCommit = gitStdout(repo, ["rev-parse", "HEAD"]);
  runGit(repo, ["branch", runId]);
  const runDir = join(repo, ".opencode", "factory", runId);
  const worktree = join(repo, ".opencode", "worktrees", runId);
  mkdirSync(runDir, { recursive: true });
  for (const dir of ["artifacts", "reviews"]) mkdirSync(join(runDir, dir), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "validation-report.md"), "GO\n", "utf8");
  writeJson(join(runDir, "reviews", "implementation-validator.json"), { subject: "feature", verdict: "GO" });
  writeJson(join(runDir, "reviews", "security-reviewer.json"), { subject: "feature", verdict: "PASS" });
  const run = {
    ...readyRun(runId),
    base_ref: "main",
    base_commit: baseCommit,
    branch: runId,
    slices: [{ id: "slice", status: "merged", attempts: 1, merge_commit: baseCommit }],
  };
  if (!omitWorktree) run.worktree = worktree;
  writeJson(join(runDir, "run.json"), run);
  if (deleteBranch) runGit(repo, ["branch", "-D", runId]);
  return fixturePaths({ repo, runDir, runId, worktree });
}

function fixturePaths(fixture) {
  return {
    ...fixture,
    runPath: join(fixture.runDir, "run.json"),
    heartbeatPath: join(fixture.runDir, "heartbeat.json"),
    lockPath: join(fixture.runDir, "run-json.lock"),
  };
}

async function acquireHolder(runDir) {
  const entered = deferred();
  const release = deferred();
  const holder = tracked(withRunJsonLock(runDir, async () => {
    entered.resolve();
    await release.promise;
  }, { timeoutMs: 5000 }));
  holder.release = release;
  await bounded(entered.promise, "holder acquisition");
  return holder;
}

function lane(name) {
  return { name, entered: deferred(), release: deferred(), context: null };
}

function laneOptions(contenderLane, overrides = {}) {
  return {
    timeoutMs: 5000,
    retryDelayMs: 1,
    ...overrides,
    lockHooks: {
      onContended: async (context) => {
        contenderLane.context = context;
        contenderLane.entered.resolve();
        await contenderLane.release.promise;
      },
    },
  };
}

async function allEntered(...lanes) {
  await Promise.all(lanes.map((contenderLane) => bounded(contenderLane.entered.promise, `${contenderLane.name} contention`)));
  for (const contenderLane of lanes) {
    assert.equal(contenderLane.context.lockDir, join(contenderLane.context.runDir, "run-json.lock"));
  }
}

async function finishRace(fixture, ...parts) {
  const promises = [];
  for (const part of parts.flat()) {
    if (!part) continue;
    if (part.release?.resolve) part.release.resolve();
    if (part.promise && typeof part.promise.then === "function") promises.push(part.promise);
  }
  await Promise.allSettled(promises);
  assert.equal(existsSync(fixture.lockPath), false, `lock leaked for ${fixture.runId}`);
}

function tracked(promise) {
  const state = { promise, settled: false };
  promise.then(
    () => { state.settled = true; },
    () => { state.settled = true; },
  );
  return state;
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) { if (!settled) { settled = true; resolvePromise(value); } },
    reject(error) { if (!settled) { settled = true; rejectPromise(error); } },
  };
}

async function bounded(promise, label, timeoutMs = 3000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function seedInactiveHeartbeat(fixture, lastTickAt, pid = null, intervalMs = 30000) {
  writeJson(fixture.heartbeatPath, {
    schema_version: 1,
    run_id: fixture.runId,
    phase: "steering-boundary-test",
    pid,
    interval_ms: intervalMs,
    last_tick_at: lastTickAt,
  });
}

async function stopIfActive(fixture) {
  try {
    if (!existsSync(fixture.heartbeatPath)) return;
    const heartbeat = readJson(fixture.heartbeatPath);
    if (heartbeat.pid === process.pid) await stopHeartbeat(fixture.runId, {}, { cwd: fixture.repo, now: LATER });
  } catch {
    // Best-effort cleanup; finishRace still proves lock cleanup.
  }
}

function pendingSidecars(runDir) {
  const steeringDir = join(runDir, "steering");
  if (!existsSync(steeringDir)) return [];
  return readdirSync(steeringDir).filter((name) => name.startsWith("pending-"));
}

function pendingSidecarPath(runDir, id, createdAt) {
  const safeTimestamp = createdAt.replace(/[^0-9A-Za-z]/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "");
  return join(runDir, "steering", `pending-${safeTimestamp}-${id}.json`);
}

function rawSha256(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function bytes(file) {
  return existsSync(file) ? readFileSync(file) : null;
}

function assertBytes(file, expected, message) {
  assert.deepEqual(bytes(file), expected, message || file);
}

function prInput() {
  return { pr_url: PR_URL, pr_number: 77, repository: "acme/project" };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanupFixture(fixture) {
  assert.equal(existsSync(fixture.lockPath), false, `lock leaked before cleanup for ${fixture.runId}`);
  rmSync(fixture.repo, { recursive: true, force: true });
}

function cleanupRecoveryFixture(fixture) {
  if (existsSync(fixture.worktree)) spawnSync("git", ["worktree", "remove", "--force", fixture.worktree], { cwd: fixture.repo, env: gitEnv(), encoding: "utf8" });
  cleanupFixture(fixture);
}

function runCli(repo, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8", timeout: 15000 });
}

function initGitRepo(repo) {
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "test\n", "utf8");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "init"]);
}

function runGit(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv() });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function gitStdout(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv() });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

function gitEnv() {
  return { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "");
}
