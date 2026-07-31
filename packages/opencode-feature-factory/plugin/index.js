// OpenCode integration. Read-only toward run state, by contract.
//
// This package observes and renders; it never writes run.json. The API it consumes from
// feature-factory is the schema plus the read-only reader and `nextAction`. If that stops being
// enough, the package boundary is wrong rather than the export list being too small.
//
// The predecessor's plugin was 1,350 lines, and almost all of it served subsystems this rebuild
// dropped: dispatch claim/closure, post-PR CI configuration, cost attribution, lifecycle-event
// emission. What is left once those go is genuinely small, and that is the honest result rather
// than a stub — the orchestrator drives every state change through the CLI, so there is no
// correctness work for a plugin hook to do. Its job is to answer "what is this repository's run
// doing", for the sidebar and for anything else that asks.
import { pollRuns } from "../observe/runs.js";

export { readRun, readRunUnchecked, nextAction } from "feature-factory";
export { pollRuns, findControlPlane, listRuns, selectActiveRun } from "../observe/runs.js";

export default async function plugin({ directory } = {}) {
  // Resolved per call rather than captured once: opencode can hand a different directory than the
  // process cwd, and a slice worktree resolves to the main repository's control plane.
  const observe = (cwd = directory ?? process.cwd()) => pollRuns(cwd);

  return {
    name: "feature-factory",
    // Everything below reports. Nothing decides, and nothing writes.
    status() {
      const { repo, active, runs } = observe();
      if (!repo) return { control_plane: null, run: null, runs: 0 };
      return { control_plane: repo, run: active, runs: runs.length };
    },
    runs() {
      return observe().runs;
    },
  };
}
