import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeSteering, persistFactoryRunResumeEnv, resumeFactory, writeSteering } from "../src/factory.js";

describe("factory resume", () => {
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

function createFixture(runId, { prMode, postPrPolicy } = {}) {
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
  if (postPrPolicy) run.post_pr = { schema_version: 1, policy: postPrPolicy, phase: "awaiting-pr", attempt: 0, observation: null, remediation: null, evidence_refs: [], continuation_review: null, terminal_fact: null };
  writeJson(join(runDir, "run.json"), run);
  return { repo, runDir, runId, worktree };
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
