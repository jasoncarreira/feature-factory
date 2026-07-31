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
import { Sidebar } from "./sidebar.jsx";

export { renderLines } from "./lines.js";
export { pollRuns } from "../observe/runs.js";
export { DEFAULT_POLL_MS } from "./sidebar-config.js";

export default {
  id: "feature-factory",
  tui(api, options = {}) {
    // Content is contributed by registering a slot, and the slot returns a *component* — not a string
    // or an array. The host calls the slot once to obtain its child, so reactivity has to live inside
    // that child; returning today's lines would render them forever.
    api.slots.register({
      slots: {
        sidebar_content: () => (
          <Sidebar
            cwd={options.directory ?? options.cwd ?? process.cwd()}
            intervalMs={options.intervalMs}
            theme={options.theme}
          />
        ),
      },
    });
  },
};
