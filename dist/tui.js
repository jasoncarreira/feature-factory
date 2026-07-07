// src/tui.jsx
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";

// src/tui-data.js
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
var SKIP_DIRS = /* @__PURE__ */ new Set([".git", "node_modules", "dist", "coverage", ".cache", ".next"]);
var MAX_SCAN_DIRS = 2e3;
function factoryRoots(api) {
  const starts = [api.state.path.worktree, api.state.path.directory].filter(Boolean);
  const roots = /* @__PURE__ */ new Set();
  for (const start of starts) {
    for (const root of findFactoryRoots(start)) roots.add(root);
  }
  return [...roots].sort();
}
function readRuns(roots) {
  return roots.flatMap((root) => readRootRuns(root)).sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
}
function findFactoryRoots(start) {
  const dir = resolve(start);
  const roots = /* @__PURE__ */ new Set();
  const nearest = findNearestFactoryRoot(dir);
  if (nearest) roots.add(nearest);
  for (const root of findNestedFactoryRoots(dir)) roots.add(root);
  if (!roots.size) roots.add(join(dir, ".opencode", "factory"));
  return [...roots];
}
function findNearestFactoryRoot(start) {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, ".opencode", "factory");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function findNestedFactoryRoots(start) {
  const roots = [];
  const queue = [resolve(start)];
  let scanned = 0;
  while (queue.length && scanned < MAX_SCAN_DIRS) {
    const dir = queue.shift();
    scanned += 1;
    const candidate = join(dir, ".opencode", "factory");
    if (existsSync(candidate)) roots.push(candidate);
    for (const child of safeReadDir(dir)) {
      if (SKIP_DIRS.has(child.name)) continue;
      const path = join(dir, child.name);
      if (child.isDirectory()) queue.push(path);
    }
  }
  return roots;
}
function safeReadDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
function readRootRuns(root) {
  if (!root || !existsSync(root)) return [];
  return readdirSync(root).flatMap((runID) => {
    const file = join(root, runID, "run.json");
    if (!existsSync(file) || !statSync(file).isFile()) return [];
    try {
      const run = JSON.parse(readFileSync(file, "utf8"));
      return [summarize(run, runID, file)];
    } catch {
      return [];
    }
  });
}
function summarize(run, fallbackID, file) {
  return {
    run_id: String(run.run_id || fallbackID),
    status: String(run.status || "unknown"),
    mode: run.mode ? String(run.mode) : null,
    gate: pendingGate(run),
    branch: run.branch ? String(run.branch) : null,
    pr_url: run.pr_url ? String(run.pr_url) : null,
    review_tier: stringOrNull(run.review_tier?.selected),
    review_tier_source: stringOrNull(run.review_tier?.source),
    updated_at: run.updated_at ? String(run.updated_at) : null,
    current: currentSummary(run),
    slices: sliceSummary(run),
    panel: panelSummary(run),
    terminal_reason: run.terminal_result?.reason ? String(run.terminal_result.reason) : null,
    file
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
    total: slices.length
  };
}
function currentSummary(run) {
  const slice = firstByStatus(run.slices, ["blocked", "running", "review"]);
  if (slice) return summarizeWorkItem(slice.id, slice.status, slice.attempts);
  const step = firstByStatus(run.steps, ["blocked", "running", "review", "pending"]);
  if (step) return summarizeWorkItem(step.agent, step.status, step.attempts);
  return null;
}
function firstByStatus(items, statuses) {
  if (!Array.isArray(items)) return null;
  for (const status of statuses) {
    const item = items.find((candidate) => candidate?.status === status);
    if (item) return item;
  }
  return null;
}
function summarizeWorkItem(name, status, attempts) {
  const label = stringOrNull(name);
  if (!label || !status) return null;
  const normalizedStatus = String(status);
  const attempt = Number.isInteger(attempts) && attempts > 0 ? ` a${attempts}` : "";
  return `${label} ${normalizedStatus}${attempt}`;
}
function panelSummary(run) {
  const validator = run.validator?.verdict ? String(run.validator.verdict) : null;
  const security = run.security_review?.verdict ? String(run.security_review.verdict) : null;
  if (!validator && !security) return null;
  return [validator, security].filter(Boolean).join(" / ");
}
function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

// src/tui.jsx
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
var HIDDEN_STATUSES = /* @__PURE__ */ new Set(["completed"]);
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
  const timer = setInterval(() => setRuns(readRuns(roots())), 2e3);
  onCleanup(() => clearInterval(timer));
  return /* @__PURE__ */ jsx(Show, { when: visible(), children: /* @__PURE__ */ jsxs("box", { children: [
    /* @__PURE__ */ jsx("text", { fg: theme().text, children: /* @__PURE__ */ jsx("b", { children: "Feature Factory" }) }),
    /* @__PURE__ */ jsx(For, { each: shown(), children: (run) => /* @__PURE__ */ jsxs("box", { paddingTop: 1, children: [
      /* @__PURE__ */ jsxs("box", { flexDirection: "row", gap: 1, children: [
        /* @__PURE__ */ jsx("text", { fg: statusColor(theme(), run.status), children: "*" }),
        /* @__PURE__ */ jsx("text", { fg: theme().text, wrapMode: "none", children: truncate(run.run_id, 31) })
      ] }),
      /* @__PURE__ */ jsxs("text", { fg: theme().textMuted, children: [
        run.status,
        /* @__PURE__ */ jsxs(Show, { when: run.mode, children: [
          " | ",
          run.mode
        ] })
      ] }),
      /* @__PURE__ */ jsx(Show, { when: run.gate, children: /* @__PURE__ */ jsxs("text", { fg: theme().warning, children: [
        "gate: ",
        run.gate
      ] }) }),
      /* @__PURE__ */ jsx(Show, { when: run.current, children: /* @__PURE__ */ jsxs("text", { fg: theme().textMuted, children: [
        "current: ",
        truncate(run.current, 34)
      ] }) }),
      /* @__PURE__ */ jsx(Show, { when: run.slices, children: /* @__PURE__ */ jsxs("text", { fg: theme().textMuted, children: [
        "slices: ",
        run.slices.merged,
        "/",
        run.slices.total,
        /* @__PURE__ */ jsxs(Show, { when: run.slices.blocked, children: [
          " | blocked ",
          run.slices.blocked
        ] })
      ] }) }),
      /* @__PURE__ */ jsx(Show, { when: run.panel, children: /* @__PURE__ */ jsxs("text", { fg: theme().textMuted, children: [
        "panel: ",
        run.panel
      ] }) }),
      /* @__PURE__ */ jsx(Show, { when: run.pr_url, children: /* @__PURE__ */ jsxs("text", { fg: theme().success, children: [
        "PR: ",
        truncate(run.pr_url, 34)
      ] }) }),
      /* @__PURE__ */ jsx(Show, { when: run.terminal_reason, children: /* @__PURE__ */ jsxs("text", { fg: theme().warning, children: [
        "reason: ",
        truncate(run.terminal_reason, 30)
      ] }) }),
      /* @__PURE__ */ jsx(Show, { when: run.branch, children: /* @__PURE__ */ jsxs("text", { fg: theme().textMuted, children: [
        "branch: ",
        truncate(run.branch, 30)
      ] }) })
    ] }) })
  ] }) });
}
var plugin = {
  id: "opencode-feature-factory",
  async tui(api) {
    api.slots.register({
      order: 450,
      slots: {
        sidebar_content(_ctx, props) {
          return /* @__PURE__ */ jsx(View, { api, session_id: props.session_id });
        }
      }
    });
  }
};
var tui_default = plugin;
export {
  tui_default as default
};
