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
      { recorded_path: "/recorded/z", physical_path: "/physical/z", device: "17", inode: "42", branch: "z", head: "z-head", state: "verified" },
      { recorded_path: "/recorded/a", physical_path: "/physical/a", device: "17", inode: "41", branch: "a", head: "a-head", state: "verified" },
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
    const identityEvidence = eligibleEvidence("a");
    identityEvidence.worktrees = [{ recorded_path: "/recorded/a", physical_path: "/physical/a", device: "17", inode: "41", branch: "a", head: "a-head", state: "verified" }];
    const changedIdentityEvidence = structuredClone(identityEvidence);
    changedIdentityEvidence.worktrees[0].inode = "42";
    const identityCandidate = createCandidate({ entry_name: "a", run_id: "a", classification: "eligible", reason_codes: ["ELIGIBLE"], evidence: identityEvidence });
    const changedIdentityCandidate = createCandidate({ entry_name: "a", run_id: "a", classification: "eligible", reason_codes: ["ELIGIBLE"], evidence: changedIdentityEvidence });
    assert.notEqual(createCleanupSweepDigest(REPOSITORY, [identityCandidate]), createCleanupSweepDigest(REPOSITORY, [changedIdentityCandidate]));
    const launchClaimEvidence = eligibleEvidence("claim");
    launchClaimEvidence.launch_claim = { state: "live-matching", hash: `sha256:${"a".repeat(64)}`, dir_device: "17", dir_inode: "50", file_device: "17", file_inode: "51" };
    const changedLaunchClaimEvidence = structuredClone(launchClaimEvidence);
    changedLaunchClaimEvidence.launch_claim.file_inode = "52";
    const launchClaimCandidate = createCandidate({ entry_name: "claim", run_id: "claim", classification: "protected", reason_codes: ["PROTECTED_LIVE_LAUNCH_CLAIM"], evidence: launchClaimEvidence });
    const changedLaunchClaimCandidate = createCandidate({ entry_name: "claim", run_id: "claim", classification: "protected", reason_codes: ["PROTECTED_LIVE_LAUNCH_CLAIM"], evidence: changedLaunchClaimEvidence });
    assert.notEqual(createCleanupSweepDigest(REPOSITORY, [launchClaimCandidate]), createCleanupSweepDigest(REPOSITORY, [changedLaunchClaimCandidate]));
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

  it("rejects every invalid candidate mutation and failure-stage cross-field state", () => {
    const successfulCleanup = cleanupResult("run");
    const failedDetails = emptyFailedCleanup("FAILED_CLEANUP_RUN_DIR");
    const invalid = [
      ["cleanup failure without an attempt", { classification: "failed", failure_stage: "cleanup", attempted_cleanup: false, cleanup: null }, /cleanup-failed candidate must be attempted with cleanup details/u],
      ["cleanup failure with details but no attempt", { classification: "failed", failure_stage: "cleanup", attempted_cleanup: false, cleanup: failedDetails }, /cleanup-failed candidate must be attempted with cleanup details/u],
      ["cleanup failure without details", { classification: "failed", failure_stage: "cleanup", attempted_cleanup: true, cleanup: null }, /cleanup-failed candidate must be attempted with cleanup details/u],
      ["inspection failure with an attempt", { classification: "failed", failure_stage: "inspection", attempted_cleanup: true, cleanup: successfulCleanup }, /inspection-failed candidate must be unattempted with null cleanup/u],
      ["inspection failure with attempt but no details", { classification: "failed", failure_stage: "inspection", attempted_cleanup: true, cleanup: null }, /inspection-failed candidate must be unattempted with null cleanup/u],
      ["inspection failure with details", { classification: "failed", failure_stage: "inspection", attempted_cleanup: false, cleanup: successfulCleanup }, /inspection-failed candidate must be unattempted with null cleanup/u],
      ["failed without a stage", { classification: "failed", failure_stage: null, attempted_cleanup: false, cleanup: null }, /failed candidate requires inspection or cleanup failure_stage/u],
      ["eligible mutation", { classification: "eligible", failure_stage: null, attempted_cleanup: true, cleanup: successfulCleanup }, /attempted cleanup is allowed only/u],
      ["eligible attempt without details", { classification: "eligible", failure_stage: null, attempted_cleanup: true, cleanup: null }, /attempted cleanup is allowed only/u],
      ["skipped mutation details", { classification: "skipped", failure_stage: null, attempted_cleanup: false, cleanup: failedDetails }, /attempted cleanup is allowed only/u],
      ["non-failed candidate with failure stage", { classification: "protected", failure_stage: "inspection", attempted_cleanup: false, cleanup: null }, /only a failed candidate may have failure_stage/u],
      ["deleted without an attempt", { classification: "deleted", failure_stage: null, attempted_cleanup: false, cleanup: null }, /deleted candidate must be attempted with cleanup details/u],
      ["deleted with details but no attempt", { classification: "deleted", failure_stage: null, attempted_cleanup: false, cleanup: successfulCleanup }, /deleted candidate must be attempted with cleanup details/u],
      ["deleted attempt without details", { classification: "deleted", failure_stage: null, attempted_cleanup: true, cleanup: null }, /deleted candidate must be attempted with cleanup details/u],
      ["deleted with failure stage", { classification: "deleted", failure_stage: "cleanup", attempted_cleanup: true, cleanup: successfulCleanup }, /only a failed candidate may have failure_stage/u],
      ["deleted with failed worktree", { classification: "deleted", failure_stage: null, attempted_cleanup: true, cleanup: { ...successfulCleanup, worktrees: [{ recorded_path: "/r", physical_path: "/p", branch: "b", outcome: "failed", reason_code: "FAILED_CLEANUP_WORKTREE" }], run_dir: { path: "/run", outcome: "retained", reason_code: "RETAINED_AFTER_PARTIAL_FAILURE" } } }, /deleted candidate requires wholly successful cleanup outcomes/u],
      ["deleted with unattempted branch", { classification: "deleted", failure_stage: null, attempted_cleanup: true, cleanup: { ...successfulCleanup, worktrees: [{ recorded_path: "/r", physical_path: "/p", branch: "b", outcome: "failed", reason_code: "FAILED_CLEANUP_WORKTREE" }], branches: [{ name: "b", expected_head: "oid", outcome: "not-attempted", reason_code: "RETAINED_AFTER_PARTIAL_FAILURE" }], run_dir: { path: "/run", outcome: "retained", reason_code: "RETAINED_AFTER_PARTIAL_FAILURE" } } }, /deleted candidate requires wholly successful cleanup outcomes/u],
      ["deleted with retained run directory", { classification: "deleted", failure_stage: null, attempted_cleanup: true, cleanup: { ...successfulCleanup, run_dir: { path: "/run", outcome: "retained", reason_code: "FAILED_CLEANUP_UNEXPECTED" } } }, /deleted candidate requires wholly successful cleanup outcomes/u],
    ];
    for (const [label, overrides, expected] of invalid) {
      assert.throws(() => createCandidate(candidateInput("run", overrides)), expected, label);
    }
    assert.throws(
      () => createCandidate(candidateInput("run", { classification: "failed", failure_stage: "cleanup", attempted_cleanup: true, cleanup: { ...failedDetails, run_dir: { path: "/run", outcome: "failed", reason_code: null } } })),
      /unsuccessful outcome requires reason_code/u,
    );
    assert.throws(
      () => createCandidate(candidateInput("run", { classification: "deleted", attempted_cleanup: true, cleanup: { ...successfulCleanup, run_dir: { path: "/run", outcome: "removed", reason_code: "DELETED" } } })),
      /successful outcome requires null reason_code/u,
    );
  });

  it("rejects wholly successful failed candidates and every order-inconsistent cleanup outcome", () => {
    const successful = cleanupResult("run");
    const failedWorktree = { recorded_path: "/recorded/run", physical_path: "/physical/run", branch: "run-branch", outcome: "failed", reason_code: "FAILED_CLEANUP_WORKTREE" };
    const failedBranch = { name: "run-branch", expected_head: "oid", outcome: "failed", reason_code: "FAILED_CLEANUP_BRANCH" };
    const notAttemptedBranch = { name: "run-branch", expected_head: "oid", outcome: "not-attempted", reason_code: "RETAINED_AFTER_PARTIAL_FAILURE" };
    const retained = { path: "/repo/.opencode/factory/run", outcome: "retained", reason_code: "RETAINED_AFTER_PARTIAL_FAILURE" };
    const invalid = [
      ["failed classification with wholly successful details", successful, /wholly successful cleanup details require deleted classification/u],
      ["failed worktree followed by run-directory removal", { worktrees: [failedWorktree], branches: [], run_dir: successful.run_dir }, /target failure requires the run directory to be retained/u],
      ["failed worktree followed by run-directory removal failure", { worktrees: [failedWorktree], branches: [], run_dir: { path: "/run", outcome: "failed", reason_code: "FAILED_CLEANUP_RUN_DIR" } }, /target failure requires the run directory to be retained/u],
      ["failed branch followed by run-directory removal", { worktrees: [], branches: [failedBranch], run_dir: successful.run_dir }, /target failure requires the run directory to be retained/u],
      ["not-attempted branch followed by run-directory removal", { worktrees: [failedWorktree], branches: [notAttemptedBranch], run_dir: successful.run_dir }, /target failure requires the run directory to be retained/u],
      ["target failure with wrong retained detail", { worktrees: [failedWorktree], branches: [], run_dir: { ...retained, reason_code: "FAILED_CLEANUP_UNEXPECTED" } }, /target failure requires the run directory to be retained after partial failure/u],
      ["not-attempted branch without failed recorded worktree", { worktrees: [], branches: [notAttemptedBranch], run_dir: retained }, /only after its recorded worktree failed/u],
      ["not-attempted branch with wrong detail", { worktrees: [failedWorktree], branches: [{ ...notAttemptedBranch, reason_code: "FAILED_CLEANUP_BRANCH" }], run_dir: retained }, /not-attempted branch requires retained-after-partial-failure detail/u],
      ["branch deletion after its recorded worktree failed", { worktrees: [failedWorktree], branches: [{ name: "run-branch", expected_head: "oid", outcome: "deleted", reason_code: null }], run_dir: retained }, /branch with a failed recorded worktree must be not-attempted/u],
      ["branch failure after its recorded worktree failed", { worktrees: [failedWorktree], branches: [failedBranch], run_dir: retained }, /branch with a failed recorded worktree must be not-attempted/u],
      ["failed worktree with branch-failure detail", { worktrees: [{ ...failedWorktree, reason_code: "FAILED_CLEANUP_BRANCH" }], branches: [], run_dir: retained }, /failed worktree requires FAILED_CLEANUP_WORKTREE detail/u],
      ["failed branch with worktree-failure detail", { worktrees: [], branches: [{ ...failedBranch, reason_code: "FAILED_CLEANUP_WORKTREE" }], run_dir: retained }, /failed branch requires FAILED_CLEANUP_BRANCH detail/u],
      ["retained run directory without target failure or unexpected detail", { worktrees: [], branches: [], run_dir: retained }, /retained without target failure requires FAILED_CLEANUP_UNEXPECTED detail/u],
      ["failed run-directory removal with wrong detail", { worktrees: [], branches: [], run_dir: { path: "/run", outcome: "failed", reason_code: "FAILED_CLEANUP_UNEXPECTED" } }, /failed run directory removal requires FAILED_CLEANUP_RUN_DIR detail/u],
    ];
    for (const [label, cleanup, expected] of invalid) {
      assert.throws(
        () => createCandidate(candidateInput("run", { classification: "failed", reason_codes: ["FAILED_CLEANUP_UNEXPECTED"], failure_stage: "cleanup", attempted_cleanup: true, cleanup })),
        expected,
        label,
      );
    }

    const coherent = [
      { worktrees: [failedWorktree], branches: [notAttemptedBranch], run_dir: retained },
      { worktrees: [], branches: [failedBranch], run_dir: retained },
      { worktrees: [], branches: [], run_dir: { path: "/run", outcome: "failed", reason_code: "FAILED_CLEANUP_RUN_DIR" } },
      { worktrees: [], branches: [], run_dir: { path: "/run", outcome: "retained", reason_code: "FAILED_CLEANUP_UNEXPECTED" } },
    ];
    for (const [index, cleanup] of coherent.entries()) {
      assert.doesNotThrow(() => createCandidate(candidateInput(`coherent-${index}`, { classification: "failed", reason_codes: ["FAILED_CLEANUP_UNEXPECTED"], failure_stage: "cleanup", attempted_cleanup: true, cleanup })));
    }
  });

  it("rejects every invalid previewed report authorization, exit, confirmation, and candidate state", () => {
    const base = previewReportInput();
    const invalid = [
      ["wrong mode", (value) => { value.mode = "execute"; value.confirmation = { argv: null, shell_command: null }; }, /previewed report must use preview mode/u],
      ["missing repository", (value) => { value.repository = null; }, /previewed report requires repository identity/u],
      ["missing digest", (value) => { value.authorization.digest = null; }, /recomputed digest/u],
      ["stale digest", (value) => { value.authorization.digest = foreignDigest(); }, /recomputed digest/u],
      ["provided digest", (value) => { value.authorization.provided_digest = value.authorization.digest; }, /null execution authorization fields/u],
      ["matched authorization", (value) => { value.authorization.matched = true; }, /null execution authorization fields/u],
      ["refusal authorization", (value) => { value.authorization.refusal_code = "DIGEST_STALE"; }, /only a refused report may have a refusal code/u],
      ["attempted candidate", (value) => { value.candidates = [deletedCandidate("deleted")]; }, /cannot contain attempted or deleted candidates/u],
      ["missing confirmation", (value) => { value.confirmation = { argv: null, shell_command: null }; }, /requires confirmation/u],
      ["nonzero exit", (value) => { value.exit_code = 1; }, /requires exit_code 0/u],
    ];
    for (const [label, mutate, expected] of invalid) assertInvalidReport(base, mutate, expected, label);
  });

  it("rejects every invalid completed report authorization, exit, and final candidate state", () => {
    const base = completedReportInput();
    const invalid = [
      ["wrong mode", (value) => { value.mode = "preview"; }, /completed report must use execute mode/u],
      ["missing repository", (value) => { value.repository = null; }, /completed report requires repository identity/u],
      ["missing digest", (value) => { value.authorization.digest = null; }, /equal matched authorization digests/u],
      ["missing provided digest", (value) => { value.authorization.provided_digest = null; }, /equal matched authorization digests/u],
      ["unequal digest", (value) => { value.authorization.provided_digest = foreignDigest(); }, /equal matched authorization digests/u],
      ["foreign digest", (value) => { value.authorization.digest = foreignDigest(); value.authorization.provided_digest = foreignDigest(); }, /bound to its repository identity/u],
      ["malformed equal digest", (value) => { value.authorization.digest = "malformed"; value.authorization.provided_digest = "malformed"; }, /digest is malformed/u],
      ["unmatched", (value) => { value.authorization.matched = false; }, /equal matched authorization digests/u],
      ["refusal code", (value) => { value.authorization.refusal_code = "DIGEST_FOREIGN"; }, /only a refused report may have a refusal code/u],
      ["eligible remains", (value) => { value.candidates = [candidate("eligible")]; }, /cannot retain eligible candidates/u],
      ["wrong success exit", (value) => { value.exit_code = 1; }, /exit_code must reflect attempted cleanup failures/u],
      ["confirmation present", (value) => { value.confirmation = { argv: ["x"], shell_command: "'x'" }; }, /must have null confirmation/u],
    ];
    for (const [label, mutate, expected] of invalid) assertInvalidReport(base, mutate, expected, label);

    const failed = completedReportInput([failedCleanup("failed", "FAILED_CLEANUP_RUN_DIR", emptyFailedCleanup("FAILED_CLEANUP_RUN_DIR"))], 1);
    assertInvalidReport(failed, (value) => { value.exit_code = 0; }, /exit_code must reflect attempted cleanup failures/u, "attempted failure with zero exit");
  });

  it("rejects every invalid refused report and derives foreign versus stale from the supplied digest", () => {
    const base = refusedReportInput();
    const invalid = [
      ["wrong mode", (value) => { value.mode = "preview"; }, /refused report must use execute mode/u],
      ["missing repository", (value) => { value.repository = null; }, /refused report requires repository identity/u],
      ["missing digest", (value) => { value.authorization.digest = null; }, /requires recomputed and provided unmatched digest/u],
      ["missing provided digest", (value) => { value.authorization.provided_digest = null; }, /requires recomputed and provided unmatched digest/u],
      ["matched flag", (value) => { value.authorization.matched = true; }, /requires recomputed and provided unmatched digest/u],
      ["missing refusal", (value) => { value.authorization.refusal_code = null; }, /requires recomputed and provided unmatched digest/u],
      ["wrong expected digest", (value) => { value.authorization.digest = foreignDigest(); }, /must derive from repository and candidate evidence/u],
      ["wrong refusal derivation", (value) => { value.authorization.refusal_code = "DIGEST_STALE"; }, /must derive from repository and candidate evidence/u],
      ["provided digest now matches", (value) => { value.authorization.provided_digest = value.authorization.digest; }, /must derive from repository and candidate evidence/u],
      ["malformed provided digest", (value) => { value.authorization.provided_digest = "malformed"; }, /digest is malformed/u],
      ["attempted candidate", (value) => { value.candidates = [deletedCandidate("deleted")]; }, /cannot contain attempted or deleted candidates/u],
      ["zero exit", (value) => { value.exit_code = 0; }, /requires exit_code 1/u],
      ["confirmation present", (value) => { value.confirmation = { argv: ["x"], shell_command: "'x'" }; }, /must have null confirmation/u],
    ];
    for (const [label, mutate, expected] of invalid) assertInvalidReport(base, mutate, expected, label);

    const candidates = [candidate("run")];
    const expected = createCleanupSweepDigest(REPOSITORY, candidates);
    const parsed = parseCleanupSweepDigest(expected);
    const stale = `ff-cleanup-v1.${parsed.repository_sha256}.${"f".repeat(64)}`;
    assert.equal(createRefusedReport({ repository: REPOSITORY, candidates, provided_digest: stale }).authorization.refusal_code, "DIGEST_STALE");
    assert.throws(() => createRefusedReport({ repository: REPOSITORY, candidates, provided_digest: foreignDigest(), refusal_code: "DIGEST_STALE" }), /code must be derived/u);
    assert.throws(() => createRefusedReport({ repository: REPOSITORY, candidates, provided_digest: expected }), /matching digest cannot create a refused report/u);
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
    assert.throws(() => executeReport([first], 0), /exit_code must reflect attempted cleanup failures/u);
  });

  it("models R46-R52 cleanup outcomes and keeps report-level failures independent from attempted failures", () => {
    const cases = [
      ["FAILED_CLEANUP_WORKTREE", "failed", "cleanup", true],
      ["FAILED_CLEANUP_BRANCH", "failed", "cleanup", true],
      ["FAILED_CLEANUP_RUN_DIR", "failed", "cleanup", true],
      ["FAILED_CLEANUP_UNEXPECTED", "failed", "cleanup", true],
    ];
    for (const [code, classification, failureStage, attempted] of cases) {
      const item = failedCleanup(code, code, cleanupFailureResult(code));
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

function candidateInput(entryName, overrides = {}) {
  return {
    entry_name: entryName,
    run_id: entryName,
    classification: "eligible",
    reason_codes: ["ELIGIBLE"],
    failure_stage: null,
    attempted_cleanup: false,
    evidence: eligibleEvidence(entryName),
    cleanup: null,
    ...overrides,
  };
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

function cleanupFailureResult(reasonCode) {
  if (reasonCode === "FAILED_CLEANUP_WORKTREE") return {
    worktrees: [{ recorded_path: "/recorded/run", physical_path: "/physical/run", branch: "run", outcome: "failed", reason_code: "FAILED_CLEANUP_WORKTREE" }],
    branches: [{ name: "run", expected_head: "oid", outcome: "not-attempted", reason_code: "RETAINED_AFTER_PARTIAL_FAILURE" }],
    run_dir: { path: "/repo/.opencode/factory/run", outcome: "retained", reason_code: "RETAINED_AFTER_PARTIAL_FAILURE" },
  };
  if (reasonCode === "FAILED_CLEANUP_BRANCH") return {
    worktrees: [],
    branches: [{ name: "run", expected_head: "oid", outcome: "failed", reason_code: "FAILED_CLEANUP_BRANCH" }],
    run_dir: { path: "/repo/.opencode/factory/run", outcome: "retained", reason_code: "RETAINED_AFTER_PARTIAL_FAILURE" },
  };
  if (reasonCode === "FAILED_CLEANUP_UNEXPECTED") return {
    worktrees: [], branches: [], run_dir: { path: "/repo/.opencode/factory/run", outcome: "retained", reason_code: "FAILED_CLEANUP_UNEXPECTED" },
  };
  return emptyFailedCleanup(reasonCode);
}

function deletedCandidate(entryName) {
  return createCandidate({
    entry_name: entryName, run_id: entryName, classification: "deleted", reason_codes: ["DELETED"], attempted_cleanup: true, evidence: eligibleEvidence(entryName),
    cleanup: { worktrees: [], branches: [], run_dir: { path: `/repo/.opencode/factory/${entryName}`, outcome: "removed", reason_code: null } },
  });
}

function cleanupResult(entryName) {
  return { worktrees: [], branches: [], run_dir: { path: `/repo/.opencode/factory/${entryName}`, outcome: "removed", reason_code: null } };
}

function previewReportInput() {
  const candidates = [candidate("run")];
  return {
    mode: "preview", status: "previewed", repository: REPOSITORY, candidates,
    authorization: { schema_version: 1, digest: createCleanupSweepDigest(REPOSITORY, candidates), provided_digest: null, matched: null, refusal_code: null },
    report_errors: [], confirmation: { argv: ["feature-factory"], shell_command: "'feature-factory'" }, exit_code: 0,
  };
}

function completedReportInput(candidates = [deletedCandidate("run")], exitCode = 0) {
  const digest = completedDigest();
  return {
    mode: "execute", status: "completed", repository: REPOSITORY, candidates,
    authorization: { schema_version: 1, digest, provided_digest: digest, matched: true, refusal_code: null },
    report_errors: [], confirmation: { argv: null, shell_command: null }, exit_code: exitCode,
  };
}

function refusedReportInput() {
  const candidates = [candidate("run")];
  return {
    mode: "execute", status: "refused", repository: REPOSITORY, candidates,
    authorization: { schema_version: 1, digest: createCleanupSweepDigest(REPOSITORY, candidates), provided_digest: foreignDigest(), matched: false, refusal_code: "DIGEST_FOREIGN" },
    report_errors: [], confirmation: { argv: null, shell_command: null }, exit_code: 1,
  };
}

function foreignDigest() {
  return `ff-cleanup-v1.${"0".repeat(64)}.${"1".repeat(64)}`;
}

function completedDigest() {
  return `ff-cleanup-v1.${repositoryDigest(REPOSITORY)}.${"3".repeat(64)}`;
}

function assertInvalidReport(base, mutate, expected, label) {
  const input = structuredClone(base);
  mutate(input);
  assert.throws(() => createCleanupSweepReport(input), expected, label);
}

function executeReport(candidates, exitCode) {
  const digest = completedDigest();
  return createCleanupSweepReport({
    mode: "execute", status: "completed", repository: REPOSITORY, candidates,
    authorization: { schema_version: 1, digest, provided_digest: digest, matched: true, refusal_code: null },
    report_errors: [], confirmation: { argv: null, shell_command: null }, exit_code: exitCode,
  });
}
