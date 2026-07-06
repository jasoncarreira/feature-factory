import { readFile, rename, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pendingProtectedGate, validateHeartbeatState, validateRun } from "./validate.js";

export const TERMINAL_RUN_STATUSES = new Set(["completed", "blocked", "partial", "needs-human"]);

const ACTIVE_HEARTBEAT_STATUSES = new Set(["active", "running"]);

const DEFAULT_LOCK_TIMEOUT_MS = 1000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const LOCK_DIR = "run-json.lock";
const LOCK_OWNER_FILE = "owner.json";
const RUN_FILE = "run.json";
const HEARTBEAT_FILE = "heartbeat.json";

export async function withRunJsonLock(runDir, fn, options = {}) {
  if (typeof fn !== "function") throw new Error("withRunJsonLock requires a callback");
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const retryDelayMs = normalizePositiveInteger(options.retryDelayMs, DEFAULT_LOCK_RETRY_DELAY_MS);
  const lockDir = join(runDir, LOCK_DIR);
  const ownerPath = join(lockDir, LOCK_OWNER_FILE);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        const owner = await readJsonIfExists(ownerPath);
        throw new Error(formatLockTimeout(lockDir, owner));
      }
      await delay(Math.min(retryDelayMs, Math.max(1, deadline - Date.now())));
    }
  }

  const owner = {
    pid: process.pid,
    hostname: hostname(),
    acquired_at: new Date().toISOString(),
  };

  try {
    await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
    return await fn({ lock_dir: lockDir, owner });
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

export async function mutateRunJsonLocked(runDir, mutator, options = {}) {
  if (typeof mutator !== "function") throw new Error("mutateRunJsonLocked requires a mutator");

  return withRunJsonLock(
    runDir,
    async () => {
      const current = await readRunJson(runDir);
      const draft = cloneJson(current);
      let nextValue = await mutator(draft);
      if (nextValue === undefined) {
        if (sameJson(current, draft)) {
          return { updated: false, reason: "mutator-skip", status: current.status, run: current };
        }
        nextValue = draft;
      }

      const next = validateRun(nextValue);
      await writeJsonAtomically(join(runDir, RUN_FILE), next);
      return { updated: true, status: next.status, run: next };
    },
    options,
  );
}

export async function heartbeatOnce(runDir, { token, ownerPid, now } = {}, options = {}) {
  if (!stringValue(token)) throw new Error("heartbeatOnce requires a token");
  const heartbeatOwnerPid = normalizeHeartbeatOwnerPid(ownerPid);
  const heartbeatAt = normalizeTimestamp(now);

  return withRunJsonLock(
    runDir,
    async () => {
      const current = await readRunJson(runDir);
      if (TERMINAL_RUN_STATUSES.has(current.status)) {
        return { updated: false, reason: "terminal-status", status: current.status, run: current };
      }
      if (current.status !== "running") {
        return { updated: false, reason: "run-not-running", status: current.status, run: current };
      }

      const protectedGate = pendingProtectedGate(current);
      if (protectedGate) {
        return { updated: false, reason: "protected-gate-pending", gate: protectedGate, status: current.status, run: current };
      }

      const lease = await inspectHeartbeatLease(runDir, current.run_id, {
        token,
        ownerPid: heartbeatOwnerPid,
        now: heartbeatAt,
      });
      if (!lease.active) {
        return { updated: false, reason: lease.reason, gate: lease.gate || null, status: current.status, run: current };
      }

      const next = validateRun({ ...current, heartbeat_at: heartbeatAt });
      await writeJsonAtomically(join(runDir, RUN_FILE), next);
      return { updated: true, status: next.status, heartbeat_at: heartbeatAt, run: next };
    },
    options,
  );
}

async function readRunJson(runDir) {
  const run = await readJson(join(runDir, RUN_FILE));
  return validateRun(run);
}

async function inspectHeartbeatLease(runDir, runId, { token, ownerPid, now } = {}) {
  const heartbeatPath = join(runDir, HEARTBEAT_FILE);
  if (!existsSync(heartbeatPath)) return { active: false, reason: "missing-heartbeat-lease" };

  let lease;
  try {
    lease = validateHeartbeatState(await readJson(heartbeatPath));
  } catch {
    return { active: false, reason: "invalid-heartbeat-lease" };
  }

  if (lease.run_id !== runId) return { active: false, reason: "heartbeat-run-id-mismatch" };
  if (lease.token !== token) return { active: false, reason: "heartbeat-token-mismatch" };
  if (lease.pid !== ownerPid) return { active: false, reason: "heartbeat-owner-mismatch" };

  const statusState = inspectHeartbeatLeaseStatus(lease.status, lease);
  if (!statusState.active) return statusState;

  const deadlineAt = lease.deadline_at;
  if (!stringValue(deadlineAt)) return { active: false, reason: "invalid-heartbeat-lease" };

  const deadlineMs = Date.parse(deadlineAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(deadlineMs) || Number.isNaN(nowMs)) return { active: false, reason: "invalid-heartbeat-lease" };
  if (nowMs >= deadlineMs) return { active: false, reason: "heartbeat-lease-expired" };

  return { active: true, lease };
}

function inspectHeartbeatLeaseStatus(status, lease) {
  if (stringValue(lease.stopped_at) || status === "stopped") {
    return { active: false, reason: "heartbeat-lease-stopped" };
  }
  if (stringValue(lease.stop_requested_at) || status === "stopping") {
    return { active: false, reason: "heartbeat-lease-stopping" };
  }
  if (stringValue(lease.stop_reason) && ACTIVE_HEARTBEAT_STATUSES.has(status)) {
    return { active: false, reason: "invalid-heartbeat-lease" };
  }
  if (TERMINAL_RUN_STATUSES.has(status)) {
    return { active: false, reason: "heartbeat-lease-terminal" };
  }
  if (status === "inactive") {
    return { active: false, reason: "heartbeat-lease-inactive" };
  }
  if (!ACTIVE_HEARTBEAT_STATUSES.has(status)) {
    return { active: false, reason: "invalid-heartbeat-lease" };
  }
  return { active: true };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return await readJson(path);
  } catch {
    return null;
  }
}

async function writeJsonAtomically(path, value) {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } finally {
    if (existsSync(tempPath)) await rm(tempPath, { force: true });
  }
}

function formatLockTimeout(lockDir, owner) {
  if (!isRecord(owner)) return `timed out waiting for run.json lock at ${lockDir}`;
  const heldBy = [owner.hostname, owner.pid].filter((value) => value !== undefined && value !== null).join(":");
  const suffix = heldBy ? ` held by ${heldBy}` : "";
  const acquiredAt = stringValue(owner.acquired_at) ? ` since ${owner.acquired_at}` : "";
  return `timed out waiting for run.json lock at ${lockDir}${suffix}${acquiredAt}`;
}

function normalizeTimestamp(now) {
  if (now === undefined) return new Date().toISOString();
  const value = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(value)) throw new Error("invalid heartbeat timestamp");
  return new Date(value).toISOString();
}

function normalizePositiveInteger(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error("lock timing options must be positive integers");
  return value;
}

function normalizeHeartbeatOwnerPid(ownerPid) {
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) throw new Error("heartbeatOnce requires ownerPid");
  return ownerPid;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
