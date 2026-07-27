import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { hostname as systemHostname } from "node:os";
import { isAbsolute, posix, resolve } from "node:path";

export const PROCESS_INSPECTOR = "node-process";
export const VERIFIED_PROCESS_SIGNAL = "SIGTERM";
export const PROCESS_SIGNAL_RACE_LIMITATION =
  "Portable process inspection and signaling are not atomic; exit or PID reuse after the final identity check can still cause SIGTERM to reach a replacement process.";

export function normalizeLegacyBooleanLiveness(value) {
  if (value === true) return "live";
  if (value === false) return "absent";
  return "indeterminate";
}

export function probeLegacyBooleanLiveness(callback, ...args) {
  if (typeof callback !== "function") return "indeterminate";
  try {
    return normalizeLegacyBooleanLiveness(callback(...args));
  } catch {
    return "indeterminate";
  }
}

export function publicLivenessBoolean(status) {
  if (status === "live") return true;
  if (status === "absent") return false;
  return null;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_MAX_BUFFER = 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DARWIN_WEEKDAYS = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
const DARWIN_MONTHS = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
const DARWIN_START_PATTERN = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d) (\d{4})$/u;

export const PROCESS_VERIFICATION_CODES = Object.freeze({
  INVALID_PID: "INVALID_PID",
  INVALID_OPTIONS: "INVALID_OPTIONS",
  LIVENESS_LIVE: "LIVENESS_LIVE",
  LIVENESS_ABSENT: "LIVENESS_ABSENT",
  LIVENESS_PERMISSION_DENIED: "LIVENESS_PERMISSION_DENIED",
  LIVENESS_FAILED: "LIVENESS_FAILED",
  LIVENESS_RESULT_MALFORMED: "LIVENESS_RESULT_MALFORMED",
  PLATFORM_UNSUPPORTED: "PLATFORM_UNSUPPORTED",
  METADATA_UNAVAILABLE: "METADATA_UNAVAILABLE",
  METADATA_MALFORMED: "METADATA_MALFORMED",
  INSPECTION_TIMEOUT: "INSPECTION_TIMEOUT",
  IDENTITY_LIVE: "IDENTITY_LIVE",
  IDENTITY_INVALID: "IDENTITY_INVALID",
  IDENTITY_MATCH: "IDENTITY_MATCH",
  IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
  SIGNAL_INVALID: "SIGNAL_INVALID",
  SIGNAL_NOT_AUTHORIZED: "SIGNAL_NOT_AUTHORIZED",
  SIGNAL_SENT: "SIGNAL_SENT",
  SIGNAL_FAILED: "SIGNAL_FAILED",
  POST_SIGNAL_NOT_CHECKED: "POST_SIGNAL_NOT_CHECKED",
  POST_SIGNAL_ABSENT: "POST_SIGNAL_ABSENT",
  POST_SIGNAL_LIVE: "POST_SIGNAL_LIVE",
  POST_SIGNAL_MISMATCH: "POST_SIGNAL_MISMATCH",
  POST_SIGNAL_INDETERMINATE: "POST_SIGNAL_INDETERMINATE",
});

const REASONS = Object.freeze({
  INVALID_PID: "process pid must be a positive integer",
  INVALID_OPTIONS: "process verification options are invalid",
  LIVENESS_LIVE: "process is live",
  LIVENESS_ABSENT: "process is absent",
  LIVENESS_PERMISSION_DENIED: "process liveness is indeterminate because permission was denied",
  LIVENESS_FAILED: "process liveness could not be determined",
  LIVENESS_RESULT_MALFORMED: "process liveness probe returned a malformed result",
  PLATFORM_UNSUPPORTED: "process identity inspection is unsupported on this platform",
  METADATA_UNAVAILABLE: "process identity metadata could not be inspected",
  METADATA_MALFORMED: "process identity metadata is malformed",
  INSPECTION_TIMEOUT: "process identity inspection timed out",
  IDENTITY_LIVE: "process identity is live",
  IDENTITY_INVALID: "expected process identity is invalid",
  IDENTITY_MATCH: "process identity matches expected identity",
  IDENTITY_MISMATCH: "process identity does not match expected identity",
  SIGNAL_INVALID: "only SIGTERM may be sent by verified process signaling",
  SIGNAL_NOT_AUTHORIZED: "process signal was not authorized by identity verification",
  SIGNAL_SENT: "SIGTERM was sent to the verified process",
  SIGNAL_FAILED: "SIGTERM could not be sent to the verified process",
  POST_SIGNAL_NOT_CHECKED: "process state was not checked after SIGTERM",
  POST_SIGNAL_ABSENT: "process absence was confirmed after SIGTERM",
  POST_SIGNAL_LIVE: "the matching process remains live after SIGTERM",
  POST_SIGNAL_MISMATCH: "a different process identity was observed after SIGTERM",
  POST_SIGNAL_INDETERMINATE: "process state is indeterminate after SIGTERM",
});

class InspectionFailure extends Error {
  constructor(code) {
    super(REASONS[code]);
    this.code = code;
  }
}

export function probeProcessLiveness(pid, options = {}) {
  if (!positivePid(pid)) return result("indeterminate", "INVALID_PID", pid);

  const injectedProbe = firstFunction(options.livenessProbe);
  if (injectedProbe) {
    try {
      return normalizeLivenessResult(injectedProbe(pid), pid);
    } catch (error) {
      return livenessErrorResult(error, pid);
    }
  }

  try {
    process.kill(pid, 0);
    return result("live", "LIVENESS_LIVE", pid);
  } catch (error) {
    return livenessErrorResult(error, pid);
  }
}

export function inspectProcessIdentity(pid, options = {}) {
  const liveness = probeProcessLiveness(pid, options);
  if (liveness.status !== "live") return liveness;

  const platform = resolvePlatform(options);
  if (platform !== "linux" && platform !== "darwin") {
    return result("indeterminate", "PLATFORM_UNSUPPORTED", pid);
  }

  try {
    const identity = platform === "linux"
      ? inspectLinuxIdentity(pid, options)
      : inspectDarwinIdentity(pid, options);
    identity.hostname = resolveHostname(options);
    return {
      ...result("live", "IDENTITY_LIVE", pid),
      identity,
    };
  } catch (error) {
    const failure = error instanceof InspectionFailure
      ? error
      : new InspectionFailure(isTimeoutError(error) ? "INSPECTION_TIMEOUT" : "METADATA_UNAVAILABLE");
    const refreshed = probeProcessLiveness(pid, options);
    if (refreshed.status === "absent") return refreshed;
    return {
      ...result("indeterminate", failure.code, pid),
      liveness_status: refreshed.status,
    };
  }
}

export function verifyProcessIdentity(expected, options = {}) {
  const normalizedExpected = normalizeExpectedIdentity(expected);
  if (!normalizedExpected) return result("indeterminate", "IDENTITY_INVALID", expected?.pid ?? null);

  const inspected = inspectProcessIdentity(normalizedExpected.pid, options);
  if (inspected.status !== "live") return inspected;

  const actual = normalizeInspectedIdentity(inspected.identity);
  if (!actual) return result("indeterminate", "METADATA_MALFORMED", normalizedExpected.pid);

  const mismatchedFields = [];
  for (const field of ["pid", "inspector", "start_marker", "command_name", "cwd"]) {
    if (actual[field] !== normalizedExpected[field]) mismatchedFields.push(field);
  }

  if (mismatchedFields.length > 0) {
    return {
      ...result("mismatched", "IDENTITY_MISMATCH", normalizedExpected.pid),
      mismatched_fields: mismatchedFields,
    };
  }

  return {
    ...result("live-and-matching", "IDENTITY_MATCH", normalizedExpected.pid),
    identity: inspected.identity,
  };
}

export async function signalVerifiedProcess(expected, options = {}) {
  const signal = options.signal ?? VERIFIED_PROCESS_SIGNAL;
  if (signal !== VERIFIED_PROCESS_SIGNAL) {
    return signalResult("not-signaled", "SIGNAL_INVALID", expected?.pid ?? null);
  }

  const polling = normalizePollingOptions(options);
  if (!polling) return signalResult("not-signaled", "INVALID_OPTIONS", expected?.pid ?? null);

  let deadline = null;
  if (polling.waitForExitMs > 0) {
    try {
      const started = polling.clock();
      if (!Number.isFinite(started)) return signalResult("not-signaled", "INVALID_OPTIONS", expected?.pid ?? null);
      deadline = started + polling.waitForExitMs;
    } catch {
      return signalResult("not-signaled", "INVALID_OPTIONS", expected?.pid ?? null);
    }
  }

  const signalFn = firstFunction(options.signalFn, options.processSignalFn) || process.kill.bind(process);

  // No callback, hook, wait, or fallback belongs between this final inspection
  // and the single targeted signal operation.
  const verification = verifyProcessIdentity(expected, options);
  if (verification.status !== "live-and-matching") {
    return {
      ...signalResult("not-signaled", "SIGNAL_NOT_AUTHORIZED", verification.pid),
      verification,
    };
  }

  const pid = verification.pid;
  if (!positivePid(pid)) {
    return signalResult("not-signaled", "SIGNAL_NOT_AUTHORIZED", pid);
  }

  try {
    signalFn(pid, VERIFIED_PROCESS_SIGNAL);
  } catch {
    return {
      ...signalResult("signal-failed", "SIGNAL_FAILED", pid),
      verification,
    };
  }

  const postSignal = deadline === null
    ? postSignalResult("not-checked", "POST_SIGNAL_NOT_CHECKED")
    : await observeAfterSignal(expected, options, polling, deadline);
  return {
    ...signalResult("signaled", "SIGNAL_SENT", pid),
    verification,
    post_signal: postSignal,
  };
}

function inspectLinuxIdentity(pid, options) {
  const readFile = firstFunction(options.procReadFile)
    || ((path) => readFileSync(path, "utf8"));
  const readLink = firstFunction(options.procReadlink)
    || ((path) => readlinkSync(path));

  let firstStat;
  let command;
  let cwd;
  let finalStat;
  try {
    firstStat = readFile(`/proc/${pid}/stat`, "utf8");
    command = readFile(`/proc/${pid}/comm`, "utf8");
    cwd = readLink(`/proc/${pid}/cwd`);
    finalStat = readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    throw new InspectionFailure(isTimeoutError(error) ? "INSPECTION_TIMEOUT" : "METADATA_UNAVAILABLE");
  }

  const firstStart = parseLinuxStartMarker(firstStat, pid);
  const finalStart = parseLinuxStartMarker(finalStat, pid);
  const commandName = normalizeCommandName(command);
  const resolvedCwd = normalizeCwd(cwd);
  if (!firstStart || !finalStart || !commandName || !resolvedCwd) {
    throw new InspectionFailure("METADATA_MALFORMED");
  }
  if (firstStart !== finalStart) throw new InspectionFailure("METADATA_MALFORMED");

  return {
    pid,
    inspector: PROCESS_INSPECTOR,
    start_marker: `linux-procfs:${firstStart}`,
    command_name: commandName,
    cwd: resolvedCwd,
  };
}

function inspectDarwinIdentity(pid, options) {
  const timeout = positiveBound(options.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
  const maxBuffer = positiveBound(options.commandMaxBuffer, DEFAULT_COMMAND_MAX_BUFFER);
  if (!timeout || !maxBuffer) throw new InspectionFailure("METADATA_MALFORMED");
  const runCommand = firstFunction(options.commandRunner)
    || ((command, args, commandOptions) => execFileSync(command, args, commandOptions));
  const commandOptions = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    maxBuffer,
  };

  let firstStart;
  let command;
  let lsof;
  let finalStart;
  try {
    firstStart = commandOutput(runCommand, "ps", ["-p", String(pid), "-o", "lstart="], commandOptions, maxBuffer);
    command = commandOutput(runCommand, "ps", ["-p", String(pid), "-o", "comm="], commandOptions, maxBuffer);
    lsof = commandOutput(runCommand, "lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], commandOptions, maxBuffer);
    finalStart = commandOutput(runCommand, "ps", ["-p", String(pid), "-o", "lstart="], commandOptions, maxBuffer);
  } catch (error) {
    if (error instanceof InspectionFailure) throw error;
    throw new InspectionFailure(isTimeoutError(error) ? "INSPECTION_TIMEOUT" : "METADATA_UNAVAILABLE");
  }

  const firstMarker = normalizeDarwinStart(firstStart);
  const finalMarker = normalizeDarwinStart(finalStart);
  const commandName = parseDarwinCommand(command);
  const cwd = parseDarwinCwd(lsof, pid);
  if (!firstMarker || !finalMarker || firstMarker !== finalMarker || !commandName || !cwd) {
    throw new InspectionFailure("METADATA_MALFORMED");
  }

  return {
    pid,
    inspector: PROCESS_INSPECTOR,
    start_marker: `darwin-ps:${firstMarker}`,
    command_name: commandName,
    cwd,
  };
}

async function observeAfterSignal(expected, options, polling, deadline) {
  const maximumPolls = Math.ceil(polling.waitForExitMs / polling.pollIntervalMs) + 1;
  for (let count = 0; count < maximumPolls; count += 1) {
    let now;
    try {
      now = polling.clock();
      if (!Number.isFinite(now) || now >= deadline) break;
      await polling.sleep(Math.min(polling.pollIntervalMs, deadline - now));
    } catch {
      return postSignalResult("indeterminate", "POST_SIGNAL_INDETERMINATE");
    }

    const verification = verifyProcessIdentity(expected, options);
    if (verification.status === "absent") {
      return { ...postSignalResult("absent", "POST_SIGNAL_ABSENT"), verification };
    }
    if (verification.status === "mismatched") {
      return { ...postSignalResult("mismatched", "POST_SIGNAL_MISMATCH"), verification };
    }
    if (verification.status === "indeterminate") {
      return { ...postSignalResult("indeterminate", "POST_SIGNAL_INDETERMINATE"), verification };
    }
  }

  const verification = verifyProcessIdentity(expected, options);
  if (verification.status === "absent") return { ...postSignalResult("absent", "POST_SIGNAL_ABSENT"), verification };
  if (verification.status === "mismatched") return { ...postSignalResult("mismatched", "POST_SIGNAL_MISMATCH"), verification };
  if (verification.status === "indeterminate") return { ...postSignalResult("indeterminate", "POST_SIGNAL_INDETERMINATE"), verification };
  return { ...postSignalResult("live-and-matching", "POST_SIGNAL_LIVE"), verification };
}

function normalizePollingOptions(options) {
  const waitForExitMs = options.waitForExitMs ?? 0;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isInteger(waitForExitMs) || waitForExitMs < 0) return null;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) return null;
  const clock = firstFunction(options.clock) || Date.now;
  const sleep = firstFunction(options.sleep)
    || ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  return { waitForExitMs, pollIntervalMs, clock, sleep };
}

function normalizeExpectedIdentity(expected) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) return null;
  const nested = expected.identity && typeof expected.identity === "object" && !Array.isArray(expected.identity)
    ? expected.identity
    : expected;
  const pid = expected.pid ?? nested.pid;
  const inspector = nested.inspector;
  const startMarker = nested.start_marker ?? nested.startMarker;
  const commandName = normalizeCommandName(nested.command_name ?? nested.commandName);
  const cwd = normalizeCwd(expected.cwd ?? nested.cwd);
  if (!positivePid(pid) || !nonEmptyExactString(inspector) || !nonEmptyExactString(startMarker) || !commandName || !cwd) return null;
  return { pid, inspector, start_marker: startMarker, command_name: commandName, cwd };
}

function normalizeInspectedIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return null;
  const commandName = normalizeCommandName(identity.command_name ?? identity.commandName);
  const cwd = normalizeCwd(identity.cwd);
  const startMarker = identity.start_marker ?? identity.startMarker;
  if (!positivePid(identity.pid) || !nonEmptyExactString(identity.inspector) || !nonEmptyExactString(startMarker) || !commandName || !cwd) return null;
  return {
    pid: identity.pid,
    inspector: identity.inspector,
    start_marker: startMarker,
    command_name: commandName,
    cwd,
  };
}

function normalizeLivenessResult(value, pid) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return result("indeterminate", "LIVENESS_RESULT_MALFORMED", pid);
  }
  if (value.status === "live") return result("live", "LIVENESS_LIVE", pid);
  if (value.status === "absent") return result("absent", "LIVENESS_ABSENT", pid);
  if (value.status === "indeterminate") return result("indeterminate", "LIVENESS_FAILED", pid);
  return result("indeterminate", "LIVENESS_RESULT_MALFORMED", pid);
}

function livenessErrorResult(error, pid) {
  if (error?.code === "ESRCH") return result("absent", "LIVENESS_ABSENT", pid);
  if (error?.code === "EPERM" || error?.code === "EACCES") {
    return result("indeterminate", "LIVENESS_PERMISSION_DENIED", pid);
  }
  return result("indeterminate", "LIVENESS_FAILED", pid);
}

function parseLinuxStartMarker(value, pid) {
  const text = toText(value);
  if (!text.startsWith(`${pid} (`)) return null;
  const commandEnd = text.lastIndexOf(") ");
  if (commandEnd < 0) return null;
  const fields = text.slice(commandEnd + 2).trim().split(/\s+/u);
  const marker = fields[19];
  return /^\d+$/u.test(marker || "") ? marker : null;
}

function parseDarwinCwd(value, pid) {
  const lines = strictOutputLines(value);
  if (!lines || lines.length !== 3) return null;
  if (lines[0] !== `p${pid}` || lines[1] !== "fcwd" || !lines[2].startsWith("n")) return null;
  return normalizeCwd(lines[2].slice(1));
}

function commandOutput(runCommand, command, args, commandOptions, maxBuffer) {
  const output = runCommand(command, args, commandOptions);
  if (!(typeof output === "string" || Buffer.isBuffer(output))) throw new InspectionFailure("METADATA_MALFORMED");
  if (Buffer.byteLength(output) > maxBuffer) throw new InspectionFailure("METADATA_UNAVAILABLE");
  return toText(output);
}

function normalizeCommandName(value) {
  const text = toText(value).trim();
  if (!text || /[\r\n\0]/u.test(text)) return null;
  const name = posix.basename(text);
  return name && name !== "." && name !== ".." ? name : null;
}

function normalizeCwd(value) {
  const text = toText(value);
  if (!text || text.includes("\0") || !isAbsolute(text)) return null;
  return resolve(text);
}

function normalizeDarwinStart(value) {
  const lines = strictOutputLines(value);
  if (!lines || lines.length !== 1 || !/^[ -~]+$/u.test(lines[0])) return null;
  const normalized = lines[0].trim().replace(/ +/gu, " ");
  const match = normalized.match(DARWIN_START_PATTERN);
  if (!match) return null;

  const [, weekday, monthName, dayText, hourText, minuteText, secondText, yearText] = match;
  const month = DARWIN_MONTHS.indexOf(monthName);
  const day = Number(dayText);
  const year = Number(yearText);
  if (year < 1970 || month < 0) return null;
  const date = new Date(Date.UTC(year, month, day, Number(hourText), Number(minuteText), Number(secondText)));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month
    || date.getUTCDate() !== day
    || DARWIN_WEEKDAYS[date.getUTCDay()] !== weekday
  ) return null;
  return normalized;
}

function parseDarwinCommand(value) {
  const lines = strictOutputLines(value);
  return lines && lines.length === 1 ? normalizeCommandName(lines[0]) : null;
}

function strictOutputLines(value) {
  const text = toText(value);
  if (!text || text.includes("\0") || /\r(?!\n)/u.test(text)) return null;
  const body = text.endsWith("\r\n") ? text.slice(0, -2)
    : text.endsWith("\n") ? text.slice(0, -1)
      : text;
  if (!body || /[\r\n]$/u.test(body)) return null;
  const lines = body.split(/\r?\n/u);
  return lines.some((line) => line.length === 0) ? null : lines;
}

function resolvePlatform(options) {
  try {
    return options.platform ?? process.platform;
  } catch {
    return null;
  }
}

function resolveHostname(options) {
  const value = options.hostname ?? systemHostname();
  if (!nonEmptyExactString(value)) throw new InspectionFailure("METADATA_MALFORMED");
  return value;
}

function positiveBound(value, fallback) {
  const selected = value ?? fallback;
  return Number.isInteger(selected) && selected > 0 ? selected : null;
}

function isTimeoutError(error) {
  return error?.code === "ETIMEDOUT" || error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || error?.timedOut === true;
}

function positivePid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonEmptyExactString(value) {
  return typeof value === "string" && value.length > 0 && value.trim().length > 0 && !value.includes("\0");
}

function firstFunction(...values) {
  return values.find((value) => typeof value === "function") || null;
}

function toText(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function result(status, code, pid, extra = {}) {
  return { status, code: PROCESS_VERIFICATION_CODES[code], reason: REASONS[code], pid, ...extra };
}

function signalResult(status, code, pid) {
  return {
    ...result(status, code, pid),
    signal: VERIFIED_PROCESS_SIGNAL,
    limitation: PROCESS_SIGNAL_RACE_LIMITATION,
  };
}

function postSignalResult(status, code) {
  return { status, code: PROCESS_VERIFICATION_CODES[code], reason: REASONS[code] };
}
