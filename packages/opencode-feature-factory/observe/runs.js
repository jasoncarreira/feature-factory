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

// The repositories a directory could keep its control plane in: itself, and — if it is a linked
// worktree — the main repository it points at. Nothing above either.
//
// Both are needed, and getting this wrong broke the sidebar during a real run. The orchestrator makes
// one linked worktree per slice, and those have no control plane of their own, so a slice worktree has
// to resolve to the main repository. But a linked worktree used as the *project* root legitimately has
// its own: `factory init` writes to whatever directory it is run in. Resolving only to the main
// repository reported "no runs" while a valid run sat in the worktree; resolving only to the directory
// itself would blank the sidebar inside every slice worktree.
//
// Order matters: the directory's own control plane wins, because that is the run someone working here
// is driving. An earlier version walked up until *any* ancestor had one, which found `~/.factory` —
// a different tool's — so the search still stops at the repository.
export function repositoryRoots(startDir) {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, ".git"))) {
      const main = mainRepositoryOf(current);
      return main && main !== current ? [current, main] : [current];
    }
    const parent = dirname(current);
    if (parent === current) return [];
    current = parent;
  }
}

// The host reports *four* locations — `state`, `config`, `worktree`, `directory` — and which one
// holds the run is not ours to decide. Taking only `directory` rendered "no runs" while a live run
// sat one path away, because for a linked worktree the two differ. So this takes candidates in
// priority order and returns the first that has a control plane, along with everywhere it looked.
export function findControlPlane(startDirs) {
  const candidates = (Array.isArray(startDirs) ? startDirs : [startDirs]).filter(Boolean);
  const searched = [];
  for (const start of candidates) {
    for (const root of repositoryRoots(start)) {
      if (searched.includes(root)) continue;
      searched.push(root);
      if (existsSync(join(root, CONTROL_PLANE))) return { repo: root, searched };
    }
  }
  return { repo: null, searched };
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

// The session that owns a run, so the sidebar can offer to jump to it. Already on disk: the `lock`
// command records the claiming session beside the manifest, which is the only place a run and an
// opencode session are associated. Absent, unreadable or unparseable is simply "unknown" — a run
// whose lock has been released is still a run.
function owningSession(runDir) {
  try {
    const owner = JSON.parse(readFileSync(join(runDir, "factory.lock"), "utf8"));
    return typeof owner?.session === "string" && owner.session ? owner.session : null;
  } catch { return null; }
}

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
    session: owningSession(runDir),
    terminal: TERMINAL.has(run.status),
    // Which gate is waiting is the one thing an operator acts on, so it is not buried in a map.
    gates: Object.entries(run.gates ?? {}).map(([name, gate]) => ({ name, status: gate?.status ?? "absent" })),
    // The step still in flight, with its attempt count against the run's own bound. Slices carried
    // this from the start and steps did not, so a spec-writer on its second review round looked
    // identical to its first — and the count is the part that says whether the loop is converging or
    // about to exhaust `max_retries` and block the run.
    step: (Array.isArray(run.steps) ? run.steps : []).find((entry) => entry?.status !== "accepted") ?? null,
    max_retries: run.max_retries ?? null,
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

// One poll: where the control plane is, every run in it, which one is live, and — when there is
// none — the directories that were checked, so an empty sidebar can say why it is empty.
export function pollRuns(startDirs) {
  const { repo, searched } = findControlPlane(startDirs);
  if (!repo) return { repo: null, runs: [], active: null, searched };
  const runs = listRuns(repo);
  return { repo, runs, active: selectActiveRun(runs), searched };
}
