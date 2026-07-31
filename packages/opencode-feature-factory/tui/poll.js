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
  // Both the lines and the snapshot they came from: the sidebar renders the lines, and the command
  // palette needs the runs themselves to offer a jump to each one's session.
  const read = () => {
    try {
      const snapshot = poll(cwd);
      return { snapshot, lines: renderLines(snapshot) };
    } catch (error) {
      // A transient scan failure — a cleanup deleting run state mid-tick — must never throw into the
      // host's render loop. It becomes content instead, so the operator sees it.
      return { snapshot: null, lines: [`sidebar error: ${error.message}`] };
    }
  };

  // Nothing escapes a tick — the *publish*, not just the scan. The predecessor lost the sidebar to
  // this and wrote down why: "a factory cleanup deleting run state mid-tick — exactly the transition
  // to 'no current runs' — could propagate an exception into the host interval or slot render and
  // freeze the sidebar until restart." Its fix guarded the scan. Guarding only the scan is what I
  // did too, and it is not enough: `onLines` writes a signal, and whatever the host's reconciler
  // does downstream of that write runs inside this callback. A throw there strands the last frame
  // on screen with the timer still ticking, which reads exactly like a dead plugin.
  const publish = (next) => {
    try { onLines?.(next.lines, next.snapshot); } catch { /* the frame is lost; the loop is not */ }
  };

  let current = read();
  publish(current);

  const refresh = () => {
    current = read();
    publish(current);
    return current.lines;
  };

  const timer = setInterval(refresh, intervalMs);
  // Keeps a host process from being held open by a sidebar nobody is watching. Stated as intent
  // rather than as a proven fix: I first attributed a 109-second test hang to its absence, then
  // probed by removing it and the suite still finished in 367ms. The hang was an unhandled
  // "No renderer found" error, not this. So this line is defensive and unproven by any test here.
  timer.unref?.();

  return {
    refresh,
    stop: () => clearInterval(timer),
    lines: () => current.lines,
    snapshot: () => current.snapshot,
  };
}
