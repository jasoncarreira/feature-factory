import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePostPrCiPolicy } from "../src/config.js";
import { hashFile } from "../src/refs.js";
import {
  createPostPrState,
  hasInFlightHeartbeatWork,
  transitionPostPrFailure,
  transitionPostPrState,
  transitionPostPrTerminal,
  transitionPrePrFenceEstablished,
  transitionPrCreated,
  transitionRunJson,
} from "../src/run-state.js";
import { POST_PR_TERMINAL_REASONS, ValidationError, validateRun } from "../src/validate.js";

const NOW = "2026-07-12T12:00:00.000Z";
const HEAD = "a".repeat(40);

describe("post-PR schema-v1 state", () => {
  it("keeps absence legacy-compatible and validates disabled/awaiting states", () => {
    assert.doesNotThrow(() => validateRun({ schema_version: 1, run_id: "legacy", status: "running", gates: {} }));
    assert.equal(validateRun(baseRun("disabled", createPostPrState(policy(false)))).post_pr.phase, "disabled");
    assert.equal(validateRun(baseRun("enabled", createPostPrState(policy(true)))).post_pr.phase, "awaiting-pr");
  });

  it("rejects invalid policy, active/terminal consistency, attempts, and unknown fields", () => {
    const cases = [
      mutate(activeRun(), (run) => { run.post_pr.policy.wait_ms = 1; }),
      mutate(activeRun(), (run) => { run.post_pr.attempt = 4; }),
      mutate(activeRun(), (run) => { run.status = "completed"; }),
      mutate(activeRun(), (run) => { run.post_pr.extra = true; }),
      mutate(activeRun(), (run) => { run.post_pr.observation.expected_head_sha = "short"; }),
    ];
    for (const value of cases) assert.throws(() => validateRun(value), ValidationError);
  });

  it("enforces closed terminal phase/reason combinations", () => {
    for (const [status, reasons] of Object.entries(POST_PR_TERMINAL_REASONS)) {
      for (const reason of reasons) {
        const run = activeRun();
        run.status = status;
        run.post_pr.phase = status === "completed" ? "succeeded" : status;
        run.terminal_result = { status, run_id: run.run_id, pr_url: run.pr_url, reason, summary: reason, artifacts: {} };
        assert.doesNotThrow(() => validateRun(run), `${status}:${reason}`);
      }
    }
    const invalid = activeRun();
    invalid.status = "blocked";
    invalid.post_pr.phase = "blocked";
    invalid.terminal_result = { status: "blocked", run_id: invalid.run_id, pr_url: invalid.pr_url, reason: "arbitrary", artifacts: {} };
    assert.throws(() => validateRun(invalid), /closed post-PR blocked reason/u);
  });

  it("recognizes all durable waiting phases as heartbeat work", () => {
    for (const phase of ["observing", "remediation-running", "revalidating"]) {
      const run = activeRun();
      run.post_pr.phase = phase;
      if (phase !== "observing") run.post_pr.remediation = remediation(1, phase === "revalidating" ? "revalidating" : "running");
      assert.equal(hasInFlightHeartbeatWork(run), true, phase);
    }
  });
});

describe("checked post-PR transitions", () => {
  it("preserves legacy immediate completion but initializes enabled observation", async () => {
    for (const enabled of [false, true]) {
      const fixture = createPrFixture(`pr-${enabled}`, enabled);
      try {
        const fence = await transitionPrePrFenceEstablished(fixture.runDir, { now: NOW, token: "fence-token-123" });
        const input = { pr_url: "https://github.com/acme/repo/pull/7", pr_number: 7, repository: "acme/repo", head_sha: enabled ? HEAD : undefined };
        const result = await transitionPrCreated(fixture.runDir, input, { now: NOW, fenceToken: fence.fence.token });
        if (enabled) {
          assert.equal(result.run.status, "running");
          assert.equal(result.run.post_pr.phase, "observing");
          assert.equal(result.run.post_pr.observation.epoch, 1);
          assert.equal(result.run.post_pr.observation.deadline_at, "2026-07-12T13:00:00.000Z");
          assert.equal(result.run.post_pr.observation.expected_head_sha, HEAD);
        } else assert.equal(result.run.status, "completed");
      } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
    }
  });

  it("requires a full head SHA for enabled pr-created without weakening the fence", async () => {
    const fixture = createPrFixture("head-required", true);
    try {
      const fence = await transitionPrePrFenceEstablished(fixture.runDir, { now: NOW, token: "fence-token-123" });
      await assert.rejects(transitionPrCreated(fixture.runDir, { pr_url: "https://github.com/acme/repo/pull/7", pr_number: 7, repository: "acme/repo" }, { now: NOW, fenceToken: fence.fence.token }), /requires a full 40-character/u);
      assert.equal(readJson(join(fixture.runDir, "run.json")).pr_url, null);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("advances attempts exactly, binds evidence bytes, replays identically, and rejects conflicts", async () => {
    const fixture = createActiveFixture("attempts");
    try {
      mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
      writeJson(join(fixture.runDir, "evidence", "post-pr-ci.attempt-1.json"), { schema_version: 1, kind: "post-pr-ci", attempt: 1, head: HEAD });
      const ref = "evidence/post-pr-ci.attempt-1.json";
      const hash = hashFile(join(fixture.runDir, ref));
      const next = remediation(1, "planned", { failure_evidence_ref: ref, failure_evidence_hash: hash });
      const reserved = await transitionPostPrFailure(fixture.runDir, { remediation: next }, { now: NOW });
      assert.equal(reserved.run.post_pr.attempt, 1);
      assert.equal(reserved.run.post_pr.phase, "failure-recording");
      const replay = await transitionPostPrFailure(fixture.runDir, { remediation: next }, { now: NOW });
      assert.equal(replay.updated, false);
      await assert.rejects(transitionPostPrFailure(fixture.runDir, { remediation: { ...next, failure_fingerprint: `sha256:${"b".repeat(64)}` } }), /conflicting post-PR failure replay/u);

      const planned = { ...reserved.run.post_pr, phase: "remediation-planned", remediation: { ...next, stage: "planned" } };
      assert.equal((await transitionPostPrState(fixture.runDir, planned)).run.post_pr.phase, "remediation-planned");
      const decremented = { ...planned, attempt: 0, remediation: null };
      await assert.rejects(transitionPostPrState(fixture.runDir, decremented), /attempt changes must use transitionPostPrFailure/u);
      await assert.rejects(transitionPostPrFailure(fixture.runDir, { remediation: { ...next, attempt: 2 } }), /cannot start from 'remediation-planned'/u);

      writeJson(join(fixture.runDir, ref), { tampered: true });
      const running = { ...planned, phase: "remediation-running", remediation: { ...next, stage: "running", dispatch: { ...next.dispatch, status: "running" } } };
      await assert.rejects(transitionPostPrState(fixture.runDir, running), /ref\/hash invariant failed/u);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("guards active state from generic mutation and terminalizes only with closed reasons", async () => {
    const fixture = createActiveFixture("guards");
    try {
      await assert.rejects(transitionRunJson(fixture.runDir, (run) => { run.post_pr.observation.poll_count += 1; }), /checked post-PR transitions/u);
      await assert.rejects(transitionRunJson(fixture.runDir, (run) => { run.status = "completed"; }), /post-PR runs can only terminalize/u);
      await assert.rejects(transitionPostPrTerminal(fixture.runDir, { status: "blocked", reason: "made-up" }), /invalid closed post-PR terminal reason/u);
      const done = await transitionPostPrTerminal(fixture.runDir, { status: "completed", reason: "post-pr-ci-green" }, { now: NOW });
      assert.equal(done.run.post_pr.phase, "succeeded");
      await assert.rejects(transitionPostPrState(fixture.runDir, done.run.post_pr), /terminal run/u);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });
});

function policy(enabled) {
  return resolvePostPrCiPolicy({ driver: { enabled }, reviewer: null });
}

function baseRun(runId, postPr) {
  return { schema_version: 1, run_id: runId, status: "running", max_retries: 3, gates: {}, post_pr: postPr, terminal_result: null };
}

function observation() {
  return { epoch: 1, expected_head_sha: HEAD, started_at: NOW, deadline_at: "2026-07-12T13:00:00.000Z", next_poll_at: NOW, poll_count: 0, unchanged_count: 0, current_interval_ms: 30_000, consecutive_transient_errors: 0, last_observed_at: null, last_fingerprint: null, last_check_verdict: "not_started", last_review_verdict: "not_required", last_verdict: "pending", last_error: null };
}

function activeRun(runId = "active") {
  const run = baseRun(runId, createPostPrState(policy(true)));
  run.pr_url = "https://github.com/acme/repo/pull/7";
  run.post_pr.phase = "observing";
  run.post_pr.observation = observation();
  return run;
}

function remediation(attempt, stage, overrides = {}) {
  return {
    schema_version: 1, attempt, reason_code: "check-red", failure_fingerprint: `sha256:${"a".repeat(64)}`, failed_head_sha: HEAD,
    failure_evidence_ref: "evidence/post-pr-ci.attempt-1.json", failure_evidence_hash: `sha256:${"a".repeat(64)}`,
    owner: { kind: "slice", slice_id: "api", stack: "backend", path_b64url: null, method: "check-slice-id" }, route: "backend-builder", lane: "slice", stage,
    baseline_head_sha: HEAD, dispatch: { id: "dispatch-1", status: stage === "running" ? "running" : "planned", role: "backend-builder", subject: "api", started_at: null, returned_at: null },
    changes: { paths: [], tree_hash: null }, candidate_head_sha: null, remediation_evidence_ref: null, remediation_evidence_hash: null,
    revalidation: { canonical_evidence_ref: null, canonical_evidence_hash: null, canonical_verdict: null, validator_review_ref: null, validator_review_hash: null, validator_verdict: null, security_review_ref: null, security_review_hash: null, security_verdict: null },
    push: { status: "not-ready", remote_before_sha: null, local_head_sha: null, remote_after_sha: null, consecutive_transient_errors: 0, next_retry_at: null, pushed_at: null }, ...overrides,
  };
}

function createPrFixture(runId, enabled) {
  const repo = mkdtempSync(join(tmpdir(), "post-pr-state-"));
  const runDir = join(repo, ".opencode", "factory", runId);
  for (const dir of ["artifacts", "reviews"]) mkdirSync(join(runDir, dir), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "validation-report.md"), "GO\n");
  writeJson(join(runDir, "reviews", "implementation-validator.json"), { verdict: "GO" });
  writeJson(join(runDir, "reviews", "security-reviewer.json"), { verdict: "PASS" });
  writeJson(join(runDir, "run.json"), {
    schema_version: 1, run_id: runId, status: "running", max_retries: 3, gates: { pre_pr: { status: "approved" } }, pr_url: null,
    slices: [{ id: "api", stack: "backend", status: "merged", merge_commit: HEAD }],
    validator: { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" },
    security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json" }, steering: { schema_version: 1, generation: 0, pending: null, uncheckpointed: null, boundary: null, action_claim: null, last_action: null, pr_fence: null, history: [] },
    post_pr: createPostPrState(policy(enabled)), terminal_result: null,
  });
  return { repo, runDir };
}

function createActiveFixture(runId) {
  const repo = mkdtempSync(join(tmpdir(), "post-pr-active-"));
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, "run.json"), activeRun(runId));
  return { repo, runDir };
}

function mutate(value, fn) { const copy = structuredClone(value); fn(copy); return copy; }
function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
