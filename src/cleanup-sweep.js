import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupRunLocked, CleanupRunUnexpectedError } from "./factory.js";
import { git } from "./git.js";
import { classifyCleanupSweepCandidate, discoverCleanupSweepCandidates } from "./cleanup-sweep-eligibility.js";
import { createCleanupSweepConfirmation } from "./cleanup-sweep-output.js";
import {
  canonicalJson,
  compareCleanupSweepDigest,
  createCandidate,
  createCleanupSweepDigest,
  createCleanupSweepReport,
  createRefusedReport,
  createReportLevelFailure,
  createRepositoryIdentity,
  parseCleanupSweepDigest,
} from "./cleanup-sweep-report.js";
import { RunJsonLockContendedError, withRunJsonLock } from "./run-state.js";
import { validateRun } from "./validate.js";

const utf8 = (left, right) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));

export async function previewCleanupSweep(options = {}) {
  let repository = null;
  let candidates = [];
  let temporaryRefs = [];
  let discoveryComplete = false;
  let report;
  try {
    const invocationId = invocationIdentifier(options);
    repository = resolveCleanupSweepRepository(options);
    const discovery = discoverCleanupSweepCandidates(repository.root_path, discoveryOptions(options, invocationId));
    discoveryComplete = true;
    candidates = discovery.candidates;
    temporaryRefs = temporaryRefRecords(discovery.temporary_refs, candidates);
    const digest = createCleanupSweepDigest(repository, candidates);
    report = createCleanupSweepReport({
      mode: "preview",
      status: "previewed",
      repository,
      authorization: { schema_version: 1, digest, provided_digest: null, matched: null, refusal_code: null },
      candidates,
      report_errors: [],
      confirmation: createCleanupSweepConfirmation(digest, repository.root_path, { json: options.json === true }),
      exit_code: 0,
    });
  } catch {
    report = createReportLevelFailure({
      mode: "preview",
      code: discoveryComplete ? "FAILED_ORCHESTRATION" : "FAILED_FACTORY_ROOT",
      repository,
      candidates,
    });
  }
  return finalizeAfterTemporaryRefs(report, { ...options, repository, candidates, temporaryRefs, mode: "preview" });
}

export async function executeCleanupSweep(options = {}) {
  parseCleanupSweepDigest(options.digest);
  let repository = null;
  let candidates = [];
  let temporaryRefs = [];
  let report;
  let discoveryComplete = false;
  try {
    const invocationId = invocationIdentifier(options);
    repository = resolveCleanupSweepRepository(options);
    const discovery = discoverCleanupSweepCandidates(repository.root_path, discoveryOptions(options, invocationId));
    discoveryComplete = true;
    candidates = discovery.candidates;
    temporaryRefs = temporaryRefRecords(discovery.temporary_refs, candidates);
    const comparison = compareCleanupSweepDigest(options.digest, repository, candidates);
    await phase(options, "after-digest-recompute", { repository, candidates });
    if (!comparison.matched) {
      report = createRefusedReport({
        repository,
        candidates,
        provided_digest: options.digest,
        refusal_code: comparison.refusal_code,
        digest: comparison.digest,
      });
    } else {
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (candidate.classification !== "eligible") {
          continue;
        }
        try {
          candidates[index] = await executeCandidate(repository, candidate, options, invocationId, temporaryRefs);
        } catch (error) {
          if (error?.completedCandidate) candidates[index] = error.completedCandidate;
          throw error;
        }
      }
      report = createCleanupSweepReport({
        mode: "execute",
        status: "completed",
        repository,
        authorization: { schema_version: 1, digest: options.digest, provided_digest: options.digest, matched: true, refusal_code: null },
        candidates,
        report_errors: [],
        confirmation: { argv: null, shell_command: null },
        exit_code: candidates.some((candidate) => candidate.attempted_cleanup && candidate.classification === "failed") ? 1 : 0,
      });
    }
  } catch {
    report = createReportLevelFailure({
      mode: "execute",
      code: discoveryComplete ? "FAILED_ORCHESTRATION" : "FAILED_FACTORY_ROOT",
      repository,
      candidates,
      provided_digest: options.digest,
    });
  }
  return finalizeAfterTemporaryRefs(report, { ...options, repository, candidates, temporaryRefs, mode: "execute", providedDigest: options.digest });
}

export function resolveCleanupSweepRepository(options = {}) {
  const gitRunner = options.gitRunner ?? git;
  const selected = resolve(options.cwd ?? process.cwd());
  const rootResult = gitRunner(selected, ["rev-parse", "--show-toplevel"]);
  if (!rootResult?.ok || !rootResult.stdout?.trim()) throw new Error("repository root is unavailable");
  const rootPath = inspectPath(rootResult.stdout.trim(), "realpath", options);
  const commonResult = gitRunner(rootPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const objectResult = gitRunner(rootPath, ["rev-parse", "--show-object-format"]);
  if (!commonResult?.ok || !commonResult.stdout?.trim() || !objectResult?.ok) throw new Error("repository identity is unavailable");
  const commonPath = inspectPath(resolve(rootPath, commonResult.stdout.trim()), "realpath", options);
  const rootStat = inspectPath(rootPath, "stat", options);
  const commonStat = inspectPath(commonPath, "stat", options);
  if (!rootStat.isDirectory() || !commonStat.isDirectory()) throw new Error("repository controls are not directories");
  return createRepositoryIdentity({
    schema_version: 1,
    root_path: rootPath,
    root_device: String(rootStat.dev),
    root_inode: String(rootStat.ino),
    git_common_dir_path: commonPath,
    git_common_dir_device: String(commonStat.dev),
    git_common_dir_inode: String(commonStat.ino),
    object_format: objectResult.stdout.trim(),
  });
}

async function executeCandidate(repository, authorized, options, invocationId, temporaryRefs) {
  const runDir = join(repository.root_path, ".opencode", "factory", authorized.entry_name);
  const acquire = options.acquireRunLock ?? ((path, callback, lockOptions) => withRunJsonLock(path, callback, lockOptions));
  let completedCandidate = null;
  try {
    return await acquire(runDir, async () => {
      await phase(options, "after-candidate-lock", { entry_name: authorized.entry_name });
      const reclassified = classifyCleanupSweepCandidate(repository.root_path, authorized.entry_name, {
        ...discoveryOptions(options, invocationId),
        heldRunId: authorized.run_id,
      });
      if (reclassified.temporary_ref) {
        temporaryRefs.push({ ref: reclassified.temporary_ref, expected_oid: reclassified.candidate.evidence.pr.base_sha });
      }
      const normalized = normalizeHeldLockEvidence(reclassified.candidate);
      await phase(options, "after-candidate-revalidation", { entry_name: authorized.entry_name, candidate: normalized });
      if (authorizationRecord(normalized) !== authorizationRecord(authorized)) return changedCandidate(normalized);

      let run;
      try {
        run = validateRun(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")));
      } catch {
        return changedCandidate(normalized);
      }
      const branches = normalized.evidence.branches.filter((item) => item.state === "verified-ancestor");
      try {
        const cleanup = cleanupRunLocked(runDir, run, {
          mode: "cleanup-sweep",
          repo: repository.root_path,
          force: false,
          dryRun: false,
          expectedRunHash: normalized.evidence.run.hash,
          expectedBranchHeads: branches,
          fetchedBaseRef: reclassified.temporary_ref,
          fetchedBase: { ref: reclassified.temporary_ref, oid: normalized.evidence.pr.base_sha },
          gitRunner: options.gitRunner,
          removeRunDir: options.removeRunDir,
          checkWorktreeIdentity: options.checkWorktreeIdentity,
          physicalPath: options.physicalPath,
          phaseHook: options.phaseHook,
        });
        completedCandidate = candidateFromCleanup(normalized, cleanup);
        return completedCandidate;
      } catch (error) {
        if (error instanceof CleanupRunUnexpectedError || error?.code === "FAILED_CLEANUP_UNEXPECTED") {
          return unexpectedCleanupCandidate(normalized, error.cleanup, runDir);
        }
        return changedCandidate(normalized);
      }
    }, { reclaimMode: "never" });
  } catch (error) {
    if (completedCandidate) {
      const orchestrationError = new Error("candidate lock orchestration failed after cleanup", { cause: error });
      orchestrationError.completedCandidate = completedCandidate;
      throw orchestrationError;
    }
    if (error instanceof RunJsonLockContendedError || error?.code === "RUN_JSON_LOCK_CONTENDED") {
      const evidence = structuredClone(authorized.evidence);
      evidence.run_lock = { observed_before_acquire: "present", held_by_sweep: false };
      return replacementCandidate({ ...authorized, evidence }, "skipped", ["SKIPPED_RUN_LOCK_CONTENDED"]);
    }
    return replacementCandidate(authorized, "failed", ["FAILED_INSPECTION"], { failure_stage: "inspection" });
  }
}

function candidateFromCleanup(candidate, cleanup) {
  normalizePartialCleanup(cleanup);
  const reasonCodes = [];
  if (cleanup.worktrees.some((item) => item.outcome === "failed")) reasonCodes.push("FAILED_CLEANUP_WORKTREE");
  if (cleanup.branches.some((item) => item.outcome === "failed")) reasonCodes.push("FAILED_CLEANUP_BRANCH");
  if (cleanup.run_dir.outcome === "failed") reasonCodes.push("FAILED_CLEANUP_RUN_DIR");
  if (cleanup.run_dir.outcome === "retained") reasonCodes.push("RETAINED_AFTER_PARTIAL_FAILURE");
  const success = reasonCodes.length === 0;
  return replacementCandidate(candidate, success ? "deleted" : "failed", success ? ["DELETED"] : reasonCodes, {
    failure_stage: success ? null : "cleanup",
    attempted_cleanup: true,
    cleanup,
  });
}

function unexpectedCleanupCandidate(candidate, cleanup, runDir) {
  const value = cleanup ?? { worktrees: [], branches: [], run_dir: { path: runDir, outcome: "retained", reason_code: "FAILED_CLEANUP_UNEXPECTED" } };
  const hasTargetFailure = value.worktrees.some((item) => item.outcome === "failed") || value.branches.some((item) => item.outcome !== "deleted");
  value.run_dir = { path: value.run_dir?.path ?? runDir, outcome: "retained", reason_code: hasTargetFailure ? "RETAINED_AFTER_PARTIAL_FAILURE" : "FAILED_CLEANUP_UNEXPECTED" };
  normalizePartialCleanup(value);
  return replacementCandidate(candidate, "failed", ["FAILED_CLEANUP_UNEXPECTED"], {
    failure_stage: "cleanup", attempted_cleanup: true, cleanup: value,
  });
}

function normalizePartialCleanup(cleanup) {
  const failedBranches = new Set(cleanup.worktrees.filter((item) => item.outcome === "failed" && item.branch).map((item) => item.branch));
  for (const branch of cleanup.branches) {
    if (branch.outcome === "not-attempted" && failedBranches.has(branch.name)) branch.reason_code = "RETAINED_AFTER_PARTIAL_FAILURE";
  }
}

function changedCandidate(candidate) {
  return replacementCandidate(candidate, "skipped", ["SKIPPED_CHANGED_DURING_EXECUTION"]);
}

function replacementCandidate(candidate, classification, reasonCodes, overrides = {}) {
  return createCandidate({
    entry_name: candidate.entry_name,
    run_id: candidate.run_id,
    classification,
    reason_codes: reasonCodes,
    evidence: candidate.evidence,
    failure_stage: overrides.failure_stage ?? null,
    attempted_cleanup: overrides.attempted_cleanup ?? false,
    cleanup: overrides.cleanup ?? null,
  });
}

function normalizeHeldLockEvidence(candidate) {
  const evidence = structuredClone(candidate.evidence);
  evidence.run_lock = { observed_before_acquire: "missing", held_by_sweep: false };
  return createCandidate({ ...candidate, evidence, evidence_digest: undefined });
}

function authorizationRecord(candidate) {
  return canonicalJson({
    entry_name: candidate.entry_name,
    run_id: candidate.run_id,
    classification: candidate.classification,
    reason_codes: candidate.reason_codes,
    evidence_digest: candidate.evidence_digest,
  });
}

function discoveryOptions(options, invocationId) {
  return {
    githubRunner: options.githubRunner,
    gitRunner: options.gitRunner,
    fsInspector: options.fsInspector,
    inspectProcess: options.inspectProcess,
    processOptions: { ...options, ...options.processOptions },
    clock: options.clock,
    invocationId,
  };
}

function temporaryRefRecords(refs, candidates) {
  return refs.map((ref) => {
    const candidate = candidates.find((item) => item.run_id && ref.endsWith(sha256RunId(item.run_id)));
    return { ref, expected_oid: candidate?.evidence?.pr?.base_sha ?? null };
  });
}

function sha256RunId(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function finalizeAfterTemporaryRefs(report, context) {
  try {
    await cleanupTemporaryRefs(context.temporaryRefs, context);
    return report;
  } catch {
    return createReportLevelFailure({
      mode: context.mode,
      code: "FAILED_TEMP_REF_CLEANUP",
      repository: context.repository,
      candidates: context.candidates,
      provided_digest: context.providedDigest ?? null,
    });
  }
}

async function cleanupTemporaryRefs(records, options) {
  const unique = [...new Map(records.filter((item) => item?.ref).map((item) => [item.ref, item])).values()].sort((a, b) => utf8(a.ref, b.ref));
  const gitRunner = options.gitRunner ?? git;
  for (const record of unique) {
    await phase(options, "before-temp-ref-delete", { ref: record.ref, expected_oid: record.expected_oid });
    const present = gitRunner(options.repository.root_path, ["show-ref", "--verify", "--quiet", record.ref]);
    if (!present?.ok) {
      if (present?.status === 1) continue;
      throw new Error("temporary ref could not be inspected");
    }
    const current = gitRunner(options.repository.root_path, ["rev-parse", "--verify", `${record.ref}^{commit}`]);
    if (!current?.ok) throw new Error("temporary ref could not be resolved");
    if (!record.expected_oid || current.stdout.trim() !== record.expected_oid) throw new Error("temporary ref changed");
    const remove = options.deleteTemporaryRef
      ? await options.deleteTemporaryRef(options.repository.root_path, record.ref, record.expected_oid)
      : gitRunner(options.repository.root_path, ["update-ref", "-d", record.ref, record.expected_oid]);
    if (remove === false || (remove && typeof remove === "object" && remove.ok !== true)) throw new Error("temporary ref deletion failed");
  }
}

function inspectPath(path, operation, options) {
  const fallback = () => operation === "realpath" ? realpathSync(path) : statSync(path);
  const inspector = options.fsInspector;
  if (typeof inspector === "function") {
    const result = inspector(path, { operation, inspectDefault: fallback });
    return result === undefined ? fallback() : result;
  }
  if (inspector && typeof inspector[operation] === "function") return inspector[operation](path, { inspectDefault: fallback });
  return fallback();
}

function invocationIdentifier(options) {
  const value = typeof options.invocationId === "function" ? options.invocationId() : options.invocationId;
  return value ?? (typeof options.uuid === "function" ? options.uuid() : randomUUID());
}

async function phase(options, name, context) {
  if (typeof options.phaseHook === "function") await options.phaseHook(name, context);
}
