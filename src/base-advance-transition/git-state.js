import { constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, closeSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { git } from "../git.js";
import { observeRegisteredWorktree } from "../worktrees.js";

const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export function observeBaseAdvanceGitState(repository, run, target, options = {}) {
  const branch = requireString(run.branch, "run.branch");
  const worktree = resolve(requireString(run.worktree, "run.worktree"));
  const branchRef = `refs/heads/${branch}`;
  const validBranch = git(repository, ["check-ref-format", "--branch", branch], options.gitOptions);
  if (!validBranch.ok) throw gitStateFailure("run branch is invalid");
  const branchHead = resolveCommit(repository, branchRef, "run branch", options.gitOptions);
  let worktreeIdentity;
  try {
    worktreeIdentity = observeRegisteredWorktree(repository, worktree, { branch, head: branchHead }, options.gitOptions);
  } catch (error) {
    if (error?.code === "BASE_ADVANCE_GIT_STATE_INVALID") throw error;
    throw gitStateFailure(error?.message || "registered worktree identity is invalid");
  }
  const manifest = requireCommit(run.base_commit, "run.base_commit");
  const observedTarget = requireCommit(target, "canonical target");

  let crashPoint = "split";
  if (manifest === branchHead && branchHead === observedTarget) crashPoint = "bound-current";
  else if (manifest === branchHead) crashPoint = "old-eligible";
  else if (branchHead === observedTarget) crashPoint = "git-advanced-unbound";
  else if (isAncestor(repository, manifest, branchHead, options.gitOptions)
    && isAncestor(repository, branchHead, observedTarget, options.gitOptions)) crashPoint = "target-moved-after-git";

  return Object.freeze({
    repository: resolve(repository),
    worktree: worktreeIdentity.worktree,
    branch,
    branch_ref: branchRef,
    manifest,
    branch_head: branchHead,
    target: observedTarget,
    crash_point: crashPoint,
  });
}

export function fastForwardBaseWorktree(observed, options = {}) {
  const result = git(observed.worktree, ["merge", "--ff-only", "--no-edit", "--no-autostash", observed.target], options.gitOptions);
  if (!result.ok) throw gitStateFailure("integration branch fast-forward failed");
}

export function assertCanonicalTarget(repository, target, options = {}) {
  const expected = requireCommit(target, "canonical target");
  const result = git(repository, ["ls-remote", "--exit-code", "--refs", "origin", "refs/heads/main"], options.gitOptions);
  if (!result.ok) throw codedFailure("BASE_ADVANCE_ORIGIN_UNAVAILABLE", "canonical origin/main advertisement is unavailable");
  const match = /^([0-9a-f]{40})\trefs\/heads\/main\n$/u.exec(result.stdout);
  if (!match) throw codedFailure("BASE_ADVANCE_ORIGIN_AMBIGUOUS", "canonical origin/main advertisement is ambiguous");
  if (match[1] !== expected) throw codedFailure("BASE_ADVANCE_TARGET_MOVED", "canonical origin/main moved during base advancement");
  return expected;
}

export function snapshotRunDurableFiles(runDir) {
  const root = resolve(runDir);
  const rows = [];
  walk(root, "", rows);
  return rows;
}

function walk(root, relativePath, rows) {
  const directory = relativePath ? join(root, relativePath) : root;
  for (const name of readdirSync(directory).sort()) {
    const childRelative = relativePath ? `${relativePath}/${name}` : name;
    if (childRelative === "run.json" || /^\.run\.json\..+\.tmp$/u.test(childRelative)
      || childRelative === "run-json.lock" || childRelative.startsWith("run-json.lock/")
      || childRelative.startsWith(".run-json.lock-")) continue;
    const path = join(root, childRelative);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw codedFailure("BASE_ADVANCE_RUN_INVALID", `run sidecar '${childRelative}' must not be a symlink`);
    if (entry.isDirectory()) {
      rows.push({ path: `${childRelative}/`, type: "directory" });
      walk(root, childRelative, rows);
      continue;
    }
    if (!entry.isFile()) throw codedFailure("BASE_ADVANCE_RUN_INVALID", `run sidecar '${childRelative}' must be a regular file`);
    rows.push({ path: childRelative, type: "file", bytes: readRegularNoFollow(path).toString("base64") });
  }
}

export function assertRunDurableFilesEqual(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw codedFailure("BASE_ADVANCE_INELIGIBLE", "run sidecar bytes changed during base advancement");
  }
}

export function assertRunWorktreePath(repository, worktree) {
  const root = resolve(repository, ".opencode", "worktrees");
  const target = resolve(worktree);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw gitStateFailure("run worktree is outside the factory worktree root");
}

function readRegularNoFollow(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    if (!fstatSync(descriptor).isFile()) throw codedFailure("BASE_ADVANCE_RUN_INVALID", "run sidecar must be a regular file");
    return readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function resolveCommit(cwd, ref, label, gitOptions) {
  const result = git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], gitOptions);
  const commit = result.ok ? result.stdout.trim() : "";
  if (!FULL_COMMIT_PATTERN.test(commit)) throw gitStateFailure(`${label} did not resolve to one full commit`);
  return commit;
}

function isAncestor(repository, ancestor, descendant, gitOptions) {
  const result = git(repository, ["merge-base", "--is-ancestor", ancestor, descendant], gitOptions);
  if (result.ok) return true;
  if (result.status === 1) return false;
  throw gitStateFailure("Git ancestry could not be verified");
}

function requireCommit(value, label) {
  if (typeof value !== "string" || !FULL_COMMIT_PATTERN.test(value)) throw gitStateFailure(`${label} must be a full lowercase commit id`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw gitStateFailure(`${label} must be a non-empty string`);
  return value;
}

function gitStateFailure(message) {
  return codedFailure("BASE_ADVANCE_GIT_STATE_INVALID", message);
}

function codedFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
