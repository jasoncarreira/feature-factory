import { spawnSync as defaultSpawnSync } from "node:child_process";
import { resolve } from "node:path";

export const DEFAULT_GITHUB_TIMEOUT_MS = 10_000;
export const MAX_GITHUB_TIMEOUT_MS = 30_000;
export const DEFAULT_GITHUB_MAX_BUFFER = 1024 * 1024;
export const MAX_GITHUB_MAX_BUFFER = 8 * 1024 * 1024;

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
