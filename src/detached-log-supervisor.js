import { appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createSanitizedLineWriter } from "./hardening/line-output.js";
import { renderErrorForTerminal } from "./hardening/output-policy.js";
import { inspectProcessIdentity, readProcessEvidence, recordDetachedProcessEvidence, writeProcessEvidence } from "./process-evidence.js";
import { stopHeartbeatInRunDir } from "./factory.js";
import { timestamp } from "./utils.js";

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
    throw new Error(renderErrorForTerminal(error));
  };

  try {
    await append(init.log, Buffer.alloc(0));
    child = spawnProcess("opencode", init.commandArgs, {
      cwd: init.repo,
      detached: true,
      env: init.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;
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
        pid: child.pid,
        cwd: init.repo,
        commandName: "opencode",
        logRef: init.logRef,
        now: init.now,
        inspectorFn: () => stableIdentity,
      });
    }

    send({ type: "ready", pid: child.pid });
    const close = waitForClose(child);
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
  const inspect = typeof options.inspectorFn === "function" ? options.inspectorFn : inspectProcessIdentity;
  const sleep = typeof options.sleepFn === "function" ? options.sleepFn : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const deadline = clock() + IDENTITY_SETTLE_TIMEOUT_MS;
  let previous = null;
  while (clock() <= deadline) {
    const observed = inspect(pid);
    const commandName = typeof observed?.command_name === "string" ? observed.command_name.trim() : "";
    if (observed?.ok === true && commandName && commandName.toLowerCase() !== "env") {
      const fingerprint = JSON.stringify([observed.inspector, observed.pid, observed.start_marker, commandName, observed.cwd]);
      if (fingerprint === previous) return observed;
      previous = fingerprint;
    } else {
      previous = null;
    }
    await sleep(IDENTITY_SETTLE_INTERVAL_MS);
  }
  throw new Error("detached child identity did not stabilize before readiness");
}

function validateInit(init) {
  if (!init || typeof init !== "object") throw new Error("invalid detached supervisor init");
  if (typeof init.repo !== "string" || !Array.isArray(init.commandArgs) || typeof init.log !== "string") {
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
      try { sendIpc({ type: "error", error: renderErrorForTerminal(error) }); } catch { /* launcher disconnected */ }
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
