// Finding and projecting runs, without asking git.
//
// The boundary test forbids this package from spawning a process, so `git rev-parse` is not
// available — which turns out to be the right constraint rather than an obstacle. The control plane
// lives at `<repo>/.factory/<run-id>/run.json`, so locating it is a filesystem question.
//
// The case that makes this non-trivial is a *linked worktree*. The orchestrator creates one per
// slice, and a linked worktree has no `.factory` of its own — the control plane stays in the main
// repository. Its `.git` is a file rather than a directory, containing
// `gitdir: /main/repo/.git/worktrees/<name>`, so the main repository is derivable from that text
// alone. Without this, opening the sidebar while a slice worktree is the cwd shows no run at all,
// which is precisely when an operator most wants to see one.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONTROL_PLANE, nextAction, readRunUnchecked } from "feature-factory";

// `gitdir: <path>/.git/worktrees/<name>` → `<path>`. Returns null for an ordinary checkout, where
// `.git` is a directory, and for anything that does not parse — a malformed pointer is not a
// repository root to go looking in.
function mainRepositoryOf(dir) {
  const pointer = join(dir, ".git");
  try {
    if (!statSync(pointer).isFile()) return null;
  } catch { return null; }
  let text;
  try { text = readFileSync(pointer, "utf8"); } catch { return null; }
  // Matched with String.match rather than the RegExp method, whose name is one of the
  // process-spawning tokens the boundary test forbids. That guard is a plain substring scan and
  // deliberately blunt; complying is cheaper than teaching it exceptions.
  const match = text.match(/^gitdir:\s*(.+?)\s*$/mu);
  if (!match) return null;
  const worktreesDir = dirname(dirname(match[1]));
  if (!worktreesDir.endsWith(".git")) return null;
  return dirname(worktreesDir);
}

// The repository this directory belongs to, and nothing above it.
//
// This walked up looking for `.factory` and accepted the first ancestor that had one — which found
// `~/.factory`, a directory belonging to another tool entirely, and rendered its `skills/` subfolder
// as a broken run. Found by opening the sidebar for real. The rename from `.claude/factory` to
// `.factory` is what made it likely: a two-segment path rarely exists by accident in a home
// directory, a single dotfile does.
//
// A control plane belongs to a repository, so the repository is the boundary: find the repo root
// first, then look inside it. Never above it.
export function repositoryRoot(startDir) {
  let current = resolve(startDir);
  while (true) {
    const pointer = join(current, ".git");
    if (existsSync(pointer)) {
      // A linked worktree's `.git` is a file pointing into the main repository, which is where the
      // control plane lives — a slice worktree has none of its own.
      return mainRepositoryOf(current) ?? current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function findControlPlane(startDir) {
  const repo = repositoryRoot(startDir);
  if (!repo) return null;
  return existsSync(join(repo, CONTROL_PLANE)) ? repo : null;
}

// Every run under a repository's control plane, newest first. A record that does not parse is
// reported rather than skipped: an operator staring at a sidebar that omits a broken run has no
// way to know it exists, which is the failure mode `readRunUnchecked` exists for.
export function listRuns(repo) {
  const root = join(repo, CONTROL_PLANE);
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const runs = entries
    .filter((entry) => entry.isDirectory())
    // A directory with no run.json is not a broken run, it is not a run — the control plane may hold
    // anything else. Reporting one as INVALID is how another tool's `skills/` folder appeared as a
    // failed run. `readRunUnchecked` still reports a manifest that exists and does not parse.
    .filter((entry) => existsSync(join(root, entry.name, "run.json")))
    .map((entry) => project(join(root, entry.name), entry.name));
  return runs.sort((left, right) => String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")));
}

// The run an operator means when they open the sidebar: the one still going. Terminal runs stay
// listed but never win, so finishing a run does not make yesterday's the headline.
export function selectActiveRun(runs) {
  return runs.find((run) => run.valid && !run.terminal) ?? runs[0] ?? null;
}

const TERMINAL = new Set(["completed", "blocked", "partial", "needs-human"]);

function project(runDir, runId) {
  const observed = readRunUnchecked(runDir);
  if (!observed.ok) {
    return { run_id: runId, valid: false, error: observed.error, terminal: false, updated_at: null };
  }
  const run = observed.run;
  const slices = Array.isArray(run.slices) ? run.slices : [];
  return {
    run_id: run.run_id ?? runId,
    valid: true,
    error: null,
    status: run.status,
    mode: run.mode,
    branch: run.branch,
    jira_key: run.jira_key ?? null,
    updated_at: run.updated_at ?? null,
    terminal: TERMINAL.has(run.status),
    // Which gate is waiting is the one thing an operator acts on, so it is not buried in a map.
    gates: Object.entries(run.gates ?? {}).map(([name, gate]) => ({ name, status: gate?.status ?? "absent" })),
    awaiting_gate: Object.entries(run.gates ?? {}).find(([, gate]) => gate?.status === "pending")?.[0] ?? null,
    slices: slices.map((slice) => ({
      id: slice.id, status: slice.status, attempts: slice.attempts, stack: slice.stack ?? null,
    })),
    merged: slices.filter((slice) => slice.status === "merged").length,
    slice_total: slices.length,
    validator: run.validator?.verdict ?? null,
    pr_url: run.pr_url ?? null,
    terminal_result: run.terminal_result ?? null,
    // Derived by the factory package, not here, so the sidebar and `factory status` cannot
    // disagree about what happens next.
    next: nextAction(run),
  };
}

// One poll: where the control plane is, every run in it, and which one is live.
export function pollRuns(startDir) {
  const repo = findControlPlane(startDir);
  if (!repo) return { repo: null, runs: [], active: null };
  const runs = listRuns(repo);
  return { repo, runs, active: selectActiveRun(runs) };
}
