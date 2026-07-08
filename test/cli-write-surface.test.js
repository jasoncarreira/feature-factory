import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const RUN_ID = "cli-write-surface";

describe("cli write surface", () => {
  it("drives a run through local state transitions without direct run.json edits", () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-cli-write-"));
    const runDir = join(repo, ".opencode", "factory", RUN_ID);
    try {
      initGitRepo(repo, ["slice-branch"]);
      seedRun(runDir);

      runFactory(repo, ["slices-seed", RUN_ID, "--from", `.opencode/factory/${RUN_ID}/plan/slices.json`, "--json"]);
      validateFactory(repo);
      runFactory(repo, ["slice-status", RUN_ID, "slice", "running", "--branch", "slice-branch", "--worktree", ".opencode/worktrees/slice", "--attempts", "1", "--json"]);
      validateFactory(repo);
      assert.match(runFactoryFail(repo, ["slices-seed", RUN_ID, "--from", `.opencode/factory/${RUN_ID}/plan/slices.json`, "--json"]).stderr, /refuses to replace non-pending slice progress/u);
      assert.match(runFactoryFail(repo, ["slice-status", RUN_ID, "typo", "running", "--branch", "slice-branch", "--worktree", ".opencode/worktrees/typo", "--attempts", "1", "--json"]).stderr, /slice 'typo' not found/u);
      writeJson(join(runDir, "evidence", "slice.json"), { subject: "slice", status: "pass", review_ready: true });
      writeJson(join(runDir, "reviews", "slice.json"), { subject: "slice", verdict: "APPROVE", required_fixes: [] });
      runFactory(repo, ["slice-status", RUN_ID, "slice", "review", "--evidence-ref", "evidence/slice.json", "--review-ref", "reviews/slice.json", "--json"]);
      validateFactory(repo);
      runFactory(repo, ["slice-merged", RUN_ID, "slice", "--merge-commit", "abc123", "--json"]);
      validateFactory(repo);

      writeFileSync(join(runDir, "artifacts", "story.md"), "story\n", "utf8");
      runFactory(repo, ["step", RUN_ID, "spec-writer", "accepted", "--artifact-ref", "artifacts/story.md", "--review-ref", "reviews/slice.json", "--json"]);
      validateFactory(repo);
      assert.match(runFactoryFail(repo, ["step", RUN_ID, "unknown-agent", "running", "--attempts", "1", "--json"]).stderr, /step 'unknown-agent' not found/u);

      writeFileSync(join(runDir, "artifacts", "validation-report.md"), "GO\n", "utf8");
      writeJson(join(runDir, "reviews", "implementation-validator.json"), { subject: "feature-branch", verdict: "GO" });
      writeJson(join(runDir, "reviews", "security-reviewer.json"), { subject: "feature-branch", verdict: "PASS" });
      runFactory(repo, ["verdicts", RUN_ID, "--validator", "GO", "--report", "artifacts/validation-report.md", "--security", "PASS", "--review-ref", "reviews/security-reviewer.json", "--json"]);
      validateFactory(repo);

      writeFileSync(join(runDir, "gates", "pre_pr.question.md"), "approve PR?\n", "utf8");
      runFactory(repo, ["gate-decision", RUN_ID, "pre_pr", "pending", "--artifact", "artifacts/validation-report.md", "--question-ref", "gates/pre_pr.question.md", "--answer-ref", "gates/pre_pr.answer", "--json"]);
      validateFactory(repo);
      runFactory(repo, ["answer", "--json", RUN_ID, "pre_pr", "approve"]);
      runFactory(repo, ["gate-decision", RUN_ID, "pre_pr", "approved", "--artifact", "artifacts/validation-report.md", "--question-ref", "gates/pre_pr.question.md", "--answer-ref", "gates/pre_pr.answer", "--approval-source", "external-driver", "--json"]);
      validateFactory(repo);

      const completed = JSON.parse(runFactory(repo, ["pr-created", RUN_ID, "--pr-url", "https://github.com/jasoncarreira/opencode-feature-factory/pull/123", "--pr-number", "123", "--repository", "jasoncarreira/opencode-feature-factory", "--json"]).stdout);
      const validation = JSON.parse(runFactory(repo, ["validate", RUN_ID]).stdout);

      assert.equal(completed.status, "completed");
      assert.equal(validation.ok, true, JSON.stringify(validation, null, 2));
      assert.equal(readJson(join(runDir, "run.json")).status, "completed");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses stale answers after a gate is re-pended through the CLI", () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-cli-gate-repend-"));
    const runDir = join(repo, ".opencode", "factory", RUN_ID);
    try {
      initGitRepo(repo);
      seedRun(runDir);
      writeFileSync(join(runDir, "artifacts", "story.md"), "story\n", "utf8");
      writeFileSync(join(runDir, "gates", "story.question.md"), "approve story?\n", "utf8");
      runFactory(repo, ["gate-decision", RUN_ID, "story", "pending", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer-ref", "gates/story.answer", "--json"]);
      runFactory(repo, ["answer", "--json", RUN_ID, "story", "approve"]);
      runFactory(repo, ["gate-decision", RUN_ID, "story", "approved", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer-ref", "gates/story.answer", "--approval-source", "external-driver", "--json"]);

      writeFileSync(join(runDir, "gates", "story.question.md"), "approve updated story?\n", "utf8");
      runFactory(repo, ["gate-decision", RUN_ID, "story", "pending", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer-ref", "gates/story.answer", "--json"]);
      assert.match(runFactoryFail(repo, ["gate-decision", RUN_ID, "story", "approved", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer-ref", "gates/story.answer", "--approval-source", "external-driver", "--json"]).stderr, /missing gates ref/u);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("records non-completed terminal states through the CLI", () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-cli-terminal-"));
    const runDir = join(repo, ".opencode", "factory", RUN_ID);
    try {
      initGitRepo(repo);
      seedRun(runDir);
      runFactory(repo, ["terminal", RUN_ID, "blocked", "--reason", "needs operator", "--json"]);
      const run = readJson(join(runDir, "run.json"));
      assert.equal(run.status, "blocked");
      assert.equal(run.terminal_result.reason, "needs operator");
      const validation = JSON.parse(runFactoryFail(repo, ["validate", RUN_ID]).stdout);
      assert.equal(validation.ok, false);
      assert.equal(validation.runs[0].checks.find((check) => check.name === "run.schema")?.ok, true);
      assert.equal(validation.runs[0].diagnostics.items[0].condition, "terminal-run");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

function seedRun(runDir) {
  mkdirSync(join(runDir, "plan"), { recursive: true });
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "evidence"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  mkdirSync(join(runDir, "gates"), { recursive: true });
  writeJson(join(runDir, "run.json"), { schema_version: 1, run_id: RUN_ID, status: "running", gates: {}, slices: [], steps: [{ agent: "spec-writer", status: "running", attempts: 0 }] });
  writeJson(join(runDir, "plan", "slices.json"), {
    slices: [{ id: "slice", stack: "backend", paths: ["src/example.js"], depends_on: [], acceptance: ["works"], test_plan: ["unit"] }],
  });
}

function validateFactory(repo) {
  const validation = JSON.parse(runFactory(repo, ["validate", RUN_ID]).stdout);
  assert.equal(validation.ok, true, JSON.stringify(validation, null, 2));
}

function runFactoryFail(repo, args) {
  const proc = spawnFactory(repo, args);
  assert.notEqual(proc.status, 0, proc.stdout || proc.stderr);
  return proc;
}

function runFactory(repo, args) {
  const proc = spawnFactory(repo, args);
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc;
}

function spawnFactory(repo, args) {
  const commandArgs = args[0] === "answer"
    ? [CLI, "factory", "answer", "--repo", repo, ...args.slice(1)]
    : [CLI, "factory", ...args, "--repo", repo];
  return spawnSync(process.execPath, commandArgs, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    timeout: 15000,
  });
}

function initGitRepo(repo, branches = []) {
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "test\n", "utf8");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "init"]);
  for (const branch of branches) runGit(repo, ["branch", branch]);
}

function runGit(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
