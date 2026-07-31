// The sidebar. Read-only rendering of run state.
//
// The host detects this module from `exports["./tui"]` in the manifest and calls its default
// export. The package root is the server plugin and has no `tui()` hook, so it is never mistaken
// for the sidebar entry.
//
// Deliberately split: everything that decides *what* to show is `renderLines`, a pure function over
// a poll snapshot, and it is unit-tested. The host binding below is the thinnest adapter that can
// work, because it cannot be exercised without a running host — and code that cannot be tested
// should be small enough to read instead.
import { pollRuns } from "../observe/runs.js";

export { pollRuns } from "../observe/runs.js";

export const DEFAULT_POLL_MS = 2000;

// A gate waiting on a human is the only line an operator must act on, so it is the only one marked.
// A sidebar that flags everything flags nothing.
export function renderLines(snapshot) {
  if (!snapshot.repo) return ["no control plane found", "run `factory init` to start one"];
  const run = snapshot.active;
  if (!run) return [snapshot.repo, "no runs recorded"];
  // A record that exists but does not validate is shown as broken rather than omitted. Omitting it
  // leaves an operator with no way to learn it is there.
  if (!run.valid) return [`${run.run_id}  INVALID`, run.error ?? "run.json could not be read"];

  const lines = [
    `${run.run_id}${run.jira_key ? `  ${run.jira_key}` : ""}`,
    `${run.status}  ${run.mode}  ${run.branch}`,
  ];
  if (run.awaiting_gate) lines.push(`>> gate ${run.awaiting_gate} is waiting on you`);
  if (run.slice_total > 0) {
    lines.push(`slices ${run.merged}/${run.slice_total} merged`);
    for (const slice of run.slices) {
      lines.push(`  ${slice.id}  ${slice.status}${slice.attempts > 1 ? ` (attempt ${slice.attempts})` : ""}`);
    }
  }
  if (run.validator) lines.push(`validator ${run.validator}`);
  if (run.pr_url) lines.push(`pr ${run.pr_url}`);
  if (run.terminal_result) lines.push(`${run.terminal_result.status}: ${run.terminal_result.reason}`);
  lines.push(`next: ${run.next}`);
  if (snapshot.runs.length > 1) {
    lines.push(`(${snapshot.runs.length - 1} other run${snapshot.runs.length === 2 ? "" : "s"})`);
  }
  return lines;
}

// `poll` is injectable so this can be driven without a filesystem, and the returned handle exposes
// `stop` so the host owns the lifecycle rather than this module leaking an interval nobody can clear.
export function createSidebar({ cwd = process.cwd(), poll = pollRuns, intervalMs = DEFAULT_POLL_MS, onUpdate } = {}) {
  let lines = [];
  const refresh = () => {
    lines = renderLines(poll(cwd));
    onUpdate?.(lines);
    return lines;
  };
  refresh();
  const timer = setInterval(refresh, intervalMs);
  // An unreferenced interval keeps a host process alive for a sidebar nobody is watching.
  timer.unref?.();
  return { refresh, stop: () => clearInterval(timer), lines: () => lines };
}

// The host's contract, not a guess: a default *object* carrying a `tui(api, options, meta)` hook.
// This module previously default-exported a function returning `{ name, start }`, which opencode
// rejects before any of the code below runs — so the sidebar would never have appeared, and nothing
// here could have told us. Verified against the loader's shape check rather than inferred from the
// README, which only said the entry is read from `exports["./tui"]`.
export default {
  id: "feature-factory",
  tui(api, options = {}) {
    // `api` belongs to the host; this package neither stores nor writes through it. The sidebar is
    // handed the directory to watch and reports upward through the host's own update channel.
    const sidebar = createSidebar({
      cwd: options.directory ?? options.cwd ?? process.cwd(),
      intervalMs: options.intervalMs ?? DEFAULT_POLL_MS,
      onUpdate: (lines) => api?.render?.(lines) ?? api?.update?.(lines),
    });
    return {
      lines: sidebar.lines,
      refresh: sidebar.refresh,
      dispose: sidebar.stop,
    };
  },
};
