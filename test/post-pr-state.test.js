import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePostPrCiPolicy } from "../src/config.js";
import { hashFile, hashValue } from "../src/refs.js";
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
    const factBoundReasons = new Set(["post-pr-account-switch-failed", "post-pr-dispatch-start-unknown", "post-pr-path-lane-violation", "post-pr-remote-head-diverged"]);
    for (const [status, reasons] of Object.entries(POST_PR_TERMINAL_REASONS)) {
      for (const reason of reasons) {
        if (factBoundReasons.has(reason)) continue;
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
      const ref = "evidence/post-pr-ci.attempt-1.json";
      const fingerprint = `sha256:${"a".repeat(64)}`;
      writeJson(join(fixture.runDir, ref), { schema_version: 1, kind: "post-pr-ci", run_id: fixture.runId, attempt: 1, source: "check-red", verdict: "red", failed_head_sha: HEAD, failure_fingerprint: fingerprint });
      const hash = hashFile(join(fixture.runDir, ref));
      const next = remediation(1, "planned", { failure_evidence_ref: ref, failure_evidence_hash: hash, failure_fingerprint: fingerprint });
      const red = readJson(join(fixture.runDir, "run.json"));
      red.post_pr.observation.last_verdict = "red";
      red.post_pr.observation.last_check_verdict = "red";
      writeJson(join(fixture.runDir, "run.json"), red);
      const reserved = await transitionPostPrFailure(fixture.runDir, { remediation: next }, { now: NOW });
      assert.equal(reserved.run.post_pr.attempt, 1);
      assert.equal(reserved.run.post_pr.phase, "failure-recording");
      const replay = await transitionPostPrFailure(fixture.runDir, { remediation: next }, { now: NOW });
      assert.equal(replay.updated, false);
      for (const conflict of [
        { ...next, failure_fingerprint: `sha256:${"b".repeat(64)}` },
        { ...next, failed_head_sha: "b".repeat(40) },
        { ...next, reason_code: "local-red" },
        { ...next, failure_evidence_hash: `sha256:${"b".repeat(64)}` },
        { ...next, route: "test-verifier" },
      ]) await assert.rejects(transitionPostPrFailure(fixture.runDir, { remediation: conflict }), /mismatch|conflicting post-PR failure replay/u);

      const planned = { ...reserved.run.post_pr, phase: "remediation-planned", remediation: { ...next, stage: "planned" } };
      assert.equal((await transitionPostPrState(fixture.runDir, planned)).run.post_pr.phase, "remediation-planned");
      const decremented = { ...planned, attempt: 0, remediation: null };
      await assert.rejects(transitionPostPrState(fixture.runDir, decremented), /attempt changes must use transitionPostPrFailure/u);
      await assert.rejects(transitionPostPrFailure(fixture.runDir, { remediation: { ...next, attempt: 2 } }), /requires observing phase/u);

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
      const green = readJson(join(fixture.runDir, "run.json"));
      green.post_pr.observation.last_verdict = "green";
      green.post_pr.observation.last_check_verdict = "pass";
      writeJson(join(fixture.runDir, "run.json"), green);
      const done = await transitionPostPrTerminal(fixture.runDir, { status: "completed", reason: "post-pr-ci-green" }, { now: NOW });
      assert.equal(done.run.post_pr.phase, "succeeded");
      await assert.rejects(transitionPostPrState(fixture.runDir, done.run.post_pr), /terminal run/u);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("guards persisted policy, PR identity, account, retry budget, and same-epoch progress", async () => {
    for (const [name, mutateRun, match] of [
      ["policy", (run) => { run.post_pr.policy.wait_ms += 1; }, /persisted post-PR state/u],
      ["pr-url", (run) => { run.pr_url = "https://github.com/acme/repo/pull/8"; }, /post-PR pr_url/u],
      ["account", (run) => { run.github_account = "other"; }, /post-PR github_account/u],
      ["budget", (run) => { run.max_retries = 99; }, /post-PR max_retries/u],
    ]) {
      const fixture = createActiveFixture(`guard-${name}`);
      try { await assert.rejects(transitionRunJson(fixture.runDir, mutateRun), match); }
      finally { rmSync(fixture.repo, { recursive: true, force: true }); }
    }

    for (const [name, mutatePostPr, match] of [
      ["head", (postPr) => { postPr.observation.expected_head_sha = "b".repeat(40); }, /expected_head_sha is immutable/u],
      ["started", (postPr) => { postPr.observation.started_at = "2026-07-12T11:00:00.000Z"; }, /started_at is immutable/u],
      ["deadline", (postPr) => { postPr.observation.deadline_at = "2026-07-12T14:00:00.000Z"; }, /deadline_at is immutable/u],
      ["poll", (postPr) => { postPr.observation.poll_count = -1; }, /poll_count cannot decrease/u],
      ["epoch", (postPr) => { postPr.observation.epoch = 2; }, /epoch can advance only/u],
    ]) {
      const fixture = createActiveFixture(`monotonic-${name}`);
      try {
        const next = structuredClone(readJson(join(fixture.runDir, "run.json")).post_pr);
        mutatePostPr(next);
        await assert.rejects(transitionPostPrState(fixture.runDir, next), match);
      } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
    }

    for (const [name, mutatePostPr, match] of [
      ["unchanged", (postPr) => { postPr.observation.unchanged_count = 1; }, /unchanged_count cannot decrease/u],
      ["transient", (postPr) => { postPr.observation.consecutive_transient_errors = 1; }, /transient error counter/u],
      ["next-poll", (postPr) => { postPr.observation.next_poll_at = "2026-07-12T11:59:00.000Z"; }, /next_poll_at cannot move backwards/u],
    ]) {
      const fixture = createActiveFixture(`counter-${name}`);
      try {
        const run = readJson(join(fixture.runDir, "run.json"));
        run.post_pr.observation.poll_count = 3;
        run.post_pr.observation.unchanged_count = 2;
        run.post_pr.observation.consecutive_transient_errors = 2;
        run.post_pr.observation.last_fingerprint = `sha256:${"d".repeat(64)}`;
        run.post_pr.observation.last_error = { class: "network", exit_code: null, occurred_at: NOW, next_retry_at: "2026-07-12T12:01:00.000Z" };
        writeJson(join(fixture.runDir, "run.json"), run);
        const next = structuredClone(run.post_pr);
        mutatePostPr(next);
        await assert.rejects(transitionPostPrState(fixture.runDir, next), match);
      } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
    }
  });

  it("requires failure phase, source, current head, exact evidence bytes, and immutable remediation identity", async () => {
    const fixture = createActiveFixture("failure-contract");
    try {
      const next = prepareCheckRedFailure(fixture, 1);
      const wrongHead = { ...next, failed_head_sha: "b".repeat(40) };
      await assert.rejects(transitionPostPrFailure(fixture.runDir, { remediation: wrongHead }), /current expected observation head/u);

      const wrongSource = { ...next, reason_code: "local-red" };
      await assert.rejects(transitionPostPrFailure(fixture.runDir, { remediation: wrongSource }), /local-red failure requires revalidating/u);

      const reserved = await transitionPostPrFailure(fixture.runDir, { remediation: next });
      writeFileSync(join(fixture.runDir, next.failure_evidence_ref), `${readFileSync(join(fixture.runDir, next.failure_evidence_ref), "utf8")} `);
      await assert.rejects(transitionPostPrFailure(fixture.runDir, { remediation: next }), /exact-byte hash mismatch/u);
      writeFileSync(join(fixture.runDir, next.failure_evidence_ref), JSON.stringify(failureEvidence(fixture.runId, next)));
      next.failure_evidence_hash = hashFile(join(fixture.runDir, next.failure_evidence_ref));
      assert.notEqual(next.failure_evidence_hash, reserved.run.post_pr.remediation.failure_evidence_hash, "rewritten bytes must produce a conflicting replay hash");
      await assert.rejects(transitionPostPrFailure(fixture.runDir, { remediation: next }), /conflicting post-PR failure replay/u);

      const current = readJson(join(fixture.runDir, "run.json")).post_pr;
      for (const [field, value] of [["route", "test-verifier"], ["failure_evidence_ref", "evidence/other.json"], ["baseline_head_sha", "c".repeat(40)]]) {
        const conflict = structuredClone(current);
        conflict.remediation[field] = value;
        await assert.rejects(transitionPostPrState(fixture.runDir, conflict), /immutable within an attempt/u);
      }
      const reset = structuredClone(current);
      const uncounted = structuredClone(reset);
      uncounted.phase = "revalidating";
      uncounted.remediation.stage = "revalidating";
      writeJson(join(fixture.runDir, "run.json"), { ...readJson(join(fixture.runDir, "run.json")), post_pr: uncounted });
      await assert.rejects(transitionPostPrState(fixture.runDir, { ...uncounted, phase: "remediation-planned", remediation: { ...uncounted.remediation, stage: "planned" } }), /invalid post-PR phase transition/u);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("accepts local-red only from revalidation on the current candidate and advances exactly once", async () => {
    const fixture = createActiveFixture("local-red-source");
    try {
      const first = prepareCheckRedFailure(fixture, 1);
      const reserved = await transitionPostPrFailure(fixture.runDir, { remediation: first });
      const candidate = "b".repeat(40);
      const revalidating = structuredClone(reserved.run);
      revalidating.post_pr.phase = "revalidating";
      revalidating.post_pr.remediation.stage = "revalidating";
      revalidating.post_pr.remediation.candidate_head_sha = candidate;
      writeJson(join(fixture.runDir, "run.json"), revalidating);

      const local = remediation(2, "planned", { reason_code: "local-red", failed_head_sha: candidate, baseline_head_sha: candidate, failure_evidence_ref: "evidence/post-pr-ci.attempt-2.json" });
      writeJson(join(fixture.runDir, local.failure_evidence_ref), failureEvidence(fixture.runId, local));
      local.failure_evidence_hash = hashFile(join(fixture.runDir, local.failure_evidence_ref));
      const wrong = { ...local, failed_head_sha: "c".repeat(40) };
      await assert.rejects(transitionPostPrFailure(fixture.runDir, { remediation: wrong }), /current remediation candidate head/u);
      const result = await transitionPostPrFailure(fixture.runDir, { remediation: local });
      assert.equal(result.run.post_pr.attempt, 2);
      assert.equal(result.run.post_pr.remediation.reason_code, "local-red");
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("rejects an exact failure replay after observation moved to a different head/source context", async () => {
    const fixture = createActiveFixture("stale-failure-replay");
    try {
      const failure = prepareCheckRedFailure(fixture, 1);
      const reserved = await transitionPostPrFailure(fixture.runDir, { remediation: failure });
      const moved = structuredClone(reserved.run);
      moved.post_pr.phase = "observing";
      moved.post_pr.observation.epoch = 2;
      moved.post_pr.observation.expected_head_sha = "b".repeat(40);
      moved.post_pr.observation.started_at = "2026-07-12T14:00:00.000Z";
      moved.post_pr.observation.deadline_at = "2026-07-12T15:00:00.000Z";
      moved.post_pr.observation.next_poll_at = "2026-07-12T14:00:00.000Z";
      moved.post_pr.observation.last_check_verdict = "not_started";
      moved.post_pr.observation.last_verdict = "pending";
      writeJson(join(fixture.runDir, "run.json"), moved);
      await assert.rejects(transitionPostPrFailure(fixture.runDir, { remediation: failure }), /stale post-PR failure replay/u);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("rejects every terminal reason without its reason-specific durable preconditions", async () => {
    for (const [status, reasons] of Object.entries(POST_PR_TERMINAL_REASONS)) {
      for (const reason of reasons) {
        const fixture = createActiveFixture(`terminal-${reason}`);
        try {
          await assert.rejects(transitionPostPrTerminal(fixture.runDir, { status, reason }, { now: NOW }), /requires/u, reason);
          assert.equal(readJson(join(fixture.runDir, "run.json")).status, "running", reason);
        } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
      }
    }
  });

  it("atomically hash-binds the exhaustion continuation review and rejects conflicts without terminalizing", async () => {
    const fixture = createActiveFixture("retry-exhaustion");
    try {
      const run = readJson(join(fixture.runDir, "run.json"));
      run.max_retries = 1;
      writeJson(join(fixture.runDir, "run.json"), run);
      const failure = prepareCheckRedFailure(fixture, 1);
      const reserved = await transitionPostPrFailure(fixture.runDir, { remediation: failure });
      mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
      const reviewRef = "reviews/post-pr-ci.attempt-1.json";
      const postPrForHash = structuredClone(reserved.run.post_pr);
      delete postPrForHash.continuation_review;
      writeJson(join(fixture.runDir, reviewRef), {
        kind: "post-pr-continuation", subject: fixture.runId, verdict: "BLOCKED", attempt: 1, reason: "post-pr-retry-exhausted", route: failure.route,
        evidence_ref: failure.failure_evidence_ref, evidence_hash: failure.failure_evidence_hash, post_pr_hash: hashValue(postPrForHash),
        pr_url: reserved.run.pr_url, repository: "acme/repo", pr_number: 7, head_sha: HEAD, pr_disposition: "leave-unchanged", summary: "Retry budget exhausted.", required_fixes: [],
      });
      const binding = { ref: reviewRef, hash: hashFile(join(fixture.runDir, reviewRef)) };
      await assert.rejects(transitionPostPrTerminal(fixture.runDir, { status: "blocked", reason: "post-pr-retry-exhausted", continuation_review: { ...binding, hash: `sha256:${"f".repeat(64)}` } }), /exact-byte hash mismatch/u);
      assert.equal(readJson(join(fixture.runDir, "run.json")).post_pr.continuation_review, null);

      const result = await transitionPostPrTerminal(fixture.runDir, { status: "blocked", reason: "post-pr-retry-exhausted", continuation_review: binding });
      assert.equal(result.run.status, "blocked");
      assert.deepEqual(result.run.post_pr.continuation_review, binding);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("requires and persists the exact account-switch failure fact", async () => {
    const fixture = createActiveFixture("account-switch-fact");
    try {
      const run = readJson(join(fixture.runDir, "run.json"));
      run.github_account = "octocat";
      run.post_pr.observation.last_error = { class: "command", exit_code: 1, occurred_at: NOW, next_retry_at: null };
      writeJson(join(fixture.runDir, "run.json"), run);
      const input = { status: "needs-human", reason: "post-pr-account-switch-failed" };
      await assert.rejects(transitionPostPrTerminal(fixture.runDir, input), /requires persisted account-switch-failed trigger fact/u);
      const fact = { schema_version: 1, kind: "account-switch-failed", observed_at: NOW, operation: "gh-auth-switch", github_account: "octocat", error_class: "command", exit_code: 1 };
      await assert.rejects(transitionPostPrTerminal(fixture.runDir, { ...input, trigger_fact: { ...fact, github_account: "other" } }), /must match run.github_account/u);
      const result = await transitionPostPrTerminal(fixture.runDir, { ...input, trigger_fact: fact });
      assert.deepEqual(result.run.post_pr.terminal_fact, fact);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("requires and persists the exact unknown-dispatch fact", async () => {
    const fixture = createActiveFixture("dispatch-unknown-fact");
    try {
      const run = await prepareTerminalRemediation(fixture, "remediation-running", "running");
      run.post_pr.remediation.dispatch.status = "running";
      run.post_pr.remediation.dispatch.started_at = NOW;
      writeJson(join(fixture.runDir, "run.json"), run);
      const input = { status: "needs-human", reason: "post-pr-dispatch-start-unknown" };
      await assert.rejects(transitionPostPrTerminal(fixture.runDir, input), /requires persisted dispatch-start-unknown trigger fact/u);
      const fact = { schema_version: 1, kind: "dispatch-start-unknown", observed_at: "2026-07-12T12:05:00.000Z", attempt: 1, dispatch_id: run.post_pr.remediation.dispatch.id, dispatch_started_at: NOW, outcome: "return-unknown" };
      await assert.rejects(transitionPostPrTerminal(fixture.runDir, { ...input, trigger_fact: { ...fact, dispatch_id: "other" } }), /bind the running dispatch identity exactly/u);
      const result = await transitionPostPrTerminal(fixture.runDir, { ...input, trigger_fact: fact });
      assert.deepEqual(result.run.post_pr.terminal_fact, fact);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("requires and persists the exact path-lane violation fact", async () => {
    const fixture = createActiveFixture("path-lane-fact");
    try {
      const run = await prepareTerminalRemediation(fixture, "changes-observed", "changes-observed");
      run.post_pr.remediation.dispatch.status = "returned";
      run.post_pr.remediation.dispatch.started_at = NOW;
      run.post_pr.remediation.dispatch.returned_at = "2026-07-12T12:01:00.000Z";
      run.post_pr.remediation.changes = { paths: ["package.json"], tree_hash: null };
      writeJson(join(fixture.runDir, "run.json"), run);
      const input = { status: "needs-human", reason: "post-pr-path-lane-violation" };
      await assert.rejects(transitionPostPrTerminal(fixture.runDir, input), /requires persisted path-lane-violation trigger fact/u);
      const fact = { schema_version: 1, kind: "path-lane-violation", observed_at: "2026-07-12T12:02:00.000Z", attempt: 1, lane: "slice", source: "remediation-diff", violation: "outside-lane", path_b64url: Buffer.from("package.json").toString("base64url"), changes_hash: hashValue(run.post_pr.remediation.changes) };
      await assert.rejects(transitionPostPrTerminal(fixture.runDir, { ...input, trigger_fact: { ...fact, path_b64url: Buffer.from("other.json").toString("base64url") } }), /identify a persisted changed path/u);
      const result = await transitionPostPrTerminal(fixture.runDir, { ...input, trigger_fact: fact });
      assert.deepEqual(result.run.post_pr.terminal_fact, fact);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("requires and persists exact remote divergence heads", async () => {
    const fixture = createActiveFixture("remote-diverged-fact");
    try {
      const run = await preparePushPendingState(fixture);
      writeJson(join(fixture.runDir, "run.json"), run);
      const input = { status: "needs-human", reason: "post-pr-remote-head-diverged" };
      await assert.rejects(transitionPostPrTerminal(fixture.runDir, input), /requires persisted remote-head-diverged trigger fact/u);
      const fact = { schema_version: 1, kind: "remote-head-diverged", observed_at: "2026-07-12T12:03:00.000Z", attempt: 1, expected_remote_sha: "c".repeat(40), candidate_head_sha: "b".repeat(40), observed_remote_sha: "d".repeat(40) };
      await assert.rejects(transitionPostPrTerminal(fixture.runDir, { ...input, trigger_fact: { ...fact, observed_remote_sha: fact.expected_remote_sha } }), /must differ from both expected remote and candidate heads/u);
      const result = await transitionPostPrTerminal(fixture.runDir, { ...input, trigger_fact: fact });
      assert.deepEqual(result.run.post_pr.terminal_fact, fact);
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
  return { repo, runDir, runId };
}

function prepareCheckRedFailure(fixture, attempt) {
  const run = readJson(join(fixture.runDir, "run.json"));
  run.post_pr.observation.last_verdict = "red";
  run.post_pr.observation.last_check_verdict = "red";
  writeJson(join(fixture.runDir, "run.json"), run);
  mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
  const value = remediation(attempt, "planned", { failure_evidence_ref: `evidence/post-pr-ci.attempt-${attempt}.json` });
  writeJson(join(fixture.runDir, value.failure_evidence_ref), failureEvidence(fixture.runId, value));
  value.failure_evidence_hash = hashFile(join(fixture.runDir, value.failure_evidence_ref));
  return value;
}

function failureEvidence(runId, value) {
  return { schema_version: 1, kind: "post-pr-ci", run_id: runId, attempt: value.attempt, source: value.reason_code, verdict: "red", failed_head_sha: value.failed_head_sha, failure_fingerprint: value.failure_fingerprint };
}

async function prepareTerminalRemediation(fixture, phase, stage) {
  const failure = prepareCheckRedFailure(fixture, 1);
  const reserved = await transitionPostPrFailure(fixture.runDir, { remediation: failure });
  const run = structuredClone(reserved.run);
  run.post_pr.phase = phase;
  run.post_pr.remediation.stage = stage;
  return run;
}

async function preparePushPendingState(fixture) {
  const run = await prepareTerminalRemediation(fixture, "push-pending", "push-pending");
  for (const dir of ["evidence", "reviews"]) mkdirSync(join(fixture.runDir, dir), { recursive: true });
  const refs = {
    canonical: "evidence/post-pr-canonical.attempt-1.json",
    validator: "reviews/post-pr-validator.attempt-1.json",
    security: "reviews/post-pr-security.attempt-1.json",
  };
  writeJson(join(fixture.runDir, refs.canonical), { verdict: "pass" });
  writeJson(join(fixture.runDir, refs.validator), { verdict: "GO" });
  writeJson(join(fixture.runDir, refs.security), { verdict: "PASS" });
  run.post_pr.remediation.candidate_head_sha = "b".repeat(40);
  run.post_pr.remediation.revalidation = {
    canonical_evidence_ref: refs.canonical, canonical_evidence_hash: hashFile(join(fixture.runDir, refs.canonical)), canonical_verdict: "pass",
    validator_review_ref: refs.validator, validator_review_hash: hashFile(join(fixture.runDir, refs.validator)), validator_verdict: "GO",
    security_review_ref: refs.security, security_review_hash: hashFile(join(fixture.runDir, refs.security)), security_verdict: "PASS",
  };
  run.post_pr.remediation.push = { status: "pending", remote_before_sha: "c".repeat(40), local_head_sha: "b".repeat(40), remote_after_sha: null, consecutive_transient_errors: 0, next_retry_at: null, pushed_at: null };
  return run;
}

function mutate(value, fn) { const copy = structuredClone(value); fn(copy); return copy; }
function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
