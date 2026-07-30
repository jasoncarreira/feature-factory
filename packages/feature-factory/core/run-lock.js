// Ported unchanged from src/run-state.js:120-485 (the run-json lock cluster).
// The 0c spike reused this lock as-is, which is why it is lifted rather than
// rewritten: hand-rolling lock reclaim and steal logic is where subtle crash bugs
// live. Only the imports and the extracted constants below are new.
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { writeProtectedJsonAtomic } from "./atomic-write.js";

const DEFAULT_LOCK_TIMEOUT_MS = 1000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const DEFAULT_STALE_LOCK_MS = 60000;
const DEFAULT_MISSING_OWNER_STEAL_MS = 5000;
const LOCK_DIR = "run-json.lock";
const LOCK_OWNER_FILE = "owner.json";

export class RunJsonLockContendedError extends Error {
  constructor(lockDir) {
    super(`run.json lock is contended at ${lockDir}`);
    this.name = "RunJsonLockContendedError";
    this.code = "RUN_JSON_LOCK_CONTENDED";
    this.lockDir = lockDir;
  }
}

export async function withRunJsonLock(runDir, fn, options = {}) {
  if (typeof fn !== "function") throw new Error("withRunJsonLock requires a callback");
  const reclaimMode = normalizeReclaimMode(options.reclaimMode);
  const lockHooks = validateRunJsonLockHooks(options.lockHooks);
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const retryDelayMs = normalizePositiveInteger(options.retryDelayMs, DEFAULT_LOCK_RETRY_DELAY_MS);
  normalizePositiveInteger(options.staleLockMs, DEFAULT_STALE_LOCK_MS);
  normalizePositiveInteger(options.missingOwnerStealMs, DEFAULT_MISSING_OWNER_STEAL_MS);
  const lockDir = join(runDir, LOCK_DIR);
  const ownerPath = join(lockDir, LOCK_OWNER_FILE);
  const deadline = Date.now() + timeoutMs;
  let stolenFrom = null;
  let stealAttempted = false;
  let createdIdentity = null;
  let owner = null;
  let ownerPublished = false;
  let publishedEvidence = null;

  while (true) {
    try {
      await mkdir(lockDir);
      createdIdentity = await lockDirectoryIdentity(lockDir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (reclaimMode === "never") throw new RunJsonLockContendedError(lockDir);
      if (!stealAttempted) {
        const observedIdentity = await lockDirectoryIdentity(lockDir);
        const observedEvidence = await readLockOwnerEvidence(ownerPath);
        if (canStealRunJsonLock(observedEvidence?.owner, options)) {
          stealAttempted = true;
          const reclaimed = await reclaimRunJsonLock(runDir, lockDir, observedIdentity, observedEvidence, options, lockHooks, deadline);
          if (reclaimed) {
            stolenFrom = reclaimed;
            continue;
          }
        } else if (!observedEvidence && await ownerlessLockIsReclaimable(lockDir, ownerPath, options)) {
          stealAttempted = true;
          if (await reclaimOwnerlessRunJsonLock(runDir, lockDir, observedIdentity, options, lockHooks, deadline)) continue;
        }
      }
      if (Date.now() >= deadline) {
        const observedOwner = await readLockOwner(ownerPath);
        throw new Error(formatLockTimeout(lockDir, observedOwner));
      }
      await delay(Math.min(retryDelayMs, Math.max(1, deadline - Date.now())));
    }
  }

  owner = { pid: process.pid, hostname: hostname(), acquired_at: new Date().toISOString(), nonce: randomUUID() };
  if (stolenFrom) owner.stolen_from = sanitizeLockOwner(stolenFrom);

  try {
    if (!sameLockDirectoryIdentity(createdIdentity, await lockDirectoryIdentity(lockDir))) {
      throw new Error(`run.json lock ownership changed before owner publication at ${lockDir}`);
    }
    await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    publishedEvidence = await readLockOwnerEvidence(ownerPath);
    if (!sameLockOwner(owner, publishedEvidence?.owner)) throw new Error(`run.json lock owner publication failed at ${lockDir}`);
    ownerPublished = true;
    return await fn({ lock_dir: lockDir, owner });
  } finally {
    if (ownerPublished) {
      await releaseOwnedRunJsonLock(runDir, lockDir, createdIdentity, publishedEvidence);
    } else if (!ownerPublished && !(await lockOwnerEntryExists(ownerPath))) {
      await quarantineAndRemoveOwnedLock(runDir, lockDir, createdIdentity);
    }
  }
}

function normalizeReclaimMode(value) {
  if (value === undefined || value === "dead-owner") return "dead-owner";
  if (value === "never") return value;
  throw new Error("reclaimMode must be dead-owner or never");
}

// One seam, not six. The ported lock carried a generic six-hook structure with
// per-hook validation and deadline-bounded invocation; only onBeforeSteal was ever
// used, and only by the test that proves a lock re-acquired inside the steal window is
// not taken. Generic extension points for callers who do not exist are how the
// predecessor reached 43,000 lines. This displacement funded the merge-proof and PR
// admission fixes instead of raising the ceiling.
function validateRunJsonLockHooks(lockHooks) {
  if (lockHooks === undefined) return {};
  if (!isRecord(lockHooks)) throw new Error("lockHooks must be an object");
  if (lockHooks.onBeforeSteal !== undefined && typeof lockHooks.onBeforeSteal !== "function") {
    throw new Error("lockHooks.onBeforeSteal must be a function");
  }
  return lockHooks;
}

function canStealRunJsonLock(owner, options = {}) {
  return isDurableLockOwner(owner) && inspectLockOwnerLiveness(owner, options) === "dead";
}

async function readLockOwnerEvidence(ownerPath) {
  let handle;
  try {
    handle = await open(ownerPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const parsed = JSON.parse(await handle.readFile("utf8"));
    if (!isDurableLockOwner(parsed)) return null;
    const value = await handle.stat();
    return { owner: parsed, identity: { dev: value.dev, ino: value.ino } };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function readLockOwner(ownerPath) {
  return (await readLockOwnerEvidence(ownerPath))?.owner ?? null;
}

async function reclaimRunJsonLock(runDir, lockDir, observedIdentity, observedEvidence, options, lockHooks, deadline) {
  if (!observedIdentity || !observedEvidence) return null;
  return stealByRename(runDir, lockDir, observedIdentity, observedEvidence.owner, lockHooks);
}

async function reclaimOwnerlessRunJsonLock(runDir, lockDir, observedIdentity, options, lockHooks, deadline) {
  if (!observedIdentity) return null;
  return stealByRename(runDir, lockDir, observedIdentity, null, lockHooks);
}

// Stealing a stale lock is one atomic rename.
//
// A nonce-keyed reclaim-claim protocol used to guard this, re-verifying a claim
// file four times across the steal. It was unnecessary: `rename` is atomic, so of
// two racers exactly one succeeds and the loser gets ENOENT and retries the
// acquire loop. More importantly the lock is not the correctness boundary - the
// write core re-reads run.json and deep-compares it immediately before its own
// rename, so even a wrongly stolen lock cannot produce a lost update. The
// ceremony was protecting the lock as though the lock were the invariant.
//
// The identity check still earns its place: it refuses to rename away a lock that
// is no longer the one we judged stale, which is the case where another process
// already stole and re-acquired.
async function stealByRename(runDir, lockDir, observedIdentity, observedOwner, lockHooks) {
  if (lockHooks.onBeforeSteal) await lockHooks.onBeforeSteal({ runDir, lockDir, owner: observedOwner });
  // No identity pre-check here on purpose. renameOwnedLockToQuarantine re-checks
  // dev/ino *after* the rename and throws, which covers the re-acquisition case
  // and is not subject to a check-then-act window. A pre-check was added here and
  // removed once falsification showed its removal was undetectable.
  let quarantine;
  try {
    quarantine = await renameOwnedLockToQuarantine(runDir, lockDir, observedIdentity);
  } catch (error) {
    // ENOENT means another racer got there first: fall back to the acquire loop.
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  await rm(quarantine, { recursive: true, force: true });
  return observedOwner ?? { pid: null, hostname: null, acquired_at: null, nonce: null };
}

async function releaseOwnedRunJsonLock(runDir, lockDir, expectedIdentity, expectedEvidence) {
  if (!sameLockDirectoryIdentity(expectedIdentity, await lockDirectoryIdentity(lockDir))) return;
  if (!sameLockOwnerEvidence(expectedEvidence, await readLockOwnerEvidence(join(lockDir, LOCK_OWNER_FILE)))) return;
  const quarantine = await renameOwnedLockToQuarantine(runDir, lockDir, expectedIdentity);
  if (!sameLockOwnerEvidence(expectedEvidence, await readLockOwnerEvidence(join(quarantine, LOCK_OWNER_FILE)))) {
    throw new Error(`run.json lock cleanup identity changed at ${quarantine}`);
  }
  if (!sameLockDirectoryIdentity(expectedIdentity, await lockDirectoryIdentity(quarantine))
    || !sameLockOwnerEvidence(expectedEvidence, await readLockOwnerEvidence(join(quarantine, LOCK_OWNER_FILE)))) return;
  await rm(quarantine, { recursive: true, force: true });
}

async function quarantineAndRemoveOwnedLock(runDir, lockDir, expectedIdentity) {
  if (!sameLockDirectoryIdentity(expectedIdentity, await lockDirectoryIdentity(lockDir))) return;
  const quarantine = await renameOwnedLockToQuarantine(runDir, lockDir, expectedIdentity);
  if (!sameLockDirectoryIdentity(expectedIdentity, await lockDirectoryIdentity(quarantine))) return;
  await rm(quarantine, { recursive: true, force: true });
}

async function renameOwnedLockToQuarantine(runDir, lockDir, expectedIdentity) {
  if (!sameLockDirectoryIdentity(expectedIdentity, await lockDirectoryIdentity(lockDir))) {
    throw new Error(`run.json lock directory identity changed at ${lockDir}`);
  }
  const quarantine = join(runDir, `.run-json.lock-quarantine-${randomUUID()}`);
  await rename(lockDir, quarantine);
  if (!sameLockDirectoryIdentity(expectedIdentity, await lockDirectoryIdentity(quarantine))) {
    throw new Error(`run.json lock quarantine identity changed at ${quarantine}`);
  }
  return quarantine;
}



// viso decides this with a timestamp: a lock whose heartbeat is older than the TTL
// may be stolen. We do the same on `acquired_at`, because this lock is held for one
// transition - a holder that has had it longer than the TTL is not working, it is
// gone. The alternative was 520 lines of process-identity probing to steal a dead
// owner's lock immediately rather than after the TTL, which is convenience rather
// than correctness for a single-operator tool. Pull it back if a real case appears.
function inspectLockOwnerLiveness(owner, options = {}) {
  if (!isDurableLockOwner(owner)) return "indeterminate";
  // A lock taken on another host cannot be adjudicated from here at all.
  if (owner.hostname !== hostname()) return "indeterminate";
  const staleAfterMs = normalizePositiveInteger(options.staleLockMs, DEFAULT_STALE_LOCK_MS);
  const heldForMs = Date.now() - Date.parse(owner.acquired_at);
  if (!Number.isFinite(heldForMs)) return "indeterminate";
  // A future `acquired_at` yields a negative age, which is never greater than the
  // TTL, so clock skew already fails closed here. An explicit `heldForMs < 0`
  // branch was removed after its falsification showed removing it changed nothing.
  return heldForMs > staleAfterMs ? "dead" : "alive";
}

async function lockOwnerEntryExists(ownerPath) {
  try {
    await lstat(ownerPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return true;
  }
}

function sanitizeLockOwner(owner) {
  if (!isRecord(owner)) return owner;
  return Object.fromEntries(Object.entries(owner).filter(([key]) => key !== "stolen_from" && key !== "nonce"));
}

function isDurableLockOwner(owner) {
  return isRecord(owner)
    && Number.isInteger(owner.pid)
    && owner.pid > 0
    && stringValue(owner.hostname)
    && Number.isFinite(Date.parse(owner.acquired_at || ""))
    && typeof owner.nonce === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(owner.nonce);
}

function sameLockOwner(left, right) {
  return isDurableLockOwner(left) && isDurableLockOwner(right) && left.nonce === right.nonce;
}

function sameLockOwnerEvidence(left, right) {
  return Boolean(left && right
    && sameLockOwner(left.owner, right.owner)
    && left.identity.dev === right.identity.dev
    && left.identity.ino === right.identity.ino);
}

async function lockDirectoryIdentity(lockDir) {
  try {
    const value = await lstat(lockDir);
    if (!value.isDirectory() || value.isSymbolicLink()) return null;
    return { dev: value.dev, ino: value.ino, mtimeMs: value.mtimeMs };
  } catch {
    return null;
  }
}

function sameLockDirectoryIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}


function normalizePositiveInteger(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error("lock timing options must be positive integers");
  return value;
}

// Small local helpers, lifted with the cluster.
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatLockTimeout(lockDir, owner) {
  if (!isRecord(owner)) return `timed out waiting for run.json lock at ${lockDir}`;
  const heldBy = [owner.hostname, owner.pid].filter((value) => value !== undefined && value !== null).join(":");
  const suffix = heldBy ? ` held by ${heldBy}` : "";
  const acquiredAt = stringValue(owner.acquired_at) ? ` since ${owner.acquired_at}` : "";
  return `timed out waiting for run.json lock at ${lockDir}${suffix}${acquiredAt}`;
}

// An ownerless lock is a directory with no valid owner record: a crash between the
// mkdir and publishing owner.json. It is only reclaimable after a grace window,
// because that gap is microseconds wide in the normal case and stealing inside it
// would take a lock from a process that is about to publish.
//
// This replaces a canReclaimOwnerlessRunJsonLock that was deleted during the reclaim
// simplification while its call site remained — a live ReferenceError on the
// ownerless path, found by opencode.
async function ownerlessLockIsReclaimable(lockDir, ownerPath, options = {}) {
  if (await lockOwnerEntryExists(ownerPath)) return false;
  const graceMs = normalizePositiveInteger(options.missingOwnerStealMs, DEFAULT_MISSING_OWNER_STEAL_MS);
  try {
    const observed = await stat(lockDir);
    const ageMs = Date.now() - observed.mtimeMs;
    return Number.isFinite(ageMs) && ageMs > graceMs;
  } catch {
    return false;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}
