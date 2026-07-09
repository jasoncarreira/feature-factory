import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverDisruptedRun } from "../src/factory.js";

describe("factory disrupted run recovery", () => {
  it("does not re-scaffold a missing run.json and returns a synthetic non-durable terminal result", async () => {
    const repo = tempRepo("missing-run");
    try {
      const result = await recoverDisruptedRun("missing-run", { cwd: repo, now: "2026-07-08T12:00:00.000Z" });

      assert.equal(result.ok, false);
      assert.equal(result.durable, false);
      assert.equal(result.updated, false);
      assert.equal(result.recovered, false);
      assert.equal(result.status, "blocked");
      assert.match(result.terminal_result.reason, /missing run\.json/i);
      assert.match(result.terminal_result.reason, /No durable terminal_result can be written without forbidden re-scaffolding/i);
      assert.equal(existsSync(join(repo, ".opencode", "factory", "missing-run", "run.json")), false);
    } finally {
      cleanup(repo);
    }
  });

  it("documents the no-re-scaffold recovery contract and synthetic terminal reason", () => {
    for (const [name, text] of Object.entries({
      README: readDoc("../README.md"),
      COMMAND: readDoc("../assets/command/feature.md"),
      SKILL: readDoc("../assets/skills/feature/SKILL.md"),
      SCHEMA: readDoc("../assets/skills/feature/SCHEMA.md"),
    })) {
      assert.match(text, /resume-check/i, `${name} must document resume-check`);
      assert.match(text, /not|never/i, `${name} must explicitly forbid recovery by implication`);
      assert.match(text, /re-scaffold/i, `${name} must document no re-scaffold behavior`);
      assert.match(text, /synthetic non-durable|non-durable terminal-shaped/i, `${name} must document synthetic non-durable terminal output`);
      assert.match(text, /no durable `?terminal_result`? can be written without forbidden re-scaffolding/i, `${name} must document the terminal reason text`);
    }
  });

  it("recovers a missing active worktree from durable state and branch evidence", async () => {
    const fixture = createRecoveryFixture("recoverable-run");
    try {
      rmSync(fixture.worktree, { recursive: true, force: true });

      const result = await recoverDisruptedRun(fixture.runId, { cwd: fixture.repo });

      assert.equal(result.ok, true);
      assert.equal(result.durable, true);
      assert.equal(result.recovered, true);
      assert.equal(result.status, "running");
      assert.equal(result.worktree, fixture.worktree);
      assert.equal(existsSync(join(fixture.worktree, ".git")), true);
      assert.equal(gitStdout(fixture.worktree, ["branch", "--show-current"]), fixture.runId);
      assert.equal(gitStdout(fixture.worktree, ["rev-parse", "HEAD"]), gitStdout(fixture.repo, ["rev-parse", fixture.runId]));
      assert.equal(readJson(join(fixture.runDir, "run.json")).status, "running");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("persists blocked when git base evidence contradicts durable state", async () => {
    const fixture = createRecoveryFixture("base-mismatch-run", { baseMismatch: true });
    try {
      const result = await recoverDisruptedRun(fixture.runId, { cwd: fixture.repo });
      const run = readJson(join(fixture.runDir, "run.json"));

      assert.equal(result.ok, false);
      assert.equal(result.durable, true);
      assert.equal(result.updated, true);
      assert.equal(result.status, "blocked");
      assert.match(result.terminal_result.reason, /base_commit/i);
      assert.match(result.terminal_result.reason, /not an ancestor/i);
      assert.equal(run.status, "blocked");
      assert.match(run.terminal_result.reason, /base_commit/i);
      assert.equal(existsSync(fixture.worktree), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("persists needs-human for unsafe target paths without overwriting them", async () => {
    const fixture = createRecoveryFixture("unsafe-path-run", { worktree: join(tmpdir(), "outside-recovery-target") });
    try {
      writeFileSync(fixture.worktree, "outside file must not be overwritten\n", "utf8");

      const result = await recoverDisruptedRun(fixture.runId, { cwd: fixture.repo });
      const run = readJson(join(fixture.runDir, "run.json"));

      assert.equal(result.ok, false);
      assert.equal(result.status, "needs-human");
      assert.match(result.terminal_result.reason, /outside \.opencode\/worktrees/i);
      assert.equal(readFileSync(fixture.worktree, "utf8"), "outside file must not be overwritten\n");
      assert.equal(run.status, "needs-human");
    } finally {
      rmSync(fixture.worktree, { force: true });
      cleanup(fixture.repo);
    }
  });
});

function createRecoveryFixture(runId, { baseMismatch = false, worktree } = {}) {
  const repo = tempRepo(runId);
  initGitRepo(repo);
  const initial = gitStdout(repo, ["rev-parse", "HEAD"]);
  runGit(repo, ["branch", runId]);
  let baseCommit = initial;
  if (baseMismatch) {
    writeFileSync(join(repo, "after-branch.txt"), "after branch\n", "utf8");
    runGit(repo, ["add", "after-branch.txt"]);
    runGit(repo, ["commit", "-m", "after branch"]);
    baseCommit = gitStdout(repo, ["rev-parse", "HEAD"]);
  }
  const runDir = join(repo, ".opencode", "factory", runId);
  const resolvedWorktree = worktree || join(repo, ".opencode", "worktrees", runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    status: "running",
    base_ref: "main",
    base_commit: baseCommit,
    branch: runId,
    worktree: resolvedWorktree,
    gates: { story: { status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer: "approve", answered_at: "2026-07-08T12:00:00.000Z" } },
    slices: [{ id: "backend", stack: "backend", depends_on: [], status: "merged", merge_commit: initial, evidence_ref: "evidence/backend.md", review_ref: "reviews/backend.json" }],
    terminal_result: null,
  });
  return { repo, runDir, runId, worktree: resolvedWorktree };
}

function tempRepo(name) {
  return mkdtempSync(join(tmpdir(), `factory-disrupted-${name}-`));
}

function initGitRepo(repo) {
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "test\n", "utf8");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "init"]);
}

function runGit(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv() });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function gitStdout(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv() });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

function gitEnv() {
  return { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readDoc(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}
