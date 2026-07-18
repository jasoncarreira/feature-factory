import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "./helpers/git-fixture.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRuns, recoverDisruptedRun, status, validateState } from "../src/factory.js";

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

  it("does not overwrite malformed run.json and returns a synthetic non-durable terminal result", async () => {
    const repo = tempRepo("malformed-run");
    const runDir = join(repo, ".opencode", "factory", "malformed-run");
    const runFile = join(runDir, "run.json");
    try {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(runFile, "{ malformed durable state\n", "utf8");
      const before = readFileSync(runFile, "utf8");

      const result = await recoverDisruptedRun("malformed-run", { cwd: repo, now: "2026-07-08T12:00:00.000Z" });

      assert.equal(result.ok, false);
      assert.equal(result.durable, false);
      assert.equal(result.updated, false);
      assert.equal(result.recovered, false);
      assert.equal(result.status, "blocked");
      assert.match(result.terminal_result.reason, /invalid run\.json/i);
      assert.match(result.terminal_result.reason, /No durable terminal_result can be written without forbidden re-scaffolding/i);
      assert.equal(readFileSync(runFile, "utf8"), before);
      assert.equal(existsSync(join(repo, ".opencode", "worktrees", "malformed-run")), false);
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

  it("refuses recovery on unsafe ownership and preserves claim, process, and heartbeat sidecars byte-for-byte", async () => {
    const fixture = createRecoveryFixture("unsafe-ownership-run");
    try {
      rmSync(fixture.worktree, { recursive: true, force: true });
      const claimDir = join(fixture.runDir, "process-launch.lock");
      mkdirSync(claimDir, { recursive: true });
      const paths = {
        claim: join(claimDir, "owner.json"),
        process: join(fixture.runDir, "process.json"),
        heartbeat: join(fixture.runDir, "heartbeat.json"),
      };
      writeFileSync(paths.claim, "{\"kind\":\"malformed-preserve-me\"}\n", "utf8");
      writeFileSync(paths.process, "{\"kind\":\"malformed-process-preserve-me\"}\n", "utf8");
      writeJson(paths.heartbeat, { schema_version: 1, run_id: fixture.runId, phase: "builder-wave", pid: process.pid, interval_ms: 30000, last_tick_at: new Date().toISOString() });
      const before = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(path, "utf8")]));
      const runBefore = readFileSync(join(fixture.runDir, "run.json"), "utf8");

      const result = await recoverDisruptedRun(fixture.runId, { cwd: fixture.repo });

      assert.equal(result.ok, false);
      assert.equal(result.updated, false);
      assert.equal(result.recovered, false);
      assert.equal(result.recovery_required, true);
      assert.equal(result.ownership.condition, "unsafe-ownership");
      assert.equal(result.ownership.reason_code, "launch-claim-invalid");
      for (const [key, path] of Object.entries(paths)) assert.equal(readFileSync(path, "utf8"), before[key], `${key} sidecar must be byte-identical`);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), runBefore, "unsafe ownership must not mutate run state");
      assert.equal(existsSync(fixture.worktree), false, "unsafe ownership must not recover the worktree");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("blocks recovery when the durable branch is missing", async () => {
    const fixture = createRecoveryFixture("missing-branch-run");
    try {
      runGit(fixture.repo, ["branch", "-D", fixture.runId]);

      const result = await recoverDisruptedRun(fixture.runId, { cwd: fixture.repo });
      const run = readJson(join(fixture.runDir, "run.json"));

      assert.equal(result.ok, false);
      assert.equal(result.durable, true);
      assert.equal(result.updated, true);
      assert.equal(result.status, "blocked");
      assert.match(result.terminal_result.reason, /branch 'missing-branch-run' does not exist/i);
      assert.match(run.terminal_result.reason, /branch 'missing-branch-run' does not exist/i);
      assert.equal(existsSync(fixture.worktree), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("blocks recovery when a merged slice merge_commit contradicts branch history", async () => {
    const fixture = createRecoveryFixture("merge-contradiction-run");
    try {
      writeFileSync(join(fixture.repo, "main-only.txt"), "main only\n", "utf8");
      runGit(fixture.repo, ["add", "main-only.txt"]);
      runGit(fixture.repo, ["commit", "-m", "main only"]);
      const nonAncestorMergeCommit = gitStdout(fixture.repo, ["rev-parse", "HEAD"]);
      const run = readJson(join(fixture.runDir, "run.json"));
      Object.assign(run.slices[0], modernReviewedSlice(fixture.runDir, "backend", gitStdout(fixture.repo, ["rev-parse", fixture.runId]), { status: "merged", mergeCommit: nonAncestorMergeCommit }));
      writeJson(join(fixture.runDir, "run.json"), run);

      const result = await recoverDisruptedRun(fixture.runId, { cwd: fixture.repo });
      const updated = readJson(join(fixture.runDir, "run.json"));

      assert.equal(result.ok, false);
      assert.equal(result.status, "blocked");
      assert.match(result.terminal_result.reason, /merged slice merge_commit/i);
      assert.match(result.terminal_result.reason, /not an ancestor/i);
      assert.match(updated.terminal_result.reason, /merged slice merge_commit/i);
      assert.equal(existsSync(fixture.worktree), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("derives a safe worktree for valid non-terminal runs without worktree and preserves durable fields", async () => {
    const repo = tempRepo("derive-worktree-run");
    const runId = "derive-worktree-run";
    try {
      initGitRepo(repo);
      const baseCommit = gitStdout(repo, ["rev-parse", "HEAD"]);
      runGit(repo, ["branch", runId]);
      const runDir = join(repo, ".opencode", "factory", runId);
      const runFile = join(runDir, "run.json");
      mkdirSync(runDir, { recursive: true });
      const original = {
        schema_version: 1,
        run_id: runId,
        mode: "headless",
        status: "running",
        created_at: "2026-07-08T11:00:00.000Z",
        updated_at: "2026-07-08T11:30:00.000Z",
        heartbeat_at: "2026-07-08T11:59:00.000Z",
        base_ref: "main",
        base_commit: baseCommit,
        branch: runId,
        github_account: "octo-org",
        max_parallel_slices: 2,
        max_retries: 1,
        review_tier: "standard",
        debug_snapshot: {
          created_with: {
            collected_at: "2026-07-08T11:00:00.000Z",
            event: "created",
            diagnostic_only: true,
            env: { PATH: "/usr/bin", GITHUB_TOKEN: "[redacted]" },
          },
          last_resumed_with: null,
          resume_count: 1,
        },
        gates: {
          story: { status: "approved", artifact: "artifacts/story.md", question_ref: "gates/story.question.md", answer: "approve", answered_at: "2026-07-08T11:05:00.000Z" },
          pre_pr: { status: "pending", artifact: "artifacts/pre-pr.md", question_ref: "gates/pre_pr.question.md", pending_snapshot: { question_ref: "gates/pre_pr.question.md", question_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", artifact_ref: "artifacts/pre-pr.md", artifact_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", created_at: "2026-07-08T11:50:00.000Z" } },
        },
        slices: [
          { id: "research", stack: "backend", depends_on: [], status: "pending", attempts: 0 },
          { id: "backend", stack: "backend", depends_on: ["research"], status: "running", attempts: 2, evidence_ref: "evidence/backend.md" },
        ],
        steps: [{ agent: "story-reader", status: "accepted", attempts: 1, artifact_ref: "artifacts/story.md", evidence_ref: "evidence/story.md", review_ref: "reviews/story.json" }],
        validator: { verdict: "GO-WITH-NITS", report: "artifacts/validation.md", loops: 1 },
        security_review: { verdict: "PASS", review_ref: "reviews/security.json", loops: 1 },
        terminal_result: null,
      };
      writeJson(runFile, original);

      const result = await recoverDisruptedRun(runId, { cwd: repo });
      const expectedWorktree = gitListedPath(join(repo, ".opencode", "worktrees", runId));
      const after = readJson(runFile);

      assert.equal(result.ok, true);
      assert.equal(result.updated, true);
      assert.equal(result.recovered, true);
      assert.equal(result.worktree, expectedWorktree);
      assert.equal(gitStdout(expectedWorktree, ["branch", "--show-current"]), runId);
      assert.deepEqual(after, { ...original, worktree: expectedWorktree });
    } finally {
      cleanup(repo);
    }
  });

  it("does not prune or clean unrelated stale worktree metadata during recovery", async () => {
    const fixture = createRecoveryFixture("non-destructive-prune-run");
    const staleBranch = "unrelated-stale-worktree";
    const staleWorktree = join(fixture.repo, ".opencode", "worktrees", staleBranch);
    try {
      runGit(fixture.repo, ["branch", staleBranch]);
      mkdirSync(join(fixture.repo, ".opencode", "worktrees"), { recursive: true });
      runGit(fixture.repo, ["worktree", "add", staleWorktree, staleBranch]);
      rmSync(staleWorktree, { recursive: true, force: true });
      assert.match(gitStdout(fixture.repo, ["worktree", "list", "--porcelain"]), new RegExp(`worktree ${escapeRegExp(gitListedPath(staleWorktree))}`));

      const result = await recoverDisruptedRun(fixture.runId, { cwd: fixture.repo });

      assert.equal(result.ok, true);
      assert.equal(result.recovered, true);
      assert.match(gitStdout(fixture.repo, ["worktree", "list", "--porcelain"]), new RegExp(`worktree ${escapeRegExp(gitListedPath(staleWorktree))}`));
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

  it("rejects physical worktree paths under a symlinked .opencode/worktrees target", async () => {
    const outsideRoot = tempRepo("physical-symlink-target");
    const physicalWorktree = join(outsideRoot, "physical-symlink-run");
    const fixture = createRecoveryFixture("physical-symlink-run", { worktree: physicalWorktree });
    try {
      mkdirSync(join(fixture.repo, ".opencode"), { recursive: true });
      symlinkSync(outsideRoot, join(fixture.repo, ".opencode", "worktrees"), "dir");

      const result = await recoverDisruptedRun(fixture.runId, { cwd: fixture.repo });
      const run = readJson(join(fixture.runDir, "run.json"));

      assert.equal(result.ok, false);
      assert.equal(result.recovered, false);
      assert.equal(result.status, "needs-human");
      assert.match(result.terminal_result.reason, /outside \.opencode\/worktrees|must not contain symlinks/i);
      assert.equal(run.status, "needs-human");
      assert.equal(existsSync(physicalWorktree), false);
    } finally {
      cleanup(fixture.repo);
      cleanup(outsideRoot);
    }
  });

  it("rejects logical recovery worktree paths when .opencode/worktrees is a symlink", async () => {
    const outsideRoot = tempRepo("logical-symlink-target");
    const fixture = createRecoveryFixture("logical-symlink-run");
    try {
      mkdirSync(join(fixture.repo, ".opencode"), { recursive: true });
      symlinkSync(outsideRoot, join(fixture.repo, ".opencode", "worktrees"), "dir");

      const result = await recoverDisruptedRun(fixture.runId, { cwd: fixture.repo });
      const run = readJson(join(fixture.runDir, "run.json"));

      assert.equal(result.ok, false);
      assert.equal(result.recovered, false);
      assert.equal(result.status, "needs-human");
      assert.match(result.terminal_result.reason, /must not contain symlinks/i);
      assert.equal(run.status, "needs-human");
      assert.equal(existsSync(join(outsideRoot, fixture.runId)), false);
    } finally {
      cleanup(fixture.repo);
      cleanup(outsideRoot);
    }
  });

  it("clears disrupted recovery heartbeat metadata without sending SIGTERM to heartbeat pid", async () => {
    const fixture = createRecoveryFixture("heartbeat-no-kill-run", { baseMismatch: true });
    const originalKill = process.kill;
    const killCalls = [];
    try {
      writeJson(join(fixture.runDir, "heartbeat.json"), {
        schema_version: 1,
        run_id: fixture.runId,
        phase: "recovery-test",
        pid: 987654321,
        interval_ms: 30000,
        last_tick_at: "2026-07-08T11:59:00.000Z",
      });
      process.kill = (pid, signal) => {
        killCalls.push({ pid, signal });
        return true;
      };

      const result = await recoverDisruptedRun(fixture.runId, { cwd: fixture.repo, now: "2026-07-08T12:00:00.000Z", processAliveFn: () => true });
      const heartbeat = readJson(join(fixture.runDir, "heartbeat.json"));

      assert.equal(result.status, "blocked");
      assert.deepEqual(killCalls, []);
      assert.equal(heartbeat.pid, null);
      assert.equal(heartbeat.last_tick_at, "2026-07-08T12:00:00.000Z");
    } finally {
      process.kill = originalKill;
      cleanup(fixture.repo);
    }
  });

  it("does not treat an inaccessible recorded worktree path as healthy", async () => {
    const fixture = createRecoveryFixture("inaccessible-worktree-run");
    try {
      mkdirSync(join(fixture.repo, ".opencode", "worktrees"), { recursive: true });
      writeFileSync(fixture.worktree, "not a directory\n", "utf8");

      const result = await recoverDisruptedRun(fixture.runId, { cwd: fixture.repo });
      const run = readJson(join(fixture.runDir, "run.json"));

      assert.equal(result.ok, false);
      assert.equal(result.recovered, false);
      assert.equal(result.status, "needs-human");
      assert.match(result.terminal_result.reason, /recorded worktree path exists but is not a directory/i);
      assert.equal(run.status, "needs-human");
      assert.match(run.terminal_result.reason, /recorded worktree path exists but is not a directory/i);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("does not replace pending slice nonconvergence with a disrupted-recovery terminal", async () => {
    const fixture = createRecoveryFixture("nonconvergent-recovery-run", { worktree: join(tmpdir(), "outside-nonconvergent-recovery") });
    try {
      const head = gitStdout(fixture.repo, ["rev-parse", `${fixture.runId}^{commit}`]);
      const evidenceRef = "evidence/backend.attempt-1.json";
      const reviewRef = "reviews/backend.attempt-1.json";
      mkdirSync(join(fixture.runDir, "evidence"), { recursive: true });
      mkdirSync(join(fixture.runDir, "reviews"), { recursive: true });
      writeJson(join(fixture.runDir, evidenceRef), { subject: "backend", attempt: 1, status: "pass", review_ready: true, head_sha: head });
      writeJson(join(fixture.runDir, reviewRef), {
        subject: "backend", attempt: 1, reviewed_commit: head, verdict: "REJECT", convergence: "nonconvergent",
        remaining_fix_count: 1, required_fixes: ["missed category"],
        remediation_context: { schema_version: 2, fixes: [{ required_fix_index: 0, classification: "nonconvergent", scope_effect: "in-lane", likely_paths: ["README.md"], fix_owner: "backend" }] },
      });
      const source = {
        attempt: 1,
        evidence_ref: evidenceRef,
        evidence_hash: fileHash(join(fixture.runDir, evidenceRef)),
        review_ref: reviewRef,
        review_hash: fileHash(join(fixture.runDir, reviewRef)),
        reviewed_commit: head,
        verdict: "REJECT",
        convergence: "nonconvergent",
        remaining_fix_count: 1,
      };
      const run = readJson(join(fixture.runDir, "run.json"));
      run.slices = [{
        id: "backend", stack: "backend", depends_on: [], status: "review", branch: fixture.runId,
        worktree: fixture.worktree, attempts: 1, attempt_reviews: [source], evidence_ref: evidenceRef,
        evidence_hash: source.evidence_hash, review_ref: reviewRef, review_hash: source.review_hash, reviewed_commit: head,
      }];
      writeJson(join(fixture.runDir, "run.json"), run);

      await assert.rejects(
        recoverDisruptedRun(fixture.runId, { cwd: fixture.repo }),
        /current nonconvergent review must terminalize through the checked next-attempt transition/u,
      );
      assert.equal(readJson(join(fixture.runDir, "run.json")).status, "running");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("keeps status, listRuns, and validateState read-only for missing manifests and worktrees", () => {
    const fixture = createRecoveryFixture("read-only-state-run");
    const runFile = join(fixture.runDir, "run.json");
    const orphanRunDir = join(fixture.repo, ".opencode", "factory", "missing-manifest-run");
    try {
      mkdirSync(orphanRunDir, { recursive: true });
      const before = readFileSync(runFile, "utf8");

      const current = status(fixture.runId, { cwd: fixture.repo, now: "2026-07-08T12:00:00.000Z" });
      const runs = listRuns({ cwd: fixture.repo, now: "2026-07-08T12:00:00.000Z" });
      const validation = validateState(fixture.runId, { cwd: fixture.repo, now: "2026-07-08T12:00:00.000Z" });

      assert.equal(current.status, "running");
      assert.equal(current.diagnostics.items.some((item) => item.condition === "missing-worktree"), true);
      assert.equal(runs.some((item) => item.run_id === fixture.runId), true);
      assert.equal(runs.some((item) => item.run_id === "missing-manifest-run"), false);
      assert.equal(validation.runs.length, 1);
      assert.throws(() => status("missing-manifest-run", { cwd: fixture.repo }), /run not found/i);
      assert.throws(() => validateState("missing-manifest-run", { cwd: fixture.repo }), /run not found/i);
      assert.equal(readFileSync(runFile, "utf8"), before);
      assert.equal(existsSync(fixture.worktree), false);
      assert.equal(existsSync(join(orphanRunDir, "run.json")), false);
    } finally {
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
    slices: [{ id: "backend", stack: "backend", depends_on: [], status: "pending", attempts: 0 }],
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

function fileHash(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function modernReviewedSlice(runDir, id, reviewedCommit, { status = "review", mergeCommit } = {}) {
  const evidenceRef = `evidence/${id}.json`;
  const reviewRef = `reviews/${id}.json`;
  mkdirSync(join(runDir, "evidence"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  writeJson(join(runDir, evidenceRef), { subject: id, attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommit });
  writeJson(join(runDir, reviewRef), {
    subject: id, attempt: 1, reviewed_commit: reviewedCommit, verdict: "APPROVE", convergence: "converging",
    remaining_fix_count: 0, required_fixes: [], remediation_context: { schema_version: 2, fixes: [] },
  });
  const evidenceHash = fileHash(join(runDir, evidenceRef));
  const reviewHash = fileHash(join(runDir, reviewRef));
  const history = { attempt: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash, reviewed_commit: reviewedCommit, verdict: "APPROVE", convergence: "converging", remaining_fix_count: 0 };
  return {
    id, stack: "backend", depends_on: [], status, attempts: 1, evidence_ref: evidenceRef, evidence_hash: evidenceHash,
    review_ref: reviewRef, review_hash: reviewHash, reviewed_commit: reviewedCommit, attempt_reviews: [history],
    ...(status === "merged" ? { merge_commit: mergeCommit ?? reviewedCommit } : {}),
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function gitListedPath(path) {
  return process.platform === "darwin" && path.startsWith("/var/") ? `/private${path}` : path;
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}
