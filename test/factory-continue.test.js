import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { continueFactory } from "../src/factory.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

describe("factory continue", () => {
  it("builds a dry-run continuation payload from a blocked parent without mutating parent state", () => {
    const fixture = createFixture("blocked-parent");
    try {
      const beforeRunHash = hashFile(join(fixture.runDir, "run.json"));
      const beforeReviewHash = hashFile(join(fixture.runDir, "reviews", "reviewer.json"));

      const result = continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviews/reviewer.json",
        runId: "blocked-parent-continue",
        dryRun: true,
        ghAccount: "octo-org",
      });

      assert.equal(result.status, "dry-run");
      assert.equal(result.payload.driver.ready, false);
      assert.equal(result.payload.driver.github_account, "octo-org");
      assert.deepEqual(result.payload.continuation, {
        parent_run_id: fixture.runId,
        target_run_id: "blocked-parent-continue",
        parent_branch: fixture.runId,
        parent_run_ref: `.opencode/factory/${fixture.runId}/run.json`,
        parent_run_hash: beforeRunHash,
        review_ref: "reviews/reviewer.json",
        review_hash: beforeReviewHash,
        artifact_refs: [{ ref: "artifacts/story.md", hash: hashFile(join(fixture.runDir, "artifacts", "story.md")) }],
      });
      assert.equal(hashFile(join(fixture.runDir, "run.json")), beforeRunHash);
      assert.equal(hashFile(join(fixture.runDir, "reviews", "reviewer.json")), beforeReviewHash);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "blocked-parent-continue", "run.json")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("accepts required_fixes without requiring a verdict enum", () => {
    const fixture = createFixture("fixes-review", { review: { subject: "fixes", required_fixes: ["repair tests"], verdict: "not-a-standard-verdict" } });
    try {
      const result = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "fixes-review-next", dryRun: true });
      assert.equal(result.payload.continuation.review_ref, "reviews/reviewer.json");
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects non-blocked parents, missing parent branches, invalid reviews, and unsafe targets", () => {
    const nonBlocked = createFixture("running-parent", { status: "running" });
    try {
      assert.throws(
        () => continueFactory(nonBlocked.runId, { cwd: nonBlocked.repo, review: "reviewer.json", runId: "running-next", dryRun: true }),
        /must have status blocked/u,
      );
    } finally {
      cleanup(nonBlocked.repo);
    }

    const missingBranch = createFixture("missing-branch", { createBranch: false });
    try {
      assert.throws(
        () => continueFactory(missingBranch.runId, { cwd: missingBranch.repo, review: "reviewer.json", runId: "missing-branch-next", dryRun: true }),
        /requires existing branch/u,
      );
    } finally {
      cleanup(missingBranch.repo);
    }

    const invalidReview = createFixture("invalid-review", { review: { subject: "", summary: "" } });
    try {
      assert.throws(
        () => continueFactory(invalidReview.runId, { cwd: invalidReview.repo, review: "reviewer.json", runId: "invalid-review-next", dryRun: true }),
        /non-empty subject/u,
      );
      assert.throws(
        () => continueFactory(invalidReview.runId, { cwd: invalidReview.repo, review: "../run.json", runId: "invalid-review-next", dryRun: true }),
        /reviews\//u,
      );
    } finally {
      cleanup(invalidReview.repo);
    }

    const unsafeTarget = createFixture("unsafe-target");
    try {
      assert.throws(
        () => continueFactory(unsafeTarget.runId, { cwd: unsafeTarget.repo, review: "reviewer.json", runId: "../next", dryRun: true }),
        /bare safe/u,
      );
      assert.throws(
        () => continueFactory(unsafeTarget.runId, { cwd: unsafeTarget.repo, review: "reviewer.json", runId: unsafeTarget.runId, dryRun: true }),
        /differ from the parent/u,
      );
      runGit(unsafeTarget.repo, ["branch", "already-exists"]);
      assert.throws(
        () => continueFactory(unsafeTarget.runId, { cwd: unsafeTarget.repo, review: "reviewer.json", runId: "already-exists", dryRun: true }),
        /target branch already exists/u,
      );
    } finally {
      cleanup(unsafeTarget.repo);
    }
  });

  it("CLI routes factory continue, rejects --ready and --no-draft, and prints dry-run JSON", () => {
    const fixture = createFixture("cli-parent");
    try {
      const proc = runCli(fixture.repo, ["factory", "continue", fixture.runId, "--review", "reviewer.json", "--run-id", "cli-parent-next", "--dry-run", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const output = JSON.parse(proc.stdout);
      assert.equal(output.status, "dry-run");
      assert.equal(output.payload.continuation.target_run_id, "cli-parent-next");
      assert.equal(output.payload.driver.ready, false);

      assert.match(
        runCli(fixture.repo, ["factory", "continue", fixture.runId, "--review", "reviewer.json", "--run-id", "ready-next", "--ready", "--dry-run"]).stderr,
        /does not accept --ready/u,
      );
      assert.match(
        runCli(fixture.repo, ["factory", "continue", fixture.runId, "--review", "reviewer.json", "--run-id", "draft-next", "--no-draft", "--dry-run"]).stderr,
        /does not accept --no-draft/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });
});

function createFixture(runId, { status = "blocked", createBranch = true, review = { subject: "blocked run", summary: "needs continuation" } } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "factory-continue-"));
  initGitRepo(repo);
  if (createBranch) runGit(repo, ["branch", runId]);
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "story.md"), "story\n", "utf8");
  writeJson(join(runDir, "reviews", "reviewer.json"), review);
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    status,
    branch: runId,
    worktree: join(repo, ".opencode", "worktrees", runId),
    gates: {},
    terminal_result: status === "blocked" ? { status: "blocked", run_id: runId, reason: "review blocked", summary: "blocked", artifacts: {} } : null,
  });
  return { repo, runDir, runId };
}

function initGitRepo(repo) {
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "test\n", "utf8");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "init"]);
}

function runCli(repo, args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function runGit(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function hashFile(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
