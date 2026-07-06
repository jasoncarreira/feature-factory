import { spawnSync as defaultSpawnSync } from "node:child_process";
import { resolve } from "node:path";

const NULL_DEVICE = "/dev/null";
const C_STYLE_ESCAPES = Object.freeze({
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  '"': '"',
  "\\": "\\",
});
const SAFE_SUBCOMMANDS = new Set([
  "cat-file",
  "check-ignore",
  "diff-tree",
  "ls-files",
  "ls-tree",
  "merge-base",
  "merge-tree",
  "rev-list",
  "rev-parse",
  "show-ref",
  "status",
  "symbolic-ref",
  "worktree",
]);

export const SAFE_GIT_POLICY = "safe-git-v1";
export const DEFAULT_SAFE_GIT_TIMEOUT_MS = 10_000;
export const MAX_SAFE_GIT_TIMEOUT_MS = 30_000;
export const DEFAULT_SAFE_GIT_MAX_BUFFER = 1024 * 1024;
export const MAX_SAFE_GIT_MAX_BUFFER = 8 * 1024 * 1024;
export const SAFE_GIT_ENV_OVERRIDES = Object.freeze({
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: NULL_DEVICE,
});
export const SAFE_GIT_PREFIX_ARGS = Object.freeze([
  "--no-replace-objects",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  `core.hooksPath=${NULL_DEVICE}`,
]);

export function safeGit(cwd, args, options = {}) {
  const resolvedCwd = resolve(requireText(cwd, "cwd"));
  const requestedArgs = normalizeArgs(args);
  validateSafeGitArgs(requestedArgs);

  const commandArgs = [...SAFE_GIT_PREFIX_ARGS, ...requestedArgs];
  const timeout = clampPositiveInteger(options.timeout, DEFAULT_SAFE_GIT_TIMEOUT_MS, MAX_SAFE_GIT_TIMEOUT_MS);
  const maxBuffer = clampPositiveInteger(options.maxBuffer, DEFAULT_SAFE_GIT_MAX_BUFFER, MAX_SAFE_GIT_MAX_BUFFER);
  const command = {
    file: "git",
    cwd: resolvedCwd,
    args: commandArgs,
    shell: false,
    timeout,
    maxBuffer,
  };

  const spawn = typeof options.spawnSync === "function" ? options.spawnSync : defaultSpawnSync;
  const spawnOptions = {
    cwd: resolvedCwd,
    encoding: "utf8",
    env: buildSafeGitEnv(options.env),
    shell: false,
    timeout,
    maxBuffer,
    windowsHide: true,
  };

  let proc;

  try {
    proc = spawn(command.file, command.args, spawnOptions) || {};
  } catch (error) {
    return buildSafeGitResult({
      ok: false,
      status: null,
      stdout: "",
      stderr: normalizeErrorMessage(error),
      command,
      error,
    });
  }

  const status = Number.isInteger(proc.status) ? proc.status : null;
  return buildSafeGitResult({
    ok: !proc.error && status === 0,
    status,
    stdout: normalizeOutput(proc.stdout),
    stderr: joinOutput(proc.stderr, proc.error),
    command,
    error: proc.error,
    signal: typeof proc.signal === "string" ? proc.signal : null,
  });
}

export function buildSafeGitEnv(extraEnv = {}) {
  if (extraEnv == null || typeof extraEnv !== "object" || Array.isArray(extraEnv)) {
    throw new Error("options.env must be an object when provided");
  }

  const env = {};
  for (const [key, value] of Object.entries({ ...process.env, ...extraEnv })) {
    if (value == null) continue;
    if (key.toUpperCase().startsWith("GIT_")) continue;
    env[key] = String(value);
  }

  return { ...env, ...SAFE_GIT_ENV_OVERRIDES };
}

export function listHiddenIndexPaths(worktree, options = {}) {
  const result = safeGit(worktree, ["ls-files", "-v"], options);
  return {
    ...result,
    hidden_index_paths: result.ok ? parseHiddenIndexPaths(result.stdout) : [],
  };
}

export function parseHiddenIndexPaths(stdout) {
  return normalizeOutput(stdout)
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(parseLsFilesEntry)
    .filter(Boolean);
}

function parseLsFilesEntry(line) {
  if (typeof line !== "string" || line.length < 3 || line[1] !== " ") return null;

  const tag = line[0];
  const skipWorktree = tag.toUpperCase() === "S";
  const assumeUnchanged = tag === tag.toLowerCase() && tag !== tag.toUpperCase();
  if (!skipWorktree && !assumeUnchanged) return null;

  return {
    path: decodeGitPath(line.slice(2)),
    tag,
    assume_unchanged: assumeUnchanged,
    skip_worktree: skipWorktree,
  };
}

function validateSafeGitArgs(args) {
  if (args.length === 0) throw new Error("safeGit args must include a git subcommand");
  if (args[0].startsWith("-")) throw new Error("safeGit only accepts git subcommands, not global git options");
  if (!SAFE_SUBCOMMANDS.has(args[0])) throw new Error(`safeGit does not allow git ${args[0]}`);

  if (args[0] === "worktree") {
    if (args[1] !== "list") throw new Error("safeGit only allows git worktree list");
    return;
  }

  if (args[0] === "cat-file") {
    rejectForbiddenArg(args, "--filters");
    rejectForbiddenArg(args, "--textconv");
  }

  if (args[0] === "diff-tree") {
    rejectForbiddenArg(args, "--ext-diff");
    rejectForbiddenArg(args, "--textconv");
  }
}

function rejectForbiddenArg(args, forbidden) {
  if (args.includes(forbidden)) throw new Error(`safeGit does not allow ${forbidden} for git ${args[0]}`);
}

function normalizeArgs(args) {
  if (!Array.isArray(args)) throw new Error("safeGit args must be an array of strings");

  return args.map((arg, index) => {
    if (typeof arg !== "string" || arg === "") {
      throw new Error(`safeGit args[${index}] must be a non-empty string`);
    }
    if (arg.includes("\u0000")) throw new Error(`safeGit args[${index}] must not contain NUL bytes`);
    return arg;
  });
}

function buildSafeGitResult({ ok, status, stdout, stderr, command, error, signal = null }) {
  const result = {
    ok,
    status,
    stdout,
    stderr,
    command,
    policy: SAFE_GIT_POLICY,
  };

  if (error) result.error = normalizeErrorMessage(error);
  if (signal) result.signal = signal;
  return result;
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

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function decodeGitPath(value) {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;

  let decoded = "";

  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      decoded += char;
      continue;
    }

    index += 1;
    if (index >= value.length - 1) {
      decoded += "\\";
      break;
    }

    const escaped = value[index];
    if (/[0-7]/u.test(escaped)) {
      let octal = escaped;
      for (let count = 1; count < 3 && /[0-7]/u.test(value[index + 1] || ""); count += 1) {
        index += 1;
        octal += value[index];
      }
      decoded += String.fromCharCode(Number.parseInt(octal, 8));
      continue;
    }

    decoded += C_STYLE_ESCAPES[escaped] ?? escaped;
  }

  return decoded;
}
