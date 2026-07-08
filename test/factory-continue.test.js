import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { continueFactory } from "../src/factory.js";
import { ValidationError, validateRun } from "../src/validate.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

describe("factory continue", () => {
  it("builds a dry-run continuation payload from a blocked parent without mutating parent state", () => {
    const fixture = createFixture("blocked-parent");
    try {
      const beforeRunHash = hashFile(join(fixture.runDir, "run.json"));
      const beforeReviewHash = hashFile(join(fixture.runDir, "reviews", "reviewer.json"));
      const beforeArtifactHashes = hashArtifactRefs(fixture.runDir, ["artifacts/story.md"]);

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
      const parentCommit = gitStdout(fixture.repo, ["rev-parse", "--verify", `refs/heads/${fixture.runId}^{commit}`]);
      assert.deepEqual(result.payload.continuation, {
        kind: "blocked-run-continuation",
        schema: "feature-factory.continuation.v1",
        schema_version: 1,
        parent: {
          run_id: fixture.runId,
          status: "blocked",
          ref: `.opencode/factory/${fixture.runId}/run.json`,
          hash: beforeRunHash,
          branch: fixture.runId,
          commit: parentCommit,
          artifact_refs: [{ ref: "artifacts/story.md", hash: hashFile(join(fixture.runDir, "artifacts", "story.md")) }],
        },
        review: {
          ref: "reviews/reviewer.json",
          hash: beforeReviewHash,
          subject: "blocked run",
          summary: "needs continuation",
          required_fixes: [],
        },
        target: {
          run_id: "blocked-parent-continue",
          branch: "blocked-parent-continue",
          worktree: join(gitStdout(fixture.repo, ["rev-parse", "--show-toplevel"]), ".opencode", "worktrees", "blocked-parent-continue"),
        },
      });
      assert.equal(hashFile(join(fixture.runDir, "run.json")), beforeRunHash);
      assert.equal(hashFile(join(fixture.runDir, "reviews", "reviewer.json")), beforeReviewHash);
      assert.deepEqual(hashArtifactRefs(fixture.runDir, result.payload.continuation.parent.artifact_refs.map((artifact) => artifact.ref)), beforeArtifactHashes);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "blocked-parent-continue", "run.json")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("exposes that the emitted continuation payload does not match the persisted run.continuation schema", () => {
    const fixture = createFixture("schema-parent");
    try {
      const proc = runCli(fixture.repo, ["factory", "continue", fixture.runId, "--review", "reviewer.json", "--run-id", "schema-parent-next", "--dry-run", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const output = JSON.parse(proc.stdout);

      assert.throws(
        () => validateRun(childRunFromPayload(output.payload.continuation)),
        (error) => error instanceof ValidationError
          && error.message.includes("run.continuation.parent.run_ref: must be a non-empty string")
          && error.message.includes("run.continuation.parent.run_hash: must be a sha256 hash")
          && error.message.includes("run.continuation.parent_artifacts: must be an array"),
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("accepts required_fixes without requiring a verdict enum", () => {
    const fixture = createFixture("fixes-review", { review: { subject: "fixes", required_fixes: ["repair tests"], verdict: "not-a-standard-verdict" } });
    try {
      const result = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "fixes-review-next", dryRun: true });
      assert.equal(result.payload.continuation.review.ref, "reviews/reviewer.json");
      assert.deepEqual(result.payload.continuation.review.required_fixes, ["repair tests"]);
      assert.equal(result.payload.continuation.review.summary, null);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects missing parents and missing reviews", () => {
    const missingParent = createFixture("missing-parent-source");
    try {
      assert.throws(
        () => continueFactory("missing-parent", { cwd: missingParent.repo, review: "reviewer.json", runId: "missing-parent-next", dryRun: true }),
        /run not found/u,
      );
    } finally {
      cleanup(missingParent.repo);
    }

    const missingReview = createFixture("missing-review");
    try {
      rmSync(join(missingReview.runDir, "reviews", "reviewer.json"));
      assert.throws(
        () => continueFactory(missingReview.runId, { cwd: missingReview.repo, review: "reviewer.json", runId: "missing-review-next", dryRun: true }),
        /review is unresolvable|missing/u,
      );
    } finally {
      cleanup(missingReview.repo);
    }
  });

  it("rejects invalid JSON, non-object reviews, and empty required_fixes entries without summary", () => {
    const invalidJson = createFixture("invalid-json-review");
    try {
      writeFileSync(join(invalidJson.runDir, "reviews", "reviewer.json"), "{\n", "utf8");
      assert.throws(
        () => continueFactory(invalidJson.runId, { cwd: invalidJson.repo, review: "reviewer.json", runId: "invalid-json-next", dryRun: true }),
        /must parse as a JSON object/u,
      );
    } finally {
      cleanup(invalidJson.repo);
    }

    const nonObject = createFixture("non-object-review");
    try {
      writeFileSync(join(nonObject.runDir, "reviews", "reviewer.json"), "[]\n", "utf8");
      assert.throws(
        () => continueFactory(nonObject.runId, { cwd: nonObject.repo, review: "reviewer.json", runId: "non-object-next", dryRun: true }),
        /must parse as a JSON object/u,
      );
    } finally {
      cleanup(nonObject.repo);
    }

    const emptyFixes = createFixture("empty-fixes-review", { review: { subject: "fixes", required_fixes: ["", "   "] } });
    try {
      assert.throws(
        () => continueFactory(emptyFixes.runId, { cwd: emptyFixes.repo, review: "reviewer.json", runId: "empty-fixes-next", dryRun: true }),
        /non-empty summary or required_fixes\[\]/u,
      );
    } finally {
      cleanup(emptyFixes.repo);
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
      mkdirSync(join(unsafeTarget.repo, ".opencode", "factory", "target-run-exists"), { recursive: true });
      writeFileSync(join(unsafeTarget.repo, ".opencode", "factory", "target-run-exists", "run.json"), "{}\n", "utf8");
      assert.throws(
        () => continueFactory(unsafeTarget.runId, { cwd: unsafeTarget.repo, review: "reviewer.json", runId: "target-run-exists", dryRun: true }),
        /target run already exists/u,
      );
      mkdirSync(join(unsafeTarget.repo, ".opencode", "worktrees", "target-worktree-exists"), { recursive: true });
      assert.throws(
        () => continueFactory(unsafeTarget.runId, { cwd: unsafeTarget.repo, review: "reviewer.json", runId: "target-worktree-exists", dryRun: true }),
        /target worktree already exists/u,
      );
    } finally {
      cleanup(unsafeTarget.repo);
    }
  });

  it("rejects review symlink escapes, including an escaped parent reviews directory", () => {
    const fixture = createFixture("symlink-review");
    const escapedReviews = mkdtempSync(join(tmpdir(), "factory-escaped-reviews-"));
    try {
      writeJson(join(escapedReviews, "reviewer.json"), { subject: "escaped", summary: "outside parent run" });
      rmSync(join(fixture.runDir, "reviews"), { recursive: true, force: true });
      symlinkSync(escapedReviews, join(fixture.runDir, "reviews"), "dir");
      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "symlink-review-next", dryRun: true }),
        /reviews\//u,
      );
    } finally {
      cleanup(fixture.repo);
      cleanup(escapedReviews);
    }
  });

  it("CLI routes factory continue, rejects --ready and --no-draft, and prints dry-run JSON", () => {
    const fixture = createFixture("cli-parent");
    try {
      const proc = runCli(fixture.repo, ["factory", "continue", fixture.runId, "--review", "reviewer.json", "--run-id", "cli-parent-next", "--dry-run", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const output = JSON.parse(proc.stdout);
      assert.equal(output.status, "dry-run");
      assert.equal(output.payload.continuation.target.run_id, "cli-parent-next");
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

function gitStdout(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

function hashFile(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function hashArtifactRefs(runDir, refs) {
  return refs.map((ref) => ({ ref, hash: hashFile(join(runDir, ref)) }));
}

function childRunFromPayload(continuation) {
  return {
    schema_version: 1,
    run_id: continuation.target.run_id,
    status: "running",
    branch: continuation.target.branch,
    worktree: continuation.target.worktree,
    gates: {},
    continuation,
  };
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
