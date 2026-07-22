import { spawn as defaultSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  claimCheckedTestExecution,
  claimCheckedVerificationArtifactExecution,
  completeCheckedTestExecution,
  completeCheckedVerificationArtifactExecution,
  markCheckedVerificationArtifactExecutionUnknown,
  markCheckedTestExecutionUnknown,
} from "./run-state.js";
import { TEST_EXECUTION_STREAM_LIMIT_BYTES, validateTestExecutionReceipt, validateVerificationArtifactExecutionReceipt } from "./validate.js";

const COMMAND_TIMEOUT_MS = 300_000;
const PROCESS_CLOSE_TIMEOUT_MS = 10_000;
const ENV_ALLOWLIST = Object.freeze([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "CI", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC",
]);

export async function executeCheckedTestExecution(runDir, options = {}) {
  const env = checkedExecutionEnvironment(options.env ?? process.env);
  const claimed = await claimCheckedTestExecution(runDir, options);
  if (claimed.replayed) return claimed.result;
  const startedMs = nowMs(options);
  const startedAt = isoNow(options);
  const results = [];
  try {
    for (const [index, command] of claimed.authority.commands.entries()) {
      results.push(await executeCheckedCommand(command, index, claimed.authority.worktree, env, options));
    }
  } catch (error) {
    await markCheckedTestExecutionUnknown(runDir, claimed.claim, "process-outcome-indeterminate", options);
    throw executionError(
      "TEST_EXECUTION_OPERATOR_RECONCILIATION_REQUIRED",
      `checked test process outcome is indeterminate: ${error.message}; no supported factory command may clear, replace, terminalize, retry, or advance the claim; trusted out-of-band operator/process reconciliation is required`,
    );
  }
  const completedMs = nowMs(options);
  const completedAt = isoNow(options);
  const status = results.every((result) => result.outcome === "exited" && result.exit_code === 0 && result.signal === null) ? "pass" : "fail";
  const receipt = validateTestExecutionReceipt({
    schema_version: 1,
    kind: "checked-test-execution-receipt",
    subject: "test-verifier",
    run_id: claimed.claim.run_id,
    attempt: claimed.claim.attempt,
    claim_nonce: claimed.claim.nonce,
    plan_ref: claimed.claim.plan_ref,
    plan_hash: claimed.claim.plan_hash,
    head_sha: claimed.claim.head_sha,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: Math.max(0, completedMs - startedMs),
    status,
    review_ready: status === "pass",
    commands: results,
  });
  return completeCheckedTestExecution(runDir, claimed.claim, claimed.authority, receipt, options);
}

export async function executeCheckedVerificationArtifact(runDir, sliceId, artifactId, options = {}) {
  const claimed = await claimCheckedVerificationArtifactExecution(runDir, sliceId, artifactId, options);
  if (claimed.replayed) return claimed;
  if (typeof options.afterArtifactClaim === "function") await options.afterArtifactClaim({ claim: claimed.claim, authority: claimed.authority });
  const startedMs = nowMs(options);
  const startedAt = isoNow(options);
  const command = { program: claimed.authority.probe.program, args: claimed.authority.probe.args };
  let result;
  try {
    result = await executeCheckedCommand(command, 0, claimed.authority.worktree, checkedExecutionEnvironment(options.env ?? process.env), options);
    if (typeof options.afterArtifactProcess === "function") await options.afterArtifactProcess({ claim: claimed.claim, authority: claimed.authority, result });
  } catch (error) {
    await markCheckedVerificationArtifactExecutionUnknown(runDir, claimed.claim, claimed.authority, "process-outcome-indeterminate", options);
    throw executionError("VERIFICATION_ARTIFACT_OPERATOR_RECONCILIATION_REQUIRED", `checked verification artifact process outcome requires operator reconciliation: ${error.message}`);
  }
  const completedMs = nowMs(options);
  const completedAt = isoNow(options);
  const status = result.outcome === "exited" && result.exit_code === 0 && result.signal === null ? "pass" : "fail";
  const receipt = validateVerificationArtifactExecutionReceipt({
    schema_version: 1,
    kind: "checked-verification-artifact-execution-receipt",
    subject: claimed.authority.slice_id,
    run_id: claimed.authority.run_id,
    slice_id: claimed.authority.slice_id,
    attempt: claimed.authority.attempt,
    claim_nonce: claimed.claim.nonce,
    plan_ref: claimed.authority.plan_ref,
    plan_hash: claimed.authority.plan_hash,
    head_sha: claimed.authority.head_sha,
    verification_artifact_id: claimed.authority.verification_artifact_id,
    probe: claimed.authority.probe,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: Math.max(0, completedMs - startedMs),
    status,
    review_ready: status === "pass",
    commands: [result],
    result: {
      type: "verification-result",
      outcome: status,
      summary: status === "pass" ? "Verification artifact command passed" : "Verification artifact command failed",
    },
  });
  try {
    return await completeCheckedVerificationArtifactExecution(runDir, claimed.claim, claimed.authority, receipt, options);
  } catch (error) {
    try {
      await markCheckedVerificationArtifactExecutionUnknown(runDir, claimed.claim, claimed.authority, "receipt-publication-indeterminate", options);
    } catch (reconciliationError) {
      throw executionError("VERIFICATION_ARTIFACT_OPERATOR_RECONCILIATION_REQUIRED", `checked verification artifact receipt/claim completion requires operator reconciliation: ${error.message}; ${reconciliationError.message}`);
    }
    throw executionError("VERIFICATION_ARTIFACT_OPERATOR_RECONCILIATION_REQUIRED", `checked verification artifact receipt/claim completion requires operator reconciliation: ${error.message}`);
  }
}

export function checkedExecutionEnvironment(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw executionError("TEST_EXECUTION_ENV_INVALID", "checked test execution environment is invalid");
  if (typeof source.PATH !== "string" || source.PATH.length === 0) throw executionError("TEST_EXECUTION_PATH_REQUIRED", "checked test execution requires PATH");
  const env = {};
  for (const key of ENV_ALLOWLIST) if (typeof source[key] === "string") env[key] = source[key];
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export async function executeCheckedCommand(command, index, cwd, env, options = {}) {
  const started = nowMs(options);
  const stdout = streamCapture();
  const stderr = streamCapture();
  const spawnFn = typeof options.spawnFn === "function" ? options.spawnFn : defaultSpawn;
  let child;
  try {
    child = spawnFn(command.program, command.args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return commandResult(command, index, "launch-error", "fail", null, null, "spawn-failed", started, stdout, stderr, options);
  }
  if (!child || typeof child.once !== "function" || !child.stdout || !child.stderr) throw new Error("spawn returned no closable piped child process");

  return new Promise((resolve, reject) => {
    let settled = false;
    let killReason = null;
    let indeterminate = null;
    let timeout = null;
    let closeTimeout = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(closeTimeout);
      fn(value);
    };
    const kill = (reason, cause = null) => {
      if (killReason) return;
      killReason = reason;
      indeterminate = cause;
      closeTimeout = setTimeout(() => finish(reject, new Error("process did not close within 10 seconds after SIGKILL")), closeTimeoutMs(options));
      let sent;
      try { sent = child.kill("SIGKILL"); }
      catch (error) { finish(reject, new Error(`SIGKILL failed: ${error.message}`)); return; }
      if (sent !== true) { finish(reject, new Error("SIGKILL could not be delivered")); return; }
    };
    const onData = (capture, chunk) => {
      if (captureChunk(capture, chunk)) kill("output-limit");
    };
    child.stdout.on("data", (chunk) => onData(stdout, chunk));
    child.stderr.on("data", (chunk) => onData(stderr, chunk));
    child.stdout.once("error", (error) => kill("pipe-error", error));
    child.stderr.once("error", (error) => kill("pipe-error", error));
    child.once("error", () => {
      if (killReason) return;
      finish(resolve, commandResult(command, index, "launch-error", "fail", null, null, "spawn-failed", started, stdout, stderr, options));
    });
    child.once("close", (code, signal) => {
      if (indeterminate) { finish(reject, new Error(`process pipe outcome is indeterminate: ${indeterminate.message}`)); return; }
      if (killReason === "timeout" || killReason === "output-limit") {
        finish(resolve, commandResult(command, index, killReason, "fail", null, "SIGKILL", null, started, stdout, stderr, options));
        return;
      }
      if (typeof signal === "string" && signal.length > 0) {
        finish(resolve, commandResult(command, index, "signaled", "fail", null, signal, null, started, stdout, stderr, options));
        return;
      }
      if (Number.isInteger(code) && code >= 0 && code <= 255) {
        finish(resolve, commandResult(command, index, "exited", code === 0 ? "pass" : "fail", code, null, null, started, stdout, stderr, options));
        return;
      }
      finish(reject, new Error("process closed without a decided exit code or signal"));
    });
    timeout = setTimeout(() => kill("timeout"), commandTimeoutMs(options));
  });
}

function streamCapture() {
  return { bytes: 0, hash: createHash("sha256"), truncated: false };
}

function captureChunk(capture, value) {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const remaining = TEST_EXECUTION_STREAM_LIMIT_BYTES - capture.bytes;
  if (remaining > 0) {
    const prefix = chunk.subarray(0, remaining);
    capture.hash.update(prefix);
    capture.bytes += prefix.length;
  }
  if (chunk.length > remaining) capture.truncated = true;
  return capture.truncated;
}

function commandResult(command, index, outcome, status, exitCode, signal, errorCode, started, stdout, stderr, options) {
  return {
    index,
    program: command.program,
    args: [...command.args],
    outcome,
    status,
    exit_code: exitCode,
    signal,
    error_code: errorCode,
    duration_ms: Math.max(0, nowMs(options) - started),
    stdout: finalizeStream(stdout),
    stderr: finalizeStream(stderr),
  };
}

function finalizeStream(capture) {
  return { captured_bytes: capture.bytes, sha256: `sha256:${capture.hash.digest("hex")}`, truncated: capture.truncated };
}

function commandTimeoutMs(options) {
  return Number.isInteger(options.commandTimeoutMs) && options.commandTimeoutMs > 0 ? options.commandTimeoutMs : COMMAND_TIMEOUT_MS;
}

function closeTimeoutMs(options) {
  return Number.isInteger(options.closeTimeoutMs) && options.closeTimeoutMs > 0 ? options.closeTimeoutMs : PROCESS_CLOSE_TIMEOUT_MS;
}

function nowMs(options) {
  const value = typeof options.nowMs === "function" ? options.nowMs() : Date.now();
  if (!Number.isFinite(value)) throw new Error("checked test execution clock is invalid");
  return Math.trunc(value);
}

function isoNow(options) {
  const value = typeof options.isoNow === "function" ? options.isoNow() : new Date().toISOString();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("checked test execution timestamp is invalid");
  return value;
}

function executionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
