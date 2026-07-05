/* @jsxImportSource @opentui/solid */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";

const HIDDEN_STATUSES = new Set(["completed"]);

function factoryRoot(api) {
  for (const start of [api.state.path.worktree, api.state.path.directory].filter(Boolean)) {
    const hit = findFactoryRoot(start);
    if (hit) return hit;
  }
  const base = api.state.path.worktree || api.state.path.directory;
  return base ? join(base, ".opencode", "factory") : null;
}

function findFactoryRoot(start) {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, ".opencode", "factory");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readRuns(root) {
  if (!root || !existsSync(root)) return [];
  return readdirSync(root)
    .flatMap((runID) => {
      const file = join(root, runID, "run.json");
      if (!existsSync(file) || !statSync(file).isFile()) return [];
      try {
        const run = JSON.parse(readFileSync(file, "utf8"));
        return [summarize(run, runID, file)];
      } catch {
        return [];
      }
    })
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
}

function summarize(run, fallbackID, file) {
  return {
    run_id: String(run.run_id || fallbackID),
    status: String(run.status || "unknown"),
    mode: run.mode ? String(run.mode) : null,
    gate: pendingGate(run),
    branch: run.branch ? String(run.branch) : null,
    pr_url: run.pr_url ? String(run.pr_url) : null,
    updated_at: run.updated_at ? String(run.updated_at) : null,
    slices: sliceSummary(run),
    panel: panelSummary(run),
    terminal_reason: run.terminal_result?.reason ? String(run.terminal_result.reason) : null,
    file,
  };
}

function pendingGate(run) {
  for (const [name, gate] of Object.entries(run.gates || {})) {
    if (gate?.status === "pending") return name;
  }
  return null;
}

function sliceSummary(run) {
  const slices = Array.isArray(run.slices) ? run.slices : [];
  if (!slices.length) return null;
  return {
    merged: slices.filter((item) => item?.status === "merged").length,
    blocked: slices.filter((item) => item?.status === "blocked").length,
    total: slices.length,
  };
}

function panelSummary(run) {
  const validator = run.validator?.verdict ? String(run.validator.verdict) : null;
  const security = run.security_review?.verdict ? String(run.security_review.verdict) : null;
  if (!validator && !security) return null;
  return [validator, security].filter(Boolean).join(" / ");
}

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
  const root = () => factoryRoot(props.api);
  const [runs, setRuns] = createSignal(readRuns(root()));
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
  const timer = setInterval(() => setRuns(readRuns(root())), 2000);
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
