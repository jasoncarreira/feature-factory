import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postPrObserve, status } from "../src/factory.js";

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
});

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

function readRun(fixture) { return JSON.parse(readFileSync(join(fixture.runDir, "run.json"), "utf8")); }
