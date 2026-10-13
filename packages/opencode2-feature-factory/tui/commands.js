// Jumping from a run to the session driving it, as OpenCode 2.0 keymap commands.
//
// `factory lock` records the claiming session beside the manifest, and the host can navigate to a
// session by id, so this is a projection and a route call: no process, no write. Pure, so the mapping is
// testable without a renderer or a host.
export function runCommands(runs, { navigate } = {}) {
  return (Array.isArray(runs) ? runs : [])
    // A run whose lock was released has no session to open; offering it would navigate nowhere.
    .filter((run) => run?.valid && run.session)
    .map((run) => ({
      id: `feature-factory.open.${run.run_id}`,
      title: `Feature Factory: open run ${run.run_id}${run.next ? ` (next: ${run.next})` : ""}`,
      group: "Feature Factory",
      palette: true,
      run: () => navigate?.({ type: "session", sessionID: run.session }),
    }));
}
