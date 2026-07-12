import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GITHUB_MAX_BUFFER,
  DEFAULT_GITHUB_TIMEOUT_MS,
  MAX_GITHUB_MAX_BUFFER,
  MAX_GITHUB_TIMEOUT_MS,
  github,
  lookupPullRequest,
  normalizePullRequestResponse,
  normalizeRecordedPullRequest,
  pullRequestLookupArgs,
} from "../src/github.js";

const cwd = process.cwd();

function response(overrides = {}) {
  return {
    html_url: "https://github.com/Owner/Repo/pull/42",
    number: 42,
    state: "closed",
    merged: true,
    base: {
      ref: "main",
      sha: "0123456789abcdef",
      repo: { full_name: "OWNER/REPO" },
    },
    ignored: "not projected",
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    pr_url: "https://github.com/OWNER/REPO/pull/42",
    terminal_result: {
      pr_url: "https://github.com/owner/repo/pull/42",
      repository: "Owner/Repo",
      pr_number: 42,
    },
    ...overrides,
  };
}

test("github uses a bounded noninteractive shell-free injectable command", () => {
  let invocation;
  const result = github(cwd, ["api", "user"], {
    timeout: MAX_GITHUB_TIMEOUT_MS + 1,
    maxBuffer: MAX_GITHUB_MAX_BUFFER + 1,
    spawnSync(file, args, options) {
      invocation = { file, args, options };
      return { status: 0, stdout: Buffer.from("ok"), stderr: "", signal: null };
    },
  });

  assert.equal(invocation.file, "gh");
  assert.deepEqual(invocation.args, ["api", "user"]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.timeout, MAX_GITHUB_TIMEOUT_MS);
  assert.equal(invocation.options.maxBuffer, MAX_GITHUB_MAX_BUFFER);
  assert.equal(invocation.options.env.GH_PROMPT_DISABLED, "1");
  assert.equal(invocation.options.env.GH_PAGER, "cat");
  assert.equal(invocation.options.env.PAGER, "cat");
  assert.deepEqual(result, {
    ok: true,
    status: 0,
    stdout: "ok",
    stderr: "",
    command: {
      file: "gh",
      cwd,
      args: ["api", "user"],
      shell: false,
      timeout: MAX_GITHUB_TIMEOUT_MS,
      maxBuffer: MAX_GITHUB_MAX_BUFFER,
    },
    error: null,
    signal: null,
  });
});

test("github applies defaults and converts spawn failures into bounded results", () => {
  const result = github(cwd, ["api", "user"], {
    timeout: 0,
    maxBuffer: Number.NaN,
    spawnSync() {
      throw new Error("spawn failed");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.error, "spawn failed");
  assert.equal(result.stderr, "spawn failed");
  assert.equal(result.command.timeout, DEFAULT_GITHUB_TIMEOUT_MS);
  assert.equal(result.command.maxBuffer, DEFAULT_GITHUB_MAX_BUFFER);
  assert.equal(result.signal, null);
});

test("github rejects malformed arguments before spawning", () => {
  let called = false;
  assert.throws(() => github(cwd, ["api", ""], { spawnSync() { called = true; } }), /non-empty string/u);
  assert.throws(() => github(cwd, ["api\0user"], { spawnSync() { called = true; } }), /NUL bytes/u);
  assert.equal(called, false);
});

test("builds the exact strict GET pull-request lookup command", () => {
  assert.deepEqual(pullRequestLookupArgs("Owner/Repo", 42), [
    "api",
    "--method",
    "GET",
    "repos/owner/repo/pulls/42",
    "--header",
    "Accept:application/vnd.github+json",
  ]);
});

test("R27 normalizes exact merged and closed pull-request responses", () => {
  assert.deepEqual(normalizePullRequestResponse(response()), {
    url: "https://github.com/owner/repo/pull/42",
    number: 42,
    state: "MERGED",
    repository: "owner/repo",
    base_ref: "main",
    base_sha: "0123456789abcdef",
  });
  assert.equal(normalizePullRequestResponse(response({ merged: false })).state, "CLOSED");
  assert.equal(normalizePullRequestResponse(response({ state: "open", merged: false })).state, "OPEN");
});

test("strict response normalization rejects missing, wrongly typed, and contradictory fields", () => {
  const invalid = [
    response({ html_url: undefined }),
    response({ number: "42" }),
    response({ state: "OPEN" }),
    response({ state: "open", merged: true }),
    response({ merged: "true" }),
    response({ base: { ref: "main", sha: "abc", repo: {} } }),
    response({ base: { ref: 1, sha: "abc", repo: { full_name: "owner/repo" } } }),
    response({ html_url: "https://github.com/owner/repo/pull/41" }),
    response({ base: { ref: "main", sha: "abc", repo: { full_name: "other/repo" } } }),
  ];
  for (const value of invalid) assert.throws(() => normalizePullRequestResponse(value));
});

test("normalizes and requires exact agreement across all recorded PR tuple fields", () => {
  assert.deepEqual(normalizeRecordedPullRequest(run()), {
    url: "https://github.com/owner/repo/pull/42",
    repository: "owner/repo",
    number: 42,
  });
  assert.throws(() => normalizeRecordedPullRequest(run({ pr_url: "https://github.com/owner/repo/pull/41" })));
  assert.throws(() => normalizeRecordedPullRequest(run({ terminal_result: { ...run().terminal_result, repository: "other/repo" } })));
  assert.throws(() => normalizeRecordedPullRequest(run({ terminal_result: { ...run().terminal_result, pr_number: 41 } })));
  assert.throws(() => normalizeRecordedPullRequest(run({ terminal_result: { ...run().terminal_result, pr_url: "https://github.com/owner/repo/pull/41" } })));
});

test("R25 returns lookup uncertainty for nonzero, malformed, or mismatched injected responses", () => {
  const outputs = [
    { ok: false, status: 1, stdout: "", command: { file: "gh" } },
    { ok: true, status: 0, stdout: "not json", command: { file: "gh" } },
    { ok: true, status: 0, stdout: JSON.stringify(response({ state: "open", merged: true })), command: { file: "gh" } },
    { ok: true, status: 0, stdout: JSON.stringify(response({ number: 43, html_url: "https://github.com/owner/repo/pull/43" })), command: { file: "gh" } },
  ];
  for (const output of outputs) {
    const result = lookupPullRequest(cwd, run(), { githubRunner: () => output });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "lookup-uncertain");
    assert.equal(result.pullRequest, null);
  }
  const thrown = lookupPullRequest(cwd, run(), { githubRunner: () => { throw new Error("timeout"); } });
  assert.deepEqual(thrown, { ok: false, reason: "lookup-uncertain", pullRequest: null, command: null });
});

test("does not invoke GitHub when canonical recorded metadata is inconsistent", () => {
  let calls = 0;
  const result = lookupPullRequest(cwd, run({ terminal_result: { ...run().terminal_result, pr_number: 7 } }), {
    githubRunner() {
      calls += 1;
    },
  });
  assert.deepEqual(result, { ok: false, reason: "metadata-mismatch", pullRequest: null, command: null });
  assert.equal(calls, 0);
});

test("R27 performs the exact injected lookup and returns only normalized response fields", () => {
  let invocation;
  const result = lookupPullRequest(cwd, run(), {
    timeout: 123,
    maxBuffer: 456,
    githubRunner(receivedCwd, args, options) {
      invocation = { receivedCwd, args, options };
      return { ok: true, status: 0, stdout: JSON.stringify(response()), command: { file: "gh" } };
    },
  });

  assert.deepEqual(invocation, {
    receivedCwd: cwd,
    args: pullRequestLookupArgs("owner/repo", 42),
    options: { timeout: 123, maxBuffer: 456 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.deepEqual(result.pullRequest, normalizePullRequestResponse(response()));
  assert.deepEqual(Object.keys(result.pullRequest), ["url", "number", "state", "repository", "base_ref", "base_sha"]);
});
