import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { continueFactory } from "../src/factory.js";
import { validateRun } from "../src/validate.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

describe("factory continue", () => {
  it("builds a dry-run continuation payload from a blocked parent without mutating parent state", () => {
    const fixture = createFixture("blocked-parent");
    try {
      const beforeRunHash = hashFile(join(fixture.runDir, "run.json"));
      const beforeReviewHash = hashFile(join(fixture.runDir, "reviews", "reviewer.json"));
      const beforeArtifactHashes = hashArtifactRefs(fixture.runDir, ["artifacts/story.md"]);
      const mainCommit = gitStdout(fixture.repo, ["rev-parse", "--verify", "main^{commit}"]);

      const result = continueFactory(fixture.runId, {
        cwd: fixture.repo,
        review: "reviews/reviewer.json",
        runId: "blocked-parent-continue",
        dryRun: true,
        ghAccount: "octo-org",
        now: "2026-07-08T12:00:00.000Z",
      });

      assert.equal(result.status, "dry-run");
      assert.equal(result.payload.driver.ready, false);
      assert.equal(result.payload.driver.github_account, "octo-org");
      const parentCommit = gitStdout(fixture.repo, ["rev-parse", "--verify", `refs/heads/${fixture.runId}^{commit}`]);
      assert.deepEqual(result.payload.continuation, {
        kind: "blocked-run-continuation",
        schema_version: 1,
        created_at: "2026-07-08T12:00:00.000Z",
        operator_summary: `Continue blocked run '${fixture.runId}' from reviews/reviewer.json.`,
        parent: {
          run_id: fixture.runId,
          status: "blocked",
          run_ref: `.opencode/factory/${fixture.runId}/run.json`,
          run_hash: beforeRunHash,
          branch: fixture.runId,
          commit: parentCommit,
          worktree: join(fixture.repo, ".opencode", "worktrees", fixture.runId),
        },
        review: {
          kind: "validator",
          ref: "reviews/reviewer.json",
          hash: beforeReviewHash,
          subject: fixture.runId,
          summary: "needs continuation",
          required_fixes: [],
          source: "run.validator.review_ref",
        },
        target: {
          run_id: "blocked-parent-continue",
          branch: "blocked-parent-continue",
          worktree: join(gitStdout(fixture.repo, ["rev-parse", "--show-toplevel"]), ".opencode", "worktrees", "blocked-parent-continue"),
          base_ref: "main",
          base_commit: mainCommit,
        },
        parent_artifacts: [{ kind: "story", ref: "artifacts/story.md", hash: hashFile(join(fixture.runDir, "artifacts", "story.md")) }],
        parent_evidence: [],
        parent_reviews: [{ kind: "review", ref: "reviews/reviewer.json", hash: beforeReviewHash }],
      });
      assert.equal(hashFile(join(fixture.runDir, "run.json")), beforeRunHash);
      assert.equal(hashFile(join(fixture.runDir, "reviews", "reviewer.json")), beforeReviewHash);
      assert.deepEqual(hashArtifactRefs(fixture.runDir, result.payload.continuation.parent_artifacts.map((artifact) => artifact.ref)), beforeArtifactHashes);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "factory", "blocked-parent-continue", "run.json")), false);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("emits a continuation payload that is valid for the persisted run.continuation schema", () => {
    const fixture = createFixture("schema-parent");
    try {
      const proc = runCli(fixture.repo, ["factory", "continue", fixture.runId, "--review", "reviewer.json", "--run-id", "schema-parent-next", "--dry-run", "--json"]);
      assert.equal(proc.status, 0, proc.stderr);
      const output = JSON.parse(proc.stdout);

      assert.doesNotThrow(() => validateRun(childRunFromPayload(output.payload.continuation)));
      assert.equal(output.payload.continuation.parent.run_ref, `.opencode/factory/${fixture.runId}/run.json`);
      assert.equal(output.payload.continuation.parent.run_hash, hashFile(join(fixture.runDir, "run.json")));
      assert.deepEqual(output.payload.continuation.parent_artifacts, hashArtifactRefs(fixture.runDir, ["artifacts/story.md"]));
      assert.equal(output.payload.continuation.parent.artifact_refs, undefined);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("accepts required_fixes without requiring a verdict enum", () => {
    const fixture = createFixture("fixes-review", { review: { subject: "fixes-review", required_fixes: ["repair tests"], verdict: "not-a-standard-verdict" } });
    try {
      const result = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "fixes-review-next", dryRun: true });
      assert.equal(result.payload.continuation.review.ref, "reviews/reviewer.json");
      assert.deepEqual(result.payload.continuation.review.required_fixes, ["repair tests"]);
      assert.equal(result.payload.continuation.review.summary, null);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("hashes only documented parent artifact refs", () => {
    const fixture = createFixture("known-artifacts-only");
    try {
      writeFileSync(join(fixture.runDir, "artifacts", "extra.json"), "{}\n", "utf8");
      mkdirSync(join(fixture.runDir, "artifacts", "nested"));
      writeFileSync(join(fixture.runDir, "artifacts", "nested", "extra.md"), "extra\n", "utf8");

      const result = continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "known-artifacts-only-next", dryRun: true });

      assert.deepEqual(result.payload.continuation.parent_artifacts, hashArtifactRefs(fixture.runDir, ["artifacts/story.md"]));
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

    const emptyFixes = createFixture("empty-fixes-review", { review: { subject: "empty-fixes-review", required_fixes: ["", "   "] } });
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

  it("rejects continuation reviews that are not referenced by parent run state or have mismatched subjects", () => {
    const unreferenced = createFixture("unreferenced-review");
    try {
      writeJson(join(unreferenced.runDir, "reviews", "unreferenced.json"), { subject: unreferenced.runId, summary: "not linked" });
      assert.throws(
        () => continueFactory(unreferenced.runId, { cwd: unreferenced.repo, review: "unreferenced.json", runId: "unreferenced-review-next", dryRun: true }),
        /must be referenced by parent run state/u,
      );
    } finally {
      cleanup(unreferenced.repo);
    }

    const mismatchedSubject = createFixture("mismatched-review-subject", { review: { subject: "other-run", summary: "wrong subject" } });
    try {
      assert.throws(
        () => continueFactory(mismatchedSubject.runId, { cwd: mismatchedSubject.repo, review: "reviewer.json", runId: "mismatched-review-subject-next", dryRun: true }),
        /subject must match parent validator source/u,
      );
    } finally {
      cleanup(mismatchedSubject.repo);
    }
  });

  it("rejects a symlinked parent run.json trust root before reading or hashing it", () => {
    const fixture = createFixture("symlink-parent-run-json");
    const escapedRun = mkdtempSync(join(tmpdir(), "factory-escaped-run-json-"));
    try {
      writeFileSync(join(escapedRun, "run.json"), readFileSync(join(fixture.runDir, "run.json")), "utf8");
      rmSync(join(fixture.runDir, "run.json"), { force: true });
      symlinkSync(join(escapedRun, "run.json"), join(fixture.runDir, "run.json"), "file");
      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "symlink-parent-run-json-next", dryRun: true }),
        /parent run\.json must not contain symlinks/u,
      );
    } finally {
      cleanup(fixture.repo);
      cleanup(escapedRun);
    }
  });

  it("rejects a symlinked parent run directory trust root", () => {
    const fixture = createFixture("symlink-parent-run-dir");
    const realRunDir = join(fixture.repo, ".opencode", "factory", `${fixture.runId}-real`);
    try {
      renameSync(fixture.runDir, realRunDir);
      symlinkSync(realRunDir, fixture.runDir, "dir");
      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "symlink-parent-run-dir-next", dryRun: true }),
        /parent run\.json must not contain symlinks/u,
      );
    } finally {
      cleanup(fixture.repo);
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

  it("rejects a parent reviews symlink to artifacts even when artifact JSON looks like review evidence", () => {
    const fixture = createFixture("reviews-to-artifacts");
    try {
      writeJson(join(fixture.runDir, "artifacts", "reviewer.json"), { subject: "artifact review", summary: "must not be accepted" });
      rmSync(join(fixture.runDir, "reviews"), { recursive: true, force: true });
      symlinkSync(join(fixture.runDir, "artifacts"), join(fixture.runDir, "reviews"), "dir");

      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "reviews-to-artifacts-next", dryRun: true }),
        /reviews\/ directory without symlinks/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects a symlinked review file under reviews", () => {
    const fixture = createFixture("symlink-review-file");
    try {
      writeJson(join(fixture.runDir, "artifacts", "linked-review.json"), { subject: "linked", summary: "outside reviews" });
      rmSync(join(fixture.runDir, "reviews", "reviewer.json"), { force: true });
      symlinkSync(join(fixture.runDir, "artifacts", "linked-review.json"), join(fixture.runDir, "reviews", "reviewer.json"), "file");

      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "symlink-review-file-next", dryRun: true }),
        /reviews\/ directory without symlinks/u,
      );
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("rejects a symlinked intermediate review directory", () => {
    const fixture = createFixture("symlink-review-dir");
    const escapedReviews = mkdtempSync(join(tmpdir(), "factory-review-dir-"));
    try {
      writeJson(join(escapedReviews, "reviewer.json"), { subject: "linked dir", summary: "outside reviews" });
      symlinkSync(escapedReviews, join(fixture.runDir, "reviews", "nested"), "dir");

      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "nested/reviewer.json", runId: "symlink-review-dir-next", dryRun: true }),
        /reviews\/ directory without symlinks/u,
      );
    } finally {
      cleanup(fixture.repo);
      cleanup(escapedReviews);
    }
  });

  it("rejects a symlinked artifact file before reading parent_artifacts", () => {
    const fixture = createFixture("symlink-artifact-file");
    const escapedArtifacts = mkdtempSync(join(tmpdir(), "factory-escaped-artifacts-"));
    try {
      writeFileSync(join(escapedArtifacts, "story.md"), "outside story\n", "utf8");
      rmSync(join(fixture.runDir, "artifacts", "story.md"), { force: true });
      symlinkSync(join(escapedArtifacts, "story.md"), join(fixture.runDir, "artifacts", "story.md"), "file");

      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "symlink-artifact-file-next", dryRun: true }),
        /parent artifact 'artifacts\/story\.md' must not contain symlinks/u,
      );
    } finally {
      cleanup(fixture.repo);
      cleanup(escapedArtifacts);
    }
  });

  it("rejects a symlinked artifact root", () => {
    const fixture = createFixture("symlink-artifact-root");
    const escapedArtifacts = mkdtempSync(join(tmpdir(), "factory-artifacts-root-"));
    try {
      writeFileSync(join(escapedArtifacts, "story.md"), "outside story\n", "utf8");
      rmSync(join(fixture.runDir, "artifacts"), { recursive: true, force: true });
      symlinkSync(escapedArtifacts, join(fixture.runDir, "artifacts"), "dir");

      assert.throws(
        () => continueFactory(fixture.runId, { cwd: fixture.repo, review: "reviewer.json", runId: "symlink-artifact-root-next", dryRun: true }),
        /parent artifacts\/ directory must not contain symlinks/u,
      );
    } finally {
      cleanup(fixture.repo);
      cleanup(escapedArtifacts);
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

function createFixture(runId, { status = "blocked", createBranch = true, review } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "factory-continue-"));
  initGitRepo(repo);
  if (createBranch) runGit(repo, ["branch", runId]);
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "story.md"), "story\n", "utf8");
  writeJson(join(runDir, "reviews", "reviewer.json"), review || { subject: runId, summary: "needs continuation" });
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    status,
    branch: runId,
    worktree: join(repo, ".opencode", "worktrees", runId),
    validator: { verdict: "NO-GO", review_ref: "reviews/reviewer.json" },
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
  return refs.map((ref) => ({ kind: parentArtifactKind(ref), ref, hash: hashFile(join(runDir, ref)) }));
}

function parentArtifactKind(ref) {
  if (ref === "artifacts/story.md") return "story";
  if (ref === "artifacts/research-map.md") return "research_map";
  if (ref === "artifacts/design-brief.md") return "design_brief";
  if (ref === "artifacts/technical-brief.md") return "technical_brief";
  if (ref === "artifacts/test-report.md") return "test_report";
  if (ref === "artifacts/validation-report.md") return "validation_report";
  if (ref === "artifacts/pr-body.md") return "pr_body";
  return "artifact";
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
