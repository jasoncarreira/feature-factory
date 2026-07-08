import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoRoot } from "./git.js";

export function directFactoryRoot(cwd = process.cwd()) {
  const local = join(resolve(cwd), ".opencode", "factory");
  if (isDirectory(local)) return local;
  return join(repoRoot(cwd), ".opencode", "factory");
}

export function factoryRootsForLookup(cwd = process.cwd()) {
  const direct = directFactoryRoot(cwd);
  const roots = [direct];
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
    if (isDirectory(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
