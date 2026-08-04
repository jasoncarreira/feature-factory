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
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONTROL_PLANE, nextAction, readRunUnchecked, validateRun } from "feature-factory";

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
      const roots = [canonicalPath(current), ...(main ? [canonicalPath(main)] : [])];
      return [...new Set(roots)];
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
    const roots = repositoryRoots(start);
    // Outside a repository there is no root to name — and that is the case most worth naming, because
    // it means the host is pointed somewhere unexpected: a deleted worktree, a home directory, a path
    // that moved. Reporting nothing here made "not in a repository" render as a bare "no runs",
    // identical to a broken plugin, which is the confusion this whole line exists to remove. It cost
    // a debugging round on a directory that had been removed out from under a running session.
    if (roots.length === 0 && !searched.includes(start)) searched.push(start);
    for (const root of roots) {
      if (searched.includes(root)) continue;
      searched.push(root);
      if (existsSync(join(root, CONTROL_PLANE))) return { repo: root, searched };
    }
  }
  return { repo: null, searched };
}

export function listRuns(repo) {
  const operatorRoot = canonicalPath(repo);
  const records = [...localRuns(operatorRoot), ...sandboxRuns(operatorRoot)];
  return sortRuns(deduplicateRuns(records));
}

function localRuns(repo) {
  const root = join(repo, CONTROL_PLANE);
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(root, entry.name, "run.json")))
    .map((entry) => project(join(root, entry.name), entry.name, {
      source: "local", sandboxPath: null, expectedRunId: null,
    }));
}

function sandboxRuns(repo) {
  const container = sandboxContainer(repo);
  // The container itself must be a real directory, checked without following. `readdirSync` resolves
  // a symlink, so a pre-existing `<repo>/.factory-sandboxes -> elsewhere` would enumerate another
  // directory and report its manifests as this repository's runs — the unrelated-control-plane
  // failure the derived location exists to prevent, and inconsistent with the orchestration contract,
  // which refuses a symlinked container when it creates one.
  //
  // The per-entry `isDirectory()` below cannot cover this: traversal has already crossed the
  // container before any Dirent is examined, which is why the direct-child symlink test passes while
  // this case does not.
  if (!isRealDirectory(container)) return [];
  let entries;
  try { entries = readdirSync(container, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const sandboxPath = join(container, entry.name);
      const runDir = join(sandboxPath, CONTROL_PLANE, entry.name);
      if (!existsSync(join(runDir, "run.json"))) return [];
      return [project(runDir, entry.name, {
        source: "sandbox", sandboxPath: canonicalPath(sandboxPath), expectedRunId: entry.name,
      })];
    });
}

// The run an operator means when they open the sidebar: the one still going. Terminal runs stay
// listed but never win, so finishing a run does not make yesterday's the headline.
export function selectActiveRun(runs) {
  return runs.find((run) => run.valid && !run.terminal && run.awaiting_gate)
    ?? runs.find((run) => run.valid && !run.terminal)
    ?? runs.find((run) => run.valid && run.terminal)
    ?? runs.find((run) => !run.valid)
    ?? null;
}

const TERMINAL = new Set(["completed", "blocked", "partial", "needs-human"]);
const SESSION_LOCK_KEYS = ["session", "pid", "run_id", "branch", "claimed_at", "heartbeat_at"];
const SESSION_LOCK_TTL_MS = 30 * 60 * 1000;

// The session that owns a run, so the sidebar can offer to jump to it. Already on disk: the `lock`
// command records the claiming session beside the manifest, which is the only place a run and an
// opencode session are associated. Absent, unreadable or unparseable is simply "unknown" — a run
// whose lock has been released is still a run.
function inspectSessionLock(runDir) {
  let owner;
  try {
    owner = JSON.parse(readFileSync(join(runDir, "factory.lock"), "utf8"));
  } catch { return { state: "absent", owner: null }; }
  if (!validSessionLock(owner)) return { state: "absent", owner: null };
  const ageMs = Date.now() - Date.parse(owner.heartbeat_at);
  return { state: ageMs <= SESSION_LOCK_TTL_MS ? "fresh" : "stale", owner };
}

// A session the host can navigate to is one the host issued, and the host issues `ses_`-prefixed ids.
// The lock's `session` is whatever the claimer passed, and for every run recorded before the plugin
// exported the real id that is an invented label — `opencode-163-20260803` and the like. Projecting
// those made the sidebar offer a jump that lands nowhere, which is worse than offering none: the
// consumer already filters on this field, so narrowing it here turns a broken jump into no jump.
//
// Deliberately a shape check rather than a lookup. Asking the host to resolve every id would make a
// pure projection do I/O, and if the id format ever changes this degrades to "no jump offered" —
// the safe direction — instead of resurrecting the broken one.
function navigableSession(session) {
  return typeof session === "string" && session.startsWith("ses_") && session.length > 4 ? session : null;
}

function validSessionLock(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).every((key) => SESSION_LOCK_KEYS.includes(key))
    && typeof value.session === "string" && value.session.trim().length > 0
    && Number.isInteger(value.pid)
    && typeof value.run_id === "string" && value.run_id.trim().length > 0
    && Number.isFinite(Date.parse(value.claimed_at || ""))
    && Number.isFinite(Date.parse(value.heartbeat_at || ""));
}

function project(runDir, runId, { source, sandboxPath, expectedRunId }) {
  const manifestPath = canonicalPath(join(runDir, "run.json"));
  const observed = readRunUnchecked(runDir);
  if (!observed.ok) {
    return invalidRun(runId, observed.error, source, manifestPath, sandboxPath);
  }
  let run;
  try { run = validateRun(observed.run); } catch (error) {
    return invalidRun(runId, error.message, source, manifestPath, sandboxPath);
  }
  if (expectedRunId && run.run_id !== expectedRunId) {
    return invalidRun(runId, `run_id ${run.run_id} does not match sandbox directory ${expectedRunId}`,
      source, manifestPath, sandboxPath);
  }
  const slices = Array.isArray(run.slices) ? run.slices : [];
  const lock = inspectSessionLock(runDir);
  const terminal = TERMINAL.has(run.status);
  return {
    run_id: run.run_id ?? runId,
    valid: true,
    error: null,
    source,
    manifest_path: manifestPath,
    sandbox_path: sandboxPath,
    status: run.status,
    mode: run.mode,
    branch: run.branch,
    jira_key: run.jira_key ?? null,
    updated_at: run.updated_at ?? null,
    session: navigableSession(lock.owner?.session),
    terminal,
    deadLock: !terminal && lock.state === "stale",
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

function invalidRun(runId, error, source, manifestPath, sandboxPath) {
  return {
    run_id: runId, valid: false, error, source, manifest_path: manifestPath,
    sandbox_path: sandboxPath, terminal: false, deadLock: false, updated_at: null,
  };
}

function isRealDirectory(path) {
  try {
    const value = lstatSync(path);
    return value.isDirectory() && !value.isSymbolicLink();
  } catch { return false; }
}

function sandboxContainer(repo) {
  return join(repo, ".factory-sandboxes");
}

function canonicalPath(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function deduplicateRuns(runs) {
  const byManifest = new Map();
  for (const run of runs) {
    const existing = byManifest.get(run.manifest_path);
    if (!existing || (existing.source !== "sandbox" && run.source === "sandbox")) {
      byManifest.set(run.manifest_path, run);
    }
  }
  return [...byManifest.values()];
}

function sortRuns(runs) {
  return [...runs].sort((left, right) => {
    const leftGroup = left.valid ? (left.terminal ? 1 : 0) : 2;
    const rightGroup = right.valid ? (right.terminal ? 1 : 0) : 2;
    if (leftGroup !== rightGroup) return leftGroup - rightGroup;
    if (left.valid && right.valid) {
      const byUpdated = Date.parse(right.updated_at) - Date.parse(left.updated_at);
      if (byUpdated !== 0) return byUpdated;
    }
    return String(left.run_id).localeCompare(String(right.run_id))
      || left.manifest_path.localeCompare(right.manifest_path);
  });
}

// One poll: where the control plane is, every run in it, which one is live, and — when there is
// none — the directories that were checked, so an empty sidebar can say why it is empty.
export function pollRuns(startDirs) {
  const candidates = (Array.isArray(startDirs) ? startDirs : [startDirs]).filter(Boolean);
  const roots = [...new Set(candidates.flatMap((candidate) => repositoryRoots(candidate)))];
  const searched = roots.length > 0
    ? roots.flatMap((root) => [join(root, CONTROL_PLANE), sandboxContainer(root)]).map(canonicalPath)
    : candidates.map(canonicalPath);
  const runsByRoot = roots.map((root) => ({ root, runs: listRuns(root) }));
  const runs = sortRuns(deduplicateRuns(runsByRoot.flatMap((entry) => entry.runs)));
  const repo = runsByRoot.find((entry) => entry.runs.length > 0)?.root ?? null;
  return {
    repo,
    runs,
    active: selectActiveRun(runs),
    searched: [...new Set(searched)].sort((left, right) => left.localeCompare(right)),
  };
}
