import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TERMINAL_RUN_STATUSES,
  claimsCheckpointRoutingParent,
  pendingProtectedGate,
  validateFactoryLock,
  validateHeartbeatState,
  validateProcessSidecar,
  validateRun,
  validateRunSlicesPlanAuthority,
} from "./validate.js";
import { PROCESS_EVIDENCE_FILE } from "./process-evidence.js";
import { hasInFlightHeartbeatWork } from "./run-state.js";
import { physicalPath, timestamp } from "./utils.js";
import { projectDiagnosticData } from "./hardening/output-policy.js";
import {
  probeProcessLiveness,
  publicLivenessBoolean,
} from "./hardening/process-verification.js";

export const DIAGNOSTIC_SCHEMA_VERSION = 1;
export const HEARTBEAT_FILE = "heartbeat.json";
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
export const MIN_STALE_HEARTBEAT_MS = 120000;

const CONDITIONS = Object.freeze([
  Object.freeze({ condition: "invalid-run-state", failClosed: true, classification: "invalid", severity: "critical", status: "error", message: "Factory run state is invalid or cannot be parsed.", action: "Treat the run as untrusted until run.json and required sidecars validate." }),
  Object.freeze({ condition: "newer-schema", failClosed: true, classification: "invalid", severity: "critical", status: "error", message: "Factory run state uses a newer schema than this reader.", action: "Read the run with a feature-factory build that recognizes its schema; this reader must treat it as untrusted." }),
  Object.freeze({ condition: "missing-worktree", classification: "blocked", severity: "error", status: "error", message: "A recorded worktree path is missing or inaccessible.", action: "Restore the worktree or complete cleanup/recovery from durable state." }),
  Object.freeze({ condition: "missing-heartbeat-process", classification: "recoverable", severity: "warning", status: "warning", message: "The heartbeat helper process recorded in heartbeat.json is not alive.", action: "Inspect the run log and validate durable state before resuming; do not infer run failure from PID liveness alone." }),
  Object.freeze({ condition: "stale-heartbeat", classification: "recoverable", severity: "warning", status: "warning", message: "Heartbeat has not advanced within the stale threshold.", action: "Inspect the run log and validate durable state before resuming; do not restart blindly." }),
  Object.freeze({ condition: "protected-gate", classification: "needs-human", severity: "warning", status: "warning", message: "Run is waiting at a protected human gate.", action: "Answer the pending protected gate or stop the run; heartbeat liveness alarms are suppressed while waiting." }),
  Object.freeze({ condition: "terminal-run", classification: "terminal", severity: "info", status: "ok", message: "Run is terminal.", action: "Read terminal_result for the durable outcome." }),
]);

export const DIAGNOSTIC_CONDITIONS = Object.freeze(CONDITIONS.map((item) => item.condition));
// Derived from the table rather than restated by each caller: a condition that
// denies this reader workflow authority must fail every consumer closed, and a
// hand-maintained literal in each consumer silently fails open the moment a new
// such condition is added.
export const FAIL_CLOSED_DIAGNOSTIC_CONDITIONS = Object.freeze(
  new Set(CONDITIONS.filter((item) => item.failClosed).map((item) => item.condition)),
);
export const DIAGNOSTIC_CLASSIFICATIONS = Object.freeze(["healthy", "recoverable", "blocked", "needs-human", "terminal", "invalid"]);
export const DIAGNOSTIC_STATUSES = Object.freeze(["ok", "warning", "error"]);
export const DIAGNOSTIC_SEVERITIES = Object.freeze(["info", "warning", "error", "critical"]);

const CONDITION_BY_NAME = new Map(CONDITIONS.map((item, index) => [item.condition, { ...item, index }]));
const TERMINAL_OVERRIDES = Object.freeze({
  completed: Object.freeze({ classification: "terminal", severity: "info", status: "ok" }),
  partial: Object.freeze({ classification: "terminal", severity: "info", status: "ok" }),
  blocked: Object.freeze({ classification: "blocked", severity: "error", status: "error" }),
  "needs-human": Object.freeze({ classification: "needs-human", severity: "warning", status: "warning" }),
});

const TERMINAL_STATUSES = new Set(TERMINAL_RUN_STATUSES);
const DIAGNOSTIC_IDENTITY_FIELDS = Object.freeze({
  status: new Set(DIAGNOSTIC_STATUSES),
  severity: new Set(DIAGNOSTIC_SEVERITIES),
  classification: new Set(DIAGNOSTIC_CLASSIFICATIONS),
  condition: new Set(DIAGNOSTIC_CONDITIONS),
});

// Exactly the message allowedKeys() emits for a key the schema does not know.
// Matched by equality, not substring: several real constraint violations embed
// the same phrase ("is not allowed for schema_version 1", "untrusted raw or
// sensitive data is not allowed"), and those are genuine invalid state, not a
// writer running ahead of this reader.
const UNKNOWN_KEY_MESSAGE = "is not allowed";
const MAX_REPORTED_UNKNOWN_KEYS = 12;

let readerVersionCache = null;

function readerVersion() {
  if (readerVersionCache) return readerVersionCache;
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), "package.json"), "utf8"));
    readerVersionCache = typeof pkg.version === "string" && pkg.version ? pkg.version : "unknown";
  } catch {
    readerVersionCache = "unknown";
  }
  return readerVersionCache;
}

// Returns the unknown-key paths when a validation failure consists of nothing
// but unrecognized keys, and null otherwise. That shape means every constraint
// this reader knows about passed and the record merely carries fields a newer
// writer added, which is worth telling the operator apart from a corrupt run.
// It grants no authority: the caller still emits a critical, fail-closed item.
function unknownKeyPaths(error) {
  const errors = error?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  if (!errors.every((item) => item?.message === UNKNOWN_KEY_MESSAGE && typeof item?.path === "string")) return null;
  return errors.map((item) => item.path);
}

function runValidationDiagnostic(error, { checkedAt, runDir, runFile }) {
  const unknownKeys = unknownKeyPaths(error);
  const evidence = { source: "run.json", run_dir: runDir, run_path: runFile, error: error.message };
  if (!unknownKeys) {
    return diagnosticItem("invalid-run-state", {
      checkedAt,
      authoritative: false,
      message: `Factory run state is invalid: ${error.message}`,
      evidence,
    });
  }
  const reported = unknownKeys.slice(0, MAX_REPORTED_UNKNOWN_KEYS);
  return diagnosticItem("newer-schema", {
    checkedAt,
    authoritative: false,
    message: `Factory run state uses a newer schema than this reader (feature-factory ${readerVersion()}): unrecognized ${reported.join(", ")}${unknownKeys.length > reported.length ? `, and ${unknownKeys.length - reported.length} more` : ""}.`,
    evidence: {
      ...evidence,
      reader_version: readerVersion(),
      unknown_keys: reported,
      unknown_key_count: unknownKeys.length,
    },
  });
}

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
      runValidationDiagnostic(error, { checkedAt, runDir, runFile }),
    ], { checkedAt, authoritative: false });
  }

  const invalidSidecar = runDir ? inspectSidecars(runDir, checkedAt, run) : null;
  if (invalidSidecar) {
    return diagnosticEnvelope([invalidSidecar], { checkedAt, authoritative: false });
  }

  const terminal = TERMINAL_STATUSES.has(run.status);
  const authoritative = Boolean(runDir);
  const protectedGate = pendingProtectedGate(run);

  if (terminal) {
    items.push(terminalRunItem(run, { checkedAt, runDir, runFile, authoritative }));
    return diagnosticEnvelope(items, { checkedAt, authoritative });
  }

  if (protectedGate) {
    items.push(diagnosticItem("protected-gate", {
      checkedAt,
      authoritative,
      message: `Run is waiting at protected gate '${protectedGate}'.`,
      evidence: { source: "run.json", run_dir: runDir, run_path: runFile, gate: protectedGate },
    }));
  } else if (hasInFlightHeartbeatWork(run)) {
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

  const missingWorktree = inspectWorktree(run, { ...options, checkedAt, runDir, authoritative });
  if (missingWorktree) items.push(missingWorktree);

  return diagnosticEnvelope(items, { checkedAt, authoritative });
}

export function diagnosticEnvelope(items = [], options = {}) {
  const checkedAt = options.checkedAt || timestamp(options.now);
  const normalized = items.map((item) => normalizeDiagnosticItem(item, checkedAt));
  const aggregate = aggregateDiagnostics(normalized);
  const envelope = {
    schema_version: DIAGNOSTIC_SCHEMA_VERSION,
    checked_at: checkedAt,
    authoritative: Boolean(options.authoritative) && aggregate.classification !== "invalid",
    status: aggregate.status,
    severity: aggregate.severity,
    classification: aggregate.classification,
    summary: aggregate.summary,
    items: normalized,
  };
  return plainDiagnosticProjection(projectDiagnosticData(envelope, {
    validatedIdentityPaths: validatedDiagnosticIdentityPaths(envelope),
  }));
}

export function aggregateDiagnostics(items = []) {
  if (!items.length) {
    return { classification: "healthy", status: "ok", severity: "info", summary: "No diagnostics", primary: null };
  }
  const primary = items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => conditionOrder(left.item.condition) - conditionOrder(right.item.condition) || left.index - right.index)[0].item;
  return {
    classification: primary.classification,
    status: primary.status,
    severity: primary.severity,
    summary: primary.message,
    primary,
  };
}

export function diagnosticItem(condition, options = {}) {
  const definition = condition === "terminal-run"
    ? terminalDefinition(options.terminalStatus)
    : CONDITION_BY_NAME.get(condition);
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

function terminalRunItem(run, options) {
  return diagnosticItem("terminal-run", {
    ...options,
    terminalStatus: run.status,
    message: terminalMessage(run.status),
    evidence: { source: "run.json", run_dir: options.runDir, run_path: options.runFile, run_status: run.status },
  });
}

function inspectSidecars(runDir, checkedAt, run) {
  const slicesPlanPath = join(runDir, "plan", "slices.json");
  if (claimsCheckpointRoutingParent(runDir, run) && !existsSync(slicesPlanPath)) {
    return diagnosticItem("invalid-run-state", {
      checkedAt,
      authoritative: false,
      message: "Factory sidecar state is invalid: checkpoint-routing plan must be a regular file",
      evidence: {
        source: "plan/slices.json",
        run_dir: runDir,
        path: slicesPlanPath,
        error: "checkpoint-routing plan must be a regular file",
      },
    });
  }
  const checks = [
    { path: join(runDir, HEARTBEAT_FILE), source: HEARTBEAT_FILE, validator: validateHeartbeatState },
    { path: join(runDir, "factory.lock"), source: "factory.lock", validator: validateFactoryLock },
    { path: join(runDir, PROCESS_EVIDENCE_FILE), source: PROCESS_EVIDENCE_FILE, validator: (value) => validateProcessSidecar(value, { runDir, runId: run.run_id }), failClosed: true },
    { path: slicesPlanPath, source: "plan/slices.json", validator: (value) => validateRunSlicesPlanAuthority(runDir, run, value) },
  ];
  for (const check of checks) {
    if (!existsSync(check.path)) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(check.path, "utf8"));
      const sidecar = check.validator(parsed);
      if ((check.source === HEARTBEAT_FILE || check.source === "factory.lock") && sidecar.run_id !== run.run_id) {
        return diagnosticItem("invalid-run-state", {
          checkedAt,
          authoritative: false,
          message: `Factory sidecar state contradicts run.json: ${check.source}.run_id does not match run.run_id.`,
          evidence: {
            source: check.source,
            run_dir: runDir,
            path: check.path,
            error: `${check.source}.run_id does not match run.run_id`,
            run_id: run.run_id,
            sidecar_run_id: sidecar.run_id,
          },
        });
      }
    } catch (error) {
      const failClosed = Boolean(check.failClosed);
      return diagnosticItem("invalid-run-state", {
        checkedAt,
        authoritative: false,
        message: failClosed
          ? `Factory process sidecar state is invalid; cancellation must fail closed: ${error.message}`
          : `Factory sidecar state is invalid: ${error.message}`,
        action: failClosed
          ? "Treat process evidence as untrusted; do not signal any process until the sidecar is repaired or manually verified."
          : undefined,
        evidence: {
          source: check.source,
          run_dir: runDir,
          path: check.path,
          error: error.message,
          ...(failClosed ? { fail_closed: true, sidecar_run_id: parsed?.run_id || null } : {}),
        },
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
    heartbeat_phase: heartbeat?.phase || null,
    pid: heartbeat?.pid || null,
    process_alive: null,
    last_tick_at: lastTickAt,
    interval_ms: intervalMs,
    stale_after: Number.isFinite(lastTickMs) ? new Date(lastTickMs + staleMs).toISOString() : null,
    age_ms: ageMs,
  };

  const result = {};
  if (heartbeat) {
    const liveness = processLiveness(heartbeat.pid, options);
    evidence.process_alive = publicLivenessBoolean(liveness);
    if (liveness === "absent") result.missingProcess = diagnosticItem("missing-heartbeat-process", {
      checkedAt,
      authoritative: false,
      evidence: { ...evidence },
    });
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

function processLiveness(pid, options = {}) {
  return probeProcessLiveness(pid, options).status;
}

function validatedDiagnosticIdentityPaths(envelope) {
  const paths = [];
  for (const field of ["status", "severity", "classification"]) {
    if (DIAGNOSTIC_IDENTITY_FIELDS[field].has(envelope[field])) paths.push([field]);
  }
  for (let index = 0; index < envelope.items.length; index += 1) {
    const item = envelope.items[index];
    for (const field of ["condition", "status", "severity", "classification"]) {
      if (DIAGNOSTIC_IDENTITY_FIELDS[field].has(item[field])) paths.push(["items", String(index), field]);
    }
  }
  return paths;
}

function plainDiagnosticProjection(value) {
  if (Array.isArray(value)) return value.map(plainDiagnosticProjection);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainDiagnosticProjection(item)]));
  }
  return value;
}

function realpath(options, path) {
  if (typeof options.realpathFn === "function") return options.realpathFn(path);
  return physicalPath(path, "worktree", { mustExist: true });
}

function terminalDefinition(status) {
  return { ...CONDITION_BY_NAME.get("terminal-run"), ...(TERMINAL_OVERRIDES[status] || TERMINAL_OVERRIDES.completed) };
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

function conditionOrder(condition) {
  return CONDITION_BY_NAME.get(condition)?.index ?? Number.MAX_SAFE_INTEGER;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}
