/* @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { factoryRoots, readRuns } from "./tui-data.js";

const HIDDEN_STATUSES = new Set(["completed"]);
const REFRESH_INTERVAL_MS = 5000;
const MAX_VISIBLE_RUNS = 3;
const DEFAULT_THEME = {
  text: "white",
  textMuted: "gray",
  success: "green",
  error: "red",
  warning: "yellow",
  info: "cyan",
};

function currentTheme(api) {
  const theme = api?.theme?.current;
  return theme && typeof theme === "object" ? { ...DEFAULT_THEME, ...theme } : DEFAULT_THEME;
}

function statusColor(theme, status) {
  if (status === "completed") return theme.success;
  if (status === "blocked" || status === "invalid") return theme.error;
  if (status === "needs-human" || status === "partial") return theme.warning;
  if (status === "running") return theme.info;
  return theme.textMuted;
}

function diagnosticColor(theme, status) {
  if (status === "error") return theme.error;
  if (status === "warning") return theme.warning;
  return theme.textMuted;
}

function hasNonOkDiagnostic(run) {
  return Boolean(run?.diagnostic_status && run.diagnostic_status !== "ok");
}

function diagnosticLine(run) {
  const classification = run.diagnostic_classification ? `${run.diagnostic_classification}: ` : "";
  return `${classification}${run.diagnostic_summary || "Diagnostics require attention"}`;
}

function truncate(value, max) {
  if (!value || value.length <= max) return value || "";
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function sliceLine(slices) {
  if (!slices || typeof slices !== "object") return null;
  const merged = Number.isInteger(slices.merged) ? slices.merged : 0;
  const total = Number.isInteger(slices.total) ? slices.total : 0;
  const blocked = Number.isInteger(slices.blocked) && slices.blocked > 0 ? ` | blocked ${slices.blocked}` : "";
  return `slices: ${merged}/${total}${blocked}`;
}

function View(props) {
  const roots = () => factoryRoots(props.api, { noCache: true });
  const scanRuns = () => readRuns(roots());
  const [runs, setRuns] = createSignal(scanRuns());
  const theme = () => currentTheme(props.api);
  const visible = createMemo(() => runs().length > 0);
  const active = createMemo(() => runs().filter((run) => !HIDDEN_STATUSES.has(run.status) || hasNonOkDiagnostic(run)));
  const latestCompleted = createMemo(() => runs().find((run) => run.status === "completed"));
  const shown = createMemo(() => {
    const list = active();
    const completed = latestCompleted();
    if (completed && !list.some((run) => run.run_id === completed.run_id)) return [...list, completed];
    return list;
  });
  const visibleRuns = createMemo(() => shown().slice(0, MAX_VISIBLE_RUNS));
  const hiddenCount = createMemo(() => Math.max(0, runs().length - visibleRuns().length));
  const timer = setInterval(() => setRuns(scanRuns()), REFRESH_INTERVAL_MS);
  onCleanup(() => clearInterval(timer));

  return (
    <Show when={visible()}>
      <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
        <text fg={theme().text}>
          <b>Feature Factory</b>
        </text>
        <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
          <For each={visibleRuns()}>
            {(run) => {
              const slices = sliceLine(run.slices);
              return (
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
                  <Show when={slices}>
                    <text fg={theme().textMuted}>{slices}</text>
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
                  <Show when={hasNonOkDiagnostic(run)}>
                    <text fg={diagnosticColor(theme(), run.diagnostic_status)}>
                      diagnostic: {truncate(diagnosticLine(run), 42)}
                    </text>
                  </Show>
                  <Show when={run.branch}>
                    <text fg={theme().textMuted}>branch: {truncate(run.branch, 30)}</text>
                  </Show>
                </box>
              );
            }}
          </For>
          <Show when={hiddenCount() > 0}>
            <text fg={theme().textMuted}>+ {hiddenCount()} more runs</text>
          </Show>
        </box>
      </box>
    </Show>
  );
}

const plugin = {
  id: "opencode-feature-factory",
  async tui(api) {
    if (typeof api?.slots?.register !== "function") return;
    api.slots.register({
      order: 450,
      slots: {
        sidebar_content(_ctx, props) {
          return <View api={api} session_id={props?.session_id} />;
        },
      },
    });
  },
};

export default plugin;
