import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeSteering, persistFactoryRunResumeEnv, resumeFactory, startFactory, transitionGateDecisionAndHandoff, writeSteering } from "../src/factory.js";
import { acquireLaunchClaim, recordDetachedProcessEvidence, transitionLaunchClaimPhase, writeProcessEvidence } from "../src/process-evidence.js";
import { decodeFeatureCommandPayload } from "../src/feature-command-payload.js";
import { transitionGateDecision, transitionSteeringBoundaryOpened } from "../src/run-state.js";

describe("factory resume", () => {
  const behavioralCases = [
    { code: "matching-detached-shepherd-live", setup: (f) => writeRunningEvidence(f, "matching-live"), options: (f) => ({ inspectorFn: (pid) => ({ ok: true, inspector: "test-inspector", pid, start_marker: "test-start", command_name: "opencode", cwd: f.repo }) }) },
    { code: "run-mode-not-interactive", setup: (f) => mutateRun(f, (run) => { run.mode = "headless"; delete run.gates.story.handoff_receipt; }) },
    { code: "protected-gate-pending", setup: async (f) => {
      writeFileSync(join(f.runDir, "artifacts", "brief.md"), "brief\n");
      writeFileSync(join(f.runDir, "gates", "brief.question.md"), "approve brief?\n");
      await transitionGateDecision(f.runDir, "brief", { status: "pending", artifact: "artifacts/brief.md", question_ref: "gates/brief.question.md" });
    } },
    { code: "terminal-run", setup: (f) => mutateRun(f, (run) => {
      const terminalResult = completedTerminalResult(f.runId);
      Object.assign(run, { status: "completed", pr_url: terminalResult.pr_url, terminal_result: terminalResult });
    }) },
    { code: "validated-cancelled", setup: (f) => writeStoppedEvidence(f, "cancelled") },
    { code: "cancel-pending", setup: (f) => writeRunningEvidence(f, "exec-cancel", { cancel: { requested_at: new Date().toISOString(), signal: "SIGTERM", confirmed_at: null, result: "pending", reason: "pending" } }) },
    { code: "approval-snapshot-mismatch", setup: (f) => writeFileSync(join(f.runDir, "artifacts", "story.md"), "changed\n") },
    { code: "steering-generation-mismatch", setup: (f) => mutateRun(f, (run) => { run.steering = { ...run.steering, generation: (run.steering?.generation || 0) + 1 }; }) },
    { code: "steering-state-not-clean", setup: (f) => mutateRun(f, (run) => { run.steering = { ...(run.steering || { schema_version: 1, generation: 0 }), boundary: { kind: "gate", token: "boundary1", generation: run.steering?.generation || 0, state_hash: `sha256:${"a".repeat(64)}`, created_at: new Date().toISOString() } }; }) },
    { code: "resume-ineligible", setup: (f) => rmSync(f.worktree, { recursive: true, force: true }) },
    { code: "launch-claim-invalid", setup: (f) => { mkdirSync(join(f.runDir, "process-launch.lock")); writeFileSync(join(f.runDir, "process-launch.lock", "owner.json"), "malformed claim bytes\n"); } },
    { code: "launch-owner-indeterminate", setup: (f) => writeClaim(f, { hostname: "foreign-host" }) },
    { code: "launch-claim-conflict", options: (f) => ({ inspectLaunchClaimFn: () => ({ ok: true, missing: false, owner_status: "live", claim: fakeClaim(f, { phase: "foreground-live" }) }) }) },
    { code: "process-evidence-invalid", setup: (f) => writeFileSync(join(f.runDir, "process.json"), "malformed process bytes\n") },
    { code: "process-identity-mismatch", setup: (f) => writeRunningEvidence(f, "exec-mismatch"), options: (f) => ({ inspectorFn: () => ({ ok: true, inspector: "test-inspector", pid: 9876, start_marker: "different", command_name: "opencode", cwd: f.repo }) }) },
    { code: "prior-process-stopped", setup: (f) => writeStoppedEvidence(f, "exited") },
    { code: "claim-acquisition-failed", options: () => ({ inspectLaunchClaimFn: () => ({ ok: false, missing: true }), acquireLaunchClaimFn: () => { throw new Error("injected acquisition failure"); } }) },
    { code: "foreground-release-failed", options: (f) => fakeLaunchOptions(f, { transitionFailure: "predecessor-released" }) },
    { code: "launch-spawn-failed", options: (f) => fakeLaunchOptions(f, { launchError: "spawn failed" }) },
    { code: "launch-readiness-failed", options: (f) => fakeLaunchOptions(f, { launchError: "readiness timed out" }) },
    { code: "launch-evidence-mismatch", options: (f) => fakeLaunchOptions(f, { mismatchedEvidence: true }) },
  ];

  for (const behavior of behavioralCases) {
    it(`behaviorally reaches ${behavior.code} through accepted gate handoff`, async () => {
      const fixture = await createApprovedHandoffFixture(`behavior-${behavior.code}`);
      try {
        await behavior.setup?.(fixture);
        writeJson(join(fixture.runDir, "heartbeat.json"), { schema_version: 1, run_id: fixture.runId, phase: "builder-wave", pid: null, interval_ms: 30000, last_tick_at: "2000-01-01T00:00:00.000Z" });
        const watched = snapshotSidecars(fixture.runDir);
        const behaviorOptions = behavior.options?.(fixture) || {};
        const result = await transitionGateDecisionAndHandoff(fixture.runDir, "story", fixture.decision, { cwd: fixture.repo, ...behaviorOptions });
        assert.equal(result.gate_accepted, true);
        assertBehaviorHandoff(result.handoff, behavior.code, fixture.runId);
        assert.equal(result.handoff.reason.includes("merge"), false);
        if (result.handoff.status === "recovery-required") assertPreservedOriginalSidecars(fixture.runDir, watched);
        if (["foreground-release-failed", "launch-spawn-failed", "launch-readiness-failed", "launch-evidence-mismatch"].includes(behavior.code)) {
          const claimPath = join(fixture.runDir, "process-launch.lock", "owner.json");
          assert.equal(existsSync(claimPath), true, "ambiguous launch claim must remain on disk");
          assert.equal(readFileSync(claimPath).equals(behaviorOptions.metrics.claimBytes), true, "claim bytes must remain identical after the response");
          assert.equal(behaviorOptions.metrics.spawnAttempts, behavior.code === "foreground-release-failed" ? 0 : 1);
          assert.equal(behaviorOptions.metrics.signalAttempts, 0);
          assert.equal(behaviorOptions.metrics.releaseAttempts, 0);
          assert.equal(behaviorOptions.metrics.sleepCalls.length, behavior.code === "launch-readiness-failed" ? 4 : 0);
          if (behavior.code === "launch-readiness-failed") {
            assert.deepEqual(behaviorOptions.metrics.sleepCalls, [25, 25, 25, 25]);
            assert.equal(behaviorOptions.metrics.now, 100);
          }
          if (behavior.code === "launch-evidence-mismatch") {
            assert.equal(existsSync(join(fixture.runDir, "process.json")), true);
            assert.equal(readFileSync(join(fixture.runDir, "process.json")).equals(behaviorOptions.metrics.processBytes), true);
          }
        }
      } finally {
        cleanup(fixture.repo);
      }
    });
  }

  it("rejects a missing interactive approval receipt before handoff", async () => {
    const fixture = await createApprovedHandoffFixture("behavior-approval-receipt-missing");
    try {
      mutateRun(fixture, (run) => { delete run.gates.story.handoff_receipt; });
      await assert.rejects(
        transitionGateDecisionAndHandoff(fixture.runDir, "story", fixture.decision, { cwd: fixture.repo }),
        /handoff_receipt: is required for an interactive approval/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  const ownershipRows = [
    { name: "interactive foreground resume", durableMode: "interactive", driverMode: "interactive", invoke: (f, o) => resumeFactory(f.runId, o), payloadKind: "resume" },
    { name: "explicit headless foreground resume", durableMode: "headless", driverMode: "headless", invoke: (f, o) => resumeFactory(f.runId, { ...o, headless: true }), payloadKind: "resume" },
    { name: "explicit autonomous foreground resume", durableMode: "autonomous", driverMode: "autonomous", invoke: (f, o) => resumeFactory(f.runId, { ...o, autonomous: true }), payloadKind: "resume" },
    { name: "interactive detached resume", durableMode: "interactive", driverMode: "headless", detached: true, invoke: (f, o) => resumeFactory(f.runId, { ...o, detached: true, headless: true }), payloadKind: "resume" },
    { name: "headless detached resume", durableMode: "headless", driverMode: "headless", detached: true, invoke: (f, o) => resumeFactory(f.runId, { ...o, detached: true, headless: true }), payloadKind: "resume" },
    { name: "autonomous detached resume", durableMode: "autonomous", driverMode: "autonomous", detached: true, invoke: (f, o) => resumeFactory(f.runId, { ...o, detached: true, autonomous: true }), payloadKind: "resume" },
    { name: "interactive start-resume", durableMode: "interactive", driverMode: "interactive", invoke: (f, o) => startFactory([`resume ${f.runId}`], o), payloadKind: "resume" },
    { name: "headless start-resume", durableMode: "headless", driverMode: "headless", invoke: (f, o) => startFactory([`resume ${f.runId}`], { ...o, headless: true }), payloadKind: "resume" },
    { name: "autonomous start-resume", durableMode: "autonomous", driverMode: "autonomous", invoke: (f, o) => startFactory([`resume ${f.runId}`], { ...o, autonomous: true }), payloadKind: "resume" },
    { name: "headless detached start-resume", durableMode: "headless", driverMode: "headless", detached: true, invoke: (f, o) => startFactory([`resume ${f.runId}`], { ...o, headless: true, detached: true }), payloadKind: "resume" },
    { name: "autonomous detached start-resume", durableMode: "autonomous", driverMode: "autonomous", detached: true, invoke: (f, o) => startFactory([`resume ${f.runId}`], { ...o, autonomous: true, detached: true }), payloadKind: "resume" },
  ];

  for (const row of ownershipRows) {
    it(`preserves exact outgoing payload and durable mode for ${row.name}`, async () => {
      const fixture = createFixture(`payload-${row.name.replaceAll(" ", "-")}`, { mode: row.durableMode });
      let payload;
      let launches = 0;
      const runBytesBefore = readFileSync(join(fixture.runDir, "run.json"));
      const inspectorFn = (pid) => ({ ok: true, inspector: "test-inspector", pid, start_marker: "test-start", command_name: "node", cwd: pid === process.pid ? process.cwd() : fixture.repo });
      const capture = async (_repo, args, launchOpts) => {
        launches += 1;
        payload = decodeFeatureCommandPayload(args.at(-1)).payload;
        if (row.detached) {
          ensureProcessLog(fixture);
          recordDetachedProcessEvidence(fixture.runDir, { runId: fixture.runId, executionId: launchOpts.executionId, pid: 9876, cwd: fixture.repo, logRef: "processes/behavior.log", inspectorFn });
          return { status: "started", pid: 9876 };
        }
        return { status: "completed", code: 0 };
      };
      try {
        const result = await row.invoke(fixture, {
          cwd: fixture.repo,
          inspectorFn,
          foregroundLaunchFn: capture,
          detachedLaunchFn: capture,
          recoverDisruptedRunFn: async () => ({ ok: true, run_dir: fixture.runDir, run_file: join(fixture.runDir, "run.json") }),
        });
        assert.equal(launches, 1);
        assert.equal(result.status, row.detached ? "started" : "completed");
        assert.deepEqual(payload, expectedOwnershipPayload(fixture.runId, row.driverMode, row.payloadKind));
        assert.equal(readJson(join(fixture.runDir, "run.json")).mode, row.durableMode);
        assert.equal(readFileSync(join(fixture.runDir, "run.json")).equals(runBytesBefore), true, "launch coordination must preserve durable run bytes");
      } finally {
        cleanup(fixture.repo);
      }
    });
  }

  for (const cleanupResult of [true, false]) {
    it(`${cleanupResult ? "releases before one spawn and starts" : "requires exact-token cleanup before reporting success"}`, async () => {
      const fixture = await createApprovedHandoffFixture(`handoff-cleanup-${cleanupResult}`);
      const inspectorFn = (pid) => ({ ok: true, inspector: "test-inspector", pid, start_marker: "test-start", command_name: "opencode", cwd: fixture.repo });
      let claim = null;
      let spawnCount = 0;
      let releaseCount = 0;
      const claimFns = {
        inspectLaunchClaimFn: () => ({ ok: false, missing: true }),
        acquireLaunchClaimFn: (_runDir, input) => {
          claim = { schema_version: 1, kind: "opencode-launch-claim", run_id: input.runId, execution_id: input.executionId, launch_kind: input.launchKind, approval: input.approval, phase: input.phase, pid: process.pid, hostname: "test", acquired_at: new Date().toISOString(), identity: { inspector: "test", start_marker: "start", command_name: "node", cwd: fixture.repo }, nonce: "opaque-cleanup-token-1234" };
          return { ok: true, acquired: true, claim, token: claim.nonce };
        },
        transitionLaunchClaimPhaseFn: (_runDir, token, phase) => {
          assert.equal(token, claim.nonce);
          claim = { ...claim, phase };
          return { ok: true, claim };
        },
        releaseLaunchClaimFn: (_runDir, token) => {
          releaseCount += 1;
          assert.equal(token, claim.nonce);
          return cleanupResult;
        },
      };
      try {
        const result = await transitionGateDecisionAndHandoff(fixture.runDir, "story", fixture.decision, {
          cwd: fixture.repo,
          ...claimFns,
          inspectorFn,
          handoffHooks: {
            beforeRelease: () => assert.equal(spawnCount, 0),
            afterRelease: () => assert.equal(spawnCount, 0),
          },
          detachedLaunchFn: async (_repo, _args, launchOpts) => {
            spawnCount += 1;
            mkdirSync(join(fixture.runDir, "processes"), { recursive: true });
            writeFileSync(join(fixture.runDir, "processes", "handoff.log"), "ready\n", "utf8");
            recordDetachedProcessEvidence(fixture.runDir, { runId: fixture.runId, executionId: launchOpts.executionId, pid: 9876, cwd: fixture.repo, logRef: "processes/handoff.log", inspectorFn });
            return { status: "started", pid: 9876 };
          },
        });
        assert.equal(spawnCount, 1);
        assert.equal(releaseCount, 1);
        assert.equal(result.gate_accepted, true);
        assert.equal(result.handoff.reason_code, cleanupResult ? "detached-shepherd-started" : "launch-evidence-mismatch");
        assert.equal(result.handoff.launch_claim_ref, cleanupResult ? null : "process-launch.lock/owner.json");
      } finally {
        cleanup(fixture.repo);
      }
    });
  }

  for (const entry of [
    { name: "resume interactive foreground", invoke: (fixture, opts) => resumeFactory(fixture.runId, opts) },
    { name: "resume headless foreground", invoke: (fixture, opts) => resumeFactory(fixture.runId, { ...opts, headless: true }) },
    { name: "resume autonomous foreground", invoke: (fixture, opts) => resumeFactory(fixture.runId, { ...opts, autonomous: true }) },
    { name: "resume detached", invoke: (fixture, opts) => resumeFactory(fixture.runId, { ...opts, detached: true, headless: true }), flags: {} },
    { name: "start-resume headless", invoke: (fixture, opts) => startFactory([`resume ${fixture.runId}`], { ...opts, headless: true }), flags: {} },
    { name: "start-resume autonomous", invoke: (fixture, opts) => startFactory([`resume ${fixture.runId}`], { ...opts, autonomous: true }) },
    { name: "start-resume headless detached", invoke: (fixture, opts) => startFactory([`resume ${fixture.runId}`], { ...opts, headless: true, detached: true }) },
    { name: "start-resume autonomous detached", invoke: (fixture, opts) => startFactory([`resume ${fixture.runId}`], { ...opts, autonomous: true, detached: true, headless: true }), flags: {} },
  ]) {
    it(`boundedly reconciles a contended ${entry.name} only after matching execution evidence`, async () => {
      const fixture = createFixture(`contended-${entry.name.replaceAll(" ", "-")}`);
      mkdirSync(join(fixture.runDir, "processes"), { recursive: true });
      const executionId = `execution-${entry.name.replaceAll(" ", "-")}`;
      let now = 0;
      let published = false;
      const inspectorFn = (pid) => ({ ok: true, inspector: "test-inspector", pid, start_marker: "test-start", command_name: "node", cwd: fixture.repo });
      try {
        const claim = acquireLaunchClaim(fixture.runDir, {
          runId: fixture.runId,
          executionId,
          launchKind: "resume-detached",
          phase: "spawning",
          pid: process.pid,
          cwd: fixture.repo,
        }, { inspectorFn });
        assert.equal(claim.acquired, true);
        const result = await entry.invoke(fixture, {
          cwd: fixture.repo,
          readyTimeoutMs: 100,
          clock: () => now,
          sleep: async (ms) => {
            if (!published) {
              published = true;
              writeFileSync(join(fixture.runDir, "processes", "matching.log"), "ready\n", "utf8");
              recordDetachedProcessEvidence(fixture.runDir, {
                runId: fixture.runId,
                executionId,
                pid: process.pid,
                cwd: fixture.repo,
                logRef: "processes/matching.log",
                inspectorFn,
              });
            }
            now += ms;
          },
          inspectorFn,
        });
        assert.equal(result.status, "already-running");
        assert.equal(result.execution_id, executionId);
        assert.equal(published, true);
      } finally {
        cleanup(fixture.repo);
      }
    });
  }

  it("preflights start-resume before seeding skills and refuses without launching", async () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-start-resume-preflight-"));
    try {
      const result = await startFactory(["resume missing-run"], { cwd: repo, json: true });
      assert.equal(result.ok, false);
      assert.match(result.terminal_result.reason, /missing run\.json/i);
      assert.equal(existsSync(join(repo, ".opencode", "skills", "feature", "SKILL.md")), false, "a refused start-resume must not seed skills");
    } finally {
      cleanup(repo);
    }
  });

  it("refuses start-resume against an active heartbeat without mutating durable state", async () => {
    const fixture = createFixture("start-resume-active-heartbeat", { mode: "interactive" });
    try {
      const runBytesBefore = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      writeJson(join(fixture.runDir, "heartbeat.json"), heartbeat(fixture.runId));

      const result = await startFactory([`resume ${fixture.runId}`], {
        cwd: fixture.repo,
        json: true,
        foregroundLaunchFn: async () => { throw new Error("must not launch"); },
        detachedLaunchFn: async () => { throw new Error("must not launch"); },
      });

      assert.equal(result.ok, false);
      assert.match(result.reason, /resume ineligible/i);
      assert.match(result.reason, /active-heartbeat/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), runBytesBefore, "a refused start-resume must not mutate run state");
      assert.equal(existsSync(join(fixture.repo, ".opencode", "skills", "feature", "SKILL.md")), false, "a refused start-resume must not seed skills");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("builds an exact dry-run resume payload with steering pointers and no raw text", async () => {
    const fixture = createFixture("resume-pointer");
    try {
      const queued = await writeSteering(fixture.runId, "raw steering should not leak", { cwd: fixture.repo, now: "2026-07-08T12:00:00.000Z" });
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, json: true, headless: true });

      assert.equal(result.status, "dry-run");
      assert.equal(result.eligible, true);
      assert.deepEqual(result.payload.resume, { schema_version: 1, kind: "existing-run-resume", run_id: fixture.runId });
      assert.equal(result.payload.driver.mode, "headless");
      assert.equal(result.payload.driver.ready, false);
      assert.equal(result.payload.driver.pr_mode, null);
      assert.equal(result.payload.steering.raw_message_included, false);
      assert.deepEqual(result.payload.steering.pending, queued.steering);
      assert.deepEqual(result.payload.steering.consume.args, ["factory", "steer-consume", fixture.runId, "--ref", queued.steering.ref, "--hash", queued.steering.hash, "--json"]);
      assert.equal(JSON.stringify(result.payload).includes("raw steering"), false);
      assert.equal(readdirSync(join(fixture.repo, ".opencode", "factory")).length, 1);
      assert.equal(readJson(join(fixture.runDir, "run.json")).run_id, fixture.runId);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("carries a persisted start PR mode override through resume payloads", async () => {
    const fixture = createFixture("resume-draft-pr-mode", { prMode: "draft" });
    try {
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, json: true, headless: true });

      assert.equal(result.status, "dry-run");
      assert.equal(result.payload.driver.ready, false);
      assert.equal(result.payload.driver.pr_mode, "draft");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("carries the exact persisted post-PR policy and rejects resume overrides", async () => {
    const policy = { enabled: true, wait_ms: 5400000, initial_poll_ms: 45000, max_poll_ms: 180000, check_start_grace_ms: 360000, max_transient_errors: 9, review: { required: false, reviewer_login: null, source: "none" } };
    const fixture = createFixture("resume-post-pr-policy", { postPrPolicy: policy });
    try {
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true });
      assert.deepEqual(result.payload.resume.post_pr_policy, policy);
      assert.equal(result.payload.driver.post_pr_ci, undefined);
      await assert.rejects(resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, postPrCi: true }), /rejects post-PR policy flags/u);
    } finally { cleanup(fixture.repo); }
  });

  it("routes consumed-but-uncheckpointed steering to archived-text redelivery on resume", async () => {
    const fixture = createFixture("resume-uncheckpointed");
    try {
      const queued = await writeSteering(fixture.runId, "redeliver only under the untrusted label", { cwd: fixture.repo, now: "2026-07-08T12:00:00.000Z" });
      const consumed = await consumeSteering(fixture.runId, queued.steering, { cwd: fixture.repo, now: "2026-07-08T12:01:00.000Z" });
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, json: true, headless: true });

      assert.equal(result.payload.steering.pending, null);
      assert.equal(result.payload.steering.uncheckpointed.ref, consumed.steering.ref);
      assert.deepEqual(result.payload.steering.consume.args, ["factory", "steer-consume", fixture.runId, "--ref", consumed.steering.ref, "--hash", consumed.steering.hash, "--json"]);
      assert.equal(JSON.stringify(result.payload).includes("redeliver only"), false);
      assert.equal(readdirSync(join(fixture.runDir, "steering")).filter((name) => name.startsWith("consumed-")).length, 1);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects fresh active heartbeat before resume spawn", async () => {
    const fixture = createFixture("resume-active-heartbeat");
    try {
      writeJson(join(fixture.runDir, "heartbeat.json"), heartbeat(fixture.runId));
      await assert.rejects(
        resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, processAliveFn: (pid) => pid === process.pid }),
        /active-heartbeat/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("record-resume locks and rejects active heartbeat before mutating debug snapshot", async () => {
    const fixture = createFixture("record-resume-active-heartbeat");
    try {
      const rawSteering = "raw active-heartbeat steering must remain pending";
      const queued = await writeSteering(fixture.runId, rawSteering, { cwd: fixture.repo, now: "2026-07-08T11:59:00.000Z" });
      writeJson(join(fixture.runDir, "heartbeat.json"), heartbeat(fixture.runId));
      const runBefore = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      const steeringBefore = snapshotSteeringFiles(fixture.runDir);
      const debugSnapshotBefore = readJson(join(fixture.runDir, "run.json")).debug_snapshot;
      let rejection;
      await assert.rejects(
        persistFactoryRunResumeEnv(fixture.runId, { cwd: fixture.repo, now: "2026-07-08T12:00:00.000Z", processAliveFn: (pid) => pid === process.pid }),
        (error) => {
          rejection = error;
          return /active-heartbeat/u.test(error.message);
        },
      );

      const runAfter = readJson(join(fixture.runDir, "run.json"));
      assert.equal(String(rejection).includes(rawSteering), false);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), runBefore);
      assert.deepEqual(runAfter.debug_snapshot, debugSnapshotBefore);
      assert.deepEqual(runAfter.steering.pending, queued.steering);
      assert.equal(runAfter.steering.history.at(-1).event, "queued");
      assert.deepEqual(snapshotSteeringFiles(fixture.runDir), steeringBefore);
      assert.equal(existsSync(join(fixture.runDir, queued.steering.ref)), true);
      assert.equal(Object.keys(steeringBefore).some((name) => name.startsWith("consumed-")), false);
      assert.equal(JSON.stringify(runAfter).includes(rawSteering), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects missing pending steering file before dry-run resume or record-resume mutation", async () => {
    const fixture = createFixture("resume-missing-steering");
    try {
      const queued = await writeSteering(fixture.runId, "steer me", { cwd: fixture.repo, now: "2026-07-08T12:00:00.000Z" });
      rmSync(join(fixture.runDir, queued.steering.ref));
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");

      await assert.rejects(
        resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, json: true }),
        /resume ineligible: invalid-run-state/u,
      );
      await assert.rejects(
        persistFactoryRunResumeEnv(fixture.runId, { cwd: fixture.repo, now: "2026-07-08T12:01:00.000Z" }),
        /record-resume requires resumable run: invalid-run-state/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects pending steering hash mismatch before dry-run resume or record-resume mutation", async () => {
    const fixture = createFixture("resume-bad-steering");
    try {
      const queued = await writeSteering(fixture.runId, "steer me", { cwd: fixture.repo, now: "2026-07-08T12:00:00.000Z" });
      writeFileSync(join(fixture.runDir, queued.steering.ref), "{}\n", "utf8");
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");

      await assert.rejects(
        resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, json: true }),
        /resume ineligible: invalid-run-state/u,
      );
      await assert.rejects(
        persistFactoryRunResumeEnv(fixture.runId, { cwd: fixture.repo, now: "2026-07-08T12:01:00.000Z" }),
        /record-resume requires resumable run: invalid-run-state/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });
});

function createFixture(runId, { prMode, mode, postPrPolicy } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "factory-resume-"));
  const runDir = join(repo, ".opencode", "factory", runId);
  const worktree = join(repo, ".opencode", "worktrees", runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const run = {
    schema_version: 1,
    run_id: runId,
    status: "running",
    branch: runId,
    worktree,
    gates: {},
    slices: [{ id: "slice", status: "running", attempts: 1, branch: runId, worktree }],
  };
  if (prMode !== undefined) run.pr_mode = prMode;
  if (mode !== undefined) run.mode = mode;
  if (postPrPolicy) run.post_pr = { schema_version: 1, policy: postPrPolicy, phase: "awaiting-pr", attempt: 0, observation: null, remediation: null, evidence_refs: [], continuation_review: null, terminal_fact: null };
  writeJson(join(runDir, "run.json"), run);
  return { repo, runDir, runId, worktree };
}

function expectedOwnershipPayload(runId, driverMode, payloadKind) {
  const expected = {
    operator_request: `resume ${runId}`,
    driver: {
      mode: driverMode,
      ready: false,
      pr_mode: null,
      reviewer: null,
      github_account: null,
      run_id: null,
      post_pr_ci: null,
    },
    resume: null,
    steering: null,
    continuation: null,
  };
  if (payloadKind === "resume") {
    expected.resume = { schema_version: 1, kind: "existing-run-resume", run_id: runId };
    expected.steering = {
      schema_version: 1,
      kind: "operator-steering-pointer",
      run_id: runId,
      pending: null,
      uncheckpointed: null,
      consume: null,
      raw_message_included: false,
    };
  }
  return expected;
}

async function createApprovedHandoffFixture(runId) {
  const fixture = createFixture(runId);
  mkdirSync(join(fixture.runDir, "artifacts"), { recursive: true });
  mkdirSync(join(fixture.runDir, "gates"), { recursive: true });
  writeFileSync(join(fixture.runDir, "artifacts", "story.md"), "story\n", "utf8");
  writeFileSync(join(fixture.runDir, "gates", "story.question.md"), "approve?\n", "utf8");
  const run = readJson(join(fixture.runDir, "run.json"));
  run.mode = "interactive";
  writeJson(join(fixture.runDir, "run.json"), run);
  await transitionGateDecision(fixture.runDir, "story", { status: "pending", artifact: "artifacts/story.md", question_ref: "gates/story.question.md" });
  const boundary = await transitionSteeringBoundaryOpened(fixture.runDir, "gate");
  const accepted = await transitionGateDecision(fixture.runDir, "story", { status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer: "approve" }, { boundaryToken: boundary.boundary.token });
  return { ...fixture, run: accepted.run, decision: { status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer: "approve" } };
}

function mutateRun(fixture, mutator) {
  const run = readJson(join(fixture.runDir, "run.json"));
  mutator(run);
  writeJson(join(fixture.runDir, "run.json"), run);
}

function processIdentity() {
  return { inspector: "test-inspector", start_marker: "test-start", command_name: "opencode" };
}

function ensureProcessLog(fixture) {
  mkdirSync(join(fixture.runDir, "processes"), { recursive: true });
  writeFileSync(join(fixture.runDir, "processes", "behavior.log"), "evidence\n", "utf8");
}

function writeRunningEvidence(fixture, executionId, overrides = {}) {
  ensureProcessLog(fixture);
  const now = new Date().toISOString();
  writeProcessEvidence(fixture.runDir, {
    schema_version: 1, kind: "opencode-process", run_id: fixture.runId, execution_id: executionId, pid: 9876,
    started_at: now, updated_at: now, state: "running", cwd: fixture.repo, identity: processIdentity(), log_ref: "processes/behavior.log", cancel: null, ...overrides,
  });
}

function writeStoppedEvidence(fixture, state) {
  ensureProcessLog(fixture);
  const now = new Date().toISOString();
  writeProcessEvidence(fixture.runDir, {
    schema_version: 1, kind: "opencode-process", run_id: fixture.runId, execution_id: `exec-${state}`, pid: 9876,
    started_at: now, updated_at: now, state, cwd: fixture.repo, identity: processIdentity(), log_ref: "processes/behavior.log",
    cancel: state === "cancelled" ? { requested_at: now, signal: "SIGTERM", confirmed_at: now, result: "cancelled", reason: null } : null,
  });
}

function fakeClaim(fixture, overrides = {}) {
  return {
    schema_version: 1, kind: "opencode-launch-claim", run_id: fixture.runId, execution_id: "claim-execution", launch_kind: "approval-handoff",
    phase: "spawning", pid: process.pid, hostname: "test-host", acquired_at: new Date().toISOString(),
    identity: { inspector: "test-inspector", start_marker: "test-start", command_name: "node", cwd: fixture.repo }, approval: null,
    nonce: "opaque-behavior-token-1234", ...overrides,
  };
}

function writeClaim(fixture, overrides = {}) {
  mkdirSync(join(fixture.runDir, "process-launch.lock"));
  writeJson(join(fixture.runDir, "process-launch.lock", "owner.json"), fakeClaim(fixture, overrides));
}

function fakeLaunchOptions(fixture, options = {}) {
  let claim = null;
  const metrics = { spawnAttempts: 0, signalAttempts: 0, releaseAttempts: 0, sleepCalls: [], now: 0, claimBytes: null, processBytes: null };
  const inspectorFn = (pid) => ({ ok: true, inspector: "test-inspector", pid, start_marker: "test-start", command_name: "node", cwd: fixture.repo });
  return {
    metrics,
    inspectLaunchClaimFn: () => ({ ok: false, missing: true }),
    acquireLaunchClaimFn: (_runDir, input) => {
      const acquired = acquireLaunchClaim(_runDir, { ...input, nonce: "opaque-behavior-token-1234" }, { inspectorFn });
      claim = acquired.claim;
      return acquired;
    },
    transitionLaunchClaimPhaseFn: (_runDir, _token, phase) => {
      if (phase === options.transitionFailure) {
        metrics.claimBytes = readFileSync(join(_runDir, "process-launch.lock", "owner.json"));
        throw new Error("injected transition failure");
      }
      const transitioned = transitionLaunchClaimPhase(_runDir, _token, phase, {}, { expectedPhase: claim.phase, inspectorFn });
      claim = transitioned.claim;
      metrics.claimBytes = readFileSync(join(_runDir, "process-launch.lock", "owner.json"));
      return transitioned;
    },
    releaseLaunchClaimFn: () => { metrics.releaseAttempts += 1; return true; },
    detachedLaunchFn: async (_repo, _args, launchOpts) => {
      if (options.transitionFailure) assert.fail("launch must not occur before cooperative release succeeds");
      metrics.spawnAttempts += 1;
      assert.equal(metrics.spawnAttempts, 1, "handoff must not retry launch");
      assert.equal(_args.some((arg) => String(arg).includes("merge")), false, "handoff must not invoke merge");
      if (options.launchError && !/readiness/iu.test(options.launchError)) throw new Error(options.launchError);
      if (/readiness/iu.test(options.launchError || "")) return { status: "started", pid: 9876 };
      ensureProcessLog(fixture);
      const inspectorFn = (pid) => ({ ok: true, inspector: "test-inspector", pid, start_marker: "test-start", command_name: "opencode", cwd: fixture.repo });
      recordDetachedProcessEvidence(fixture.runDir, {
        runId: fixture.runId, executionId: options.mismatchedEvidence ? "different-execution" : launchOpts.executionId,
        pid: 9876, cwd: fixture.repo, logRef: "processes/behavior.log", inspectorFn,
      });
      metrics.processBytes = readFileSync(join(fixture.runDir, "process.json"));
      return { status: "started", pid: 9876 };
    },
    readyTimeoutMs: 100,
    clock: () => metrics.now,
    sleep: async (ms) => { metrics.sleepCalls.push(ms); metrics.now += ms; },
    processSignalFn: () => { metrics.signalAttempts += 1; },
    inspectorFn,
  };
}

const BEHAVIOR_ROWS = {
  "matching-detached-shepherd-live": ["already-running", true, "A matching detached interactive shepherd is already running.", "watch"],
  "run-mode-not-interactive": ["manual", false, "The durable run mode is not interactive; the external driver remains responsible for continuation.", "external-driver-continues"],
  "protected-gate-pending": ["paused-at-protected-gate", false, "The run is paused at a protected gate awaiting an explicit answer.", "answer-protected-gate"],
  "terminal-run": ["terminal", false, "The run is already terminal; inspect the durable terminal result.", "inspect-terminal-result"],
  "validated-cancelled": ["stopped", false, "Validated process evidence shows that the detached shepherd is cancelled.", "confirm-cancellation"],
  "cancel-pending": ["stopped", false, "Cancellation is pending for the validated detached shepherd.", "confirm-cancellation"],
  "approval-snapshot-mismatch": ["recovery-required", false, "The accepted approval no longer matches its durable pending-gate snapshot.", "run-resume-check"],
  "steering-generation-mismatch": ["recovery-required", false, "The steering generation changed after the approval was accepted.", "run-resume-check"],
  "steering-state-not-clean": ["recovery-required", false, "Pending or uncheckpointed steering prevents automatic continuation.", "run-resume-check"],
  "resume-ineligible": ["recovery-required", false, "The run is not eligible for detached continuation.", "run-resume-check"],
  "launch-claim-invalid": ["recovery-required", false, "The preserved launch claim is invalid and requires manual ownership reconciliation.", "manual-ownership-reconciliation"],
  "launch-owner-indeterminate": ["recovery-required", false, "The preserved launch claim owner cannot be safely proven live or absent.", "manual-ownership-reconciliation"],
  "launch-claim-conflict": ["recovery-required", false, "Another launch claim conflicts with this execution and ownership is ambiguous.", "manual-ownership-reconciliation"],
  "process-evidence-invalid": ["recovery-required", false, "Detached process evidence is invalid; preserve it and reconcile ownership manually.", "manual-ownership-reconciliation"],
  "process-identity-mismatch": ["recovery-required", false, "Recorded detached process identity does not match live inspection; preserve the evidence and reconcile ownership manually.", "manual-ownership-reconciliation"],
  "prior-process-stopped": ["recovery-required", false, "Prior process evidence is stopped or failed-closed; automatic relaunch is forbidden until manual reconciliation.", "manual-ownership-reconciliation"],
  "claim-acquisition-failed": ["recovery-required", false, "The launch claim could not be acquired and no safe ownership decision was possible.", "manual-ownership-reconciliation"],
  "foreground-release-failed": ["recovery-required", false, "The foreground predecessor could not be durably released, so ownership remains ambiguous.", "manual-ownership-reconciliation"],
  "launch-spawn-failed": ["recovery-required", false, "Detached launch failed after predecessor release; process ownership is ambiguous.", "manual-ownership-reconciliation"],
  "launch-readiness-failed": ["recovery-required", false, "Detached launch did not produce matching readiness evidence within the bounded wait.", "manual-ownership-reconciliation"],
  "launch-evidence-mismatch": ["recovery-required", false, "Published detached process evidence does not match the launch claim execution.", "manual-ownership-reconciliation"],
};

function completedTerminalResult(runId) {
  return {
    status: "completed",
    run_id: runId,
    pr_url: "https://github.com/jasoncarreira/opencode-feature-factory/pull/1",
    pr_number: 1,
    repository: "jasoncarreira/opencode-feature-factory",
    draft: false,
    reason: null,
    summary: "done",
    artifacts: {},
  };
}

function assertBehaviorHandoff(handoff, code, runId) {
  const [status, automatic, reason, action] = BEHAVIOR_ROWS[code];
  assert.equal(handoff.reason_code, code);
  assert.equal(handoff.status, status);
  assert.equal(handoff.automatic, automatic);
  assert.equal(handoff.reason, reason);
  assert.equal(handoff.action, action);
  assert.equal(handoff.run_id, runId);
  const live = code === "matching-detached-shepherd-live";
  assert.equal(handoff.pid, live ? 9876 : null);
  assert.equal(handoff.process_ref, live ? "process.json" : null);
  assert.equal(handoff.log, live ? "processes/behavior.log" : null);
  assert.equal(handoff.status_command, `feature-factory factory status ${runId} --json`);
  assert.equal(handoff.watch_command, `feature-factory factory watch ${runId}`);
  assert.equal(handoff.action_command, action === "watch" ? `feature-factory factory watch ${runId}` : action === "run-resume-check" ? `feature-factory factory resume-check ${runId} --json` : action === "inspect-terminal-result" ? `feature-factory factory status ${runId} --json` : action === "confirm-cancellation" ? (code === "cancel-pending" ? `feature-factory factory cancel ${runId} --json` : `feature-factory factory status ${runId} --json`) : null);
  assert.equal(handoff.recovery_command, action === "run-resume-check" ? `feature-factory factory resume-check ${runId} --json` : null);
  const claimExpected = ["launch-claim-invalid", "launch-owner-indeterminate", "launch-claim-conflict", "foreground-release-failed", "launch-spawn-failed", "launch-readiness-failed", "launch-evidence-mismatch"].includes(code);
  assert.equal(handoff.launch_claim_ref, claimExpected ? "process-launch.lock/owner.json" : null);
}

function snapshotSidecars(runDir) {
  const refs = ["process-launch.lock/owner.json", "process.json", "heartbeat.json"];
  return Object.fromEntries(refs.filter((ref) => existsSync(join(runDir, ref))).map((ref) => [ref, readFileSync(join(runDir, ref), "utf8")]));
}

function assertPreservedOriginalSidecars(runDir, snapshot) {
  for (const [ref, bytes] of Object.entries(snapshot)) assert.equal(readFileSync(join(runDir, ref), "utf8"), bytes, `${ref} must be byte-identical`);
}

function heartbeat(runId) {
  return {
    schema_version: 1,
    run_id: runId,
    phase: "builder-wave",
    pid: process.pid,
    interval_ms: 30000,
    last_tick_at: new Date().toISOString(),
  };
}

function snapshotSteeringFiles(runDir) {
  const steeringDir = join(runDir, "steering");
  return Object.fromEntries(readdirSync(steeringDir).sort().map((name) => [name, readFileSync(join(steeringDir, name), "utf8")]));
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
