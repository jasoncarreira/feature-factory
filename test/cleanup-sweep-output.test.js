import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  createCandidate,
  createCleanupSweepDigest,
  createCleanupSweepReport,
  createEmptyEvidence,
  createRefusedReport,
} from "../src/cleanup-sweep-report.js";
import {
  createCleanupSweepConfirmation,
  renderCleanupSweepReport,
  renderCleanupSweepReportLines,
} from "../src/cleanup-sweep-output.js";

const REPOSITORY = {
  schema_version: 1, root_path: "/repo with 'quote'", root_device: "1", root_inode: "2",
  git_common_dir_path: "/repo with 'quote'/.git", git_common_dir_device: "1", git_common_dir_inode: "3", object_format: "sha1",
};

describe("cleanup sweep output", () => {
  it("builds the exact preview confirmation and round-trips every argv element through /bin/sh", () => {
    const digest = createCleanupSweepDigest(REPOSITORY, []);
    const confirmation = createCleanupSweepConfirmation(digest, REPOSITORY.root_path, { json: true });
    assert.deepEqual(confirmation.argv, [
      "feature-factory", "factory", "cleanup", "--all", "--digest", digest, "--repo", REPOSITORY.root_path, "--json",
    ]);
    const script = `set -- ${confirmation.shell_command}; printf '%s\\0' "$@"`;
    const output = execFileSync("/bin/sh", ["-c", script]);
    assert.deepEqual([...output.toString("utf8").split("\0").slice(0, -1)], confirmation.argv);
  });

  it("renders ordered terminal-safe human fields, candidate reasons, counts, and confirmation", () => {
    const evidence = createEmptyEvidence("run\nname");
    const candidate = createCandidate({
      entry_name: "run\nname", run_id: null, classification: "protected",
      reason_codes: ["PROTECTED_STATUS_BLOCKED"], evidence,
    });
    const digest = createCleanupSweepDigest(REPOSITORY, [candidate]);
    const confirmation = createCleanupSweepConfirmation(digest, REPOSITORY.root_path);
    const report = createCleanupSweepReport({
      mode: "preview", status: "previewed", repository: REPOSITORY, candidates: [candidate],
      authorization: { schema_version: 1, digest, provided_digest: null, matched: null, refusal_code: null },
      report_errors: [], confirmation, exit_code: 0,
    });
    const lines = renderCleanupSweepReportLines(report);
    assert.match(lines[0], /^mode: preview$/u);
    assert.match(lines[1], /^status: previewed$/u);
    assert.match(lines[2], /^repository:/u);
    assert.match(lines[3], new RegExp(`^digest: ${digest.replaceAll(".", "\\.")}$`, "u"));
    assert.match(lines[4], /^protected\trun\\u000Aname\tPROTECTED_STATUS_BLOCKED\tThe run contains blocked recoverable work\.$/u);
    assert.equal(lines[5], "counts: eligible=0 protected=1 skipped=0 deleted=0 failed=0");
    assert.equal(lines[6], "attempted-cleanup-failures: 0");
    assert.match(lines[7], /^confirmation: 'feature-factory'/u);
    assert.equal(lines.every((line) => !line.includes("\n") && !line.includes("\r") && !line.includes("\u001b")), true);

    const json = JSON.parse(renderCleanupSweepReport(report, { json: true }));
    assert.equal(json.confirmation.argv[5], digest);
    assert.equal(json.confirmation.shell_command, confirmation.shell_command);
  });

  it("renders JSON without redacting the authorization digest and reports R43 refusals with fixed text", () => {
    const expected = createCleanupSweepDigest(REPOSITORY, []);
    const foreign = `ff-cleanup-v1.${"0".repeat(64)}.${"1".repeat(64)}`;
    const report = createRefusedReport({ repository: REPOSITORY, candidates: [], provided_digest: foreign, refusal_code: "DIGEST_FOREIGN", digest: expected });
    const json = JSON.parse(renderCleanupSweepReport(report, { json: true }));
    assert.equal(json.authorization.digest, expected);
    assert.equal(json.authorization.provided_digest, foreign);
    const lines = renderCleanupSweepReportLines(report);
    assert.match(lines.join("\n"), /refusal: DIGEST_FOREIGN - The supplied digest was created for a different repository\./u);
    assert.doesNotMatch(lines.join("\n"), /confirmation:/u);
    assert.equal(lines.at(-1), "attempted-cleanup-failures: 0");
  });
});
