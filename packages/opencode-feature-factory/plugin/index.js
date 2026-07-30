// OpenCode integration. Read-only toward run state, by contract.
//
// This package observes and renders; it never writes run.json. The single API it
// consumes from feature-factory is the schema plus the read-only reader. If that
// stops being enough, the package boundary is wrong rather than the export list
// being too small.
//
// The predecessor's plugin already performed zero writes — no lock, no atomic
// writer, no rename. Its only route to mutation was the dispatch claim/closure
// machinery, which the small factory drops, so the boundary is now structural
// rather than a convention.
export { readRun, readRunUnchecked } from "feature-factory";

export default async function plugin() {
  return {
    // Session and task observation goes here. It reports; it does not decide.
  };
}
