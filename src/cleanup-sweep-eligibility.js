import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { collectCleanupTargets } from "./factory.js";
import { git } from "./git.js";
import { lookupPullRequest } from "./github.js";
import { inspectProcessEvidenceForCleanup } from "./process-evidence.js";
import { createCandidate, createEmptyEvidence } from "./cleanup-sweep-report.js";
import { validateFactoryLock, validateHeartbeatState, validateRun } from "./validate.js";
import { parseWorktreeListPorcelain } from "./worktrees.js";

const PROTECTED_STATUS = Object.freeze({
  blocked: "PROTECTED_STATUS_BLOCKED",
  partial: "PROTECTED_STATUS_PARTIAL",
  "needs-human": "PROTECTED_STATUS_NEEDS_HUMAN",
});
const SAFE_ENTRY = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const FILES = Object.freeze({ run: "run.json", factoryLock: "factory.lock", heartbeat: "heartbeat.json", process: "process.json", runLock: "run-json.lock" });
const utf8 = (left, right) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));

/**
 * Inspect immediate entries in this repository's factory root. The function
 * never discovers an ancestor factory root and never deletes a temporary ref.
 * Callers own deletion of every ref returned in temporary_refs.
 */
export function discoverCleanupSweepCandidates(repo, options = {}) {
  const repositoryRoot = realpathSync(resolve(repo));
  const factoryRoot = join(repositoryRoot, ".opencode", "factory");
  let root;
  try {
    root = lstatSync(factoryRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return { factory_root: factoryRoot, candidates: [], temporary_refs: [] };
    throw error;
  }
  if (root.isSymbolicLink() || !root.isDirectory() || realpathSync(factoryRoot) !== factoryRoot) {
    throw new Error("factory root is not a safe physical directory");
  }

  const entries = readdirSync(factoryRoot).sort(utf8).map((entryName) => inspectEntry(factoryRoot, entryName));
  const collisions = buildClaimInventory(entries, repositoryRoot);
  const temporaryRefs = [];
  const candidates = entries.map((entry) => {
    try {
      const result = classifyEntry(repositoryRoot, entry, collisions.get(entry.entryName) ?? false, {
        ...options,
        registerTemporaryRef: (temporaryRef) => temporaryRefs.push(temporaryRef),
      });
      return result.candidate;
    } catch {
      return failedCandidate(entry);
    }
  });
  return { factory_root: factoryRoot, candidates, temporary_refs: [...new Set(temporaryRefs)].sort(utf8) };
}

export function classifyCleanupSweepCandidate(repo, entryName, options = {}) {
  const repositoryRoot = realpathSync(resolve(repo));
  const factoryRoot = join(repositoryRoot, ".opencode", "factory");
  const entries = readdirSync(factoryRoot).sort(utf8).map((name) => inspectEntry(factoryRoot, name));
  const entry = entries.find((item) => item.entryName === entryName);
  if (!entry) throw new Error("cleanup sweep entry does not exist");
  const collisions = buildClaimInventory(entries, repositoryRoot);
  return classifyEntry(repositoryRoot, entry, collisions.get(entryName) ?? false, options);
}

function inspectEntry(factoryRoot, entryName) {
  const logicalPath = join(factoryRoot, entryName);
  const entry = { entryName, logicalPath, kind: "inaccessible", stat: null, physicalPath: null, rawRun: null };
  try {
    const value = lstatSync(logicalPath);
    entry.stat = value;
    entry.kind = value.isSymbolicLink() ? "symlink" : value.isDirectory() ? "directory" : value.isFile() ? "file" : "other";
    if (entry.kind === "directory") entry.physicalPath = realpathSync(logicalPath);
  } catch {
    return entry;
  }
  if (entry.kind !== "directory") return entry;
  try {
    const read = readJsonNoFollow(join(logicalPath, FILES.run));
    if (read.state === "valid") {
      entry.rawRun = read.value;
    }
  } catch {
    // Classification records the invalid manifest; inventory remains synthetic.
  }
  return entry;
}

function buildClaimInventory(entries, repo) {
  const owners = new Map();
  const claimsByEntry = new Map();
  for (const entry of entries) {
    const claims = rawClaims(entry, repo);
    claimsByEntry.set(entry.entryName, claims);
    for (const key of [...claims.branchKeys, ...claims.worktreeKeys]) {
      const claimants = owners.get(key) ?? new Set();
      claimants.add(entry.entryName);
      owners.set(key, claimants);
    }
  }
  const result = new Map(entries.map((entry) => [entry.entryName, false]));
  for (const [entryName, claims] of claimsByEntry) {
    if ([...claims.branchKeys, ...claims.worktreeKeys].some((key) => owners.get(key)?.size > 1)) result.set(entryName, true);
  }
  return result;
}

function rawClaims(entry, repo) {
  const branchValues = [entry.entryName];
  const worktreeValues = [join(repo, ".opencode", "worktrees", entry.entryName)];
  const run = entry.rawRun;
  if (run && typeof run === "object" && !Array.isArray(run)) {
    if (typeof run.branch === "string") branchValues.push(run.branch);
    if (typeof run.worktree === "string") worktreeValues.push(run.worktree);
    if (Array.isArray(run.slices)) for (const slice of run.slices) {
      if (typeof slice?.branch === "string") branchValues.push(slice.branch);
      if (typeof slice?.worktree === "string") worktreeValues.push(slice.worktree);
    }
  }
  const branches = [...new Set(branchValues.filter(nonEmpty))].sort(utf8);
  const worktrees = [...new Set(worktreeValues.filter(nonEmpty).map((value) => resolve(repo, value)))].sort(utf8);
  return {
    branches,
    worktrees,
    branchKeys: branches.map((value) => `branch:${value}`),
    worktreeKeys: worktrees.flatMap((value) => worktreeClaimKeys(value)),
  };
}

function worktreeClaimKeys(logical) {
  const keys = [`worktree-logical:${logical}`];
  try { keys.push(`worktree-physical:${realpathSync(logical)}`); } catch { /* logical key remains collision-safe */ }
  return keys;
}

function classifyEntry(repo, entry, sharedClaim, options) {
  const evidence = createEmptyEvidence(entry.entryName, entry.logicalPath);
  evidence.entry = {
    kind: entry.kind,
    logical_path: entry.logicalPath,
    physical_path: entry.physicalPath,
    device: entry.stat ? String(entry.stat.dev) : null,
    inode: entry.stat ? String(entry.stat.ino) : null,
  };
  const claims = rawClaims(entry, repo);
  evidence.claims = { branches: claims.branches, worktrees: claims.worktrees };
  const finish = (classification, reasonCodes, runId = evidence.run.run_id, temporaryRef = null) => ({
    candidate: createCandidate({ entry_name: entry.entryName, run_id: runId, classification, reason_codes: sharedClaim ? [...reasonCodes, "SHARED_TARGET_CLAIM"] : reasonCodes, evidence }),
    temporary_ref: temporaryRef,
  });

  if (entry.kind !== "directory" || entry.physicalPath !== entry.logicalPath || !SAFE_ENTRY.test(entry.entryName)) return finish("skipped", ["SKIPPED_UNSAFE_ENTRY"], null);
  const runRead = readJsonNoFollow(join(entry.logicalPath, FILES.run));
  if (runRead.state === "missing") return finish("skipped", ["SKIPPED_PRE_MANIFEST"], null);
  if (runRead.state !== "valid") {
    evidence.run.state = runRead.state === "inaccessible" ? "inaccessible" : "invalid";
    evidence.run.hash = runRead.hash;
    return finish("skipped", ["SKIPPED_INVALID_RUN_STATE"], null);
  }
  evidence.run.hash = runRead.hash;
  evidence.run.run_id = typeof runRead.value?.run_id === "string" ? runRead.value.run_id : null;
  evidence.run.status = typeof runRead.value?.status === "string" ? runRead.value.status : null;
  let run;
  try { run = validateRun(runRead.value); } catch {
    evidence.run.state = "invalid";
    return finish("skipped", ["SKIPPED_INVALID_RUN_STATE"]);
  }
  evidence.run.state = "valid";
  if (run.run_id !== entry.entryName) return finish("skipped", ["SKIPPED_RUN_ID_MISMATCH"]);
  const sidecars = inspectSidecars(entry.logicalPath, run, evidence, options);
  const protectedStatus = PROTECTED_STATUS[run.status];
  if (protectedStatus) return finish("protected", [protectedStatus, ...sidecars.protected, ...sidecars.skipped]);
  if (run.status !== "completed") return finish("skipped", ["SKIPPED_NON_TERMINAL_STATUS", ...sidecars.protected, ...sidecars.skipped]);
  if (sharedClaim) return finish("skipped", [...sidecars.protected, ...sidecars.skipped]);
  if (sidecars.protected.length) return finish("protected", [...sidecars.protected, ...sidecars.skipped]);
  if (sidecars.skipped.length) return finish("skipped", sidecars.skipped);

  const lookup = lookupPullRequest(repo, run, { githubRunner: options.githubRunner, timeout: options.githubTimeout, maxBuffer: options.githubMaxBuffer });
  if (!lookup.ok) {
    evidence.pr.state = lookup.reason === "metadata-mismatch" ? "missing-metadata" : "inaccessible";
    return finish("skipped", [lookup.reason === "metadata-mismatch" ? "SKIPPED_PR_METADATA_MISMATCH" : "SKIPPED_PR_LOOKUP_UNCERTAIN"]);
  }
  const pr = lookup.pullRequest;
  evidence.pr = { state: pr.state.toLowerCase(), url: pr.url, repository: pr.repository, number: pr.number, base_ref: pr.base_ref, base_sha: pr.base_sha };
  if (pr.state === "OPEN") return finish("skipped", ["SKIPPED_PR_OPEN"]);

  const temporaryRef = temporaryRefFor(entry.entryName, options.invocationId ?? randomUUID());
  options.registerTemporaryRef?.(temporaryRef);
  if (!verifyFetchedBase(repo, pr, temporaryRef, options.gitRunner ?? git)) return finish("skipped", ["SKIPPED_BASE_UNPROVABLE"], run.run_id, temporaryRef);
  const targetResult = inspectTargets(repo, run, temporaryRef, pr.base_sha, evidence, options.gitRunner ?? git);
  if (targetResult.reason) return finish("skipped", [targetResult.reason], run.run_id, temporaryRef);
  return finish("eligible", ["ELIGIBLE"], run.run_id, temporaryRef);
}

function inspectSidecars(runDir, run, evidence, options) {
  const protectedReasons = [];
  const skipped = [];
  const factoryLock = inspectValidatedFile(join(runDir, FILES.factoryLock), validateFactoryLock, run.run_id);
  evidence.factory_lock = { state: factoryLock.state, hash: factoryLock.hash, active_owner: null };
  if (!["missing", "valid-matching"].includes(factoryLock.state)) skipped.push("SKIPPED_FACTORY_LOCK_INVALID");

  const heartbeat = inspectHeartbeat(runDir, run.run_id, options);
  evidence.heartbeat = heartbeat.evidence;
  if (["invalid", "mismatched", "indeterminate"].includes(heartbeat.evidence.state)) skipped.push("SKIPPED_HEARTBEAT_UNCERTAIN");
  if (heartbeat.evidence.state === "valid-fresh") protectedReasons.push("PROTECTED_FRESH_HEARTBEAT");

  const processInspector = options.inspectProcess ?? inspectProcessEvidenceForCleanup;
  let processResult;
  try { processResult = processInspector(runDir, { ...options.processOptions, runId: run.run_id }); } catch { processResult = { state: "indeterminate" }; }
  const processHash = safeFileHash(join(runDir, FILES.process));
  evidence.process = { state: normalizeProcessState(processResult?.state), hash: processHash };
  if (evidence.process.state === "live-matching") protectedReasons.push("PROTECTED_LIVE_PROCESS");
  else if (!["missing", "absent"].includes(evidence.process.state)) skipped.push("SKIPPED_PROCESS_UNCERTAIN");

  if (factoryLock.state === "valid-matching" && (heartbeat.evidence.state === "valid-fresh" || evidence.process.state === "live-matching")) {
    evidence.factory_lock.active_owner = true;
    protectedReasons.unshift("PROTECTED_ACTIVE_FACTORY_OWNER");
  } else if (factoryLock.state === "valid-matching") evidence.factory_lock.active_owner = false;

  const lockState = inspectRunLock(join(runDir, FILES.runLock), options.heldRunId === run.run_id);
  evidence.run_lock = { observed_before_acquire: lockState, held_by_sweep: options.heldRunId === run.run_id };
  if (lockState === "invalid") skipped.push("SKIPPED_RUN_LOCK_INVALID");
  else if (lockState === "present" && options.heldRunId !== run.run_id) {
    skipped.push(options.runLockContended ? "SKIPPED_RUN_LOCK_CONTENDED" : "SKIPPED_RUN_LOCK_PRESENT_PREVIEW");
  }
  return { protected: dedupe(protectedReasons), skipped: dedupe(skipped) };
}

function inspectHeartbeat(runDir, runId, options) {
  const read = readJsonNoFollow(join(runDir, FILES.heartbeat));
  if (read.state === "missing") return { evidence: { state: "missing", hash: null, fresh: null } };
  if (read.state !== "valid") return { evidence: { state: read.state === "inaccessible" ? "indeterminate" : "invalid", hash: read.hash, fresh: null } };
  let heartbeat;
  try { heartbeat = validateHeartbeatState(read.value); } catch { return { evidence: { state: "invalid", hash: read.hash, fresh: null } }; }
  if (heartbeat.run_id !== runId) return { evidence: { state: "mismatched", hash: read.hash, fresh: null } };
  const nowMs = clockMs(options.clock);
  const tickMs = Date.parse(heartbeat.last_tick_at);
  const interval = Number.isInteger(heartbeat.interval_ms) && heartbeat.interval_ms > 0 ? heartbeat.interval_ms : 30_000;
  if (!Number.isFinite(nowMs) || !Number.isFinite(tickMs) || tickMs > nowMs + 5_000) return { evidence: { state: "indeterminate", hash: read.hash, fresh: null } };
  const fresh = nowMs - tickMs <= Math.max(2 * interval, 120_000);
  return { evidence: { state: fresh ? "valid-fresh" : "valid-stale", hash: read.hash, fresh } };
}

function inspectTargets(repo, run, temporaryRef, baseOid, evidence, gitRunner) {
  const targets = collectCleanupTargets(run);
  const worktreeTargets = recordedWorktreeAssociations(run);
  let registered = [];
  if (targets.branches.length > 0 || targets.worktrees.length > 0) {
    const listed = gitRunner(repo, ["worktree", "list", "--porcelain"]);
    if (!listed?.ok) return { reason: "SKIPPED_BRANCH_UNPROVABLE" };
    registered = parseWorktreeListPorcelain(listed.stdout);
  }
  const worktreeRoot = join(repo, ".opencode", "worktrees");
  const recordedPaths = new Set(worktreeTargets
    .map((item) => resolve(repo, item.worktree))
    .filter((path) => contained(worktreeRoot, path)));
  for (const branch of [...targets.branches].sort(utf8)) {
    const record = { name: branch, expected_head: null, state: "unprovable", base_oid: baseOid };
    evidence.branches.push(record);
    if (!validBranch(repo, branch, gitRunner)) { record.state = "unsafe"; return { reason: "SKIPPED_BRANCH_UNSAFE" }; }
    const head = gitRunner(repo, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    if (!head?.ok || !oid(head.stdout.trim())) { record.state = "missing"; return { reason: "SKIPPED_BRANCH_MISSING" }; }
    record.expected_head = head.stdout.trim();
    const checkout = registered.find((item) => item.branch === branch);
    if (checkout && !recordedPaths.has(resolve(checkout.path))) {
      record.state = resolve(checkout.path) === repo ? "current" : "checked-out-unrecorded";
      return { reason: "SKIPPED_BRANCH_CHECKED_OUT" };
    }
    const ancestry = gitRunner(repo, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, temporaryRef]);
    if (ancestry?.status === 1) { record.state = "unmerged"; return { reason: "SKIPPED_BRANCH_UNMERGED" }; }
    if (!ancestry?.ok) { record.state = "unprovable"; return { reason: "SKIPPED_BRANCH_UNPROVABLE" }; }
    record.state = "verified-ancestor";
  }
  const associationConflict = conflictingWorktreeAssociation(repo, worktreeTargets);
  if (associationConflict) {
    for (const target of associationConflict) {
      evidence.worktrees.push({
        recorded_path: String(target.worktree),
        physical_path: physicalPathOrNull(resolve(repo, target.worktree)),
        branch: target.branch ?? null,
        head: null,
        state: "branch-mismatch",
      });
    }
    return { reason: "SKIPPED_WORKTREE_IDENTITY" };
  }
  for (const target of dedupeWorktreeAssociations(worktreeTargets)) {
    const result = inspectWorktree(repo, target, registered, evidence.branches);
    evidence.worktrees.push(result.record);
    if (result.reason) return { reason: result.reason };
  }
  return { reason: null };
}

function recordedWorktreeAssociations(run) {
  const entries = [];
  if (run.worktree) entries.push({ worktree: run.worktree, branch: run.branch });
  if (Array.isArray(run.slices)) {
    for (const slice of run.slices) if (slice?.worktree) entries.push({ worktree: slice.worktree, branch: slice.branch });
  }
  return entries.sort((left, right) => utf8(String(left.worktree), String(right.worktree)) || utf8(String(left.branch ?? ""), String(right.branch ?? "")));
}

function conflictingWorktreeAssociation(repo, targets) {
  const associations = new Map();
  for (const target of targets) {
    const logical = resolve(repo, target.worktree);
    const keys = new Set([logical]);
    const physical = physicalPathOrNull(logical);
    if (physical) keys.add(physical);
    for (const key of keys) {
      const byBranch = associations.get(key) ?? new Map();
      const branch = target.branch ?? null;
      const entries = byBranch.get(branch) ?? [];
      entries.push(target);
      byBranch.set(branch, entries);
      associations.set(key, byBranch);
    }
  }
  for (const byBranch of associations.values()) {
    if (byBranch.size > 1) return [...byBranch.values()].flat().sort((left, right) => utf8(String(left.worktree), String(right.worktree)) || utf8(String(left.branch ?? ""), String(right.branch ?? "")));
  }
  return null;
}

function dedupeWorktreeAssociations(targets) {
  const seen = new Set();
  return targets.filter((target) => {
    const key = `${String(target.worktree)}\0${String(target.branch ?? "")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function physicalPathOrNull(path) {
  try { return realpathSync(path); } catch { return null; }
}

function inspectWorktree(repo, target, registered, branches) {
  const recordedPath = String(target.worktree);
  const logical = resolve(repo, recordedPath);
  const record = { recorded_path: recordedPath, physical_path: null, branch: target.branch ?? null, head: null, state: "unprovable" };
  const root = join(repo, ".opencode", "worktrees");
  if (!contained(root, logical)) { record.state = "outside-root"; return { record, reason: "SKIPPED_WORKTREE_UNSAFE" }; }
  let value;
  try { value = lstatSync(logical); } catch { record.state = "missing"; return { record, reason: "SKIPPED_WORKTREE_MISSING" }; }
  if (value.isSymbolicLink()) { record.state = "symlink"; return { record, reason: "SKIPPED_WORKTREE_UNSAFE" }; }
  if (!value.isDirectory()) { record.state = "missing"; return { record, reason: "SKIPPED_WORKTREE_MISSING" }; }
  try { record.physical_path = realpathSync(logical); } catch { record.state = "unprovable"; return { record, reason: "SKIPPED_WORKTREE_UNSAFE" }; }
  if (!contained(realpathExistingRoot(root), record.physical_path)) { record.state = "outside-root"; return { record, reason: "SKIPPED_WORKTREE_UNSAFE" }; }
  const registeredEntry = registered.find((item) => { try { return realpathSync(item.path) === record.physical_path; } catch { return false; } });
  if (!registeredEntry) { record.state = "unregistered"; return { record, reason: "SKIPPED_WORKTREE_UNREGISTERED" }; }
  record.branch = registeredEntry.branch;
  record.head = registeredEntry.head;
  const branch = branches.find((item) => item.name === target.branch);
  if (!target.branch || registeredEntry.branch !== target.branch) { record.state = "branch-mismatch"; return { record, reason: "SKIPPED_WORKTREE_IDENTITY" }; }
  if (!branch?.expected_head || registeredEntry.head !== branch.expected_head) { record.state = "head-mismatch"; return { record, reason: "SKIPPED_WORKTREE_IDENTITY" }; }
  record.state = "verified";
  return { record, reason: null };
}

function verifyFetchedBase(repo, pr, temporaryRef, gitRunner) {
  if (!validBranch(repo, pr.base_ref, gitRunner) || !oid(pr.base_sha)) return false;
  if (gitRunner(repo, ["check-ref-format", temporaryRef])?.ok !== true) return false;
  const fetch = gitRunner(repo, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--force", `https://github.com/${pr.repository}.git`, `+refs/heads/${pr.base_ref}:${temporaryRef}`]);
  if (!fetch?.ok) return false;
  const resolved = gitRunner(repo, ["rev-parse", "--verify", `${temporaryRef}^{commit}`]);
  return Boolean(resolved?.ok && resolved.stdout.trim() === pr.base_sha);
}

function validBranch(repo, branch, gitRunner) {
  if (!nonEmpty(branch) || branch.startsWith("-") || branch.includes("\0")) return false;
  return gitRunner(repo, ["check-ref-format", "--branch", branch])?.ok === true;
}

function inspectValidatedFile(path, validator, runId) {
  const read = readJsonNoFollow(path);
  if (read.state === "missing") return { state: "missing", hash: null };
  if (read.state !== "valid") return { state: read.state === "inaccessible" ? "inaccessible" : "invalid", hash: read.hash };
  try {
    const value = validator(read.value);
    return { state: value.run_id === runId ? "valid-matching" : "valid-mismatched", hash: read.hash };
  } catch { return { state: "invalid", hash: read.hash }; }
}

function inspectRunLock(path, held) {
  try {
    const value = lstatSync(path);
    if (value.isSymbolicLink() || !value.isDirectory()) return "invalid";
    return held ? "missing" : "present";
  } catch (error) { return error?.code === "ENOENT" ? "missing" : "invalid"; }
}

function readJsonNoFollow(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    if (!fstatSync(descriptor).isFile()) return { state: "invalid", value: null, hash: null };
    const bytes = readFileSync(descriptor);
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch { return { state: "invalid", value: null, hash }; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "invalid", value, hash };
    return { state: "valid", value, hash };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing", value: null, hash: null };
    if (["ELOOP", "EFTYPE"].includes(error?.code)) return { state: "invalid", value: null, hash: null };
    return { state: "inaccessible", value: null, hash: null };
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function failedCandidate(entry) {
  const evidence = createEmptyEvidence(entry.entryName, entry.logicalPath);
  evidence.entry = { kind: entry.kind, logical_path: entry.logicalPath, physical_path: entry.physicalPath, device: entry.stat ? String(entry.stat.dev) : null, inode: entry.stat ? String(entry.stat.ino) : null };
  return createCandidate({ entry_name: entry.entryName, run_id: null, classification: "failed", reason_codes: ["FAILED_INSPECTION"], failure_stage: "inspection", evidence });
}

function temporaryRefFor(runId, invocationId) {
  const safeInvocation = String(invocationId).replace(/[^A-Za-z0-9._-]/gu, "-");
  const hash = createHash("sha256").update(runId).digest("hex");
  return `refs/feature-factory/cleanup-sweep/v1/${safeInvocation}/${hash}`;
}
function safeFileHash(path) { const read = readJsonNoFollow(path); return read.hash; }
function normalizeProcessState(value) { return ["missing", "live-matching", "absent", "mismatched", "invalid", "indeterminate"].includes(value) ? value : "indeterminate"; }
function clockMs(clock) { try { const value = typeof clock === "function" ? clock() : Date.now(); return value instanceof Date ? value.getTime() : Number(value); } catch { return Number.NaN; } }
function oid(value) { return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(String(value)); }
function nonEmpty(value) { return typeof value === "string" && value.trim() !== ""; }
function dedupe(values) { return [...new Set(values)]; }
function contained(root, target) { const rel = relative(resolve(root), resolve(target)); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
function realpathExistingRoot(root) { try { return realpathSync(root); } catch { return root; } }
