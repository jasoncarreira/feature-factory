import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { git } from "./git.js";
import { physicalPath, requireNonEmptyString } from "./utils.js";

export function parseWorktreeListPorcelain(stdout) {
  const entries = [];
  let current = null;
  for (const line of String(stdout || "").split(/\r?\n/u)) {
    if (!line) continue;
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null, head: null, bare: false, detached: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    if (line.startsWith("branch refs/heads/")) current.branch = line.slice("branch refs/heads/".length);
    if (line === "bare") current.bare = true;
    if (line === "detached") current.detached = true;
  }
  if (current) entries.push(current);
  return entries;
}

export function checkWorktreeIdentity(repo, worktree, expected = {}, options = {}) {
  const physicalWorktree = physicalPath(worktree);
  if (!existsSync(physicalWorktree) || !statSync(physicalWorktree).isDirectory()) {
    return { ok: false, reason: "missing-worktree", worktree: physicalWorktree };
  }
  const result = git(repo, ["worktree", "list", "--porcelain"], options);
  if (!result.ok) return { ok: false, reason: result.stderr || "git worktree list failed", worktree: physicalWorktree };
  const entries = parseWorktreeListPorcelain(result.stdout);
  const entry = entries.find((item) => physicalPath(item.path) === physicalWorktree) || null;
  if (!entry) return { ok: false, reason: "not-a-registered-worktree", worktree: physicalWorktree };
  if (expected.branch && entry.branch !== expected.branch) {
    return { ok: false, reason: `branch-mismatch:${entry.branch || "detached"}`, worktree: physicalWorktree, entry };
  }
  if (expected.head && entry.head !== expected.head) {
    return { ok: false, reason: `head-mismatch:${entry.head || "missing"}`, worktree: physicalWorktree, entry };
  }
  return { ok: true, worktree: physicalWorktree, entry };
}

export function createOrRecoverWorktree(repo, worktree, expected = {}, options = {}) {
  const repository = resolve(requireNonEmptyString(repo, "repo"));
  const target = resolve(requireNonEmptyString(worktree, "worktree"));
  const branch = requireNonEmptyString(expected.branch, "expected branch");
  const head = requireNonEmptyString(expected.head, "expected head");
  if (!/^[a-f0-9]{40}$/u.test(head)) throw new Error("expected worktree head must be a full lowercase commit id");
  const root = resolve(repository, ".opencode", "worktrees");
  const targetRelative = relative(root, target);
  if (!targetRelative || targetRelative === ".." || targetRelative.startsWith("../") || isAbsolute(targetRelative)) {
    throw new Error(`continuation worktree must stay under ${root}`);
  }

  const existing = inspectTarget(target);
  if (existing.exists) return exactWorktreeOrThrow(repository, target, branch, head, options, true);

  mkdirSync(root, { recursive: true });
  const rootEntry = lstatSync(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) throw new Error(`continuation worktree root is unsafe: ${root}`);
  if (typeof options.beforeAdd === "function") options.beforeAdd({ repo: repository, worktree: target, branch, head });
  try {
    mkdirSync(target, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") return exactWorktreeOrThrow(repository, target, branch, head, options, true);
    throw new Error(`continuation worktree path could not be reserved without overwrite: ${error.message}`);
  }
  const added = git(repository, ["worktree", "add", target, branch], { timeout: 30000, ...options });
  if (!added.ok) {
    const raced = inspectTarget(target);
    if (raced.exists) return exactWorktreeOrThrow(repository, target, branch, head, options, true);
    throw new Error(`continuation worktree add failed: ${(added.stderr || added.stdout || "unknown git error").trim()}`);
  }
  return exactWorktreeOrThrow(repository, target, branch, head, options, false);
}

export function deriveExpectedWorktreePath(repo, branch) {
  const branchName = requireNonEmptyString(branch, "branch");
  const root = resolve(repo, ".opencode", "worktrees");
  const slug = branchName.replace(/[\\/]+/gu, "-");
  const candidate = resolve(root, slug);
  if (!existsSync(candidate)) return candidate;
  const identity = checkWorktreeIdentity(repo, candidate, { branch: branchName });
  if (identity.ok) return candidate;
  return resolve(root, `${slug}-${shortHash(branchName)}`);
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function inspectTarget(target) {
  try {
    const entry = lstatSync(target);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`continuation worktree path exists but is unsafe: ${target}`);
    return { exists: true };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

function exactWorktreeOrThrow(repo, target, branch, head, options, recovered) {
  const identity = checkWorktreeIdentity(repo, target, { branch, head }, options);
  if (!identity.ok) throw new Error(`continuation worktree conflicts with expected branch/head: ${identity.reason}`);
  const observedHead = git(target, ["rev-parse", "--verify", "HEAD^{commit}"], options);
  if (!observedHead.ok || observedHead.stdout.trim() !== head) {
    throw new Error("continuation worktree HEAD does not equal the registered start commit");
  }
  return { worktree: identity.worktree, recovered, entry: identity.entry };
}
