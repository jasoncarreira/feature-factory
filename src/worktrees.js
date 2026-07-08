import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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
  return { ok: true, worktree: physicalWorktree, entry };
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
