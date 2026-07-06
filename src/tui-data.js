import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".cache", ".next"]);
const MAX_SCAN_DIRS = 2000;

export function factoryRoots(api) {
  const starts = [api.state.path.worktree, api.state.path.directory].filter(Boolean);
  const roots = new Set();
  for (const start of starts) {
    for (const root of findFactoryRoots(start)) roots.add(root);
  }
  return [...roots].sort();
}

export function readRuns(roots) {
  return roots
    .flatMap((root) => readRootRuns(root))
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
}

export function findFactoryRoots(start) {
  const dir = resolve(start);
  const roots = new Set();
  const nearest = findNearestFactoryRoot(dir);
  if (nearest) roots.add(nearest);
  for (const root of findNestedFactoryRoots(dir)) roots.add(root);
  if (!roots.size) roots.add(join(dir, ".opencode", "factory"));
  return [...roots];
}

function findNearestFactoryRoot(start) {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, ".opencode", "factory");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findNestedFactoryRoots(start) {
  const roots = [];
  const queue = [resolve(start)];
  let scanned = 0;
  while (queue.length && scanned < MAX_SCAN_DIRS) {
    const dir = queue.shift();
    scanned += 1;
    const candidate = join(dir, ".opencode", "factory");
    if (existsSync(candidate)) roots.push(candidate);
    for (const child of safeReadDir(dir)) {
      if (SKIP_DIRS.has(child.name)) continue;
      const path = join(dir, child.name);
      if (child.isDirectory()) queue.push(path);
    }
  }
  return roots;
}

function safeReadDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readRootRuns(root) {
  if (!root || !existsSync(root)) return [];
  return readdirSync(root)
    .flatMap((runID) => {
      const file = join(root, runID, "run.json");
      if (!existsSync(file) || !statSync(file).isFile()) return [];
      try {
        const run = JSON.parse(readFileSync(file, "utf8"));
        return [summarize(run, runID, file)];
      } catch {
        return [];
      }
    });
}

function summarize(run, fallbackID, file) {
  return {
    run_id: String(run.run_id || fallbackID),
    status: String(run.status || "unknown"),
    mode: run.mode ? String(run.mode) : null,
    gate: pendingGate(run),
    branch: run.branch ? String(run.branch) : null,
    pr_url: run.pr_url ? String(run.pr_url) : null,
    review_tier: stringOrNull(run.review_tier?.selected),
    review_tier_source: stringOrNull(run.review_tier?.source),
    updated_at: run.updated_at ? String(run.updated_at) : null,
    slices: sliceSummary(run),
    panel: panelSummary(run),
    terminal_reason: run.terminal_result?.reason ? String(run.terminal_result.reason) : null,
    file,
  };
}

function pendingGate(run) {
  for (const [name, gate] of Object.entries(run.gates || {})) {
    if (gate?.status === "pending") return name;
  }
  return null;
}

function sliceSummary(run) {
  const slices = Array.isArray(run.slices) ? run.slices : [];
  if (!slices.length) return null;
  return {
    merged: slices.filter((item) => item?.status === "merged").length,
    blocked: slices.filter((item) => item?.status === "blocked").length,
    total: slices.length,
  };
}

function panelSummary(run) {
  const validator = run.validator?.verdict ? String(run.validator.verdict) : null;
  const security = run.security_review?.verdict ? String(run.security_review.verdict) : null;
  if (!validator && !security) return null;
  return [validator, security].filter(Boolean).join(" / ");
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}
