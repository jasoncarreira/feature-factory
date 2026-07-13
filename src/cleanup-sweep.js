import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupRunLocked, CleanupRunChangedError, CleanupRunUnexpectedError } from "./factory.js";
import { git } from "./git.js";
import { github } from "./github.js";
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
import { canonicalizeGithubPrUrl } from "./refs.js";
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
    const tracked = trackedDiscoveryOptions(options, invocationId, temporaryRefs);
    const discovery = discoverCleanupSweepCandidates(repository.root_path, tracked.options);
    discoveryComplete = true;
    candidates = discovery.candidates;
    temporaryRefs.push(...temporaryRefRecords(discovery.temporary_refs, candidates, repository, tracked.prBaseOids));
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
    const tracked = trackedDiscoveryOptions(options, invocationId, temporaryRefs);
    const discovery = discoverCleanupSweepCandidates(repository.root_path, tracked.options);
    discoveryComplete = true;
    candidates = discovery.candidates;
    temporaryRefs.push(...temporaryRefRecords(discovery.temporary_refs, candidates, repository, tracked.prBaseOids));
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
  const rawGitRunner = options.gitRunner ?? git;
  const mutationGitRunner = repositoryGuardedGitRunner(repository, options, rawGitRunner);
  const guardedOptions = { ...options, gitRunner: mutationGitRunner };
  try {
    return await acquire(runDir, async () => {
      await phase(options, "after-candidate-lock", { entry_name: authorized.entry_name });
      let reclassified;
      try {
        reclassified = reclassifyHeldCandidate(repository, authorized, guardedOptions, invocationId, temporaryRefs);
      } catch {
        return inspectionFailureCandidate(authorized);
      }
      let normalized = normalizeHeldLockEvidence(reclassified.candidate);
      if (authorizationRecord(normalized) !== authorizationRecord(authorized)) return changedCandidate(normalized);
      await phase(options, "after-candidate-revalidation", { entry_name: authorized.entry_name, candidate: normalized });

      // The phase hook deliberately opens the last deterministic mutation
      // window. Recompute every authorization field after it, then bind all
      // ancestry checks to the authorized base object rather than a movable ref.
      try {
        reclassified = reclassifyHeldCandidate(repository, authorized, guardedOptions, invocationId, temporaryRefs);
      } catch {
        return inspectionFailureCandidate(normalized);
      }
      normalized = normalizeHeldLockEvidence(reclassified.candidate);
      if (authorizationRecord(normalized) !== authorizationRecord(authorized)) return changedCandidate(normalized);

      const baseRef = reclassified.temporary_ref;
      const baseOid = authorized.evidence.pr.base_sha;
      const baseState = inspectAuthorizedTemporaryRef(repository.root_path, baseRef, baseOid, mutationGitRunner);
      if (baseState === "changed") return changedCandidate(normalized);
      if (baseState !== "matching") return inspectionFailureCandidate(normalized);

      let run;
      try {
        run = validateRun(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")));
      } catch {
        return changedCandidate(normalized);
      }
      const branches = normalized.evidence.branches.filter((item) => item.state === "verified-ancestor");
      let cleanup;
      try {
        cleanup = cleanupRunLocked(runDir, run, {
          mode: "cleanup-sweep",
          repo: repository.root_path,
          force: false,
          dryRun: false,
          expectedRunHash: normalized.evidence.run.hash,
          expectedBranchHeads: branches,
          expectedRunDirectory: normalized.evidence.entry,
          expectedWorktreeRoot: normalized.evidence.worktree_root,
          expectedWorktrees: normalized.evidence.worktrees,
          fetchedBaseRef: baseOid,
          fetchedBase: { ref: baseRef, oid: baseOid },
          gitRunner: guardedCleanupGitRunner(repository.root_path, baseRef, baseOid, mutationGitRunner),
          assertMutationAuthorized: () => assertCandidateMutationAuthorized(repository, authorized, guardedOptions, invocationId, temporaryRefs),
          removeRunDir: options.removeRunDir,
          checkWorktreeIdentity: options.checkWorktreeIdentity,
          physicalPath: options.physicalPath,
          phaseHook: options.phaseHook,
        });
      } catch (error) {
        if (error instanceof CleanupRunChangedError || error?.code === "CLEANUP_EVIDENCE_CHANGED") return changedCandidate(normalized);
        if (error instanceof CleanupRunUnexpectedError || error?.code === "FAILED_CLEANUP_UNEXPECTED") {
          completedCandidate = unexpectedCleanupCandidate(normalized, error.cleanup, runDir);
          return completedCandidate;
        }
        return inspectionFailureCandidate(normalized);
      }
      try {
        completedCandidate = candidateFromCleanup(normalized, cleanup);
      } catch {
        completedCandidate = unexpectedCleanupCandidate(normalized, cleanup, runDir);
      }
      return completedCandidate;
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
  normalizePartialCleanup(cleanup, candidate);
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
  normalizePartialCleanup(value, candidate);
  return replacementCandidate(candidate, "failed", ["FAILED_CLEANUP_UNEXPECTED"], {
    failure_stage: "cleanup", attempted_cleanup: true, cleanup: value,
  });
}

function normalizePartialCleanup(cleanup, candidate) {
  for (const worktree of cleanup.worktrees) {
    if (worktree.branch !== null) continue;
    const authorized = candidate.evidence.worktrees.find((item) => item.physical_path === worktree.physical_path && item.recorded_path === worktree.recorded_path);
    if (authorized?.branch) worktree.branch = authorized.branch;
  }
  const failedBranches = new Set(cleanup.worktrees.filter((item) => item.outcome === "failed" && item.branch).map((item) => item.branch));
  for (const branch of cleanup.branches) {
    if (branch.outcome === "not-attempted" && failedBranches.has(branch.name)) branch.reason_code = "RETAINED_AFTER_PARTIAL_FAILURE";
  }
}

function changedCandidate(candidate) {
  return replacementCandidate(candidate, "skipped", ["SKIPPED_CHANGED_DURING_EXECUTION"]);
}

function inspectionFailureCandidate(candidate) {
  return replacementCandidate(candidate, "failed", ["FAILED_INSPECTION"], { failure_stage: "inspection" });
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

function temporaryRefRecords(refs, candidates, repository, prBaseOids) {
  return refs.map((ref) => {
    const candidate = candidates.find((item) => ref.endsWith(sha256RunId(item.entry_name)));
    const expectedOid = candidate?.evidence?.pr?.base_sha ?? recordedRunBaseOid(repository.root_path, candidate?.entry_name, prBaseOids);
    return { ref, expected_oid: expectedOid ?? null };
  });
}

function trackedDiscoveryOptions(options, invocationId, temporaryRefs) {
  const githubRunner = options.githubRunner ?? github;
  const gitRunner = options.gitRunner ?? git;
  const prBaseOids = new Map();
  let currentBaseOid = null;
  const trackedGithubRunner = (...args) => {
    currentBaseOid = null;
    const result = githubRunner(...args);
    try {
      const body = result?.ok ? JSON.parse(result.stdout) : null;
      if (typeof body?.html_url === "string" && typeof body?.base?.sha === "string") {
        currentBaseOid = body.base.sha;
        prBaseOids.set(canonicalizeGithubPrUrl(body.html_url), currentBaseOid);
      }
    } catch {
      // Invalid responses cannot authorize temporary-ref deletion.
    }
    return result;
  };
  const trackedGitRunner = (cwd, args, commandOptions) => {
    if (args[0] === "check-ref-format" && typeof args[1] === "string" && args[1].startsWith("refs/feature-factory/cleanup-sweep/")) {
      temporaryRefs.push({ ref: args[1], expected_oid: currentBaseOid });
    }
    return gitRunner(cwd, args, commandOptions);
  };
  return {
    options: discoveryOptions({ ...options, githubRunner: trackedGithubRunner, gitRunner: trackedGitRunner }, invocationId),
    prBaseOids,
  };
}

function recordedRunBaseOid(repo, entryName, prBaseOids) {
  if (!entryName) return null;
  try {
    const run = JSON.parse(readFileSync(join(repo, ".opencode", "factory", entryName, "run.json"), "utf8"));
    const urls = [run?.pr_url, run?.terminal_result?.pr_url].filter((value) => typeof value === "string");
    for (const url of urls) {
      const canonical = canonicalizeGithubPrUrl(url);
      if (prBaseOids.has(canonical)) return prBaseOids.get(canonical);
    }
  } catch {
    // Missing authorization is handled as FAILED_TEMP_REF_CLEANUP if the ref exists.
  }
  return null;
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
  const byRef = new Map();
  for (const record of records.filter((item) => item?.ref)) {
    const previous = byRef.get(record.ref);
    byRef.set(record.ref, { ref: record.ref, expected_oid: record.expected_oid ?? previous?.expected_oid ?? null });
  }
  const unique = [...byRef.values()].sort((a, b) => utf8(a.ref, b.ref));
  const rawGitRunner = options.gitRunner ?? git;
  const gitRunner = options.repository ? repositoryGuardedGitRunner(options.repository, options, rawGitRunner) : rawGitRunner;
  let failed = false;
  for (const record of unique) {
    try {
      await phase(options, "before-temp-ref-delete", { ref: record.ref, expected_oid: record.expected_oid });
      const present = gitRunner(options.repository.root_path, ["show-ref", "--verify", "--quiet", record.ref]);
      if (!present?.ok) {
        if (present?.status === 1) continue;
        failed = true;
        continue;
      }
      const current = gitRunner(options.repository.root_path, ["rev-parse", "--verify", `${record.ref}^{commit}`]);
      if (!current?.ok || !record.expected_oid || current.stdout.trim() !== record.expected_oid) {
        failed = true;
        continue;
      }
      let remove;
      if (options.deleteTemporaryRef) {
        assertRepositoryIdentity(options.repository, options, rawGitRunner);
        remove = await options.deleteTemporaryRef(options.repository.root_path, record.ref, record.expected_oid);
      } else {
        remove = gitRunner(options.repository.root_path, ["update-ref", "-d", record.ref, record.expected_oid]);
      }
      if (remove === false || (remove && typeof remove === "object" && remove.ok !== true)) failed = true;
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error("one or more temporary refs could not be removed safely");
}

function reclassifyHeldCandidate(repository, authorized, options, invocationId, temporaryRefs) {
  const registerTemporaryRef = (ref) => temporaryRefs.push({ ref, expected_oid: authorized.evidence.pr.base_sha });
  const result = classifyCleanupSweepCandidate(repository.root_path, authorized.entry_name, {
    ...discoveryOptions(options, invocationId),
    heldRunId: authorized.run_id,
    registerTemporaryRef,
  });
  return result;
}

function inspectAuthorizedTemporaryRef(repo, ref, expectedOid, gitRunner) {
  if (!ref || !expectedOid) return "uncertain";
  try {
    const resolved = gitRunner(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (!resolved?.ok) return "uncertain";
    return resolved.stdout.trim() === expectedOid ? "matching" : "changed";
  } catch {
    return "uncertain";
  }
}

function guardedCleanupGitRunner(repo, baseRef, baseOid, gitRunner) {
  return (cwd, args, commandOptions) => {
    if (args[0] === "merge-base" && args[1] === "--is-ancestor" && args[3] === baseOid) {
      const state = inspectAuthorizedTemporaryRef(repo, baseRef, baseOid, gitRunner);
      if (state !== "matching") return { ok: false, status: 2, stdout: "", stderr: "", command: null, signal: null };
    }
    return gitRunner(cwd, args, commandOptions);
  };
}

function assertCandidateMutationAuthorized(repository, authorized, options, invocationId, temporaryRefs) {
  const reclassified = reclassifyHeldCandidate(repository, authorized, options, invocationId, temporaryRefs);
  const normalized = normalizeHeldLockEvidence(reclassified.candidate);
  if (sidecarAuthorizationRecord(normalized) !== sidecarAuthorizationRecord(authorized)) throw new CleanupRunChangedError();
}

function sidecarAuthorizationRecord(candidate) {
  return canonicalJson({
    entry_name: candidate.entry_name,
    run_id: candidate.run_id,
    entry: candidate.evidence.entry,
    run: candidate.evidence.run,
    factory_lock: candidate.evidence.factory_lock,
    heartbeat: candidate.evidence.heartbeat,
    process: candidate.evidence.process,
    launch_claim: candidate.evidence.launch_claim,
  });
}

function repositoryGuardedGitRunner(repository, options, gitRunner) {
  return (cwd, args, commandOptions) => {
    if (isCleanupGitMutation(args)) {
      try {
        assertRepositoryIdentity(repository, options, gitRunner);
      } catch {
        return { ok: false, status: 2, stdout: "", stderr: "", command: null, signal: null, cleanupEvidenceChanged: true };
      }
    }
    return gitRunner(cwd, args, commandOptions);
  };
}

function isCleanupGitMutation(args) {
  return args[0] === "fetch" || args[0] === "update-ref"
    || args[0] === "worktree" && ["move", "remove"].includes(args[1]);
}

function assertRepositoryIdentity(expected, options, gitRunner) {
  const current = resolveCleanupSweepRepository({ ...options, cwd: expected.root_path, gitRunner });
  if (canonicalJson(current) !== canonicalJson(expected)) throw new CleanupRunChangedError();
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
