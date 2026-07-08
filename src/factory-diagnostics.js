import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  HEARTBEAT_ACTIVE_STATUSES,
  TERMINAL_RUN_STATUSES,
  pendingProtectedGate,
  validateFactoryLock,
  validateHeartbeatState,
  validateRun,
  validateRunAuthority,
  validateSlicesPlan,
} from "./validate.js";
import { scrubSecretProvenance } from "./provenance.js";

export const DIAGNOSTIC_SCHEMA_VERSION = 1;
export const HEARTBEAT_FILE = "heartbeat.json";
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
export const MIN_STALE_HEARTBEAT_MS = 120000;

export const DIAGNOSTIC_CONDITIONS = Object.freeze([
  "stale-heartbeat",
  "missing-heartbeat-process",
  "missing-worktree",
  "invalid-run-state",
  "invalid-authority",
  "unverifiable-authority",
  "protected-gate",
  "terminal-run",
]);

export const DIAGNOSTIC_CLASSIFICATIONS = Object.freeze(["healthy", "recoverable", "blocked", "needs-human", "terminal", "invalid"]);
export const DIAGNOSTIC_STATUSES = Object.freeze(["ok", "warning", "error"]);
export const DIAGNOSTIC_SEVERITIES = Object.freeze(["info", "warning", "error", "critical"]);

export const CLASSIFICATION_PRIORITY = Object.freeze({
  invalid: 5,
  blocked: 4,
  "needs-human": 3,
  recoverable: 2,
  terminal: 1,
  healthy: 0,
});

export const SEVERITY_PRIORITY = Object.freeze({
  critical: 3,
  error: 2,
  warning: 1,
  info: 0,
});

export const STATUS_PRIORITY = Object.freeze({
  error: 2,
  warning: 1,
  ok: 0,
});

export const CONDITION_PRIORITY = Object.freeze({
  "invalid-run-state": 7,
  "invalid-authority": 6,
  "unverifiable-authority": 5,
  "missing-worktree": 4,
  "missing-heartbeat-process": 3,
  "stale-heartbeat": 2,
  "protected-gate": 1,
  "terminal-run": 0,
});

const CONDITION_DEFINITIONS = Object.freeze({
  "stale-heartbeat": Object.freeze({
    classification: "recoverable",
    severity: "warning",
    status: "warning",
    message: "Heartbeat has not advanced within the stale threshold.",
    action: "Inspect the run log and validate durable state before resuming; do not restart blindly.",
  }),
  "missing-heartbeat-process": Object.freeze({
    classification: "recoverable",
    severity: "warning",
    status: "warning",
    message: "The heartbeat helper process recorded in heartbeat.json is not alive.",
    action: "Inspect the run log and validate durable state before resuming; do not infer run failure from PID liveness alone.",
  }),
  "missing-worktree": Object.freeze({
    classification: "blocked",
    severity: "error",
    status: "error",
    message: "A provenance-validated worktree path is missing or inaccessible.",
    action: "Restore the trusted worktree or complete cleanup/recovery from validated durable state.",
  }),
  "invalid-run-state": Object.freeze({
    classification: "invalid",
    severity: "critical",
    status: "error",
    message: "Factory run state is invalid or cannot be parsed.",
    action: "Treat the run as untrusted until run.json and required sidecars validate.",
  }),
  "invalid-authority": Object.freeze({
    classification: "invalid",
    severity: "critical",
    status: "error",
    message: "Factory run state contradicts accepted provenance authority.",
    action: "Do not trust mutable run claims; inspect accepted attestations and durable artifacts.",
  }),
  "unverifiable-authority": Object.freeze({
    classification: "blocked",
    severity: "critical",
    status: "error",
    message: "Factory run authority cannot be verified from local proofs.",
    action: "Restore or inspect missing provenance proofs before trusting status, branch, PR, gate, or worktree claims.",
  }),
  "protected-gate": Object.freeze({
    classification: "needs-human",
    severity: "warning",
    status: "warning",
    message: "Run is waiting at a protected human gate.",
    action: "Answer the pending protected gate or stop the run; heartbeat liveness alarms are suppressed while waiting.",
  }),
});

const TERMINAL_DEFINITIONS = Object.freeze({
  completed: Object.freeze({ classification: "terminal", severity: "info", status: "ok" }),
  partial: Object.freeze({ classification: "terminal", severity: "info", status: "ok" }),
  blocked: Object.freeze({ classification: "blocked", severity: "error", status: "error" }),
  "needs-human": Object.freeze({ classification: "needs-human", severity: "warning", status: "warning" }),
});

const TERMINAL_STATUSES = new Set(TERMINAL_RUN_STATUSES);
const HEARTBEAT_ACTIVE_STATUS_SET = new Set(HEARTBEAT_ACTIVE_STATUSES);

export function diagnoseRunDir(runDir, options = {}) {
  return diagnoseRunFile(join(runDir, "run.json"), { ...options, runDir });
}

export function diagnoseRunFile(runFile, options = {}) {
  const runDir = options.runDir || dirname(runFile);
  const checkedAt = timestamp(options.now);
  let raw;

  try {
    raw = readFileSync(runFile, "utf8");
  } catch (error) {
    return diagnosticEnvelope([
      diagnosticItem("invalid-run-state", {
        checkedAt,
        authoritative: false,
        message: `Factory run state is unavailable: ${error.message}`,
        evidence: { source: "run.json", run_dir: runDir, run_path: runFile, error: error.message },
      }),
    ], { checkedAt, authoritative: false });
  }

  try {
    return diagnoseRunObject(JSON.parse(raw), { ...options, runDir, runFile, checkedAt });
  } catch (error) {
    return diagnosticEnvelope([
      diagnosticItem("invalid-run-state", {
        checkedAt,
        authoritative: false,
        message: `Factory run state is invalid: ${error.message}`,
        evidence: { source: "run.json", run_dir: runDir, run_path: runFile, error: error.message },
      }),
    ], { checkedAt, authoritative: false });
  }
}

export function diagnoseRunObject(input, options = {}) {
  const checkedAt = options.checkedAt || timestamp(options.now);
  const runDir = options.runDir || null;
  const runFile = options.runFile || (runDir ? join(runDir, "run.json") : null);
  const items = [];
  let run;

  try {
    run = validateRun(input);
  } catch (error) {
    return diagnosticEnvelope([
      diagnosticItem("invalid-run-state", {
        checkedAt,
        authoritative: false,
        message: `Factory run state is invalid: ${error.message}`,
        evidence: { source: "run.json", run_dir: runDir, run_path: runFile, error: error.message },
      }),
    ], { checkedAt, authoritative: false });
  }

  const invalidSidecar = runDir ? inspectSidecars(runDir, checkedAt, run) : null;
  if (invalidSidecar) {
    return diagnosticEnvelope([invalidSidecar], { checkedAt, authoritative: false });
  }

  const authority = runDir ? validateAuthority(runDir, run, options) : { ok: true, authoritative: false };
  if (!authority.ok) {
    items.push(authorityItem(authority, { checkedAt, runDir, runFile }));
    return diagnosticEnvelope(items, { checkedAt, authoritative: false });
  }

  const terminal = TERMINAL_STATUSES.has(run.status);
  const authoritative = Boolean(runDir && authority.authoritative !== false);
  const acceptedAuthority = hasAcceptedRunAuthority(authority, options);
  const trustedAuthoritative = authoritative && acceptedAuthority;
  const protectedGate = pendingProtectedGate(run);

  if (terminal) {
    if (runDir && !acceptedAuthority) items.push(unverifiableRunAuthorityItem({ checkedAt, runDir, runFile, terminal: true }));
    items.push(terminalRunItem(run, { checkedAt, runDir, runFile, authoritative: trustedAuthoritative }));
    return diagnosticEnvelope(items, { checkedAt, authoritative: trustedAuthoritative && !hasUntrustedAuthorityItem(items) });
  }

  if (protectedGate) {
    items.push(diagnosticItem("protected-gate", {
      checkedAt,
      authoritative: trustedAuthoritative,
      message: `Run is waiting at protected gate '${protectedGate}'.`,
      evidence: { source: "run.json", run_dir: runDir, run_path: runFile, gate: protectedGate },
    }));
  } else {
    const heartbeat = inspectHeartbeat(run, { ...options, checkedAt, runDir });
    if (heartbeat.invalid) {
      items.push(diagnosticItem("invalid-run-state", {
        checkedAt,
        authoritative: false,
        message: `Heartbeat state is invalid: ${heartbeat.error}`,
        evidence: { source: "heartbeat.json", run_dir: runDir, heartbeat_path: heartbeat.path, error: heartbeat.error },
      }));
    } else {
      if (heartbeat.missingProcess) items.push(heartbeat.missingProcess);
      if (heartbeat.stale) items.push(heartbeat.stale);
    }
  }

  const missingWorktree = inspectWorktree(run, { ...options, checkedAt, runDir, authoritative: trustedAuthoritative });
  if (missingWorktree) items.push(missingWorktree);

  if (runDir && !acceptedAuthority) {
    items.push(unverifiableRunAuthorityItem({ checkedAt, runDir, runFile }));
  }

  return diagnosticEnvelope(items, { checkedAt, authoritative: trustedAuthoritative && !hasUntrustedAuthorityItem(items) });
}

export function diagnosticEnvelope(items = [], options = {}) {
  const checkedAt = options.checkedAt || timestamp(options.now);
  const normalized = items.map((item) => normalizeDiagnosticItem(item, checkedAt));
  const aggregate = aggregateDiagnostics(normalized);
  return {
    schema_version: DIAGNOSTIC_SCHEMA_VERSION,
    checked_at: checkedAt,
    authoritative: Boolean(options.authoritative) && aggregate.classification !== "invalid",
    status: aggregate.status,
    severity: aggregate.severity,
    classification: aggregate.classification,
    summary: aggregate.summary,
    items: normalized,
  };
}

export function aggregateDiagnostics(items = []) {
  if (!items.length) {
    return { classification: "healthy", status: "ok", severity: "info", summary: "No diagnostics", primary: null };
  }
  const primary = items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => compareDiagnosticItems(left.item, right.item) || left.index - right.index)[0].item;
  return {
    classification: primary.classification,
    status: primary.status,
    severity: primary.severity,
    summary: primary.message,
    primary,
  };
}

export function compareDiagnosticItems(left, right) {
  return (
    priority(right.classification, CLASSIFICATION_PRIORITY) - priority(left.classification, CLASSIFICATION_PRIORITY)
    || priority(right.severity, SEVERITY_PRIORITY) - priority(left.severity, SEVERITY_PRIORITY)
    || priority(right.status, STATUS_PRIORITY) - priority(left.status, STATUS_PRIORITY)
    || priority(right.condition, CONDITION_PRIORITY) - priority(left.condition, CONDITION_PRIORITY)
  );
}

export function diagnosticItem(condition, options = {}) {
  const definition = condition === "terminal-run"
    ? terminalDefinition(options.terminalStatus)
    : CONDITION_DEFINITIONS[condition];
  if (!definition) throw new Error(`unknown diagnostic condition: ${condition}`);
  const checkedAt = options.checkedAt || timestamp(options.now);
  return normalizeDiagnosticItem({
    condition,
    classification: definition.classification,
    severity: definition.severity,
    status: definition.status,
    message: options.message || definition.message,
    action: options.action || definition.action || terminalAction(options.terminalStatus),
    authoritative: Boolean(options.authoritative),
    checked_at: checkedAt,
    evidence: options.evidence || {},
  }, checkedAt);
}

function normalizeDiagnosticItem(item, checkedAt) {
  return {
    condition: item.condition,
    classification: item.classification,
    severity: item.severity,
    status: item.status,
    message: item.message,
    action: item.action,
    authoritative: Boolean(item.authoritative),
    checked_at: item.checked_at || checkedAt,
    evidence: item.evidence && typeof item.evidence === "object" && !Array.isArray(item.evidence) ? item.evidence : {},
  };
}

function validateAuthority(runDir, run, options) {
  const authority = typeof options.validateRunAuthorityFn === "function"
    ? options.validateRunAuthorityFn(runDir, run, options)
    : validateRunAuthority(runDir, run, options);
  if (authority.ok) return { ...authority, authoritative: true };
  const errors = validationErrors(authority.checks);
  return {
    ...authority,
    errors: sanitizeAuthorityErrors(errors),
    condition: classifyAuthorityFailure(errors),
  };
}

function hasAcceptedRunAuthority(authority, options = {}) {
  if (typeof options.validateRunAuthorityFn === "function") return authority?.authoritative !== false;
  if (authority?.authoritative === false) return false;
  return Array.isArray(authority?.orderedRefs) && authority.orderedRefs.length > 0;
}

function unverifiableRunAuthorityItem({ checkedAt, runDir, runFile, terminal = false }) {
  return diagnosticItem("unverifiable-authority", {
    checkedAt,
    authoritative: false,
    message: `${terminal ? "Terminal" : "Active"} factory run authority cannot be verified from accepted run-base or attestation proofs.`,
    evidence: {
      source: "provenance-authority",
      run_dir: runDir,
      run_path: runFile,
      errors: [{ path: "attestations/index.json", message: `${terminal ? "terminal" : "active"} run requires an accepted run-base attestation or authority proof` }],
    },
  });
}

function hasUntrustedAuthorityItem(items) {
  return items.some((item) => item.condition === "invalid-run-state" || item.condition === "unverifiable-authority");
}

function authorityItem(authority, { checkedAt, runDir, runFile }) {
  const message = formatValidationErrors(authority.errors) || CONDITION_DEFINITIONS[authority.condition].message;
  return diagnosticItem(authority.condition, {
    checkedAt,
    authoritative: false,
    message,
    evidence: {
      source: "provenance-authority",
      run_dir: runDir,
      run_path: runFile,
      errors: authority.errors,
    },
  });
}

function terminalRunItem(run, options) {
  return diagnosticItem("terminal-run", {
    ...options,
    terminalStatus: run.status,
    message: terminalMessage(run.status),
    evidence: { source: "run.json", run_dir: options.runDir, run_path: options.runFile, run_status: run.status },
  });
}

function inspectSidecars(runDir, checkedAt, run) {
  const checks = [
    { path: join(runDir, HEARTBEAT_FILE), source: HEARTBEAT_FILE, validator: validateHeartbeatState },
    { path: join(runDir, "factory.lock"), source: "factory.lock", validator: validateFactoryLock },
    { path: join(runDir, "plan", "slices.json"), source: "plan/slices.json", validator: validateSlicesPlan },
  ];
  for (const check of checks) {
    if (!existsSync(check.path)) continue;
    try {
      const sidecar = check.validator(JSON.parse(readFileSync(check.path, "utf8")));
      if (check.source === HEARTBEAT_FILE && sidecar.run_id !== run.run_id) {
        return diagnosticItem("invalid-run-state", {
          checkedAt,
          authoritative: false,
          message: "Factory sidecar state contradicts run.json: heartbeat.run_id does not match run.run_id.",
          evidence: {
            source: check.source,
            run_dir: runDir,
            path: check.path,
            error: "heartbeat.run_id does not match run.run_id",
            run_id: run.run_id,
            heartbeat_run_id: sidecar.run_id,
          },
        });
      }
    } catch (error) {
      return diagnosticItem("invalid-run-state", {
        checkedAt,
        authoritative: false,
        message: `Factory sidecar state is invalid: ${error.message}`,
        evidence: { source: check.source, run_dir: runDir, path: check.path, error: error.message },
      });
    }
  }
  return null;
}

function inspectHeartbeat(run, options) {
  const checkedAt = options.checkedAt;
  const runDir = options.runDir;
  const heartbeatPath = runDir ? join(runDir, HEARTBEAT_FILE) : null;
  const nowMs = Date.parse(checkedAt);
  let heartbeat = null;
  let source = "run.json";

  if (heartbeatPath && existsSync(heartbeatPath)) {
    try {
      heartbeat = validateHeartbeatState(JSON.parse(readFileSync(heartbeatPath, "utf8")));
      if (heartbeat.run_id !== run.run_id) {
        return { invalid: true, error: "heartbeat.run_id does not match run.run_id", path: heartbeatPath };
      }
      source = "heartbeat.json";
    } catch (error) {
      return { invalid: true, error: error.message, path: heartbeatPath };
    }
  }

  const lastTickAt = heartbeat?.last_tick_at || run.heartbeat_at || null;
  const intervalMs = positiveInteger(heartbeat?.interval_ms) || DEFAULT_HEARTBEAT_INTERVAL_MS;
  const staleMs = Math.max(2 * intervalMs, MIN_STALE_HEARTBEAT_MS);
  const lastTickMs = Date.parse(lastTickAt || "");
  const ageMs = Number.isFinite(nowMs) && Number.isFinite(lastTickMs) ? Math.max(0, nowMs - lastTickMs) : null;
  const evidence = {
    source,
    liveness_only: true,
    run_dir: runDir,
    heartbeat_path: heartbeatPath,
    heartbeat_status: heartbeat?.status || null,
    heartbeat_phase: heartbeat?.phase || null,
    pid: heartbeat?.pid || null,
    process_alive: null,
    last_tick_at: lastTickAt,
    interval_ms: intervalMs,
    stale_after: Number.isFinite(lastTickMs) ? new Date(lastTickMs + staleMs).toISOString() : null,
    age_ms: ageMs,
  };

  const result = {};
  if (heartbeat && HEARTBEAT_ACTIVE_STATUS_SET.has(heartbeat.status)) {
    evidence.process_alive = processAlive(heartbeat.pid, options);
    if (!evidence.process_alive) {
      result.missingProcess = diagnosticItem("missing-heartbeat-process", {
        checkedAt,
        authoritative: false,
        evidence: { ...evidence },
      });
    }
  }

  if (ageMs !== null && ageMs > staleMs) {
    result.stale = diagnosticItem("stale-heartbeat", {
      checkedAt,
      authoritative: false,
      evidence,
    });
  }
  return result;
}

function inspectWorktree(run, options) {
  if (!stringValue(run.worktree)) return null;
  const repoRoot = options.repoRoot || options.cwd || process.cwd();
  const worktree = isAbsolute(run.worktree) ? run.worktree : resolve(repoRoot, run.worktree);
  try {
    const physical = realpath(options, worktree);
    if (!statSync(physical).isDirectory()) throw new Error(`worktree is not a directory: ${worktree}`);
    return null;
  } catch (error) {
    return diagnosticItem("missing-worktree", {
      checkedAt: options.checkedAt,
      authoritative: options.authoritative,
      evidence: {
        source: "filesystem",
        run_dir: options.runDir,
        worktree,
        error: error.message,
      },
    });
  }
}

function processAlive(pid, options = {}) {
  if (typeof options.processAliveFn === "function") return Boolean(options.processAliveFn(pid));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return error?.code === "EPERM";
  }
}

function realpath(options, path) {
  if (typeof options.realpathFn === "function") return options.realpathFn(path);
  return realpathSync.native(path);
}

function terminalDefinition(status) {
  return TERMINAL_DEFINITIONS[status] || TERMINAL_DEFINITIONS.completed;
}

function terminalMessage(status) {
  if (status === "completed") return "Run completed.";
  if (status === "partial") return "Run ended with a partial result.";
  if (status === "blocked") return "Run ended blocked.";
  if (status === "needs-human") return "Run is terminal and needs human attention.";
  return "Run is terminal.";
}

function terminalAction(status) {
  if (status === "completed" || status === "partial") return "No liveness action is required.";
  if (status === "blocked") return "Inspect the terminal result and resolve the blocker before attempting follow-up work.";
  return "Inspect the terminal result and provide the required human input.";
}

function classifyAuthorityFailure(errors) {
  return errors.length > 0 && errors.every(isUnverifiableAuthorityError) ? "unverifiable-authority" : "invalid-authority";
}

function isUnverifiableAuthorityError(error) {
  const text = `${error.path || ""} ${error.message || ""}`;
  if (/does not match|mismatch|stale|contradict|forged|current integrated feature head|must equal|differs from|outside trusted|unexpected/i.test(text)) {
    return false;
  }
  return /missing|not found|no such file|ENOENT|EACCES|EPERM|inaccessible|requires? an accepted|accepted attestation not found|attestations\/index\.json|proof/i.test(text);
}

function validationErrors(checks = []) {
  return checks.flatMap((check) => (Array.isArray(check?.errors) ? check.errors : [])).map((error) => ({
    path: error.path || "authority",
    message: error.message || String(error),
  }));
}

function sanitizeAuthorityErrors(errors = []) {
  return errors.map((error) => ({
    path: stringValue(error.path) ? String(scrubSecretProvenance(error.path)) : "authority",
    message: stringValue(error.message) ? String(scrubSecretProvenance(error.message)) : String(scrubSecretProvenance(String(error))),
  }));
}

function formatValidationErrors(errors = []) {
  return errors.map((error) => `${error.path}: ${error.message}`).join("; ");
}

function priority(value, table) {
  return Number.isInteger(table[value]) ? table[value] : -1;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function timestamp(value) {
  if (value === undefined || value === null) return new Date().toISOString();
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid diagnostic timestamp");
  return new Date(parsed).toISOString();
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}
