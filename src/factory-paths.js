import { existsSync, lstatSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoRoot } from "./git.js";

export function directFactoryRoot(cwd = process.cwd()) {
  const local = join(resolve(cwd), ".opencode", "factory");
  if (isDirectory(local)) return assertSafeFactoryRoot(local);
  return assertSafeFactoryRoot(join(repoRoot(cwd), ".opencode", "factory"));
}

export function directFactoryRootForLookup(cwd = process.cwd()) {
  const local = join(resolve(cwd), ".opencode", "factory");
  if (isDirectory(local)) {
    const safeLocal = safeFactoryRootForLookup(local);
    if (safeLocal) return safeLocal;
  }
  return safeFactoryRootForLookup(join(repoRoot(cwd), ".opencode", "factory"));
}

export function factoryRootsForLookup(cwd = process.cwd()) {
  const direct = directFactoryRootForLookup(cwd);
  const roots = direct ? [direct] : [];
  const ancestor = nearestAncestorFactoryRoot(cwd);
  if (ancestor && ancestor !== direct) roots.push(ancestor);
  return roots;
}

export function factoryRepoFromRunDir(runDir) {
  return dirname(dirname(dirname(resolve(runDir))));
}

function nearestAncestorFactoryRoot(cwd) {
  let dir = resolve(cwd);
  while (true) {
    const candidate = join(dir, ".opencode", "factory");
    if (isDirectory(candidate)) {
      const safeCandidate = safeFactoryRootForLookup(candidate);
      if (safeCandidate) return safeCandidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function safeFactoryRootForLookup(root) {
  try {
    return assertSafeFactoryRoot(root);
  } catch {
    return null;
  }
}

function assertSafeFactoryRoot(root) {
  const opencodeDir = dirname(root);
  for (const [path, label] of [[opencodeDir, ".opencode"], [root, ".opencode/factory"]]) {
    if (!existsSync(path)) continue;
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${label} must be a real directory, not a symlink`);
  }
  return root;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
