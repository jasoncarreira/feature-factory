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
  // One line for both empty cases: no control plane, and a control plane with nothing in it. The
  // distinction is ours, not the reader's — and the old text told them to run `factory init`, which
  // is not their command. The orchestrator runs it; a human types /feature.
  if (!snapshot.repo || !snapshot.active) return ["no runs"];
  const run = snapshot.active;
  // A record that exists but does not validate is shown as broken rather than omitted. Omitting it
  // leaves an operator with no way to learn it is there.
  if (!run.valid) return [`${run.run_id}  INVALID`, run.error ?? "run.json could not be read"];

  const lines = [
    `${run.run_id}${run.jira_key ? `  ${run.jira_key}` : ""}`,
    `${run.status}  ${run.mode}  ${run.branch}`,
  ];
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
  if (snapshot.runs.length > 1) {
    lines.push(`(${snapshot.runs.length - 1} other run${snapshot.runs.length === 2 ? "" : "s"})`);
  }
  return lines;
}
