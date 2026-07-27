import { closeSync, constants as FS_CONSTANTS, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { timestamp } from "./utils.js";
import { writeProtectedJsonAtomicSync } from "./hardening/atomic-write.js";
import {
  PROCESS_INSPECTOR,
  inspectProcessIdentity as inspectVerifiedProcessIdentity,
  signalVerifiedProcess,
  verifyProcessIdentity,
} from "./hardening/process-verification.js";

export const PROCESS_EVIDENCE_FILE = "process.json";
export const PROCESS_EVIDENCE_KIND = "opencode-process";
export const PROCESS_EVIDENCE_SCHEMA_VERSION = 1;
export const PROCESS_EVIDENCE_SIGNAL = "SIGTERM";
export const LAUNCH_CLAIM_DIR = "process-launch.lock";
export const LAUNCH_CLAIM_FILE = "owner.json";
export const LAUNCH_CLAIM_REF = `${LAUNCH_CLAIM_DIR}/${LAUNCH_CLAIM_FILE}`;
export const LAUNCH_CLAIM_KIND = "opencode-launch-claim";
export const LAUNCH_CLAIM_SCHEMA_VERSION = 1;
export const LAUNCH_FENCE_KIND = "opencode-launch-fence";
export const BASE_ADVANCE_LAUNCH_FENCE_OWNER_KIND = "base-advance";
export const LAUNCH_CLAIM_PHASES = Object.freeze(["foreground-live", "predecessor-active", "predecessor-released", "spawning"]);
export const LAUNCH_KINDS = Object.freeze(["approval-handoff", "resume-foreground", "resume-detached", "start-resume-foreground", "start-resume-detached"]);

const PROCESS_STATES = new Set(["running", "cancelled", "failed-closed", "exited"]);
const DEFAULT_INSPECTOR = PROCESS_INSPECTOR;
const DEFAULT_CANCEL_WAIT_MS = 5000;
const CANCEL_POLL_INTERVAL_MS = 200;
const LAUNCH_PHASE_SET = new Set(LAUNCH_CLAIM_PHASES);
const LAUNCH_KIND_SET = new Set(LAUNCH_KINDS);

export function processEvidencePath(runDir) {
  return join(resolve(runDir), PROCESS_EVIDENCE_FILE);
}

export function processEvidenceProcessesDir(runDir) {
  return join(resolve(runDir), "processes");
}

export function launchClaimPath(runDir) {
  return join(resolve(runDir), LAUNCH_CLAIM_DIR, LAUNCH_CLAIM_FILE);
}

/**
 * Inspect a transient launch claim without following either claim entry. Claims
 * are deliberately never reclaimed here: an invalid or unprovable owner is
 * durable evidence for manual reconciliation, not permission to relaunch.
 */
export function inspectLaunchClaim(runDir, opts = {}) {
  const root = resolve(runDir);
  const dir = join(root, LAUNCH_CLAIM_DIR);
  const file = join(dir, LAUNCH_CLAIM_FILE);
  let rootStat;
  let dirStat;
  try {
    rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return invalidLaunchClaim(file, "run directory must be a non-symlink directory");
    dirStat = lstatSync(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, missing: true, reason: "missing launch claim", path: file, claim: null, owner_status: "absent", identity: null, hash: null };
    return invalidLaunchClaim(file, `launch claim directory is inaccessible: ${error.message}`);
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return invalidLaunchClaim(file, "launch claim directory must be a non-symlink directory", claimIdentity(dirStat));
  opts.onLaunchClaimDirectoryInspected?.({ root, dir, file, identity: claimIdentity(dirStat) });

  let fd;
  let fileStat;
  let hash = null;
  try {
    fd = openSync(file, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW || 0));
    fileStat = fstatSync(fd);
    if (!fileStat.isFile()) return invalidLaunchClaim(file, "launch claim owner must be a regular file", claimIdentity(dirStat, fileStat));
    const bytes = readFileSync(fd);
    hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    assertStableClaimPath(root, dir, file, rootStat, dirStat, fileStat);
    const claim = JSON.parse(bytes.toString("utf8"));
    const validation = validateLaunchClaim(claim, { ...opts, runDir: root });
    if (!validation.ok) return { ...validation, missing: false, path: file, owner_status: "invalid", identity: claimIdentity(dirStat, fileStat), hash };
    const ownerStatus = inspectClaimOwner(validation.claim, opts);
    assertStableClaimPath(root, dir, file, rootStat, dirStat, fileStat);
    return {
      ok: true,
      missing: false,
      reason: null,
      path: file,
      claim: validation.claim,
      owner_status: ownerStatus,
      identity: claimIdentity(dirStat, fileStat),
      hash,
    };
  } catch (error) {
    if (error?.code === "LAUNCH_CLAIM_CHANGED") return invalidLaunchClaim(file, "launch claim identity changed during inspection");
    if (error?.code === "ENOENT") return invalidLaunchClaim(file, "launch claim directory is ownerless", claimIdentity(dirStat));
    return invalidLaunchClaim(file, `invalid launch claim: ${error.message}`, claimIdentity(dirStat, fileStat), hash);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function validateLaunchClaim(claim, opts = {}) {
  const errors = [];
  if (!plainObject(claim)) return invalidClaim("launch claim must be a JSON object");
  if (claim.schema_version !== LAUNCH_CLAIM_SCHEMA_VERSION) errors.push("schema_version must be 1");
  if (claim.kind !== LAUNCH_CLAIM_KIND) errors.push("kind must be opencode-launch-claim");
  if (!nonEmptyString(claim.run_id)) errors.push("run_id must be a non-empty string");
  if (nonEmptyString(opts.runId) && claim.run_id !== opts.runId) errors.push("run_id must match requested run");
  if (!nonEmptyString(claim.execution_id)) errors.push("execution_id must be a non-empty string");
  if (!LAUNCH_KIND_SET.has(claim.launch_kind)) errors.push("launch_kind is invalid");
  if (!LAUNCH_PHASE_SET.has(claim.phase)) errors.push("phase is invalid");
  if (!positivePid(claim.pid)) errors.push("pid must be a positive integer");
  if (!nonEmptyString(claim.hostname)) errors.push("hostname must be a non-empty string");
  if (!validTimestamp(claim.acquired_at)) errors.push("acquired_at must be an ISO timestamp");
  if (!plainObject(claim.identity)) errors.push("identity must be an object");
  else {
    for (const field of ["inspector", "start_marker", "command_name", "cwd"]) if (!nonEmptyString(claim.identity[field])) errors.push(`identity.${field} must be a non-empty string`);
    if (nonEmptyString(claim.identity?.cwd) && !isAbsolute(claim.identity.cwd)) errors.push("identity.cwd must be absolute");
  }
  if (!(claim.approval === null || plainObject(claim.approval))) errors.push("approval must be null or an object");
  if (!nonEmptyString(claim.nonce) || !/^[A-Za-z0-9_-]{16,128}$/u.test(claim.nonce)) errors.push("nonce must be an opaque safe token");
  if (errors.length) return invalidClaim(`invalid launch claim: ${errors.join("; ")}`);
  return { ok: true, reason: null, claim };
}

export function acquireLaunchClaim(runDir, input = {}, opts = {}) {
  const root = resolve(runDir);
  const fence = acquireLaunchFence(root, "launch", opts);
  if (!fence.acquired) {
    return { acquired: false, ok: false, missing: false, reason: "launch fence is held", path: launchClaimPath(root), claim: null, owner_status: "indeterminate", identity: null, hash: null, launch_fence_ref: fence.path };
  }
  try {
    return acquireLaunchClaimFenced(root, input, opts);
  } finally {
    if (!releaseLaunchFence(fence)) throw new Error("launch fence release failed");
  }
}

function acquireLaunchClaimFenced(root, input = {}, opts = {}) {
  const dir = join(root, LAUNCH_CLAIM_DIR);
  const file = join(dir, LAUNCH_CLAIM_FILE);
  assertContainedLaunchPath(root, dir);
  const existing = inspectLaunchClaim(root, { ...opts, runId: input.runId });
  if (!existing.missing) return { acquired: false, ...existing };
  const pid = positivePid(input.pid) ? input.pid : process.pid;
  const cwd = resolve(input.cwd || process.cwd());
  const inspected = inspectProcessForEvidence(pid, opts);
  const verified = requireVerifiedProcessIdentity(inspected, cwd);
  const claim = {
    schema_version: LAUNCH_CLAIM_SCHEMA_VERSION,
    kind: LAUNCH_CLAIM_KIND,
    run_id: input.runId,
    execution_id: input.executionId || randomUUID(),
    launch_kind: input.launchKind,
    phase: input.phase || "foreground-live",
    pid,
    hostname: input.hostname || hostname(),
    acquired_at: timestamp(input.now),
    identity: {
      inspector: stringOrDefault(inspected.inspector, DEFAULT_INSPECTOR),
      start_marker: verified.startMarker,
      command_name: verified.commandName,
      cwd,
    },
    approval: input.approval ?? null,
    nonce: input.nonce || randomUUID(),
  };
  const validation = validateLaunchClaim(claim, { runId: input.runId });
  if (!validation.ok) throw new Error(validation.reason);
  try {
    mkdirSync(dir);
    const dirStat = lstatSync(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error("launch claim directory identity is invalid");
    writeFileSync(file, `${JSON.stringify(claim, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") return { acquired: false, ...inspectLaunchClaim(root, { ...opts, runId: input.runId }) };
    try {
      if (!existsSync(file)) rmSync(dir, { force: true });
    } catch { /* preserve unexpected evidence */ }
    throw error;
  }
  const observed = inspectLaunchClaim(root, { ...opts, runId: input.runId });
  if (!observed.ok || observed.claim.nonce !== claim.nonce) throw new Error("launch claim publication could not be verified");
  return { acquired: true, ...observed, token: claim.nonce };
}

export function acquireLaunchFence(runDir, ownerKind, opts = {}) {
  if (!["launch", "cleanup", BASE_ADVANCE_LAUNCH_FENCE_OWNER_KIND].includes(ownerKind)) throw new Error("launch fence owner kind is invalid");
  const requestedRoot = resolve(runDir);
  const runStat = lstatSync(requestedRoot);
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) throw new Error("run directory must be a non-symlink directory");
  const root = realpathSync(requestedRoot);
  const physicalRunStat = lstatSync(root);
  if (!sameIdentity(physicalRunStat, runStat) || !physicalRunStat.isDirectory() || physicalRunStat.isSymbolicLink()) {
    throw new Error("launch fence run directory identity changed");
  }
  const namespace = resolveLaunchFenceNamespace(root, opts);
  const fenceRoot = ensureLaunchFenceRoot(requestedRoot, root, runStat, namespace);
  const key = createHash("sha256").update(root, "utf8").digest("hex");
  const path = join(fenceRoot.path, key);
  const ownerPath = join(path, "owner.json");
  const nonce = opts.launchFenceNonce || randomUUID();
  opts.onLaunchFenceReadyToAcquire?.({ requestedRoot, root, fenceRoot: fenceRoot.path, path, identity: claimIdentity(runStat) });
  if (!createLaunchFenceDirectory(path)) {
    if (!reclaimDeadBaseAdvanceLaunchFence(path, key, opts) || !createLaunchFenceDirectory(path)) {
      return { acquired: false, path, owner_kind: ownerKind };
    }
  }
  const dirStat = lstatSync(path);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error("launch fence directory identity is invalid");
  let owner;
  let ownerStat;
  try {
    const baseAdvanceIdentity = ownerKind === BASE_ADVANCE_LAUNCH_FENCE_OWNER_KIND
      ? currentLaunchFenceProcessIdentity(opts)
      : null;
    owner = {
      schema_version: 1,
      kind: LAUNCH_FENCE_KIND,
      run_path_hash: `sha256:${key}`,
      owner_kind: ownerKind,
      nonce,
      pid: process.pid,
      hostname: opts.hostname || hostname(),
      acquired_at: timestamp(opts.now),
    };
    if (baseAdvanceIdentity) owner.identity = baseAdvanceIdentity;
    assertLaunchFenceRunIdentity(requestedRoot, root, runStat);
    assertLaunchFenceNamespace(fenceRoot);
    const writeOwner = opts.writeLaunchFenceOwner || writeFileSync;
    writeOwner(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const inspectOwner = opts.inspectLaunchFenceOwner || lstatSync;
    ownerStat = inspectOwner(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) throw new Error("launch fence owner identity is invalid");
    assertLaunchFenceNamespace(fenceRoot);
  } catch (error) {
    removeFailedLaunchFence(path, dirStat, nonce);
    throw error;
  }
  return { acquired: true, path, owner_path: ownerPath, owner_kind: ownerKind, nonce, identity: claimIdentity(dirStat, ownerStat) };
}

function createLaunchFenceDirectory(path) {
  try {
    mkdirSync(path, { mode: 0o700 });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

function currentLaunchFenceProcessIdentity(opts) {
  const inspected = inspectVerifiedProcessIdentity(process.pid, opts);
  if (inspected.status !== "live" || !plainObject(inspected.identity)) {
    throw new Error("base-advance launch fence requires verifiable live process identity");
  }
  const identity = inspected.identity;
  if (identity.pid !== process.pid
    || identity.inspector !== PROCESS_INSPECTOR
    || !nonEmptyString(identity.start_marker)
    || !nonEmptyString(identity.command_name)
    || !nonEmptyString(identity.cwd)
    || !isAbsolute(identity.cwd)) {
    throw new Error("base-advance launch fence process identity is invalid");
  }
  return {
    inspector: identity.inspector,
    start_marker: identity.start_marker,
    command_name: identity.command_name,
    cwd: resolve(identity.cwd),
  };
}

function reclaimDeadBaseAdvanceLaunchFence(path, runPathKey, opts) {
  const observed = inspectBaseAdvanceLaunchFence(path, runPathKey);
  if (!observed || inspectBaseAdvanceFenceOwner(observed.owner, opts) !== "dead") return false;

  const confirmed = inspectBaseAdvanceLaunchFence(path, runPathKey);
  if (!sameBaseAdvanceFenceEvidence(observed, confirmed)
    || inspectBaseAdvanceFenceOwner(confirmed.owner, opts) !== "dead") return false;

  const quarantine = join(dirnameForClaimDir(path), `.${basename(path)}.quarantine-${randomUUID()}`);
  try {
    renameSync(path, quarantine);
  } catch {
    return false;
  }

  const moved = inspectBaseAdvanceLaunchFence(quarantine, runPathKey);
  if (!sameBaseAdvanceFenceEvidence(observed, moved)
    || inspectBaseAdvanceFenceOwner(moved.owner, opts) !== "dead") {
    restoreContendedLaunchFence(path, quarantine, observed);
    return false;
  }

  const finalEvidence = inspectBaseAdvanceLaunchFence(quarantine, runPathKey);
  if (!sameBaseAdvanceFenceEvidence(observed, finalEvidence)
    || inspectBaseAdvanceFenceOwner(finalEvidence.owner, opts) !== "dead") {
    restoreContendedLaunchFence(path, quarantine, observed);
    return false;
  }
  rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function inspectBaseAdvanceLaunchFence(path, runPathKey) {
  const ownerPath = join(path, "owner.json");
  let descriptor;
  try {
    const dirStat = lstatSync(path);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
    descriptor = openSync(ownerPath, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW || 0));
    const fileStat = fstatSync(descriptor);
    if (!fileStat.isFile()) return null;
    const bytes = readFileSync(descriptor);
    const owner = JSON.parse(bytes.toString("utf8"));
    if (!validBaseAdvanceLaunchFenceOwner(owner, runPathKey)) return null;
    const currentDir = lstatSync(path);
    const currentFile = lstatSync(ownerPath);
    if (!sameIdentity(currentDir, dirStat) || currentDir.isSymbolicLink() || !currentDir.isDirectory()
      || !sameIdentity(currentFile, fileStat) || currentFile.isSymbolicLink() || !currentFile.isFile()) return null;
    return {
      owner,
      identity: claimIdentity(dirStat, fileStat),
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validBaseAdvanceLaunchFenceOwner(owner, runPathKey) {
  if (!plainObject(owner) || !plainObject(owner.identity)) return false;
  const ownerKeys = ["schema_version", "kind", "run_path_hash", "owner_kind", "nonce", "pid", "hostname", "acquired_at", "identity"];
  const identityKeys = ["inspector", "start_marker", "command_name", "cwd"];
  if (!exactObjectKeys(owner, ownerKeys) || !exactObjectKeys(owner.identity, identityKeys)) return false;
  return owner.schema_version === 1
    && owner.kind === LAUNCH_FENCE_KIND
    && owner.run_path_hash === `sha256:${runPathKey}`
    && owner.owner_kind === BASE_ADVANCE_LAUNCH_FENCE_OWNER_KIND
    && nonEmptyString(owner.nonce)
    && /^[A-Za-z0-9_-]{16,128}$/u.test(owner.nonce)
    && positivePid(owner.pid)
    && nonEmptyString(owner.hostname)
    && validTimestamp(owner.acquired_at)
    && owner.identity.inspector === PROCESS_INSPECTOR
    && nonEmptyString(owner.identity.start_marker)
    && nonEmptyString(owner.identity.command_name)
    && nonEmptyString(owner.identity.cwd)
    && isAbsolute(owner.identity.cwd);
}

function exactObjectKeys(value, expected) {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

function inspectBaseAdvanceFenceOwner(owner, opts) {
  if (owner.hostname !== (opts.hostname || hostname())) return "indeterminate";
  const verification = verifyProcessIdentity({
    pid: owner.pid,
    cwd: owner.identity.cwd,
    identity: {
      inspector: owner.identity.inspector,
      start_marker: owner.identity.start_marker,
      command_name: owner.identity.command_name,
    },
  }, opts);
  if (verification.status === "absent") return "dead";
  if (verification.status === "live-and-matching") return "live";
  if (verification.status === "mismatched") return "mismatched";
  return "indeterminate";
}

function sameBaseAdvanceFenceEvidence(left, right) {
  return Boolean(left && right
    && sameIdentity(left.identity.dir, right.identity.dir)
    && sameIdentity(left.identity.file, right.identity.file)
    && left.hash === right.hash);
}

function restoreContendedLaunchFence(path, quarantine, observed) {
  try {
    const current = lstatSync(quarantine);
    if (sameIdentity(current, observed.identity.dir) && current.isDirectory() && !current.isSymbolicLink()) {
      try {
        renameSync(quarantine, path);
        return;
      } catch (error) {
        if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
        return;
      }
    }
  } catch {
    // Fall through to an ownerless fail-closed fence when the quarantined
    // identity cannot safely be restored.
  }
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    // An existing or concurrently-created path already preserves contention.
  }
}

export function releaseLaunchFence(fence) {
  if (!fence?.acquired || !fence.identity || !nonEmptyString(fence.nonce)) return false;
  const path = resolve(fence.path);
  const ownerPath = join(path, "owner.json");
  let fd;
  try {
    const dirStat = lstatSync(path);
    if (!sameIdentity(dirStat, fence.identity.dir) || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return false;
    fd = openSync(ownerPath, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW || 0));
    const ownerStat = fstatSync(fd);
    if (!sameIdentity(ownerStat, fence.identity.file) || !ownerStat.isFile()) return false;
    const owner = JSON.parse(readFileSync(fd, "utf8"));
    const pathnameStat = lstatSync(ownerPath);
    if (!sameIdentity(pathnameStat, ownerStat) || pathnameStat.isSymbolicLink() || owner?.kind !== LAUNCH_FENCE_KIND || owner?.nonce !== fence.nonce) return false;
    const quarantine = join(dirnameForClaimDir(path), `.${basename(path)}.quarantine-${randomUUID()}`);
    renameSync(path, quarantine);
    const movedDir = lstatSync(quarantine);
    const movedOwner = lstatSync(join(quarantine, "owner.json"));
    if (!sameIdentity(movedDir, fence.identity.dir) || !sameIdentity(movedOwner, fence.identity.file)) throw new Error("launch fence identity changed during release");
    rmSync(quarantine, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function transitionLaunchClaimPhase(runDir, nonce, phase, updates = {}, opts = {}) {
  if (!LAUNCH_PHASE_SET.has(phase)) throw new Error("invalid launch claim phase");
  const observed = inspectLaunchClaim(runDir, opts);
  if (!observed.ok || observed.claim.nonce !== nonce) throw new Error("launch claim exact-token ownership mismatch");
  if (opts.expectedPhase && observed.claim.phase !== opts.expectedPhase) throw new Error(`launch claim phase must be ${opts.expectedPhase}`);
  const next = { ...observed.claim, ...updates, phase, nonce: observed.claim.nonce };
  const validation = validateLaunchClaim(next, { runId: observed.claim.run_id });
  if (!validation.ok) throw new Error(validation.reason);
  replaceExactClaim(runDir, observed, next);
  const confirmed = inspectLaunchClaim(runDir, { ...opts, runId: next.run_id });
  if (!confirmed.ok || confirmed.claim.nonce !== nonce || confirmed.claim.phase !== phase) throw new Error("launch claim phase transition could not be verified");
  return confirmed;
}

export function releaseLaunchClaim(runDir, nonce, opts = {}) {
  const observed = inspectLaunchClaim(runDir, opts);
  if (!observed.ok || observed.claim.nonce !== nonce) return false;
  if (opts.expectedPhase && observed.claim.phase !== opts.expectedPhase) return false;
  const dir = join(resolve(runDir), LAUNCH_CLAIM_DIR);
  const quarantine = join(resolve(runDir), `.process-launch.lock-quarantine-${randomUUID()}`);
  const before = lstatSync(dir);
  if (before.dev !== observed.identity.dir.dev || before.ino !== observed.identity.dir.ino) return false;
  renameSync(dir, quarantine);
  const moved = inspectLaunchClaimAt(quarantine, { ...opts, runId: observed.claim.run_id });
  if (!moved.ok || moved.claim.nonce !== nonce || moved.identity.dir.dev !== observed.identity.dir.dev || moved.identity.dir.ino !== observed.identity.dir.ino) {
    throw new Error("launch claim cleanup identity changed");
  }
  rmSync(quarantine, { recursive: true, force: true });
  return true;
}

export function inspectProcessEvidence(runDir, opts = {}) {
  const read = readProcessEvidence(runDir, opts);
  if (!read.ok) return read;
  const logValidation = validateProcessLogEntry(runDir, read.evidence.log_ref);
  if (!logValidation.ok) return { ok: false, missing: false, reason: logValidation.reason, path: read.path, evidence: read.evidence };
  const verification = read.evidence.state === "running" ? verifyEvidenceProcess(read.evidence, opts) : null;
  return { ...read, verification };
}

export function readProcessEvidence(runDir, opts = {}) {
  const projection = { ...readProcessEvidenceSnapshot(runDir, opts) };
  delete projection.hash;
  return projection;
}

export function inspectProcessEvidenceForCleanup(runDir, opts = {}) {
  const read = readProcessEvidenceSnapshot(runDir);
  if (read.missing) return cleanupProcessInspection("missing", null, read.reason, null);
  if (!read.ok) return cleanupProcessInspection("invalid", read.evidence, read.reason, read.hash);

  const evidence = read.evidence;
  if (nonEmptyString(opts.runId) && evidence.run_id !== opts.runId) {
    return cleanupProcessInspection("mismatched", evidence, "process evidence run_id does not match requested run", read.hash);
  }
  if (evidence.state !== "running") {
    return cleanupProcessInspection("absent", evidence, `process evidence state is ${evidence.state}`, read.hash);
  }

  const verification = verifyEvidenceProcess(evidence, opts);
  if (verification.status === "live-and-matching") return cleanupProcessInspection("live-matching", evidence, null, read.hash);
  if (verification.status === "absent") return cleanupProcessInspection("absent", evidence, verification.reason, read.hash);
  if (verification.status === "mismatched") return cleanupProcessInspection("mismatched", evidence, verification.reason, read.hash);
  return cleanupProcessInspection("indeterminate", evidence, verification.reason, read.hash);
}

function cleanupProcessInspection(state, evidence, reason, hash) {
  return { state, evidence, reason: reason || null, hash: hash || null };
}

function readProcessEvidenceSnapshot(runDir, opts = {}) {
  const root = resolve(runDir);
  const file = processEvidencePath(root);
  let descriptor;
  let hash = null;
  try {
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("run directory must be a non-symlink directory");
    descriptor = openSync(file, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW || 0));
    const fileStat = fstatSync(descriptor);
    if (!fileStat.isFile()) throw new Error("process evidence must be a regular file");
    const bytes = readFileSync(descriptor);
    hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    assertStableProcessEvidencePath(root, file, rootStat, fileStat);
    const evidence = JSON.parse(bytes.toString("utf8"));
    const validation = validateProcessEvidence(evidence, { ...opts, runDir: root });
    if (!validation.ok) return { ok: false, missing: false, reason: validation.reason, path: file, evidence, hash };
    return { ok: true, missing: false, reason: null, path: file, evidence: validation.evidence, hash };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, missing: true, reason: "missing process evidence", path: file, evidence: null, hash: null };
    return { ok: false, missing: false, reason: `invalid process evidence: ${error.message}`, path: file, evidence: null, hash };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertStableProcessEvidencePath(root, file, rootStat, fileStat) {
  const currentRoot = lstatSync(root);
  const currentFile = lstatSync(file);
  if (!sameIdentity(currentRoot, rootStat) || currentRoot.isSymbolicLink() || !currentRoot.isDirectory()
    || !sameIdentity(currentFile, fileStat) || currentFile.isSymbolicLink() || !currentFile.isFile()) {
    throw new Error("process evidence identity changed during inspection");
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
  if (evidence.launch_token_hash !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(evidence.launch_token_hash)) errors.push("launch_token_hash must be a SHA-256 digest");
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
    ...(nonEmptyString(input.launchToken) ? { launch_token_hash: launchTokenHash(input.launchToken) } : {}),
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

export function matchesProcessLaunchToken(evidence, token) {
  return nonEmptyString(token)
    && /^sha256:[a-f0-9]{64}$/u.test(evidence?.launch_token_hash)
    && evidence.launch_token_hash === launchTokenHash(token);
}

function launchTokenHash(token) {
  return `sha256:${createHash("sha256").update(String(token), "utf8").digest("hex")}`;
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
  return Date.now;
}

function resolvePollSleep(opts) {
  if (typeof opts.sleep === "function") return opts.sleep;
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
  const inspected = inspectVerifiedProcessIdentity(pid, opts);
  if (inspected.status === "live" && inspected.identity) {
    return publicProcessIdentity(inspected.identity);
  }
  return {
    ok: false,
    inspector: DEFAULT_INSPECTOR,
    reason: inspectionFailureReason(inspected, opts),
  };
}

function verifyEvidenceProcess(evidence, opts = {}) {
  const verified = verifyProcessIdentity(expectedProcessIdentity(evidence), opts);
  return { ...verified, reason: verificationReason(verified) };
}

async function signalEvidenceProcess(evidence, opts) {
  const result = await signalVerifiedProcess(expectedProcessIdentity(evidence), {
    ...opts,
    signal: PROCESS_EVIDENCE_SIGNAL,
    waitForExitMs: 0,
  });
  return result.verification
    ? { ...result, verification: { ...result.verification, reason: verificationReason(result.verification) } }
    : result;
}

function inspectProcessForEvidence(pid, opts) {
  return inspectProcessIdentity(pid, opts);
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

function publicProcessIdentity(identity) {
  return {
    ok: true,
    inspector: identity.inspector,
    pid: identity.pid,
    start_marker: identity.start_marker,
    command_name: identity.command_name,
    cwd: identity.cwd,
  };
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

function inspectionFailureReason(inspected, opts) {
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

function invalidLaunchClaim(path, reason, identity = null, hash = null) {
  return { ok: false, missing: false, reason, path, claim: null, owner_status: "invalid", identity, hash };
}

function invalidClaim(reason) {
  return { ok: false, reason, claim: null };
}

function claimIdentity(dirStat, fileStat = null) {
  return {
    dir: { dev: dirStat.dev, ino: dirStat.ino },
    file: fileStat ? { dev: fileStat.dev, ino: fileStat.ino } : null,
  };
}

function assertStableClaimPath(root, dir, file, rootStat, dirStat, fileStat) {
  try {
    const currentRoot = lstatSync(root);
    const currentDir = lstatSync(dir);
    const currentFile = lstatSync(file);
    if (!sameIdentity(currentRoot, rootStat) || currentRoot.isSymbolicLink() || !currentRoot.isDirectory()
      || !sameIdentity(currentDir, dirStat) || currentDir.isSymbolicLink() || !currentDir.isDirectory()
      || !sameIdentity(currentFile, fileStat) || currentFile.isSymbolicLink() || !currentFile.isFile()) {
      throw launchClaimChangedError();
    }
  } catch (error) {
    if (error?.code === "LAUNCH_CLAIM_CHANGED") throw error;
    throw launchClaimChangedError();
  }
}

function launchClaimChangedError() {
  const error = new Error("launch claim identity changed during inspection");
  error.code = "LAUNCH_CLAIM_CHANGED";
  return error;
}

function sameIdentity(actual, expected) {
  return Boolean(actual && expected) && actual.dev === expected.dev && actual.ino === expected.ino;
}

function resolveLaunchFenceNamespace(runDir, opts = {}) {
  let requested;
  if (nonEmptyString(opts.launchFenceRoot)) requested = resolve(opts.launchFenceRoot);
  else {
    const factoryRoot = dirnameForClaimDir(runDir);
    const parent = basename(factoryRoot) === "factory" ? dirnameForClaimDir(factoryRoot) : factoryRoot;
    requested = join(parent, ".factory-launch-fences");
  }
  const parent = realpathSync(dirnameForClaimDir(requested));
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("launch fence parent must be a non-symlink directory");
  return { parent, parent_identity: claimIdentity(parentStat).dir, path: join(parent, basename(requested)) };
}

function ensureLaunchFenceRoot(requestedRunDir, physicalRunDir, expectedRunStat, namespace) {
  assertLaunchFenceParent(namespace);
  try {
    mkdirSync(namespace.path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const fenceRootStat = lstatSync(namespace.path);
  if (!fenceRootStat.isDirectory() || fenceRootStat.isSymbolicLink()) throw new Error("launch fence root must be a non-symlink directory");
  const fenceRoot = { ...namespace, root_identity: claimIdentity(fenceRootStat).dir };
  assertLaunchFenceNamespace(fenceRoot);
  assertLaunchFenceRunIdentity(requestedRunDir, physicalRunDir, expectedRunStat);
  return fenceRoot;
}

function assertLaunchFenceParent(namespace) {
  try {
    const parentStat = lstatSync(namespace.parent);
    if (!sameIdentity(parentStat, namespace.parent_identity) || parentStat.isSymbolicLink() || !parentStat.isDirectory()
      || realpathSync(namespace.parent) !== namespace.parent) throw new Error("launch fence namespace identity changed");
  } catch (error) {
    if (error?.message === "launch fence namespace identity changed") throw error;
    throw new Error("launch fence namespace identity changed");
  }
}

function assertLaunchFenceNamespace(namespace) {
  assertLaunchFenceParent(namespace);
  try {
    const rootStat = lstatSync(namespace.path);
    if (!sameIdentity(rootStat, namespace.root_identity) || rootStat.isSymbolicLink() || !rootStat.isDirectory()
      || realpathSync(namespace.path) !== namespace.path) throw new Error("launch fence namespace identity changed");
  } catch (error) {
    if (error?.message === "launch fence namespace identity changed") throw error;
    throw new Error("launch fence namespace identity changed");
  }
}

function assertLaunchFenceRunIdentity(requestedRunDir, physicalRunDir, expectedRunStat) {
  try {
    const runStat = lstatSync(requestedRunDir);
    const physicalRunStat = lstatSync(physicalRunDir);
    if (!sameIdentity(runStat, expectedRunStat) || !sameIdentity(physicalRunStat, expectedRunStat)
      || runStat.isSymbolicLink() || !runStat.isDirectory()
      || physicalRunStat.isSymbolicLink() || !physicalRunStat.isDirectory()
      || realpathSync(requestedRunDir) !== physicalRunDir) {
      throw new Error("launch fence run directory identity changed");
    }
  } catch (error) {
    if (error?.message === "launch fence run directory identity changed") throw error;
    throw new Error("launch fence run directory identity changed");
  }
}

function removeFailedLaunchFence(path, expectedStat, nonce) {
  let fd;
  try {
    const current = lstatSync(path);
    if (!sameIdentity(current, expectedStat) || current.isSymbolicLink() || !current.isDirectory()) return;
    const ownerPath = join(path, "owner.json");
    let ownerStat = null;
    try {
      fd = openSync(ownerPath, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW || 0));
      ownerStat = fstatSync(fd);
      if (!ownerStat.isFile()) return;
      const owner = JSON.parse(readFileSync(fd, "utf8"));
      const pathnameStat = lstatSync(ownerPath);
      if (!sameIdentity(pathnameStat, ownerStat) || pathnameStat.isSymbolicLink()
        || owner?.kind !== LAUNCH_FENCE_KIND || owner?.nonce !== nonce) return;
    } catch (error) {
      if (error?.code !== "ENOENT") return;
    }
    const quarantine = join(dirnameForClaimDir(path), `.${basename(path)}.failed-${randomUUID()}`);
    renameSync(path, quarantine);
    const movedDir = lstatSync(quarantine);
    if (!sameIdentity(movedDir, expectedStat)) return;
    if (ownerStat) {
      const movedOwner = lstatSync(join(quarantine, "owner.json"));
      if (!sameIdentity(movedOwner, ownerStat)) return;
    }
    rmSync(quarantine, { recursive: true, force: true });
  } catch {
    // Preserve uncertain fence evidence fail closed.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function inspectClaimOwner(claim, opts = {}) {
  if (claim.hostname !== (opts.hostname || hostname())) return "indeterminate";
  const expected = {
    pid: claim.pid,
    cwd: claim.identity.cwd,
    identity: {
      inspector: claim.identity.inspector,
      start_marker: claim.identity.start_marker,
      command_name: claim.identity.command_name,
    },
  };
  const verified = verifyProcessIdentity(expected, opts);
  if (verified.status === "live-and-matching") return "live";
  if (verified.status === "absent") return "dead";
  if (verified.status === "mismatched") return "mismatched";
  return "indeterminate";
}

function assertContainedLaunchPath(runDir, candidate) {
  const prefix = runDir.endsWith(sep) ? runDir : `${runDir}${sep}`;
  if (!candidate.startsWith(prefix)) throw new Error("launch claim path escapes the run directory");
  const runStat = lstatSync(runDir);
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) throw new Error("run directory must be a non-symlink directory");
}

function replaceExactClaim(runDir, observed, next) {
  const root = resolve(runDir);
  const dir = join(root, LAUNCH_CLAIM_DIR);
  const file = join(dir, LAUNCH_CLAIM_FILE);
  const dirStat = lstatSync(dir);
  const fileStat = lstatSync(file);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error("launch claim identity changed");
  if (dirStat.dev !== observed.identity.dir.dev || dirStat.ino !== observed.identity.dir.ino || fileStat.dev !== observed.identity.file.dev || fileStat.ino !== observed.identity.file.ino) {
    throw new Error("launch claim identity changed");
  }
  const temp = join(dir, `.owner-${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    const current = inspectLaunchClaim(root, { runId: next.run_id });
    if (!current.ok || current.claim.nonce !== observed.claim.nonce || current.identity.file.dev !== observed.identity.file.dev || current.identity.file.ino !== observed.identity.file.ino) {
      throw new Error("launch claim identity changed before phase transition");
    }
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function inspectLaunchClaimAt(dir, opts = {}) {
  const runDir = dirnameForClaimDir(dir);
  if (basename(dir) === LAUNCH_CLAIM_DIR) return inspectLaunchClaim(runDir, opts);
  const file = join(dir, LAUNCH_CLAIM_FILE);
  let fd;
  try {
    const rootStat = lstatSync(runDir);
    const dirStat = lstatSync(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return invalidLaunchClaim(file, "launch claim quarantine is invalid");
    fd = openSync(file, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW || 0));
    const fileStat = fstatSync(fd);
    if (!fileStat.isFile()) return invalidLaunchClaim(file, "launch claim owner must be regular");
    const claim = JSON.parse(readFileSync(fd, "utf8"));
    assertStableClaimPath(runDir, dir, file, rootStat, dirStat, fileStat);
    const validation = validateLaunchClaim(claim, opts);
    if (!validation.ok) return invalidLaunchClaim(file, validation.reason);
    return { ok: true, claim, identity: claimIdentity(dirStat, fileStat) };
  } catch (error) {
    return invalidLaunchClaim(file, error.message);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function dirnameForClaimDir(dir) {
  const normalized = resolve(dir);
  return normalized.slice(0, normalized.lastIndexOf(sep)) || sep;
}

function validProcessLogRef(ref) {
  if (!nonEmptyString(ref) || isAbsolute(ref) || ref.includes("\\") || ref.includes("\0")) return false;
  const normalized = normalize(ref).replaceAll(sep, "/");
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") return false;
  if (!normalized.startsWith("processes/")) return false;
  return basename(normalized).length > 0 && normalized !== "processes";
}

function validateProcessLogEntry(runDir, ref) {
  try {
    const root = resolve(runDir);
    const processes = join(root, "processes");
    const log = resolve(root, ref);
    const prefix = processes.endsWith(sep) ? processes : `${processes}${sep}`;
    if (!log.startsWith(prefix)) return { ok: false, reason: "process log escapes processes/" };
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { ok: false, reason: "run directory must be a non-symlink directory" };
    const relativeParts = log.slice(prefix.length).split(sep).filter(Boolean);
    let current = processes;
    const processesStat = lstatSync(processes);
    if (!processesStat.isDirectory() || processesStat.isSymbolicLink()) return { ok: false, reason: "processes directory must be a non-symlink directory" };
    for (const [index, part] of relativeParts.entries()) {
      current = join(current, part);
      const entry = lstatSync(current);
      if (entry.isSymbolicLink()) return { ok: false, reason: "process log ancestors must not be symlinks" };
      if (index < relativeParts.length - 1 && !entry.isDirectory()) return { ok: false, reason: "process log ancestor must be a directory" };
      if (index === relativeParts.length - 1 && !entry.isFile()) return { ok: false, reason: "process log must be a regular file" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `process log is inaccessible: ${error.message}` };
  }
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
