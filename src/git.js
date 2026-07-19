import { spawnSync as defaultSpawnSync } from "node:child_process";
import { resolve } from "node:path";
import { requireNonEmptyString } from "./utils.js";

export const DEFAULT_GIT_TIMEOUT_MS = 10_000;
export const MAX_GIT_TIMEOUT_MS = 30_000;
export const DEFAULT_GIT_MAX_BUFFER = 1024 * 1024;
export const MAX_GIT_MAX_BUFFER = 8 * 1024 * 1024;
const repoRootCache = new Map();
const ZERO_OID = "0".repeat(40);

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
      ...(options.input === undefined ? {} : { input: options.input }),
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

export function createTwoRefsAtomicallyNoReplace(cwd, verify, first, second, options = {}) {
  const required = normalizeRefOid(verify, "required verify ref");
  const updates = [normalizeRefOid(first, "first create ref"), normalizeRefOid(second, "second create ref")];
  if (new Set([required.ref, ...updates.map((update) => update.ref)]).size !== 3) {
    throw new Error("atomic ref transaction requires three distinct direct refs");
  }
  const input = [
    "start",
    `verify ${required.ref} ${required.oid}`,
    ...updates.map(({ ref, oid }) => `update ${ref} ${oid} ${ZERO_OID}`),
    "prepare",
    "commit",
    "",
  ].join("\n");
  return git(cwd, ["update-ref", "--no-deref", "--stdin"], { ...options, input });
}

export function createThreeRefsAtomicallyNoReplace(cwd, verify, first, second, third, options = {}) {
  const required = normalizeRefOid(verify, "required verify ref");
  const updates = [normalizeRefOid(first, "first create ref"), normalizeRefOid(second, "second create ref"), normalizeRefOid(third, "third create ref")];
  if (new Set([required.ref, ...updates.map((update) => update.ref)]).size !== 4) {
    throw new Error("atomic ref transaction requires four distinct direct refs");
  }
  const input = [
    "start",
    `verify ${required.ref} ${required.oid}`,
    ...updates.map(({ ref, oid }) => `update ${ref} ${oid} ${ZERO_OID}`),
    "prepare",
    "commit",
    "",
  ].join("\n");
  return git(cwd, ["update-ref", "--no-deref", "--stdin"], { ...options, input });
}

export function updateTwoRefsAtomically(cwd, verify, first, second, options = {}) {
  const required = normalizeRefOid(verify, "required verify ref");
  const updates = [normalizeRefTransition(first, "first update ref"), normalizeRefTransition(second, "second update ref")];
  if (new Set([required.ref, ...updates.map((update) => update.ref)]).size !== 3) throw new Error("atomic ref transaction requires three distinct direct refs");
  const input = [
    "start",
    `verify ${required.ref} ${required.oid}`,
    ...updates.map(({ ref, oid, oldOid }) => `update ${ref} ${oid} ${oldOid}`),
    "prepare",
    "commit",
    "",
  ].join("\n");
  return git(cwd, ["update-ref", "--no-deref", "--stdin"], { ...options, input });
}

export function updateTwoRefsAtomicallyWithVerifications(cwd, verifies, first, second, options = {}) {
  if (!Array.isArray(verifies) || verifies.length === 0) throw new Error("atomic ref transaction requires at least one verification");
  const required = verifies.map((verify, index) => normalizeRefOid(verify, `required verify ref ${index + 1}`));
  const updates = [normalizeRefTransition(first, "first update ref"), normalizeRefTransition(second, "second update ref")];
  if (new Set([...required.map((item) => item.ref), ...updates.map((update) => update.ref)]).size !== required.length + updates.length) {
    throw new Error("atomic ref transaction requires distinct direct refs");
  }
  const input = [
    "start",
    ...required.map(({ ref, oid }) => `verify ${ref} ${oid}`),
    ...updates.map(({ ref, oid, oldOid }) => `update ${ref} ${oid} ${oldOid}`),
    "prepare",
    "commit",
    "",
  ].join("\n");
  return git(cwd, ["update-ref", "--no-deref", "--stdin"], { ...options, input });
}

export function createRefAtomicallyNoReplaceWithVerifications(cwd, verifies, update, options = {}) {
  if (!Array.isArray(verifies) || verifies.length === 0) throw new Error("atomic ref creation requires at least one verification");
  const required = verifies.map((verify, index) => normalizeRefOid(verify, `required verify ref ${index + 1}`));
  const created = normalizeRefOid(update, "create ref");
  if (new Set([...required.map((item) => item.ref), created.ref]).size !== required.length + 1) throw new Error("atomic ref creation requires distinct direct refs");
  const input = [
    "start",
    ...required.map(({ ref, oid }) => `verify ${ref} ${oid}`),
    `update ${created.ref} ${created.oid} ${ZERO_OID}`,
    "prepare",
    "commit",
    "",
  ].join("\n");
  return git(cwd, ["update-ref", "--no-deref", "--stdin"], { ...options, input });
}

export function updateTwoRefsAtomicallyNoVerify(cwd, first, second, options = {}) {
  const updates = [normalizeRefTransition(first, "first update ref"), normalizeRefTransition(second, "second update ref")];
  if (updates[0].ref === updates[1].ref) throw new Error("atomic ref transaction requires two distinct direct refs");
  const input = [
    "start",
    ...updates.map(({ ref, oid, oldOid }) => `update ${ref} ${oid} ${oldOid}`),
    "prepare",
    "commit",
    "",
  ].join("\n");
  return git(cwd, ["update-ref", "--no-deref", "--stdin"], { ...options, input });
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

function normalizeRefOid(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const ref = requireNonEmptyString(value.ref, label);
  const oid = requireNonEmptyString(value.oid, `${label} oid`);
  if (!ref.startsWith("refs/") || /[\u0000-\u0020\u007f~^:?*[\]]/u.test(ref) || ref.includes("\\") || ref.includes("..") || ref.includes("@{")
    || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".") || ref.endsWith(".lock")) {
    throw new Error(`${label} must be a full safe direct ref name`);
  }
  if (!/^[a-f0-9]{40}$/u.test(oid) || oid === ZERO_OID) throw new Error(`${label} oid must be a nonzero full lowercase object id`);
  return { ref, oid };
}

function normalizeRefTransition(value, label) {
  const next = normalizeRefOid(value, label);
  const oldOid = requireNonEmptyString(value.oldOid, `${label} oldOid`);
  if (!/^[a-f0-9]{40}$/u.test(oldOid) || oldOid === ZERO_OID) throw new Error(`${label} oldOid must be a nonzero full lowercase object id`);
  return { ...next, oldOid };
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
