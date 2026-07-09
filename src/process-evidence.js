import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { timestamp } from "./utils.js";

export const PROCESS_EVIDENCE_FILE = "process.json";
export const PROCESS_EVIDENCE_KIND = "opencode-process";
export const PROCESS_EVIDENCE_SCHEMA_VERSION = 1;
export const PROCESS_EVIDENCE_SIGNAL = "SIGTERM";

const PROCESS_STATES = new Set(["running", "cancelled", "failed-closed", "exited"]);
const DEFAULT_INSPECTOR = "node-process";

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
  writeJsonAtomic(file, validation.evidence);
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

  const inspected = resolveInspector(input)(current.evidence.pid);
  if (processIsProvenStale(inspected)) return;
  const identity = compareProcessIdentity(current.evidence, inspected);
  if (identity.ok) {
    throw new Error(`refusing to overwrite live running process evidence for run '${current.evidence.run_id}' pid ${current.evidence.pid}`);
  }
  throw new Error(`refusing to overwrite running process evidence because stale/exited state could not be proven: ${identity.reason}`);
}

export function recordDetachedProcessEvidence(runDir, input = {}) {
  assertDetachedProcessEvidenceWritable(runDir, input);
  const startedAt = timestamp(input.now);
  const inspector = resolveInspector(input);
  const inspected = inspector(input.pid);
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

export function cancelProcessFromEvidence(runDir, opts = {}) {
  const read = readProcessEvidence(runDir, opts);
  if (!read.ok) return failClosed(opts.runId, read.reason, read.missing ? null : PROCESS_EVIDENCE_FILE);

  const evidence = read.evidence;
  if (evidence.state !== "running") return failClosed(evidence.run_id, `process evidence state is ${evidence.state}`, PROCESS_EVIDENCE_FILE);

  const inspector = resolveInspector(opts);
  const inspected = inspector(evidence.pid);
  const identity = compareProcessIdentity(evidence, inspected);
  if (!identity.ok) return failClosed(evidence.run_id, identity.reason, PROCESS_EVIDENCE_FILE, evidence.pid);

  const requestedAt = timestamp(opts.now);
  try {
    resolveSignalFn(opts)(evidence.pid, PROCESS_EVIDENCE_SIGNAL);
  } catch (error) {
    return failClosed(evidence.run_id, `signal failed: ${error.message}`, PROCESS_EVIDENCE_FILE, evidence.pid);
  }

  const confirmedAt = timestamp(opts.confirmedAt || opts.now);
  const next = {
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
  };
  writeProcessEvidence(runDir, next);
  return {
    ok: true,
    run_id: evidence.run_id,
    status: "cancelled",
    pid: evidence.pid,
    signal: PROCESS_EVIDENCE_SIGNAL,
    process_ref: PROCESS_EVIDENCE_FILE,
    updated: true,
    signaled: true,
  };
}

export function inspectProcessIdentity(pid, opts = {}) {
  if (!positivePid(pid)) return { ok: false, inspector: DEFAULT_INSPECTOR, reason: "pid must be a positive integer" };
  const liveness = inspectPidLiveness(pid, opts);
  if (!liveness.alive) return { ok: false, inspector: DEFAULT_INSPECTOR, reason: liveness.reason };
  const platform = opts.platform || process.platform;
  if (platform === "linux") return inspectLinuxProcessIdentity(pid);
  if (platform === "darwin") return inspectDarwinProcessIdentity(pid, opts);
  return { ok: false, inspector: DEFAULT_INSPECTOR, reason: `process inspector unsupported on platform ${platform}` };
}

function inspectLinuxProcessIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(") ");
    if (end === -1) return { ok: false, inspector: DEFAULT_INSPECTOR, reason: "invalid process stat" };
    const fields = stat.slice(end + 2).trim().split(/\s+/u);
    const start = fields[19];
    if (!start) return { ok: false, inspector: DEFAULT_INSPECTOR, reason: "missing process start marker" };
    const command = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    return {
      ok: true,
      inspector: DEFAULT_INSPECTOR,
      pid,
      start_marker: `linux-procfs:${start}`,
      command_name: normalizeCommandName(command),
      cwd: resolve(cwd),
    };
  } catch (error) {
    return { ok: false, inspector: DEFAULT_INSPECTOR, reason: `process inspection failed: ${error.message}` };
  }
}

function inspectDarwinProcessIdentity(pid, opts = {}) {
  const runCommand = resolveCommandRunner(opts);
  try {
    const lstart = runCommand("ps", ["-p", String(pid), "-o", "lstart="]).trim().replace(/\s+/gu, " ");
    const command = runCommand("ps", ["-p", String(pid), "-o", "comm="]).trim().split(/\r?\n/u)[0] || "";
    const cwd = darwinProcessCwd(pid, runCommand);
    if (!lstart) return { ok: false, inspector: DEFAULT_INSPECTOR, reason: "missing process start marker" };
    if (!command) return { ok: false, inspector: DEFAULT_INSPECTOR, reason: "missing process command" };
    if (!cwd) return { ok: false, inspector: DEFAULT_INSPECTOR, reason: "missing process cwd" };
    return {
      ok: true,
      inspector: DEFAULT_INSPECTOR,
      pid,
      start_marker: `darwin-ps:${lstart}`,
      command_name: normalizeCommandName(command),
      cwd: resolve(cwd),
    };
  } catch (error) {
    return { ok: false, inspector: DEFAULT_INSPECTOR, reason: `process inspection failed: ${error.message}` };
  }
}

function darwinProcessCwd(pid, runCommand) {
  const output = runCommand("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const line = output.split(/\r?\n/u).find((item) => item.startsWith("n"));
  return line ? line.slice(1) : null;
}

function compareProcessIdentity(evidence, inspected) {
  if (!inspected?.ok) return { ok: false, reason: inspected?.reason || "stale pid" };
  if (positivePid(inspected.pid) && inspected.pid !== evidence.pid) return { ok: false, reason: "inspected pid mismatch" };
  if (stringOrDefault(inspected.inspector, DEFAULT_INSPECTOR) !== evidence.identity.inspector) return { ok: false, reason: "unsupported inspector" };
  if (String(inspected.start_marker || "") !== evidence.identity.start_marker) return { ok: false, reason: "process start marker mismatch" };
  if (normalizeCommandName(inspected.command_name || "") !== normalizeCommandName(evidence.identity.command_name)) return { ok: false, reason: "process command mismatch" };
  if (resolve(String(inspected.cwd || "")) !== resolve(evidence.cwd)) return { ok: false, reason: "process cwd mismatch" };
  return { ok: true };
}

function processIsProvenStale(inspected) {
  if (!inspected || inspected.ok !== false) return false;
  return /\b(?:ESRCH|no such process)\b/iu.test(String(inspected.reason || ""));
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

function resolveInspector(opts = {}) {
  return typeof opts.inspectorFn === "function" ? opts.inspectorFn
    : typeof opts.processInspectorFn === "function" ? opts.processInspectorFn
      : (pid) => inspectProcessIdentity(pid, opts);
}

function resolveSignalFn(opts = {}) {
  if (typeof opts.signalFn === "function") return opts.signalFn;
  if (typeof opts.processSignalFn === "function") return opts.processSignalFn;
  return (pid, signal) => {
    if (!positivePid(pid)) throw new Error("pid must be a positive integer");
    if (signal !== PROCESS_EVIDENCE_SIGNAL) throw new Error("unsupported cancellation signal");
    process.kill(pid, PROCESS_EVIDENCE_SIGNAL);
  };
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

function inspectPidLiveness(pid, opts = {}) {
  if (typeof opts.processAliveFn === "function") {
    return opts.processAliveFn(pid) ? { alive: true, reason: null } : { alive: false, reason: "stale pid (no such process)" };
  }
  try {
    process.kill(pid, 0);
    return { alive: true, reason: null };
  } catch (error) {
    if (error?.code === "ESRCH") return { alive: false, reason: "stale pid (ESRCH: no such process)" };
    return { alive: false, reason: `process liveness unknown: ${error?.code || error?.message || "unknown error"}` };
  }
}

function resolveCommandRunner(opts = {}) {
  if (typeof opts.commandRunnerFn === "function") return opts.commandRunnerFn;
  return (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: 1024 * 1024 });
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}
