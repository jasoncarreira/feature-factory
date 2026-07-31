// The poll loop, in plain JavaScript on purpose.
//
// Moving this into the JSX component cost it all its coverage: the component's intrinsic elements need
// a running OpenTUI renderer, so it cannot be instantiated in a test at all. The interval, its cleanup,
// and the error handling are the parts that can actually be wrong in a way a test would catch — so they
// live here, and the component holds only a signal and a loop over it.
import { pollRuns } from "../observe/runs.js";
import { renderLines } from "./lines.js";
import { DEFAULT_POLL_MS } from "./sidebar-config.js";

export function createLineSource({ cwd, poll = pollRuns, intervalMs = DEFAULT_POLL_MS, onLines } = {}) {
  const read = () => {
    try {
      return renderLines(poll(cwd));
    } catch (error) {
      // A transient scan failure — a cleanup deleting run state mid-tick — must never throw into the
      // host's render loop. It becomes content instead, so the operator sees it.
      return [`sidebar error: ${error.message}`];
    }
  };

  let lines = read();
  onLines?.(lines);

  const refresh = () => {
    lines = read();
    onLines?.(lines);
    return lines;
  };

  const timer = setInterval(refresh, intervalMs);
  // Keeps a host process from being held open by a sidebar nobody is watching. Stated as intent
  // rather than as a proven fix: I first attributed a 109-second test hang to its absence, then
  // probed by removing it and the suite still finished in 367ms. The hang was an unhandled
  // "No renderer found" error, not this. So this line is defensive and unproven by any test here.
  timer.unref?.();

  return { refresh, stop: () => clearInterval(timer), lines: () => lines };
}
