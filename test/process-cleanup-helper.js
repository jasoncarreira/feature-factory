import { spawn as spawnChild } from "node:child_process";

const MAX_DIAGNOSTICS = 20;
const MAX_METADATA_LENGTH = 160;
const MAX_ERROR_LENGTH = 300;

function boundedText(value, limit) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, limit);
}

function positivePid(child) {
  return Number.isInteger(child.pid) && child.pid > 0 ? child.pid : null;
}

function errorDetails(error) {
  return {
    errorCode: boundedText(error?.code, MAX_METADATA_LENGTH),
    errorMessage: boundedText(error?.message ?? error, MAX_ERROR_LENGTH),
  };
}

function isTerminated(record) {
  return record.exit || record.close || record.exitCode !== null || record.signalCode !== null;
}

function stateOf(record) {
  if (record.close) return "closed";
  if (record.exit || record.exitCode !== null || record.signalCode !== null) return "exited";
  if (record.error) return "spawn-error";
  if (record.spawn) return "spawned";
  return "pending-spawn";
}

function normalizeTimeout(timeoutMs) {
  const numeric = Number(timeoutMs);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 1500;
}

export function createTrackedProcessCleanup({ timeoutMs = 1500, diagnostic = console.error } = {}) {
  const records = new Map();
  const terminationWaiters = new Map();
  const cleanupTimeoutMs = normalizeTimeout(timeoutMs);
  let cleanupPromise = null;
  let spawning = false;

  function spawn(command, args = [], options = {}, metadata = {}) {
    if (cleanupPromise) throw new Error("Cannot spawn after process cleanup has started");
    if (spawning) throw new Error("Tracked process spawn is not reentrant");
    if (typeof command !== "string") throw new TypeError("Tracked process command must be a string");

    spawning = true;
    try {
      if (options?.detached === true) throw new Error("Tracked process cleanup does not support detached children");

      const label = boundedText(metadata?.label, MAX_METADATA_LENGTH);
      const boundedCommand = command.slice(0, MAX_METADATA_LENGTH);
      if (cleanupPromise) throw new Error("Cannot spawn after process cleanup has started");

      const child = spawnChild(command, args, options);
      const signal = typeof child.kill === "function" ? child.kill.bind(child) : null;
      const record = {
        child,
        signal,
        label,
        command: boundedCommand,
        pid: positivePid(child),
        spawn: false,
        error: false,
        exit: false,
        close: false,
        exitCode: child.exitCode ?? null,
        signalCode: child.signalCode ?? null,
        signalAttempted: false,
        signalOutcome: null,
        signalError: null,
        spawnError: null,
      };

      const terminationPromise = new Promise((resolve) => {
        terminationWaiters.set(child, { promise: null, resolve });
      });
      terminationWaiters.get(child).promise = terminationPromise;
      records.set(child, record);

      child.once("spawn", () => {
        record.spawn = true;
        record.pid = positivePid(child);
      });
      child.once("error", (error) => {
        record.error = true;
        record.spawnError = errorDetails(error);
      });
      child.once("exit", (exitCode, signalCode) => {
        record.exit = true;
        record.exitCode = exitCode;
        record.signalCode = signalCode;
        terminationWaiters.get(child)?.resolve();
      });
      child.once("close", (exitCode, signalCode) => {
        record.close = true;
        record.exitCode = exitCode;
        record.signalCode = signalCode;
        terminationWaiters.get(child)?.resolve();
      });

      return child;
    } finally {
      spawning = false;
    }
  }

  function cleanup() {
    if (cleanupPromise) return cleanupPromise;

    cleanupPromise = Promise.resolve().then(async () => {
      const deadline = Date.now() + cleanupTimeoutMs;
      const attempted = [];

      for (const record of records.values()) {
        record.exitCode = record.child.exitCode ?? record.exitCode;
        record.signalCode = record.child.signalCode ?? record.signalCode;
        if (isTerminated(record) || record.signal === null) continue;

        record.signalAttempted = true;
        attempted.push(record);
        try {
          const signaled = record.signal("SIGTERM");
          record.signalOutcome = signaled ? "signal-sent" : "signal-returned-false";
        } catch (error) {
          record.signalOutcome = "signal-threw";
          record.signalError = errorDetails(error);
        }

        record.exitCode = record.child.exitCode ?? record.exitCode;
        record.signalCode = record.child.signalCode ?? record.signalCode;
        if (record.signalOutcome === "signal-returned-false" && isTerminated(record)) {
          record.signalOutcome = "signal-exit-race";
        }
      }

      const waiting = attempted.filter((record) => !isTerminated(record));
      if (waiting.length > 0) {
        const remainingMs = Math.max(0, deadline - Date.now());
        let timer;
        await Promise.race([
          Promise.all(waiting.map((record) => terminationWaiters.get(record.child).promise)),
          new Promise((resolve) => {
            timer = setTimeout(resolve, remainingMs);
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
      }

      const deadlineSurvivors = new Set();
      for (const record of attempted) {
        record.exitCode = record.child.exitCode ?? record.exitCode;
        record.signalCode = record.child.signalCode ?? record.signalCode;
        if (!isTerminated(record)) deadlineSurvivors.add(record);
      }

      const candidates = [];
      for (const record of attempted) {
        candidates.push(makeDiagnostic(record, record.signalOutcome, record.signalError));
        if (deadlineSurvivors.has(record)) {
          candidates.push(makeDiagnostic(record, "deadline-survivor", record.signalError ?? record.spawnError));
        }
      }

      const diagnostics = candidates.slice(0, MAX_DIAGNOSTICS);
      const omittedDiagnosticCount = Math.max(0, candidates.length - diagnostics.length);
      for (const entry of diagnostics) emitDiagnostic(diagnostic, entry);
      if (omittedDiagnosticCount > 0) {
        emitDiagnostic(diagnostic, { outcome: "diagnostics-omitted", omittedDiagnosticCount });
      }

      return Object.freeze({
        timedOut: deadlineSurvivors.size > 0,
        signaledCount: attempted.filter((record) => record.signalOutcome === "signal-sent").length,
        diagnostics: Object.freeze(diagnostics),
        omittedDiagnosticCount,
      });
    }).catch((error) => {
      const entry = {
        label: null,
        command: null,
        pid: null,
        state: "cleanup",
        exitCode: null,
        signalCode: null,
        outcome: "cleanup-failed",
        ...errorDetails(error),
      };
      emitDiagnostic(diagnostic, entry);
      return Object.freeze({
        timedOut: false,
        signaledCount: 0,
        diagnostics: Object.freeze([entry]),
        omittedDiagnosticCount: 0,
      });
    });

    return cleanupPromise;
  }

  return Object.freeze({ spawn, cleanup });
}

function makeDiagnostic(record, outcome, error) {
  return Object.freeze({
    label: record.label,
    command: record.command,
    pid: record.pid,
    state: stateOf(record),
    exitCode: record.exitCode,
    signalCode: boundedText(record.signalCode, MAX_METADATA_LENGTH),
    outcome,
    errorCode: error?.errorCode ?? null,
    errorMessage: error?.errorMessage ?? null,
  });
}

function emitDiagnostic(diagnostic, entry) {
  if (typeof diagnostic !== "function") return;
  try {
    diagnostic(entry);
  } catch {
    // Cleanup diagnostics must never replace the test result.
  }
}
