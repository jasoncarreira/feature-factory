import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFeatureCommandPayload } from "../src/feature-command-payload.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const RUN_ID = "cli-write-surface";
const TERMINAL_CURRENCY_PAYLOADS = Object.freeze([
  "USD\u001b]0;pwned\u0007",
  "USD\u001b[2J",
  "USD\u001b]52;c;U0VDUkVU\u0007",
]);

describe("cli write surface", () => {
  it("passes a named start run id as driver config", () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-cli-start-run-id-"));
    try {
      initGitRepo(repo);
      const capture = join(repo, "opencode-capture.json");
      const bin = writeFakeOpencode(repo, capture);

      const proc = spawnFactoryStart(repo, ["--run-id", "named-start", "--autonomous", "implement the named feature"], bin, capture);

      assert.equal(proc.status, 0, proc.stderr || proc.stdout);
      const captured = readJson(capture);
      const expectedRepo = realpathSync(repo);
      assert.equal(captured.cwd, expectedRepo);
      assert.deepEqual(captured.args.slice(0, 6), ["run", "--dir", expectedRepo, "--command", "feature", "--agent"]);
      assert.equal(captured.args[6], "feature-factory");
      assert.match(captured.args.at(-1), /^ffpayload-v1:[A-Za-z0-9_-]+$/u);
      const decoded = decodeFeatureCommandPayload(captured.args.at(-1));
      assert.equal(decoded.ok, true);
      const payload = decoded.payload;
      assert.equal(payload.operator_request, "implement the named feature");
      assert.equal(payload.driver.mode, "autonomous");
      assert.equal(payload.driver.run_id, "named-start");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects unsafe or resume start run ids before launching opencode", () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-cli-start-run-id-invalid-"));
    try {
      initGitRepo(repo);
      const capture = join(repo, "opencode-capture.json");
      const bin = writeFakeOpencode(repo, capture);

      const unsafe = spawnFactoryStart(repo, ["--run-id", "../bad", "implement"], bin, capture);
      assert.notEqual(unsafe.status, 0, unsafe.stdout || unsafe.stderr);
      assert.match(unsafe.stderr, /--run-id must be a bare safe factory run id/u);
      assert.equal(existsSync(capture), false);

      const resume = spawnFactoryStart(repo, ["--run-id", "named-start", "--headless", "resume named-start"], bin, capture);
      assert.notEqual(resume.status, 0, resume.stdout || resume.stderr);
      assert.match(resume.stderr, /--run-id is only for new runs/u);
      assert.equal(existsSync(capture), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("drives a run through local state transitions without direct run.json edits", () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-cli-write-"));
    const runDir = join(repo, ".opencode", "factory", RUN_ID);
    try {
      initGitRepo(repo, ["slice-branch"]);
      seedRun(runDir);

      const steered = JSON.parse(runFactory(repo, ["steer", RUN_ID, "--message", "operator steering", "--json"]).stdout);
      assert.equal(steered.steering.message_chars, 17);
      const consumed = JSON.parse(runFactory(repo, ["steer-consume", RUN_ID, "--ref", steered.steering.ref, "--hash", steered.steering.hash, "--json"]).stdout);
      assert.equal(consumed.steering.trust, "untrusted-operator-data");
      runFactory(repo, ["steer-ack", RUN_ID, "--ref", consumed.steering.ref, "--hash", consumed.steering.hash, "--json"]);
      validateFactory(repo);

      runFactory(repo, ["slices-seed", RUN_ID, "--from", `.opencode/factory/${RUN_ID}/plan/slices.json`, "--json"]);
      validateFactory(repo);
      const costRecorded = JSON.parse(runFactory(repo, ["cost-record", RUN_ID, "--agent", "backend-builder", "--step", "build", "--slice-id", "slice", "--provider", "opencode", "--model", "gpt-5.5", "--source", "usage-log", "--operation", "completion", "--request-id", "req-1", "--input-tokens", "10", "--output-tokens", "5", "--total-tokens", "15", "--cost-total", "0.02", "--currency", "USD", "--recorded-at", "2026-07-08T12:30:00.000Z", "--entry-id", "cli-cost", "--json"]).stdout);
      assert.equal(costRecorded.entry.id, "cli-cost");
      assert.equal(costRecorded.entry.slice_id, "slice");
      assert.equal(costRecorded.cost_summary.total_tokens, 15);
      assert.equal(JSON.parse(runFactory(repo, ["status", RUN_ID, "--json"]).stdout).cost_summary.cost_total, 0.02);
      assert.equal(JSON.parse(runFactory(repo, ["list", "--json"]).stdout)[0].cost_summary.entry_count, 1);
      assert.match(runFactory(repo, ["list"]).stdout, /cost available · 1 entry · 15 tokens · 0\.02 USD/u);
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
      const gateBoundary = openBoundary(repo, "gate");
      runFactory(repo, ["gate-decision", RUN_ID, "pre_pr", "approved", "--artifact", "artifacts/validation-report.md", "--question-ref", "gates/pre_pr.question.md", "--answer-ref", "gates/pre_pr.answer", "--approval-source", "external-driver", "--boundary-token", gateBoundary.token, "--json"]);
      validateFactory(repo);

      const fence = JSON.parse(runFactory(repo, ["pr-fence", RUN_ID, "--json"]).stdout).fence;
      const completed = JSON.parse(runFactory(repo, ["pr-created", RUN_ID, "--pr-url", "https://github.com/jasoncarreira/opencode-feature-factory/pull/123", "--pr-number", "123", "--repository", "jasoncarreira/opencode-feature-factory", "--fence-token", fence.token, "--json"]).stdout);
      const validation = JSON.parse(runFactory(repo, ["validate", RUN_ID]).stdout);

      assert.equal(completed.status, "completed");
      assert.equal(validation.ok, true, JSON.stringify(validation, null, 2));
      assert.equal(readJson(join(runDir, "run.json")).status, "completed");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects blank cost numeric flags without mutating run.json", () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-cli-cost-invalid-"));
    const runDir = join(repo, ".opencode", "factory", RUN_ID);
    try {
      initGitRepo(repo);
      seedRun(runDir);
      const before = readFileSync(join(runDir, "run.json"), "utf8");

      for (const [flag, value] of [["--input-tokens", ""], ["--cost-total", "   "]]) {
        const failed = runFactoryFail(repo, ["cost-record", RUN_ID, "--agent", "backend-builder", flag, value, "--json"]);
        assert.match(failed.stderr, new RegExp(`${flag} must be a finite non-negative number`, "u"));
        assert.equal(readFileSync(join(runDir, "run.json"), "utf8"), before);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects terminal control currency flags without mutating run.json", () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-cli-cost-currency-invalid-"));
    const runDir = join(repo, ".opencode", "factory", RUN_ID);
    try {
      initGitRepo(repo);
      seedRun(runDir);
      const before = readFileSync(join(runDir, "run.json"), "utf8");

      for (const payload of TERMINAL_CURRENCY_PAYLOADS) {
        const failed = runFactoryFail(repo, ["cost-record", RUN_ID, "--agent", "backend-builder", "--input-tokens", "1", "--cost-total", "0.01", "--currency", payload, "--json"]);
        assert.match(failed.stderr, /cost_currency must be an uppercase currency code \(3-12 letters\) with no control characters/u);
        assert.equal(readFileSync(join(runDir, "run.json"), "utf8"), before);
      }
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
      const firstBoundary = openBoundary(repo, "gate");
      runFactory(repo, ["gate-decision", RUN_ID, "story", "approved", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer-ref", "gates/story.answer", "--approval-source", "external-driver", "--boundary-token", firstBoundary.token, "--json"]);

      writeFileSync(join(runDir, "gates", "story.question.md"), "approve updated story?\n", "utf8");
      runFactory(repo, ["gate-decision", RUN_ID, "story", "pending", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer-ref", "gates/story.answer", "--json"]);
      const secondBoundary = openBoundary(repo, "gate");
      assert.match(runFactoryFail(repo, ["gate-decision", RUN_ID, "story", "approved", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer-ref", "gates/story.answer", "--approval-source", "external-driver", "--boundary-token", secondBoundary.token, "--json"]).stderr, /missing gates ref/u);
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
      const terminalBoundary = openBoundary(repo, "terminal");
      runFactory(repo, ["terminal", RUN_ID, "blocked", "--reason", "needs operator", "--boundary-token", terminalBoundary.token, "--json"]);
      const run = readJson(join(runDir, "run.json"));
      assert.equal(run.status, "blocked");
      assert.equal(run.terminal_result.reason, "needs operator");
      const validation = JSON.parse(runFactoryFail(repo, ["validate", RUN_ID]).stdout);
      assert.equal(validation.ok, false);
      assert.equal(validation.runs[0].checks.find((check) => check.name === "run.schema")?.ok, true);
      assert.equal(validation.runs[0].diagnostics.items[0].condition, "terminal-run");
      assert.match(runFactoryFail(repo, ["step", RUN_ID, "spec-writer", "running", "--attempts", "2", "--json"]).stderr, /terminal run 'blocked' cannot be mutated/u);
      assert.match(runFactoryFail(repo, ["slices-seed", RUN_ID, "--from", `.opencode/factory/${RUN_ID}/plan/slices.json`, "--json"]).stderr, /terminal run 'blocked' cannot be mutated/u);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("resolves state commands from a managed git worktree cwd without --repo", () => {
    const repo = mkdtempSync(join(tmpdir(), "feature-factory-cli-worktree-cwd-"));
    const runDir = join(repo, ".opencode", "factory", RUN_ID);
    const branch = `${RUN_ID}-worktree`;
    const worktree = join(repo, ".opencode", "worktrees", branch);
    try {
      initGitRepo(repo);
      mkdirSync(join(repo, ".opencode", "worktrees"), { recursive: true });
      runGit(repo, ["worktree", "add", "-b", branch, worktree]);
      seedRun(runDir);
      writeJson(join(runDir, "run.json"), { ...readJson(join(runDir, "run.json")), branch, worktree });
      writeFileSync(join(runDir, "artifacts", "story.md"), "story\n", "utf8");
      writeFileSync(join(runDir, "gates", "story.question.md"), "approve story?\n", "utf8");

      const current = JSON.parse(runFactoryFrom(worktree, ["status", RUN_ID, "--json"]).stdout);
      runFactoryFrom(worktree, ["gate-decision", RUN_ID, "story", "pending", "--artifact", "artifacts/story.md", "--question-ref", "gates/story.question.md", "--answer-ref", "gates/story.answer", "--json"]);
      const listed = JSON.parse(runFactoryFrom(worktree, ["list", "--json"]).stdout);

      assert.equal(current.run_id, RUN_ID);
      assert.equal(listed[0].run_id, RUN_ID);
      assert.equal(readJson(join(runDir, "run.json")).gates.story.status, "pending");
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

function openBoundary(repo, kind) {
  return JSON.parse(runFactory(repo, ["boundary-open", RUN_ID, kind, "--json"]).stdout).boundary;
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

function runFactoryFrom(cwd, args) {
  const proc = spawnSync(process.execPath, [CLI, "factory", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    timeout: 15000,
  });
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

function spawnFactoryStart(repo, args, bin, capture) {
  return spawnSync(process.execPath, [CLI, "factory", "start", "--repo", repo, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      FEATURE_FACTORY_CAPTURE: capture,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: `${bin}:${process.env.PATH || ""}`,
    },
    timeout: 15000,
  });
}

function writeFakeOpencode(repo, capture) {
  const bin = join(repo, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "opencode");
  writeFileSync(script, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.FEATURE_FACTORY_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }, null, 2) + "\\n");
`, "utf8");
  chmodSync(script, 0o755);
  return bin;
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
