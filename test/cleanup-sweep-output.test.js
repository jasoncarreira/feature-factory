import assert from "node:assert/strict";
import { execFileSync } from "./helpers/git-fixture.js";
import { describe, it } from "node:test";
import {
  createCandidate,
  createCleanupSweepDigest,
  createCleanupSweepReport,
  createEmptyEvidence,
  createRefusedReport,
  createReportLevelFailure,
  parseCleanupSweepDigest,
} from "../src/cleanup-sweep-report.js";
import {
  createCleanupSweepConfirmation,
  renderCleanupSweepReport,
  renderCleanupSweepReportLines,
} from "../src/cleanup-sweep-output.js";

const SENSITIVE_ROOT = "/tmp/github_pat_AAAAAAAAAAAAAAAAAAAAAAAA/repo";
const REPOSITORY = repository(SENSITIVE_ROOT);

describe("cleanup sweep output", () => {
  it("keeps sensitive human diagnostics display-safe while JSON preserves exact normalized machine fields", () => {
    const candidate = makeCandidate("protected");
    const report = previewReport(REPOSITORY, [candidate], true);
    const human = renderCleanupSweepReport(report);
    assert.match(human, /^repository: .*\[redacted\]/mu);
    assert.doesNotMatch(human, /github_pat_AAAAAAAAAAAAAAAAAAAAAAAA/u);
    assert.match(human, /confirmation: _ff_cleanup_repo=\$\(printf '%b_' '[\\0-7]+'/u);

    const renderedJson = renderCleanupSweepReport(report, { json: true });
    const parsed = JSON.parse(renderedJson);
    assert.equal(parsed.repository.root_path, SENSITIVE_ROOT);
    assert.equal(parsed.repository.git_common_dir_path, `${SENSITIVE_ROOT}/.git`);
    assert.equal(parsed.confirmation.argv[7], SENSITIVE_ROOT);
    assert.equal(parsed.candidates[0].entry_name, candidate.entry_name);
    assert.deepEqual(createCleanupSweepReport(parsed), createCleanupSweepReport(report));
  });

  it("extracts the complete human report confirmation and round-trips argv byte-for-byte through /bin/sh", () => {
    const roots = [
      "/tmp/repo with spaces/and 'quotes'",
      "/tmp/repo\\with-literal-backslash",
      "/tmp/répo/雪",
      "/tmp/repo\u001b[31m",
      SENSITIVE_ROOT,
      "/tmp/repo-with-trailing-newline\n",
    ];
    for (const root of roots) {
      const repo = repository(root);
      const report = previewReport(repo, [], true);
      const confirmation = report.confirmation;
      assert.deepEqual(confirmation.argv, [
        "feature-factory", "factory", "cleanup", "--all", "--digest", report.authorization.digest, "--repo", root, "--json",
      ]);
      const extracted = extractHumanConfirmation(renderCleanupSweepReport(report));
      assert.equal(extracted, confirmation.shell_command, root);
      assert.deepEqual(runConfirmationAsSet(extracted), confirmation.argv, root);
      if (root === SENSITIVE_ROOT || /[^\x20-\x7e]/u.test(root)) {
        assert.match(extracted, /^_ff_cleanup_repo=\$\(printf '%b_' /u, root);
        assert.doesNotMatch(extracted, new RegExp(escapeRegExp(root), "u"), root);
      }
    }
  });

  it("rejects NUL and non-round-trippable confirmation roots", () => {
    const digest = createCleanupSweepDigest(REPOSITORY, []);
    assert.throws(() => createCleanupSweepConfirmation(digest, "/tmp/a\0b"), /round-trippable/u);
    assert.throws(() => createCleanupSweepConfirmation(digest, "/tmp/\ud800"), /round-trippable/u);
  });

  it("renders ordered terminal-safe human fields, candidates, counts, and exact preview action", () => {
    const repo = repository("/repo with 'quote'");
    const candidate = makeCandidate("protected", "run\nname");
    const report = previewReport(repo, [candidate]);
    const lines = renderCleanupSweepReportLines(report);
    assert.equal(lines[0], "mode: preview");
    assert.equal(lines[1], "status: previewed");
    assert.equal(lines[2], "repository: /repo with 'quote'");
    assert.equal(lines[3], `digest: ${report.authorization.digest}`);
    assert.equal(lines[4], "protected\trun\\u000Aname\tPROTECTED_STATUS_BLOCKED\tThe run contains blocked recoverable work.");
    assert.equal(lines[5], "counts: eligible=0 protected=1 skipped=0 deleted=0 failed=0");
    assert.equal(lines[6], "attempted-cleanup-failures: 0");
    assert.equal(lines[7], `confirmation: ${report.confirmation.shell_command}`);
    assert.equal(lines.every((line) => !line.includes("\n") && !line.includes("\r") && !line.includes("\u001b")), true);
  });

  it("covers both R43 refusals in human and JSON with recomputed candidates and null confirmation", () => {
    const candidates = [makeCandidate("skipped")];
    const expected = createCleanupSweepDigest(REPOSITORY, candidates);
    const parsedExpected = parseCleanupSweepDigest(expected);
    const cases = [
      ["DIGEST_FOREIGN", `ff-cleanup-v1.${differentHash(parsedExpected.repository_sha256)}.${"1".repeat(64)}`],
      ["DIGEST_STALE", `ff-cleanup-v1.${parsedExpected.repository_sha256}.${differentHash(parsedExpected.envelope_sha256)}`],
    ];
    for (const [code, providedDigest] of cases) {
      const report = createRefusedReport({ repository: REPOSITORY, candidates, provided_digest: providedDigest, refusal_code: code, digest: expected });
      assert.equal(report.status, "refused");
      assert.equal(report.exit_code, 1);
      assert.equal(report.authorization.digest, expected);
      assert.equal(report.authorization.provided_digest, providedDigest);
      assert.deepEqual(report.confirmation, { argv: null, shell_command: null });
      assert.equal(report.candidates.length, 1);
      assert.equal(report.attempted_cleanup_failures, 0);

      const human = renderCleanupSweepReport(report);
      assert.match(human, new RegExp(`^digest: ${escapeRegExp(expected)}$`, "mu"));
      assert.match(human, new RegExp(`^refusal: ${code} - `, "mu"));
      assert.doesNotMatch(human, /^confirmation:/mu);
      const json = JSON.parse(renderCleanupSweepReport(report, { json: true }));
      assert.deepEqual(createCleanupSweepReport(json), report);
    }
  });

  it("renders every human/JSON status row with exact digest, confirmation, candidate, and failure invariants", () => {
    const preview = previewReport(REPOSITORY, [makeCandidate("eligible")]);
    const digest = createCleanupSweepDigest(REPOSITORY, []);
    const completed = executionReport({ digest, candidates: [makeCandidate("deleted")] });
    const attemptedFailure = executionReport({ digest, candidates: [makeCandidate("cleanup-failed")] });
    const beforeDiscoveryFailure = createReportLevelFailure({ mode: "preview", code: "FAILED_FACTORY_ROOT" });
    const executeBeforeDiscoveryFailure = createReportLevelFailure({ mode: "execute", code: "FAILED_ORCHESTRATION", provided_digest: digest });
    const afterInspectionFailure = createReportLevelFailure({
      mode: "execute", code: "FAILED_TEMP_REF_CLEANUP", repository: REPOSITORY,
      candidates: [makeCandidate("deleted"), makeCandidate("inspection-failed")], provided_digest: digest,
    });
    const rows = [
      ["preview", preview, true, 0],
      ["completed", completed, false, 0],
      ["attempted failure", attemptedFailure, false, 1],
      ["failure before discovery", beforeDiscoveryFailure, false, 0],
      ["execute failure before discovery", executeBeforeDiscoveryFailure, false, 0],
      ["failure after inspection/mutation", afterInspectionFailure, false, 0],
    ];

    for (const [name, report, hasConfirmation, attemptedFailures] of rows) {
      const humanLines = renderCleanupSweepReportLines(report);
      assert.equal(humanLines[0], `mode: ${report.mode}`, name);
      assert.equal(humanLines[1], `status: ${report.status}`, name);
      assert.equal(humanLines.some((line) => line.startsWith("confirmation:")), hasConfirmation, name);
      assert.equal(report.attempted_cleanup_failures, attemptedFailures, name);
      if (report.status === "failed") {
        assert.equal(report.authorization.digest, null, name);
        assert.deepEqual(report.confirmation, { argv: null, shell_command: null }, name);
        assert.match(humanLines.join("\n"), /^report-error: FAILED_/mu, name);
      }
      const jsonText = renderCleanupSweepReport(report, { json: true });
      assert.equal(jsonText.endsWith("\n"), false, name);
      const parsed = JSON.parse(jsonText);
      assert.deepEqual(createCleanupSweepReport(parsed), createCleanupSweepReport(report), name);
    }
  });
});

function repository(rootPath) {
  return {
    schema_version: 1, root_path: rootPath, root_device: "1", root_inode: "2",
    git_common_dir_path: `${rootPath}/.git`, git_common_dir_device: "1", git_common_dir_inode: "3", object_format: "sha1",
  };
}

function previewReport(repo, candidates, json = false) {
  const digest = createCleanupSweepDigest(repo, candidates);
  return createCleanupSweepReport({
    mode: "preview", status: "previewed", repository: repo, candidates,
    authorization: { schema_version: 1, digest, provided_digest: null, matched: null, refusal_code: null },
    report_errors: [], confirmation: createCleanupSweepConfirmation(digest, repo.root_path, { json }), exit_code: 0,
  });
}

function executionReport({ digest, candidates }) {
  return createCleanupSweepReport({
    mode: "execute", status: "completed", repository: REPOSITORY, candidates,
    authorization: { schema_version: 1, digest, provided_digest: digest, matched: true, refusal_code: null },
    report_errors: [], confirmation: { argv: null, shell_command: null },
    exit_code: candidates.some((candidate) => candidate.attempted_cleanup && candidate.classification === "failed") ? 1 : 0,
  });
}

function makeCandidate(kind, entryName = `run-${kind}`) {
  const common = { entry_name: entryName, run_id: entryName, evidence: createEmptyEvidence(entryName) };
  if (kind === "eligible") return createCandidate({ ...common, classification: "eligible", reason_codes: ["ELIGIBLE"] });
  if (kind === "protected") return createCandidate({ ...common, classification: "protected", reason_codes: ["PROTECTED_STATUS_BLOCKED"] });
  if (kind === "skipped") return createCandidate({ ...common, classification: "skipped", reason_codes: ["SKIPPED_PR_OPEN"] });
  if (kind === "inspection-failed") {
    return createCandidate({ ...common, classification: "failed", reason_codes: ["FAILED_INSPECTION"], failure_stage: "inspection" });
  }
  if (kind === "deleted") {
    return createCandidate({
      ...common, classification: "deleted", reason_codes: ["DELETED"], attempted_cleanup: true,
      cleanup: { worktrees: [], branches: [], run_dir: { path: `/factory/${entryName}`, outcome: "removed", reason_code: null } },
    });
  }
  if (kind === "cleanup-failed") {
    return createCandidate({
      ...common, classification: "failed", reason_codes: ["FAILED_CLEANUP_RUN_DIR"], failure_stage: "cleanup", attempted_cleanup: true,
      cleanup: { worktrees: [], branches: [], run_dir: { path: `/factory/${entryName}`, outcome: "failed", reason_code: "FAILED_CLEANUP_RUN_DIR" } },
    });
  }
  throw new TypeError(`unknown candidate fixture kind: ${kind}`);
}

function runConfirmationAsSet(shellCommand) {
  const setCommand = shellCommand.replace("'feature-factory'", "set -- 'feature-factory'");
  const output = execFileSync("/bin/sh", ["-c", `${setCommand}; printf '%s\\0' "$@"`]);
  return output.toString("utf8").split("\0").slice(0, -1);
}

function extractHumanConfirmation(renderedReport) {
  const prefix = "confirmation: ";
  const line = renderedReport.split("\n").find((item) => item.startsWith(prefix));
  assert.notEqual(line, undefined, "human report must contain a confirmation line");
  return line.slice(prefix.length);
}

function differentHash(hash) {
  return hash === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
