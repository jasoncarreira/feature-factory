import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;
const PR_URL = "https://github.com/jasoncarreira/opencode-feature-factory/pull/99";
const HASH = `sha256:${"a".repeat(64)}`;

describe("cli pr-created", () => {
  it("records completed PR state through checked transition", () => {
    const fixture = createFixture("cli-pr-created");
    try {
      const proc = runCli(fixture.repo, ["factory", "pr-created", fixture.runId, "--pr-url", PR_URL, "--pr-number", "99", "--repository", "jasoncarreira/opencode-feature-factory", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const output = JSON.parse(proc.stdout);
      const run = readJson(join(fixture.runDir, "run.json"));
      assert.equal(output.pr_url, PR_URL);
      assert.equal(run.status, "completed");
      assert.equal(run.terminal_result.pr_url, PR_URL);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("requires validator, security, and pre_pr approval", () => {
    const fixture = createFixture("cli-pr-blocked", { ready: false });
    try {
      const proc = runCli(fixture.repo, ["factory", "pr-created", fixture.runId, "--pr-url", PR_URL, "--pr-number", "99", "--repository", "jasoncarreira/opencode-feature-factory"]);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /approved pre_pr gate|validator verdict|security_review verdict/u);
      assert.equal(readJson(join(fixture.runDir, "run.json")).status, "running");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects --no-draft for blocked-run continuations without recording PR state", () => {
    const fixture = createFixture("cli-pr-continuation-no-draft", { continuation: true });
    try {
      const proc = runCli(fixture.repo, ["factory", "pr-created", fixture.runId, "--pr-url", PR_URL, "--pr-number", "99", "--repository", "jasoncarreira/opencode-feature-factory", "--no-draft"]);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /requires draft PR for blocked-run-continuation/u);
      const run = readJson(join(fixture.runDir, "run.json"));
      assert.equal(run.status, "running");
      assert.equal(run.pr_url, undefined);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("keeps default draft PR creation available for blocked-run continuations", () => {
    const fixture = createFixture("cli-pr-continuation-draft", { continuation: true });
    try {
      const proc = runCli(fixture.repo, ["factory", "pr-created", fixture.runId, "--pr-url", PR_URL, "--pr-number", "99", "--repository", "jasoncarreira/opencode-feature-factory", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const run = readJson(join(fixture.runDir, "run.json"));
      assert.equal(run.status, "completed");
      assert.equal(run.terminal_result.draft, true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects blocked-run continuation PRs when GitHub reports a non-draft PR", () => {
    const fixture = createFixture("cli-pr-continuation-github-ready", { continuation: true, ghIsDraft: false });
    try {
      const proc = runCli(fixture.repo, ["factory", "pr-created", fixture.runId, "--pr-url", PR_URL, "--pr-number", "99", "--repository", "jasoncarreira/opencode-feature-factory", "--json"]);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /isDraft=true/u);
      const run = readJson(join(fixture.runDir, "run.json"));
      assert.equal(run.status, "running");
      assert.equal(run.pr_url, undefined);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects repository mismatches without verifying a different repository", () => {
    const fixture = createFixture("cli-pr-continuation-repo-mismatch", { continuation: true });
    try {
      const proc = runCli(fixture.repo, ["factory", "pr-created", fixture.runId, "--pr-url", PR_URL, "--pr-number", "99", "--repository", "other-owner/other-repo", "--json"]);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /repository to match the GitHub PR URL/u);
      const run = readJson(join(fixture.runDir, "run.json"));
      assert.equal(run.status, "running");
      assert.equal(run.pr_url, undefined);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects removed pr-created flags as unknown", () => {
    const fixture = createFixture("cli-pr-unknown-flag");
    try {
      const proc = runCli(fixture.repo, ["factory", "pr-created", fixture.runId, "--pr-url", PR_URL, "--pr-number", "99", "--repository", "jasoncarreira/opencode-feature-factory", "--head-commit", "abc123"]);
      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /unknown option: --head-commit/u);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("records env snapshots through the env command and keeps the legacy alias", () => {
    const fixture = createFixture("cli-env");
    try {
      for (const command of ["env", "provenance"]) {
        const proc = runCli(fixture.repo, ["factory", command, "record-created", fixture.runId, "--json"]);
        assert.equal(proc.status, 0, proc.stderr);
        const run = readJson(join(fixture.runDir, "run.json"));
        assert.equal(run.debug_snapshot.created_with.diagnostic_only, true);
        assert.equal(typeof run.debug_snapshot.created_with.env, "object");
      }
    } finally {
      cleanup(fixture.repo);
    }
  });
});

function createFixture(runId, { ready = true, continuation = false, ghIsDraft = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "cli-pr-simplified-"));
  writeFakeGh(repo, { isDraft: ghIsDraft, expectedRepository: "jasoncarreira/opencode-feature-factory", expectedNumber: "99" });
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "validation-report.md"), "ok\n");
  writeJson(join(runDir, "reviews", "implementation-validator.json"), { subject: "feature-branch", verdict: "GO" });
  writeJson(join(runDir, "reviews", "security-reviewer.json"), { subject: "feature-branch", verdict: "PASS" });
  const run = {
    schema_version: 1,
    run_id: runId,
    status: "running",
    branch: continuation ? "continuation-branch" : undefined,
    worktree: continuation ? "/tmp/continuation-worktree" : undefined,
    gates: ready ? { pre_pr: { status: "approved", artifact: "artifacts/validation-report.md", question_ref: "gates/pre_pr.question.md", answer: "approve", answered_at: "2026-07-08T12:00:00.000Z" } } : {},
    slices: ready ? [{ id: "slice", status: "merged", attempts: 1, merge_commit: "abc123" }] : [],
    validator: ready ? { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" } : null,
    security_review: ready ? { verdict: "PASS", review_ref: "reviews/security-reviewer.json" } : null,
    continuation: continuation ? continuationMetadata(runId) : undefined,
  };
  writeJson(join(runDir, "run.json"), run);
  return { repo, runDir, runId };
}

function continuationMetadata(targetRunId) {
  return {
    schema_version: 1,
    kind: "blocked-run-continuation",
    parent: {
      run_id: "parent-run",
      status: "blocked",
      run_ref: "runs/parent-run/run.json",
      run_hash: HASH,
      branch: "parent-branch",
      commit: "abc123",
      worktree: "/tmp/parent-worktree",
    },
    review: {
      kind: "validator",
      ref: "reviews/implementation-validator.json",
      hash: HASH,
      subject: "parent-run",
      summary: "Validator required fixes before PR creation.",
      required_fixes: ["address validation failure"],
      source: "run.validator.review_ref",
    },
    target: {
      run_id: targetRunId,
      branch: "continuation-branch",
      worktree: "/tmp/continuation-worktree",
      base_ref: "main",
      base_commit: "def456",
    },
    created_at: "2026-07-08T12:00:00.000Z",
    operator_summary: "Continue blocked parent run from implementation-validator review.",
    parent_artifacts: [{ kind: "validation_report", ref: "artifacts/validation-report.md", hash: HASH }],
    parent_evidence: [],
    parent_reviews: [{ kind: "review", ref: "reviews/implementation-validator.json", hash: HASH }],
  };
}

function runCli(repo, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${join(repo, "bin")}:${process.env.PATH}` } });
}

function writeFakeGh(repo, { isDraft, expectedRepository, expectedNumber }) {
  const bin = join(repo, "bin");
  mkdirSync(bin, { recursive: true });
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
const repoIndex = args.indexOf("--repo");
if (args[0] !== "pr" || args[1] !== "view" || args[2] !== ${JSON.stringify(expectedNumber)} || repoIndex < 0 || args[repoIndex + 1] !== ${JSON.stringify(expectedRepository)}) {
  process.stderr.write("unexpected gh args\\n");
  process.exit(2);
}
process.stdout.write(${JSON.stringify(JSON.stringify({ isDraft }) + "\n")});
`, "utf8");
  chmodSync(gh, 0o755);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
