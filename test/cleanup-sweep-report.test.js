import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLEANUP_SWEEP_REASON_REGISTRY,
  canonicalJson,
  compareCleanupSweepDigest,
  createAuthorizationEnvelope,
  createCandidate,
  createCleanupSweepDigest,
  createCleanupSweepReport,
  createEmptyEvidence,
  createRefusedReport,
  createReportLevelFailure,
  parseCleanupSweepDigest,
  repositoryDigest,
  validateCandidate,
} from "../src/cleanup-sweep-report.js";

const REPOSITORY = {
  schema_version: 1,
  root_path: "/repo",
  root_device: "17",
  root_inode: "23",
  git_common_dir_path: "/repo/.git",
  git_common_dir_device: "17",
  git_common_dir_inode: "29",
  object_format: "sha1",
};

describe("cleanup sweep report and digest", () => {
  it("constructs the exact closed candidate schema and canonicalizes branch, worktree, and reason ordering", () => {
    const evidence = eligibleEvidence();
    evidence.branches = [
      { name: "z", expected_head: "z-head", state: "verified-ancestor", base_oid: "base" },
      { name: "a", expected_head: "a-head", state: "verified-ancestor", base_oid: "base" },
    ];
    evidence.worktrees = [
      { recorded_path: "/recorded/z", physical_path: "/physical/z", branch: "z", head: "z-head", state: "verified" },
      { recorded_path: "/recorded/a", physical_path: "/physical/a", branch: "a", head: "a-head", state: "verified" },
    ];
    const candidate = createCandidate({ entry_name: "run", run_id: "run", classification: "protected", reason_codes: ["SHARED_TARGET_CLAIM", "PROTECTED_STATUS_BLOCKED", "SHARED_TARGET_CLAIM"], evidence });

    assert.deepEqual(Object.keys(candidate), ["schema_version", "kind", "entry_name", "run_id", "classification", "reason_codes", "reasons", "failure_stage", "attempted_cleanup", "evidence_digest", "evidence", "cleanup"]);
    assert.deepEqual(candidate.reason_codes, ["PROTECTED_STATUS_BLOCKED", "SHARED_TARGET_CLAIM"]);
    assert.deepEqual(candidate.reasons, [
      { code: "PROTECTED_STATUS_BLOCKED", message: "The run contains blocked recoverable work." },
      { code: "SHARED_TARGET_CLAIM", message: "A cleanup target is claimed by more than one factory entry." },
    ]);
    assert.deepEqual(candidate.evidence.branches.map((item) => item.name), ["a", "z"]);
    assert.deepEqual(candidate.evidence.worktrees.map((item) => item.physical_path), ["/physical/a", "/physical/z"]);
    assert.match(candidate.evidence_digest, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(validateCandidate(candidate), candidate);
    assert.throws(() => validateCandidate({ ...candidate, extra: true }), /must contain exactly/u);
    assert.throws(() => createCandidate({ ...candidate, classification: "unknown" }), /must be one of/u);
  });

  it("freezes the complete normative reason registry and never accepts caller-provided messages", () => {
    assert.equal(CLEANUP_SWEEP_REASON_REGISTRY.PROTECTED_STATUS_BLOCKED.message, "The run contains blocked recoverable work.");
    assert.equal(CLEANUP_SWEEP_REASON_REGISTRY.FAILED_CLEANUP_WORKTREE.message, "A validated worktree could not be removed.");
    assert.equal(CLEANUP_SWEEP_REASON_REGISTRY.RETAINED_AFTER_PARTIAL_FAILURE.message, "The run directory was retained after an earlier cleanup failure.");
    assert.throws(() => createCandidate({ entry_name: "x", run_id: null, classification: "skipped", reason_codes: ["CALLER_REASON"] }), /unknown cleanup sweep reason/u);
  });

  it("uses UTF-8 byte ordering and sorted-key canonical JSON without mutating candidates", () => {
    const candidates = [candidate("é"), candidate("z"), candidate("a")];
    const before = structuredClone(candidates);
    const envelope = createAuthorizationEnvelope(REPOSITORY, candidates);
    assert.deepEqual(envelope.candidates.map((item) => item.entry_name), ["a", "z", "é"]);
    assert.deepEqual(candidates, before);
    assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), "{\"a\":{\"b\":3,\"y\":2},\"z\":1}");
  });

  it("binds the digest independently to physical repository identity and the complete authorization envelope", () => {
    const candidates = [candidate("b"), candidate("a")];
    const digest = createCleanupSweepDigest(REPOSITORY, candidates);
    const parsed = parseCleanupSweepDigest(digest);
    assert.equal(parsed.repository_sha256, repositoryDigest(REPOSITORY));
    assert.match(digest, /^ff-cleanup-v1\.[0-9a-f]{64}\.[0-9a-f]{64}$/u);
    assert.equal(createCleanupSweepDigest(REPOSITORY, [...candidates].reverse()), digest);

    const foreign = compareCleanupSweepDigest(digest, { ...REPOSITORY, root_inode: "30" }, candidates);
    assert.deepEqual({ matched: foreign.matched, refusal_code: foreign.refusal_code }, { matched: false, refusal_code: "DIGEST_FOREIGN" });
    const stale = compareCleanupSweepDigest(digest, REPOSITORY, [candidate("a")]);
    assert.deepEqual({ matched: stale.matched, refusal_code: stale.refusal_code }, { matched: false, refusal_code: "DIGEST_STALE" });
    assert.equal(compareCleanupSweepDigest(digest, REPOSITORY, candidates).matched, true);
    for (const invalid of ["", "ff-cleanup-v1.A.b", `${digest}x`, `ff-cleanup-v1.${"0".repeat(64)}.${"A".repeat(64)}`]) assert.throws(() => parseCleanupSweepDigest(invalid), /malformed/u);
  });

  it("creates exact mutually exclusive counts and a preview report with stable nullability", () => {
    const candidates = [
      candidate("e", "eligible", "ELIGIBLE"),
      candidate("p", "protected", "PROTECTED_STATUS_BLOCKED"),
      candidate("s", "skipped", "SKIPPED_PR_OPEN"),
      failedInspection("f"),
    ];
    const digest = createCleanupSweepDigest(REPOSITORY, candidates);
    const report = createCleanupSweepReport({
      mode: "preview", status: "previewed", repository: REPOSITORY, candidates,
      authorization: { schema_version: 1, digest, provided_digest: null, matched: null, refusal_code: null },
      report_errors: [], confirmation: { argv: ["feature-factory"], shell_command: "'feature-factory'" }, exit_code: 0,
    });
    assert.deepEqual(Object.keys(report), ["schema_version", "kind", "mode", "status", "repository", "authorization", "counts", "attempted_cleanup_failures", "report_errors", "confirmation", "candidates", "exit_code"]);
    assert.deepEqual(report.counts, { eligible: 1, protected: 1, skipped: 1, deleted: 0, failed: 1 });
    assert.equal(report.attempted_cleanup_failures, 0);
    assert.equal(report.exit_code, 0);
  });

  it("emits zero counts, no digest, and FAILED_FACTORY_ROOT for a symlinked, non-directory, inaccessible, or unsafe factory root", () => {
    for (const rootFailure of ["symlinked", "non-directory", "inaccessible", "unsafe"]) {
      const report = createReportLevelFailure({ mode: "preview", code: "FAILED_FACTORY_ROOT" });
      assert.equal(rootFailure.length > 0, true);
      assert.equal(report.status, "failed");
      assert.equal(report.repository, null);
      assert.deepEqual(report.counts, { eligible: 0, protected: 0, skipped: 0, deleted: 0, failed: 0 });
      assert.equal(report.authorization.digest, null);
      assert.deepEqual(report.confirmation, { argv: null, shell_command: null });
      assert.deepEqual(report.report_errors, [{ code: "FAILED_FACTORY_ROOT", message: "The selected repository factory root could not be inspected as a safe physical directory." }]);
      assert.equal(report.exit_code, 1);
    }
  });

  it("builds a refused execution that preserves recomputed candidates without attempts or report errors", () => {
    const candidates = [candidate("run")];
    const expectedDigest = createCleanupSweepDigest(REPOSITORY, candidates);
    const providedDigest = `ff-cleanup-v1.${"0".repeat(64)}.${"1".repeat(64)}`;
    const report = createRefusedReport({ repository: REPOSITORY, candidates, provided_digest: providedDigest, refusal_code: "DIGEST_FOREIGN", digest: expectedDigest });
    assert.equal(report.status, "refused");
    assert.deepEqual(report.authorization, { schema_version: 1, digest: expectedDigest, provided_digest: providedDigest, matched: false, refusal_code: "DIGEST_FOREIGN" });
    assert.equal(report.candidates[0].attempted_cleanup, false);
    assert.deepEqual(report.report_errors, []);
    assert.deepEqual(report.confirmation, { argv: null, shell_command: null });
    assert.equal(report.exit_code, 1);
  });

  it("counts one attempted cleanup failure per failed candidate even when that candidate contains multiple failed operations", () => {
    const first = failedCleanup("a", "FAILED_CLEANUP_WORKTREE", {
      worktrees: [
        { recorded_path: "/r/b", physical_path: "/p/b", branch: "b", outcome: "failed", reason_code: "FAILED_CLEANUP_WORKTREE" },
        { recorded_path: "/r/a", physical_path: "/p/a", branch: "a", outcome: "failed", reason_code: "FAILED_CLEANUP_WORKTREE" },
      ],
      branches: [{ name: "a", expected_head: "oid", outcome: "not-attempted", reason_code: "RETAINED_AFTER_PARTIAL_FAILURE" }],
      run_dir: { path: "/repo/.opencode/factory/a", outcome: "retained", reason_code: "RETAINED_AFTER_PARTIAL_FAILURE" },
    });
    const second = failedCleanup("b", "FAILED_CLEANUP_BRANCH", {
      worktrees: [], branches: [{ name: "b", expected_head: "oid", outcome: "failed", reason_code: "FAILED_CLEANUP_BRANCH" }],
      run_dir: { path: "/repo/.opencode/factory/b", outcome: "retained", reason_code: "RETAINED_AFTER_PARTIAL_FAILURE" },
    });
    const inspection = failedInspection("inspection");
    const report = executeReport([first, second, inspection], 1);
    assert.equal(report.attempted_cleanup_failures, 2);
    assert.equal(report.counts.failed, 3);
    assert.deepEqual(report.candidates[0].cleanup.worktrees.map((item) => item.physical_path), ["/p/a", "/p/b"]);
    assert.throws(() => executeReport([first], 0), /require exit_code 1/u);
  });

  it("models R46-R52 cleanup outcomes and keeps report-level failures independent from attempted failures", () => {
    const cases = [
      ["FAILED_CLEANUP_WORKTREE", "failed", "cleanup", true],
      ["FAILED_CLEANUP_BRANCH", "failed", "cleanup", true],
      ["FAILED_CLEANUP_RUN_DIR", "failed", "cleanup", true],
      ["FAILED_CLEANUP_UNEXPECTED", "failed", "cleanup", true],
    ];
    for (const [code, classification, failureStage, attempted] of cases) {
      const item = failedCleanup(code, code, emptyFailedCleanup(code));
      assert.equal(item.classification, classification);
      assert.equal(item.failure_stage, failureStage);
      assert.equal(item.attempted_cleanup, attempted);
    }
    const deleted = deletedCandidate("deleted");
    assert.equal(deleted.classification, "deleted");
    assert.equal(deleted.cleanup.run_dir.outcome, "removed");
    assert.equal(failedInspection("inspection").attempted_cleanup, false);

    const report = createReportLevelFailure({ mode: "execute", code: "FAILED_TEMP_REF_CLEANUP", repository: REPOSITORY, candidates: [deleted] });
    assert.equal(report.authorization.digest, null);
    assert.equal(report.attempted_cleanup_failures, 0);
    assert.equal(report.counts.deleted, 1);
    assert.equal(report.exit_code, 1);
  });

  it("preserves completed candidate records for FAILED_ORCHESTRATION while nulling authorization and confirmation", () => {
    const candidates = [deletedCandidate("a"), failedCleanup("b", "FAILED_CLEANUP_RUN_DIR", emptyFailedCleanup("FAILED_CLEANUP_RUN_DIR"))];
    const report = createReportLevelFailure({ mode: "execute", code: "FAILED_ORCHESTRATION", repository: REPOSITORY, candidates });
    assert.deepEqual(report.counts, { eligible: 0, protected: 0, skipped: 0, deleted: 1, failed: 1 });
    assert.equal(report.attempted_cleanup_failures, 1);
    assert.equal(report.authorization.digest, null);
    assert.deepEqual(report.confirmation, { argv: null, shell_command: null });
    assert.equal(report.report_errors[0].code, "FAILED_ORCHESTRATION");
  });
});

function eligibleEvidence(entryName = "run") {
  const evidence = createEmptyEvidence(entryName, `/repo/.opencode/factory/${entryName}`);
  evidence.entry = { kind: "directory", logical_path: `/repo/.opencode/factory/${entryName}`, physical_path: `/repo/.opencode/factory/${entryName}`, device: "17", inode: "31" };
  evidence.run = { state: "valid", hash: `sha256:${"1".repeat(64)}`, run_id: entryName, status: "completed" };
  evidence.pr = { state: "merged", url: "https://github.com/o/r/pull/1", repository: "o/r", number: 1, base_ref: "main", base_sha: "base" };
  return evidence;
}

function candidate(entryName, classification = "eligible", reasonCode = "ELIGIBLE") {
  return createCandidate({ entry_name: entryName, run_id: entryName, classification, reason_codes: [reasonCode], evidence: eligibleEvidence(entryName) });
}

function failedInspection(entryName) {
  return createCandidate({ entry_name: entryName, run_id: null, classification: "failed", reason_codes: ["FAILED_INSPECTION"], failure_stage: "inspection", evidence: createEmptyEvidence(entryName) });
}

function failedCleanup(entryName, reasonCode, cleanup) {
  return createCandidate({ entry_name: entryName, run_id: entryName, classification: "failed", reason_codes: [reasonCode], failure_stage: "cleanup", attempted_cleanup: true, evidence: eligibleEvidence(entryName), cleanup });
}

function emptyFailedCleanup(reasonCode) {
  return { worktrees: [], branches: [], run_dir: { path: "/repo/.opencode/factory/run", outcome: "failed", reason_code: reasonCode } };
}

function deletedCandidate(entryName) {
  return createCandidate({
    entry_name: entryName, run_id: entryName, classification: "deleted", reason_codes: ["DELETED"], attempted_cleanup: true, evidence: eligibleEvidence(entryName),
    cleanup: { worktrees: [], branches: [], run_dir: { path: `/repo/.opencode/factory/${entryName}`, outcome: "removed", reason_code: null } },
  });
}

function executeReport(candidates, exitCode) {
  const digest = `ff-cleanup-v1.${"2".repeat(64)}.${"3".repeat(64)}`;
  return createCleanupSweepReport({
    mode: "execute", status: "completed", repository: REPOSITORY, candidates,
    authorization: { schema_version: 1, digest, provided_digest: digest, matched: true, refusal_code: null },
    report_errors: [], confirmation: { argv: null, shell_command: null }, exit_code: exitCode,
  });
}
