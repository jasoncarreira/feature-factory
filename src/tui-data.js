import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { formatCostAttributionSummary, publicCostAttributionSummary } from "./cost-attribution.js";
import { diagnoseRunFile, diagnoseRunObject, diagnosticEnvelope, diagnosticItem } from "./factory-diagnostics.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".cache", ".next"]);
const MAX_SCAN_DIRS = 2000;
const MAX_DIAGNOSTIC_SUMMARY = 180;
const ROOT_CACHE_TTL_MS = 30000;
const TUI_SIDEBAR_REFRESH_LIMITATION = "An already-open opencode TUI process can keep rendering stale Feature Factory sidebar data after the plugin bundle changes; restart or reload the TUI to pick up plugin changes.";
const FAIL_CLOSED_CONDITIONS = new Set(["invalid-run-state"]);
const rootCache = new Map();

export function tuiSidebarRefreshMetadata({ version } = {}) {
  const dataVersion = sanitizedDataVersion(version);
  return {
    schema_version: 1,
    data_version: dataVersion,
    root_cache_ttl_ms: ROOT_CACHE_TTL_MS,
    limitation: TUI_SIDEBAR_REFRESH_LIMITATION,
    label: `sidebar v${dataVersion} · plugin changes need TUI restart`,
  };
}

function sanitizedDataVersion(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return 0;
  return number;
}

export function factoryRoots(api, options = {}) {
  const starts = tuiStartPaths(api);
  const cacheKey = starts.map((start) => resolve(start)).join("\0");
  const now = Date.now();
  const cached = rootCache.get(cacheKey);
  if (!options.noCache && !options.notes && cached && cached.expiresAt > now) return cached.roots;

  const roots = new Set();
  for (const start of starts) {
    for (const root of findFactoryRoots(start, options)) roots.add(root);
  }
  const sorted = [...roots].sort();
  if (!options.noCache) rootCache.set(cacheKey, { expiresAt: now + ROOT_CACHE_TTL_MS, roots: sorted });
  return sorted;
}

function tuiStartPaths(api) {
  const path = api?.state?.path;
  const starts = [path?.worktree, path?.directory].filter(isUsablePath);
  if (starts.length) return [...new Set(starts)];
  const cwd = typeof process.cwd === "function" ? process.cwd() : null;
  return isUsablePath(cwd) ? [cwd] : [];
}

function isUsablePath(value) {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const resolved = resolve(value);
  return dirname(resolved) !== resolved;
}

export function readRuns(roots, options = {}) {
  return roots
    .flatMap((root) => readRootRuns(root, options))
    .sort(compareRunRows);
}

export function findFactoryRoots(start, options = {}) {
  if (!isUsablePath(start)) return [];
  const dir = resolve(start);
  const roots = new Set();
  const nearest = findNearestFactoryRoot(dir);
  if (nearest) roots.add(nearest);
  for (const root of findNestedFactoryRoots(dir, options)) roots.add(root);
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

function findNestedFactoryRoots(start, options = {}) {
  const roots = [];
  const queue = [resolve(start)];
  const maxScanDirs = Number.isInteger(options.maxScanDirs) && options.maxScanDirs > 0 ? options.maxScanDirs : MAX_SCAN_DIRS;
  let scanned = 0;
  while (queue.length && scanned < maxScanDirs) {
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
  if (queue.length && Array.isArray(options.notes)) {
    options.notes.push({ type: "scan-truncated", start: resolve(start), scanned, remaining: queue.length, max_scan_dirs: maxScanDirs });
  }
  return roots;
}

function compareRunRows(a, b) {
  return Number(isInvalidRow(b)) - Number(isInvalidRow(a)) || String(b.updated_at || "").localeCompare(String(a.updated_at || "")) || String(b.run_id || "").localeCompare(String(a.run_id || ""));
}

function isInvalidRow(row) {
  return row?.status === "invalid" || row?.diagnostic_classification === "invalid";
}

function safeReadDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readRootRuns(root, options = {}) {
  if (!root || !existsSync(root)) return [];
  const repoRoot = dirname(dirname(root));
  return readdirSync(root)
    .flatMap((runID) => {
      const file = join(root, runID, "run.json");
      if (!existsSync(file) || !statSync(file).isFile()) return [];
      try {
        const run = JSON.parse(readFileSync(file, "utf8"));
        const diagnostics = options.diagnostics === false ? healthyDiagnostics() : safeDiagnoseRunObject(run, file, { repoRoot });
        if (shouldUseFallbackRow(diagnostics)) return [fallbackRun(runID, file, diagnostics)];
        return [summarize(run, runID, file, diagnostics)];
      } catch (error) {
        const diagnostics = options.diagnostics === false ? parseErrorDiagnostics(file, error) : safeDiagnoseRunFile(file, { repoRoot });
        return [fallbackRun(runID, file, diagnostics)];
      }
    });
}

function parseErrorDiagnostics(file, error) {
  const checkedAt = new Date().toISOString();
  return diagnosticEnvelope([
    diagnosticItem("invalid-run-state", {
      checkedAt,
      authoritative: false,
      message: `Factory run JSON could not be parsed: ${error.message}`,
      evidence: { source: "tui-data", run_path: file, error: error.message },
    }),
  ], { checkedAt, authoritative: false });
}

function summarize(run, fallbackID, file, diagnostics = healthyDiagnostics()) {
  return {
    run_id: String(run.run_id || fallbackID),
    status: String(run.status || "unknown"),
    mode: run.mode ? String(run.mode) : null,
    gate: pendingGate(run),
    branch: run.branch ? String(run.branch) : null,
    pr_url: run.pr_url ? String(run.pr_url) : null,
    review_tier: stringOrNull(run.review_tier),
    review_tier_source: null,
    updated_at: run.updated_at ? String(run.updated_at) : null,
    current: currentSummary(run),
    steering: steeringSummary(run),
    cost: costSummary(run.cost_attribution),
    slices: sliceSummary(run),
    panel: panelSummary(run),
    terminal_reason: run.terminal_result?.reason ? String(run.terminal_result.reason) : null,
    file,
    run_dir: dirname(file),
    ...diagnosticSummary(diagnostics),
  };
}

function fallbackRun(fallbackID, file, diagnostics) {
  return {
    run_id: String(fallbackID),
    status: "invalid",
    mode: null,
    gate: null,
    branch: null,
    pr_url: null,
    review_tier: null,
    review_tier_source: null,
    updated_at: null,
    current: null,
    steering: null,
    cost: null,
    slices: null,
    panel: null,
    terminal_reason: null,
    file,
    run_dir: dirname(file),
    ...diagnosticSummary(diagnostics),
  };
}

function shouldUseFallbackRow(diagnostics) {
  return Array.isArray(diagnostics?.items) && diagnostics.items.some((item) => FAIL_CLOSED_CONDITIONS.has(item?.condition));
}

function safeDiagnoseRunFile(file, options) {
  try {
    return diagnoseRunFile(file, options);
  } catch (error) {
    const checkedAt = new Date().toISOString();
    return diagnosticEnvelope([
      diagnosticItem("invalid-run-state", {
        checkedAt,
        authoritative: false,
        message: `Factory diagnostics failed: ${error.message}`,
        evidence: { source: "tui-data", run_path: file, error: error.message },
      }),
    ], { checkedAt, authoritative: false });
  }
}

function safeDiagnoseRunObject(run, file, options) {
  try {
    return diagnoseRunObject(run, { ...options, runDir: dirname(file), runFile: file });
  } catch (error) {
    const checkedAt = new Date().toISOString();
    return diagnosticEnvelope([
      diagnosticItem("invalid-run-state", {
        checkedAt,
        authoritative: false,
        message: `Factory diagnostics failed: ${error.message}`,
        evidence: { source: "tui-data", run_path: file, error: error.message },
      }),
    ], { checkedAt, authoritative: false });
  }
}

function diagnosticSummary(diagnostics) {
  const envelope = diagnostics || healthyDiagnostics();
  return {
    diagnostics: envelope,
    diagnostic_status: stringOrDefault(envelope.status, "ok"),
    diagnostic_severity: stringOrDefault(envelope.severity, "info"),
    diagnostic_classification: stringOrDefault(envelope.classification, "healthy"),
    diagnostic_summary: truncateDiagnosticSummary(stringOrDefault(envelope.summary, "No diagnostics")),
  };
}

function healthyDiagnostics() {
  return diagnosticEnvelope([], { authoritative: true });
}

function truncateDiagnosticSummary(value) {
  const text = String(value || "");
  if (text.length <= MAX_DIAGNOSTIC_SUMMARY) return text;
  return `${text.slice(0, MAX_DIAGNOSTIC_SUMMARY - 3)}...`;
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

function currentSummary(run) {
  const activeSlice = firstByStatus(run.slices, ["running", "review"]);
  if (activeSlice) return summarizeWorkItem(activeSlice.id, activeSlice.status, activeSlice.attempts);
  const activeStep = firstByStatus(run.steps, ["running", "review"]);
  if (activeStep) return summarizeWorkItem(activeStep.agent, activeStep.status, activeStep.attempts);
  const blockedSlice = firstByStatus(run.slices, ["blocked"]);
  if (blockedSlice) return summarizeWorkItem(blockedSlice.id, blockedSlice.status, blockedSlice.attempts);
  const step = firstByStatus(run.steps, ["blocked", "pending"]);
  if (step) return summarizeWorkItem(step.agent, step.status, step.attempts);
  const panel = inferredPrePrPanelSummary(run);
  if (panel) return panel;
  return null;
}

function steeringSummary(run) {
  const steering = run?.steering;
  if (!steering || typeof steering !== "object" || Array.isArray(steering)) return { pending: null, consumed_count: 0, latest_consumed: null };
  const pending = steering.pending && typeof steering.pending === "object" && !Array.isArray(steering.pending)
    ? {
      id: stringOrNull(steering.pending.id),
      ref: stringOrNull(steering.pending.ref),
      hash: stringOrNull(steering.pending.hash),
      message_chars: Number.isInteger(steering.pending.message_chars) ? steering.pending.message_chars : null,
      created_at: stringOrNull(steering.pending.created_at),
    }
    : null;
  const consumed = Array.isArray(steering.history) ? steering.history.filter((item) => item?.event === "consumed") : [];
  const latest = consumed[consumed.length - 1];
  return {
    pending,
    consumed_count: consumed.length,
    latest_consumed: latest ? {
      ref: stringOrNull(latest.ref),
      consumed_at: stringOrNull(latest.consumed_at),
    } : null,
  };
}

function costSummary(costAttribution) {
  if (!costAttribution || typeof costAttribution !== "object" || Array.isArray(costAttribution)) return null;
  return {
    ...publicCostAttributionSummary(costAttribution),
    label: formatCostAttributionSummary(costAttribution),
  };
}

function inferredPrePrPanelSummary(run) {
  if (run?.status !== "running" || pendingGate(run)) return null;
  const testAccepted = Array.isArray(run.steps) && run.steps.some((step) => step?.agent === "test-verifier" && step?.status === "accepted");
  if (!testAccepted) return null;
  const validatorVerdict = stringOrNull(run.validator?.verdict);
  const securityVerdict = stringOrNull(run.security_review?.verdict);
  if (!validatorVerdict && !securityVerdict) return "pre-PR panel running";
  if (validatorVerdict === "NO-GO" || securityVerdict === "BLOCK") return "panel remediation running";
  if (!validatorVerdict) return "implementation-validator running";
  if (!securityVerdict) return "security-reviewer running";
  if (!run.pr_url) return "PR pending";
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

function stringOrDefault(value, fallback) {
  return typeof value === "string" ? value : fallback;
}
