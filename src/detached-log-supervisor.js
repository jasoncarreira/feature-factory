import { appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createSanitizedLineWriter } from "./hardening/line-output.js";
import { renderErrorForTerminal } from "./hardening/output-policy.js";
import { inspectProcessIdentity } from "./hardening/process-verification.js";
import { readProcessEvidence, recordDetachedProcessEvidence, writeProcessEvidence } from "./process-evidence.js";
import { FACTORY_LAUNCH_CLAIM_ENV, stopHeartbeatInRunDir } from "./factory.js";
import { timestamp } from "./utils.js";
import { revalidateRuntimeLaunchBinding } from "./runtime-identity.js";

const ABORT_GRACE_MS = 1000;
const IDENTITY_SETTLE_TIMEOUT_MS = 5000;
const IDENTITY_SETTLE_INTERVAL_MS = 25;
let activeChild = null;

export async function superviseDetachedLaunch(init, options = {}) {
  validateInit(init);
  const spawnProcess = typeof options.spawnFn === "function" ? options.spawnFn : spawn;
  const send = typeof options.send === "function" ? options.send : sendIpc;
  const append = typeof options.appendFileFn === "function" ? options.appendFileFn : appendFile;
  let child;
  let writer;
  let failedClosed = false;
  let heartbeatCleanupAttempted = false;

  const cleanupHeartbeat = async () => {
    if (!init.recordEvidence || heartbeatCleanupAttempted) return;
    heartbeatCleanupAttempted = true;
    const stopHeartbeat = typeof options.stopHeartbeatFn === "function" ? options.stopHeartbeatFn : stopHeartbeatInRunDir;
    await stopHeartbeat(init.runDir, options);
  };

  const failClosed = async (error) => {
    if (failedClosed) return;
    failedClosed = true;
    terminateChild(child);
    try { await cleanupHeartbeat(); } catch { /* the failed-closed evidence preserves ambiguous ownership */ }
    await markMatchingEvidence(init, child?.pid, "failed-closed", options);
    const failure = new Error(renderErrorForTerminal(error));
    failure.code = error?.code;
    throw failure;
  };

  try {
    await append(init.log, Buffer.alloc(0));
    const executable = (options.runtimeRevalidateFn || revalidateRuntimeLaunchBinding)(init.runtimeBinding, { cwd: init.repo, env: init.env });
    child = spawnProcess(executable, init.commandArgs, {
      cwd: init.repo,
      detached: true,
      env: init.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    activeChild = child;
    // Register the close listener before any awaited work. `close` is emitted
    // once, and a short-lived child can emit it while we are awaiting spawn or
    // identity settling — a `once` handler attached afterwards never sees that
    // past event, leaving the supervisor promise pending forever. Nothing
    // consumes the rejection until the await below, so mark it handled here to
    // keep an early spawn error from surfacing as an unhandled rejection while
    // still rejecting for the real awaiter.
    const close = waitForClose(child);
    close.catch(() => {});
    await waitForSpawn(child);
    send({ type: "spawned", pid: child.pid });

    writer = createSanitizedLineWriter({
      write: (_stream, buffer) => append(init.log, buffer).catch(async (error) => {
        terminateChild(child);
        await markMatchingEvidence(init, child?.pid, "failed-closed", options);
        throw error;
      }),
    });
    child.stdout.pipe(writer.stdout);
    child.stderr.pipe(writer.stderr);

    if (init.recordEvidence) {
      const stableIdentity = await waitForStableProcessIdentity(child.pid, options);
      recordDetachedProcessEvidence(init.runDir, {
        runId: init.runId,
        executionId: init.executionId,
        launchToken: init.env?.[FACTORY_LAUNCH_CLAIM_ENV],
        pid: child.pid,
        cwd: init.repo,
        commandName: "opencode",
        logRef: init.logRef,
        now: init.now,
        expectedIdentity: stableIdentity.identity,
        ...processInspectionOptions(options),
      });
    }

    send({ type: "ready", pid: child.pid });
    try {
      await Promise.all([close, writer.finished()]);
    } catch (error) {
      await failClosed(error);
    }
    await cleanupHeartbeat();
    await markMatchingEvidence(init, child.pid, "exited", options);
    activeChild = null;
    return { pid: child.pid, status: "exited" };
  } catch (error) {
    if (child && !failedClosed) {
      try { await failClosed(error); } catch (safeError) { throw safeError; }
    }
    throw new Error(renderErrorForTerminal(error));
  }
}

async function waitForStableProcessIdentity(pid, options = {}) {
  const sleep = typeof options.sleep === "function" ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const deadline = clock() + IDENTITY_SETTLE_TIMEOUT_MS;
  let previous = null;
  while (clock() <= deadline) {
    const observed = inspectProcessIdentity(pid, processInspectionOptions(options));
    const identity = observed.status === "live" ? observed.identity : null;
    const commandName = typeof identity?.command_name === "string" ? identity.command_name.trim() : "";
    if (identity && commandName && commandName.toLowerCase() !== "env") {
      const fingerprint = JSON.stringify([identity.inspector, identity.pid, identity.start_marker, commandName, identity.cwd]);
      if (fingerprint === previous) return observed;
      previous = fingerprint;
    } else {
      previous = null;
    }
    await sleep(IDENTITY_SETTLE_INTERVAL_MS);
  }
  throw new Error("detached child identity did not stabilize before readiness");
}

function processInspectionOptions(options) {
  const keys = [
    "platform",
    "hostname",
    "livenessProbe",
    "procReadFile",
    "procReadlink",
    "commandRunner",
    "commandTimeoutMs",
    "commandMaxBuffer",
  ];
  return Object.fromEntries(keys.filter((key) => options[key] !== undefined).map((key) => [key, options[key]]));
}

function validateInit(init) {
  if (!init || typeof init !== "object") throw new Error("invalid detached supervisor init");
  if (typeof init.repo !== "string" || !Array.isArray(init.commandArgs) || typeof init.log !== "string" || !init.runtimeBinding) {
    throw new Error("invalid detached supervisor init");
  }
  if (init.recordEvidence && (!init.runDir || !init.runId || !init.executionId || !init.logRef)) {
    throw new Error("invalid detached supervisor evidence init");
  }
}

function waitForSpawn(child) {
  if (Number.isInteger(child?.pid) && child.pid > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function waitForClose(child) {
  // Mirror `waitForSpawn`'s already-settled fast path: a child handed to us
  // after it exited will never emit another `close`, so read the terminal state
  // directly instead of waiting for an event that cannot arrive.
  if (child?.exitCode !== null && child?.exitCode !== undefined) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode ?? null });
  }
  if (child?.signalCode !== null && child?.signalCode !== undefined) {
    return Promise.resolve({ code: child.exitCode ?? null, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function terminateChild(child) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) return;
  try { child.kill("SIGTERM"); } catch { return; }
  const timer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }, ABORT_GRACE_MS);
  timer.unref?.();
}

async function markMatchingEvidence(init, pid, state, options = {}) {
  if (!init.recordEvidence || !Number.isInteger(pid)) return false;
  const readEvidence = typeof options.readProcessEvidenceFn === "function" ? options.readProcessEvidenceFn : readProcessEvidence;
  const writeEvidence = typeof options.writeProcessEvidenceFn === "function" ? options.writeProcessEvidenceFn : writeProcessEvidence;
  const current = readEvidence(init.runDir, { runId: init.runId });
  if (!current.ok || current.evidence.execution_id !== init.executionId || current.evidence.pid !== pid || current.evidence.state !== "running") return false;
  writeEvidence(init.runDir, {
    ...current.evidence,
    state,
    updated_at: timestamp(options.now),
  });
  return true;
}

function sendIpc(message) {
  if (typeof process.send !== "function" || !process.connected) throw new Error("detached supervisor IPC is unavailable");
  process.send(message);
}

if (typeof process.send === "function") {
  let started = false;
  process.once("message", async (message) => {
    if (message?.type !== "init" || started) return;
    started = true;
    try {
      await superviseDetachedLaunch(message);
      process.disconnect?.();
    } catch (error) {
      try { sendIpc({ type: "error", error: renderErrorForTerminal(error), code: error?.code }); } catch { /* launcher disconnected */ }
      process.exitCode = 1;
      process.disconnect?.();
    }
  });
  process.on("message", (message) => {
    if (message?.type === "abort") {
      terminateChild(activeChild);
      process.exitCode = 1;
    }
  });
}
