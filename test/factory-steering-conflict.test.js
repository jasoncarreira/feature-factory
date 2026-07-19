import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFile } from "../src/refs.js";
import { createSliceAttemptReview, createSliceReviewRecord } from "./helpers/review-record-fixture.js";
import { transitionSteeringAcknowledged, transitionSteeringConflict, transitionSteeringConsumed, transitionSteeringQueued } from "../src/run-state.js";
import { collectProtectedSteeringState } from "../src/steering-conflicts.js";
import { validateRunDir } from "../src/validate.js";

const NOW = "2026-07-09T12:00:00.000Z";

describe("factory steering conflict transition", () => {
  it("records a terminal needs-human conflict without rolling back accepted durable state", async () => {
    const fixture = createFixture("steering-conflict", { durable: true });
    try {
      const queued = await transitionSteeringQueued(fixture.runDir, "roll back accepted work and redo the merged slice", { now: NOW, id: "operator" });
      const consumed = await transitionSteeringConsumed(fixture.runDir, { ref: queued.steering.ref, hash: queued.steering.hash }, { now: "2026-07-09T12:01:00.000Z" });
      const beforeRun = readJson(join(fixture.runDir, "run.json"));
      const durableFilesBefore = snapshotDurableFiles(fixture.runDir);

      assert.deepEqual(collectProtectedSteeringState(fixture.runDir, beforeRun), [
        "gate:story",
        "gate:pre_pr",
        "step:spec-writer",
        "step:test-verifier",
        "slice:be-api",
        "slice:be-docs",
        "validator:GO-WITH-NITS",
        "security_review:PASS",
        "pr_url",
      ]);

      const result = await transitionSteeringConflict(
        fixture.runDir,
        { ref: consumed.steering.ref, hash: consumed.steering.hash, reason: "operator requested rollback" },
        { now: "2026-07-09T12:02:00.000Z" },
      );
      const afterRun = readJson(join(fixture.runDir, "run.json"));

      assert.equal(result.ok, false);
      assert.equal(result.conflict, true);
      assert.equal(result.run_id, fixture.runId);
      assert.equal(result.status, "needs-human");
      assert.equal(afterRun.status, "needs-human");
      assert.deepEqual(result.protected_state, [
        "gate:story",
        "gate:pre_pr",
        "step:spec-writer",
        "step:test-verifier",
        "slice:be-api",
        "slice:be-docs",
        "validator:GO-WITH-NITS",
        "security_review:PASS",
        "pr_url",
      ]);
      assert.equal(afterRun.terminal_result.status, "needs-human");
      assert.equal(afterRun.terminal_result.run_id, fixture.runId);
      assert.equal(afterRun.terminal_result.pr_url, "https://github.com/acme/project/pull/123");
      assert.equal(afterRun.terminal_result.reason, `operator steering conflicts with accepted durable state: steering=${consumed.steering.ref}; protected=gate:story,gate:pre_pr,step:spec-writer,step:test-verifier,slice:be-api,slice:be-docs,validator:GO-WITH-NITS,security_review:PASS,pr_url; automatic rollback is forbidden`);
      assert.equal(afterRun.terminal_result.summary, "Consumed untrusted steering would require changing accepted durable state; human reconciliation is required.");
      assert.deepEqual(afterRun.terminal_result.artifacts, {});
      assert.deepEqual(result.steering, { ref: consumed.steering.ref, hash: consumed.steering.hash });
      assert.equal(afterRun.steering.history.at(-1).ref, consumed.steering.ref);
      assert.equal(afterRun.steering.history.at(-1).hash, consumed.steering.hash);

      assert.deepEqual(afterRun, {
        ...beforeRun,
        status: "needs-human",
        steering: { ...beforeRun.steering, generation: beforeRun.steering.generation + 1, uncheckpointed: null },
        terminal_result: afterRun.terminal_result,
      });
      assert.deepEqual(snapshotDurableFiles(fixture.runDir), durableFilesBefore);
      const validation = validateRunDir(fixture.runDir);
      assert.equal(validation.ok, true, JSON.stringify(validation.checks.filter((check) => !check.ok)));
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects active heartbeat and terminal run conflicts without run.json mutation", async () => {
    const heartbeatFixture = createFixture("steering-conflict-heartbeat");
    try {
      const consumed = await queueAndConsume(heartbeatFixture.runDir);
      const before = readFileSync(join(heartbeatFixture.runDir, "run.json"), "utf8");
      writeJson(join(heartbeatFixture.runDir, "heartbeat.json"), {
        schema_version: 1,
        run_id: heartbeatFixture.runId,
        phase: "builder-wave",
        pid: 4242,
        interval_ms: 30000,
        last_tick_at: "2026-07-09T12:01:30.000Z",
      });

      await assert.rejects(
        transitionSteeringConflict(heartbeatFixture.runDir, { ref: consumed.ref, hash: consumed.hash }, {
          now: "2026-07-09T12:02:00.000Z",
          processAliveFn: (pid) => pid === 4242,
        }),
        /active-heartbeat/u,
      );
      assert.equal(readFileSync(join(heartbeatFixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(heartbeatFixture.repo);
    }

    const terminalFixture = createFixture("steering-conflict-terminal");
    try {
      const consumed = await queueAndConsume(terminalFixture.runDir);
      const terminal = {
        ...readJson(join(terminalFixture.runDir, "run.json")),
        status: "blocked",
        terminal_result: { status: "blocked", run_id: terminalFixture.runId, reason: "already blocked" },
      };
      writeJson(join(terminalFixture.runDir, "run.json"), terminal);
      const before = readFileSync(join(terminalFixture.runDir, "run.json"), "utf8");

      await assert.rejects(
        transitionSteeringConflict(terminalFixture.runDir, { ref: consumed.ref, hash: consumed.hash }),
        /terminal run 'blocked'/u,
      );
      assert.equal(readFileSync(join(terminalFixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(terminalFixture.repo);
    }
  });

  it("rejects stale refs, bad hashes, and mismatched consumed files without run.json mutation", async () => {
    const fixture = createFixture("steering-conflict-ref-hash");
    try {
      const first = await queueAndConsume(fixture.runDir, "first steering", "first");
      await transitionSteeringAcknowledged(fixture.runDir, first);
      const second = await queueAndConsume(fixture.runDir, "second steering", "second");
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");

      await assert.rejects(
        transitionSteeringConflict(fixture.runDir, { ref: first.ref, hash: first.hash }),
        /uncheckpointed steering ref\/hash mismatch/u,
      );
      await assert.rejects(
        transitionSteeringConflict(fixture.runDir, { ref: second.ref, hash: `sha256:${"0".repeat(64)}` }),
        /uncheckpointed steering ref\/hash mismatch/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);

      writeFileSync(join(fixture.runDir, second.ref), "tampered\n", "utf8");
      await assert.rejects(
        transitionSteeringConflict(fixture.runDir, { ref: second.ref, hash: second.hash }),
        /consumed steering file hash mismatch/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects conflicts before any steering has been consumed", async () => {
    const fixture = createFixture("steering-conflict-no-consumed");
    try {
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      await assert.rejects(
        transitionSteeringConflict(fixture.runDir, { ref: "steering/consumed-missing.json", hash: `sha256:${"1".repeat(64)}` }),
        /no uncheckpointed steering/u,
      );
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });
});

async function queueAndConsume(runDir, message = "rollback accepted state", id = "operator") {
  const queued = await transitionSteeringQueued(runDir, message, { now: NOW, id });
  const consumed = await transitionSteeringConsumed(runDir, { ref: queued.steering.ref, hash: queued.steering.hash }, { now: "2026-07-09T12:01:00.000Z" });
  return { ref: consumed.steering.ref, hash: consumed.steering.hash };
}

function createFixture(runId, { durable = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "factory-steering-conflict-"));
  const runDir = join(repo, ".opencode", "factory", runId);
  for (const dir of ["artifacts", "gates", "evidence", "reviews", "plan", "steering"]) mkdirSync(join(runDir, dir), { recursive: true });
  if (durable) writeDurableFilesAndRun(runDir, runId);
  else writeJson(join(runDir, "run.json"), { schema_version: 1, run_id: runId, status: "running", gates: {}, slices: [] });
  return { repo, runDir, runId };
}

function writeDurableFilesAndRun(runDir, runId) {
  const reviewedCommit = "a".repeat(40);
  writeFileSync(join(runDir, "artifacts", "story.md"), "approved story\n", "utf8");
  writeFileSync(join(runDir, "artifacts", "brief.md"), "accepted brief\n", "utf8");
  writeFileSync(join(runDir, "artifacts", "pre-pr.md"), "pre-pr\n", "utf8");
  writeFileSync(join(runDir, "artifacts", "validator.md"), "validator report\n", "utf8");
  writeFileSync(join(runDir, "gates", "story.question.md"), "approve story?\n", "utf8");
  writeFileSync(join(runDir, "gates", "story.answer"), "approve\n", "utf8");
  writeFileSync(join(runDir, "gates", "story.answer.consumed-1"), "approve\n", "utf8");
  writeFileSync(join(runDir, "gates", "pre_pr.question.md"), "approve pre-pr?\n", "utf8");
  writeJson(join(runDir, "evidence", "spec.json"), { subject: "spec-writer", status: "pass" });
  writeJson(join(runDir, "evidence", "test.json"), { subject: "test-verifier", status: "pass" });
  writeJson(join(runDir, "evidence", "be-api.json"), { subject: "be-api", status: "pass" });
  writeJson(join(runDir, "evidence", "be-docs.json"), { subject: "be-docs", status: "blocked" });
  writeJson(join(runDir, "reviews", "spec.json"), { subject: "spec-writer", verdict: "APPROVE" });
  writeJson(join(runDir, "reviews", "test.json"), { subject: "test-verifier", verdict: "APPROVE" });
  writeJson(join(runDir, "reviews", "be-api.json"), createSliceReviewRecord({ subject: "be-api", attempt: 1, reviewedCommit }));
  writeJson(join(runDir, "reviews", "be-docs.json"), createSliceReviewRecord({ subject: "be-docs", attempt: 1, reviewedCommit }));
  writeJson(join(runDir, "reviews", "validator.json"), { subject: "implementation-validator", verdict: "GO-WITH-NITS" });
  writeJson(join(runDir, "reviews", "security.json"), { subject: "security-reviewer", verdict: "PASS" });
  writeJson(join(runDir, "plan", "slices.json"), { slices: [] });
  const evidenceRef = "evidence/be-api.json";
  const reviewRef = "reviews/be-api.json";
  const evidenceHash = hashFile(join(runDir, evidenceRef));
  const reviewHash = hashFile(join(runDir, reviewRef));
  const attemptReview = createSliceAttemptReview({ evidenceRef, evidenceHash, reviewRef, reviewHash, reviewedCommit });

  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    status: "running",
    gates: {
      story: {
        status: "approved",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer.consumed-1",
        answer: "approve",
        answered_at: "2026-07-09T11:00:00.000Z",
        pending_snapshot: {
          question_ref: "gates/story.question.md",
          question_hash: hashFile(join(runDir, "gates", "story.question.md"), { mode: "raw" }),
          artifact_ref: "artifacts/story.md",
          artifact_hash: hashFile(join(runDir, "artifacts", "story.md"), { mode: "raw" }),
          answer_ref: "gates/story.answer",
          answer_hash: hashFile(join(runDir, "gates", "story.answer"), { mode: "raw" }),
          created_at: "2026-07-09T10:59:00.000Z",
        },
      },
      pre_pr: {
        status: "approved",
        artifact: "artifacts/pre-pr.md",
        question_ref: "gates/pre_pr.question.md",
        answer: "approve",
        answered_at: "2026-07-09T11:30:00.000Z",
      },
    },
    steps: [
      { agent: "spec-writer", status: "accepted", artifact_ref: "artifacts/brief.md", evidence_ref: "evidence/spec.json", review_ref: "reviews/spec.json", attempts: 1 },
      { agent: "test-verifier", status: "accepted", evidence_ref: "evidence/test.json", review_ref: "reviews/test.json", attempts: 2 },
    ],
    slices: [
      { id: "be-api", declared_paths: ["be-api.txt"], effective_paths: ["be-api.txt"], status: "merged", branch: "be-api", worktree: "/tmp/be-api", attempts: 1, attempt_reviews: [attemptReview], evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash, reviewed_commit: reviewedCommit, merge_commit: "abc123" },
      { id: "be-docs", declared_paths: ["be-docs.txt"], effective_paths: ["be-docs.txt"], status: "blocked", branch: "be-docs", worktree: "/tmp/be-docs", attempts: 1, evidence_ref: "evidence/be-docs.json", review_ref: "reviews/be-docs.json", blocked_reason: "blocked by upstream" },
    ],
    validator: { verdict: "GO-WITH-NITS", report: "artifacts/validator.md", review_ref: "reviews/validator.json" },
    security_review: { verdict: "PASS", review_ref: "reviews/security.json" },
    pr_url: "https://github.com/acme/project/pull/123",
  });
}

function snapshotDurableFiles(runDir) {
  const snapshot = {};
  for (const dir of ["artifacts", "gates", "evidence", "reviews", "plan"]) snapshot[dir] = snapshotDir(join(runDir, dir));
  return snapshot;
}

function snapshotDir(dir) {
  if (!existsSync(dir)) return [];
  const entries = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const child of snapshotDir(path)) entries.push(`${name}/${child}`);
    } else {
      entries.push(`${name}:${hashFile(path, { mode: "raw" })}`);
    }
  }
  return entries;
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
