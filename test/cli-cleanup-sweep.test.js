import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "./helpers/git-fixture.js";
import {
  parseCleanupSweepCommand,
  runCleanupSweepCommand,
} from "../src/cleanup-sweep-command.js";
import {
  createCleanupSweepConfirmation,
  renderCleanupSweepReport,
  renderCleanupSweepReportLines,
} from "../src/cleanup-sweep-output.js";
import { StructuredOutputError } from "../src/hardening/output-policy.js";
import {
  createCandidate,
  createCleanupSweepDigest,
  createCleanupSweepReport,
  createEmptyEvidence,
} from "../src/cleanup-sweep-report.js";

const DIGEST = `ff-cleanup-v1.${"a".repeat(64)}.${"b".repeat(64)}`;

describe("cleanup sweep closed command grammar", () => {
  it("parses only the exact preview and execute forms in unrestricted flag order", () => {
    assert.deepEqual(
      parseCleanupSweepCommand(["--json", "--repo", "relative repo", "--dry-run", "--all"]),
      { mode: "preview", cwd: resolve("relative repo"), json: true },
    );
    assert.deepEqual(
      parseCleanupSweepCommand(["--digest", DIGEST, "--all"]),
      { mode: "execute", cwd: process.cwd(), json: false, digest: DIGEST },
    );
  });

  it("rejects every duplicate, missing, empty, next-flag, positional, and unrelated form with structured errors", () => {
    const invalid = [
      [],
      ["--all"],
      ["--all", "--dry-run", "--digest", DIGEST],
      ["--dry-run"],
      ["--digest", DIGEST],
      ["--all", "--dry-run", "--all"],
      ["--all", "--dry-run", "--dry-run"],
      ["--all", "--dry-run", "--json", "--json"],
      ["--all", "--dry-run", "--repo", "x", "--repo", "y"],
      ["--all", "--digest", DIGEST, "--digest", DIGEST],
      ["--all", "--digest"],
      ["--all", "--digest", ""],
      ["--all", "--digest", "--json"],
      ["--all", "--dry-run", "--repo"],
      ["--all", "--dry-run", "--repo", ""],
      ["--all", "--dry-run", "--repo", "--json"],
      ["--all", "--dry-run", "run-id"],
      ["--all", "--dry-run", "--force"],
      ["--all", "--dry-run", "-j"],
      ["--all", "--dry-run", "--repo=path"],
      ["--all", "--dry-run", "--"],
      ["--all", "--dry-run", "--telemetry"],
      ["--all", "--digest", "ff-cleanup-v1.BAD.BAD"],
      ["--all", "--digest", `ff-cleanup-v1.${"A".repeat(64)}.${"b".repeat(64)}`],
    ];
    for (const args of invalid) {
      assert.throws(() => parseCleanupSweepCommand(args), (error) => {
        assert.ok(error instanceof StructuredOutputError);
        assert.equal(error.message.length > 0, true);
        return true;
      }, args.join(" "));
    }
  });

  it("parses before handlers, invokes exactly one mode handler, and returns the report exit code", async () => {
    const calls = [];
    const previewReport = { exit_code: 0 };
    const executeReport = { exit_code: 1 };
    const handlers = {
      preview(command) { calls.push(["preview", command]); return previewReport; },
      execute(command) { calls.push(["execute", command]); return executeReport; },
    };
    assert.deepEqual(
      await runCleanupSweepCommand(["--all", "--dry-run"], handlers),
      { report: previewReport, exitCode: 0 },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "preview");

    calls.length = 0;
    assert.deepEqual(
      await runCleanupSweepCommand(["--all", "--digest", DIGEST], handlers),
      { report: executeReport, exitCode: 1 },
    );
    assert.deepEqual(calls.map(([mode]) => mode), ["execute"]);

    calls.length = 0;
    await assert.rejects(runCleanupSweepCommand(["--all", "--force", "--dry-run"], handlers), StructuredOutputError);
    assert.deepEqual(calls, []);
  });
});

describe("cleanup sweep confirmation and rendering", () => {
  it("builds the exact shell-safe confirmation and appends json only for JSON previews", () => {
    const root = "/tmp/repo with 'quote'";
    const plain = createCleanupSweepConfirmation(DIGEST, root);
    assert.deepEqual(plain.argv, [
      "feature-factory", "factory", "cleanup", "--all", "--digest", DIGEST, "--repo", root,
    ]);
    assert.equal(plain.shell_command, plain.argv.map((arg) => `'${arg.replaceAll("'", `'"'"'`)}'`).join(" "));
    assert.deepEqual(shellRoundTrip(plain.shell_command), plain.argv);

    const json = createCleanupSweepConfirmation(DIGEST, root, { json: true });
    assert.deepEqual(json.argv.slice(-1), ["--json"]);
    assert.deepEqual(shellRoundTrip(json.shell_command), json.argv);
  });

  it("renders deterministic human lines in contract order with terminal-safe candidate data", () => {
    const report = previewReport({
      candidates: [
        createCandidate({ entry_name: "z\u001b[31m", run_id: "z", classification: "skipped", reason_codes: ["SKIPPED_PR_OPEN"] }),
        createCandidate({ entry_name: "a", run_id: "a", classification: "eligible", reason_codes: ["ELIGIBLE"] }),
      ],
    });
    const lines = renderCleanupSweepReportLines(report);
    assert.equal(lines[0], "mode: preview");
    assert.equal(lines[1], "status: previewed");
    assert.match(lines[2], /^repository: /u);
    assert.match(lines[3], /^digest: ff-cleanup-v1\./u);
    assert.match(lines[4], /^eligible\ta\tELIGIBLE\t/u);
    assert.match(lines[5], /^skipped\tz\\u001B\[31m\tSKIPPED_PR_OPEN\t/u);
    assert.match(lines[6], /^counts: eligible=1 protected=0 skipped=1 deleted=0 failed=0$/u);
    assert.equal(lines[7], "attempted-cleanup-failures: 0");
    assert.match(lines[8], /^confirmation: /u);
    assert.doesNotMatch(lines.join("\n"), /\u001b/u);
  });

  it("renders terminal-safe stable JSON without adding raw operational errors", () => {
    const report = previewReport();
    report.raw_error = "fatal: credential helper failed";
    const rendered = renderCleanupSweepReport(report, { json: true });
    assert.deepEqual(JSON.parse(rendered), createCleanupSweepReport(report));
    assert.doesNotMatch(rendered, /credential helper/u);
  });
});

function previewReport({ candidates = [] } = {}) {
  const repository = {
    schema_version: 1,
    root_path: "/physical/repo",
    root_device: "1",
    root_inode: "2",
    git_common_dir_path: "/physical/repo/.git",
    git_common_dir_device: "1",
    git_common_dir_inode: "3",
    object_format: "sha1",
  };
  const normalizedCandidates = candidates.map((candidate) => candidate.evidence
    ? candidate
    : createCandidate({ ...candidate, evidence: createEmptyEvidence(candidate.entry_name) }));
  const digest = createCleanupSweepDigest(repository, normalizedCandidates);
  return createCleanupSweepReport({
    mode: "preview",
    status: "previewed",
    repository,
    authorization: { schema_version: 1, digest, provided_digest: null, matched: null, refusal_code: null },
    candidates: normalizedCandidates,
    report_errors: [],
    confirmation: createCleanupSweepConfirmation(digest, repository.root_path),
    exit_code: 0,
  });
}

function shellRoundTrip(command) {
  const output = execFileSync("/bin/sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`]);
  return output.toString("utf8").split("\0").slice(0, -1);
}
