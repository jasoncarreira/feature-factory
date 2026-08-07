import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, lstatSync, openSync, realpathSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const SENSITIVE_CHILD_ENV_DENYLIST = Object.freeze([
  "DEBUG", "GH_DEBUG", "CURL_VERBOSE", "GIT_TRACE", "GIT_TRACE_PACKET",
  "GIT_TRACE_PACK_ACCESS", "GIT_TRACE_PERFORMANCE", "GIT_TRACE_SETUP", "GIT_TRACE_SHALLOW",
  "GIT_TRACE_FSMONITOR", "GIT_TRACE_CURL", "GIT_TRACE_CURL_NO_DATA", "GIT_CURL_VERBOSE",
  "GIT_TRACE2", "GIT_TRACE2_EVENT", "GIT_TRACE2_PERF", "GIT_TRACE2_BRIEF",
  "GIT_TRACE2_CONFIG_PARAMS", "GIT_TRACE2_ENV_VARS", "GIT_TRACE2_PARENT_SID", "GIT_TRACE_REDACT",
  "GIT_REDIRECT_STDOUT", "GIT_REDIRECT_STDERR", "GCM_TRACE", "GCM_TRACE2", "GCM_DEBUG",
  "GIT_CONFIG_PARAMETERS",
]);

const DEFAULT_EFFECTIVE_PUSH_OPERATIONS = Object.freeze({
  spawn: spawnSync, env: process.env, resolvePath: resolve, realpath: realpathSync, lstat: lstatSync,
  dirname, basename, joinPath: join, open: openSync, write: writeSync, fsync: fsyncSync, close: closeSync,
});

class EffectivePushRefusal extends Error {}

const targetError = (kind, sandbox) => new EffectivePushRefusal(kind === "operator"
  ? `factory sandbox: operator effective push target unavailable; sandbox retained at ${sandbox}`
  : kind === "sandbox"
    ? `factory sandbox: sandbox effective push target unavailable at ${sandbox}`
    : `factory sandbox: sandbox effective push target does not match operator target; sandbox retained at ${sandbox}`);

function childEnvironment(source) {
  const env = { ...source, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };
  for (const name of SENSITIVE_CHILD_ENV_DENYLIST) delete env[name];
  return env;
}

function runGit(cwd, args, operations) {
  const result = operations.spawn("git", args, {
    cwd, shell: false, env: childEnvironment(operations.env), stdio: ["ignore", "pipe", "pipe"],
  });
  if (!result || result.error || result.signal !== null || result.status !== 0
    || !Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr) || result.stderr.length !== 0) {
    throw new Error("effective push operation failed");
  }
  return result.stdout;
}

function targetBytes(cwd, operations) {
  const stdout = runGit(cwd, ["remote", "get-url", "--push", "origin"], operations);
  if (stdout.length < 2 || stdout.at(-1) !== 0x0a) throw new Error("invalid target framing");
  const end = stdout.at(-2) === 0x0d ? stdout.length - 2 : stdout.length - 1;
  const value = stdout.subarray(0, end);
  if (value.length === 0) throw new Error("empty target");
  for (const byte of value) {
    if (byte === 0 || byte === 0x7f || byte < 0x20) throw new Error("invalid target byte");
  }
  return value;
}

function startsWith(value, prefix) {
  return value.length >= prefix.length && value.subarray(0, prefix.length).equals(prefix);
}

function validTransport(value) {
  const networkPrefixes = ["http://", "https://", "ssh://", "git://"].map((entry) => Buffer.from(entry));
  for (const prefix of networkPrefixes) {
    if (!startsWith(value, prefix)) continue;
    const authority = value.subarray(prefix.length);
    if (authority.length === 0 || [0x2f, 0x3f, 0x23].includes(authority[0])) return false;
    for (const byte of authority) {
      if (byte === 0x20 || byte === 0x09 || byte === 0x0b || byte === 0x0c) return false;
      if ([0x2f, 0x3f, 0x23].includes(byte)) break;
    }
    return true;
  }
  if (value.includes(Buffer.from("://"))) return false;
  let colon = -1;
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index];
    if (byte === 0x3a) { colon = index; break; }
    if (byte === 0x2f || byte === 0x20 || byte === 0x09 || byte === 0x0b || byte === 0x0c) return false;
  }
  if (colon <= 0 || colon === value.length - 1 || colon === 1 || value[colon + 1] === 0x3a) return false;
  const prefix = value.subarray(0, colon);
  let at = -1;
  for (let index = 0; index < prefix.length; index += 1) {
    const byte = prefix[index];
    if (byte === 0x40) {
      if (at !== -1 || index === 0 || index === prefix.length - 1) return false;
      at = index;
    } else if (byte === 0x2f || byte === 0x3a || byte === 0x20) return false;
  }
  const hostLength = prefix.length - at - 1;
  return at >= 0 || hostLength !== 1;
}

function capture(cwd, side, sandbox, operations) {
  try {
    const value = targetBytes(cwd, operations);
    if (!validTransport(value)) throw new Error("unsupported target");
    return value;
  } catch {
    throw targetError(side, sandbox);
  }
}

function escapedConfig(target) {
  const escaped = [];
  for (const byte of target) escaped.push(...byte === 0x5c ? [0x5c, 0x5c] : byte === 0x22 ? [0x5c, 0x22] : [byte]);
  return Buffer.concat([
    Buffer.from("[remote \"origin\"]\n\tpushurl = \""), Buffer.from(escaped), Buffer.from("\"\n"),
  ]);
}

function configure(sandbox, target, operations) {
  let fd;
  let failed = false;
  try {
    runGit(sandbox, ["config", "--local", "--add", "include.path", "./factory-push-target.config"], operations);
    fd = operations.open(operations.joinPath(sandbox, ".git", "factory-push-target.config"), "wx", 0o600);
    const bytes = escapedConfig(target);
    let offset = 0;
    while (offset < bytes.length) {
      const written = operations.write(fd, bytes, offset, bytes.length - offset);
      if (!Number.isInteger(written) || written <= 0) throw new Error("write failed");
      offset += written;
    }
    operations.fsync(fd);
  } catch {
    failed = true;
  } finally {
    if (fd !== undefined) {
      try { operations.close(fd); } catch { failed = true; }
    }
  }
  if (failed) throw targetError("sandbox", sandbox);
}

function contextTop(root, sandbox, operations) {
  try {
    const stdout = runGit(root, ["rev-parse", "--show-toplevel"], operations);
    if (stdout.length < 2 || stdout.at(-1) !== 0x0a) throw new Error("invalid context");
    const end = stdout.at(-2) === 0x0d ? stdout.length - 2 : stdout.length - 1;
    const observed = operations.realpath(operations.resolvePath(root, stdout.subarray(0, end).toString("utf8")));
    if (observed !== root) throw new Error("context mismatch");
  } catch {
    throw targetError("operator", sandbox);
  }
}

function exactDirectory(path, operations) {
  const stat = operations.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || operations.realpath(path) !== path) throw new Error("unsafe path");
}

export function configureSandboxPushTarget({ operatorRoot, sandboxRoot }, overrides = DEFAULT_EFFECTIVE_PUSH_OPERATIONS) {
  const operations = { ...DEFAULT_EFFECTIVE_PUSH_OPERATIONS, ...overrides };
  let sandbox;
  try { sandbox = operations.realpath(sandboxRoot); } catch { throw targetError("operator", sandboxRoot); }
  const initial = capture(operatorRoot, "operator", sandbox, operations);
  configure(sandbox, initial, operations);
  const currentOperator = capture(operatorRoot, "operator", sandbox, operations);
  const currentSandbox = capture(sandbox, "sandbox", sandbox, operations);
  if (!currentOperator.equals(currentSandbox)) throw targetError("mismatch", sandbox);
  return "verified";
}

export function compareSelectedRunPushTarget({ selectedRoot, runId }, overrides = DEFAULT_EFFECTIVE_PUSH_OPERATIONS) {
  const operations = { ...DEFAULT_EFFECTIVE_PUSH_OPERATIONS, ...overrides };
  let lexical;
  try { lexical = operations.resolvePath(selectedRoot); } catch {
    lexical = resolve(selectedRoot);
    throw new Error(`factory sandbox: selected repository unavailable at ${lexical}; selected run unchanged`);
  }
  let sandbox;
  try {
    const stat = operations.lstat(lexical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe path");
    sandbox = operations.realpath(lexical);
    exactDirectory(sandbox, operations);
  } catch {
    throw new Error(`factory sandbox: selected repository unavailable at ${lexical}; selected run unchanged`);
  }
  try {
    const container = operations.dirname(sandbox);
    contextTop(sandbox, sandbox, operations);
    if (operations.basename(container) !== ".factory-sandboxes") return "legacy-direct";
    if (operations.basename(sandbox) !== runId) throw new Error("run mismatch");
    exactDirectory(container, operations);
    const operator = operations.dirname(container);
    exactDirectory(operator, operations);
    contextTop(operator, sandbox, operations);
    const currentOperator = capture(operator, "operator", sandbox, operations);
    const currentSandbox = capture(sandbox, "sandbox", sandbox, operations);
    if (!currentOperator.equals(currentSandbox)) throw targetError("mismatch", sandbox);
  } catch (error) {
    if (error instanceof EffectivePushRefusal) throw error;
    throw targetError("operator", sandbox);
  }
  return "verified";
}
