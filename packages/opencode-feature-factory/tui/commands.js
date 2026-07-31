// Jumping from a run to the session driving it.
//
// The association already exists on disk and nothing exposed it: `factory lock` records the claiming
// session beside the manifest, and the host can navigate to a session by id. So this is a projection
// and a route call, not a new capability — no process, no write, nothing the boundary test forbids.
//
// Built against `api.commands.register`, which the host marks deprecated in favour of
// `api.keymap.registerLayer({ commands, bindings })`. That replacement is deliberately *not* used
// yet: `@opentui/keymap` is not installed in this host, so its shape cannot be read, and this adapter
// has already shipped three versions written against an invented API. `TuiCommand` is fully typed
// where it is declared, so that is what this builds on until the successor can be verified.
//
// Pure, so the mapping is testable without a renderer or a host.
export function runCommands(runs, { navigate } = {}) {
  return (Array.isArray(runs) ? runs : [])
    // A run whose lock was released has no session to open — offering it would navigate nowhere.
    .filter((run) => run?.valid && run.session)
    .map((run) => ({
      title: `Feature Factory: open run ${run.run_id}`,
      value: `feature-factory.open.${run.run_id}`,
      category: "Feature Factory",
      // The gate or step it is on, so the palette says which run needs attention without opening it.
      description: run.next ? `next: ${run.next}` : undefined,
      onSelect: () => navigate?.("session", { sessionID: run.session }),
    }));
}
