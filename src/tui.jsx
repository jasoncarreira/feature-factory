/* @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { factoryRoots, readRuns } from "./tui-data.js";

const HIDDEN_STATUSES = new Set(["completed"]);

function statusColor(theme, status) {
  if (status === "completed") return theme.success;
  if (status === "blocked") return theme.error;
  if (status === "needs-human" || status === "partial") return theme.warning;
  if (status === "running") return theme.info;
  return theme.textMuted;
}

function truncate(value, max) {
  if (!value || value.length <= max) return value || "";
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function View(props) {
  const roots = () => factoryRoots(props.api);
  const [runs, setRuns] = createSignal(readRuns(roots()));
  const theme = () => props.api.theme.current;
  const visible = createMemo(() => runs().length > 0);
  const active = createMemo(() => runs().filter((run) => !HIDDEN_STATUSES.has(run.status)));
  const latestCompleted = createMemo(() => runs().find((run) => run.status === "completed"));
  const shown = createMemo(() => {
    const list = active();
    const completed = latestCompleted();
    if (completed && !list.some((run) => run.run_id === completed.run_id)) return [...list, completed];
    return list;
  });
  const timer = setInterval(() => setRuns(readRuns(roots())), 2000);
  onCleanup(() => clearInterval(timer));

  return (
    <Show when={visible()}>
      <box>
        <text fg={theme().text}>
          <b>Feature Factory</b>
        </text>
        <For each={shown()}>
          {(run) => (
            <box paddingTop={1}>
              <box flexDirection="row" gap={1}>
                <text fg={statusColor(theme(), run.status)}>*</text>
                <text fg={theme().text} wrapMode="none">
                  {truncate(run.run_id, 31)}
                </text>
              </box>
              <text fg={theme().textMuted}>
                {run.status}
                <Show when={run.mode}> | {run.mode}</Show>
              </text>
              <Show when={run.gate}>
                <text fg={theme().warning}>gate: {run.gate}</text>
              </Show>
              <Show when={run.current}>
                <text fg={theme().textMuted}>current: {truncate(run.current, 34)}</text>
              </Show>
              <Show when={run.slices}>
                <text fg={theme().textMuted}>
                  slices: {run.slices.merged}/{run.slices.total}
                  <Show when={run.slices.blocked}> | blocked {run.slices.blocked}</Show>
                </text>
              </Show>
              <Show when={run.panel}>
                <text fg={theme().textMuted}>panel: {run.panel}</text>
              </Show>
              <Show when={run.pr_url}>
                <text fg={theme().success}>PR: {truncate(run.pr_url, 34)}</text>
              </Show>
              <Show when={run.terminal_reason}>
                <text fg={theme().warning}>reason: {truncate(run.terminal_reason, 30)}</text>
              </Show>
              <Show when={run.branch}>
                <text fg={theme().textMuted}>branch: {truncate(run.branch, 30)}</text>
              </Show>
            </box>
          )}
        </For>
      </box>
    </Show>
  );
}

const plugin = {
  id: "opencode-feature-factory",
  async tui(api) {
    api.slots.register({
      order: 450,
      slots: {
        sidebar_content(_ctx, props) {
          return <View api={api} session_id={props.session_id} />;
        },
      },
    });
  },
};

export default plugin;
