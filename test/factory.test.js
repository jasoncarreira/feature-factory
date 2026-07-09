import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupRun,
  latestRunId,
  listRuns,
  persistFactoryRunCreatedEnv,
  persistFactoryRunResumeEnv,
  seedRepoSkill,
  status,
  validateState,
  watchRun,
  writeGateAnswer,
} from "../src/factory.js";

describe("factory public state operations", { concurrency: false }, () => {
  it("lists and reads runs without authority proofs", () => {
    const fixture = createFixture("public-run");
    try {
      const listed = listRuns({ cwd: fixture.repo });
      const current = status(fixture.runId, { cwd: fixture.repo });
      assert.equal(listed[0].run_id, fixture.runId);
      assert.equal(current.run_id, fixture.runId);
      assert.equal(current.status, "running");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("breaks latest-run timestamp ties by run id", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-latest-run-"));
    try {
      createFixture("alpha", { repo, updatedAt: "2026-07-08T12:00:00.000Z" });
      createFixture("zulu", { repo, updatedAt: "2026-07-08T12:00:00.000Z" });

      assert.equal(latestRunId({ cwd: repo }), "zulu");
      assert.deepEqual(listRuns({ cwd: repo }).map((run) => run.run_id), ["zulu", "alpha"]);
    } finally {
      cleanup(repo);
    }
  });

  it("writes gate answers after pending snapshot freshness checks", () => {
    const fixture = createFixture("gate-answer", { gate: true });
    try {
      const result = writeGateAnswer(fixture.runId, "story", "approve", { cwd: fixture.repo });
      assert.equal(result.answer, "approve");
      assert.equal(readFileSync(join(fixture.runDir, "gates", "story.answer"), "utf8"), "approve\n");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("validates schema and advisory consistency", () => {
    const fixture = createFixture("validate-run", { gate: true });
    try {
      const result = validateState(fixture.runId, { cwd: fixture.repo });
      assert.equal(result.ok, true);
      assert.equal(result.runs[0].checks.some((check) => check.name === "run.schema"), true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("records redacted debug snapshots", async () => {
    const fixture = createFixture("env-run");
    try {
      const created = await persistFactoryRunCreatedEnv(fixture.runId, { cwd: fixture.repo, now: "2026-07-08T12:00:00.000Z" });
      const resumed = await persistFactoryRunResumeEnv(fixture.runId, { cwd: fixture.repo, now: "2026-07-08T13:00:00.000Z" });
      const run = readJson(join(fixture.runDir, "run.json"));
      assert.equal(created.resume_count, 0);
      assert.equal(resumed.resume_count, 1);
      assert.equal(run.debug_snapshot.last_resumed_with.event, "run-resumed");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("resolves bare run ids under the factory root before same-name repo paths", () => {
    const fixture = createFixture("shadow-run");
    try {
      const shadow = join(fixture.repo, fixture.runId);
      mkdirSync(shadow, { recursive: true });
      writeJson(join(shadow, "run.json"), { schema_version: 1, run_id: "shadow-outside", status: "blocked", terminal_result: { status: "blocked", run_id: "shadow-outside", reason: "outside" } });

      assert.equal(status(fixture.runId, { cwd: fixture.repo }).run_id, fixture.runId);
      assert.throws(
        () => status(shadow, { cwd: fixture.repo }),
        /inside \.opencode\/factory/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("emits a removed event when a watched run disappears", async () => {
    const fixture = createFixture("watch-removed");
    const logs = [];
    const originalLog = console.log;
    console.log = (value) => logs.push(value);
    try {
      const timer = watchRun(fixture.runId, { cwd: fixture.repo, intervalMs: 10 });
      rmSync(fixture.runDir, { recursive: true, force: true });
      await waitFor(() => logs.some((line) => JSON.parse(line).status === "removed"), { timeoutMs: 10000 });
      if (timer) clearInterval(timer);
    } finally {
      console.log = originalLog;
      cleanup(fixture.repo);
    }
  });

  it("does not clobber locally edited seeded feature skills", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-seed-skill-"));
    try {
      const dest = seedRepoSkill(repo);
      const skill = join(dest, "SKILL.md");
      writeFileSync(skill, "local edit\n", "utf8");

      seedRepoSkill(repo);

      assert.equal(readFileSync(skill, "utf8"), "local edit\n");
    } finally {
      cleanup(repo);
    }
  });

  it("repairs recognized stale seeded feature skills when seed metadata is missing", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-seed-skill-stale-"));
    try {
      const dest = seedRepoSkill(repo);
      const skill = join(dest, "SKILL.md");
      const schema = join(dest, "SCHEMA.md");
      const seedHash = join(dest, ".seed-hash");
      const currentSkill = readFileSync(skill, "utf8");
      const currentSchema = readFileSync(schema, "utf8");
      const staleSkill = "older packaged skill\n";
      const staleSchema = "older packaged schema\n";
      writeFileSync(skill, staleSkill, "utf8");
      writeFileSync(schema, staleSchema, "utf8");
      rmSync(seedHash, { force: true });

      const warnings = captureWarnings(() => seedRepoSkill(repo, {
        knownSeedHashes: {
          "SKILL.md": new Set([sha256(staleSkill)]),
          "SCHEMA.md": new Set([sha256(staleSchema)]),
        },
      }));

      assert.equal(readFileSync(skill, "utf8"), currentSkill);
      assert.equal(readFileSync(schema, "utf8"), currentSchema);
      assert.deepEqual(readJson(seedHash), {
        "SKILL.md": sha256(currentSkill),
        "SCHEMA.md": sha256(currentSchema),
      });
      assert.match(warnings.join("\n"), /refreshed stale repo-seeded feature skill file\(s\): SKILL\.md, SCHEMA\.md/u);
    } finally {
      cleanup(repo);
    }
  });

  it("repairs recognized stale seeded feature skills when seed metadata is empty", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-seed-skill-empty-"));
    try {
      const dest = seedRepoSkill(repo);
      const skill = join(dest, "SKILL.md");
      const schema = join(dest, "SCHEMA.md");
      const seedHash = join(dest, ".seed-hash");
      const currentSkill = readFileSync(skill, "utf8");
      const currentSchema = readFileSync(schema, "utf8");
      const staleSkill = "older packaged skill from empty metadata\n";
      const staleSchema = "older packaged schema from empty metadata\n";
      writeFileSync(skill, staleSkill, "utf8");
      writeFileSync(schema, staleSchema, "utf8");
      writeFileSync(seedHash, "", "utf8");

      seedRepoSkill(repo, {
        knownSeedHashes: {
          "SKILL.md": new Set([sha256(staleSkill)]),
          "SCHEMA.md": new Set([sha256(staleSchema)]),
        },
      });

      assert.equal(readFileSync(skill, "utf8"), currentSkill);
      assert.equal(readFileSync(schema, "utf8"), currentSchema);
      assert.deepEqual(readJson(seedHash), {
        "SKILL.md": sha256(currentSkill),
        "SCHEMA.md": sha256(currentSchema),
      });
    } finally {
      cleanup(repo);
    }
  });

  it("preserves unrecognized local seeded feature edits with empty metadata", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-seed-skill-local-"));
    try {
      const dest = seedRepoSkill(repo);
      const skill = join(dest, "SKILL.md");
      const schema = join(dest, "SCHEMA.md");
      const seedHash = join(dest, ".seed-hash");
      const currentSkill = readFileSync(skill, "utf8");
      const currentSchema = readFileSync(schema, "utf8");
      const staleSchema = "older packaged schema alongside local edit\n";
      writeFileSync(skill, "local edit\n", "utf8");
      writeFileSync(schema, staleSchema, "utf8");
      writeFileSync(seedHash, "{}\n", "utf8");

      const warnings = captureWarnings(() => seedRepoSkill(repo, {
        knownSeedHashes: {
          "SCHEMA.md": new Set([sha256(staleSchema)]),
        },
      }));

      assert.equal(readFileSync(skill, "utf8"), "local edit\n");
      assert.equal(readFileSync(schema, "utf8"), currentSchema);
      assert.deepEqual(readJson(seedHash), {
        "SKILL.md": sha256(currentSkill),
        "SCHEMA.md": sha256(currentSchema),
      });
      assert.match(warnings.join("\n"), /preserved locally edited seeded skill file\(s\): SKILL\.md/u);

      seedRepoSkill(repo);

      assert.equal(readFileSync(skill, "utf8"), "local edit\n");
    } finally {
      cleanup(repo);
    }
  });

  it("leaves unrelated feature skill files unchanged and absent from seed metadata", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-seed-skill-unrelated-"));
    try {
      const dest = seedRepoSkill(repo);
      const skill = join(dest, "SKILL.md");
      const schema = join(dest, "SCHEMA.md");
      const seedHash = join(dest, ".seed-hash");
      const currentSkill = readFileSync(skill, "utf8");
      const currentSchema = readFileSync(schema, "utf8");
      const notes = join(dest, "NOTES.md");
      writeFileSync(notes, "operator notes\n", "utf8");
      writeJson(seedHash, {
        "SKILL.md": sha256(currentSkill),
        "SCHEMA.md": sha256(currentSchema),
        "NOTES.md": sha256("old notes\n"),
      });

      seedRepoSkill(repo);

      assert.equal(readFileSync(notes, "utf8"), "operator notes\n");
      assert.deepEqual(readJson(seedHash), {
        "SKILL.md": sha256(currentSkill),
        "SCHEMA.md": sha256(currentSchema),
      });
    } finally {
      cleanup(repo);
    }
  });

  it("rejects symlinked repo-seeded feature skill parent and skill directories", () => {
    for (const attack of ["opencode", "parent", "skill"])
      assertRejectsSeedSymlinkAttack(attack, ({ repo, outside }) => {
        if (attack === "opencode") {
          symlinkSync(outside, join(repo, ".opencode"));
        } else if (attack === "parent") {
          mkdirSync(join(repo, ".opencode"), { recursive: true });
          symlinkSync(outside, join(repo, ".opencode", "skills"));
        } else {
          mkdirSync(join(repo, ".opencode", "skills"), { recursive: true });
          symlinkSync(outside, join(repo, ".opencode", "skills", "feature"));
        }
      }, ({ outside }) => {
        assert.equal(existsSync(join(outside, "SKILL.md")), false);
        assert.equal(existsSync(join(outside, "SCHEMA.md")), false);
      });
  });

  it("rejects symlinked repo-seeded feature skill target files", () => {
    for (const file of ["SKILL.md", "SCHEMA.md"])
      assertRejectsSeedSymlinkAttack(file, ({ repo, outside }) => {
        const dest = seedRepoSkill(repo);
        const outsideFile = join(outside, file);
        writeFileSync(outsideFile, "outside original\n", "utf8");
        rmSync(join(dest, file), { force: true });
        symlinkSync(outsideFile, join(dest, file));
      }, ({ outside }) => {
        assert.equal(readFileSync(join(outside, file), "utf8"), "outside original\n");
      });
  });

  it("rejects symlinked repo-seeded feature skill seed metadata", () => {
    assertRejectsSeedSymlinkAttack("seed-hash", ({ repo, outside }) => {
      const dest = seedRepoSkill(repo);
      const outsideFile = join(outside, ".seed-hash");
      writeFileSync(outsideFile, "outside metadata\n", "utf8");
      rmSync(join(dest, ".seed-hash"), { force: true });
      symlinkSync(outsideFile, join(dest, ".seed-hash"));
    }, ({ outside }) => {
      assert.equal(readFileSync(join(outside, ".seed-hash"), "utf8"), "outside metadata\n");
    });
  });

  it("cleans terminal run state, branches, and registered worktrees", async () => {
    const fixture = createFixture("cleanup-run", { terminal: true, git: true });
    try {
      const result = await cleanupRun(fixture.runId, { cwd: fixture.repo, force: true });
      assert.equal(result.removed_run_dir, true);
      assert.equal(result.deleted_branches.includes("cleanup-run"), true);
      assert.equal(result.removed_worktrees.length, 1);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("skips unmerged branch deletion by default for completed runs", async () => {
    const fixture = createFixture("cleanup-unmerged", { terminal: true, git: true });
    try {
      commitInWorktree(join(fixture.repo, ".opencode", "worktrees", fixture.runId), "feature.txt", "feature\n");
      const result = await cleanupRun(fixture.runId, { cwd: fixture.repo });
      assert.equal(branchExists(fixture.repo, fixture.runId), true);
      assert.equal(result.deleted_branches.includes(fixture.runId), false);
      assert.equal(result.skipped_branches.some((item) => item.branch === fixture.runId && /not fully merged|not merged/u.test(item.reason)), true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("force deletes unmerged branches when requested", async () => {
    const fixture = createFixture("cleanup-force-unmerged", { terminal: true, git: true });
    try {
      commitInWorktree(join(fixture.repo, ".opencode", "worktrees", fixture.runId), "feature.txt", "feature\n");
      const result = await cleanupRun(fixture.runId, { cwd: fixture.repo, force: true });
      assert.equal(branchExists(fixture.repo, fixture.runId), false);
      assert.equal(result.deleted_branches.includes(fixture.runId), true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("skips cleanup worktrees that do not match the recorded branch", async () => {
    const fixture = createFixture("cleanup-branch-mismatch", { terminal: true, git: true });
    try {
      const runFile = join(fixture.runDir, "run.json");
      writeJson(runFile, { ...readJson(runFile), branch: "different-branch" });

      const result = await cleanupRun(fixture.runId, { cwd: fixture.repo, force: true });

      assert.equal(result.removed_worktrees.length, 0);
      assert.equal(result.skipped_worktrees.some((item) => /branch-mismatch/u.test(item.reason)), true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("refuses cleanup while heartbeat liveness is fresh without force", async () => {
    const fixture = createFixture("cleanup-fresh-heartbeat", { terminal: true });
    try {
      writeJson(join(fixture.runDir, "heartbeat.json"), {
        schema_version: 1,
        run_id: fixture.runId,
        phase: "cleanup",
        pid: process.pid,
        interval_ms: 30000,
        last_tick_at: new Date().toISOString(),
      });

      await assert.rejects(
        cleanupRun(fixture.runId, { cwd: fixture.repo }),
        /fresh heartbeat/u,
      );
      assert.equal(existsSync(join(fixture.runDir, "run.json")), true);

      const result = await cleanupRun(fixture.runId, { cwd: fixture.repo, force: true });
      assert.equal(result.removed_run_dir, true);
    } finally {
      cleanup(fixture.repo);
    }
  });
});

function createFixture(runId, { gate = false, terminal = false, git = false, repo = mkdtempSync(join(tmpdir(), "factory-simplified-")), updatedAt = undefined } = {}) {
  if (git) initGitRepo(repo, runId);
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "gates"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "story.md"), "story\n");
  writeFileSync(join(runDir, "gates", "story.question.md"), "approve?\n");
  const run = {
    schema_version: 1,
    run_id: runId,
    status: terminal ? "completed" : "running",
    updated_at: updatedAt,
    branch: git ? runId : null,
    worktree: git ? join(repo, ".opencode", "worktrees", runId) : null,
    gates: gate ? {
      story: {
        status: "pending",
        artifact: "artifacts/story.md",
        question_ref: "gates/story.question.md",
        answer_ref: "gates/story.answer",
        pending_snapshot: {
          question_ref: "gates/story.question.md",
          question_hash: hashFile(join(runDir, "gates", "story.question.md")),
          artifact_ref: "artifacts/story.md",
          artifact_hash: hashFile(join(runDir, "artifacts", "story.md")),
          answer_ref: "gates/story.answer",
          created_at: "2026-07-08T12:00:00.000Z",
        },
      },
    } : {},
    terminal_result: terminal ? { status: "completed", run_id: runId, pr_url: null, reason: null, summary: "done", artifacts: {} } : null,
  };
  writeJson(join(runDir, "run.json"), run);
  return { repo, runDir, runId };
}

function initGitRepo(repo, branch) {
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "test\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "init"]);
  mkdirSync(join(repo, ".opencode", "worktrees"), { recursive: true });
  runGit(repo, ["worktree", "add", "-b", branch, join(repo, ".opencode", "worktrees", branch)]);
}

function runGit(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function commitInWorktree(worktree, file, content) {
  writeFileSync(join(worktree, file), content);
  runGit(worktree, ["add", file]);
  runGit(worktree, ["commit", "-m", `add ${file}`]);
}

function branchExists(repo, branch) {
  const proc = spawnSync("git", ["show-ref", "--verify", `refs/heads/${branch}`], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  return proc.status === 0;
}

function hashFile(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function captureWarnings(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    fn();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

function assertRejectsSeedSymlinkAttack(name, arrange, assertAfter = () => {}) {
  const repo = mkdtempSync(join(tmpdir(), `factory-seed-symlink-${name}-`));
  const outside = mkdtempSync(join(tmpdir(), `factory-seed-symlink-outside-${name}-`));
  try {
    arrange({ repo, outside });

    assert.throws(
      () => seedRepoSkill(repo),
      /symlink/u,
    );
    assertAfter({ repo, outside });
  } finally {
    cleanup(repo);
    cleanup(outside);
  }
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`timed out after ${timeoutMs}ms`);
}
