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

// **This plugin registers no hooks, deliberately.**
//
// It previously returned `{ name, status, runs }`, none of which opencode recognises — an object the
// host accepts and then ignores, which is worse than registering nothing because it reads as
// integration. The honest position is that there is no hook worth registering: the orchestrator
// drives every state change through the CLI, so no session or task event needs to be observed for
// correctness, and this package is forbidden from writing state anyway.
//
// The plan's original sketch said "session/task observation, checked context injection". Context
// injection was the predecessor's mechanism for handing builders a plugin-owned authority block, and
// it went with the subsystems this rebuild dropped — the skill passes each builder its slice spec
// directly. BUILD-PLAN-SMALL.md has been corrected rather than left promising it.
//
// The observation helpers are exported as ordinary module exports, which is how the sidebar and any
// other caller use them. When a hook earns its place, it goes here and gets a test that fails
// without it.
export default async function plugin() {
  return {};
}
