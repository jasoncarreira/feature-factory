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

// Only the semantic lines get a colour. Everything else leaves `fg` unset so it inherits the host's
// own foreground — the previous defaults hardcoded white and gray, which is invisible on a light theme.
// A default is the host's business; naming a colour should mean "this line is different".
function lineColor(theme, line) {
  if (line.startsWith(">>")) return theme?.warning ?? "yellow";
  if (line.includes("INVALID") || line.startsWith("sidebar error")) return theme?.error ?? "red";
  if (line.startsWith("next:")) return theme?.info ?? "cyan";
  if (line.startsWith("  ") || line.startsWith("(")) return theme?.textMuted;
  return undefined;
}

export function Sidebar(props) {
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
      <For each={lines()}>{(line) => <text fg={lineColor(props.theme?.current, line)}>{line}</text>}</For>
    </box>
  );
}
