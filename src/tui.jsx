/* @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show } from "solid-js";
import { factoryRoots, readRuns, runHasNonOkDiagnostic as hasNonOkDiagnostic, selectVisibleRuns } from "./tui-data.js";
import { renderHiddenRunsLine, renderRunTextFields } from "./tui-rendering.js";

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
let runStore = null;

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

// Returns null on a transient scan failure (e.g. a cleanup deleting state
// mid-tick) so callers keep the previous rows; a poll tick or slot mount must
// never throw into the host render loop.
function scanRuns(api) {
  try {
    return readRuns(factoryRoots(api));
  } catch {
    return null;
  }
}

function runSnapshot(runs) {
  return JSON.stringify(runs.map((run) => ({
    run_id: run.run_id,
    status: run.status,
    mode: run.mode,
    gate: run.gate,
    current: run.current,
    steering: run.steering,
    cost: run.cost,
    slices: run.slices,
    panel: run.panel,
    pr_url: run.pr_url,
    terminal_reason: run.terminal_reason,
    branch: run.branch,
    diagnostic_status: run.diagnostic_status,
    diagnostic_classification: run.diagnostic_classification,
    diagnostic_summary: run.diagnostic_summary,
    updated_at: run.updated_at,
  })));
}

function sharedRunStore(api) {
  if (!runStore) {
    const initialRuns = scanRuns(api) ?? [];
    const [runs, setRuns] = createSignal(initialRuns, { equals: false });
    const [version, setVersion] = createSignal(1);
    runStore = { api, runs, setRuns, version, setVersion, snapshot: runSnapshot(initialRuns), refreshing: false };
    setInterval(() => refreshRunStore(), REFRESH_INTERVAL_MS);
    return runStore;
  }
  runStore.api = api;
  refreshRunStore();
  return runStore;
}

function refreshRunStore() {
  if (!runStore || runStore.refreshing) return;
  runStore.refreshing = true;
  let nextRuns;
  let nextSnapshot;
  try {
    nextRuns = scanRuns(runStore.api);
    nextSnapshot = nextRuns ? runSnapshot(nextRuns) : null;
  } finally {
    runStore.refreshing = false;
  }
  if (!nextRuns || nextSnapshot === runStore.snapshot) return;
  runStore.snapshot = nextSnapshot;
  runStore.setRuns(nextRuns);
  runStore.setVersion((value) => value + 1);
}

function View(props) {
  const store = sharedRunStore(props.api);
  const runs = store.runs;
  const version = store.version;
  const theme = () => currentTheme(props.api);
  const visible = createMemo(() => runs().length > 0);
  const shown = createMemo(() => selectVisibleRuns(runs()));
  const visibleRuns = createMemo(() => shown().slice(0, MAX_VISIBLE_RUNS));
  const hiddenCount = createMemo(() => Math.max(0, runs().length - visibleRuns().length));
  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
      <text fg={theme().text}>
        <b>Feature Factory</b>
      </text>
      <Show when={visible()} fallback={<text fg={theme().textMuted}>No factory runs yet</text>}>
        <Show keyed when={version()}>
          {() => (
            <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
              <For each={visibleRuns()}>
                {(run) => {
                  const rendered = renderRunTextFields(run);
                  return (
                    <box paddingTop={1}>
                      <box flexDirection="row" gap={1}>
                        <text fg={statusColor(theme(), run.status)}>*</text>
                        <text fg={theme().text} wrapMode="none">
                          {rendered.run_id}
                        </text>
                      </box>
                      <text fg={theme().textMuted}>{rendered.status_line}</text>
                      <Show when={run.gate}>
                        <text fg={theme().warning}>{rendered.gate_line}</text>
                      </Show>
                      <Show when={run.current}>
                        <text fg={theme().textMuted}>{rendered.current_line}</text>
                      </Show>
                      <Show when={rendered.steering_line}>
                        <text fg={theme().warning}>{rendered.steering_line}</text>
                      </Show>
                      <Show when={rendered.slices_line}>
                        <text fg={theme().textMuted}>{rendered.slices_line}</text>
                      </Show>
                      <Show when={rendered.cost_line}>
                        <text fg={theme().textMuted}>{rendered.cost_line}</text>
                      </Show>
                      <Show when={run.panel}>
                        <text fg={theme().textMuted}>{rendered.panel_line}</text>
                      </Show>
                      <Show when={run.pr_url}>
                        <text fg={theme().success}>{rendered.pr_line}</text>
                      </Show>
                      <Show when={run.terminal_reason}>
                        <text fg={theme().warning}>{rendered.terminal_reason_line}</text>
                      </Show>
                      <Show when={hasNonOkDiagnostic(run)}>
                        <text fg={diagnosticColor(theme(), run.diagnostic_status)}>
                          {rendered.diagnostic_line}
                        </text>
                      </Show>
                      <Show when={run.branch}>
                        <text fg={theme().textMuted}>{rendered.branch_line}</text>
                      </Show>
                    </box>
                  );
                }}
              </For>
              <Show when={hiddenCount() > 0}>
                <text fg={theme().textMuted}>{renderHiddenRunsLine(hiddenCount())}</text>
              </Show>
            </box>
          )}
        </Show>
      </Show>
    </box>
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
