import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { continueFactory, heartbeatStatus, postPrObserve, postPrRemediation, resumeFactory, status, writeSteering } from "../src/factory.js";
import { decodeFeatureCommandPayload, encodeFeatureCommandPayload } from "../src/feature-command-payload.js";
import { hashValue } from "../src/refs.js";

const SHA = "a".repeat(40);

describe("post-PR workflow orchestration", () => {
  it("does no GitHub work before next_poll_at and exposes a read-only summary", async () => {
    const fixture = createFixture("post-pr-not-due", { nextPollAt: "2026-07-12T12:01:00.000Z" });
    try {
      let calls = 0;
      const result = await postPrObserve(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:00:00.000Z", executeGithub: async () => { calls += 1; throw new Error("must not run"); } });
      assert.equal(result.action, "not-due");
      assert.equal(calls, 0);
      const projected = status(fixture.runId, { cwd: fixture.repo });
      assert.equal(projected.status, "running", JSON.stringify(projected));
      assert.deepEqual(projected.post_pr, {
        enabled: true, phase: "observing", attempt: 0, max_retries: 3,
        deadline_at: "2026-07-12T13:00:00.000Z", next_poll_at: "2026-07-12T12:01:00.000Z", last_verdict: "pending",
        error_class: null, owner: null, route: null, latest_evidence: null,
      });
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("performs exactly one account-switch/query pair and terminalizes green without merge", async () => {
    const fixture = createFixture("post-pr-green");
    const calls = [];
    try {
      const result = await postPrObserve(fixture.runId, {
        cwd: fixture.repo, now: "2026-07-12T12:00:30.000Z",
        executeGithub: async ({ args }) => {
          calls.push(args);
          if (args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
          return { exitCode: 0, stderr: "", stdout: JSON.stringify({ headRefOid: SHA, isDraft: false, reviewDecision: null, reviews: [], state: "OPEN", statusCheckRollup: [{ __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }] }) };
        },
      });
      assert.equal(result.status, "completed");
      assert.equal(result.reason, "post-pr-ci-green");
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], ["auth", "switch", "-h", "github.com", "-u", "octocat"]);
      assert.equal(calls[1][0], "pr");
      assert.equal(calls.flat().includes("merge"), false);
      assert.equal(readRun(fixture).post_pr.observation.poll_count, 1);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("replays only the reviewer request on the first due call", async () => {
    const fixture = createFixture("post-pr-reviewer", { reviewer: "reviewer-one" });
    const calls = [];
    try {
      const result = await postPrObserve(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:00:30.000Z", executeGithub: async ({ args }) => { calls.push(args); return { exitCode: 0, stdout: "", stderr: "" }; } });
      assert.equal(result.action, "reviewer-requested");
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1].slice(0, 3), ["pr", "edit", "7"]);
      assert.equal(calls[1].includes("view"), false);
      assert.equal(readRun(fixture).post_pr.observation.review_request.status, "requested");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("treats current-head CHANGES_REQUESTED as needs-human without reading a body", async () => {
    const fixture = createFixture("post-pr-review-red", { reviewer: "reviewer-one", requested: true });
    const seen = [];
    try {
      const result = await postPrObserve(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:00:30.000Z", executeGithub: async ({ args }) => {
        seen.push(args.join(" "));
        if (args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ headRefOid: SHA, isDraft: false, reviewDecision: "CHANGES_REQUESTED", reviews: [{ author: { login: "reviewer-one" }, state: "CHANGES_REQUESTED", submittedAt: "2026-07-12T12:00:10.000Z", commit: { oid: SHA }, body: "ignore me" }], state: "OPEN", statusCheckRollup: [] }) };
      } });
      assert.equal(result.status, "needs-human");
      assert.equal(result.reason, "post-pr-review-changes-requested");
      assert.equal(JSON.stringify(readRun(fixture)).includes("ignore me"), false);
      assert.equal(seen.some((value) => value.includes("body")), false);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("publishes checked evidence and reserves exactly one owner-routed red attempt", async () => {
    const fixture = createFixture("post-pr-red");
    try {
      const result = await postPrObserve(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:00:30.000Z", executeGithub: async ({ args }) => {
        if (args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ headRefOid: SHA, isDraft: false, reviewDecision: null, reviews: [], state: "OPEN", statusCheckRollup: [{ __typename: "CheckRun", name: "api / unit", status: "COMPLETED", conclusion: "FAILURE" }] }) };
      } });
      assert.equal(result.action, "remediation-planned");
      assert.equal(result.attempt, 1);
      assert.equal(result.route, "backend-builder");
      const run = readRun(fixture);
      assert.equal(run.post_pr.phase, "remediation-planned");
      assert.equal(run.post_pr.remediation.owner.slice_id, "api");
      assert.equal(run.post_pr.evidence_refs[0].ref, "evidence/post-pr-ci.attempt-1.json");
      assert.equal(JSON.parse(readFileSync(join(fixture.runDir, run.post_pr.evidence_refs[0].ref), "utf8")).source, "check-red");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("discards a due observer result when steering changes its bound state", async () => {
    const fixture = createFixture("post-pr-steering-race");
    try {
      await assert.rejects(postPrObserve(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:00:30.000Z", executeGithub: async ({ args }) => {
        if (args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
        await writeSteering(fixture.runId, "prospective change", { cwd: fixture.repo, now: "2026-07-12T12:00:31.000Z" });
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ headRefOid: SHA, isDraft: false, reviewDecision: null, reviews: [], state: "OPEN", statusCheckRollup: [] }) };
      } }), /stale|current run state hash mismatch/u);
      const run = readRun(fixture);
      assert.equal(run.post_pr.observation.poll_count, 0);
      assert.ok(run.steering.pending);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("does not publish red evidence after a pre-publication steering race", async () => {
    const fixture = createFixture("post-pr-evidence-race");
    try {
      await assert.rejects(postPrObserve(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:00:30.000Z", executeGithub: async ({ args }) => {
        if (args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ headRefOid: SHA, isDraft: false, reviewDecision: null, reviews: [], state: "OPEN", statusCheckRollup: [{ __typename: "CheckRun", name: "api / unit", status: "COMPLETED", conclusion: "FAILURE" }] }) };
      }, beforeEvidencePublish: async () => writeSteering(fixture.runId, "race before evidence", { cwd: fixture.repo, now: "2026-07-12T12:00:32.000Z" }) }), /stale/u);
      assert.equal(existsSync(join(fixture.runDir, "evidence", "post-pr-ci.attempt-1.json")), false);
      assert.equal(readRun(fixture).post_pr.attempt, 0);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("persists dispatch/action before wait, heartbeats during dispatch, and stops before return", async () => {
    const fixture = createFixture("post-pr-dispatch");
    try {
      await observeApiRed(fixture);
      let dispatch;
      const result = await postPrRemediation(fixture.runId, 1, "running", {
        cwd: fixture.repo, now: "2026-07-12T12:01:00.000Z", heartbeatIntervalMs: 1000,
        dispatchRemediation: async (input) => {
          dispatch = input;
          const during = heartbeatStatus(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:01:00.000Z" });
          assert.equal(during.phase, "post-pr-remediation");
          assert.equal(during.fresh, true);
          return { status: "returned" };
        },
      });
      assert.equal(result.action, "remediation-returned");
      assert.equal(dispatch.run_id, fixture.runId);
      assert.equal(dispatch.attempt, 1);
      assert.equal(dispatch.role, "backend-builder");
      assert.equal(readRun(fixture).post_pr.remediation.dispatch.status, "running");
      assert.equal(heartbeatStatus(fixture.runId, { cwd: fixture.repo }).pid, null);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("terminalizes an unknown started dispatch on restart instead of redispatching", async () => {
    const fixture = createFixture("post-pr-dispatch-unknown");
    try {
      await observeApiRed(fixture);
      await postPrRemediation(fixture.runId, 1, "running", { cwd: fixture.repo, now: "2026-07-12T12:01:00.000Z" });
      await assert.rejects(resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:02:00.000Z" }), /terminal-run|resume ineligible/u);
      const run = readRun(fixture);
      assert.equal(run.status, "needs-human");
      assert.equal(run.terminal_result.reason, "post-pr-dispatch-start-unknown");
      assert.equal(run.post_pr.terminal_fact.dispatch_id, run.post_pr.remediation.dispatch.id);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("rejects stale canonical/panel bindings before push", async () => {
    const fixture = createRevalidationFixture("post-pr-stale-panel");
    try {
      const refs = writePassingRevalidationArtifacts(fixture, { validatorHead: fixture.baseline });
      await assert.rejects(postPrRemediation(fixture.runId, 1, "complete", { cwd: fixture.repo, headSha: fixture.candidate, ...refs }), /validator review must bind/u);
      assert.equal(readRun(fixture).post_pr.phase, "revalidating");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("account-switches every remote/push operation, reconciles push, and creates one fresh epoch", async () => {
    const fixture = createRevalidationFixture("post-pr-push");
    const refs = writePassingRevalidationArtifacts(fixture);
    const accountCalls = [];
    const gitOps = [];
    let remote = fixture.baseline;
    try {
      const result = await postPrRemediation(fixture.runId, 1, "complete", {
        cwd: fixture.repo, now: "2026-07-12T12:10:00.000Z", headSha: fixture.candidate, ...refs,
        executeGithub: async ({ args }) => { accountCalls.push(args); return { exitCode: 0, stdout: "", stderr: "" }; },
        executeGitOperation: async ({ operation }) => {
          gitOps.push(operation);
          if (operation === "remote-head") return { exitCode: 0, stdout: `${remote}\trefs/heads/main\n`, stderr: "" };
          remote = fixture.candidate;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
      assert.equal(result.action, "observing");
      assert.equal(result.epoch, 2);
      assert.deepEqual(gitOps, ["remote-head", "fast-forward-push", "remote-head"]);
      assert.equal(accountCalls.length, 3);
      assert.ok(accountCalls.every((args) => args.join(" ") === "auth switch -h github.com -u octocat"));
      const run = readRun(fixture);
      assert.equal(run.post_pr.observation.expected_head_sha, fixture.candidate);
      assert.equal(run.post_pr.remediation.push.remote_after_sha, fixture.candidate);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("durably records account-switch push failure and does not blindly retry", async () => {
    const fixture = createRevalidationFixture("post-pr-push-account-failure");
    const refs = writePassingRevalidationArtifacts(fixture);
    let switches = 0;
    try {
      const result = await postPrRemediation(fixture.runId, 1, "complete", { cwd: fixture.repo, now: "2026-07-12T12:10:00.000Z", headSha: fixture.candidate, ...refs,
        executeGithub: async () => { switches += 1; return { exitCode: 1, stdout: "", stderr: "authentication failed" }; } });
      assert.equal(result.action, "push-needs-human");
      const run = readRun(fixture);
      assert.equal(run.post_pr.phase, "push-pending");
      assert.equal(run.post_pr.remediation.push.consecutive_transient_errors, run.post_pr.policy.max_transient_errors);
      assert.equal(run.post_pr.remediation.push.next_retry_at, null);
      const replay = await postPrRemediation(fixture.runId, 1, "complete", { cwd: fixture.repo, now: "2026-07-12T12:11:00.000Z" });
      assert.equal(replay.action, "push-needs-human");
      assert.equal(switches, 1);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("persists transient push backoff and performs no operation before retry time", async () => {
    const fixture = createRevalidationFixture("post-pr-push-transient");
    const refs = writePassingRevalidationArtifacts(fixture); let operations = 0;
    try {
      const result = await postPrRemediation(fixture.runId, 1, "complete", { cwd: fixture.repo, now: "2026-07-12T12:10:00.000Z", headSha: fixture.candidate, ...refs,
        executeGithub: async () => ({ exitCode: 0, stdout: "", stderr: "" }), executeGitOperation: async () => { operations += 1; return { exitCode: 1, stdout: "", stderr: "HTTP 503" }; } });
      assert.equal(result.action, "push-retry");
      assert.equal(result.next_retry_at, "2026-07-12T12:11:00.000Z");
      const replay = await postPrRemediation(fixture.runId, 1, "complete", { cwd: fixture.repo, now: "2026-07-12T12:10:30.000Z" });
      assert.equal(replay.action, "push-not-due");
      assert.equal(operations, 1);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("reconciles crash-after-push from remote candidate without pushing twice", async () => {
    const fixture = createRevalidationFixture("post-pr-crash-after-push");
    const refs = writePassingRevalidationArtifacts(fixture); let remote = fixture.baseline; let pushes = 0;
    const common = { cwd: fixture.repo, now: "2026-07-12T12:10:00.000Z", executeGithub: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      executeGitOperation: async ({ operation }) => { if (operation === "remote-head") return { exitCode: 0, stdout: `${remote}\trefs/heads/main\n`, stderr: "" }; pushes += 1; remote = fixture.candidate; return { exitCode: 0, stdout: "", stderr: "" }; } };
    try {
      await assert.rejects(postPrRemediation(fixture.runId, 1, "complete", { ...common, headSha: fixture.candidate, ...refs, afterExternalPush: async () => { throw new Error("simulated crash after push"); } }), /simulated crash/u);
      assert.equal(readRun(fixture).post_pr.phase, "push-pending");
      const result = await postPrRemediation(fixture.runId, 1, "complete", common);
      assert.equal(result.action, "observing");
      assert.equal(pushes, 1);
      assert.equal(readRun(fixture).post_pr.observation.epoch, 2);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("terminalizes a remote head that is neither baseline nor candidate without force push", async () => {
    const fixture = createRevalidationFixture("post-pr-remote-diverged");
    const refs = writePassingRevalidationArtifacts(fixture); let pushes = 0;
    try {
      const result = await postPrRemediation(fixture.runId, 1, "complete", { cwd: fixture.repo, now: "2026-07-12T12:10:00.000Z", headSha: fixture.candidate, ...refs,
        executeGithub: async () => ({ exitCode: 0, stdout: "", stderr: "" }), executeGitOperation: async ({ operation }) => { if (operation === "fast-forward-push") pushes += 1; return { exitCode: 0, stdout: `${"f".repeat(40)}\trefs/heads/main\n`, stderr: "" }; } });
      assert.equal(result.status, "needs-human");
      assert.equal(result.reason, "post-pr-remote-head-diverged");
      assert.equal(pushes, 0);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("reconciles validated, push-pending, and remote-confirmed crash rows exactly once", async () => {
    for (const [name, hook, expectedPhase] of [["validated", "afterValidated", "validated"], ["push-pending", "afterPushPending", "push-pending"], ["remote-confirmed", "afterRemoteConfirmed", "remote-confirmed"]]) {
      const fixture = createRevalidationFixture(`post-pr-crash-${name}`); const refs = writePassingRevalidationArtifacts(fixture); let remote = fixture.baseline; let pushes = 0;
      const operations = { cwd: fixture.repo, now: "2026-07-12T12:10:00.000Z", executeGithub: async () => ({ exitCode: 0, stdout: "", stderr: "" }), executeGitOperation: async ({ operation }) => {
        if (operation === "remote-head") return { exitCode: 0, stdout: `${remote}\trefs/heads/main\n`, stderr: "" };
        pushes += 1; remote = fixture.candidate; return { exitCode: 0, stdout: "", stderr: "" };
      } };
      try {
        await assert.rejects(postPrRemediation(fixture.runId, 1, "complete", { ...operations, headSha: fixture.candidate, ...refs, [hook]: async () => { throw new Error(`crash-${name}`); } }), new RegExp(`crash-${name}`));
        assert.equal(readRun(fixture).post_pr.phase, expectedPhase);
        const result = await postPrRemediation(fixture.runId, 1, "complete", operations);
        assert.equal(result.action, "observing");
        assert.equal(readRun(fixture).post_pr.observation.epoch, 2);
        assert.ok(pushes <= 1);
      } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
    }
  });

  it("adopts a clean descendant commit after a crashed started dispatch", async () => {
    const fixture = createRevalidationFixture("post-pr-adopt-descendant");
    try {
      updateRunFile(fixture, (run) => {
        run.post_pr.phase = "remediation-running";
        Object.assign(run.post_pr.remediation, { stage: "running", candidate_head_sha: null, remediation_evidence_ref: null, remediation_evidence_hash: null, changes: { paths: [], tree_hash: null } });
        Object.assign(run.post_pr.remediation.dispatch, { status: "running", returned_at: null });
      });
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z" });
      assert.equal(result.status, "dry-run");
      const run = readRun(fixture);
      assert.equal(run.post_pr.phase, "committed");
      assert.equal(run.post_pr.remediation.candidate_head_sha, fixture.candidate);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("adopts a lane-contained dirty diff after a crashed started dispatch", async () => {
    const fixture = createRevalidationFixture("post-pr-adopt-dirty");
    try {
      runGit(fixture.repo, ["reset", "--hard", fixture.baseline]);
      writeFileSync(join(fixture.repo, "src", "api.js"), "export const value = 3;\n");
      updateRunFile(fixture, (run) => {
        run.post_pr.phase = "remediation-running";
        Object.assign(run.post_pr.remediation, { stage: "running", candidate_head_sha: null, remediation_evidence_ref: null, remediation_evidence_hash: null, changes: { paths: [], tree_hash: null } });
        Object.assign(run.post_pr.remediation.dispatch, { status: "running", returned_at: null });
      });
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z" });
      assert.equal(result.status, "dry-run");
      const run = readRun(fixture);
      assert.equal(run.post_pr.phase, "changes-observed");
      assert.deepEqual(run.post_pr.remediation.changes.paths, ["src/api.js"]);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("adopts bound failure evidence after a failure-recording crash", async () => {
    const fixture = createFixture("post-pr-failure-recording");
    try {
      await observeApiRed(fixture);
      updateRunFile(fixture, (run) => { run.post_pr.phase = "failure-recording"; });
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z" });
      assert.equal(result.status, "dry-run");
      assert.equal(readRun(fixture).post_pr.phase, "remediation-planned");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("deterministically regenerates missing failure-recording evidence instead of blocking", async () => {
    const fixture = createFixture("post-pr-regenerate-evidence");
    try {
      await observeApiRed(fixture);
      const before = readRun(fixture); const binding = before.post_pr.evidence_refs[0];
      updateRunFile(fixture, (run) => { run.post_pr.phase = "failure-recording"; });
      rmSync(join(fixture.runDir, binding.ref));
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z" });
      assert.equal(result.status, "dry-run");
      assert.equal(fileHash(join(fixture.runDir, binding.ref)), binding.hash);
      assert.equal(readRun(fixture).post_pr.phase, "remediation-planned");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("adopts matching deterministic failure evidence left unbound by a crash", async () => {
    const fixture = createFixture("post-pr-adopt-unbound");
    try {
      await observeApiRed(fixture);
      updateRunFile(fixture, (run) => { run.post_pr.phase = "observing"; run.post_pr.attempt = 0; run.post_pr.remediation = null; run.post_pr.evidence_refs = []; });
      const result = await resumeFactory(fixture.runId, { cwd: fixture.repo, dryRun: true, now: "2026-07-12T12:05:00.000Z" });
      assert.equal(result.status, "dry-run");
      const run = readRun(fixture);
      assert.equal(run.post_pr.phase, "remediation-planned");
      assert.equal(run.post_pr.attempt, 1);
      assert.equal(run.post_pr.remediation.failure_evidence_ref, "evidence/post-pr-ci.attempt-1.json");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("exhausts against the exact latest local failure and publishes all ref/hash bindings", async () => {
    const fixture = createRevalidationFixture("post-pr-exhaustion");
    try {
      updateRunFile(fixture, (run) => { run.max_retries = 1; });
      const failure = { run_id: fixture.runId, attempt: 2, source: "local-red", verdict: "red", failed_head_sha: fixture.candidate, failure_fingerprint: `sha256:${"9".repeat(64)}`, affected_paths: ["src/api.js"], panel: "validator" };
      writeJson(join(fixture.runDir, "evidence", "post-pr-local-failure.attempt-2.json"), failure);
      const result = await postPrRemediation(fixture.runId, 1, "failed", { cwd: fixture.repo, failureEvidenceRef: "evidence/post-pr-local-failure.attempt-2.json", now: "2026-07-12T12:10:00.000Z" });
      assert.equal(result.status, "blocked");
      const run = readRun(fixture);
      assert.equal(run.terminal_result.reason, "post-pr-retry-exhausted");
      assert.equal(run.post_pr.evidence_refs.at(-1).ref, "evidence/post-pr-local-failure.attempt-2.json");
      assert.equal(run.terminal_result.artifacts.latest_failure_hash, fileHash(join(fixture.runDir, "evidence", "post-pr-local-failure.attempt-2.json")));
      assert.equal(run.terminal_result.artifacts.continuation_review_hash, run.post_pr.continuation_review.hash);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("re-attributes structured test-only panel failure to test-verifier and fails closed for unowned security block", async () => {
    const fixture = createRevalidationFixture("post-pr-panel-reattribution");
    try {
      writeJson(join(fixture.runDir, "evidence", "panel-failure-2.json"), { run_id: fixture.runId, attempt: 2, source: "local-red", verdict: "red", failed_head_sha: fixture.candidate, failure_fingerprint: `sha256:${"7".repeat(64)}`, affected_paths: ["test/api.test.js"], panel: "validator" });
      const result = await postPrRemediation(fixture.runId, 1, "failed", { cwd: fixture.repo, failureEvidenceRef: "evidence/panel-failure-2.json", now: "2026-07-12T12:10:00.000Z" });
      assert.equal(result.route, "test-verifier");
      assert.equal(readRun(fixture).post_pr.remediation.owner.kind, "integration");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }

    const security = createRevalidationFixture("post-pr-security-reattribution");
    try {
      writeJson(join(security.runDir, "evidence", "security-failure-2.json"), { run_id: security.runId, attempt: 2, source: "local-red", verdict: "red", failed_head_sha: security.candidate, failure_fingerprint: `sha256:${"6".repeat(64)}`, affected_paths: ["test/api.test.js"], panel: "security" });
      await assert.rejects(postPrRemediation(security.runId, 1, "failed", { cwd: security.repo, failureEvidenceRef: "evidence/security-failure-2.json", now: "2026-07-12T12:10:00.000Z" }), /human ownership reconciliation/u);
      assert.equal(readRun(security).post_pr.phase, "revalidating");
    } finally { rmSync(security.repo, { recursive: true, force: true }); }
  });

  it("builds a hash-bound new-PR continuation without mutating the parent and rejects tampering", async () => {
    const fixture = createRevalidationFixture("post-pr-continuation");
    try {
      updateRunFile(fixture, (run) => { run.max_retries = 1; });
      writeJson(join(fixture.runDir, "evidence", "post-pr-local-failure.attempt-2.json"), { run_id: fixture.runId, attempt: 2, source: "local-red", verdict: "red", failed_head_sha: fixture.candidate, failure_fingerprint: `sha256:${"8".repeat(64)}`, affected_paths: ["src/api.js"] });
      await postPrRemediation(fixture.runId, 1, "failed", { cwd: fixture.repo, failureEvidenceRef: "evidence/post-pr-local-failure.attempt-2.json", now: "2026-07-12T12:10:00.000Z" });
      const parentBefore = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      const parent = readRun(fixture);
      const result = continueFactory(fixture.runId, { cwd: fixture.repo, review: parent.post_pr.continuation_review.ref, runId: "post-pr-continuation-child", newPr: true, dryRun: true, now: "2026-07-12T12:11:00.000Z" });
      assert.doesNotThrow(() => decodeFeatureCommandPayload(encodeFeatureCommandPayload(result.payload)));
      assert.equal(result.payload.continuation.post_pr.disposition, "leave-unchanged");
      assert.equal(result.payload.continuation.post_pr.evidence_ref, "evidence/post-pr-local-failure.attempt-2.json");
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), parentBefore);
      writeFileSync(join(fixture.runDir, parent.post_pr.continuation_review.ref), "{}\n");
      assert.throws(() => continueFactory(fixture.runId, { cwd: fixture.repo, review: parent.post_pr.continuation_review.ref, runId: "post-pr-continuation-tampered", newPr: true, dryRun: true }), /hash mismatch|invalid evidence\/review bindings/u);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), parentBefore);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });
});

async function observeApiRed(fixture) {
  return postPrObserve(fixture.runId, { cwd: fixture.repo, now: "2026-07-12T12:00:30.000Z", executeGithub: async ({ args }) => {
    if (args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
    return { exitCode: 0, stderr: "", stdout: JSON.stringify({ headRefOid: SHA, isDraft: false, reviewDecision: null, reviews: [], state: "OPEN", statusCheckRollup: [{ __typename: "CheckRun", name: "api / unit", status: "COMPLETED", conclusion: "FAILURE" }] }) };
  } });
}

function createFixture(runId, { nextPollAt = "2026-07-12T12:00:00.000Z", reviewer = null, requested = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "post-pr-workflow-"));
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "plan"), { recursive: true });
  writeFileSync(join(runDir, "plan", "slices.json"), `${JSON.stringify({ slices: [{ id: "api", stack: "backend", paths: ["src/api.js"], depends_on: [], acceptance: ["API works"], test_plan: ["node --test"] }] })}\n`);
  const review = reviewer ? { required: true, reviewer_login: reviewer, source: "driver" } : { required: false, reviewer_login: null, source: "none" };
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify({
    schema_version: 1, run_id: runId, status: "running", max_retries: 3, github_account: "octocat", pr_url: "https://github.com/acme/widgets/pull/7", pr_mode: "ready", gates: {},
    post_pr: { schema_version: 1, policy: { enabled: true, wait_ms: 3600000, initial_poll_ms: 30000, max_poll_ms: 120000, check_start_grace_ms: 300000, max_transient_errors: 12, review }, phase: "observing", attempt: 0,
      observation: { epoch: 1, expected_head_sha: SHA, started_at: "2026-07-12T12:00:00.000Z", deadline_at: "2026-07-12T13:00:00.000Z", next_poll_at: nextPollAt, poll_count: 0, unchanged_count: 0, current_interval_ms: 30000, consecutive_transient_errors: 0, last_observed_at: null, last_fingerprint: null, last_check_verdict: "not_started", last_review_verdict: reviewer ? "pending" : "not_required", last_verdict: "pending", last_error: null, review_request: reviewer ? { status: requested ? "requested" : "pending", attempts: requested ? 1 : 0, requested_at: requested ? "2026-07-12T11:59:00.000Z" : null } : null, snapshot: null },
      remediation: null, evidence_refs: [], continuation_review: null, terminal_fact: null },
  }, null, 2)}\n`);
  return { repo, runDir, runId };
}

function createRevalidationFixture(runId) {
  const repo = mkdtempSync(join(tmpdir(), "post-pr-revalidation-"));
  runGit(repo, ["init", "-b", "main"]); runGit(repo, ["config", "user.email", "test@example.com"]); runGit(repo, ["config", "user.name", "Test"]);
  mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src", "api.js"), "export const value = 1;\n"); writeFileSync(join(repo, ".gitignore"), ".opencode/\n"); runGit(repo, ["add", "src/api.js", ".gitignore"]); runGit(repo, ["commit", "-m", "base"]);
  const baseline = gitOutput(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "src", "api.js"), "export const value = 2;\n"); runGit(repo, ["add", "src/api.js"]); runGit(repo, ["commit", "-m", "candidate"]);
  const candidate = gitOutput(repo, ["rev-parse", "HEAD"]);
  const runDir = join(repo, ".opencode", "factory", runId); mkdirSync(join(runDir, "plan"), { recursive: true }); mkdirSync(join(runDir, "evidence")); mkdirSync(join(runDir, "reviews")); mkdirSync(join(runDir, "artifacts"));
  writeFileSync(join(runDir, "plan", "slices.json"), `${JSON.stringify({ slices: [{ id: "api", stack: "backend", paths: ["src/api.js"], depends_on: [], acceptance: ["API works"], test_plan: ["node --test"] }] })}\n`);
  writeFileSync(join(runDir, "evidence", "post-pr-ci.attempt-1.json"), "{}\n");
  const owner = { kind: "slice", slice_id: "api", stack: "backend", path_b64url: null, method: "check-slice-id" };
  const failureEvidenceRef = "evidence/post-pr-ci.attempt-1.json"; const failureHash = fileHash(join(runDir, failureEvidenceRef));
  const dispatch = { schema_version: 1, kind: "post-pr-remediation-dispatch", run_id: runId, attempt: 1, dispatch_id: "dispatch-1", role: "backend-builder", subject: "api", lane: "slice", owner, failed_head_sha: baseline, baseline_head_sha: baseline, failure_evidence: { ref: failureEvidenceRef, hash: failureHash } };
  const changes = [{ status: "modified", path: "src/api.js", previous_path: null }];
  const remediationEvidence = { kind: "post-pr-remediation", run_id: runId, attempt: 1, dispatch_id: "dispatch-1", dispatch_hash: hashValue(dispatch), baseline_head_sha: baseline, candidate_head_sha: candidate, route: "backend-builder", lane: "slice", owner, failure_evidence_ref: failureEvidenceRef, failure_evidence_hash: failureHash, review_ready: true, commands: [{ program: "node", args: ["--test"], exit_code: 0, head_sha: candidate }], commit: candidate, changed_paths: ["src/api.js"], changes, diff_hash: hashValue(changes) };
  writeJson(join(runDir, "evidence", "post-pr-remediation.attempt-1.json"), remediationEvidence);
  const remediationHash = fileHash(join(runDir, "evidence", "post-pr-remediation.attempt-1.json"));
  writeJson(join(runDir, "run.json"), {
    schema_version: 1, run_id: runId, status: "running", max_retries: 3, github_account: "octocat", branch: "main", worktree: repo, pr_url: "https://github.com/acme/widgets/pull/7", pr_mode: "ready", gates: {},
    post_pr: { schema_version: 1, policy: { enabled: true, wait_ms: 3600000, initial_poll_ms: 30000, max_poll_ms: 120000, check_start_grace_ms: 300000, max_transient_errors: 12, review: { required: false, reviewer_login: null, source: "none" } }, phase: "revalidating", attempt: 1,
      observation: { epoch: 1, expected_head_sha: baseline, started_at: "2026-07-12T12:00:00.000Z", deadline_at: "2026-07-12T13:00:00.000Z", next_poll_at: "2026-07-12T12:01:00.000Z", poll_count: 1, unchanged_count: 0, current_interval_ms: 30000, consecutive_transient_errors: 0, last_observed_at: "2026-07-12T12:00:30.000Z", last_fingerprint: `sha256:${"1".repeat(64)}`, last_check_verdict: "red", last_review_verdict: "not_required", last_verdict: "red", last_error: null, review_request: null, snapshot: null },
      remediation: { schema_version: 1, attempt: 1, reason_code: "check-red", failure_fingerprint: `sha256:${"2".repeat(64)}`, failed_head_sha: baseline, failure_evidence_ref: failureEvidenceRef, failure_evidence_hash: failureHash, owner, route: "backend-builder", lane: "slice", stage: "revalidating", baseline_head_sha: baseline, dispatch: { id: "dispatch-1", status: "returned", role: "backend-builder", subject: "api", started_at: "2026-07-12T12:01:00.000Z", returned_at: "2026-07-12T12:02:00.000Z" }, changes: { paths: ["src/api.js"], tree_hash: `sha256:${"3".repeat(64)}` }, candidate_head_sha: candidate, remediation_evidence_ref: "evidence/post-pr-remediation.attempt-1.json", remediation_evidence_hash: remediationHash, revalidation: { canonical_evidence_ref: null, canonical_evidence_hash: null, canonical_verdict: null, validator_review_ref: null, validator_review_hash: null, validator_verdict: null, security_review_ref: null, security_review_hash: null, security_verdict: null }, push: { status: "not-ready", remote_before_sha: null, local_head_sha: null, remote_after_sha: null, consecutive_transient_errors: 0, next_retry_at: null, pushed_at: null } },
      evidence_refs: [{ ref: "evidence/post-pr-ci.attempt-1.json", hash: failureHash }], continuation_review: null, terminal_fact: null },
  });
  return { repo, runDir, runId, baseline, candidate };
}

function writePassingRevalidationArtifacts(fixture, { validatorHead = fixture.candidate } = {}) {
  writeJson(join(fixture.runDir, "evidence", "post-pr-canonical.attempt-1.json"), { kind: "post-pr-canonical", run_id: fixture.runId, attempt: 1, head_sha: fixture.candidate, command: { program: "npm", args: ["run", "check"] }, verdict: "pass" });
  writeFileSync(join(fixture.runDir, "artifacts", "validation-report.attempt-1.md"), "GO\n");
  writeJson(join(fixture.runDir, "reviews", "implementation-validator.attempt-1.json"), { kind: "implementation-validator", run_id: fixture.runId, attempt: 1, head_sha: validatorHead, fresh: true, verdict: "GO", report: "artifacts/validation-report.attempt-1.md", affected_paths: ["src/api.js"] });
  writeJson(join(fixture.runDir, "reviews", "security-reviewer.attempt-1.json"), { kind: "security-reviewer", run_id: fixture.runId, attempt: 1, head_sha: fixture.candidate, fresh: true, verdict: "PASS", affected_paths: ["src/api.js"] });
  return { testEvidenceRef: "evidence/post-pr-canonical.attempt-1.json", validatorReportRef: "artifacts/validation-report.attempt-1.md", validatorReviewRef: "reviews/implementation-validator.attempt-1.json", securityReviewRef: "reviews/security-reviewer.attempt-1.json" };
}

function runGit(repo, args) { const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(proc.status, 0, proc.stderr); }
function gitOutput(repo, args) { const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(proc.status, 0, proc.stderr); return proc.stdout.trim(); }
function fileHash(file) { return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`; }
function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function updateRunFile(fixture, mutate) { const run = readRun(fixture); mutate(run); writeJson(join(fixture.runDir, "run.json"), run); }

function readRun(fixture) { return JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8")); }
