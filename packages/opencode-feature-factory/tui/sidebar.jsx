/* @jsxImportSource @opentui/solid */
// The sidebar component: a signal, and a loop over it.
//
// Reactive by construction, because the host will not re-run anything for us. `sidebar_content` is
// invoked *once* to obtain its child; a terminal repaint does not call it again. Content held in
// ordinary mutable state therefore renders whatever the first poll saw and never changes — which is
// what both previous adapters did, one through a nonexistent `api.render`, one through an invented
// `api.slots.refresh`. A signal is the entire mechanism: the poll writes it, OpenTUI reconciles.
//
// Everything that can be tested lives in ./poll.js. This file cannot be instantiated outside a host,
// because its intrinsic elements need an OpenTUI renderer, so it is kept to the smallest thing that
// still expresses the reactivity.
import { createSignal, For, onCleanup } from "solid-js";
import { createLineSource } from "./poll.js";

const DEFAULT_THEME = { text: "white", textMuted: "gray", error: "red", warning: "yellow", info: "cyan" };

// The one line a human has to answer is the only one coloured for attention. Colouring everything
// communicates nothing.
function lineColor(theme, line) {
  if (line.startsWith(">>")) return theme.warning;
  if (line.includes("INVALID") || line.startsWith("sidebar error")) return theme.error;
  if (line.startsWith("next:")) return theme.info;
  if (line.startsWith("  ") || line.startsWith("(")) return theme.textMuted;
  return theme.text;
}

export function Sidebar(props) {
  const theme = { ...DEFAULT_THEME, ...(props.theme ?? {}) };
  const [lines, setLines] = createSignal([]);
  const source = createLineSource({
    cwd: props.cwd,
    intervalMs: props.intervalMs,
    poll: props.poll,
    onLines: setLines,
  });
  onCleanup(source.stop);

  return (
    <box flexDirection="column">
      <For each={lines()}>{(line) => <text fg={lineColor(theme, line)}>{line}</text>}</For>
    </box>
  );
}
