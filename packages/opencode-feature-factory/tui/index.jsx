// The sidebar entry. The host reads this from `exports["./tui"]` and calls the `tui` hook on the
// default export.
//
// Wrong twice before: first a default *function* returning `{ name, start }`, which the loader rejects;
// then a default object whose hook called `api.render`/`api.update`, neither of which exists, so no slot
// was registered and a probe reported `registered: false`. Both passed every test here, because a shape
// check cannot distinguish a real host API from an invented one.
//
// This file is JSX and is bundled before publish; hosts load the built output and do not transform
// JSX themselves. `solid-js` and `@opentui/solid` are externalized from that bundle
// and declared as peer dependencies, because the contract is module *identity* — the sidebar must use
// the single copies the host installation provides, or its reactive graph runs in isolation and repaints
// nothing.
import { createSignal } from "solid-js";
import { Sidebar } from "./sidebar.jsx";
import { createLineSource } from "./poll.js";
import { ORDER, SLOT } from "./sidebar-config.js";

export { renderLines } from "./lines.js";
export { pollRuns } from "../observe/runs.js";
export { DEFAULT_POLL_MS, ORDER, SLOT } from "./sidebar-config.js";

export default {
  id: "feature-factory",
  tui(api, options = {}) {
    // The state lives *here*, in the hook, and the slot function reads it — which is the predecessor's
    // structure, arrived at the hard way and ported after mine failed in the same place. Holding the
    // signal inside the component is reactively correct and still does not repaint: the host invokes
    // the slot once to obtain a child, and a `<For>` reconciling text nodes in place inside that child
    // updated the graph while the screen kept the frame it mounted with. Reading the signals in the
    // slot function is what gives the host something to re-run.
    //
    // `version` is the second half. It exists only to be different, and `<Show keyed>` in the
    // component turns that difference into a *recreated* subtree rather than a reconciled one. That is
    // the part that actually paints.
    const [lines, setLines] = createSignal([], { equals: false });
    const [version, setVersion] = createSignal(1);
    // Both locations the host reports, `directory` first. They are the same in an ordinary checkout
    // and differ in a linked worktree, and passing only `directory` showed "no runs" through a whole
    // live run whose control plane was under the other one.
    const source = createLineSource({
      cwd: [api.state.path.directory, api.state.path.worktree],
      intervalMs: options.intervalMs,
      onLines: (next) => { setLines(next); setVersion((count) => count + 1); },
    });
    // The host's own disposal hook, as the predecessor used. The interval is unref'd as a backstop.
    api.lifecycle?.onDispose?.(() => source.stop());
    api.slots.register({
      order: ORDER,
      slots: {
        [SLOT]: (ctx) => <Sidebar lines={lines()} version={version()} theme={ctx.theme} />,
      },
    });
  },
};
