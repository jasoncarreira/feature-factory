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
import { For, Show } from "solid-js";

// Only the semantic lines get a colour. Everything else leaves `fg` unset so it inherits the host's
// own foreground — the previous defaults hardcoded white and gray, which is invisible on a light theme.
// A default is the host's business; naming a colour should mean "this line is different".
// Matching the host's own sections: a bold, bright header over dimmer content. Mine were inverted —
// muted header, default-bright body — which read as the odd panel out. The actionable line keeps its
// attention colour; colouring everything communicates nothing.
function lineColor(theme, line) {
  if (line.startsWith(">>")) return theme?.warning ?? "yellow";
  if (line.includes("INVALID") || line.startsWith("sidebar error")) return theme?.error ?? "red";
  if (line.startsWith("next:")) return theme?.info ?? "cyan";
  return theme?.textMuted;
}

// A pure view over props: the poll and the signals live in the `tui()` hook, so the *slot function*
// reads them and the host has something to re-run. This held the signal itself and still painted only
// its first frame — reactively correct, visually dead.
export function Sidebar(props) {
  const theme = () => props.theme?.current;
  // `<Show keyed>` on a value that only ever changes is the repaint mechanism, ported from the
  // predecessor. `keyed` *recreates* the subtree when `when` changes instead of reconciling it, and
  // reconciling `<text>` children in place is exactly what did not reach the screen. The children
  // must be a function or `keyed` has nothing to re-invoke.
  //
  // The flex props matter in a panel that shares vertical space with the host's sections: without
  // them a long run list pushes everything else off instead of clipping.
  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
      <text fg={theme()?.text}><b>Feature Factory</b></text>
      <Show keyed when={props.version}>
        {() => (
          <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
            <For each={props.lines}>{(line) => <text fg={lineColor(theme(), line)}>{line}</text>}</For>
          </box>
        )}
      </Show>
    </box>
  );
}
