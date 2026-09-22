import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FAMILY_CONTRACTS } from "../core/contracts.js";
import { validateRun } from "./schema.js";
import { inventoryEntries } from "../bin/restore.js";

const VERSION = 1;
const UUID_TEMP = /^\.run\.json\.[0-9a-f-]{36}\.tmp$/u;
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const state = (path) => { try { return lstatSync(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } };
const paths = (canonical, runId) => { const fence = join(dirname(canonical), `.grant-retry-${runId}.json`);
  return { fence, staging: `${fence}.staging`, revoked: join(dirname(canonical), `.revoked-grant-retry-${runId}`) }; };
const snapshotDigest = (path) => sha256(Buffer.from(inventoryEntries(path).join("\n")));

export function hasRetryGrantTransaction(canonical, runId) {
  const { fence, staging } = paths(canonical, runId);
  return Boolean(state(staging) || state(fence));
}

export function prepareRetryGrantTransaction({ canonical, runDir, runId, source, expectedSnapshotDigest }) {
  const { fence, staging, revoked } = paths(canonical, runId);
  if (state(fence) || state(staging) || state(revoked)) throw new Error("retry-grant transaction already exists");
  const beforeBytes = readFileSync(join(runDir, "run.json")), afterBytes = readFileSync(source);
  const before = validateRun(JSON.parse(beforeBytes)), after = validateRun(JSON.parse(afterBytes));
  if (snapshotDigest(canonical) !== expectedSnapshotDigest
    || sha256(readFileSync(join(canonical, "run.json"))) !== sha256(beforeBytes)
    || !isRetryGrantTransition(before, after, expectedSnapshotDigest)) {
    throw new Error("retry-grant transaction does not bind the qualified snapshot and candidate");
  }
  const record = { version: VERSION, run_id: runId, before_sha256: sha256(beforeBytes), after_sha256: sha256(afterBytes),
    snapshot_digest: expectedSnapshotDigest, snapshot_run_sha256: sha256(beforeBytes),
    before_state_sha256: sha256(Buffer.from(JSON.stringify(before))), before_run: before };
  let fd, published = false;
  try {
    fd = openSync(staging, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(staging, fence); published = true;
    syncDir(dirname(canonical));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!published) rmSync(staging, { force: true });
  }
}

export function reconcileRetryGrantTransaction({ canonical, runDir, runId }) {
  const { fence, staging, revoked } = paths(canonical, runId);
  const fenceState = state(fence), stagingState = state(staging); const revokedState = state(revoked);
  if (fenceState && stagingState) throw new Error("retry-grant transaction has duplicate fences");
  if (!fenceState && stagingState && revokedState) throw new Error("retry-grant transaction has impossible staging and revocation artifacts");
  if (!fenceState) {
    if (stagingState) {
      reconcileStagingTransaction({ canonical, runDir, runId, staging, stagingState });
      return "rolled-back";
    }
    // X is non-authoritative cleanup after J was removed; an interrupted recursive removal is resumable.
    if (revokedState) rmSync(revoked, { recursive: true, force: true });
    return "none";
  }
  if (!fenceState.isFile() || fenceState.isSymbolicLink()) throw new Error("retry-grant transaction fence has an unsafe type");
  let record;
  try { record = JSON.parse(readFileSync(fence, "utf8")); } catch { throw new Error("retry-grant transaction fence is malformed"); }
  validateRecord(record, runId);
  const runPath = join(runDir, "run.json"); let runState = state(runPath);
  if (!runState) {
    const candidates = readdirSync(runDir).filter((name) => UUID_TEMP.test(name) && !state(join(canonical, name)));
    if (candidates.length !== 1 || sha256(readCandidate(runDir, candidates[0])) !== record.after_sha256) {
      throw new Error("retry-grant transaction has no recoverable live run manifest");
    }
    renameSync(join(runDir, candidates[0]), runPath); syncDir(runDir); runState = state(runPath);
  }
  if (!runState?.isFile() || runState.isSymbolicLink()) throw new Error("retry-grant transaction has no safe live run manifest");
  const liveBytes = readFileSync(runPath), liveDigest = sha256(liveBytes);
  if (liveDigest === record.before_sha256) {
    if (revokedState || !qualifiedSnapshot(canonical, record)) throw new Error("pre-commit retry-grant transaction has lost its qualified snapshot");
    removeAbandonedCandidate(runDir, canonical, record.after_sha256);
    const livePlaneDigest = sha256(Buffer.from(inventoryEntries(runDir, new Set(["factory.lock", "run-json.lock"])).join("\n")));
    if (livePlaneDigest !== record.snapshot_digest) throw new Error("pre-commit retry-grant live plane changed from its qualified snapshot");
    unlinkSync(fence); syncDir(dirname(canonical));
    return "rolled-back";
  }
  if (liveDigest !== record.after_sha256) throw new Error("retry-grant transaction does not bind the live run manifest");
  const after = validateRun(JSON.parse(liveBytes));
  if (!isRetryGrantTransition(record.before_run, after, record.snapshot_digest)) throw new Error("retry-grant transaction candidate is not an authorized grant");
  const canonicalState = state(canonical);
  if (canonicalState && revokedState) throw new Error("retry-grant transaction has ambiguous snapshot copies");
  if (!canonicalState && !revokedState) throw new Error("retry-grant transaction has lost its fenced snapshot");
  if (canonicalState) {
    if (!qualifiedSnapshot(canonical, record)) throw new Error("retry-grant transaction canonical snapshot changed");
    renameSync(canonical, revoked); syncDir(dirname(canonical));
  } else if (revokedState && !qualifiedSnapshot(revoked, record)) {
    throw new Error("retry-grant transaction revoked snapshot changed");
  }
  // C is now unreachable as recovery authority. Remove J before best-effort quarantine cleanup so a
  // process death during recursive removal cannot wedge an otherwise committed grant.
  unlinkSync(fence); syncDir(dirname(canonical));
  if (state(revoked)) rmSync(revoked, { recursive: true, force: true });
  return "committed";
}

export function isRetryGrantTransition(before, after, expectedSnapshotDigest) {
  const audit = after.retry_extensions.at(-1), scope = audit?.scope;
  if (!["slice", "all"].includes(scope) || audit.snapshot_digest !== expectedSnapshotDigest) return false;
  const mode = scope === "all" ? "grant-retry-all" : "grant-retry-slice";
  try {
    for (const contract of FAMILY_CONTRACTS) {
      const prior = contract.project(before), next = contract.project(after);
      contract.validateProjection(prior); contract.validateProjection(next);
      contract.validateTransition({ mode: ["envelope", "slices"].includes(contract.id) ? mode : undefined,
        before: prior, after: next, current: before, candidate: after });
    }
    return true;
  } catch { return false; }
}

function reconcileStagingTransaction({ canonical, runDir, runId, staging, stagingState }) {
  if (!stagingState.isFile() || stagingState.isSymbolicLink()) {
    throw new Error("retry-grant transaction staging fence has an unsafe type");
  }
  let record; try { record = JSON.parse(readFileSync(staging, "utf8")); validateRecord(record, runId); }
  catch { record = null; }
  const canonicalState = state(canonical), liveBytes = readFileSync(join(runDir, "run.json"));
  if (!canonicalState?.isDirectory() || canonicalState.isSymbolicLink()
    || !readFileSync(join(canonical, "run.json")).equals(liveBytes)) {
    throw new Error("retry-grant staging transaction has lost its pre-commit snapshot");
  }
  const before = validateRun(JSON.parse(liveBytes)), digest = snapshotDigest(canonical);
  const candidates = readdirSync(runDir).filter((name) => UUID_TEMP.test(name) && !state(join(canonical, name)));
  if (candidates.length > 1 || (!record && candidates.length === 0)) {
    throw new Error("retry-grant transaction staging fence is malformed or ambiguous");
  }
  if (record && (record.before_sha256 !== sha256(liveBytes) || !qualifiedSnapshot(canonical, record))) {
    throw new Error("retry-grant staging transaction record does not bind its pre-commit snapshot");
  }
  if (candidates.length === 1) {
    const candidateBytes = readCandidate(runDir, candidates[0]);
    let after; try { after = validateRun(JSON.parse(candidateBytes)); } catch { after = null; }
    if (!after || (record && sha256(candidateBytes) !== record.after_sha256)
      || !isRetryGrantTransition(before, after, digest)) {
      throw new Error("retry-grant staging transaction has an unbound atomic candidate");
    }
  }
  const skipped = new Set(["factory.lock", "run-json.lock", ...candidates]);
  if (sha256(Buffer.from(inventoryEntries(runDir, skipped).join("\n"))) !== digest) {
    throw new Error("retry-grant staging transaction live plane changed from its qualified snapshot");
  }
  if (candidates.length) unlinkSync(join(runDir, candidates[0]));
  unlinkSync(staging); syncDir(dirname(canonical));
}

function qualifiedSnapshot(path, record) {
  const value = state(path);
  return Boolean(value?.isDirectory() && !value.isSymbolicLink()
    && snapshotDigest(path) === record.snapshot_digest
    && sha256(readFileSync(join(path, "run.json"))) === record.snapshot_run_sha256);
}

function removeAbandonedCandidate(runDir, canonical, afterDigest) {
  const candidates = readdirSync(runDir).filter((name) => UUID_TEMP.test(name) && !state(join(canonical, name)));
  if (!candidates.length) return;
  if (candidates.length !== 1 || sha256(readCandidate(runDir, candidates[0])) !== afterDigest) {
    throw new Error("retry-grant transaction has an ambiguous atomic candidate");
  }
  unlinkSync(join(runDir, candidates[0]));
}

function readCandidate(runDir, name) {
  const path = join(runDir, name), value = state(path);
  if (!value?.isFile() || value.isSymbolicLink()) throw new Error("retry-grant atomic candidate has an unsafe type");
  return readFileSync(path);
}

function validateRecord(record, runId) {
  const keys = ["after_sha256", "before_run", "before_sha256", "before_state_sha256", "run_id", "snapshot_digest", "snapshot_run_sha256", "version"];
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).sort().join() !== keys.join()
    || record.version !== VERSION || record.run_id !== runId || record.before_run?.run_id !== runId
    || record.before_sha256 !== record.snapshot_run_sha256
    || ![record.after_sha256, record.before_sha256, record.before_state_sha256, record.snapshot_digest,
      record.snapshot_run_sha256].every((value) => /^sha256:[0-9a-f]{64}$/u.test(value))) {
    throw new Error("retry-grant transaction fence is invalid");
  }
  validateRun(record.before_run);
  if (sha256(Buffer.from(JSON.stringify(record.before_run))) !== record.before_state_sha256) {
    throw new Error("retry-grant transaction before state is not bound to its fence");
  }
}

function syncDir(path) {
  let fd; try { fd = openSync(path, "r"); fsyncSync(fd); }
  catch (error) { if (!["EINVAL", "EPERM", "EISDIR", "EACCES", "ENOTSUP"].includes(error?.code)) throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
