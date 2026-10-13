// The OpenCode 2.0 CLI plugin: a run list in the sidebar, and a palette command per run that jumps to the
// session driving it. Read-only: it polls run state from disk and never writes it.
//
// A plain `{ id, setup }` object: in 2.0 `Plugin.define` from `@opencode/plugin/tui` returns its argument.
// This file is JSX and is bundled before publish; `solid-js` and `@opentui/solid` are externalized and
// declared as peer dependencies, because the sidebar must share the host's reactive runtime.
import { createSignal } from "solid-js";
import { Sidebar } from "./sidebar.jsx";
import { createLineSource } from "./poll.js";
import { runCommands } from "./commands.js";
import { SLOT } from "./sidebar-config.js";

export { renderLines } from "./lines.js";
export { runCommands } from "./commands.js";
export { pollRuns } from "../observe/runs.js";
export { DEFAULT_POLL_MS, SLOT } from "./sidebar-config.js";

export default {
  id: "feature-factory",
  setup(context) {
    const [lines, setLines] = createSignal([], { equals: false });
    const [runs, setRuns] = createSignal([], { equals: false });
    const [version, setVersion] = createSignal(1);
    const directory = context.location?.directory ?? context.data?.location?.default?.()?.directory;
    const source = createLineSource({
      cwd: [directory].filter(Boolean),
      intervalMs: context.options?.intervalMs,
      onLines: (next, snapshot) => {
        setLines(next);
        setRuns(snapshot?.runs ?? []);
        setVersion((count) => count + 1);
      },
    });
    const dropSlot = context.ui.slot({
      append: SLOT,
      render: () => <Sidebar lines={lines()} version={version()} theme={context.theme} />,
    });
    // Reactive: the layer re-reads `runs()`, so the palette always offers the current runs.
    context.keymap.layer(() => ({
      mode: "global",
      commands: runCommands(runs(), { navigate: (route) => context.ui.router.navigate(route) }),
    }));
    return () => {
      source.stop();
      dropSlot?.();
    };
  },
};
