import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeSteering, handoffApprovedInteractiveRun, persistFactoryRunResumeEnv, resumeFactory, startFactory, writeSteering } from "../src/factory.js";
import { acquireLaunchClaim, recordDetachedProcessEvidence } from "../src/process-evidence.js";
import { transitionGateDecision, transitionSteeringBoundaryOpened } from "../src/run-state.js";

describe("factory resume", () => {
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
        const result = await handoffApprovedInteractiveRun(fixture.runDir, fixture.run, "story", {
          repo: fixture.repo,
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
        assert.equal(result.reason_code, cleanupResult ? "detached-shepherd-started" : "launch-evidence-mismatch");
        assert.equal(result.launch_claim_ref, cleanupResult ? null : "process-launch.lock/owner.json");
      } finally {
        cleanup(fixture.repo);
      }
    });
  }

  for (const entry of [
    { name: "resume foreground", invoke: (fixture, opts) => resumeFactory(fixture.runId, opts), flags: {} },
    { name: "resume detached", invoke: (fixture, opts) => resumeFactory(fixture.runId, { ...opts, detached: true, headless: true }), flags: {} },
    { name: "start-resume headless", invoke: (fixture, opts) => startFactory([`resume ${fixture.runId}`], { ...opts, headless: true }), flags: {} },
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

function createFixture(runId, { prMode } = {}) {
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
  writeJson(join(runDir, "run.json"), run);
  return { repo, runDir, runId, worktree };
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
  return { ...fixture, run: accepted.run };
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
