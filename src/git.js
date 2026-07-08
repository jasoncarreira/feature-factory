import { spawnSync as defaultSpawnSync } from "node:child_process";
import { resolve } from "node:path";
import { requireNonEmptyString } from "./utils.js";

export const DEFAULT_GIT_TIMEOUT_MS = 10_000;
export const MAX_GIT_TIMEOUT_MS = 30_000;
export const DEFAULT_GIT_MAX_BUFFER = 1024 * 1024;
export const MAX_GIT_MAX_BUFFER = 8 * 1024 * 1024;
const repoRootCache = new Map();

export function git(cwd, args, options = {}) {
  const resolvedCwd = resolve(requireNonEmptyString(cwd, "cwd"));
  const commandArgs = normalizeArgs(args);
  const timeout = clampPositiveInteger(options.timeout, DEFAULT_GIT_TIMEOUT_MS, MAX_GIT_TIMEOUT_MS);
  const maxBuffer = clampPositiveInteger(options.maxBuffer, DEFAULT_GIT_MAX_BUFFER, MAX_GIT_MAX_BUFFER);
  const spawn = typeof options.spawnSync === "function" ? options.spawnSync : defaultSpawnSync;
  const env = {
    ...process.env,
    ...options.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
  };

  const command = {
    file: "git",
    cwd: resolvedCwd,
    args: commandArgs,
    shell: false,
    timeout,
    maxBuffer,
  };

  try {
    const proc = spawn("git", commandArgs, {
      cwd: resolvedCwd,
      encoding: "utf8",
      env,
      shell: false,
      timeout,
      maxBuffer,
      windowsHide: true,
    }) || {};
    const status = Number.isInteger(proc.status) ? proc.status : null;
    return {
      ok: !proc.error && status === 0,
      status,
      stdout: normalizeOutput(proc.stdout),
      stderr: joinOutput(proc.stderr, proc.error),
      command,
      error: proc.error ? normalizeErrorMessage(proc.error) : undefined,
      signal: typeof proc.signal === "string" ? proc.signal : null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: normalizeErrorMessage(error),
      command,
      error: normalizeErrorMessage(error),
      signal: null,
    };
  }
}

export function repoRoot(cwd = process.cwd(), options = {}) {
  const key = resolve(requireNonEmptyString(cwd, "cwd"));
  if (!options.noCache && repoRootCache.has(key)) return repoRootCache.get(key);
  const proc = git(key, ["rev-parse", "--show-toplevel"], options);
  const rootPath = proc.ok ? proc.stdout.trim() : key;
  if (!options.noCache && proc.ok) repoRootCache.set(key, rootPath);
  return rootPath;
}

function normalizeArgs(args) {
  if (!Array.isArray(args)) throw new Error("git args must be an array of strings");
  return args.map((arg, index) => {
    if (typeof arg !== "string" || arg === "") throw new Error(`git args[${index}] must be a non-empty string`);
    if (arg.includes("\0")) throw new Error(`git args[${index}] must not contain NUL bytes`);
    return arg;
  });
}

function clampPositiveInteger(value, fallback, maximum) {
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

function normalizeOutput(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value);
}

function normalizeErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  return String(error ?? "");
}

function joinOutput(output, error) {
  const parts = [];
  const normalizedOutput = normalizeOutput(output);
  const normalizedError = normalizeErrorMessage(error);
  if (normalizedOutput !== "") parts.push(normalizedOutput);
  if (normalizedError !== "" && normalizedError !== normalizedOutput) parts.push(normalizedError);
  return parts.join(parts.length > 1 ? "\n" : "");
}
