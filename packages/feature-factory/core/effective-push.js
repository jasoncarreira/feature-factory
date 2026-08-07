import { spawnSync } from "node:child_process";

const ARITY_ERROR = "factory effective-push: expected exactly three positional arguments: <bootstrap|check> <operator-repository> <sandbox-repository>";
const EMPTY_ERROR = "factory effective-push: positional arguments must be non-empty";
const OPERATION_ERROR = "factory effective-push: operation must be bootstrap or check";

function failure(message) {
  return new Error(message);
}

function execute(run, args) {
  return run("git", args, {
    shell: false,
    encoding: "utf8",
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
    || result.status !== 0 || typeof result.stdout !== "string") return null;
  const target = result.stdout.replace(/\n+$/u, "");
  return target.length > 0 ? target : null;
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
    if (!configure(run, sandboxRepository, operatorTarget)) {
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
  if (sandboxTarget !== operatorTarget) {
    throw failure(`factory sandbox: sandbox effective push target does not match operator target; sandbox retained at ${sandboxRepository}`);
  }
}
