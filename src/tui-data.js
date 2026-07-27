import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { publicCostAttributionSummary } from "./cost-attribution.js";
import { inspectProcessEvidence, readProcessEvidence } from "./process-evidence.js";
import { directFactoryRootForLookup, safeFactoryRootForLookup } from "./factory-paths.js";
import { repoRoot } from "./git.js";
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
import { hashValue } from "./refs.js";

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
const UNKNOWN_WORKFLOW = Symbol("unknown-workflow");
const UNKNOWN_WORKFLOW_LABEL = "workflow state unknown";
const PRE_PR_GATE_LABELS = Object.freeze({
  pending: "pre-PR approval pending",
  approved: "pre-PR approved",
  changes_requested: "pre-PR changes requested",
  stopped: "pre-PR stopped",
});
const ACTIVE_POST_PR_LABELS = Object.freeze({
  observing: "post-PR checks running",
  "failure-recording": "post-PR failure recording",
  "remediation-planned": "post-PR remediation planned",
  "remediation-running": "post-PR remediation running",
  "changes-observed": "post-PR changes observed",
  committed: "post-PR remediation committed",
  revalidating: "post-PR revalidation running",
  validated: "post-PR revalidation passed",
  "push-pending": "post-PR push pending",
  "remote-confirmed": "post-PR remote confirmed",
});
const TERMINAL_POST_PR_LABELS = Object.freeze({
  succeeded: "post-PR succeeded",
  blocked: "post-PR blocked",
  "needs-human": "post-PR needs human",
});
const POST_PR_PHASES = new Set(["disabled", "awaiting-pr", ...Object.keys(ACTIVE_POST_PR_LABELS), ...Object.keys(TERMINAL_POST_PR_LABELS)]);
const VALIDATOR_VERDICTS = new Set(["GO", "GO-WITH-NITS", "NO-GO"]);
const SECURITY_VERDICTS = new Set(["PASS", "BLOCK"]);
const PANEL_AGENTS = new Set(["implementation-validator", "security-reviewer"]);
const BUILD_SPECIAL_LABELS = Object.freeze({
  "merged-slice-repair": ["merged-slice repair running", "merged-slice repair awaiting integration"],
  "integration-amendment": ["integration amendment running", "integration amendment awaiting integration"],
  "integration-conflict": ["integration conflict repair running", "integration conflict repair awaiting integration"],
});
const SPECIAL_DISPATCH_ROUTES = new Set([...Object.keys(BUILD_SPECIAL_LABELS), "panel-remediation", "post-pr-remediation"]);
const PR_OPERATION_KEYS = Object.freeze(["operation_id", "repository", "created_at", "head_ref", "head_sha", "base_ref", "base_sha", "draft", "pr_url", "pr_number", "pr_node_id"]);
const PR_FENCE_CONTROL_KEYS = Object.freeze(["token", "generation", "state_hash", "created_at"]);
const PR_FENCE_IDENTITY_KEYS = Object.freeze(["operation_id", "repository", "head_ref", "head_sha", "base_ref", "base_sha", "draft"]);
const TEST_EXECUTION_CLAIM_KEYS = Object.freeze(["schema_version", "kind", "state", "nonce", "run_id", "attempt", "plan_ref", "plan_hash", "head_sha", "receipt_ref", "claimed_at"]);

export function factoryRoots(api, options = {}) {
  const starts = tuiStartPaths(api);
  // The canonical factory root for each session start is always part of the
  // result — even when it does not exist yet and even on a cache hit that
  // holds other discovered roots. A run created in the active project must
  // become visible on the next poll tick, never after a cache TTL expiry.
  // directFactoryRootForLookup mirrors factory root selection but skips unsafe
  // symlink candidates instead of weakening the write path's strict rejection.
  // A session opened in a repo subdirectory still sees runs written at the Git
  // root. readRootRuns tolerates roots that do not exist.
  const candidates = starts.flatMap((start) => [
    directFactoryRootForLookup(start),
    safeFactoryRootForLookup(join(repoRoot(start), ".opencode", "factory")),
  ]).filter(Boolean);
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
  if (!roots.size) {
    const fallback = safeFactoryRootForLookup(join(dir, ".opencode", "factory"));
    if (fallback) roots.add(fallback);
  }
  return [...roots];
}

function findNearestFactoryRoot(start) {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, ".opencode", "factory");
    if (existsSync(candidate)) {
      const safeCandidate = safeFactoryRootForLookup(candidate);
      if (safeCandidate) return safeCandidate;
    }
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
    if (existsSync(candidate)) {
      const safeCandidate = safeFactoryRootForLookup(candidate);
      if (safeCandidate) roots.push(safeCandidate);
    }
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
        return [summarize(run, runID, file, diagnostics, options)];
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

// Staleness must match run-state's authoritative `inspectHeartbeatLiveness`
// exactly: max(2 * interval_ms, MIN_STALE_HEARTBEAT_MS), with interval_ms taken
// from the heartbeat record and DEFAULT_HEARTBEAT_INTERVAL_MS when it is absent
// or invalid. Hardcoding the floor alone would classify a still-current
// heartbeat as stale for any interval above 60s and probe the process early.
// These constants are duplicated from run-state deliberately rather than
// importing them, because that module is being rewritten by the legacy
// retirement work; folding them into one shared constants module is #113's job.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
const MIN_STALE_HEARTBEAT_MS = 120000;

function heartbeatStaleMs(intervalMs) {
  const interval = Number.isInteger(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_HEARTBEAT_INTERVAL_MS;
  return Math.max(2 * interval, MIN_STALE_HEARTBEAT_MS);
}

// Display-only liveness classification. Heartbeat freshness and process state
// fail in opposite directions — a heartbeat can go stale while work continues,
// and a heartbeat daemon can outlive a dead run — so neither answers "wait or
// intervene?" alone. This never becomes workflow authority: the checked
// transitions remain the only thing that gates work, and anything unreadable or
// unverifiable reports `unknown` rather than guessing in either direction.
function projectProcessActivity(runDir, options = {}) {
  const read = safeReadProcessRecord(runDir, options);
  if (!read || read.missing) return null;
  if (!read.ok || !read.evidence) return processActivity("unknown", "process record is unreadable");

  const evidence = read.evidence;
  const stale = heartbeatIsStale(runDir, options);
  const stopped = evidence.state !== "running";

  if (stopped && !stale) {
    return processActivity("heartbeat-orphaned", `process ${evidence.state} while the heartbeat still ticks`, evidence);
  }
  if (stopped) return processActivity("stopped", `process ${evidence.state}`, evidence);
  if (!stale) return processActivity("running", "process running, heartbeat current", evidence);

  // Stale heartbeat with a process record still claiming `running`: the record
  // may predate a supervisor that died before it could write an exit, so verify
  // identity rather than trusting either signal.
  const status = verifiedProcessStatus(runDir, options);
  if (status === "live" || status === "live-and-matching") {
    return processActivity("working", "heartbeat stale, process verified live", evidence);
  }
  if (status === "absent") return processActivity("orphaned", "heartbeat stale, process absent", evidence);
  if (status === "mismatched") return processActivity("orphaned", "heartbeat stale, pid reused by another process", evidence);
  return processActivity("unknown", "heartbeat stale, process liveness indeterminate", evidence);
}

function processActivity(classification, detail, evidence = null) {
  return {
    classification,
    detail: projectFreeformText(detail),
    state: evidence ? projectOptionalFreeformText(stringOrNull(evidence.state)) : null,
    updated_at: evidence ? projectOptionalFreeformText(stringOrNull(evidence.updated_at)) : null,
    log_ref: evidence ? projectOptionalFreeformData(stringOrNull(evidence.log_ref)) : null,
  };
}

function safeReadProcessRecord(runDir, options = {}) {
  if (typeof options.readProcessRecord === "function") return options.readProcessRecord(runDir);
  try {
    return readProcessEvidence(runDir);
  } catch {
    return { ok: false, missing: false, reason: "process record read failed", evidence: null };
  }
}

// Verification spawns an identity probe, so it runs only on the stale-heartbeat
// path rather than on every poll of a healthy run.
function verifiedProcessStatus(runDir, options = {}) {
  if (typeof options.verifyProcess === "function") return options.verifyProcess(runDir);
  try {
    return stringOrNull(inspectProcessEvidence(runDir)?.verification?.status);
  } catch {
    return null;
  }
}

function heartbeatIsStale(runDir, options = {}) {
  const nowMs = typeof options.now === "function" ? options.now() : Date.now();
  const record = readHeartbeatRecord(runDir);
  if (record === null || record.tickMs === null) return true;
  return nowMs - record.tickMs > heartbeatStaleMs(record.intervalMs);
}

function readHeartbeatRecord(runDir) {
  try {
    const file = join(runDir, "heartbeat.json");
    if (!safeIsFile(file)) return null;
    const heartbeat = JSON.parse(readFileSync(file, "utf8"));
    const parsed = Date.parse(heartbeat?.last_tick_at || "");
    return { tickMs: Number.isFinite(parsed) ? parsed : null, intervalMs: heartbeat?.interval_ms };
  } catch {
    return null;
  }
}

function summarize(run, fallbackID, file, diagnostics = healthyDiagnostics(), options = {}) {
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
    process: projectProcessActivity(dirname(file), options),
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
  for (const project of [
    projectPostPrPhase,
    projectPrAuthority,
    projectPrFence,
    projectPrePrGate,
    projectPanelAuthority,
    projectCheckedTestExecution,
    projectBuildSpecialDispatch,
    projectActiveSlice,
    projectRunningStep,
    projectBlockedSlice,
  ]) {
    const projected = project(run);
    if (projected === UNKNOWN_WORKFLOW) return UNKNOWN_WORKFLOW_LABEL;
    if (projected !== undefined) return projected;
  }
  const displayableSteps = Array.isArray(run.steps) ? run.steps.filter(isDisplayableFallbackStep) : [];
  const step = firstByStatus(displayableSteps, ["blocked", "pending"]);
  if (step) return summarizeWorkItem(step.agent, step.status, step.attempts);
  return null;
}

function projectPostPrPhase(run) {
  const postPr = run?.post_pr;
  if (postPr === undefined || postPr === null) return undefined;
  if (!isRecord(postPr) || !POST_PR_PHASES.has(postPr.phase) || !isNonNegativeInteger(postPr.attempt)) return UNKNOWN_WORKFLOW;
  const operation = projectPrOperation(postPr.pr_operation);
  const prUrl = projectPrUrl(run?.pr_url);
  if (operation === UNKNOWN_WORKFLOW || prUrl === UNKNOWN_WORKFLOW) return UNKNOWN_WORKFLOW;
  const terminal = TERMINAL_POST_PR_LABELS[postPr.phase];
  if (terminal) {
    const expectedStatus = postPr.phase === "succeeded" ? "completed" : postPr.phase;
    if (run?.status !== expectedStatus || operation !== true && prUrl !== true) return UNKNOWN_WORKFLOW;
    return `${terminal}${positiveAttemptSuffix(postPr.attempt)}`;
  }
  const active = ACTIVE_POST_PR_LABELS[postPr.phase];
  if (active) {
    if (run?.status !== "running" || operation !== true && prUrl !== true) return UNKNOWN_WORKFLOW;
    return `${active}${positiveAttemptSuffix(postPr.attempt)}`;
  }
  return undefined;
}

function projectPrAuthority(run) {
  const prUrl = projectPrUrl(run?.pr_url);
  if (prUrl === UNKNOWN_WORKFLOW) return UNKNOWN_WORKFLOW;
  const operation = projectPrOperation(run?.post_pr?.pr_operation);
  if (operation === UNKNOWN_WORKFLOW) return UNKNOWN_WORKFLOW;
  if (prUrl !== true && operation !== true) return undefined;
  return run?.post_pr?.phase === "awaiting-pr" ? "PR created; post-PR awaiting start" : "PR created";
}

function projectPrUrl(value) {
  if (value === undefined || value === null) return false;
  return typeof value === "string" && value.length > 0 ? true : UNKNOWN_WORKFLOW;
}

function projectPrOperation(operation) {
  if (operation === undefined || operation === null) return false;
  if (!isRecord(operation) || !PR_OPERATION_KEYS.every((key) => Object.hasOwn(operation, key))) return UNKNOWN_WORKFLOW;
  const stringKeys = ["operation_id", "repository", "created_at", "head_ref", "head_sha", "base_ref", "base_sha", "pr_url", "pr_node_id"];
  if (!stringKeys.every((key) => typeof operation[key] === "string" && operation[key].length > 0)
    || !Number.isInteger(operation.pr_number) || operation.pr_number <= 0 || typeof operation.draft !== "boolean") return UNKNOWN_WORKFLOW;
  return true;
}

function projectPrFence(run) {
  const fence = run?.steering?.pr_fence;
  if (fence === undefined || fence === null) return undefined;
  if (!isRecord(fence) || !PR_FENCE_CONTROL_KEYS.every((key) => Object.hasOwn(fence, key))
    || typeof fence.token !== "string" || fence.token.length === 0 || !isNonNegativeInteger(fence.generation)
    || typeof fence.state_hash !== "string" || fence.state_hash.length === 0 || typeof fence.created_at !== "string" || fence.created_at.length === 0) return UNKNOWN_WORKFLOW;
  const identityCount = PR_FENCE_IDENTITY_KEYS.filter((key) => Object.hasOwn(fence, key)).length;
  if (identityCount !== 0 && identityCount !== PR_FENCE_IDENTITY_KEYS.length) return UNKNOWN_WORKFLOW;
  if (identityCount === 0) return "PR creation needs reconciliation";
  if (identityCount === PR_FENCE_IDENTITY_KEYS.length) {
    const stringKeys = PR_FENCE_IDENTITY_KEYS.filter((key) => key !== "draft");
    if (!stringKeys.every((key) => typeof fence[key] === "string" && fence[key].length > 0) || typeof fence.draft !== "boolean") return UNKNOWN_WORKFLOW;
  }
  return "PR creation running";
}

function projectPrePrGate(run) {
  const gate = run?.gates?.pre_pr;
  if (gate === undefined || gate === null) return undefined;
  if (!isRecord(gate) || !Object.hasOwn(PRE_PR_GATE_LABELS, gate.status)) return UNKNOWN_WORKFLOW;
  return PRE_PR_GATE_LABELS[gate.status];
}

function projectPanelAuthority(run) {
  const rawDispatch = run?.special_builder_dispatch;
  if (rawDispatch !== undefined && rawDispatch !== null && (!isRecord(rawDispatch) || !SPECIAL_DISPATCH_ROUTES.has(rawDispatch.route))) return UNKNOWN_WORKFLOW;
  if (rawDispatch?.route === "panel-remediation") {
    const dispatch = projectSpecialDispatch(run);
    if (dispatch === UNKNOWN_WORKFLOW) return UNKNOWN_WORKFLOW;
    return dispatch.closed ? "panel remediation awaiting panel publication" : "panel remediation running";
  }

  const validator = projectPanelVerdict(run?.validator, VALIDATOR_VERDICTS);
  const security = projectPanelVerdict(run?.security_review, SECURITY_VERDICTS);
  if (validator === UNKNOWN_WORKFLOW || security === UNKNOWN_WORKFLOW) return UNKNOWN_WORKFLOW;
  if (validator !== undefined && security !== undefined) {
    return validator !== "NO-GO" && security === "PASS" ? "panels passed" : "panel remediation pending";
  }
  if (validator !== undefined) return "security-reviewer pending";
  if (security !== undefined) return "implementation-validator pending";

  const step = Array.isArray(run?.steps) ? run.steps.find((candidate) => candidate?.status === "running" && PANEL_AGENTS.has(candidate?.agent)) : null;
  return step ? summarizeWorkItem(step.agent, step.status, step.attempts) : undefined;
}

function projectPanelVerdict(value, allowed) {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || !allowed.has(value.verdict)) return UNKNOWN_WORKFLOW;
  return value.verdict;
}

function projectCheckedTestExecution(run) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const claimSteps = steps.filter((step) => step && (step.execution_claim !== undefined && step.execution_claim !== null || step.execution_claim_hash !== undefined && step.execution_claim_hash !== null));
  if (claimSteps.length === 0) return undefined;
  if (claimSteps.length !== 1) return UNKNOWN_WORKFLOW;
  const step = claimSteps[0];
  const claim = step.execution_claim;
  if (step.agent !== "test-verifier" || !isRecord(claim) || !TEST_EXECUTION_CLAIM_KEYS.every((key) => Object.hasOwn(claim, key))
    || claim.schema_version !== 1 || claim.kind !== "checked-test-execution-claim"
    || typeof step.execution_claim_hash !== "string" || step.execution_claim_hash !== hashValue(claim)) return UNKNOWN_WORKFLOW;
  if (!Number.isInteger(claim.attempt) || claim.attempt <= 0 || step.attempts !== claim.attempt || claim.run_id !== run?.run_id) return UNKNOWN_WORKFLOW;
  if (claim.state === "active" || claim.state === "unknown") {
    if (claim.state === "unknown" && (!Object.hasOwn(claim, "failed_at") || !Object.hasOwn(claim, "reason"))) return UNKNOWN_WORKFLOW;
    if (step.status !== "running" || run?.status !== "running") return UNKNOWN_WORKFLOW;
    return claim.state === "active"
      ? `whole-story tests running a${claim.attempt}`
      : `whole-story tests needs reconciliation a${claim.attempt}`;
  }
  if (claim.state !== "completed") return UNKNOWN_WORKFLOW;
  if (!["completed_at", "status", "receipt_hash"].every((key) => Object.hasOwn(claim, key))) return UNKNOWN_WORKFLOW;
  if (claim.status === "pass" && ["running", "accepted"].includes(step.status)) return `whole-story tests passed a${claim.attempt}`;
  if (claim.status === "fail" && step.status === "rejected") return `whole-story tests failed a${claim.attempt}`;
  return UNKNOWN_WORKFLOW;
}

function projectBuildSpecialDispatch(run) {
  const dispatch = projectSpecialDispatch(run);
  if (dispatch === undefined) return undefined;
  if (dispatch === UNKNOWN_WORKFLOW || dispatch.route === "post-pr-remediation") return UNKNOWN_WORKFLOW;
  const labels = BUILD_SPECIAL_LABELS[dispatch.route];
  return labels ? labels[Number(dispatch.closed)] : undefined;
}

function projectSpecialDispatch(run) {
  const dispatch = run?.special_builder_dispatch;
  if (dispatch === undefined || dispatch === null) return undefined;
  if (!isRecord(dispatch) || !SPECIAL_DISPATCH_ROUTES.has(dispatch.route)) return UNKNOWN_WORKFLOW;
  const claimKeys = ["claim_ref", "claim_hash"];
  const closureKeys = ["closure_ref", "closure_hash", "completion_head"];
  const claimCount = claimKeys.filter((key) => Object.hasOwn(dispatch, key)).length;
  const closureCount = closureKeys.filter((key) => Object.hasOwn(dispatch, key)).length;
  if (claimCount !== claimKeys.length || ![0, closureKeys.length].includes(closureCount)
    || !claimKeys.every((key) => typeof dispatch[key] === "string" && dispatch[key].length > 0)
    || closureCount > 0 && !closureKeys.every((key) => typeof dispatch[key] === "string" && dispatch[key].length > 0)) return UNKNOWN_WORKFLOW;
  return { route: dispatch.route, closed: closureCount === closureKeys.length };
}

function projectActiveSlice(run) {
  const active = Array.isArray(run?.slices) ? run.slices.filter((slice) => ["running", "review"].includes(slice?.status)) : [];
  const ranked = active.map((slice) => ({ slice, dispatch: projectSliceDispatch(slice) }));
  if (ranked.some((entry) => entry.dispatch === UNKNOWN_WORKFLOW)) return UNKNOWN_WORKFLOW;
  const selected = ranked.find((entry) => entry.slice.status === "running" && entry.dispatch === true)
    || ranked.find((entry) => entry.slice.status === "running")
    || ranked.find((entry) => entry.slice.status === "review");
  return selected ? summarizeWorkItem(selected.slice.id, selected.slice.status, selected.slice.attempts) : undefined;
}

function projectSliceDispatch(slice) {
  const claimKeys = ["dispatch_claim_ref", "dispatch_claim_hash"];
  const closureKeys = ["dispatch_closure_ref", "dispatch_closure_hash"];
  const claimCount = claimKeys.filter((key) => Object.hasOwn(slice, key)).length;
  const closureCount = closureKeys.filter((key) => Object.hasOwn(slice, key)).length;
  if (![0, 2].includes(claimCount) || ![0, 2].includes(closureCount) || closureCount === 2 && claimCount !== 2) return UNKNOWN_WORKFLOW;
  if (claimCount === 2 && !claimKeys.every((key) => typeof slice[key] === "string" && slice[key].length > 0)) return UNKNOWN_WORKFLOW;
  if (closureCount === 2 && !closureKeys.every((key) => typeof slice[key] === "string" && slice[key].length > 0)) return UNKNOWN_WORKFLOW;
  if (claimCount === 2 && slice.dispatch_required !== true) return UNKNOWN_WORKFLOW;
  if (slice.dispatch_required === true && claimCount !== 2) return UNKNOWN_WORKFLOW;
  return claimCount === 2;
}

function projectRunningStep(run) {
  const step = Array.isArray(run?.steps) ? run.steps.find((candidate) => candidate?.status === "running") : null;
  return step ? summarizeWorkItem(step.agent, step.status, step.attempts) : undefined;
}

function projectBlockedSlice(run) {
  const slice = firstByStatus(run?.slices, ["blocked"]);
  if (!slice) return undefined;
  if (projectSliceDispatch(slice) === UNKNOWN_WORKFLOW) return UNKNOWN_WORKFLOW;
  return summarizeWorkItem(slice.id, slice.status, slice.attempts);
}

function positiveAttemptSuffix(attempt) {
  return attempt > 0 ? ` a${attempt}` : "";
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDisplayableFallbackStep(step) {
  if (step?.status !== "blocked") return true;
  if (Number.isInteger(step.attempts) && step.attempts > 0) return true;
  return Boolean(step.reason || step.review_ref || step.evidence_ref || step.artifact_ref);
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
