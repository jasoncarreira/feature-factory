import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PostPrCiError, aggregateObservation, buildFailureEvidenceInput, classifyGitHubFailure, classifyOwnership,
  decideObservationSchedule, decideTransientSchedule, encodeUntrustedMetadata, fetchChangedFiles,
  normalizeCheck, normalizeChecks, normalizePullRequestResponse, normalizeRepositoryPath, normalizeReview,
  queryPullRequest, runBoundedProcess, runGitHubOperation, validateLane,
} from "../src/post-pr-ci.js";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

describe("post-PR normalization", () => {
  it("normalizes every check family and applies red > pending > indeterminate > pass", () => {
    for (const status of ["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"]) assert.equal(normalizeCheck({ status }), "pending");
    for (const conclusion of ["SUCCESS", "NEUTRAL", "SKIPPED"]) assert.equal(normalizeCheck({ status: "COMPLETED", conclusion }), "pass");
    for (const conclusion of ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]) assert.equal(normalizeCheck({ status: "COMPLETED", conclusion }), "red");
    assert.equal(normalizeCheck({ status: "COMPLETED", conclusion: "STALE" }), "indeterminate");
    for (const [state, expected] of [["SUCCESS", "pass"], ["FAILURE", "red"], ["ERROR", "red"], ["PENDING", "pending"], ["EXPECTED", "pending"], ["NEW", "indeterminate"]]) {
      assert.equal(normalizeCheck({ __typename: "StatusContext", state }), expected);
    }
    const normalized = normalizeChecks([
      { name: "pass", status: "COMPLETED", conclusion: "SUCCESS" }, { name: "unknown", status: "COMPLETED" },
      { name: "wait", status: "IN_PROGRESS" }, { name: "fail", status: "COMPLETED", conclusion: "FAILURE" },
    ]);
    assert.equal(normalized.verdict, "red");
  });

  it("holds zero checks through grace and then marks them not applicable", () => {
    assert.equal(normalizeChecks([], { elapsedMs: 299_999, graceMs: 300_000 }).verdict, "not_started");
    assert.equal(normalizeChecks([], { elapsedMs: 300_000, graceMs: 300_000 }).verdict, "not_applicable");
  });

  it("uses latest current-head reviews, exact case-insensitive reviewer login, and dismissal", () => {
    const reviews = [
      review("Bot", "APPROVED", OTHER_SHA, "2026-01-01T00:00:00Z"),
      review("Bot", "APPROVED", SHA, "2026-01-02T00:00:00Z"),
      review("other", "CHANGES_REQUESTED", SHA, "2026-01-03T00:00:00Z"),
      review("other", "DISMISSED", SHA, "2026-01-04T00:00:00Z"),
      review("ignored", "COMMENTED", SHA, "2026-01-05T00:00:00Z", "never read this body"),
    ];
    assert.equal(normalizeReview({ reviews, expectedHeadSha: SHA, reviewerLogin: "bot" }).verdict, "pass");
    assert.equal(normalizeReview({ reviews: [], expectedHeadSha: SHA, reviewerLogin: "bot" }).verdict, "pending");
    assert.equal(normalizeReview({ reviews: [review("other", "CHANGES_REQUESTED", SHA, "2026-01-03T00:00:00Z")], expectedHeadSha: SHA, isDraft: true }).verdict, "red");
    assert.equal(normalizeReview({ reviews: [review("Bot", "APPROVED", SHA, "2026-01-02T00:00:00Z")], expectedHeadSha: SHA, reviewerLogin: "bot", isDraft: true }).verdict, "not_required");
  });

  it("applies external state, head, review-red, check-red, pending, and green precedence", () => {
    const base = { expectedHeadSha: SHA, headRefOid: SHA, state: "OPEN", checkVerdict: "pass", reviewVerdict: "pass" };
    assert.equal(aggregateObservation({ ...base, state: "MERGED", headRefOid: OTHER_SHA }).reason, "external-merge");
    assert.equal(aggregateObservation({ ...base, state: "CLOSED" }).verdict, "blocked");
    assert.equal(aggregateObservation({ ...base, headRefOid: OTHER_SHA }).reason, "head-mismatch");
    assert.equal(aggregateObservation({ ...base, checkVerdict: "red", reviewVerdict: "red" }).primary, "review");
    assert.equal(aggregateObservation({ ...base, checkVerdict: "red", reviewVerdict: "pass" }).verdict, "red");
    assert.equal(aggregateObservation({ ...base, checkVerdict: "pending" }).verdict, "pending");
    assert.equal(aggregateObservation(base).verdict, "green");
  });
});

describe("durable scheduling decisions", () => {
  it("produces persisted 30/45/68/102/120 second valid backoff and reset", () => {
    const now = Date.parse("2026-01-01T00:00:00Z"); const deadlineAt = now + 3_600_000;
    let current = 30_000;
    const observed = [];
    for (let count = 0; count < 5; count += 1) {
      const result = decideObservationSchedule({ now, deadlineAt, changed: false, currentIntervalMs: current, initialPollMs: 30_000, maxPollMs: 120_000, unchangedCount: count });
      observed.push(result.interval_ms); current = result.interval_ms;
    }
    assert.deepEqual(observed, [45_000, 68_000, 102_000, 120_000, 120_000]);
    assert.equal(decideObservationSchedule({ now, deadlineAt, changed: true, currentIntervalMs: current, initialPollMs: 30_000, maxPollMs: 120_000 }).interval_ms, 30_000);
  });

  it("caps schedules at the original deadline and distinguishes exhaustion", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    assert.equal(decideTransientSchedule({ now, deadlineAt: now + 70_000, consecutiveErrors: 1, maxTransientErrors: 12 }).interval_ms, 60_000);
    assert.equal(decideTransientSchedule({ now, deadlineAt: now + 700_000, consecutiveErrors: 1, maxTransientErrors: 12, rateLimited: true }).interval_ms, 600_000);
    assert.equal(decideTransientSchedule({ now, deadlineAt: now + 700_000, consecutiveErrors: 12, maxTransientErrors: 12 }).reason, "transient-exhausted");
    assert.equal(decideObservationSchedule({ now: now + 1, deadlineAt: now, changed: true, currentIntervalMs: 30_000, initialPollMs: 30_000, maxPollMs: 120_000 }).reason, "deadline");
  });
});

describe("untrusted metadata, paths, ownership, and evidence", () => {
  const slices = [
    { id: "be-api", stack: "backend", paths: ["src/api/**"] },
    { id: "fe-ui", stack: "frontend", paths: ["src/ui/**"] },
  ];

  it("base64url encodes hostile metadata with terminal-safe display", () => {
    const encoded = encodeUntrustedMetadata('x"\\\n🧨');
    assert.equal(Buffer.from(encoded.value_b64url, "base64url").toString(), 'x"\\\n🧨');
    assert.equal(encoded.display, 'x\\"\\\\\\u000A\\uD83E\\uDDE8');
    assert.match(encoded.sha256, /^sha256:[0-9a-f]{64}$/u);
  });

  it("accepts only unchanged repository-relative POSIX paths", () => {
    assert.equal(normalizeRepositoryPath("src/a.js"), "src/a.js");
    for (const path of ["/etc/passwd", "C:/x", "a\\b", "a/../b", "a//b", "a\0b"]) assert.throws(() => normalizeRepositoryPath(path), PostPrCiError);
  });

  it("classifies mutually exclusive owner and lane rows", () => {
    assert.equal(classifyOwnership({ slices, failingCheckNames: ["CI [be-api]"], paths: [] }).route, "backend-builder");
    assert.equal(classifyOwnership({ slices, failingCheckNames: ["build"], paths: ["src/ui/button.js"], complete: true }).route, "frontend-builder");
    assert.equal(classifyOwnership({ slices, failingCheckNames: ["tests"], paths: ["test/a.test.js"], complete: true }).route, "test-verifier");
    assert.equal(classifyOwnership({ slices, failingCheckNames: ["be-api", "fe-ui"], paths: [], complete: true }).disposition, "needs-human");
    assert.equal(classifyOwnership({ slices, reviewVerdict: "red", failingCheckNames: ["be-api"] }).route, null);
    assert.equal(classifyOwnership({ slices, failingCheckNames: ["build"], paths: ["package.json"], complete: true }).disposition, "needs-human");
    assert.equal(validateLane({ lane: "slice", slice: slices[0], paths: ["src/api/x.js"] }).ok, true);
    assert.equal(validateLane({ lane: "slice", slice: slices[0], paths: ["src/ui/x.js"] }).ok, false);
    assert.equal(validateLane({ lane: "test", paths: [".github/workflows/ci.yml"] }).ok, true);
    assert.equal(validateLane({ lane: "test", paths: ["test/x.js"], hasDelete: true }).ok, false);
  });

  it("constructs sorted deterministic sanitized evidence inputs", () => {
    const input = { runId: "run", attempt: 1, observedAt: "2026-01-01T00:00:00Z", prUrl: "https://github.com/o/r/pull/1", prNumber: 1,
      repository: "o/r", expectedHeadSha: SHA, observedHeadSha: SHA, failingChecks: [{ name: "z" }, { name: "a" }], review: null,
      ownership: classifyOwnership({ slices, failingCheckNames: ["be-api"] }), args: ["pr", "view", "1"], exitCode: 0 };
    const first = buildFailureEvidenceInput(input); const second = buildFailureEvidenceInput(input);
    assert.deepEqual(first, second);
    assert.equal(Buffer.from(first.failing_checks[0].name.value_b64url, "base64url").toString(), "a");
    assert.match(first.failure_fingerprint, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(JSON.stringify(first).includes("stderr"), false);
  });
});

describe("bounded GitHub execution", () => {
  it("runs mandatory switch immediately before one operation without a shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "post-pr-gh-")); const calls = [];
    try {
      const result = await runGitHubOperation({ repositoryRoot: root, account: "octocat", args: ["pr", "view", "1"], execute: async (input) => {
        calls.push(input); return { exitCode: 0, stdout: calls.length === 2 ? "{}" : "", stderr: "" };
      } });
      assert.equal(result.stdout, "{}");
      assert.deepEqual(calls.map((call) => call.args), [["auth", "switch", "-h", "github.com", "-u", "octocat"], ["pr", "view", "1"]]);
      assert.equal(calls.every((call) => call.executable === "gh"), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed on account switch and does not execute the operation", async () => {
    const root = mkdtempSync(join(tmpdir(), "post-pr-gh-")); let calls = 0;
    try {
      await assert.rejects(runGitHubOperation({ repositoryRoot: root, account: "octocat", args: ["pr", "view"], execute: async () => ({ exitCode: ++calls === 1 ? 1 : 0, stdout: "", stderr: "token" }) }),
        (error) => error.errorClass === "account-switch");
      assert.equal(calls, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("queries with checked identity and parses only bounded JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "post-pr-gh-")); const calls = [];
    try {
      const response = await queryPullRequest({ repositoryRoot: root, account: "octocat", repository: "o/r", prNumber: 7, execute: async (input) => {
        calls.push(input.args); return { exitCode: 0, stdout: input.args[0] === "pr" ? JSON.stringify({ headRefOid: SHA }) : "", stderr: "" };
      } });
      assert.equal(response.headRefOid, SHA);
      assert.deepEqual(calls[1].slice(0, 5), ["pr", "view", "7", "--repo", "o/r"]);
      await assert.rejects(queryPullRequest({ repositoryRoot: root, account: "octocat", repository: "-R", prNumber: 7 }), /invalid repository/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("enforces three ownership pages and reports incomplete pagination", async () => {
    const root = mkdtempSync(join(tmpdir(), "post-pr-gh-")); let operations = 0;
    try {
      const result = await fetchChangedFiles({ repositoryRoot: root, account: "octocat", repository: "o/r", prNumber: 7, execute: async (input) => {
        if (input.args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
        operations += 1; return { exitCode: 0, stdout: `HTTP/2 200\n\n${JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ filename: `test/p${operations}-${index}` })))}`, stderr: "" };
      } });
      assert.equal(result.complete, false); assert.equal(result.pages, 3); assert.equal(operations, 3); assert.equal(result.paths.length, 300);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("kills fake executables on stdout cap and timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "post-pr-exec-"));
    try {
      const noisy = fakeExecutable(root, "noisy", "process.stdout.write('x'.repeat(10000)); setTimeout(() => {}, 10000);");
      await assert.rejects(runBoundedProcess({ executable: noisy, args: [], cwd: root, timeoutMs: 1000, stdoutCap: 100, stderrCap: 100 }), (error) => error.errorClass === "protocol");
      const sleepy = fakeExecutable(root, "sleepy", "setTimeout(() => {}, 10000);");
      await assert.rejects(runBoundedProcess({ executable: sleepy, args: [], cwd: root, timeoutMs: 20, stdoutCap: 100, stderrCap: 100 }), (error) => error.errorClass === "timeout" && error.transient);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("classifies deterministic transient and permanent errors", () => {
    assert.equal(classifyGitHubFailure({ httpStatus: 429 }).errorClass, "rate-limit");
    assert.equal(classifyGitHubFailure({ httpStatus: 503 }).transient, true);
    assert.equal(classifyGitHubFailure({ message: "ECONNRESET" }).errorClass, "network");
    assert.equal(classifyGitHubFailure({ httpStatus: 401 }).errorClass, "account-auth");
    assert.equal(classifyGitHubFailure({ httpStatus: 403 }).errorClass, "permission");
    assert.equal(classifyGitHubFailure({ httpStatus: 404 }).errorClass, "not-found");
    assert.equal(classifyGitHubFailure({ exitCode: 2 }).errorClass, "command");
  });
});

describe("normalized response integration", () => {
  it("does not turn a long pending observation into red", () => {
    const result = normalizePullRequestResponse({ headRefOid: SHA, isDraft: false, reviewDecision: null, reviews: [], state: "OPEN",
      statusCheckRollup: [{ name: "CI", status: "IN_PROGRESS", conclusion: null }] },
    { expectedHeadSha: SHA, startedAt: "2026-01-01T00:00:00Z", now: "2026-01-01T00:25:00Z", checkStartGraceMs: 300_000, reviewRequired: false });
    assert.equal(result.aggregate.verdict, "pending");
  });
});

function review(login, state, oid, submittedAt, body) { return { author: { login }, state, commit: { oid }, submittedAt, body }; }
function fakeExecutable(root, name, body) {
  const bin = join(root, name); writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`, "utf8"); chmodSync(bin, 0o755); return bin;
}
