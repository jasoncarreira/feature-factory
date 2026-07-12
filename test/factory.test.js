import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "./helpers/git-fixture.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CleanupRunUnexpectedError,
  cleanupRunLocked,
  cleanupRun,
  collectCleanupTargets,
  latestRunId,
  listRuns,
  persistFactoryRunCreatedEnv,
  persistFactoryRunResumeEnv,
  recordCostUsage,
  seedRepoSkill,
  status,
  validateState,
  watchRun,
  writeGateAnswer,
  writeSteering,
} from "../src/factory.js";

describe("factory public state operations", { concurrency: false }, () => {
  it("lists and reads runs without authority proofs", () => {
    const fixture = createFixture("public-run");
    try {
      const listed = listRuns({ cwd: fixture.repo });
      const current = status(fixture.runId, { cwd: fixture.repo });
      assert.equal(listed[0].run_id, fixture.runId);
      assert.equal(listed[0].cost_summary, null);
      assert.equal(current.run_id, fixture.runId);
      assert.equal(current.status, "running");
      assert.equal(current.cost_summary, null);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("keeps pending steering read-only and redacted across public projections", async () => {
    const fixture = createFixture("public-steering");
    const rawSteering = "raw operator steering must remain in its pending file";
    const logs = [];
    const originalLog = console.log;
    let timer = null;
    try {
      const queued = await writeSteering(fixture.runId, rawSteering, {
        cwd: fixture.repo,
        now: "2026-07-08T12:00:00.000Z",
        id: "public-read-only",
      });
      const before = snapshotPendingSteering(fixture);
      const current = status(fixture.runId, { cwd: fixture.repo });
      const listed = listRuns({ cwd: fixture.repo })[0];
      const validation = validateState(fixture.runId, { cwd: fixture.repo });

      console.log = (value) => logs.push(String(value));
      timer = watchRun(fixture.runId, { cwd: fixture.repo, intervalMs: 60000 });
      assert.equal(logs.length, 1, "watch must emit its first projection synchronously");
      const watched = JSON.parse(logs[0]);
      clearInterval(timer);
      timer = null;
      await new Promise((resolve) => setTimeout(resolve, 10));

      for (const projection of [current, listed, watched]) {
        assert.deepEqual(projection.steering.pending, queued.steering);
        assert.deepEqual(Object.keys(projection.steering.pending).sort(), ["created_at", "hash", "id", "message_chars", "ref"]);
        assert.equal(projection.steering.consumed_count, 0);
        assert.equal(projection.steering.latest_consumed, null);
      }
      const pendingCheck = validation.runs[0].checks.find((check) => check.name === "run.steering.pending.ref");
      assert.equal(validation.ok, true);
      assert.equal(pendingCheck?.ok, true);
      assert.equal(pendingCheck?.details.ref, queued.steering.ref);

      for (const output of [current, listed, validation, watched, logs]) {
        assert.equal(JSON.stringify(output).includes(rawSteering), false);
      }
      assertPendingSteeringUnchanged(fixture, before);
    } finally {
      if (timer) clearInterval(timer);
      console.log = originalLog;
      cleanup(fixture.repo);
    }
  });

  it("records cost usage and exposes public summaries in status and list", async () => {
    const fixture = createFixture("cost-run");
    try {
      const recorded = await recordCostUsage(fixture.runId, {
        agent: "backend-builder",
        step: "build",
        provider: "opencode",
        model: "gpt-5.5",
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cost_total: 0.02,
        cost_currency: "USD",
      }, { cwd: fixture.repo, now: "2026-07-08T12:30:00.000Z", entryId: "cost-1" });

      const run = readJson(join(fixture.runDir, "run.json"));
      const current = status(fixture.runId, { cwd: fixture.repo });
      const listed = listRuns({ cwd: fixture.repo })[0];

      assert.equal(recorded.entry.id, "cost-1");
      assert.equal(recorded.entry.run_id, fixture.runId);
      assert.equal(run.cost_attribution.entries.length, 1);
      assert.equal(current.cost_summary.status, "available");
      assert.equal(current.cost_summary.entry_count, 1);
      assert.equal(current.cost_summary.total_tokens, 15);
      assert.equal(listed.cost_summary.cost_total, 0.02);
      assert.equal(listed.cost_summary.cost_currency, "USD");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("does not coerce missing cost metadata to zero", async () => {
    const fixture = createFixture("cost-partial");
    try {
      const recorded = await recordCostUsage(fixture.runId, {
        agent: "backend-builder",
        input_tokens: 7,
      }, { cwd: fixture.repo, now: "2026-07-08T12:30:00.000Z", entryId: "cost-partial-1" });

      const current = status(fixture.runId, { cwd: fixture.repo });

      assert.equal(recorded.entry.status, "partial");
      assert.equal(Object.hasOwn(recorded.entry, "cost_total"), false);
      assert.equal(Object.hasOwn(recorded.entry, "output_tokens"), false);
      assert.equal(Object.hasOwn(current.cost_summary, "cost_total"), false);
      assert.deepEqual(recorded.entry.missing, ["cost_currency", "cost_total", "model", "provider"]);
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

  it("repairs recognized stale seeded feature skills when seed metadata is invalid", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-seed-skill-invalid-"));
    try {
      const dest = seedRepoSkill(repo);
      const skill = join(dest, "SKILL.md");
      const schema = join(dest, "SCHEMA.md");
      const seedHash = join(dest, ".seed-hash");
      const currentSkill = readFileSync(skill, "utf8");
      const currentSchema = readFileSync(schema, "utf8");
      const staleSkill = "older packaged skill from invalid metadata\n";
      const staleSchema = "older packaged schema from invalid metadata\n";
      writeFileSync(skill, staleSkill, "utf8");
      writeFileSync(schema, staleSchema, "utf8");
      writeFileSync(seedHash, "{\n", "utf8");

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

  it("collects the same deduplicated run and slice targets used by single-run cleanup", () => {
    const run = {
      branch: "run-branch",
      worktree: "/repo/.opencode/worktrees/run-branch",
      slices: [
        { id: "one", branch: "slice-branch", worktree: "/repo/.opencode/worktrees/slice-branch" },
        { id: "duplicate", branch: "run-branch", worktree: "/repo/.opencode/worktrees/run-branch" },
      ],
    };

    assert.deepEqual(collectCleanupTargets(run), {
      worktrees: [
        { branch: "run-branch", worktree: "/repo/.opencode/worktrees/run-branch" },
        { branch: "slice-branch", slice_id: "one", worktree: "/repo/.opencode/worktrees/slice-branch" },
      ],
      branches: ["run-branch", "slice-branch"],
    });
  });

  it("removes sweep targets in canonical order and deletes branches only by CAS", () => {
    const fixture = createFixture("cleanup-sweep-order", { terminal: true, git: true });
    try {
      runGit(fixture.repo, ["branch", "zeta"]);
      runGit(fixture.repo, ["branch", "alpha"]);
      const runFile = join(fixture.runDir, "run.json");
      const run = { ...readJson(runFile), slices: [{ branch: "zeta" }, { branch: "alpha" }] };
      const expectedHeads = Object.fromEntries(collectCleanupTargets(run).branches.map((branch) => [branch, branchHead(fixture.repo, branch)]));
      const events = [];
      const commands = [];

      const cleanupResult = cleanupRunLocked(fixture.runDir, run, {
        mode: "sweep",
        repo: fixture.repo,
        expectedRunHash: hashFile(runFile),
        expectedBranchHeads: expectedHeads,
        fetchedBaseRef: "main",
        gitRunner: recordingGitRunner(commands),
        phaseHook: (phase, detail) => events.push(`${phase}:${detail.branch || detail.physical_path || detail.path}`),
      });

      assert.deepEqual(cleanupResult.worktrees.map((item) => item.outcome), ["removed"]);
      assert.deepEqual(cleanupResult.branches.map((item) => item.name), ["alpha", fixture.runId, "zeta"]);
      assert.deepEqual(cleanupResult.branches.map((item) => item.outcome), ["deleted", "deleted", "deleted"]);
      assert.equal(cleanupResult.run_dir.outcome, "removed");
      assert.deepEqual(commands.filter((args) => args[0] === "update-ref"), [
        ["update-ref", "-d", "refs/heads/alpha", expectedHeads.alpha],
        ["update-ref", "-d", `refs/heads/${fixture.runId}`, expectedHeads[fixture.runId]],
        ["update-ref", "-d", "refs/heads/zeta", expectedHeads.zeta],
      ]);
      assert.equal(events[0].startsWith("before-worktree-remove:"), true);
      assert.deepEqual(events.slice(1, 4), [
        "before-branch-delete:alpha",
        `before-branch-delete:${fixture.runId}`,
        "before-branch-delete:zeta",
      ]);
      assert.equal(events[4], `before-run-dir-remove:${fixture.runDir}`);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("revalidates the registered worktree branch and exact HEAD after an intervening mutation", () => {
    const fixture = createFixture("cleanup-sweep-mutated-worktree", { terminal: true, git: true });
    try {
      const runFile = join(fixture.runDir, "run.json");
      const run = readJson(runFile);
      const expectedHeads = { [fixture.runId]: branchHead(fixture.repo, fixture.runId) };
      const commands = [];

      const cleanupResult = cleanupRunLocked(fixture.runDir, run, {
        mode: "sweep",
        repo: fixture.repo,
        expectedRunHash: hashFile(runFile),
        expectedBranchHeads: expectedHeads,
        fetchedBaseRef: "main",
        gitRunner: recordingGitRunner(commands),
        phaseHook: (phase) => {
          if (phase === "before-worktree-remove") {
            commitInWorktree(run.worktree, "changed-after-authorization.txt", "changed\n");
          }
        },
      });

      assert.equal(cleanupResult.worktrees[0].outcome, "failed");
      assert.equal(cleanupResult.branches[0].outcome, "not-attempted");
      assert.equal(cleanupResult.run_dir.outcome, "retained");
      assert.equal(existsSync(run.worktree), true);
      assert.equal(commands.some((args) => args[0] === "worktree" && args[1] === "remove"), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("refuses branch CAS when a new registered worktree checks out the branch", () => {
    const fixture = createFixture("cleanup-sweep-unexpected-checkout", { terminal: true, git: true });
    const unexpectedWorktree = join(fixture.repo, ".opencode", "worktrees", "unexpected-checkout");
    try {
      runGit(fixture.repo, ["branch", "target-branch"]);
      const runFile = join(fixture.runDir, "run.json");
      const run = { ...readJson(runFile), slices: [{ branch: "target-branch" }] };
      const expectedHeads = Object.fromEntries(collectCleanupTargets(run).branches.map((branch) => [branch, branchHead(fixture.repo, branch)]));
      const commands = [];

      const cleanupResult = cleanupRunLocked(fixture.runDir, run, {
        mode: "sweep",
        repo: fixture.repo,
        expectedRunHash: hashFile(runFile),
        expectedBranchHeads: expectedHeads,
        fetchedBaseRef: "main",
        gitRunner: recordingGitRunner(commands),
        phaseHook: (phase, detail) => {
          if (phase === "before-branch-delete" && detail.branch === "target-branch") {
            runGit(fixture.repo, ["worktree", "add", unexpectedWorktree, "target-branch"]);
          }
        },
      });

      const target = cleanupResult.branches.find((item) => item.name === "target-branch");
      assert.equal(target.outcome, "failed");
      assert.equal(branchExists(fixture.repo, "target-branch"), true);
      assert.equal(commands.some((args) => args[0] === "update-ref" && args[2] === "refs/heads/target-branch"), false);
      assert.equal(cleanupResult.run_dir.outcome, "retained");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("retains sweep state after worktree failure, skips its branch, and continues independent branches", () => {
    const fixture = createFixture("cleanup-sweep-worktree-failure", { terminal: true, git: true });
    try {
      runGit(fixture.repo, ["branch", "independent"]);
      const runFile = join(fixture.runDir, "run.json");
      const run = { ...readJson(runFile), slices: [{ branch: "independent" }] };
      const expectedHeads = Object.fromEntries(collectCleanupTargets(run).branches.map((branch) => [branch, branchHead(fixture.repo, branch)]));
      const runner = recordingGitRunner([], (args) => args[0] === "worktree" && args[1] === "remove");

      const cleanupResult = cleanupRunLocked(fixture.runDir, run, {
        mode: "sweep",
        repo: fixture.repo,
        expectedRunHash: hashFile(runFile),
        expectedBranchHeads: expectedHeads,
        fetchedBaseRef: "main",
        gitRunner: runner,
      });

      assert.equal(cleanupResult.worktrees[0].outcome, "failed");
      assert.deepEqual(cleanupResult.branches.map(({ name, outcome }) => ({ name, outcome })), [
        { name: fixture.runId, outcome: "not-attempted" },
        { name: "independent", outcome: "deleted" },
      ]);
      assert.deepEqual(cleanupResult.run_dir, {
        path: fixture.runDir,
        outcome: "retained",
        reason_code: "RETAINED_AFTER_PARTIAL_FAILURE",
      });
      assert.equal(existsSync(runFile), true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("continues branch CAS deletion after a failure and retains the run directory", () => {
    const fixture = createFixture("cleanup-sweep-cas-failure", { terminal: true, git: false });
    try {
      initGitRepo(fixture.repo, "unused-worktree");
      runGit(fixture.repo, ["branch", "alpha"]);
      runGit(fixture.repo, ["branch", "zeta"]);
      const runFile = join(fixture.runDir, "run.json");
      const run = { ...readJson(runFile), branch: "zeta", worktree: null, slices: [{ branch: "alpha" }] };
      const expectedHeads = Object.fromEntries(collectCleanupTargets(run).branches.map((branch) => [branch, branchHead(fixture.repo, branch)]));
      const runner = recordingGitRunner([], (args) => args[0] === "update-ref" && args[2] === "refs/heads/alpha");

      const cleanupResult = cleanupRunLocked(fixture.runDir, run, {
        mode: "sweep",
        repo: fixture.repo,
        expectedRunHash: hashFile(runFile),
        expectedBranchHeads: expectedHeads,
        fetchedBaseRef: "main",
        gitRunner: runner,
      });

      assert.deepEqual(cleanupResult.branches.map(({ name, outcome }) => ({ name, outcome })), [
        { name: "alpha", outcome: "failed" },
        { name: "zeta", outcome: "deleted" },
      ]);
      assert.equal(cleanupResult.run_dir.outcome, "retained");
      assert.equal(branchExists(fixture.repo, "alpha"), true);
      assert.equal(branchExists(fixture.repo, "zeta"), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("reports run-directory removal failure after all sweep targets succeed", () => {
    const fixture = createFixture("cleanup-sweep-run-dir-failure", { terminal: true });
    try {
      const runFile = join(fixture.runDir, "run.json");
      const cleanupResult = cleanupRunLocked(fixture.runDir, readJson(runFile), {
        mode: "sweep",
        repo: fixture.repo,
        expectedRunHash: hashFile(runFile),
        expectedBranchHeads: {},
        fetchedBaseRef: "main",
        removeRunDir: () => { throw new Error("injected failure"); },
      });

      assert.deepEqual(cleanupResult.run_dir, {
        path: fixture.runDir,
        outcome: "failed",
        reason_code: "FAILED_CLEANUP_RUN_DIR",
      });
      assert.equal(existsSync(runFile), true);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("preserves R51 partial evidence when an unexpected failure follows mutation", () => {
    const fixture = createFixture("cleanup-sweep-unexpected", { terminal: true, git: false });
    try {
      initGitRepo(fixture.repo, "unrelated-worktree");
      runGit(fixture.repo, ["branch", "alpha"]);
      runGit(fixture.repo, ["branch", "zeta"]);
      const runFile = join(fixture.runDir, "run.json");
      const run = { ...readJson(runFile), branch: "zeta", worktree: null, slices: [{ branch: "alpha" }] };
      const expectedHeads = Object.fromEntries(collectCleanupTargets(run).branches.map((branch) => [branch, branchHead(fixture.repo, branch)]));

      const error = captureThrown(() => cleanupRunLocked(fixture.runDir, run, {
        mode: "sweep",
        repo: fixture.repo,
        expectedRunHash: hashFile(runFile),
        expectedBranchHeads: expectedHeads,
        fetchedBaseRef: "main",
        gitRunner: recordingGitRunner([]),
        phaseHook: (phase, detail) => {
          if (phase === "before-branch-delete" && detail.branch === "zeta") throw new Error("injected unexpected failure");
        },
      }));

      assert.equal(error instanceof CleanupRunUnexpectedError, true);
      assert.equal(error.code, "FAILED_CLEANUP_UNEXPECTED");
      assert.equal(error.cause?.message, "injected unexpected failure");
      assert.deepEqual(error.cleanup.branches.map(({ name, outcome }) => ({ name, outcome })), [
        { name: "alpha", outcome: "deleted" },
        { name: "zeta", outcome: "failed" },
      ]);
      assert.deepEqual(error.cleanup.run_dir, {
        path: fixture.runDir,
        outcome: "retained",
        reason_code: "RETAINED_AFTER_PARTIAL_FAILURE",
      });
      assert.equal(branchExists(fixture.repo, "alpha"), false);
      assert.equal(branchExists(fixture.repo, "zeta"), true);
      assert.equal(existsSync(runFile), true);
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

function branchHead(repo, branch) {
  const proc = spawnSync("git", ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

function recordingGitRunner(commands, shouldFail = () => false) {
  return (repo, args) => {
    commands.push([...args]);
    if (shouldFail(args)) return { ok: false, status: 1, stdout: "", stderr: "injected failure" };
    const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    return { ok: proc.status === 0, status: proc.status, stdout: proc.stdout || "", stderr: proc.stderr || "" };
  };
}

function captureThrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected function to throw");
}

function hashFile(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function snapshotPendingSteering(fixture) {
  const runFile = join(fixture.runDir, "run.json");
  const run = readJson(runFile);
  const steeringDir = join(fixture.runDir, "steering");
  assert.ok(run.steering?.pending, "fixture must have pending steering metadata");
  return {
    runText: readFileSync(runFile, "utf8"),
    pending: run.steering.pending,
    history: run.steering.history,
    pendingText: readFileSync(join(fixture.runDir, run.steering.pending.ref), "utf8"),
    files: readdirSync(steeringDir).sort(),
  };
}

function assertPendingSteeringUnchanged(fixture, before) {
  const runFile = join(fixture.runDir, "run.json");
  const run = readJson(runFile);
  const files = readdirSync(join(fixture.runDir, "steering")).sort();

  assert.equal(readFileSync(runFile, "utf8"), before.runText);
  assert.deepEqual(run.steering.pending, before.pending);
  assert.deepEqual(run.steering.history, before.history);
  assert.equal(readFileSync(join(fixture.runDir, before.pending.ref), "utf8"), before.pendingText);
  assert.deepEqual(files, before.files);
  assert.equal(files.some((file) => file.startsWith("consumed-")), false);
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
