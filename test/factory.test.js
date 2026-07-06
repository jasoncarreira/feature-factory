import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupRun, startFactory, validateState } from "../src/factory.js";

describe("factory state validation", () => {
  it("validates run.json and plan/slices.json in a run directory", () => {
    const repo = tempRepo();
    const runDir = join(repo, ".opencode", "factory", "app-123");
    mkdirSync(join(runDir, "plan"), { recursive: true });
    writeJson(join(runDir, "run.json"), runningRun());
    writeJson(join(runDir, "plan", "slices.json"), slicePlan());

    const result = validateState("app-123", { cwd: repo });

    assert.equal(result.ok, true);
    assert.equal(result.runs[0].checks.length, 2);
    cleanup(repo);
  });

  it("reports invalid run files", () => {
    const repo = tempRepo();
    const runDir = join(repo, ".opencode", "factory", "broken");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "run.json"), { run_id: "broken", status: "blocked" });

    const result = validateState("broken", { cwd: repo });

    assert.equal(result.ok, false);
    assert.equal(result.runs[0].checks[0].errors[0].path, "run.terminal_result");
    cleanup(repo);
  });
});

describe("detached factory start", () => {
  it("starts opencode in the background and records a log path", () => {
    const repo = tempRepo();
    const bin = join(repo, "bin");
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, "opencode");
    writeFileSync(fake, "#!/bin/sh\nprintf '%s\n' \"$@\"\n", "utf8");
    chmodSync(fake, 0o755);

    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      const result = startFactory(["APP-123", "do", "work"], { cwd: repo, detached: true, headless: true });
      assert.equal(result.status, "started");
      assert.equal(typeof result.pid, "number");
      assert.equal(existsSync(result.log), true);
      assert.match(result.command, /opencode run/);
    } finally {
      process.env.PATH = oldPath;
      cleanup(repo);
    }
  });
});

describe("factory cleanup", () => {
  it("removes terminal run state, recorded worktrees, and local branches", () => {
    const repo = gitRepo();
    const runDir = join(repo, ".opencode", "factory", "cleanup-run");
    const worktree = join(repo, ".opencode", "worktrees", "cleanup-run");
    const recordedWorktree = join(".opencode", "worktrees", "cleanup-run");
    mkdirSync(join(repo, ".opencode", "worktrees"), { recursive: true });
    git(repo, ["worktree", "add", "-b", "cleanup-run", worktree, "HEAD"]);
    const physicalWorktree = realpathSync.native(worktree);
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "run.json"), completedRun({ run_id: "cleanup-run", branch: "cleanup-run", worktree: recordedWorktree }));

    const result = cleanupRun("cleanup-run", { cwd: repo });

    assert.equal(result.run_id, "cleanup-run");
    assert.equal(result.removed_run_dir, true);
    assert.deepEqual(result.removed_worktrees, [physicalWorktree]);
    assert.deepEqual(result.deleted_branches, ["cleanup-run"]);
    assert.equal(existsSync(runDir), false);
    assert.equal(existsSync(worktree), false);
    assert.notEqual(gitStatus(repo, ["show-ref", "--verify", "refs/heads/cleanup-run"]), 0);
    cleanup(repo);
  });

  it("refuses to clean active runs without force", () => {
    const repo = tempRepo();
    const runDir = join(repo, ".opencode", "factory", "active-run");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "run.json"), { ...runningRun(), run_id: "active-run" });

    assert.throws(() => cleanupRun("active-run", { cwd: repo }), /cleanup requires terminal status or --force/);
    assert.equal(existsSync(runDir), true);
    cleanup(repo);
  });

  it("previews cleanup without removing files in dry-run mode", () => {
    const repo = tempRepo();
    const runDir = join(repo, ".opencode", "factory", "dry-run");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "run.json"), completedRun({ run_id: "dry-run", branch: null, worktree: null }));

    const result = cleanupRun("dry-run", { cwd: repo, dryRun: true });

    assert.equal(result.dry_run, true);
    assert.equal(result.removed_run_dir, false);
    assert.equal(existsSync(runDir), true);
    cleanup(repo);
  });
});

function tempRepo() {
  return mkdtempSync(join(tmpdir(), "feature-factory-"));
}

function gitRepo() {
  const repo = tempRepo();
  git(repo, ["init"]);
  writeFileSync(join(repo, "README.md"), "# test\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["-c", "user.name=Feature Factory Test", "-c", "user.email=factory@example.com", "commit", "-m", "initial"]);
  return repo;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runningRun() {
  return {
    schema_version: 1,
    run_id: "app-123",
    mode: "headless",
    status: "running",
    updated_at: "2026-07-05T00:00:00.000Z",
    gates: {
      story: {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
      },
    },
  };
}

function completedRun(input) {
  return {
    schema_version: 1,
    run_id: input.run_id,
    mode: "headless",
    status: "completed",
    branch: input.branch,
    worktree: input.worktree,
    updated_at: "2026-07-05T00:00:00.000Z",
    gates: {},
    terminal_result: {
      status: "completed",
      run_id: input.run_id,
      pr_url: null,
      reason: null,
      summary: "done",
      artifacts: {},
    },
  };
}

function git(cwd, args) {
  const proc = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (proc.error) throw proc.error;
  assert.equal(proc.status, 0, `git ${args.join(" ")} failed:\n${proc.stderr || proc.stdout}`);
  return proc;
}

function gitStatus(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).status;
}

function slicePlan() {
  return {
    slices: [
      {
        id: "be-api",
        stack: "backend",
        paths: ["src/server/api/"],
        depends_on: [],
        acceptance: ["AC1"],
        test_plan: ["npm test -- api.feature.test"],
      },
    ],
  };
}
