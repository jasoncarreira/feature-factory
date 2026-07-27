import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "./helpers/git-fixture.js";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelReviewRecord, createSliceAttemptReview, createSliceReviewRecord } from "./helpers/review-record-fixture.js";
import { hashFile } from "../src/refs.js";
import { git } from "../src/git.js";
import { observePullRequestOperation, prOperationMarker } from "../src/github.js";
import { deriveExpectedWorktreePath } from "../src/worktrees.js";
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
const BARRIER_FAILURE_TIMEOUT_MS = 30000;
const CONTENDER_LOCK_TIMEOUT_MS = 45000;

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

  it("keeps aged live ownership authoritative for gate, steering, and fence writers", async () => {
    const gateFixture = await createPendingGateFixture("aged-live-gate");
    const steeringFixture = createFixture("aged-live-steering");
    const fenceFixture = createReadyPrFixture("aged-live-fence");
    const cases = [
      [gateFixture, () => transitionGateDecision(gateFixture.runDir, "story", gateFixture.approval, { boundaryToken: gateFixture.boundary.token, ...agedLiveLockOptions() })],
      [steeringFixture, () => transitionSteeringQueued(steeringFixture.runDir, "must not overwrite", { id: "aged-live", ...agedLiveLockOptions() })],
      [fenceFixture, () => transitionPrePrFenceEstablished(fenceFixture.runDir, prOptions(fenceFixture, { token: "aged-live-fence-token", ...agedLiveLockOptions() }))],
    ];
    try {
      for (const [fixture, invoke] of cases) {
        const before = bytes(fixture.runPath);
        seedAgedLiveLock(fixture);
        await assert.rejects(invoke(), /timed out waiting for run\.json lock/u);
        assertBytes(fixture.runPath, before);
        assert.equal(readJson(join(fixture.lockPath, "owner.json")).nonce, "44444444-4444-4444-8444-444444444444");
        rmSync(fixture.lockPath, { recursive: true, force: true });
      }
    } finally {
      for (const fixture of [gateFixture, steeringFixture, fenceFixture]) {
        rmSync(fixture.lockPath, { recursive: true, force: true });
        cleanupFixture(fixture);
      }
    }
  });

  it("serializes gate, steering, and fence writers behind one exclusive dead-lock reclaimer", async () => {
    const gateFixture = await createPendingGateFixture("reclaim-gate-writer");
    const steeringFixture = createFixture("reclaim-steering-writer");
    const fenceFixture = createReadyPrFixture("reclaim-fence-writer");
    const cases = [
      {
        fixture: gateFixture,
        invoke: (hooks) => transitionGateDecision(gateFixture.runDir, "story", gateFixture.approval, {
          boundaryToken: gateFixture.boundary.token,
          timeoutMs: 5000,
          retryDelayMs: 1,
          processAliveFn: () => false,
          lockHooks: hooks,
        }),
        assertMutation: (run) => assert.equal(run.gates.story.status, "approved"),
      },
      {
        fixture: steeringFixture,
        invoke: (hooks) => transitionSteeringQueued(steeringFixture.runDir, "serialized steering", {
          id: "serialized-steering",
          timeoutMs: 5000,
          retryDelayMs: 1,
          processAliveFn: () => false,
          lockHooks: hooks,
        }),
        assertMutation: (run) => assert.equal(run.steering.pending.id, "serialized-steering"),
      },
      {
        fixture: fenceFixture,
        invoke: (hooks) => transitionPrePrFenceEstablished(fenceFixture.runDir, prOptions(fenceFixture, {
          token: "serialized-fence-token",
          timeoutMs: 5000,
          retryDelayMs: 1,
          processAliveFn: () => false,
          lockHooks: hooks,
        })),
        assertMutation: (run) => assert.equal(run.steering.pr_fence.token, "serialized-fence-token"),
      },
    ];
    try {
      for (const spec of cases) {
        const { fixture } = spec;
        seedDeadLock(fixture);
        const reclaimerClaimed = deferred();
        const releaseReclaimerClaim = deferred();
        const reclaimerRenamed = deferred();
        const releaseReclaimerRename = deferred();
        const reclaimerRemoved = deferred();
        const releaseReclaimerRemoved = deferred();
        const reclaimerEntered = deferred();
        let reclaimerCallbackEntered = false;
        const writerContended = deferred();
        const writerCreated = deferred();
        const releaseWriterPublication = deferred();
        const writerCleaning = deferred();
        const releaseWriterCleanup = deferred();
        const reclaimer = tracked(withRunJsonLock(fixture.runDir, () => { reclaimerCallbackEntered = true; reclaimerEntered.resolve(); }, {
          timeoutMs: 5000,
          retryDelayMs: 1,
          processAliveFn: () => false,
          lockHooks: {
            onReclaimClaimed: async () => { reclaimerClaimed.resolve(); await releaseReclaimerClaim.promise; },
            onReclaimRenamed: async () => { reclaimerRenamed.resolve(); await releaseReclaimerRename.promise; },
            onReclaimRemoved: async () => { reclaimerRemoved.resolve(); await releaseReclaimerRemoved.promise; },
          },
        }));
        await bounded(reclaimerClaimed.promise, "exclusive reclaimer claim");
        const before = bytes(fixture.runPath);
        const writer = tracked(spec.invoke({
          onContended: () => writerContended.resolve(),
          onLockCreated: async () => { writerCreated.resolve(); await releaseWriterPublication.promise; },
          onBeforeCleanup: async () => { writerCleaning.resolve(); await releaseWriterCleanup.promise; },
        }));
        try {
          await bounded(writerContended.promise, "writer contention on claimed dead lock");
          releaseReclaimerClaim.resolve();
          await bounded(reclaimerRenamed.promise, "dead lock quarantine rename");
          await bounded(writerCreated.promise, "successor writer publication barrier");
          assertBytes(fixture.runPath, before);
          releaseWriterPublication.resolve();
          await bounded(writerCleaning.promise, "successor writer cleanup barrier");
          spec.assertMutation(readJson(fixture.runPath));
          releaseReclaimerRename.resolve();
          await bounded(reclaimerRemoved.promise, "old quarantine removal");
          assert.equal(reclaimerCallbackEntered, false);
          assert.equal(existsSync(fixture.lockPath), true, "writer lock must survive stale reclaimer cleanup");
          releaseReclaimerRemoved.resolve();
          releaseWriterCleanup.resolve();
          await writer.promise;
          await bounded(reclaimerEntered.promise, "reclaimer serialized callback");
          await reclaimer.promise;
          spec.assertMutation(readJson(fixture.runPath));
        } finally {
          for (const barrier of [releaseReclaimerClaim, releaseReclaimerRename, releaseReclaimerRemoved, releaseWriterPublication, releaseWriterCleanup]) barrier.resolve();
          await Promise.allSettled([reclaimer.promise, writer.promise]);
          rmSync(fixture.lockPath, { recursive: true, force: true });
        }
      }
    } finally {
      for (const fixture of [gateFixture, steeringFixture, fenceFixture]) cleanupFixture(fixture);
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
        options: { processAliveFn: (pid) => pid !== 987654321 },
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
      const fence = tracked(transitionPrePrFenceEstablished(fixture.runDir, prOptions(fixture, laneOptions(fenceLane, { ...writer.options, token: `fence-${safeName(writer.name)}-token`, now: LATER }))));
      const sibling = tracked(writer.invoke(fixture, laneOptions(siblingLane, writer.options)));
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
      const fence = tracked(transitionPrePrFenceEstablished(fixture.runDir, prOptions(fixture, laneOptions(fenceLane, { token: "active-runtime-fence-token", now: LATER }))));
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
      const established = await transitionPrePrFenceEstablished(fixture.runDir, prOptions(fixture, { token: "stop-exclusion-fence", now: LATER }));
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

  it("rejects an identity-less fence during disrupted recovery without mutation", async () => {
    const fixture = createReadyPrFixture("legacy-fence-resume-check");
    try {
      await transitionPrePrFenceEstablished(fixture.runDir, prOptions(fixture, { token: "legacy-resume-fence" }));
      const run = readJson(fixture.runPath);
      for (const key of ["operation_id", "repository", "head_ref", "head_sha", "base_ref", "base_sha", "draft"]) delete run.steering.pr_fence[key];
      writeJson(fixture.runPath, run);
      const before = bytes(fixture.runPath);
      const result = await recoverDisruptedRun(fixture.runId, { cwd: fixture.repo, now: LATER });
      assert.equal(result.ok, false);
      assert.equal(result.updated, false);
      assert.match(result.terminal_result.reason, /pr_fence|operation_id.*repository.*head_ref.*head_sha.*base_ref.*base_sha.*draft/u);
      assertBytes(fixture.runPath, before);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("rejects an identity-less fence at the direct recovery boundary without mutation", async () => {
    const fixture = createReadyPrFixture("legacy-fence-recover");
    try {
      await transitionPrePrFenceEstablished(fixture.runDir, prOptions(fixture, { token: "legacy-recover-fence" }));
      const run = readJson(fixture.runPath);
      for (const key of ["operation_id", "repository", "head_ref", "head_sha", "base_ref", "base_sha", "draft"]) delete run.steering.pr_fence[key];
      writeJson(fixture.runPath, run);
      const before = bytes(fixture.runPath);
      await assert.rejects(
        transitionRecoverOrphan(fixture.runDir, "ignored", { now: LATER }),
        /pr_fence|operation_id.*repository.*head_ref.*head_sha.*base_ref.*base_sha.*draft/u,
      );
      assertBytes(fixture.runPath, before);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("fences the real disrupted-recovery worktree manifest update", async () => {
    const fixture = createRecoveryFixture("recovery-worktree-race", { omitWorktree: true });
    const holder = await acquireHolder(fixture.runDir);
    const fenceLane = lane("recovery-worktree-fence");
    const recoveryLane = lane("recovery-worktree-update");
    const fence = tracked(transitionPrePrFenceEstablished(fixture.runDir, prOptions(fixture, laneOptions(fenceLane, { token: "recovery-worktree-fence", now: LATER }))));
    const recovery = tracked(recoverDisruptedRun(fixture.runId, { ...laneOptions(recoveryLane), cwd: fixture.repo, now: LATER }));
    try {
      await allEntered(fenceLane, recoveryLane);
      assert.equal(gitStdout(fixture.worktree, ["branch", "--show-current"]), fixture.runId);
      assert.equal(deriveExpectedWorktreePath(fixture.repo, fixture.runId), fixture.worktree);
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
    const fixture = createRecoveryFixture("recovery-terminal-race");
    runGit(fixture.repo, ["worktree", "add", fixture.worktree, fixture.runId]);
    seedInactiveHeartbeat(fixture, NOW, 987654321, 60000);
    const holder = await acquireHolder(fixture.runDir);
    const fenceLane = lane("recovery-terminal-fence");
    const recoveryLane = lane("recovery-terminal-writer");
    const recoveryPreflight = deferred();
    const releaseRecoveryPreflight = deferred();
    const liveness = { processAliveFn: (pid) => pid !== 987654321 };
    const authority = prOptions(fixture);
    const authorityGit = authority.gitFn;
    const fence = tracked(transitionPrePrFenceEstablished(fixture.runDir, {
      ...authority,
      ...laneOptions(fenceLane, { token: "recovery-terminal-fence", now: LATER, ...liveness }),
      gitFn(cwd, args) {
        if (args[0] === "merge-base") return { ok: true, status: 0, stdout: "", stderr: "" };
        return authorityGit(cwd, args);
      },
    }));
    const recovery = tracked(recoverDisruptedRun(fixture.runId, {
      ...laneOptions(recoveryLane), cwd: fixture.repo, now: LATER, ...liveness,
      recoveryHooks: { beforeTerminalWrite: async () => { recoveryPreflight.resolve(); await releaseRecoveryPreflight.promise; } },
    }));
    let terminalHolder;
    try {
      await bounded(recoveryPreflight.promise, "recovery terminal preflight");
      await allEntered(fenceLane);
      fenceLane.release.resolve();
      holder.release.resolve();
      const established = await fence.promise;
      assert.equal(recovery.settled, false);
      runGit(fixture.worktree, ["checkout", "--detach"]);
      terminalHolder = await acquireHolder(fixture.runDir);
      releaseRecoveryPreflight.resolve();
      await allEntered(recoveryLane);
      const runBeforeRecovery = bytes(fixture.runPath);
      const heartbeatBeforeRecovery = bytes(fixture.heartbeatPath);
      recoveryLane.release.resolve();
      terminalHolder.release.resolve();
      await assert.rejects(recovery.promise, /recovery terminalization rejected: active pre-PR fence/u);
      assertBytes(fixture.runPath, runBeforeRecovery);
      assertBytes(fixture.heartbeatPath, heartbeatBeforeRecovery);
      const persisted = readJson(fixture.runPath);
      assert.equal(persisted.status, "running");
      assert.equal(persisted.terminal_result, null);
      assert.equal(persisted.steering.pr_fence.token, established.fence.token);
      assert.equal(readJson(fixture.heartbeatPath).pid, 987654321);
    } finally {
      releaseRecoveryPreflight.resolve();
      await finishRace(fixture, holder, terminalHolder, fenceLane, recoveryLane, fence, recovery);
      cleanupRecoveryFixture(fixture);
    }
  });

  it("orders missing, old, stale-hash, mismatched, winner, and duplicate fence clears", async () => {
    const fixture = createReadyPrFixture("exact-fence-clear-race");
    let race = [];
    try {
      const old = await transitionPrePrFenceEstablished(fixture.runDir, prOptions(fixture, { token: "old-fence-token", now: NOW }));
      await transitionPrePrFenceCleared(fixture.runDir, old.fence.token, prOptions(fixture, { now: "2026-07-10T12:01:00.000Z", prDisposition: "absent" }));
      const staleHash = hashRunState(readJson(fixture.runPath));
      const active = await transitionPrePrFenceEstablished(fixture.runDir, prOptions(fixture, { token: "active-fence-token", now: "2026-07-10T12:02:00.000Z" }));
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
        const contender = tracked(transitionPrePrFenceCleared(fixture.runDir, spec.token, prOptions(fixture, laneOptions(contenderLane, { ...spec.options, now: LATER, prDisposition: "absent" }))));
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

  it("retains the fence when executable clear observes an invalid own marker or tuple", async () => {
    const fixture = createReadyPrFixture("invalid-own-marker-clear");
    try {
      const authority = prOptions(fixture);
      const established = await transitionPrePrFenceEstablished(fixture.runDir, { ...authority, token: "invalid-own-marker-fence" });
      const marker = prOperationMarker(established.fence.operation_id);
      const scenarios = [
        operationApiPull(established.fence, { body: `${marker}\n${marker}` }),
        operationApiPull(established.fence, { body: `prefix ${marker}` }),
        operationApiPull(established.fence, { body: `${marker}\n<!-- opencode-feature-factory:pr-operation=malformed -->` }),
        operationApiPull(established.fence, { body: marker, head: { ref: "other", sha: established.fence.head_sha, repo: { full_name: established.fence.repository } } }),
      ];
      for (const pull of scenarios) {
        const before = bytes(fixture.runPath);
        const result = await transitionPrePrFenceCleared(fixture.runDir, established.fence.token, {
          ...authority,
          observePrOperation: observePullRequestOperation,
          observePrOperationPage: () => includedOperationPage([pull]),
        });
        assert.equal(result.updated, false);
        assert.equal(result.disposition, "ambiguous");
        assertBytes(fixture.runPath, before);
        assert.equal(readJson(fixture.runPath).steering.pr_fence.token, established.fence.token);
      }
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("retains the fence when executable clear sees incomplete or invalid pagination", async () => {
    const cases = [
      ["full-page-without-termination", ({ fence }) => includedOperationPage(Array.from({ length: 100 }, (_, index) => operationApiPull(fence, { number: index + 100, node_id: `PR_clear_${index}`, html_url: `https://github.com/acme/project/pull/${index + 100}`, body: "ordinary PR" })))],
      ["foreign-last", () => includedOperationPage([], `<https://evil.example/repos/acme/project/pulls?state=all&head=acme%3Afeature&base=main&per_page=100&page=3>; rel="last"`)],
      ["page-jump", ({ page }) => page === 1 ? includedOperationPage([], `<${operationPageUrl("acme/project", 3)}>; rel="next"`) : includedOperationPage([])],
      ["omitted-announced-pages", ({ page }) => page === 1 ? includedOperationPage([], `<${operationPageUrl("acme/project", 2)}>; rel="next", <${operationPageUrl("acme/project", 4)}>; rel="last"`) : includedOperationPage([])],
      ["repeated-next", () => includedOperationPage([], `<${operationPageUrl("acme/project", 2)}>; rel="next", <${operationPageUrl("acme/project", 3)}>; rel="next"`)],
    ];
    for (const [name, pageOutput] of cases) {
      const fixture = createReadyPrFixture(`clear-${name}`);
      try {
        const authority = prOptions(fixture);
        const established = await transitionPrePrFenceEstablished(fixture.runDir, { ...authority, token: `fence-${name}` });
        const before = bytes(fixture.runPath);
        const result = await transitionPrePrFenceCleared(fixture.runDir, established.fence.token, {
          ...authority,
          observePrOperation: observePullRequestOperation,
          observePrOperationPage: ({ page }) => pageOutput({ page, fence: established.fence }),
        });
        assert.equal(result.updated, false, name);
        assert.equal(result.disposition, "unknown", name);
        assertBytes(fixture.runPath, before, name);
        assert.equal(readJson(fixture.runPath).steering.pr_fence.token, established.fence.token, name);
      } finally {
        cleanupFixture(fixture);
      }
    }
  });

  it("still requires a live exact fence for PR creation", async () => {
    const fixture = createReadyPrFixture("pr-fence-contract");
    try {
      await assert.rejects(transitionPrCreated(fixture.runDir, {}), /active pre-PR fence/u);
      const options = prOptions(fixture);
      const established = await transitionPrePrFenceEstablished(fixture.runDir, { ...options, token: "pr-create-fence" });
      await assert.rejects(transitionPrCreated(fixture.runDir, {}, { ...options, fenceToken: "wrong-fence-token" }), /token mismatch/u);
      const stale = readJson(fixture.runPath);
      stale.steering.generation += 1;
      writeJson(fixture.runPath, stale);
      const staleBytes = bytes(fixture.runPath);
      await assert.rejects(transitionPrCreated(fixture.runDir, {}, { ...options, fenceToken: established.fence.token }), /pre-PR fence is stale/u);
      assertBytes(fixture.runPath, staleBytes);
      stale.steering.generation -= 1;
      writeJson(fixture.runPath, stale);
      const completed = await transitionPrCreated(fixture.runDir, {}, { ...options, fenceToken: established.fence.token });
      assert.equal(completed.run.status, "completed");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("restores heartbeat claim guards and side-effect-free fresh abort rejection", async () => {
    const consumedFixture = createFixture("heartbeat-uncheckpointed");
    try {
      const queued = await transitionSteeringQueued(consumedFixture.runDir, "consume before heartbeat", { id: "heartbeat-consumed", now: NOW });
      await transitionSteeringConsumed(consumedFixture.runDir, queued.steering, { now: LATER });
      const before = bytes(consumedFixture.runPath);
      await assert.rejects(startHeartbeat(consumedFixture.runId, { phase: "builder-wave", intervalMs: 60000 }, { cwd: consumedFixture.repo, now: LATER }), /consumed steering awaiting acknowledgement/u);
      assertBytes(consumedFixture.runPath, before);
      assert.equal(existsSync(consumedFixture.heartbeatPath), false);
    } finally {
      cleanupFixture(consumedFixture);
    }

    for (const kind of ["dispatch", "remediation"]) {
      const fixture = createFixture(`heartbeat-${kind}-claim`);
      try {
        const claim = await seedActionClaim(fixture, kind);
        const runBeforeStart = bytes(fixture.runPath);
        await assert.rejects(startHeartbeat(fixture.runId, { phase: "builder-wave", intervalMs: 60000 }, { cwd: fixture.repo, now: LATER }), /action awaiting start acknowledgement/u);
        assertBytes(fixture.runPath, runBeforeStart);
        assert.equal(readJson(fixture.runPath).steering.action_claim.token, claim.token);
        assert.equal(existsSync(fixture.heartbeatPath), false);

        seedInactiveHeartbeat(fixture, LATER, process.pid, 60000);
        const runBeforeAbort = bytes(fixture.runPath);
        const heartbeatBeforeAbort = bytes(fixture.heartbeatPath);
        await assert.rejects(transitionSteeringActionAborted(fixture.runDir, kind, claim.token, { now: LATER, processAliveFn: () => true }), /inactive heartbeat: active-heartbeat/u);
        assertBytes(fixture.runPath, runBeforeAbort);
        assertBytes(fixture.heartbeatPath, heartbeatBeforeAbort);
      } finally {
        cleanupFixture(fixture);
      }
    }
  });

  it("clears a pre-PR fence through the executable exact-token CLI", () => {
    const fixture = createReadyPrFixture("cli-exact-fence-clear");
    try {
      const established = runCli(fixture.repo, ["factory", "pr-fence", fixture.runId, "--json"]);
      assert.equal(established.status, 0, established.stderr);
      const token = JSON.parse(established.stdout).fence.token;
      const cleared = runCli(fixture.repo, ["factory", "pr-fence", fixture.runId, "--clear", "--fence-token", token, "--json"]);
      assert.equal(cleared.status, 0, cleared.stderr);
      assert.equal(JSON.parse(cleared.stdout).fence, null);
      assert.equal(readJson(fixture.runPath).steering.pr_fence, null);
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
  await transitionGateDecision(fixture.runDir, "story", {
    status: "pending",
    artifact: approval.artifact,
    question_ref: approval.question_ref,
    answer_ref: approval.answer_ref,
  }, { now: NOW });
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
    slices: [{ id: "slice", declared_paths: ["slice.txt"], effective_paths: ["slice.txt"], status: "running", attempts: 1 }],
  });
  return fixturePaths({ repo, runDir, runId });
}

function createReadyPrFixture(runId) {
  const fixture = createFixture(runId);
  initGitRepo(fixture.repo);
  runGit(fixture.repo, ["checkout", "-b", "feature"]);
  const head = gitStdout(fixture.repo, ["rev-parse", "HEAD"]);
  configureLocalGithubOrigin(fixture.repo, "https://github.com/acme/project.git");
  writeAbsentOperationGh(fixture.repo);
  for (const dir of ["artifacts", "evidence", "reviews"]) mkdirSync(join(fixture.runDir, dir), { recursive: true });
  writeFileSync(join(fixture.runDir, "artifacts", "validation-report.md"), "GO\n", "utf8");
  writeJson(join(fixture.runDir, "evidence", "slice.json"), { subject: "slice", attempt: 1, status: "pass", review_ready: true, head_sha: head });
  writeJson(join(fixture.runDir, "reviews", "slice.json"), createSliceReviewRecord({ subject: "slice", attempt: 1, reviewedCommit: head }));
  writeJson(join(fixture.runDir, "reviews", "implementation-validator.json"), createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: head, verdict: "GO" }));
  writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), createPanelReviewRecord({ subject: "feature", attempt: 1, reviewedHeadSha: head, verdict: "PASS" }));
  writeJson(fixture.runPath, readyRun(runId, fixture, head));
  return fixture;
}

function readyRun(runId, fixture, head) {
  const evidenceRef = "evidence/slice.json";
  const reviewRef = "reviews/slice.json";
  const evidenceHash = hashFile(join(fixture.runDir, evidenceRef));
  const reviewHash = hashFile(join(fixture.runDir, reviewRef));
  const attemptReview = createSliceAttemptReview({ evidenceRef, evidenceHash, reviewRef, reviewHash, reviewedCommit: head });
  return {
    schema_version: 1,
    run_id: runId,
    status: "running",
    base_ref: "main",
    base_commit: head,
    branch: "feature",
    worktree: fixture.repo,
    github_account: "acme",
    pr_mode: "ready",
    pr_url: null,
    gates: { pre_pr: { status: "approved", artifact: "artifacts/validation-report.md", question_ref: "gates/pre_pr.question.md", answer: "approve", answered_at: NOW } },
    steps: [{ agent: "implementation", status: "running", attempts: 1 }],
    slices: [{ id: "slice", declared_paths: ["slice.txt"], effective_paths: ["slice.txt"], status: "merged", attempts: 1, attempt_reviews: [attemptReview], evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash, reviewed_commit: head, merge_commit: head }],
    validator: { verdict: "GO", report: "artifacts/validation-report.md", report_hash: hashFile(join(fixture.runDir, "artifacts", "validation-report.md")), review_ref: "reviews/implementation-validator.json", review_hash: hashFile(join(fixture.runDir, "reviews", "implementation-validator.json")), reviewed_head_sha: head },
    security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json", review_hash: hashFile(join(fixture.runDir, "reviews", "security-reviewer.json")), reviewed_head_sha: head },
    terminal_result: null,
  };
}

function createRecoveryFixture(runId, { omitWorktree = false, deleteBranch = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), `steering-recovery-${runId}-`));
  initGitRepo(repo);
  const baseCommit = gitStdout(repo, ["rev-parse", "HEAD"]);
  runGit(repo, ["branch", runId]);
  configureLocalGithubOrigin(repo, "https://github.com/acme/project.git");
  writeAbsentOperationGh(repo);
  const runDir = join(repo, ".opencode", "factory", runId);
  const worktree = join(repo, ".opencode", "worktrees", runId);
  mkdirSync(runDir, { recursive: true });
  for (const dir of ["artifacts", "evidence", "reviews"]) mkdirSync(join(runDir, dir), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "validation-report.md"), "GO\n", "utf8");
  writeJson(join(runDir, "evidence", "slice.json"), { subject: "slice", attempt: 1, status: "pass", review_ready: true, head_sha: baseCommit });
  writeJson(join(runDir, "reviews", "slice.json"), createSliceReviewRecord({ subject: "slice", attempt: 1, reviewedCommit: baseCommit }));
  writeJson(join(runDir, "reviews", "implementation-validator.json"), createPanelReviewRecord({ subject: runId, attempt: 1, reviewedHeadSha: baseCommit, verdict: "GO" }));
  writeJson(join(runDir, "reviews", "security-reviewer.json"), createPanelReviewRecord({ subject: runId, attempt: 1, reviewedHeadSha: baseCommit, verdict: "PASS" }));
  const readyFixture = fixturePaths({ repo, runDir, runId, worktree });
  const run = {
    ...readyRun(runId, readyFixture, baseCommit),
    base_ref: "main",
    base_commit: baseCommit,
    branch: runId,
  };
  if (omitWorktree) delete run.worktree;
  else run.worktree = worktree;
  writeJson(join(runDir, "run.json"), run);
  if (deleteBranch) runGit(repo, ["branch", "-D", runId]);
  return readyFixture;
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
    // Env persistence and recovery perform real pre-lock work. This generous
    // deadline is only a hang bound; lane releases still establish all order.
    timeoutMs: CONTENDER_LOCK_TIMEOUT_MS,
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

function prOptions(fixture, overrides = {}) {
  const run = readJson(fixture.runPath);
  const disposition = overrides.prDisposition || "open";
  const options = { ...overrides };
  delete options.prDisposition;
  return {
    ...options,
    repoRoot: fixture.repo,
    gitFn: options.gitFn || ((cwd, args) => {
      if (["config --get remote.origin.url", "config --get-all remote.origin.url"].includes(args.join(" "))) return { ok: true, status: 0, stdout: "https://github.com/acme/project.git\n", stderr: "" };
      if (args[0] === "ls-remote") {
        const ref = args.at(-1).slice("refs/heads/".length);
        const local = ref === run.base_ref ? run.base_commit : gitStdout(fixture.repo, ["rev-parse", `refs/heads/${ref}`]);
        return { ok: true, status: 0, stdout: `${local}\trefs/heads/${ref}\n`, stderr: "" };
      }
      return git(cwd, args);
    }),
    observePrOperation: options.observePrOperation || ((identity) => disposition === "absent" ? { disposition: "absent", reason: null, pull_request: null } : {
      disposition,
      reason: null,
      pull_request: {
        pr_url: PR_URL, pr_number: 77, pr_node_id: "PR_steering_test", repository: identity.repository, draft: identity.draft,
        body: "", state: disposition, merged_at: disposition === "merged" ? LATER : null,
        head_ref: identity.head_ref, head_sha: identity.head_sha, head_repository: identity.repository,
        base_ref: identity.base_ref, base_sha: identity.base_sha, base_repository: identity.repository,
      },
    }),
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

async function bounded(promise, label, timeoutMs = BARRIER_FAILURE_TIMEOUT_MS) {
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

function seedAgedLiveLock(fixture) {
  mkdirSync(fixture.lockPath);
  writeJson(join(fixture.lockPath, "owner.json"), {
    pid: process.pid,
    hostname: hostname(),
    acquired_at: "2000-01-01T00:00:00.000Z",
    nonce: "44444444-4444-4444-8444-444444444444",
  });
}

function seedDeadLock(fixture) {
  mkdirSync(fixture.lockPath);
  writeJson(join(fixture.lockPath, "owner.json"), {
    pid: 987654321,
    hostname: hostname(),
    acquired_at: NOW,
    nonce: "77777777-7777-4777-8777-777777777777",
  });
}

function agedLiveLockOptions() {
  return { timeoutMs: 5, retryDelayMs: 1, staleLockMs: 1, processAliveFn: () => true };
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

function operationApiPull(fence, overrides = {}) {
  return {
    html_url: PR_URL,
    number: 77,
    node_id: "PR_steering_test",
    draft: fence.draft,
    body: prOperationMarker(fence.operation_id),
    state: "open",
    merged_at: null,
    head: { ref: fence.head_ref, sha: fence.head_sha, repo: { full_name: fence.repository } },
    base: { ref: fence.base_ref, sha: fence.base_sha, repo: { full_name: fence.repository } },
    ...overrides,
  };
}

function includedOperationPage(body, link = null) {
  return `HTTP/2 200 OK\r\ncontent-type: application/json${link ? `\r\nlink: ${link}` : ""}\r\n\r\n${JSON.stringify(body)}`;
}

function operationPageUrl(repository, page) {
  const query = new URLSearchParams({ state: "all", head: "acme:feature", base: "main", per_page: "100", page: String(page) });
  return `https://api.github.com/repos/${repository}/pulls?${query.toString()}`;
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
  return spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8", timeout: 15000, env: { ...process.env, PATH: `${join(repo, ".opencode", "fake-bin")}:${process.env.PATH}` } });
}

function configureLocalGithubOrigin(repo, url) {
  runGit(repo, ["remote", "add", "origin", url]);
  runGit(repo, ["config", `url.file://${repo}/.insteadOf`, url]);
}

function writeAbsentOperationGh(repo) {
  const bin = join(repo, ".opencode", "fake-bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "gh");
  writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "switch") process.exit(0);
if (args[0] === "api") {
  process.stdout.write("HTTP/2 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n[]");
  process.exit(0);
}
process.exit(2);
`, "utf8");
  chmodSync(executable, 0o755);
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
