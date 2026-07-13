import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export const CLEANUP_SWEEP_SCHEMA_VERSION = 1;
export const CLEANUP_SWEEP_DIGEST_PREFIX = "ff-cleanup-v1";
export const CLEANUP_SWEEP_CLASSIFICATIONS = Object.freeze(["eligible", "protected", "skipped", "failed", "deleted"]);
export const CLEANUP_SWEEP_REPORT_MODES = Object.freeze(["preview", "execute"]);
export const CLEANUP_SWEEP_REPORT_STATUSES = Object.freeze(["previewed", "completed", "refused", "failed"]);
export const CLEANUP_SWEEP_REFUSAL_CODES = Object.freeze(["DIGEST_FOREIGN", "DIGEST_STALE"]);
export const CLEANUP_SWEEP_REPORT_ERROR_CODES = Object.freeze(["FAILED_FACTORY_ROOT", "FAILED_TEMP_REF_CLEANUP", "FAILED_ORCHESTRATION"]);

const REASON_ENTRIES = [
  ["SKIPPED_UNSAFE_ENTRY", "The factory entry is not a safe readable run directory."],
  ["SKIPPED_PRE_MANIFEST", "The factory entry has no run manifest and requires manual handling."],
  ["SKIPPED_INVALID_RUN_STATE", "The run manifest is invalid or cannot be read safely."],
  ["SKIPPED_RUN_ID_MISMATCH", "The run manifest identity does not match its factory entry."],
  ["PROTECTED_STATUS_BLOCKED", "The run contains blocked recoverable work."],
  ["PROTECTED_STATUS_PARTIAL", "The run contains partial recoverable work."],
  ["PROTECTED_STATUS_NEEDS_HUMAN", "The run requires human recovery."],
  ["SKIPPED_NON_TERMINAL_STATUS", "The run is not completed."],
  ["SHARED_TARGET_CLAIM", "A cleanup target is claimed by more than one factory entry."],
  ["SKIPPED_FACTORY_LOCK_INVALID", "Factory ownership evidence is invalid or contradictory."],
  ["PROTECTED_ACTIVE_FACTORY_OWNER", "Active factory ownership is positively established."],
  ["PROTECTED_FRESH_HEARTBEAT", "The run has a fresh heartbeat."],
  ["SKIPPED_HEARTBEAT_UNCERTAIN", "Heartbeat evidence is invalid, mismatched, or indeterminate."],
  ["PROTECTED_LIVE_PROCESS", "A live identity-matching factory process references the run."],
  ["SKIPPED_PROCESS_UNCERTAIN", "Process evidence is invalid, mismatched, or indeterminate."],
  ["PROTECTED_LIVE_LAUNCH_CLAIM", "A live identity-matching launch claimant owns the run."],
  ["SKIPPED_LAUNCH_CLAIM_UNCERTAIN", "Launch ownership evidence is present but invalid, mismatched, dead, ownerless, or indeterminate."],
  ["SKIPPED_RUN_LOCK_PRESENT_PREVIEW", "A run-state lock is present during preview."],
  ["SKIPPED_RUN_LOCK_INVALID", "Run-state lock evidence is unsafe or indeterminate."],
  ["SKIPPED_RUN_LOCK_CONTENDED", "The run-state lock became contended before cleanup."],
  ["SKIPPED_PR_METADATA_MISMATCH", "Canonical recorded pull-request metadata is missing or inconsistent."],
  ["SKIPPED_PR_LOOKUP_UNCERTAIN", "Current pull-request state could not be verified."],
  ["SKIPPED_PR_OPEN", "The recorded pull request is still open."],
  ["SKIPPED_BASE_UNPROVABLE", "A trustworthy freshly fetched pull-request base could not be established."],
  ["SKIPPED_BRANCH_UNSAFE", "A recorded branch name is unsafe."],
  ["SKIPPED_BRANCH_MISSING", "A recorded local branch is missing or has no resolvable commit."],
  ["SKIPPED_BRANCH_CHECKED_OUT", "A recorded branch is current or checked out outside its recorded worktree."],
  ["SKIPPED_BRANCH_UNMERGED", "A recorded branch contains commits outside the fetched pull-request base."],
  ["SKIPPED_BRANCH_UNPROVABLE", "Recorded branch ancestry could not be proven."],
  ["SKIPPED_WORKTREE_UNSAFE", "A recorded worktree path is outside the safe worktree root."],
  ["SKIPPED_WORKTREE_MISSING", "A recorded worktree is missing or inaccessible."],
  ["SKIPPED_WORKTREE_UNREGISTERED", "A recorded worktree is not registered by Git."],
  ["SKIPPED_WORKTREE_IDENTITY", "A recorded worktree does not match its expected branch and commit."],
  ["ELIGIBLE", "All cleanup eligibility conditions were positively established."],
  ["SKIPPED_CHANGED_DURING_EXECUTION", "Cleanup evidence changed during execution revalidation."],
  ["FAILED_CLEANUP_WORKTREE", "A validated worktree could not be removed."],
  ["FAILED_CLEANUP_BRANCH", "A validated branch could not be deleted at its expected commit."],
  ["DELETED", "The eligible run was deleted."],
  ["FAILED_CLEANUP_RUN_DIR", "Validated targets were removed but the run directory could not be removed."],
  ["RETAINED_AFTER_PARTIAL_FAILURE", "The run directory was retained after an earlier cleanup failure."],
  ["FAILED_CLEANUP_UNEXPECTED", "An unexpected error occurred after cleanup mutation began."],
  ["FAILED_INSPECTION", "Candidate inspection could not be completed safely."],
];

export const CLEANUP_SWEEP_REASON_REGISTRY = Object.freeze(Object.fromEntries(
  REASON_ENTRIES.map(([code, message]) => [code, Object.freeze({ code, message })]),
));

export const CLEANUP_SWEEP_REPORT_ERROR_REGISTRY = Object.freeze({
  FAILED_FACTORY_ROOT: Object.freeze({ code: "FAILED_FACTORY_ROOT", message: "The selected repository factory root could not be inspected as a safe physical directory." }),
  FAILED_TEMP_REF_CLEANUP: Object.freeze({ code: "FAILED_TEMP_REF_CLEANUP", message: "A cleanup-sweep temporary Git reference could not be removed safely." }),
  FAILED_ORCHESTRATION: Object.freeze({ code: "FAILED_ORCHESTRATION", message: "Cleanup sweep orchestration failed outside candidate inspection or cleanup." }),
});

export const CLEANUP_SWEEP_REFUSAL_REGISTRY = Object.freeze({
  DIGEST_FOREIGN: Object.freeze({ code: "DIGEST_FOREIGN", message: "The supplied digest was created for a different repository." }),
  DIGEST_STALE: Object.freeze({ code: "DIGEST_STALE", message: "Repository cleanup evidence changed after the supplied digest was created." }),
});

const REPOSITORY_KEYS = ["schema_version", "root_path", "root_device", "root_inode", "git_common_dir_path", "git_common_dir_device", "git_common_dir_inode", "object_format"];
const EVIDENCE_KEYS = ["entry", "claims", "run", "factory_lock", "heartbeat", "process", "launch_claim", "run_lock", "pr", "worktree_root", "branches", "worktrees"];
const HASH = /^sha256:[0-9a-f]{64}$/u;
const DIGEST = /^ff-cleanup-v1\.([0-9a-f]{64})\.([0-9a-f]{64})$/u;
const REASON_ORDER = new Map(REASON_ENTRIES.map(([code], index) => [code, index]));
const utf8Collator = (left, right) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("canonical JSON does not support undefined or non-JSON primitive values");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort(utf8Collator);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function createRepositoryIdentity(input) {
  assertRecord(input, "repository");
  assertExactKeys(input, REPOSITORY_KEYS, "repository");
  if (input.schema_version !== 1) throw new TypeError("repository.schema_version must be 1");
  for (const key of REPOSITORY_KEYS.slice(1)) assertNonEmptyString(input[key], `repository.${key}`);
  for (const key of ["root_path", "git_common_dir_path"]) if (!isAbsolute(input[key])) throw new TypeError(`repository.${key} must be an absolute path`);
  for (const key of ["root_device", "root_inode", "git_common_dir_device", "git_common_dir_inode"]) {
    if (!/^\d+$/u.test(input[key])) throw new TypeError(`repository.${key} must be a decimal string`);
  }
  if (!/^(?:sha1|sha256)$/u.test(input.object_format)) throw new TypeError("repository.object_format must be sha1 or sha256");
  return Object.fromEntries(REPOSITORY_KEYS.map((key) => [key, input[key]]));
}

export function repositoryDigest(repository) {
  return sha256Canonical(createRepositoryIdentity(repository));
}

export function createReason(code) {
  const reason = CLEANUP_SWEEP_REASON_REGISTRY[code];
  if (!reason) throw new TypeError(`unknown cleanup sweep reason code: ${String(code)}`);
  return { ...reason };
}

export function createReportError(code) {
  const error = CLEANUP_SWEEP_REPORT_ERROR_REGISTRY[code];
  if (!error) throw new TypeError(`unknown cleanup sweep report error code: ${String(code)}`);
  return { ...error };
}

export function createEmptyEvidence(entryName, logicalPath = entryName) {
  assertNonEmptyString(entryName, "entryName");
  assertNonEmptyString(logicalPath, "logicalPath");
  return {
    entry: { kind: "inaccessible", logical_path: logicalPath, physical_path: null, device: null, inode: null },
    claims: { branches: [], worktrees: [] },
    run: { state: "missing", hash: null, run_id: null, status: null },
    factory_lock: { state: "missing", hash: null, active_owner: null },
    heartbeat: { state: "missing", hash: null, fresh: null },
    process: { state: "missing", hash: null },
    launch_claim: { state: "missing", hash: null, dir_device: null, dir_inode: null, file_device: null, file_inode: null },
    run_lock: { observed_before_acquire: "missing", held_by_sweep: false },
    pr: { state: "not-checked", url: null, repository: null, number: null, base_ref: null, base_sha: null },
    worktree_root: { state: "missing", logical_path: null, physical_path: null, device: null, inode: null },
    branches: [],
    worktrees: [],
  };
}

export function createCandidate(input) {
  assertRecord(input, "candidate input");
  const entryName = requiredString(input.entry_name, "candidate.entry_name");
  const classification = enumValue(input.classification, CLEANUP_SWEEP_CLASSIFICATIONS, "candidate.classification");
  const runId = nullableString(input.run_id, "candidate.run_id");
  const reasonCodes = dedupeReasons(input.reason_codes ?? []);
  const evidence = normalizeEvidence(input.evidence ?? createEmptyEvidence(entryName));
  const evidenceDigest = `sha256:${sha256Canonical(evidence)}`;
  if (input.evidence_digest !== undefined && input.evidence_digest !== evidenceDigest) {
    throw new TypeError("candidate.evidence_digest does not match canonical evidence");
  }
  const failureStage = input.failure_stage ?? null;
  if (failureStage !== null && failureStage !== "inspection" && failureStage !== "cleanup") throw new TypeError("candidate.failure_stage must be inspection, cleanup, or null");
  const attemptedCleanup = input.attempted_cleanup ?? false;
  if (typeof attemptedCleanup !== "boolean") throw new TypeError("candidate.attempted_cleanup must be boolean");
  const cleanup = normalizeCleanup(input.cleanup ?? null);
  assertCandidateMutationState({ classification, failureStage, attemptedCleanup, cleanup });
  return {
    schema_version: 1,
    kind: "factory-cleanup-candidate",
    entry_name: entryName,
    run_id: runId,
    classification,
    reason_codes: reasonCodes,
    reasons: reasonCodes.map(createReason),
    failure_stage: failureStage,
    attempted_cleanup: attemptedCleanup,
    evidence_digest: evidenceDigest,
    evidence,
    cleanup,
  };
}

export function validateCandidate(candidate) {
  assertExactKeys(candidate, ["schema_version", "kind", "entry_name", "run_id", "classification", "reason_codes", "reasons", "failure_stage", "attempted_cleanup", "evidence_digest", "evidence", "cleanup"], "candidate");
  if (candidate.schema_version !== 1 || candidate.kind !== "factory-cleanup-candidate") throw new TypeError("candidate schema or kind is invalid");
  const normalized = createCandidate(candidate);
  if (canonicalJson(candidate) !== canonicalJson(normalized)) throw new TypeError("candidate is not in the closed canonical schema");
  return normalized;
}

export function sortCandidates(candidates) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  return [...candidates].sort((left, right) => utf8Collator(left.entry_name, right.entry_name));
}

export function createAuthorizationEnvelope(repository, candidates) {
  const normalizedRepository = createRepositoryIdentity(repository);
  const normalizedCandidates = sortCandidates(candidates.map(validateCandidate)).map((candidate) => {
    if (candidate.classification === "deleted") throw new TypeError("authorization candidates cannot be deleted");
    return {
      entry_name: candidate.entry_name,
      run_id: candidate.run_id,
      classification: candidate.classification,
      reason_codes: [...candidate.reason_codes],
      evidence_digest: candidate.evidence_digest,
    };
  });
  return {
    schema_version: 1,
    kind: "factory-cleanup-sweep-authorization",
    repository: normalizedRepository,
    candidates: normalizedCandidates,
  };
}

export function createCleanupSweepDigest(repository, candidates) {
  const envelope = createAuthorizationEnvelope(repository, candidates);
  return `${CLEANUP_SWEEP_DIGEST_PREFIX}.${repositoryDigest(envelope.repository)}.${sha256Canonical(envelope)}`;
}

export function parseCleanupSweepDigest(value) {
  if (typeof value !== "string") throw new TypeError("cleanup sweep digest must be a string");
  const match = DIGEST.exec(value);
  if (!match) throw new TypeError("cleanup sweep digest is malformed");
  return { schema_version: 1, repository_sha256: match[1], envelope_sha256: match[2], digest: value };
}

export function compareCleanupSweepDigest(providedDigest, repository, candidates) {
  const provided = parseCleanupSweepDigest(providedDigest);
  const expected = parseCleanupSweepDigest(createCleanupSweepDigest(repository, candidates));
  if (provided.repository_sha256 !== expected.repository_sha256) return { matched: false, refusal_code: "DIGEST_FOREIGN", digest: expected.digest };
  if (provided.envelope_sha256 !== expected.envelope_sha256) return { matched: false, refusal_code: "DIGEST_STALE", digest: expected.digest };
  return { matched: true, refusal_code: null, digest: expected.digest };
}

export function countCandidates(candidates) {
  const counts = { eligible: 0, protected: 0, skipped: 0, deleted: 0, failed: 0 };
  for (const candidate of candidates) counts[enumValue(candidate.classification, CLEANUP_SWEEP_CLASSIFICATIONS, "candidate.classification")] += 1;
  return counts;
}

export function countAttemptedCleanupFailures(candidates) {
  return candidates.reduce((count, candidate) => count + (candidate.attempted_cleanup === true && candidate.classification === "failed" ? 1 : 0), 0);
}

export function createCleanupSweepReport(input) {
  assertRecord(input, "report input");
  const mode = enumValue(input.mode, CLEANUP_SWEEP_REPORT_MODES, "report.mode");
  const status = enumValue(input.status, CLEANUP_SWEEP_REPORT_STATUSES, "report.status");
  const repository = input.repository === null ? null : createRepositoryIdentity(input.repository);
  const candidates = sortCandidates((input.candidates ?? []).map(validateCandidate));
  const reportErrors = (input.report_errors ?? []).map((item) => createReportError(typeof item === "string" ? item : item?.code));
  const authorization = normalizeAuthorization(input.authorization);
  const confirmation = normalizeConfirmation(input.confirmation ?? { argv: null, shell_command: null });
  const exitCode = input.exit_code;
  if (exitCode !== 0 && exitCode !== 1) throw new TypeError("report.exit_code must be 0 or 1");
  if (status === "failed" && reportErrors.length === 0) throw new TypeError("a failed report requires a report error");
  if (status !== "failed" && reportErrors.length !== 0) throw new TypeError("only a failed report may contain report errors");
  if (status !== "refused" && authorization.refusal_code !== null) throw new TypeError("only a refused report may have a refusal code");
  if ((status === "refused" || status === "failed" || mode === "execute") && (confirmation.argv !== null || confirmation.shell_command !== null)) {
    throw new TypeError("execute, refused, and failed reports must have null confirmation");
  }
  if (status === "failed" && (authorization.digest !== null || confirmation.argv !== null)) throw new TypeError("failed reports cannot expose a usable digest or confirmation");
  const attemptedCleanupFailures = countAttemptedCleanupFailures(candidates);
  assertReportState({ mode, status, repository, authorization, confirmation, candidates, attemptedCleanupFailures, exitCode });
  return {
    schema_version: 1,
    kind: "factory-cleanup-sweep-report",
    mode,
    status,
    repository,
    authorization,
    counts: countCandidates(candidates),
    attempted_cleanup_failures: attemptedCleanupFailures,
    report_errors: reportErrors,
    confirmation,
    candidates,
    exit_code: exitCode,
  };
}

export function createReportLevelFailure({ mode, code, repository = null, candidates = [], provided_digest = null }) {
  return createCleanupSweepReport({
    mode,
    status: "failed",
    repository,
    authorization: { schema_version: 1, digest: null, provided_digest, matched: null, refusal_code: null },
    report_errors: [code],
    confirmation: { argv: null, shell_command: null },
    candidates,
    exit_code: 1,
  });
}

export function createRefusedReport({ repository, candidates, provided_digest, refusal_code, digest = null }) {
  const comparison = compareCleanupSweepDigest(provided_digest, repository, candidates);
  if (digest !== null && digest !== comparison.digest) throw new TypeError("refused report digest must match recomputed authorization");
  if (refusal_code !== undefined && refusal_code !== comparison.refusal_code) throw new TypeError("refused report code must be derived from the provided digest");
  if (comparison.matched) throw new TypeError("a matching digest cannot create a refused report");
  return createCleanupSweepReport({
    mode: "execute",
    status: "refused",
    repository,
    authorization: { schema_version: 1, digest: comparison.digest, provided_digest, matched: false, refusal_code: comparison.refusal_code },
    candidates,
    report_errors: [],
    confirmation: { argv: null, shell_command: null },
    exit_code: 1,
  });
}

function normalizeEvidence(input) {
  assertRecord(input, "candidate.evidence");
  assertExactKeys(input, EVIDENCE_KEYS, "candidate.evidence");
  const entry = exactRecord(input.entry, ["kind", "logical_path", "physical_path", "device", "inode"], "candidate.evidence.entry");
  enumValue(entry.kind, ["directory", "file", "symlink", "other", "inaccessible"], "candidate.evidence.entry.kind");
  assertNonEmptyString(entry.logical_path, "candidate.evidence.entry.logical_path");
  nullableString(entry.physical_path, "candidate.evidence.entry.physical_path");
  nullableString(entry.device, "candidate.evidence.entry.device");
  nullableString(entry.inode, "candidate.evidence.entry.inode");
  const claims = exactRecord(input.claims, ["branches", "worktrees"], "candidate.evidence.claims");
  const run = exactRecord(input.run, ["state", "hash", "run_id", "status"], "candidate.evidence.run");
  enumValue(run.state, ["missing", "valid", "invalid", "inaccessible"], "candidate.evidence.run.state");
  hashOrNull(run.hash, "candidate.evidence.run.hash"); nullableString(run.run_id, "candidate.evidence.run.run_id"); nullableString(run.status, "candidate.evidence.run.status");
  const factoryLock = exactRecord(input.factory_lock, ["state", "hash", "active_owner"], "candidate.evidence.factory_lock");
  enumValue(factoryLock.state, ["missing", "valid-matching", "valid-mismatched", "invalid", "inaccessible"], "candidate.evidence.factory_lock.state");
  hashOrNull(factoryLock.hash, "candidate.evidence.factory_lock.hash"); nullableBoolean(factoryLock.active_owner, "candidate.evidence.factory_lock.active_owner");
  const heartbeat = exactRecord(input.heartbeat, ["state", "hash", "fresh"], "candidate.evidence.heartbeat");
  enumValue(heartbeat.state, ["missing", "valid-fresh", "valid-stale", "invalid", "mismatched", "indeterminate"], "candidate.evidence.heartbeat.state");
  hashOrNull(heartbeat.hash, "candidate.evidence.heartbeat.hash"); nullableBoolean(heartbeat.fresh, "candidate.evidence.heartbeat.fresh");
  const process = exactRecord(input.process, ["state", "hash"], "candidate.evidence.process");
  enumValue(process.state, ["missing", "live-matching", "absent", "mismatched", "invalid", "indeterminate"], "candidate.evidence.process.state"); hashOrNull(process.hash, "candidate.evidence.process.hash");
  const launchClaim = exactRecord(input.launch_claim, ["state", "hash", "dir_device", "dir_inode", "file_device", "file_inode"], "candidate.evidence.launch_claim");
  enumValue(launchClaim.state, ["missing", "live-matching", "dead", "mismatched", "invalid", "indeterminate"], "candidate.evidence.launch_claim.state");
  hashOrNull(launchClaim.hash, "candidate.evidence.launch_claim.hash");
  for (const key of ["dir_device", "dir_inode", "file_device", "file_inode"]) decimalStringOrNull(launchClaim[key], `candidate.evidence.launch_claim.${key}`);
  const runLock = exactRecord(input.run_lock, ["observed_before_acquire", "held_by_sweep"], "candidate.evidence.run_lock");
  enumValue(runLock.observed_before_acquire, ["missing", "present", "invalid"], "candidate.evidence.run_lock.observed_before_acquire");
  if (typeof runLock.held_by_sweep !== "boolean") throw new TypeError("candidate.evidence.run_lock.held_by_sweep must be boolean");
  const pr = exactRecord(input.pr, ["state", "url", "repository", "number", "base_ref", "base_sha"], "candidate.evidence.pr");
  enumValue(pr.state, ["not-checked", "merged", "closed", "open", "missing-metadata", "mismatch", "not-found", "inaccessible", "invalid-response"], "candidate.evidence.pr.state");
  for (const key of ["url", "repository", "base_ref", "base_sha"]) nullableString(pr[key], `candidate.evidence.pr.${key}`);
  if (pr.number !== null && (!Number.isSafeInteger(pr.number) || pr.number <= 0)) throw new TypeError("candidate.evidence.pr.number must be a positive integer or null");
  const worktreeRoot = exactRecord(input.worktree_root, ["state", "logical_path", "physical_path", "device", "inode"], "candidate.evidence.worktree_root");
  enumValue(worktreeRoot.state, ["missing", "valid", "unsafe"], "candidate.evidence.worktree_root.state");
  for (const key of ["logical_path", "physical_path", "device", "inode"]) nullableString(worktreeRoot[key], `candidate.evidence.worktree_root.${key}`);
  const branches = normalizeBranches(input.branches);
  const worktrees = normalizeWorktrees(input.worktrees);
  return {
    entry: { ...entry },
    claims: { branches: stringArray(claims.branches, "candidate.evidence.claims.branches").sort(utf8Collator), worktrees: stringArray(claims.worktrees, "candidate.evidence.claims.worktrees").sort(utf8Collator) },
    run: { ...run }, factory_lock: { ...factoryLock }, heartbeat: { ...heartbeat }, process: { ...process }, launch_claim: { ...launchClaim }, run_lock: { ...runLock }, pr: { ...pr }, worktree_root: { ...worktreeRoot }, branches, worktrees,
  };
}

function normalizeBranches(value) {
  if (!Array.isArray(value)) throw new TypeError("candidate.evidence.branches must be an array");
  return value.map((item, index) => {
    const path = `candidate.evidence.branches[${index}]`;
    const branch = exactRecord(item, ["name", "expected_head", "state", "base_oid"], path);
    assertNonEmptyString(branch.name, `${path}.name`); nullableString(branch.expected_head, `${path}.expected_head`); nullableString(branch.base_oid, `${path}.base_oid`);
    enumValue(branch.state, ["verified-ancestor", "unsafe", "missing", "current", "checked-out-unrecorded", "unmerged", "unprovable"], `${path}.state`);
    return { ...branch };
  }).sort((left, right) => utf8Collator(left.name, right.name));
}

function normalizeWorktrees(value) {
  if (!Array.isArray(value)) throw new TypeError("candidate.evidence.worktrees must be an array");
  return value.map((item, index) => {
    const path = `candidate.evidence.worktrees[${index}]`;
    const worktree = exactRecord(item, ["recorded_path", "physical_path", "device", "inode", "branch", "head", "state"], path);
    assertNonEmptyString(worktree.recorded_path, `${path}.recorded_path`); nullableString(worktree.physical_path, `${path}.physical_path`); decimalStringOrNull(worktree.device, `${path}.device`); decimalStringOrNull(worktree.inode, `${path}.inode`); nullableString(worktree.branch, `${path}.branch`); nullableString(worktree.head, `${path}.head`);
    enumValue(worktree.state, ["verified", "outside-root", "missing", "symlink", "unregistered", "branch-mismatch", "head-mismatch", "unprovable"], `${path}.state`);
    if (worktree.state === "verified" && (worktree.device === null || worktree.inode === null)) throw new TypeError(`${path} verified identity requires device and inode`);
    return { ...worktree };
  }).sort((left, right) => utf8Collator(left.physical_path ?? left.recorded_path, right.physical_path ?? right.recorded_path));
}

function normalizeCleanup(value) {
  if (value === null) return null;
  const cleanup = exactRecord(value, ["worktrees", "branches", "run_dir"], "candidate.cleanup");
  if (!Array.isArray(cleanup.worktrees) || !Array.isArray(cleanup.branches)) throw new TypeError("candidate cleanup target results must be arrays");
  const worktrees = cleanup.worktrees.map((item, index) => {
    const result = exactRecord(item, ["recorded_path", "physical_path", "branch", "outcome", "reason_code"], `candidate.cleanup.worktrees[${index}]`);
    assertNonEmptyString(result.recorded_path, "cleanup worktree recorded_path"); assertNonEmptyString(result.physical_path, "cleanup worktree physical_path"); nullableString(result.branch, "cleanup worktree branch");
    enumValue(result.outcome, ["removed", "failed"], "cleanup worktree outcome"); validateOutcomeReason(result.outcome, result.reason_code, "cleanup worktree");
    return { ...result };
  }).sort((left, right) => utf8Collator(left.physical_path, right.physical_path));
  const branches = cleanup.branches.map((item, index) => {
    const result = exactRecord(item, ["name", "expected_head", "outcome", "reason_code"], `candidate.cleanup.branches[${index}]`);
    assertNonEmptyString(result.name, "cleanup branch name"); assertNonEmptyString(result.expected_head, "cleanup branch expected_head");
    enumValue(result.outcome, ["deleted", "failed", "not-attempted"], "cleanup branch outcome"); validateOutcomeReason(result.outcome, result.reason_code, "cleanup branch");
    return { ...result };
  }).sort((left, right) => utf8Collator(left.name, right.name));
  const runDir = exactRecord(cleanup.run_dir, ["path", "outcome", "reason_code"], "candidate.cleanup.run_dir");
  assertNonEmptyString(runDir.path, "cleanup run_dir path"); enumValue(runDir.outcome, ["removed", "failed", "retained"], "cleanup run_dir outcome"); validateOutcomeReason(runDir.outcome, runDir.reason_code, "cleanup run_dir");
  const normalized = { worktrees, branches, run_dir: { ...runDir } };
  assertCleanupSequenceCoherence(normalized);
  return normalized;
}

function normalizeAuthorization(value) {
  const authorization = exactRecord(value, ["schema_version", "digest", "provided_digest", "matched", "refusal_code"], "report.authorization");
  if (authorization.schema_version !== 1) throw new TypeError("report.authorization.schema_version must be 1");
  if (authorization.digest !== null) parseCleanupSweepDigest(authorization.digest);
  nullableString(authorization.provided_digest, "report.authorization.provided_digest"); nullableBoolean(authorization.matched, "report.authorization.matched");
  if (authorization.refusal_code !== null) enumValue(authorization.refusal_code, CLEANUP_SWEEP_REFUSAL_CODES, "report.authorization.refusal_code");
  return { ...authorization };
}

function normalizeConfirmation(value) {
  const confirmation = exactRecord(value, ["argv", "shell_command"], "report.confirmation");
  if (confirmation.argv !== null) stringArray(confirmation.argv, "report.confirmation.argv");
  nullableString(confirmation.shell_command, "report.confirmation.shell_command");
  if ((confirmation.argv === null) !== (confirmation.shell_command === null)) throw new TypeError("confirmation argv and shell_command must both be null or both be present");
  return { argv: confirmation.argv === null ? null : [...confirmation.argv], shell_command: confirmation.shell_command };
}

function dedupeReasons(value) {
  const codes = stringArray(value, "candidate.reason_codes");
  const unique = [];
  for (const code of codes) if (!unique.includes(code)) { createReason(code); unique.push(code); }
  return unique.sort((left, right) => REASON_ORDER.get(left) - REASON_ORDER.get(right));
}

function assertCandidateMutationState({ classification, failureStage, attemptedCleanup, cleanup }) {
  if (classification === "failed" && failureStage === "inspection") {
    if (attemptedCleanup || cleanup !== null) throw new TypeError("an inspection-failed candidate must be unattempted with null cleanup");
    return;
  }
  if (classification === "failed" && failureStage === "cleanup") {
    if (!attemptedCleanup || cleanup === null) throw new TypeError("a cleanup-failed candidate must be attempted with cleanup details");
    if (cleanupWhollySuccessful(cleanup)) throw new TypeError("wholly successful cleanup details require deleted classification");
    return;
  }
  if (classification === "failed") throw new TypeError("a failed candidate requires inspection or cleanup failure_stage");
  if (failureStage !== null) throw new TypeError("only a failed candidate may have failure_stage");
  if (classification === "deleted") {
    if (!attemptedCleanup || cleanup === null) throw new TypeError("a deleted candidate must be attempted with cleanup details");
    if (!cleanupWhollySuccessful(cleanup)) throw new TypeError("a deleted candidate requires wholly successful cleanup outcomes");
    return;
  }
  if (attemptedCleanup || cleanup !== null) throw new TypeError("attempted cleanup is allowed only for deleted or cleanup-failed candidates");
}

function assertReportState({ mode, status, repository, authorization, confirmation, candidates, attemptedCleanupFailures, exitCode }) {
  if (status === "previewed") {
    if (mode !== "preview") throw new TypeError("a previewed report must use preview mode");
    if (repository === null) throw new TypeError("a previewed report requires repository identity");
    if (candidates.some((candidate) => candidate.attempted_cleanup || candidate.classification === "deleted")) throw new TypeError("a previewed report cannot contain attempted or deleted candidates");
    const expectedDigest = createCleanupSweepDigest(repository, candidates);
    if (authorization.digest !== expectedDigest || authorization.provided_digest !== null || authorization.matched !== null || authorization.refusal_code !== null) {
      throw new TypeError("a previewed report requires its recomputed digest and null execution authorization fields");
    }
    if (confirmation.argv === null || confirmation.shell_command === null) throw new TypeError("a previewed report requires confirmation");
    if (exitCode !== 0) throw new TypeError("a previewed report requires exit_code 0");
    return;
  }
  if (status === "completed") {
    if (mode !== "execute") throw new TypeError("a completed report must use execute mode");
    if (repository === null) throw new TypeError("a completed report requires repository identity");
    if (candidates.some((candidate) => candidate.classification === "eligible")) throw new TypeError("a completed report cannot retain eligible candidates");
    if (authorization.digest === null || authorization.provided_digest === null || authorization.digest !== authorization.provided_digest || authorization.matched !== true || authorization.refusal_code !== null) {
      throw new TypeError("a completed report requires equal matched authorization digests");
    }
    const parsed = parseCleanupSweepDigest(authorization.provided_digest);
    if (parsed.repository_sha256 !== repositoryDigest(repository)) throw new TypeError("a completed report digest must be bound to its repository identity");
    if (exitCode !== (attemptedCleanupFailures > 0 ? 1 : 0)) throw new TypeError("completed execution exit_code must reflect attempted cleanup failures");
    return;
  }
  if (status === "refused") {
    if (mode !== "execute") throw new TypeError("a refused report must use execute mode");
    if (repository === null) throw new TypeError("a refused report requires repository identity");
    if (candidates.some((candidate) => candidate.attempted_cleanup || candidate.classification === "deleted")) throw new TypeError("a refused report cannot contain attempted or deleted candidates");
    if (authorization.digest === null || authorization.provided_digest === null || authorization.matched !== false || authorization.refusal_code === null) {
      throw new TypeError("a refused report requires recomputed and provided unmatched digest authorization");
    }
    const comparison = compareCleanupSweepDigest(authorization.provided_digest, repository, candidates);
    if (comparison.matched || authorization.digest !== comparison.digest || authorization.refusal_code !== comparison.refusal_code) {
      throw new TypeError("a refused report authorization must derive from repository and candidate evidence");
    }
    if (exitCode !== 1) throw new TypeError("a refused report requires exit_code 1");
    return;
  }
  if (exitCode !== 1) throw new TypeError("a failed report requires exit_code 1");
}

function cleanupWhollySuccessful(cleanup) {
  return cleanup.worktrees.every((item) => item.outcome === "removed" && item.reason_code === null)
    && cleanup.branches.every((item) => item.outcome === "deleted" && item.reason_code === null)
    && cleanup.run_dir.outcome === "removed"
    && cleanup.run_dir.reason_code === null;
}

function assertCleanupSequenceCoherence(cleanup) {
  for (const worktree of cleanup.worktrees) {
    if (worktree.outcome === "failed" && worktree.reason_code !== "FAILED_CLEANUP_WORKTREE") {
      throw new TypeError("a failed worktree requires FAILED_CLEANUP_WORKTREE detail");
    }
    if (worktree.outcome === "failed" && worktree.branch !== null) {
      const recordedBranch = cleanup.branches.find((branch) => branch.name === worktree.branch);
      if (recordedBranch && recordedBranch.outcome !== "not-attempted") {
        throw new TypeError("a branch with a failed recorded worktree must be not-attempted");
      }
    }
  }
  for (const branch of cleanup.branches) {
    if (branch.outcome === "failed" && branch.reason_code !== "FAILED_CLEANUP_BRANCH") {
      throw new TypeError("a failed branch requires FAILED_CLEANUP_BRANCH detail");
    }
    if (branch.outcome === "not-attempted") {
      if (branch.reason_code !== "RETAINED_AFTER_PARTIAL_FAILURE") throw new TypeError("a not-attempted branch requires retained-after-partial-failure detail");
      const failedRecordedWorktree = cleanup.worktrees.some((worktree) => worktree.outcome === "failed" && worktree.branch === branch.name);
      if (!failedRecordedWorktree) throw new TypeError("a branch may be not-attempted only after its recorded worktree failed");
    }
  }
  const targetFailed = cleanup.worktrees.some((item) => item.outcome === "failed")
    || cleanup.branches.some((item) => item.outcome === "failed" || item.outcome === "not-attempted");
  if (targetFailed) {
    if (cleanup.run_dir.outcome !== "retained" || cleanup.run_dir.reason_code !== "RETAINED_AFTER_PARTIAL_FAILURE") {
      throw new TypeError("a target failure requires the run directory to be retained after partial failure");
    }
    return;
  }
  if (cleanup.run_dir.outcome === "failed" && cleanup.run_dir.reason_code !== "FAILED_CLEANUP_RUN_DIR") {
    throw new TypeError("a failed run directory removal requires FAILED_CLEANUP_RUN_DIR detail");
  }
  if (cleanup.run_dir.outcome === "retained" && cleanup.run_dir.reason_code !== "FAILED_CLEANUP_UNEXPECTED") {
    throw new TypeError("a run directory retained without target failure requires FAILED_CLEANUP_UNEXPECTED detail");
  }
}

function validateOutcomeReason(outcome, reasonCode, path) {
  if (outcome === "removed" || outcome === "deleted") {
    if (reasonCode !== null) throw new TypeError(`${path} successful outcome requires null reason_code`);
    return;
  }
  if (reasonCode === null) throw new TypeError(`${path} unsuccessful outcome requires reason_code`);
  createReason(reasonCode);
}
function hashOrNull(value, path) { if (value !== null && (typeof value !== "string" || !HASH.test(value))) throw new TypeError(`${path} must be a sha256 hash or null`); }
function decimalStringOrNull(value, path) { if (value !== null && (typeof value !== "string" || !/^\d+$/u.test(value))) throw new TypeError(`${path} must be a decimal string or null`); return value; }
function nullableString(value, path) { if (value !== null && typeof value !== "string") throw new TypeError(`${path} must be a string or null`); return value; }
function nullableBoolean(value, path) { if (value !== null && typeof value !== "boolean") throw new TypeError(`${path} must be a boolean or null`); return value; }
function requiredString(value, path) { assertNonEmptyString(value, path); return value; }
function assertNonEmptyString(value, path) { if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path} must be a non-empty string`); }
function enumValue(value, allowed, path) { if (!allowed.includes(value)) throw new TypeError(`${path} must be one of ${allowed.join(", ")}`); return value; }
function stringArray(value, path) { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError(`${path} must be an array of strings`); return [...value]; }
function assertRecord(value, path) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`); }
function exactRecord(value, keys, path) { assertRecord(value, path); assertExactKeys(value, keys, path); return value; }
function assertExactKeys(value, keys, path) {
  assertRecord(value, path);
  const actual = Object.keys(value).sort(utf8Collator);
  const expected = [...keys].sort(utf8Collator);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${path} must contain exactly: ${keys.join(", ")}`);
}
