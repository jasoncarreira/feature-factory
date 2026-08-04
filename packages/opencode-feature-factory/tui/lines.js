// The lines the sidebar shows. Pure, so it is testable without solid-js, a JSX transform, or a
// running host — which matters because everything downstream of here can only be proven by a host.
// One line is marked as the thing to act on; a sidebar that flags everything flags nothing.
//
// That mark used to be its own line — `>> gate story is waiting on you` — which was both redundant
// and untrue. Redundant because an undecided gate is exactly what `next` already reports, so the
// two lines were always restatements of one fact. Untrue because a gate is seeded `pending` when
// its *stage* opens, before the artifact exists and long before anyone is asked: the state says
// "undecided", not "you have been asked", and the sidebar claimed the second. Asking is the
// conversation's job; the sidebar's job is state. So `next` carries the mark instead of a
// paraphrase of it, and stays in the same vocabulary `factory status` prints.
export function renderLines(snapshot) {
  // The empty state names where it looked. Collapsing "no control plane here" into a bare "no runs"
  // was a mistake I made twice over: an empty sidebar is indistinguishable from a broken one, and
  // both times a live run was sitting one directory away while this said nothing was happening. The
  // path is the whole diagnosis, so it is on screen. It still does not tell anyone to run
  // `factory init` — the orchestrator's command, not theirs.
  if (!snapshot.active) {
    const searched = snapshot.searched ?? [];
    return searched.length > 0 ? ["no runs", ...searched.map((dir) => `searched ${dir}`)] : ["no runs"];
  }
  const run = snapshot.active;
  const runs = Array.isArray(snapshot.runs)
    ? snapshot.runs.filter((entry) => entry && typeof entry === "object")
    : [];
  const lines = primaryLines(run);
  const otherRuns = runs.filter((entry) => entry !== run
    && (!run.manifest_path || entry.manifest_path !== run.manifest_path));
  for (const entry of otherRuns.filter((candidate) => candidate.valid && !candidate.terminal)) {
    lines.push(...secondaryLines(entry));
  }
  for (const entry of otherRuns.filter((candidate) => !candidate.valid)) {
    lines.push(...invalidLines(entry));
  }
  const otherCount = otherRuns.filter((entry) => entry.valid && entry.terminal).length;
  if (otherCount > 0) lines.push(`(${otherCount} other run${otherCount === 1 ? "" : "s"})`);
  return lines;
}

function secondaryLines(run) {
  if (run.deadLock && run.sandbox_path) {
    return [
      `${run.run_id}  lock: stale (dead; sandbox retained)`,
      `sandbox: ${run.sandbox_path}`,
      `next: ${run.next}`,
    ];
  }
  return [
    `${run.run_id}${run.jira_key ? `  ${run.jira_key}` : ""}`,
    `next: ${run.next}`,
  ];
}

function primaryLines(run) {
  if (!run.valid) return invalidLines(run);

  // A finished run is reported, not featured. `selectActiveRun` prefers a live run and falls back to
  // the newest, so with nothing running the newest dead one became the headline — four lines of
  // branch, mode, next action and terminal reason, shaped exactly like a run in progress and never
  // going away. The outcome is worth keeping on screen; the full block is not, and `factory status`
  // still has the detail.
  if (run.terminal) {
    const outcome = run.pr_url ? `${run.status}  ${run.pr_url}` : run.status;
    const lines = [`${run.run_id}${run.issue_key ? `  ${run.issue_key}` : ""}  ${outcome}`];
    if (run.sandbox_path) lines.push(`sandbox: ${run.sandbox_path}`);
    return lines;
  }

  const lines = [
    `${run.run_id}${run.issue_key ? `  ${run.issue_key}` : ""}`,
    `${run.status}  ${run.mode}  ${run.branch}`,
  ];
  // Only once a step is on its second round. At attempt 1 this line would say what `next:` already
  // says, and a restatement is what made the old gate line noise. The fraction is the point: 2/3
  // means one round left before the step blocks and the run stalls, which is worth seeing coming.
  if (run.step && run.step.attempts > 1) {
    const bound = run.max_retries ? `/${run.max_retries}` : "";
    lines.push(`${run.step.agent}  ${run.step.status} (attempt ${run.step.attempts}${bound})`);
  }
  if (run.slice_total > 0) {
    lines.push(`slices ${run.merged}/${run.slice_total} merged`);
    for (const slice of run.slices) {
      lines.push(`  ${slice.id}  ${slice.status}${slice.attempts > 1 ? ` (attempt ${slice.attempts})` : ""}`);
    }
  }
  if (run.validator) lines.push(`validator ${run.validator}`);
  if (run.pr_url) lines.push(`pr ${run.pr_url}`);
  if (run.terminal_result) lines.push(`${run.terminal_result.status}: ${run.terminal_result.reason}`);
  lines.push(`${run.awaiting_gate ? ">> " : ""}next: ${run.next}`);
  if (run.sandbox_path) {
    lines.push(`sandbox: ${run.sandbox_path}`);
    if (run.deadLock) lines.push("lock: stale (dead; sandbox retained)");
  }
  return lines;
}

function invalidLines(run) {
  return [
    `${run.run_id}  INVALID`,
    `at ${run.manifest_path}`,
    run.error ?? "run.json could not be read",
  ];
}
