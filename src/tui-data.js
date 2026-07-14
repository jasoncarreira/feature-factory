import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { publicCostAttributionSummary } from "./cost-attribution.js";
import {
  DIAGNOSTIC_CLASSIFICATIONS,
  DIAGNOSTIC_CONDITIONS,
  DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_STATUSES,
  diagnoseRunFile,
  diagnoseRunObject,
  diagnosticEnvelope,
  diagnosticItem,
} from "./factory-diagnostics.js";
import {
  freeformSegment,
  identitySegment,
  isDisplaySafeBranch,
  isDisplaySafeRunId,
  isDisplaySafeSteeringRef,
  projectDiagnosticData,
  projectFreeformData,
  renderTerminalSegmentsOrFallback,
} from "./hardening/output-policy.js";
import { REDACTED_VALUE } from "./hardening/sensitive-data.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".cache", ".next"]);
const MAX_SCAN_DIRS = 2000;
const MAX_DIAGNOSTIC_SUMMARY = 180;
const ROOT_CACHE_TTL_MS = 30000;
const FAIL_CLOSED_CONDITIONS = new Set(["invalid-run-state"]);
const DIAGNOSTIC_IDENTITIES = Object.freeze({
  condition: new Set(DIAGNOSTIC_CONDITIONS),
  classification: new Set(DIAGNOSTIC_CLASSIFICATIONS),
  severity: new Set(DIAGNOSTIC_SEVERITIES),
  status: new Set(DIAGNOSTIC_STATUSES),
});
const rootCache = new Map();

export function factoryRoots(api, options = {}) {
  const starts = tuiStartPaths(api);
  // The session's own `.opencode/factory` candidates are always part of the
  // result — even when they do not exist yet and even on a cache hit that
  // holds other discovered roots. A run created in the active project must
  // become visible on the next poll tick, never after a cache TTL expiry.
  // readRootRuns tolerates roots that do not exist.
  const candidates = starts.map((start) => join(resolve(start), ".opencode", "factory"));
  const cacheKey = starts.map((start) => resolve(start)).join("\0");
  const now = Date.now();
  const cached = rootCache.get(cacheKey);
  if (!options.noCache && !options.notes && cached && cached.expiresAt > now && cached.roots.some((root) => existsSync(root))) {
    return mergeRoots(cached.roots, candidates);
  }

  const roots = new Set();
  for (const start of starts) {
    for (const root of findFactoryRoots(start, options)) roots.add(root);
  }
  const sorted = [...roots].sort();
  if (!options.noCache) rootCache.set(cacheKey, { expiresAt: now + ROOT_CACHE_TTL_MS, roots: sorted });
  return mergeRoots(sorted, candidates);
}

function mergeRoots(roots, candidates) {
  return [...new Set([...roots, ...candidates])].sort();
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

export function runHasNonOkDiagnostic(run) {
  return Boolean(run?.diagnostic_status && run.diagnostic_status !== "ok");
}

// Sidebar visibility rule, extracted so the documented contract is testable:
// non-completed runs are always listed; a completed run stays listed while it
// carries a non-ok diagnostic; and the most recent completed run is appended
// even when healthy. Multiple completed runs can therefore appear at once when
// older completed runs still have diagnostics that need attention.
export function selectVisibleRuns(runs) {
  const rows = Array.isArray(runs) ? runs : [];
  const list = rows.filter((run) => run?.status !== "completed" || runHasNonOkDiagnostic(run));
  const latestCompleted = rows.find((run) => run?.status === "completed");
  if (latestCompleted && !list.some((run) => run.run_id === latestCompleted.run_id)) return [...list, latestCompleted];
  return list;
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

// A `factory cleanup` (or any operator deletion) can remove roots, run
// directories, or run.json between the individual fs calls of a poll tick.
// Every step therefore tolerates disappearance instead of throwing: a scan
// tick must never propagate an exception into the TUI render loop, and a
// vanished run is simply absent — not an invalid row.
function readRootRuns(root, options = {}) {
  if (!root) return [];
  const repoRoot = dirname(dirname(root));
  return safeReadDirNames(root)
    .flatMap((runID) => {
      const file = join(root, runID, "run.json");
      if (!safeIsFile(file)) return [];
      try {
        const run = JSON.parse(readFileSync(file, "utf8"));
        const diagnostics = options.diagnostics === false ? healthyDiagnostics() : safeDiagnoseRunObject(run, file, { repoRoot });
        if (shouldUseFallbackRow(diagnostics)) return [fallbackRun(runID, file, diagnostics)];
        return [summarize(run, runID, file, diagnostics)];
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        const diagnostics = options.diagnostics === false ? parseErrorDiagnostics(file, error) : safeDiagnoseRunFile(file, { repoRoot });
        return [fallbackRun(runID, file, diagnostics)];
      }
    });
}

function safeReadDirNames(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeIsFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
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
    run_id: run.run_id === fallbackID && isDisplaySafeRunId(run.run_id) ? run.run_id : REDACTED_VALUE,
    status: projectFreeformText(run.status || "unknown"),
    mode: projectOptionalFreeformText(run.mode),
    gate: projectOptionalFreeformText(pendingGate(run)),
    branch: projectOptionalBranch(run.branch),
    pr_url: projectOptionalFreeformText(run.pr_url),
    review_tier: projectOptionalFreeformText(stringOrNull(run.review_tier)),
    review_tier_source: null,
    updated_at: projectOptionalFreeformText(run.updated_at),
    current: projectOptionalFreeformText(currentSummary(run)),
    steering: steeringSummary(run),
    cost: costSummary(run.cost_attribution),
    slices: sliceSummary(run),
    panel: projectOptionalFreeformText(panelSummary(run)),
    terminal_reason: projectOptionalFreeformText(run.terminal_result?.reason),
    file: projectFreeformText(file),
    run_dir: projectFreeformText(dirname(file)),
    ...diagnosticSummary(diagnostics),
  };
}

function fallbackRun(fallbackID, file, diagnostics) {
  return {
    run_id: isDisplaySafeRunId(fallbackID) ? fallbackID : REDACTED_VALUE,
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
    file: projectFreeformText(file),
    run_dir: projectFreeformText(dirname(file)),
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
  const envelope = projectTuiDiagnosticData(diagnostics || healthyDiagnostics());
  return {
    diagnostics: envelope,
    diagnostic_status: stringOrDefault(envelope.status, "ok"),
    diagnostic_severity: stringOrDefault(envelope.severity, "info"),
    diagnostic_classification: stringOrDefault(envelope.classification, "healthy"),
    diagnostic_summary: truncateDiagnosticSummary(stringOrDefault(envelope.summary, "No diagnostics")),
  };
}

export function projectTuiDiagnosticData(diagnostics) {
  return terminalSafeProjection(plainProjection(projectDiagnosticData(diagnostics, {
    validatedIdentityPaths: validatedDiagnosticIdentityPaths(diagnostics),
  })));
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
  if (!steering || typeof steering !== "object" || Array.isArray(steering)) return { pending: null, uncheckpointed: null, consumed_count: 0, latest_consumed: null, boundary: null, action_claim: null, last_action: null, pr_fence: null };
  const pending = steering.pending && typeof steering.pending === "object" && !Array.isArray(steering.pending)
    ? {
      id: projectOptionalFreeformText(stringOrNull(steering.pending.id)),
      ref: projectOptionalSteeringRef(stringOrNull(steering.pending.ref)),
      hash: projectOptionalFreeformText(stringOrNull(steering.pending.hash)),
      message_chars: Number.isInteger(steering.pending.message_chars) ? steering.pending.message_chars : null,
      created_at: projectOptionalFreeformText(stringOrNull(steering.pending.created_at)),
    }
    : null;
  const consumed = Array.isArray(steering.history) ? steering.history.filter((item) => item?.event === "consumed") : [];
  const latest = consumed[consumed.length - 1];
  const uncheckpointed = steering.uncheckpointed && typeof steering.uncheckpointed === "object" && !Array.isArray(steering.uncheckpointed)
    ? {
      id: projectOptionalFreeformText(stringOrNull(steering.uncheckpointed.id)),
      ref: projectOptionalSteeringRef(stringOrNull(steering.uncheckpointed.ref)),
      hash: projectOptionalFreeformText(stringOrNull(steering.uncheckpointed.hash)),
      message_chars: Number.isInteger(steering.uncheckpointed.message_chars) ? steering.uncheckpointed.message_chars : null,
      created_at: projectOptionalFreeformText(stringOrNull(steering.uncheckpointed.created_at)),
      consumed_at: projectOptionalFreeformText(stringOrNull(steering.uncheckpointed.consumed_at)),
    }
    : null;
  return {
    pending,
    uncheckpointed,
    consumed_count: consumed.length,
    latest_consumed: latest ? {
      ref: projectOptionalSteeringRef(stringOrNull(latest.ref)),
      consumed_at: projectOptionalFreeformText(stringOrNull(latest.consumed_at)),
    } : null,
    boundary: steering.boundary && typeof steering.boundary === "object" ? {
      kind: projectOptionalFreeformText(stringOrNull(steering.boundary.kind)),
      token: projectOptionalFreeformText(stringOrNull(steering.boundary.token)),
      generation: Number.isInteger(steering.boundary.generation) ? steering.boundary.generation : null,
      created_at: projectOptionalFreeformText(stringOrNull(steering.boundary.created_at)),
    } : null,
    action_claim: steeringActionSummary(steering.action_claim),
    last_action: steeringActionSummary(steering.last_action),
    pr_fence: steering.pr_fence && typeof steering.pr_fence === "object" ? {
      token: projectOptionalFreeformText(stringOrNull(steering.pr_fence.token)),
      generation: Number.isInteger(steering.pr_fence.generation) ? steering.pr_fence.generation : null,
      created_at: projectOptionalFreeformText(stringOrNull(steering.pr_fence.created_at)),
    } : null,
  };
}

function steeringActionSummary(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  return {
    kind: projectOptionalFreeformText(stringOrNull(action.kind)),
    token: projectOptionalFreeformText(stringOrNull(action.token)),
    generation: Number.isInteger(action.generation) ? action.generation : null,
    claimed_at: projectOptionalFreeformText(stringOrNull(action.claimed_at)),
    outcome: projectOptionalFreeformText(stringOrNull(action.outcome)),
    resolved_at: projectOptionalFreeformText(stringOrNull(action.resolved_at)),
  };
}

function costSummary(costAttribution) {
  if (!costAttribution || typeof costAttribution !== "object" || Array.isArray(costAttribution)) return null;
  const summary = projectPublicStrings(publicCostAttributionSummary(costAttribution));
  return { ...summary, label: formatProjectedCostSummary(summary) };
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
  const label = projectOptionalFreeformData(stringOrNull(name));
  if (!label || !status) return null;
  const normalizedStatus = projectFreeformData(String(status));
  const attempt = Number.isInteger(attempts) && attempts > 0 ? ` a${attempts}` : "";
  return `${label} ${normalizedStatus}${attempt}`;
}

function panelSummary(run) {
  const validator = projectOptionalFreeformData(run.validator?.verdict);
  const security = projectOptionalFreeformData(run.security_review?.verdict);
  if (!validator && !security) return null;
  return [validator, security].filter(Boolean).join(" / ");
}

function validatedDiagnosticIdentityPaths(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const paths = [];
  for (const field of ["status", "severity", "classification"]) {
    if (DIAGNOSTIC_IDENTITIES[field].has(value[field])) paths.push([field]);
  }
  if (!Array.isArray(value.items)) return paths;
  for (let index = 0; index < value.items.length; index += 1) {
    const item = value.items[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    for (const field of ["condition", "status", "severity", "classification"]) {
      if (DIAGNOSTIC_IDENTITIES[field].has(item[field])) paths.push(["items", String(index), field]);
    }
  }
  return paths;
}

function plainProjection(value) {
  if (Array.isArray(value)) return value.map(plainProjection);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainProjection(item)]));
  }
  return value;
}

function terminalSafeProjection(value) {
  if (typeof value === "string") return projectFreeformText(value);
  if (Array.isArray(value)) return value.map(terminalSafeProjection);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, terminalSafeProjection(item)]));
  }
  return value;
}

function projectPublicStrings(value) {
  if (typeof value === "string") return projectFreeformText(value);
  if (Array.isArray(value)) return value.map(projectPublicStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, projectPublicStrings(item)]));
  }
  return value;
}

function projectFreeformText(value) {
  return renderTerminalSegmentsOrFallback([freeformSegment(String(value))]);
}

function projectOptionalFreeformText(value) {
  return value === null || value === undefined ? null : projectFreeformText(value);
}

function projectOptionalBranch(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!isDisplaySafeBranch(text)) return projectFreeformText(text);
  return renderTerminalSegmentsOrFallback([identitySegment(text)]);
}

function projectOptionalSteeringRef(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!isDisplaySafeSteeringRef(text)) return projectFreeformText(text);
  return renderTerminalSegmentsOrFallback([identitySegment(text)]);
}

function projectOptionalFreeformData(value) {
  return value === null || value === undefined ? null : projectFreeformData(String(value));
}

function formatProjectedCostSummary(summary) {
  const parts = [`cost ${summary.status}`, `${summary.entry_count} ${summary.entry_count === 1 ? "entry" : "entries"}`];
  if (summary.total_tokens !== undefined) parts.push(`${summary.total_tokens} tokens`);
  else if (summary.input_tokens !== undefined || summary.output_tokens !== undefined) {
    parts.push(`${summary.input_tokens ?? "?"}/${summary.output_tokens ?? "?"} tokens`);
  }
  if (summary.mixed_currency) parts.push("mixed currency");
  else if (summary.cost_total !== undefined) parts.push(`${formatCost(summary.cost_total)} ${summary.cost_currency || ""}`.trim());
  if (summary.missing.length > 0) parts.push(`missing ${summary.missing.join(",")}`);
  return parts.join(" · ");
}

function formatCost(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function stringOrDefault(value, fallback) {
  return typeof value === "string" ? value : fallback;
}
