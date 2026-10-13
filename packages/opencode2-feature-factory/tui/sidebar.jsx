/* @jsxImportSource @opentui/solid */
// The sidebar component: a pure view over props. The poll and the signals live in `setup`, so the slot's
// render function reads them and the host has something to re-run.
import { For, Show } from "solid-js";

// Only the semantic lines get a colour, from the host theme's feedback tokens; everything else is muted
// text, so the panel reads like the host's own sections on a light or a dark theme.
function lineColor(theme, line) {
  const feedback = theme?.text?.feedback;
  if (line.startsWith(">>")) return feedback?.warning?.base;
  if (line.includes("INVALID") || line.startsWith("sidebar error")) return feedback?.error?.base;
  if (line.startsWith("next:")) return feedback?.info?.base;
  return theme?.text?.muted;
}

export function Sidebar(props) {
  // `<Show keyed>` on a value that only ever changes recreates the subtree rather than reconciling text
  // nodes in place, which is what reliably reaches the screen in a slot the host mounts once.
  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
      <text fg={props.theme?.text?.base}><b>Feature Factory</b></text>
      <Show keyed when={props.version}>
        {() => (
          <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
            <For each={props.lines}>{(line) => <text fg={lineColor(props.theme, line)}>{line}</text>}</For>
          </box>
        )}
      </Show>
    </box>
  );
}
