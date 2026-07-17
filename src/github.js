import { spawnSync as defaultSpawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { runGitHubOperation } from "./post-pr-ci.js";

export const DEFAULT_GITHUB_TIMEOUT_MS = 10_000;
export const MAX_GITHUB_TIMEOUT_MS = 30_000;
export const DEFAULT_GITHUB_MAX_BUFFER = 1024 * 1024;
export const MAX_GITHUB_MAX_BUFFER = 8 * 1024 * 1024;
export const MAX_PR_OPERATION_PAGES = 10;
const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const PR_OPERATION_ID_PATTERN = /^ffpr-v1-[0-9a-f]{64}$/u;

export function github(cwd, args, options = {}) {
  const resolvedCwd = resolve(requireNonEmptyString(cwd, "cwd"));
  const commandArgs = normalizeArgs(args);
  const timeout = boundedPositiveInteger(options.timeout, DEFAULT_GITHUB_TIMEOUT_MS, MAX_GITHUB_TIMEOUT_MS);
  const maxBuffer = boundedPositiveInteger(options.maxBuffer, DEFAULT_GITHUB_MAX_BUFFER, MAX_GITHUB_MAX_BUFFER);
  const spawn = typeof options.spawnSync === "function" ? options.spawnSync : defaultSpawnSync;
  const command = {
    file: "gh",
    cwd: resolvedCwd,
    args: commandArgs,
    shell: false,
    timeout,
    maxBuffer,
  };

  try {
    const proc = spawn("gh", commandArgs, {
      cwd: resolvedCwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GH_PAGER: "cat",
        PAGER: "cat",
      },
      shell: false,
      timeout,
      maxBuffer,
      windowsHide: true,
    }) || {};
    const status = Number.isInteger(proc.status) ? proc.status : null;
    const error = proc.error ? normalizeError(proc.error) : null;
    return {
      ok: error === null && status === 0,
      status,
      stdout: normalizeOutput(proc.stdout),
      stderr: joinErrorOutput(proc.stderr, error),
      command,
      error,
      signal: typeof proc.signal === "string" ? proc.signal : null,
    };
  } catch (caught) {
    const error = normalizeError(caught);
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: error,
      command,
      error,
      signal: null,
    };
  }
}

export function computePrOperationId(value) {
  const input = requireRecord(value, "PR operation identity");
  const canonical = {
    base_commit: requireFullGitSha(input.base_commit, "PR operation base_commit"),
    branch: requireGitHubRef(input.branch, "PR operation branch"),
    created_at: requireTimestamp(input.created_at, "PR operation created_at"),
    repository: normalizeRepository(input.repository),
    run_id: requireNonEmptyString(input.run_id, "PR operation run_id"),
  };
  const digest = createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
  return `ffpr-v1-${digest}`;
}

export function prOperationMarker(operationId) {
  const normalized = normalizePrOperationId(operationId);
  return `<!-- opencode-feature-factory:pr-operation=${normalized} -->`;
}

export function canonicalGithubRepositoryFromOrigin(value) {
  const origin = requireNonEmptyString(value, "GitHub origin URL");
  const scp = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(origin);
  if (scp) return normalizeRepository(`${scp[1]}/${scp[2]}`);
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error("origin must be a canonical GitHub HTTPS or SSH URL"); }
  const https = parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  const ssh = parsed.protocol === "ssh:" && parsed.username === "git" && parsed.password === "";
  if ((!https && !ssh) || parsed.hostname !== "github.com" || parsed.port !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("origin must be a canonical GitHub HTTPS or SSH URL");
  }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(parsed.pathname);
  if (!match) throw new Error("origin must identify exactly one GitHub owner/repository");
  return normalizeRepository(`${match[1]}/${match[2]}`);
}

export function pullRequestOperationQueryArgs(identity, pageUrl = null) {
  const input = normalizePrOperationQueryIdentity(identity);
  const endpoint = pageUrl === null ? initialPrOperationEndpoint(input) : normalizePrOperationPageUrl(pageUrl, input).href;
  return ["api", "--method", "GET", "--include", endpoint, "--header", "Accept:application/vnd.github+json"];
}

/**
 * Reconcile one fenced PR-create operation through the bounded account-switched
 * GitHub adapter. The result is deliberately a disposition rather than an
 * exception: transport, authentication, pagination, and protocol uncertainty
 * must retain the caller's durable fence.
 */
export async function observePullRequestOperation(input) {
  let identity;
  try { identity = normalizePrOperationQueryIdentity(input); } catch (error) {
    return unknownObservation("invalid-query-identity", error);
  }
  const executePage = typeof input.observePage === "function" ? input.observePage : defaultObservePrOperationPage;
  const records = [];
  const visited = new Set();
  let pageUrl = null;
  let announcedLastPage = null;
  try {
    for (let page = 1; page <= MAX_PR_OPERATION_PAGES; page += 1) {
      const pageKey = pageUrl === null ? initialPrOperationUrl(identity).href : normalizePrOperationPageUrl(pageUrl, identity).href;
      if (visited.has(pageKey)) return unknownObservation("repeated-pagination-url");
      visited.add(pageKey);
      const output = await executePage({ ...input, identity, page, pageUrl, args: pullRequestOperationQueryArgs(identity, pageUrl) });
      const included = parseIncludedPullRequestPage(output);
      const links = normalizePrOperationLinks(included.links, identity, page);
      if (links.last !== null) {
        if (announcedLastPage !== null && announcedLastPage !== links.last) return unknownObservation("pagination-last-page-changed");
        announcedLastPage = links.last;
      }
      for (const item of included.body) records.push(item);
      if (links.next === null) {
        if (announcedLastPage !== null && announcedLastPage !== page) return unknownObservation("pagination-omitted-pages");
        if (included.body.length === 100 && announcedLastPage !== page) return unknownObservation("pagination-incomplete");
        return classifyPrOperationRecords(records, identity, page);
      }
      if (announcedLastPage !== null && links.next > announcedLastPage) return unknownObservation("pagination-past-last-page");
      if (page === MAX_PR_OPERATION_PAGES) return unknownObservation("pagination-cap-exceeded");
      pageUrl = links.nextUrl;
    }
  } catch (error) {
    return unknownObservation("github-observation-unknown", error);
  }
  return unknownObservation("pagination-incomplete");
}

async function defaultObservePrOperationPage(input) {
  const result = await runGitHubOperation({
    repositoryRoot: input.repositoryRoot,
    cwd: input.cwd ?? input.repositoryRoot,
    account: input.account,
    executable: input.executable,
    execute: input.execute,
    spawnImpl: input.spawnImpl,
    lockOptions: input.lockOptions,
    args: input.args,
    limits: input.limits,
  });
  return result.stdout;
}

function normalizePrOperationQueryIdentity(value) {
  const input = requireRecord(value, "PR operation query identity");
  const repository = normalizeRepository(input.repository);
  const [owner] = repository.split("/");
  const headRef = requireGitHubRef(input.head_ref ?? input.headRef, "PR operation head_ref");
  const baseRef = requireGitHubRef(input.base_ref ?? input.baseRef, "PR operation base_ref");
  const expectedHeadSha = requireFullGitSha(input.head_sha ?? input.headSha, "PR operation head_sha");
  const expectedBaseSha = requireFullGitSha(input.base_sha ?? input.baseSha, "PR operation base_sha");
  if (typeof input.draft !== "boolean") throw new Error("PR operation draft must be a boolean");
  return Object.freeze({
    repository,
    owner,
    head_ref: headRef,
    head_sha: expectedHeadSha,
    base_ref: baseRef,
    base_sha: expectedBaseSha,
    draft: input.draft,
    operation_id: normalizePrOperationId(input.operation_id ?? input.operationId),
  });
}

function initialPrOperationEndpoint(identity) {
  const query = operationQuery(identity);
  return `repos/${identity.repository}/pulls?${query.toString()}`;
}

function initialPrOperationUrl(identity) {
  return new URL(`https://api.github.com/${initialPrOperationEndpoint(identity)}`);
}

function operationQuery(identity) {
  return new URLSearchParams([
    ["state", "all"],
    ["head", `${identity.owner}:${identity.head_ref}`],
    ["base", identity.base_ref],
    ["per_page", "100"],
  ]);
}

function normalizePrOperationPageUrl(value, identity) {
  let parsed;
  try { parsed = new URL(requireNonEmptyString(value, "GitHub pagination URL")); } catch { throw new Error("GitHub pagination URL is invalid"); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.github.com" || parsed.port !== "" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    throw new Error("GitHub pagination URL has a foreign origin");
  }
  if (parsed.pathname !== `/repos/${identity.repository}/pulls`) throw new Error("GitHub pagination URL has a foreign path");
  const expected = operationQuery(identity);
  for (const key of ["state", "head", "base", "per_page"]) {
    const values = parsed.searchParams.getAll(key);
    if (values.length !== 1 || values[0] !== expected.get(key)) throw new Error(`GitHub pagination URL changed ${key}`);
  }
  const pageValues = parsed.searchParams.getAll("page");
  if (pageValues.length !== 1 || !/^[1-9][0-9]*$/u.test(pageValues[0])) throw new Error("GitHub pagination URL requires one positive page");
  const allowed = new Set(["state", "head", "base", "per_page", "page"]);
  for (const key of parsed.searchParams.keys()) if (!allowed.has(key)) throw new Error("GitHub pagination URL has an unknown filter");
  parsed.hostname = "api.github.com";
  return parsed;
}

function parseIncludedPullRequestPage(output) {
  const text = typeof output === "string" ? output : output?.stdout;
  if (typeof text !== "string" || text === "") throw new Error("GitHub response output is missing");
  const match = /\r?\n\r?\n/u.exec(text);
  if (!match) throw new Error("GitHub included response has no header boundary");
  const headerText = text.slice(0, match.index);
  const bodyText = text.slice(match.index + match[0].length);
  const lines = headerText.split(/\r?\n/u);
  if (!/^HTTP\/\S+ 200(?:\s|$)/u.test(lines.shift() || "")) throw new Error("GitHub included response status is not 200");
  const headers = new Map();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error("GitHub included response header is malformed");
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[a-z0-9-]+$/u.test(name) || headers.has(name)) throw new Error("GitHub included response headers are malformed or repeated");
    headers.set(name, value);
  }
  let body;
  try { body = JSON.parse(bodyText); } catch { throw new Error("GitHub pull-request page is not JSON"); }
  if (!Array.isArray(body) || body.length > 100) throw new Error("GitHub pull-request page must be an array of at most 100 records");
  return { body, links: parseLinkHeader(headers.get("link")) };
}

function parseLinkHeader(value) {
  if (value === undefined) return new Map();
  if (typeof value !== "string" || value === "") throw new Error("GitHub Link header is malformed");
  const links = new Map();
  for (const part of value.split(",")) {
    const match = /^\s*<([^<>]+)>\s*;\s*rel="([a-z]+)"\s*$/u.exec(part);
    if (!match || !["first", "prev", "next", "last"].includes(match[2]) || links.has(match[2])) throw new Error("GitHub Link header is malformed or repeated");
    links.set(match[2], match[1]);
  }
  return links;
}

function normalizePrOperationLinks(links, identity, currentPage) {
  const normalized = new Map();
  for (const [relation, value] of links) {
    const url = normalizePrOperationPageUrl(value, identity);
    normalized.set(relation, { href: url.href, page: Number(url.searchParams.get("page")) });
  }
  if (normalized.has("first") && normalized.get("first").page !== 1) throw new Error("GitHub pagination first relation is invalid");
  if (normalized.has("prev") && (currentPage <= 1 || normalized.get("prev").page !== currentPage - 1)) throw new Error("GitHub pagination prev relation is invalid");
  if (normalized.has("next") && normalized.get("next").page !== currentPage + 1) throw new Error("GitHub pagination next relation is not contiguous");
  if (normalized.has("last")) {
    const lastPage = normalized.get("last").page;
    const minimum = normalized.has("next") ? currentPage + 1 : currentPage;
    if (lastPage < minimum) throw new Error("GitHub pagination last relation is invalid");
  }
  return {
    next: normalized.get("next")?.page ?? null,
    nextUrl: normalized.get("next")?.href ?? null,
    last: normalized.get("last")?.page ?? null,
  };
}

function normalizePrOperationPullRequest(value) {
  const response = requireRecord(value, "GitHub PR operation response");
  const url = normalizePullRequestUrl(response.html_url);
  const number = normalizePullRequestNumber(response.number);
  const nodeId = requireNonEmptyString(response.node_id, "GitHub PR operation node_id");
  if (typeof response.draft !== "boolean") throw new Error("GitHub PR operation draft must be a boolean");
  if (typeof response.body !== "string" || response.body.includes("\0")) throw new Error("GitHub marked PR operation body must be a NUL-free string");
  if (response.state !== "open" && response.state !== "closed") throw new Error("GitHub PR operation state is invalid");
  const mergedAt = response.merged_at;
  if (mergedAt !== null && !isCanonicalUtcTimestamp(mergedAt)) throw new Error("GitHub PR operation merged_at is invalid");
  if (response.state === "open" && mergedAt !== null) throw new Error("GitHub PR operation state and merged_at are contradictory");
  const head = normalizePrOperationSide(response.head, "head");
  const base = normalizePrOperationSide(response.base, "base");
  const tuple = pullRequestUrlTuple(url);
  if (tuple.number !== number || tuple.repository !== base.repository) throw new Error("GitHub PR operation URL tuple is contradictory");
  return Object.freeze({
    pr_url: url,
    pr_number: number,
    pr_node_id: nodeId,
    repository: base.repository,
    draft: response.draft,
    body: response.body,
    state: response.state === "open" ? "open" : mergedAt === null ? "closed" : "merged",
    merged_at: mergedAt,
    head_ref: head.ref,
    head_sha: head.sha,
    head_repository: head.repository,
    base_ref: base.ref,
    base_sha: base.sha,
    base_repository: base.repository,
  });
}

function normalizePrOperationSide(value, label) {
  const side = requireRecord(value, `GitHub PR operation ${label}`);
  const repo = requireRecord(side.repo, `GitHub PR operation ${label}.repo`);
  return {
    ref: requireGitHubRef(side.ref, `GitHub PR operation ${label}.ref`),
    sha: requireFullGitSha(side.sha, `GitHub PR operation ${label}.sha`),
    repository: normalizeRepository(repo.full_name),
  };
}

function classifyPrOperationRecords(records, identity, pages) {
  const exact = [];
  const seen = new Set();
  const marker = prOperationMarker(identity.operation_id);
  for (const value of records) {
    const markerState = inspectOperationMarkerBody(value, marker);
    if (markerState === "other") continue;
    if (markerState !== "exact") return { disposition: "ambiguous", reason: "own-operation-marker-protocol-invalid", pull_request: null, pages, records: records.length };
    const record = normalizePrOperationPullRequest(value);
    const key = `${record.pr_node_id}\0${record.pr_url}`;
    if (seen.has(key)) return unknownObservation("repeated-pull-request-record");
    seen.add(key);
    if (record.repository !== identity.repository || record.head_repository !== identity.repository || record.base_repository !== identity.repository
      || record.head_ref !== identity.head_ref || record.head_sha !== identity.head_sha || record.base_ref !== identity.base_ref
      || record.base_sha !== identity.base_sha || record.draft !== identity.draft) {
      return { disposition: "ambiguous", reason: "own-operation-marker-tuple-mismatch", pull_request: null, pages, records: records.length };
    }
    exact.push(record);
  }
  if (exact.length === 0) return { disposition: "absent", reason: null, pull_request: null, pages, records: records.length };
  if (exact.length > 1) return { disposition: "ambiguous", reason: "multiple-exact-operation-pull-requests", pull_request: null, pages, records: records.length };
  return { disposition: exact[0].state, reason: null, pull_request: exact[0], pages, records: records.length };
}

function inspectOperationMarkerBody(value, marker) {
  const record = requireRecord(value, "GitHub PR operation response");
  if (record.body === null) return "other";
  if (typeof record.body !== "string") throw new Error("GitHub PR operation body must be a string or null");
  return inspectOperationMarker(record.body, marker);
}

function inspectOperationMarker(body, marker) {
  const ownIdentity = marker.slice(0, -4);
  const ownOccurrences = body.split(ownIdentity).length - 1;
  if (ownOccurrences === 0) return "other";
  if (body.includes("\0")) return "invalid";
  const exactOccurrences = body.split(marker).length - 1;
  const standalone = body.split(/\r?\n/u).filter((line) => line === marker).length;
  const markerLike = body.split("<!-- opencode-feature-factory:pr-operation=").length - 1;
  return ownOccurrences === 1 && exactOccurrences === 1 && standalone === 1 && markerLike === 1 ? "exact" : "invalid";
}

function unknownObservation(reason, error) {
  return { disposition: "unknown", reason, pull_request: null, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) };
}

function normalizePrOperationId(value) {
  const operationId = requireNonEmptyString(value, "PR operation_id");
  if (!PR_OPERATION_ID_PATTERN.test(operationId)) throw new Error("PR operation_id is invalid");
  return operationId;
}

function requireFullGitSha(value, label) {
  const sha = requireNonEmptyString(value, label);
  if (!FULL_GIT_SHA_PATTERN.test(sha)) throw new Error(`${label} must be a full 40-character lowercase git SHA`);
  return sha;
}

function requireGitHubRef(value, label) {
  const ref = requireNonEmptyString(value, label);
  if (ref.startsWith("refs/") || ref.startsWith("/") || ref.endsWith("/") || ref.endsWith(".") || ref.includes("..") || ref.includes("@{") || /[\s~^:?*[\\\x00-\x1f\x7f]/u.test(ref)) {
    throw new Error(`${label} is not a safe branch ref`);
  }
  return ref;
}

function requireTimestamp(value, label) {
  const input = requireNonEmptyString(value, label);
  if (!isCanonicalUtcTimestamp(input)) throw new Error(`${label} must be an ISO UTC timestamp`);
  return input;
}

function isCanonicalUtcTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/u.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year === 0 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

export function pullRequestLookupArgs(repository, number) {
  const normalizedRepository = normalizeRepository(repository);
  const normalizedNumber = normalizePullRequestNumber(number);
  return [
    "api",
    "--method",
    "GET",
    `repos/${normalizedRepository}/pulls/${normalizedNumber}`,
    "--header",
    "Accept:application/vnd.github+json",
  ];
}

export function normalizePullRequestResponse(value) {
  const response = requireRecord(value, "GitHub pull-request response");
  const number = normalizePullRequestNumber(response.number);
  const state = normalizePullRequestState(response.state, response.merged);
  const url = normalizePullRequestUrl(response.html_url);
  const urlTuple = pullRequestUrlTuple(url);
  const base = requireRecord(response.base, "GitHub pull-request response base");
  const baseRepo = requireRecord(base.repo, "GitHub pull-request response base repository");
  const repository = normalizeRepository(baseRepo.full_name);
  const baseRef = requireNonEmptyString(base.ref, "GitHub pull-request response base.ref");
  const baseSha = requireNonEmptyString(base.sha, "GitHub pull-request response base.sha");

  if (urlTuple.number !== number || urlTuple.repository !== repository) {
    throw new Error("GitHub pull-request response tuple is contradictory");
  }

  return Object.freeze({
    url,
    number,
    state,
    repository,
    base_ref: baseRef,
    base_sha: baseSha,
  });
}

export function normalizeRecordedPullRequest(run) {
  const record = requireRecord(run, "run");
  const terminalResult = requireRecord(record.terminal_result, "terminal_result");
  const topLevelUrl = normalizePullRequestUrl(record.pr_url);
  const terminalUrl = normalizePullRequestUrl(terminalResult.pr_url);
  const repository = normalizeRepository(terminalResult.repository);
  const number = normalizePullRequestNumber(terminalResult.pr_number);
  const topLevelTuple = pullRequestUrlTuple(topLevelUrl);
  const terminalTuple = pullRequestUrlTuple(terminalUrl);

  if (topLevelUrl !== terminalUrl
    || terminalTuple.repository !== repository
    || terminalTuple.number !== number
    || topLevelTuple.repository !== repository
    || topLevelTuple.number !== number) {
    throw new Error("Recorded pull-request metadata is inconsistent");
  }

  return Object.freeze({ url: topLevelUrl, repository, number });
}

export function lookupPullRequest(cwd, run, options = {}) {
  let recorded;
  try {
    recorded = normalizeRecordedPullRequest(run);
  } catch {
    return { ok: false, reason: "metadata-mismatch", pullRequest: null, command: null };
  }

  const runner = typeof options.githubRunner === "function" ? options.githubRunner : github;
  let result;
  try {
    result = runner(cwd, pullRequestLookupArgs(recorded.repository, recorded.number), {
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
    });
  } catch {
    return { ok: false, reason: "lookup-uncertain", pullRequest: null, command: null };
  }
  if (!result || result.ok !== true || result.status !== 0 || typeof result.stdout !== "string") {
    return { ok: false, reason: "lookup-uncertain", pullRequest: null, command: result?.command ?? null };
  }

  try {
    const normalized = normalizePullRequestResponse(JSON.parse(result.stdout));
    if (normalized.url !== recorded.url
      || normalized.repository !== recorded.repository
      || normalized.number !== recorded.number) {
      return { ok: false, reason: "lookup-uncertain", pullRequest: null, command: result.command ?? null };
    }
    return { ok: true, reason: null, pullRequest: normalized, command: result.command ?? null };
  } catch {
    return { ok: false, reason: "lookup-uncertain", pullRequest: null, command: result.command ?? null };
  }
}

function normalizePullRequestState(state, merged) {
  if (typeof state !== "string" || typeof merged !== "boolean") {
    throw new Error("GitHub pull-request response state is invalid");
  }
  if (state === "closed") return merged ? "MERGED" : "CLOSED";
  if (state === "open" && merged === false) return "OPEN";
  throw new Error("GitHub pull-request response state is contradictory");
}

function normalizePullRequestUrl(value) {
  const input = requireNonEmptyString(value, "GitHub pull-request URL");
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("GitHub pull-request URL is invalid");
  }
  if (parsed.protocol !== "https:"
    || parsed.hostname !== "github.com"
    || parsed.port !== ""
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== "") {
    throw new Error("GitHub pull-request URL is invalid");
  }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/u.exec(parsed.pathname);
  if (!match) throw new Error("GitHub pull-request URL is invalid");
  const repository = normalizeRepository(`${match[1]}/${match[2]}`);
  const number = normalizePullRequestNumber(Number(match[3]));
  return `https://github.com/${repository}/pull/${number}`;
}

function pullRequestUrlTuple(url) {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  return { repository: `${segments[0]}/${segments[1]}`, number: Number(segments[3]) };
}

function normalizeRepository(value) {
  const input = requireNonEmptyString(value, "GitHub repository");
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(input);
  if (!match) throw new Error("GitHub repository must have shape owner/repo");
  return `${match[1]}/${match[2]}`.toLowerCase();
}

function normalizePullRequestNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("GitHub pull-request number must be a positive integer");
  return value;
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeArgs(args) {
  if (!Array.isArray(args)) throw new Error("GitHub args must be an array of strings");
  return args.map((arg, index) => {
    if (typeof arg !== "string" || arg === "") throw new Error(`GitHub args[${index}] must be a non-empty string`);
    if (arg.includes("\0")) throw new Error(`GitHub args[${index}] must not contain NUL bytes`);
    return arg;
  });
}

function boundedPositiveInteger(value, fallback, maximum) {
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

function normalizeOutput(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value);
}

function normalizeError(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  return String(error ?? "");
}

function joinErrorOutput(output, error) {
  const normalizedOutput = normalizeOutput(output);
  if (!error || error === normalizedOutput) return normalizedOutput;
  return normalizedOutput === "" ? error : `${normalizedOutput}\n${error}`;
}
