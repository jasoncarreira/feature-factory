import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  DEFAULT_GITHUB_MAX_BUFFER,
  DEFAULT_GITHUB_TIMEOUT_MS,
  MAX_GITHUB_MAX_BUFFER,
  MAX_GITHUB_TIMEOUT_MS,
  MAX_PR_OPERATION_PAGES,
  canonicalGithubRepositoryFromOrigin,
  computePrOperationId,
  github,
  lookupPullRequest,
  normalizePullRequestResponse,
  normalizeRecordedPullRequest,
  pullRequestLookupArgs,
  observePullRequestOperation,
  prOperationMarker,
  pullRequestOperationQueryArgs,
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

const OPERATION_ID = `ffpr-v1-${"1".repeat(64)}`;
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

function operationIdentity(overrides = {}) {
  return { repository: "acme/repo", operation_id: OPERATION_ID, head_ref: "feature/one", head_sha: HEAD_SHA, base_ref: "main", base_sha: BASE_SHA, draft: false, ...overrides };
}

function operationPull(overrides = {}) {
  return {
    html_url: "https://github.com/acme/repo/pull/7",
    number: 7,
    node_id: "PR_kwDO_operation",
    draft: false,
    body: `Summary\n\n${prOperationMarker(OPERATION_ID)}\n`,
    state: "open",
    merged_at: null,
    head: { ref: "feature/one", sha: HEAD_SHA, repo: { full_name: "acme/repo" } },
    base: { ref: "main", sha: BASE_SHA, repo: { full_name: "acme/repo" } },
    ...overrides,
  };
}

function included(body, link = null) {
  return `HTTP/2 200 OK\r\ncontent-type: application/json${link ? `\r\nlink: ${link}` : ""}\r\n\r\n${JSON.stringify(body)}`;
}

function operationPage(page, overrides = {}) {
  const query = new URLSearchParams({ state: "all", head: "acme:feature/one", base: "main", per_page: "100", page: String(page) });
  return `https://api.github.com/repos/acme/repo/pulls?${query.toString()}${overrides.suffix || ""}`;
}

test("computes ffpr-v1 from the exact lexical canonical JSON and accepts only canonical GitHub origins", () => {
  const source = { run_id: "run-1", repository: "Acme/Repo", created_at: "2026-07-17T12:00:00.000Z", branch: "feature/one", base_commit: BASE_SHA };
  const canonical = JSON.stringify({ base_commit: BASE_SHA, branch: "feature/one", created_at: source.created_at, repository: "acme/repo", run_id: "run-1" });
  const independent = `ffpr-v1-${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
  assert.equal(computePrOperationId(source), independent);
  assert.equal(prOperationMarker(independent), `<!-- opencode-feature-factory:pr-operation=${independent} -->`);
  for (const origin of ["https://github.com/Acme/Repo.git", "https://github.com/acme/repo", "git@github.com:Acme/Repo.git", "ssh://git@github.com/acme/repo.git"]) {
    assert.equal(canonicalGithubRepositoryFromOrigin(origin), "acme/repo", origin);
  }
  for (const origin of ["http://github.com/acme/repo.git", "https://git.example/acme/repo.git", "ssh://root@github.com/acme/repo.git", "https://github.com/acme/repo/issues", "file:///tmp/repo"]) {
    assert.throws(() => canonicalGithubRepositoryFromOrigin(origin), /canonical GitHub|exactly one GitHub/u, origin);
  }
});

test("builds the complete exact state-all operation GET and classifies exact marker states", async () => {
  assert.deepEqual(pullRequestOperationQueryArgs(operationIdentity()), [
    "api", "--method", "GET", "--include",
    "repos/acme/repo/pulls?state=all&head=acme%3Afeature%2Fone&base=main&per_page=100",
    "--header", "Accept:application/vnd.github+json",
  ]);
  for (const [state, mergedAt, disposition] of [["open", null, "open"], ["closed", "2026-07-17T12:30:00Z", "merged"], ["closed", null, "closed"]]) {
    const result = await observePullRequestOperation({ ...operationIdentity(), observePage: () => included([operationPull({ state, merged_at: mergedAt })]) });
    assert.equal(result.disposition, disposition);
    assert.deepEqual(Object.keys(result.pull_request), ["pr_url", "pr_number", "pr_node_id", "repository", "draft", "body", "state", "merged_at", "head_ref", "head_sha", "head_repository", "base_ref", "base_sha", "base_repository"]);
    assert.equal(result.pull_request.pr_node_id, "PR_kwDO_operation");
  }
});

test("classifies every malformed or conflicting own operation marker as ambiguous", async () => {
  for (const body of [
    `${prOperationMarker(OPERATION_ID)}\n${prOperationMarker(OPERATION_ID)}`,
    `prefix ${prOperationMarker(OPERATION_ID)}`,
    `${prOperationMarker(OPERATION_ID)}\n<!-- opencode-feature-factory:pr-operation=malformed -->`,
    `${prOperationMarker(OPERATION_ID)}\n<!-- opencode-feature-factory:pr-operation=ffpr-v1-${"2".repeat(64)} -->`,
  ]) {
    const result = await observePullRequestOperation({ ...operationIdentity(), observePage: () => included([operationPull({ body })]) });
    assert.equal(result.disposition, "ambiguous", body);
  }
  for (const pull of [
    operationPull({ html_url: "https://github.com/other/repo/pull/7", base: { ...operationPull().base, repo: { full_name: "other/repo" } } }),
    operationPull({ head: { ...operationPull().head, ref: "feature/other" } }),
    operationPull({ head: { ...operationPull().head, sha: "c".repeat(40) } }),
    operationPull({ base: { ...operationPull().base, ref: "release" } }),
    operationPull({ base: { ...operationPull().base, sha: "c".repeat(40) } }),
    operationPull({ draft: true }),
  ]) {
    const result = await observePullRequestOperation({ ...operationIdentity(), observePage: () => included([pull]) });
    assert.equal(result.disposition, "ambiguous");
  }
  for (const body of ["no marker", `<!-- opencode-feature-factory:pr-operation=ffpr-v1-${"2".repeat(64)} -->`, "<!-- opencode-feature-factory:pr-operation=malformed -->"]) {
    const result = await observePullRequestOperation({ ...operationIdentity(), observePage: () => included([operationPull({ body })]) });
    assert.equal(result.disposition, "absent", body);
  }
  const exact = await observePullRequestOperation({ ...operationIdentity(), observePage: () => included([operationPull()]) });
  assert.equal(exact.disposition, "open");
});

test("follows only same-host/path/filter Link pagination and rejects repeated, foreign, malformed, and capped traversal", async () => {
  const calls = [];
  const normal = await observePullRequestOperation({
    ...operationIdentity(),
    observePage({ page, pageUrl, args }) {
      calls.push({ page, pageUrl, args });
      return page === 1 ? included([], `<${operationPage(2)}>; rel="next"`) : included([operationPull()]);
    },
  });
  assert.equal(normal.disposition, "open");
  assert.equal(normal.pages, 2);
  assert.equal(calls[1].args[4], operationPage(2));

  for (const [label, first, second] of [
    ["foreign", "https://evil.example/repos/acme/repo/pulls?state=all&head=acme%3Afeature%2Fone&base=main&per_page=100&page=2", null],
    ["changed-filter", operationPage(2, { suffix: "&base=other" }), null],
    ["malformed", "not a URL", null],
    ["repeated", operationPage(2), operationPage(2)],
  ]) {
    const result = await observePullRequestOperation({ ...operationIdentity(), observePage: ({ page }) => included([], `<${page === 1 ? first : second}>; rel="next"`) });
    assert.equal(result.disposition, "unknown", label);
  }

  const capped = await observePullRequestOperation({ ...operationIdentity(), observePage: ({ page }) => included([], `<${operationPage(page + 1)}>; rel="next"`) });
  assert.equal(capped.disposition, "unknown");
  assert.equal(capped.reason, "pagination-cap-exceeded");
  assert.equal(MAX_PR_OPERATION_PAGES, 10);
});

test("validates every pagination relation, contiguous next pages, and full-page termination proof", async () => {
  const full = Array.from({ length: 100 }, (_, index) => operationPull({
    html_url: `https://github.com/acme/repo/pull/${index + 100}`,
    number: index + 100,
    node_id: `PR_page_${index}`,
    body: "ordinary PR",
  }));
  for (const [label, link] of [
    ["foreign-last", `<${operationPage(2)}>; rel="next", <https://evil.example/repos/acme/repo/pulls?state=all&head=acme%3Afeature%2Fone&base=main&per_page=100&page=4>; rel="last"`],
    ["page-jump", `<${operationPage(3)}>; rel="next"`],
    ["repeated-relation", `<${operationPage(2)}>; rel="next", <${operationPage(3)}>; rel="next"`],
  ]) {
    const result = await observePullRequestOperation({ ...operationIdentity(), observePage: () => included([], link) });
    assert.equal(result.disposition, "unknown", label);
  }
  const omitted = await observePullRequestOperation({ ...operationIdentity(), observePage: () => included(full) });
  assert.equal(omitted.disposition, "unknown");
  const omittedAnnounced = await observePullRequestOperation({
    ...operationIdentity(),
    observePage: ({ page }) => page === 1
      ? included([], `<${operationPage(2)}>; rel="next", <${operationPage(4)}>; rel="last"`)
      : included([]),
  });
  assert.equal(omittedAnnounced.disposition, "unknown");
  const proven = await observePullRequestOperation({ ...operationIdentity(), observePage: () => included(full, `<${operationPage(1)}>; rel="last"`) });
  assert.equal(proven.disposition, "absent");
});

test("returns unknown for incomplete output, adapter failures, duplicate records, and malformed strict tuples", async () => {
  for (const output of ["", "[]", "HTTP/2 500 Server Error\r\n\r\n[]", "HTTP/2 200 OK\r\n\r\nnot-json"]) {
    const result = await observePullRequestOperation({ ...operationIdentity(), observePage: () => output });
    assert.equal(result.disposition, "unknown");
  }
  for (const message of ["auth", "timeout", "output-cap", "protocol"]) {
    const result = await observePullRequestOperation({ ...operationIdentity(), observePage: () => { throw new Error(message); } });
    assert.equal(result.disposition, "unknown");
  }
  const duplicate = await observePullRequestOperation({ ...operationIdentity(), observePage: () => included([operationPull(), operationPull()]) });
  assert.equal(duplicate.disposition, "unknown");
  for (const malformed of [
    operationPull({ node_id: null }), operationPull({ number: "7" }), operationPull({ draft: "false" }), operationPull({ body: null }),
    operationPull({ state: "OPEN" }), operationPull({ merged_at: "bad" }), operationPull({ head: { ...operationPull().head, sha: "short" } }),
    operationPull({ base: { ...operationPull().base, repo: { full_name: "other/repo" } } }),
  ]) {
    const result = await observePullRequestOperation({ ...operationIdentity(), observePage: () => included([malformed]) });
    assert.equal(result.disposition, "unknown");
  }
});

test("accepts only null or canonical valid RFC3339 UTC merged_at values", async () => {
  for (const merged_at of ["2026-07-17T12:30:00Z", "2026-07-17T12:30:00.123Z"]) {
    const result = await observePullRequestOperation({ ...operationIdentity(), observePage: () => included([operationPull({ state: "closed", merged_at })]) });
    assert.equal(result.disposition, "merged", merged_at);
  }
  const missing = operationPull({ state: "closed" });
  delete missing.merged_at;
  for (const merged_at of [missing, 7, "not-a-time", "2026-07-17", "Fri, 17 Jul 2026 12:30:00 GMT", "0", "2026-02-30T12:30:00Z"]) {
    const pull = typeof merged_at === "object" ? merged_at : operationPull({ state: "closed", merged_at });
    const result = await observePullRequestOperation({ ...operationIdentity(), observePage: () => included([pull]) });
    assert.equal(result.disposition, "unknown", String(merged_at));
  }
  const contradictory = await observePullRequestOperation({ ...operationIdentity(), observePage: () => included([operationPull({ state: "open", merged_at: "2026-07-17T12:30:00Z" })]) });
  assert.equal(contradictory.disposition, "unknown");
});

test("distinguishes complete absence from ambiguous exact operation records", async () => {
  const absent = await observePullRequestOperation({ ...operationIdentity(), observePage: () => included([operationPull({ body: "ordinary PR" })]) });
  assert.equal(absent.disposition, "absent");
  const ambiguous = await observePullRequestOperation({ ...operationIdentity(), observePage: () => included([operationPull(), operationPull({ html_url: "https://github.com/acme/repo/pull/8", number: 8, node_id: "PR_other" })]) });
  assert.equal(ambiguous.disposition, "ambiguous");
});
