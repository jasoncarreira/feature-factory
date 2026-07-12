import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { timestamp } from "./utils.js";
import { writeProtectedJsonAtomicSync } from "./hardening/atomic-write.js";
import {
  PROCESS_INSPECTOR,
  inspectProcessIdentity as inspectVerifiedProcessIdentity,
  probeLegacyBooleanLiveness,
  signalVerifiedProcess,
  verifyProcessIdentity,
} from "./hardening/process-verification.js";

export const PROCESS_EVIDENCE_FILE = "process.json";
export const PROCESS_EVIDENCE_KIND = "opencode-process";
export const PROCESS_EVIDENCE_SCHEMA_VERSION = 1;
export const PROCESS_EVIDENCE_SIGNAL = "SIGTERM";

const PROCESS_STATES = new Set(["running", "cancelled", "failed-closed", "exited"]);
const DEFAULT_INSPECTOR = PROCESS_INSPECTOR;
const DEFAULT_CANCEL_WAIT_MS = 5000;
const CANCEL_POLL_INTERVAL_MS = 200;

export function processEvidencePath(runDir) {
  return join(resolve(runDir), PROCESS_EVIDENCE_FILE);
}

export function processEvidenceProcessesDir(runDir) {
  return join(resolve(runDir), "processes");
}

export function readProcessEvidence(runDir, opts = {}) {
  const file = processEvidencePath(runDir);
  if (!existsSync(file)) return { ok: false, missing: true, reason: "missing process evidence", path: file, evidence: null };
  try {
    const evidence = JSON.parse(readFileSync(file, "utf8"));
    const validation = validateProcessEvidence(evidence, { ...opts, runDir });
    if (!validation.ok) return { ok: false, missing: false, reason: validation.reason, path: file, evidence };
    return { ok: true, missing: false, reason: null, path: file, evidence: validation.evidence };
  } catch (error) {
    return { ok: false, missing: false, reason: `invalid process evidence: ${error.message}`, path: file, evidence: null };
  }
}

export function writeProcessEvidence(runDir, evidence) {
  const file = processEvidencePath(runDir);
  mkdirSync(resolve(runDir), { recursive: true });
  const validation = validateProcessEvidence(evidence, { runDir });
  if (!validation.ok) throw new Error(validation.reason);
  writeProtectedJsonAtomicSync(resolve(runDir), PROCESS_EVIDENCE_FILE, validation.evidence, {
    commit: "replace-regular",
    mode: 0o666,
  });
  return file;
}

export function validateProcessEvidence(evidence, opts = {}) {
  const errors = [];
  if (!plainObject(evidence)) return invalid("process evidence must be a JSON object");
  if (evidence.schema_version !== PROCESS_EVIDENCE_SCHEMA_VERSION) errors.push("schema_version must be 1");
  if (evidence.kind !== PROCESS_EVIDENCE_KIND) errors.push("kind must be opencode-process");
  if (!nonEmptyString(evidence.run_id)) errors.push("run_id must be a non-empty string");
  if (nonEmptyString(opts.runId) && evidence.run_id !== opts.runId) errors.push("run_id must match requested run");
  if (!nonEmptyString(evidence.execution_id)) errors.push("execution_id must be a non-empty string");
  if (!positivePid(evidence.pid)) errors.push("pid must be a positive integer");
  if (!validTimestamp(evidence.started_at)) errors.push("started_at must be an ISO timestamp");
  if (!validTimestamp(evidence.updated_at)) errors.push("updated_at must be an ISO timestamp");
  if (!PROCESS_STATES.has(evidence.state)) errors.push("state must be one of running, cancelled, failed-closed, exited");
  if (!nonEmptyString(evidence.cwd) || !isAbsolute(evidence.cwd)) errors.push("cwd must be an absolute path");
  if (!plainObject(evidence.identity)) {
    errors.push("identity must be an object");
  } else {
    if (!nonEmptyString(evidence.identity.inspector)) errors.push("identity.inspector must be a non-empty string");
    if (!nonEmptyString(evidence.identity.start_marker)) errors.push("identity.start_marker must be a non-empty string");
    else if (String(evidence.identity.start_marker).startsWith("unverified:")) errors.push("identity.start_marker must be verifiable process evidence");
    if (!nonEmptyString(evidence.identity.command_name)) errors.push("identity.command_name must be a non-empty string");
  }
  if (!validProcessLogRef(evidence.log_ref)) errors.push("log_ref must stay under processes/");
  if (!(evidence.cancel === null || plainObject(evidence.cancel))) errors.push("cancel must be null or an object");
  if (errors.length) return invalid(`invalid process evidence: ${errors.join("; ")}`);
  return { ok: true, reason: null, evidence };
}

export function assertDetachedProcessEvidenceWritable(runDir, input = {}) {
  const current = readProcessEvidence(runDir, { ...input, runId: input.runId });
  if (current.missing) return;
  if (!current.ok) throw new Error(`refusing to overwrite invalid process evidence: ${current.reason}`);
  if (current.evidence.state !== "running") return;

  const verification = verifyEvidenceProcess(current.evidence, input);
  if (verification.status === "absent") return;
  if (verification.status === "live-and-matching") {
    throw new Error(`refusing to overwrite live running process evidence for run '${current.evidence.run_id}' pid ${current.evidence.pid}`);
  }
  throw new Error(`refusing to overwrite running process evidence because stale/exited state could not be proven: ${verification.reason}`);
}

export function recordDetachedProcessEvidence(runDir, input = {}) {
  assertDetachedProcessEvidenceWritable(runDir, input);
  const startedAt = timestamp(input.now);
  const inspected = inspectProcessForEvidence(input.pid, input);
  const cwd = resolve(input.cwd || process.cwd());
  const verified = requireVerifiedProcessIdentity(inspected, cwd);
  const identity = {
    inspector: stringOrDefault(inspected.inspector, DEFAULT_INSPECTOR),
    start_marker: verified.startMarker,
    command_name: verified.commandName,
  };
  const evidence = {
    schema_version: PROCESS_EVIDENCE_SCHEMA_VERSION,
    kind: PROCESS_EVIDENCE_KIND,
    run_id: input.runId,
    execution_id: input.executionId || randomUUID(),
    pid: input.pid,
    started_at: startedAt,
    updated_at: startedAt,
    state: "running",
    cwd,
    identity,
    log_ref: input.logRef,
    cancel: null,
  };
  writeProcessEvidence(runDir, evidence);
  return evidence;
}

export async function cancelProcessFromEvidence(runDir, opts = {}) {
  const read = readProcessEvidence(runDir, opts);
  if (!read.ok) return failClosed(opts.runId, read.reason, read.missing ? null : PROCESS_EVIDENCE_FILE);

  const evidence = read.evidence;
  if (evidence.state === "cancelled") {
    return {
      ok: true,
      run_id: evidence.run_id,
      status: "cancelled",
      pid: evidence.pid,
      signal: PROCESS_EVIDENCE_SIGNAL,
      process_ref: PROCESS_EVIDENCE_FILE,
      updated: false,
      signaled: false,
    };
  }
  if (evidence.state !== "running") return failClosed(evidence.run_id, `process evidence state is ${evidence.state}`, PROCESS_EVIDENCE_FILE);

  const signalResult = await signalEvidenceProcess(evidence, opts);
  const verification = signalResult.verification;
  if (verification?.status === "absent") {
    // Already gone (including a prior cancel that was signaled but not yet
    // confirmed): confirm the cancellation without signaling anything.
    return confirmCancelled(runDir, evidence, {
      requestedAt: evidence.cancel?.requested_at ?? timestamp(opts.now),
      confirmedAt: timestamp(opts.now),
      signaled: false,
    });
  }
  if (signalResult.status === "not-signaled") {
    return failClosed(evidence.run_id, verification?.reason || signalResult.reason, PROCESS_EVIDENCE_FILE, evidence.pid);
  }
  if (signalResult.status === "signal-failed") {
    return failClosed(evidence.run_id, `signal failed: ${signalResult.reason}`, PROCESS_EVIDENCE_FILE, evidence.pid);
  }

  const requestedAt = timestamp(opts.now);

  // SIGTERM is a request, not an exit. Recording state 'cancelled' unblocks a
  // relaunch, so only do it once the process is proven gone; a hung process
  // that ignores SIGTERM must not fail open into concurrent duplicate runs.
  const waitMs = normalizeCancelWait(opts.cancelWaitMs);
  const pollClock = resolvePollClock(opts);
  const pollSleep = resolvePollSleep(opts);
  const started = readPollClock(pollClock);
  const deadline = started === null ? null : started + waitMs;
  const maximumPolls = Math.ceil(waitMs / CANCEL_POLL_INTERVAL_MS) + 1;
  for (let count = 0; count < maximumPolls; count += 1) {
    const observed = verifyEvidenceProcess(evidence, opts);
    if (observed.status === "absent") {
      return confirmCancelled(runDir, evidence, { requestedAt, confirmedAt: timestamp(), signaled: true });
    }
    const current = readPollClock(pollClock);
    if (deadline === null || current === null) break;
    const remaining = deadline - current;
    if (remaining <= 0) break;
    try {
      await pollSleep(Math.min(CANCEL_POLL_INTERVAL_MS, remaining));
    } catch {
      break;
    }
  }

  const pendingAt = timestamp();
  writeProcessEvidence(runDir, {
    ...evidence,
    updated_at: pendingAt,
    cancel: {
      requested_at: requestedAt,
      signal: PROCESS_EVIDENCE_SIGNAL,
      confirmed_at: null,
      result: "pending",
      reason: `process still alive ${waitMs}ms after ${PROCESS_EVIDENCE_SIGNAL}`,
    },
  });
  return {
    ok: false,
    run_id: evidence.run_id,
    status: "cancel-pending",
    reason: `pid ${evidence.pid} is still alive ${waitMs}ms after ${PROCESS_EVIDENCE_SIGNAL}; re-run factory cancel to confirm exit, or stop the process manually`,
    pid: evidence.pid,
    signal: PROCESS_EVIDENCE_SIGNAL,
    process_ref: PROCESS_EVIDENCE_FILE,
    updated: true,
    signaled: true,
  };
}

function confirmCancelled(runDir, evidence, { requestedAt, confirmedAt, signaled }) {
  writeProcessEvidence(runDir, {
    ...evidence,
    updated_at: confirmedAt,
    state: "cancelled",
    cancel: {
      requested_at: requestedAt,
      signal: PROCESS_EVIDENCE_SIGNAL,
      confirmed_at: confirmedAt,
      result: "cancelled",
      reason: null,
    },
  });
  return {
    ok: true,
    run_id: evidence.run_id,
    status: "cancelled",
    pid: evidence.pid,
    signal: PROCESS_EVIDENCE_SIGNAL,
    process_ref: PROCESS_EVIDENCE_FILE,
    updated: true,
    signaled,
  };
}

function normalizeCancelWait(value) {
  if (value === undefined || value === null) return DEFAULT_CANCEL_WAIT_MS;
  const wait = Number(value);
  if (!Number.isInteger(wait) || wait < 0) throw new Error("cancelWaitMs must be a non-negative integer");
  return wait;
}

function resolvePollClock(opts) {
  if (typeof opts.clock === "function") return opts.clock;
  if (typeof opts.clockFn === "function") return opts.clockFn;
  return Date.now;
}

function resolvePollSleep(opts) {
  if (typeof opts.sleep === "function") return opts.sleep;
  if (typeof opts.sleepFn === "function") return opts.sleepFn;
  return (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function readPollClock(clock) {
  try {
    const value = clock();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function inspectProcessIdentity(pid, opts = {}) {
  const inspected = inspectVerifiedProcessIdentity(pid, processVerificationOptions(opts));
  if (inspected.status === "live" && inspected.identity) {
    return legacyIdentity(inspected.identity);
  }
  return {
    ok: false,
    inspector: DEFAULT_INSPECTOR,
    reason: legacyInspectionReason(inspected, opts),
  };
}

function compareProcessIdentity(evidence, inspected) {
  if (!inspected?.ok) return { ok: false, reason: inspected?.reason || "stale pid" };
  if (!positivePid(inspected.pid) || inspected.pid !== evidence.pid) return { ok: false, reason: "inspected pid mismatch" };
  if (!nonEmptyString(inspected.inspector) || inspected.inspector !== evidence.identity.inspector) return { ok: false, reason: "unsupported inspector" };
  if (String(inspected.start_marker || "") !== evidence.identity.start_marker) return { ok: false, reason: "process start marker mismatch" };
  if (normalizeCommandName(inspected.command_name || "") !== normalizeCommandName(evidence.identity.command_name)) return { ok: false, reason: "process command mismatch" };
  if (resolve(String(inspected.cwd || "")) !== resolve(evidence.cwd)) return { ok: false, reason: "process cwd mismatch" };
  return { ok: true };
}

function verifyEvidenceProcess(evidence, opts = {}) {
  const injected = resolveLegacyInspector(opts);
  if (!injected) {
    const verified = verifyProcessIdentity(expectedProcessIdentity(evidence), processVerificationOptions(opts));
    return { ...verified, reason: verificationReason(verified) };
  }

  const context = legacyVerificationContext(evidence, opts, injected);
  const verified = verifyProcessIdentity(context.expected, context.options);
  return {
    ...verified,
    status: context.state.comparison && !context.state.comparison.ok ? "mismatched" : verified.status,
    reason: context.state.comparison && !context.state.comparison.ok
      ? context.state.comparison.reason
      : context.state.reason || verificationReason(verified),
  };
}

async function signalEvidenceProcess(evidence, opts) {
  const injected = resolveLegacyInspector(opts);
  const context = injected
    ? legacyVerificationContext(evidence, opts, injected)
    : { expected: expectedProcessIdentity(evidence), options: processVerificationOptions(opts), state: null };
  const signaled = await signalVerifiedProcess(context.expected, {
    ...context.options,
    signal: PROCESS_EVIDENCE_SIGNAL,
    waitForExitMs: 0,
  });
  const verified = signaled.verification;
  if (!verified) return signaled;
  return {
    ...signaled,
    verification: {
      ...verified,
      status: context.state?.comparison && !context.state.comparison.ok ? "mismatched" : verified.status,
      reason: context.state?.comparison && !context.state.comparison.ok
        ? context.state.comparison.reason
        : context.state?.reason || verificationReason(verified),
    },
  };
}

function inspectProcessForEvidence(pid, opts) {
  const injected = resolveLegacyInspector(opts);
  if (!injected) return inspectProcessIdentity(pid, opts);

  const initial = callLegacyInspector(injected, pid);
  if (legacyInspectionStatus(initial) !== "live") return legacyInspectionFailure(initial);
  if (
    !nonEmptyString(initial.start_marker)
    || !nonEmptyString(initial.command_name)
    || !nonEmptyString(initial.cwd)
  ) return initial;
  const expected = {
    pid,
    cwd: initial.cwd,
    identity: {
      inspector: stringOrDefault(initial.inspector, DEFAULT_INSPECTOR),
      start_marker: initial.start_marker,
      command_name: initial.command_name,
    },
  };
  const context = legacyVerificationContext(expected, opts, injected);
  const verified = verifyProcessIdentity(context.expected, context.options);
  if (verified.status !== "live-and-matching" || (context.state.comparison && !context.state.comparison.ok)) {
    return {
      ok: false,
      inspector: DEFAULT_INSPECTOR,
      reason: context.state.comparison?.reason || context.state.reason || verificationReason(verified),
    };
  }
  return context.state.inspected;
}

function legacyVerificationContext(evidence, opts, inspector) {
  const state = { inspected: null, comparison: null, reason: null };
  const options = {
    ...processVerificationOptions(opts),
    platform: "linux",
    platformFn: () => "linux",
    livenessProbe: (pid) => {
      const inspected = callLegacyInspector(inspector, pid);
      state.inspected = inspected;
      const status = legacyInspectionStatus(inspected);
      if (status !== "live") {
        state.reason = inspected?.reason || (status === "absent" ? "stale pid (ESRCH: no such process)" : "process liveness unknown");
        return { status };
      }
      state.comparison = compareProcessIdentity(evidence, inspected);
      if (!state.comparison.ok) return { status: "indeterminate" };
      return { status: "live" };
    },
    procReadFile: (path) => path.endsWith("/stat")
      ? syntheticLinuxStat(evidence.pid)
      : `${state.inspected?.command_name || ""}\n`,
    procReadlink: () => state.inspected?.cwd || "",
  };
  return {
    state,
    options,
    expected: {
      pid: evidence.pid,
      cwd: evidence.cwd,
      identity: {
        inspector: PROCESS_INSPECTOR,
        start_marker: "linux-procfs:1",
        command_name: evidence.identity.command_name,
      },
    },
  };
}

function expectedProcessIdentity(evidence) {
  return {
    pid: evidence.pid,
    cwd: evidence.cwd,
    identity: {
      inspector: evidence.identity.inspector,
      start_marker: evidence.identity.start_marker,
      command_name: evidence.identity.command_name,
    },
  };
}

function syntheticLinuxStat(pid) {
  return `${pid} (compat) S ${Array(18).fill("0").join(" ")} 1\n`;
}

function legacyIdentity(identity) {
  return {
    ok: true,
    inspector: identity.inspector,
    pid: identity.pid,
    start_marker: identity.start_marker,
    command_name: identity.command_name,
    cwd: identity.cwd,
  };
}

function legacyInspectionFailure(inspected) {
  return {
    ok: false,
    inspector: stringOrDefault(inspected?.inspector, DEFAULT_INSPECTOR),
    reason: inspected?.reason || (legacyInspectionStatus(inspected) === "absent" ? "stale pid (ESRCH: no such process)" : "process liveness unknown"),
  };
}

function legacyInspectionStatus(inspected) {
  if (inspected?.status === "live" || inspected?.status === "absent" || inspected?.status === "indeterminate") return inspected.status;
  if (inspected?.ok === true) return "live";
  if (inspected?.ok === false && (inspected.code === "ESRCH" || /\bESRCH\b/u.test(String(inspected.reason || "")))) {
    return "absent";
  }
  return "indeterminate";
}

function callLegacyInspector(inspector, pid) {
  try {
    return inspector(pid);
  } catch {
    return { ok: false, inspector: DEFAULT_INSPECTOR, reason: "process inspection failed" };
  }
}

function verificationReason(verified) {
  if (verified?.status === "absent") return "stale pid (ESRCH: no such process)";
  const field = verified?.mismatched_fields?.[0];
  if (field === "pid") return "inspected pid mismatch";
  if (field === "inspector") return "unsupported inspector";
  if (field === "start_marker") return "process start marker mismatch";
  if (field === "command_name") return "process command mismatch";
  if (field === "cwd") return "process cwd mismatch";
  return verified?.reason || "process identity could not be verified";
}

function legacyInspectionReason(inspected, opts) {
  if (inspected?.status === "absent") return "stale pid (ESRCH: no such process)";
  if (inspected?.code === "LIVENESS_PERMISSION_DENIED") return "process liveness unknown: EPERM";
  if (inspected?.code === "INVALID_PID") return "pid must be a positive integer";
  if (inspected?.code === "PLATFORM_UNSUPPORTED") {
    const platform = opts.platform || process.platform;
    return `process inspector unsupported on platform ${platform}`;
  }
  return inspected?.reason || "process identity could not be verified";
}

function requireVerifiedProcessIdentity(inspected, expectedCwd) {
  if (!inspected?.ok) throw new Error(`process evidence requires verifiable live process identity: ${inspected?.reason || "stale pid"}`);
  const startMarker = String(inspected.start_marker ?? "").trim();
  if (!startMarker) throw new Error("process evidence requires verifiable live process identity: missing process start marker");
  const commandName = normalizeCommandName(inspected.command_name || "");
  if (!commandName) throw new Error("process evidence requires verifiable live process identity: missing process command");
  if (!nonEmptyString(inspected.cwd)) throw new Error("process evidence requires verifiable live process identity: missing process cwd");
  if (resolve(String(inspected.cwd)) !== expectedCwd) throw new Error("process evidence requires verifiable live process identity: process cwd mismatch");
  return { startMarker, commandName };
}

function resolveLegacyInspector(opts = {}) {
  return typeof opts.inspectorFn === "function" ? opts.inspectorFn
    : typeof opts.processInspectorFn === "function" ? opts.processInspectorFn
      : null;
}

function processVerificationOptions(opts = {}) {
  const options = { ...opts };
  if (
    typeof opts.processAliveFn === "function"
    && typeof opts.livenessProbe !== "function"
    && typeof opts.livenessProbeFn !== "function"
    && typeof opts.processLivenessProbe !== "function"
  ) {
    options.livenessProbe = (pid) => ({ status: probeLegacyBooleanLiveness(opts.processAliveFn, pid) });
  }
  if (typeof opts.commandRunnerFn === "function" && typeof opts.commandRunner !== "function") {
    options.commandRunner = opts.commandRunnerFn;
  }
  return options;
}

function failClosed(runId, reason, processRef, pid = null) {
  return {
    ok: false,
    run_id: runId || null,
    status: "failed-closed",
    reason,
    pid,
    process_ref: processRef,
    signaled: false,
    updated: false,
  };
}

function validProcessLogRef(ref) {
  if (!nonEmptyString(ref) || isAbsolute(ref) || ref.includes("\\") || ref.includes("\0")) return false;
  const normalized = normalize(ref).replaceAll(sep, "/");
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") return false;
  if (!normalized.startsWith("processes/")) return false;
  return basename(normalized).length > 0 && normalized !== "processes";
}

function normalizeCommandName(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return basename(text.split(/\s+/u)[0]);
}

function positivePid(value) {
  return Number.isInteger(value) && value > 0;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringOrDefault(value, fallback) {
  return nonEmptyString(value) ? String(value).trim() : fallback;
}

function validTimestamp(value) {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function invalid(reason) {
  return { ok: false, reason, evidence: null };
}
