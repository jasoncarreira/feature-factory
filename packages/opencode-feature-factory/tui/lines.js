// The lines the sidebar shows. Pure, so it is testable without solid-js, a JSX transform, or a
// running host — which matters because everything downstream of here can only be proven by a host.
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
