import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistFactoryRunCreatedEnv, persistFactoryRunResumeEnv, startHeartbeat, stopHeartbeat, writeSteering } from "../src/factory.js";
import {
  heartbeatOnce,
  transitionCostUsage,
  transitionPrePrFenceEstablished,
  transitionPrCreated,
  transitionRunJson,
  transitionSteeringAcknowledged,
  transitionSteeringActionAborted,
  transitionSteeringActionStarted,
  transitionSteeringBoundaryCrossed,
  transitionSteeringBoundaryOpened,
  transitionSteeringConsumed,
  transitionSteeringQueued,
  transitionTerminalResult,
} from "../src/run-state.js";

const NOW = "2026-07-10T12:00:00.000Z";
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
      assert.equal(claim.kind, "dispatch");
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
      cleanup(fixture.repo);
    }
  });

  it("rejects direct, pending, uncheckpointed, and stale terminal/dispatch/remediation crossings", async () => {
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
      await assert.rejects(startHeartbeat(fixture.runId, { phase: "builder-wave" }, { cwd: fixture.repo }), /awaiting acknowledgement/u);

      await transitionSteeringAcknowledged(fixture.runDir, consumed.steering, { now: "2026-07-10T12:02:00.000Z" });
      const opened = await transitionSteeringBoundaryOpened(fixture.runDir, "dispatch", { now: "2026-07-10T12:03:00.000Z", token: "dispatch-token-1" });
      await transitionRunJson(fixture.runDir, (run) => { run.updated_at = "2026-07-10T12:04:00.000Z"; });
      await assert.rejects(
        transitionSteeringBoundaryCrossed(fixture.runDir, "dispatch", opened.boundary.token),
        /observation is stale/u,
      );

      const remediation = await transitionSteeringBoundaryOpened(fixture.runDir, "remediation", { token: "remediation-token-1" });
      const crossed = await transitionSteeringBoundaryCrossed(fixture.runDir, "remediation", remediation.boundary.token);
      assert.equal(crossed.action_claim.kind, "remediation");
      await transitionSteeringActionStarted(fixture.runDir, "remediation", crossed.action_claim.token);
    } finally {
      cleanup(fixture.repo);
    }
  });

  for (const kind of ["dispatch", "remediation"]) {
    it(`retains the ${kind} claim through action start and supports explicit recovery`, async () => {
      const fixture = createFixture(`action-claim-${kind}`);
      try {
        const opened = await transitionSteeringBoundaryOpened(fixture.runDir, kind, { token: `${kind}-action-token` });
        const crossed = await transitionSteeringBoundaryCrossed(fixture.runDir, kind, opened.boundary.token);
        assert.equal(readJson(join(fixture.runDir, "run.json")).steering.action_claim.token, crossed.action_claim.token);
        await assert.rejects(transitionSteeringQueued(fixture.runDir, "queue before action start"), /awaiting start acknowledgement/u);
        await assert.rejects(transitionRunJson(fixture.runDir, (run) => { run.updated_at = NOW; }), /action start acknowledgement is pending/u);
        await startHeartbeat(fixture.runId, { phase: `${kind}-wait`, intervalMs: 1000 }, { cwd: fixture.repo, now: "2026-07-10T12:05:00.000Z" });
        assert.equal(readJson(join(fixture.runDir, "run.json")).steering.action_claim.token, crossed.action_claim.token, "heartbeat start must preserve the action claim");

        if (kind === "dispatch") {
          await assert.rejects(transitionSteeringActionStarted(fixture.runDir, kind, "wrong-action-token"), /token mismatch/u);
          const started = await transitionSteeringActionStarted(fixture.runDir, kind, crossed.action_claim.token);
          assert.equal(started.action.outcome, "started");
          await stopHeartbeat(fixture.runId, {}, { cwd: fixture.repo });
        } else {
          await assert.rejects(
            transitionSteeringActionAborted(fixture.runDir, kind, crossed.action_claim.token, { now: "2026-07-10T12:05:01.000Z" }),
            /active-heartbeat/u,
          );
          await stopHeartbeat(fixture.runId, {}, { cwd: fixture.repo, now: "2026-07-10T12:05:02.000Z" });
          const aborted = await transitionSteeringActionAborted(fixture.runDir, kind, crossed.action_claim.token);
          assert.equal(aborted.action.outcome, "aborted");
        }

        const queued = await transitionSteeringQueued(fixture.runDir, "queue after durable resolution", { id: `${kind}-after` });
        assert.equal(queued.steering.id, `${kind}-after`);
        assert.equal(queued.run.steering.action_claim, null);
      } finally {
        cleanup(fixture.repo);
      }
    });
  }

  it("serializes a queue race with boundary observation so no stale token can cross", async () => {
    const fixture = createFixture("boundary-race");
    try {
      const [boundaryResult, queueResult] = await Promise.allSettled([
        transitionSteeringBoundaryOpened(fixture.runDir, "dispatch", { token: "dispatch-race-token" }),
        transitionSteeringQueued(fixture.runDir, "race steering", { id: "race" }),
      ]);
      assert.equal(queueResult.status, "fulfilled");
      const run = readJson(join(fixture.runDir, "run.json"));
      assert.ok(run.steering.pending);
      assert.equal(run.steering.boundary, null);
      if (boundaryResult.status === "fulfilled") {
        await assert.rejects(
          transitionSteeringBoundaryCrossed(fixture.runDir, "dispatch", boundaryResult.value.boundary.token),
          /pending steering|lock-protected boundary observation/u,
        );
      } else {
        assert.match(boundaryResult.reason.message, /pending steering/u);
      }
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("fences PR creation against steering and rejects missing, mismatched, and stale fences", async () => {
    const missing = createReadyPrFixture("pr-fence-missing");
    try {
      await assert.rejects(transitionPrCreated(missing.runDir, prInput()), /active pre-PR fence/u);
    } finally {
      cleanup(missing.repo);
    }

    const fenced = createReadyPrFixture("pr-fence-active");
    try {
      const established = await transitionPrePrFenceEstablished(fenced.runDir, { token: "pre-pr-fence-token" });
      await assert.rejects(writeSteering(fenced.runId, "late steering", { cwd: fenced.repo }), /active pre-PR fence/u);
      await assert.rejects(transitionRunJson(fenced.runDir, (run) => { run.updated_at = NOW; }), /active pre-PR fence/u);
      await assert.rejects(transitionPrCreated(fenced.runDir, prInput(), { fenceToken: "wrong-fence-token" }), /token mismatch/u);
      const completed = await transitionPrCreated(fenced.runDir, prInput(), { fenceToken: established.fence.token });
      assert.equal(completed.run.status, "completed");
    } finally {
      cleanup(fenced.repo);
    }

    const stale = createReadyPrFixture("pr-fence-stale");
    try {
      const established = await transitionPrePrFenceEstablished(stale.runDir, { token: "stale-fence-token" });
      const runPath = join(stale.runDir, "run.json");
      writeJson(runPath, { ...readJson(runPath), updated_at: "2026-07-10T12:05:00.000Z" });
      await assert.rejects(transitionPrCreated(stale.runDir, prInput(), { fenceToken: established.fence.token }), /fence is stale/u);
    } finally {
      cleanup(stale.repo);
    }
  });

  it("holds a pre-PR fence across sibling run writers without hash churn and remains recoverable", async () => {
    const fixture = createReadyPrFixture("pr-fence-writers");
    try {
      const established = await transitionPrePrFenceEstablished(fixture.runDir, { token: "writer-fence-token" });
      const runPath = join(fixture.runDir, "run.json");
      const fencedBytes = readFileSync(runPath, "utf8");

      const rejected = [
        () => transitionRunJson(fixture.runDir, (run) => { run.updated_at = NOW; }),
        () => transitionCostUsage(fixture.runDir, { agent: "validator", total_tokens: 1 }),
        () => heartbeatOnce(fixture.runDir, { now: Date.parse(NOW) }),
        () => startHeartbeat(fixture.runId, { phase: "builder-wave" }, { cwd: fixture.repo }),
        () => persistFactoryRunCreatedEnv(fixture.runId, { cwd: fixture.repo, now: NOW }),
        () => persistFactoryRunResumeEnv(fixture.runId, { cwd: fixture.repo, now: NOW }),
      ];
      for (const writer of rejected) {
        await assert.rejects(writer(), /active pre-PR fence/u);
        assert.equal(readFileSync(runPath, "utf8"), fencedBytes);
      }

      assert.equal(await stopHeartbeat(fixture.runId, {}, { cwd: fixture.repo }), null);
      assert.equal(readFileSync(runPath, "utf8"), fencedBytes, "heartbeat stop must not write run.json or invalidate the fence");
      const completed = await transitionPrCreated(fixture.runDir, prInput(), { fenceToken: established.fence.token });
      assert.equal(completed.run.status, "completed");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("clears an exact stale fence for recovery when no external PR was created", async () => {
    const fixture = createReadyPrFixture("pr-fence-clear-recovery");
    try {
      const established = await transitionPrePrFenceEstablished(fixture.runDir, { token: "recover-fence-token" });
      const runPath = join(fixture.runDir, "run.json");
      writeJson(runPath, { ...readJson(runPath), updated_at: "2026-07-10T12:05:00.000Z" });
      await assert.rejects(transitionPrCreated(fixture.runDir, prInput(), { fenceToken: established.fence.token }), /fence is stale/u);
      const cleared = runCli(fixture.repo, ["factory", "pr-fence", fixture.runId, "--clear", "--fence-token", established.fence.token, "--json"]);
      assert.equal(cleared.status, 0, cleared.stderr);
      assert.equal(JSON.parse(cleared.stdout).fence, null);
      const queued = await transitionSteeringQueued(fixture.runDir, "recovered after failed PR start", { id: "post-clear" });
      assert.equal(queued.steering.id, "post-clear");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("serializes pre-PR fence and steering queue races without allowing both", async () => {
    const fixture = createReadyPrFixture("pr-fence-race");
    try {
      const results = await Promise.allSettled([
        transitionPrePrFenceEstablished(fixture.runDir, { token: "race-fence-token" }),
        transitionSteeringQueued(fixture.runDir, "late race steering", { id: "late-race" }),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const run = readJson(join(fixture.runDir, "run.json"));
      assert.notEqual(Boolean(run.steering?.pending), Boolean(run.steering?.pr_fence));
    } finally {
      cleanup(fixture.repo);
    }
  });
});

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
  return { repo, runDir, runId };
}

function createReadyPrFixture(runId) {
  const fixture = createFixture(runId);
  for (const dir of ["artifacts", "reviews"]) mkdirSync(join(fixture.runDir, dir), { recursive: true });
  writeFileSync(join(fixture.runDir, "artifacts", "validation-report.md"), "GO\n", "utf8");
  writeJson(join(fixture.runDir, "reviews", "implementation-validator.json"), { subject: "feature", verdict: "GO" });
  writeJson(join(fixture.runDir, "reviews", "security-reviewer.json"), { subject: "feature", verdict: "PASS" });
  writeJson(join(fixture.runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    status: "running",
    gates: { pre_pr: { status: "approved", artifact: "artifacts/validation-report.md", question_ref: "gates/pre_pr.question.md", answer: "approve", answered_at: NOW } },
    slices: [{ id: "slice", status: "merged", attempts: 1, merge_commit: "abc123" }],
    validator: { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" },
    security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" },
  });
  return fixture;
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

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}

function runCli(repo, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8", timeout: 15000 });
}
