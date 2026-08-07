// factory.lock retains the predecessor's session-lock record shape:
//   { session, run_id, branch, claimed_at, heartbeat_at }
// Unlike the brief run-json transition lock, this answers which session owns the
// whole run and enables resume, steal, or abort. A fresh heartbeat means another
// session is working; one older than the TTL may be stolen.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeProtectedJsonAtomic } from "../core/atomic-write.js";
import { rm } from "node:fs/promises";

export const SESSION_LOCK_FILE = "factory.lock";
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
// `pid` is no longer written, but stays listed so locks written before it was dropped
// still validate. Removing it would make every pre-existing lock fail the unknown-key
// check below, read as absent, and let a second session claim a run that is still being
// worked -- the dangerous direction. Why it was dropped, from #194: the recorded pid was
// the CLI or the transient shell that invoked it, never the run's owner, so it could not
// answer the liveness question its presence implied.
export const SESSION_LOCK_KEYS = Object.freeze([
  "session", "pid", "run_id", "branch", "claimed_at", "heartbeat_at",
]);

export class SessionLockHeldError extends Error {
  constructor(owner) {
    super(`run '${owner.run_id}' is held by session ${owner.session} (heartbeat ${owner.heartbeat_at})`);
    this.name = "SessionLockHeldError";
    this.owner = owner;
  }
}

export function readSessionLock(runDir) {
  try {
    const value = JSON.parse(readFileSync(join(runDir, SESSION_LOCK_FILE), "utf8"));
    return isValidLock(value) ? value : null;
  } catch {
    return null;
  }
}

// "fresh" | "stale" | "absent". The caller routes on this; it is the only
// question the lock answers.
export function inspectSessionLock(runDir, { now = Date.now(), ttlMs = DEFAULT_SESSION_TTL_MS } = {}) {
  const owner = readSessionLock(runDir);
  if (!owner) return { state: "absent", owner: null };
  const ageMs = now - Date.parse(owner.heartbeat_at);
  // A future heartbeat is not evidence of staleness, so it counts as fresh.
  if (!Number.isFinite(ageMs) || ageMs <= ttlMs) return { state: "fresh", owner };
  return { state: "stale", owner };
}

export async function claimSessionLock(runDir, { session, runId, branch, now, ttlMs, force = false } = {}) {
  if (!session) throw new Error("factory lock requires a session id");
  const at = new Date(now ?? Date.now()).toISOString();
  const observed = inspectSessionLock(runDir, { now: now ?? Date.now(), ttlMs });
  if (observed.state === "fresh" && observed.owner.session !== session && !force) {
    throw new SessionLockHeldError(observed.owner);
  }
  const owner = {
    session,
    run_id: runId,
    branch: branch ?? null,
    // Re-claiming your own lock preserves when you first took it.
    claimed_at: observed.owner?.session === session ? observed.owner.claimed_at : at,
    heartbeat_at: at,
  };
  await writeProtectedJsonAtomic(runDir, SESSION_LOCK_FILE, owner);
  return { ...owner, stolen_from: observed.state === "stale" || force ? observed.owner : null };
}

export async function refreshSessionLock(runDir, { session, now } = {}) {
  const owner = readSessionLock(runDir);
  if (!owner) throw new Error("no factory.lock to refresh");
  // Refreshing someone else's lock would silently extend a run you do not own.
  if (session && owner.session !== session) throw new SessionLockHeldError(owner);
  const next = { ...owner, heartbeat_at: new Date(now ?? Date.now()).toISOString() };
  await writeProtectedJsonAtomic(runDir, SESSION_LOCK_FILE, next);
  return next;
}

export async function releaseSessionLock(runDir, { session } = {}) {
  const owner = readSessionLock(runDir);
  if (!owner) return { released: false, reason: "absent" };
  if (session && owner.session !== session) throw new SessionLockHeldError(owner);
  await rm(join(runDir, SESSION_LOCK_FILE), { force: true });
  return { released: true, reason: null };
}

function isValidLock(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).every((key) => SESSION_LOCK_KEYS.includes(key))
    && typeof value.session === "string" && value.session.trim().length > 0
    && typeof value.run_id === "string" && value.run_id.trim().length > 0
    && Number.isFinite(Date.parse(value.claimed_at || ""))
    && Number.isFinite(Date.parse(value.heartbeat_at || ""));
}
