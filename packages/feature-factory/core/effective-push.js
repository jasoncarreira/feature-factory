import { spawnSync } from "node:child_process";

const ARITY_ERROR = "factory effective-push: expected exactly three positional arguments: <bootstrap|check> <operator-repository> <sandbox-repository>";
const EMPTY_ERROR = "factory effective-push: positional arguments must be non-empty";
const OPERATION_ERROR = "factory effective-push: operation must be bootstrap or check";

function failure(message) {
  return new Error(message);
}

function execute(run, args) {
  // No `encoding`: stdout stays a Buffer. Decoding to utf8 replaces every distinct
  // invalid byte sequence with the same U+FFFD, so two unequal targets could compare
  // equal here while `git push` used the original raw bytes. A local-path remote on
  // Unix may legitimately hold non-UTF-8 bytes, so this is reachable, not theoretical.
  return run("git", args, {
    shell: false,
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function capture(run, repository) {
  let result;
  try {
    result = execute(run, ["-C", repository, "remote", "get-url", "--push", "origin"]);
  } catch {
    return null;
  }
  if (!result || result.error || result.signal !== null && result.signal !== undefined
    || result.status !== 0 || result.stdout === null || result.stdout === undefined) return null;
  // A test double may still hand back a string; normalise to bytes either way.
  const raw = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout), "utf8");
  // Exactly one LF, because git contributes exactly one record terminator. Stripping every
  // trailing LF would make a target that itself ends in LF indistinguishable from one that
  // does not: operator bytes `path\n` are emitted as `path\n\n` and sandbox bytes `path` as
  // `path\n`, and a greedy strip reduces both to `path` and accepts two unequal targets.
  // Absent terminator means this is not the output shape being parsed, so fail closed.
  if (raw.length === 0 || raw[raw.length - 1] !== 0x0a) return null;
  const target = raw.subarray(0, raw.length - 1);
  return target.length > 0 ? Buffer.from(target) : null;
}

// argv is bytes-as-string, so a target that does not survive a utf8 round trip cannot be
// placed there without silently altering it. Refuse instead of configuring something other
// than what was captured.
function argvSafe(target) {
  return Buffer.from(target.toString("utf8"), "utf8").equals(target);
}

function configure(run, repository, target) {
  try {
    return execute(run, ["-C", repository, "config", "--replace-all", "remote.origin.pushurl", target])?.status === 0;
  } catch {
    return false;
  }
}

export function enforceEffectivePushTarget(positionals, { spawnSync: run = spawnSync } = {}) {
  if (!Array.isArray(positionals) || positionals.length !== 3) throw failure(ARITY_ERROR);
  if (positionals.some((value) => typeof value !== "string" || value.length === 0)) throw failure(EMPTY_ERROR);
  const [operation, operatorRepository, sandboxRepository] = positionals;
  if (operation !== "bootstrap" && operation !== "check") throw failure(OPERATION_ERROR);

  let operatorTarget = capture(run, operatorRepository);
  if (operatorTarget === null) {
    throw failure(`factory sandbox: operator effective push target unavailable; sandbox retained at ${sandboxRepository}`);
  }
  if (operation === "bootstrap") {
    if (!argvSafe(operatorTarget)) {
      throw failure(`factory sandbox: operator effective push target is not representable for configuration; sandbox retained at ${sandboxRepository}`);
    }
    if (!configure(run, sandboxRepository, operatorTarget.toString("utf8"))) {
      throw failure(`factory sandbox: sandbox effective push target unavailable at ${sandboxRepository}`);
    }
    operatorTarget = capture(run, operatorRepository);
    if (operatorTarget === null) {
      throw failure(`factory sandbox: operator effective push target unavailable; sandbox retained at ${sandboxRepository}`);
    }
  }
  const sandboxTarget = capture(run, sandboxRepository);
  if (sandboxTarget === null) {
    throw failure(`factory sandbox: sandbox effective push target unavailable at ${sandboxRepository}`);
  }
  if (!sandboxTarget.equals(operatorTarget)) {
    throw failure(`factory sandbox: sandbox effective push target does not match operator target; sandbox retained at ${sandboxRepository}`);
  }
}
