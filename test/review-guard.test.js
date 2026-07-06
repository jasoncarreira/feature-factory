import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { buildReviewGuardBlockReport, checkReviewedWorktreeClean } from "../src/review-guard.js";

describe("checkReviewedWorktreeClean", () => {
  it("returns ok for a clean git worktree", () => {
    const repo = createCommittedRepo();

    try {
      const result = checkReviewedWorktreeClean(repo);

      assert.equal(result.ok, true);
      assert.equal(result.status, "clean");
      assert.equal(result.worktree, repo);
      assert.equal(result.exit_code, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.deepEqual(result.dirty_paths, []);
      assert.equal(result.command, `git -C ${repo} status --porcelain=v1 --untracked-files=all`);
    } finally {
      cleanup(repo);
    }
  });

  it("blocks tracked dirty modifications and reports path metadata", () => {
    const repo = createCommittedRepo();

    try {
      writeFileSync(join(repo, "tracked.txt"), "changed\n", "utf8");

      const result = checkReviewedWorktreeClean(repo);

      assert.equal(result.ok, false);
      assert.equal(result.status, "dirty");
      assert.equal(result.exit_code, 0);
      assert.equal(result.dirty_paths.length, 1);
      assert.equal(result.stdout, " M tracked.txt\n");

      const dirtyPath = result.dirty_paths[0];
      assert.equal(dirtyPath.path, "tracked.txt");
      assert.equal(dirtyPath.original_path, null);
      assert.equal(dirtyPath.raw, " M tracked.txt");
      assert.equal(dirtyPath.xy, " M");
      assert.equal(dirtyPath.index_status, " ");
      assert.equal(dirtyPath.worktree_status, "M");
      assert.equal(dirtyPath.staged, false);
      assert.equal(dirtyPath.unstaged, true);
      assert.equal(dirtyPath.deleted, false);
      assert.equal(dirtyPath.conflicted, false);
      assert.equal(dirtyPath.untracked, false);
    } finally {
      cleanup(repo);
    }
  });

  it("blocks untracked files and reports untracked metadata", () => {
    const repo = createCommittedRepo();

    try {
      writeFileSync(join(repo, "new-file.txt"), "new\n", "utf8");

      const result = checkReviewedWorktreeClean(repo);

      assert.equal(result.ok, false);
      assert.equal(result.status, "dirty");
      assert.equal(result.exit_code, 0);
      assert.equal(result.dirty_paths.length, 1);
      assert.equal(result.stdout, "?? new-file.txt\n");

      const dirtyPath = result.dirty_paths[0];
      assert.equal(dirtyPath.path, "new-file.txt");
      assert.equal(dirtyPath.original_path, null);
      assert.equal(dirtyPath.raw, "?? new-file.txt");
      assert.equal(dirtyPath.xy, "??");
      assert.equal(dirtyPath.index_status, "?");
      assert.equal(dirtyPath.worktree_status, "?");
      assert.equal(dirtyPath.staged, false);
      assert.equal(dirtyPath.unstaged, false);
      assert.equal(dirtyPath.deleted, false);
      assert.equal(dirtyPath.conflicted, false);
      assert.equal(dirtyPath.untracked, true);
    } finally {
      cleanup(repo);
    }
  });

  it("blocks non-git worktrees as unverifiable", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-guard-nongit-"));

    try {
      const result = checkReviewedWorktreeClean(dir);

      assert.equal(result.ok, false);
      assert.equal(result.status, "unverifiable");
      assert.equal(result.worktree, dir);
      assert.notEqual(result.exit_code, 0);
      assert.deepEqual(result.dirty_paths, []);
      assert.equal(result.stdout, "");
      assert.equal(typeof result.stderr, "string");
      assert.notEqual(result.stderr.length, 0);
    } finally {
      cleanup(dir);
    }
  });
});

describe("buildReviewGuardBlockReport", () => {
  it("marks reviewer output invalid and preserves stable guard context", () => {
    const repo = createCommittedRepo();

    try {
      writeFileSync(join(repo, "tracked.txt"), "changed\n", "utf8");
      const guard = checkReviewedWorktreeClean(repo);

      const report = buildReviewGuardBlockReport({
        reviewer: "work-reviewer",
        subject: "be-review-guard-tests",
        reviewed_worktree: repo,
        guard,
      });

      assert.equal(report.status, "blocked");
      assert.equal(report.reason, "reviewer left reviewed worktree dirty (1 git-visible path)");
      assert.equal(report.reviewer, "work-reviewer");
      assert.equal(report.subject, "be-review-guard-tests");
      assert.equal(report.attempt, 1);
      assert.equal(report.reviewed_worktree, repo);
      assert.equal(report.review_output_valid, false);
      assert.deepEqual(report.dirty_paths, guard.dirty_paths);
      assert.equal(report.guard.ok, false);
      assert.equal(report.guard.status, "dirty");
      assert.equal(report.guard.worktree, repo);
      assert.equal(report.guard.command, guard.command);
      assert.equal(report.guard.exit_code, 0);
      assert.equal(report.guard.stdout, " M tracked.txt\n");
    } finally {
      cleanup(repo);
    }
  });
});

describe("reviewer guard documentation", () => {
  it("covers every reviewer-designated agent and documents the minimal post-run guard", () => {
    const skillDoc = readFileSync(new URL("../assets/skills/feature/SKILL.md", import.meta.url), "utf8");
    const schemaDoc = readFileSync(new URL("../assets/skills/feature/SCHEMA.md", import.meta.url), "utf8");
    const readmeDoc = readFileSync(new URL("../README.md", import.meta.url), "utf8");

    assertIncludes(skillDoc, "Reviewer-designated agents are only:");
    assertIncludes(skillDoc, "- `work-reviewer`");
    assertIncludes(skillDoc, "- `implementation-validator`");
    assertIncludes(skillDoc, "- `security-reviewer`");
    assertIncludes(skillDoc, "After it returns, before accepting or writing `$RUN/reviews/spec-writer.json`, guard `$REPO`.");
    assertIncludes(skillDoc, "After it returns, before accepting or writing `$RUN/reviews/work-decomposer.json`, guard `$REPO`.");
    assertIncludes(skillDoc, "After it returns, before accepting or writing `$RUN/reviews/<slice-id>.json`, guard `$SLICE_WT`.");
    assertIncludes(skillDoc, "Run `work-reviewer` with subject `test-verifier`. After it returns, before accepting or writing `$RUN/reviews/test-verifier.json`, guard `$FEAT_WT`.");
    assertIncludes(skillDoc, "`implementation-validator` — correctness / AC coverage / cross-slice integration / conventions. After it returns, before accepting or writing its result, guard `$FEAT_WT`.");
    assertIncludes(skillDoc, "`security-reviewer` — adversarial trust-boundary / injection / forgeable-provenance / secrets lens. After it returns, before accepting or writing `$RUN/reviews/security-reviewer.json`, guard `$FEAT_WT`.");
    assertIncludes(skillDoc, "This is post-run git-visible dirty-state detection only.");
    assertIncludes(skillDoc, "It is not OS/process sandboxing and does not prevent mutation attempts.");

    assertIncludes(schemaDoc, "Reviewer-designated agents are only `work-reviewer`, `implementation-validator`, and `security-reviewer`.");
    assertIncludes(schemaDoc, "These are guard/helper outcomes, not new normal review verdict enums.");
    assertIncludes(schemaDoc, "This schema documents post-run git-visible dirty-state detection only, not OS/process sandboxing.");

    assertIncludes(readmeDoc, "Reviewer-designated agents are `work-reviewer`, `implementation-validator`, and `security-reviewer`.");
    assertIncludes(readmeDoc, "Current enforcement is post-run git dirty-state detection only.");
    assertIncludes(readmeDoc, "If that status is dirty or unverifiable, the review is blocked and the reviewer output is discarded.");
    assertIncludes(readmeDoc, "it does not provide OS/process sandboxing or prevention.");
  });
});

function createCommittedRepo() {
  const repo = mkdtempSync(join(tmpdir(), "review-guard-repo-"));

  git(repo, ["init"]);
  writeFixture(repo, "tracked.txt", "tracked\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["-c", "user.name=Review Guard Test", "-c", "user.email=review-guard@example.com", "commit", "-m", "initial"]);

  return repo;
}

function writeFixture(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function git(cwd, args) {
  const proc = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (proc.error) throw proc.error;
  assert.equal(proc.status, 0, `git ${args.join(" ")} failed:\n${proc.stderr || proc.stdout}`);
  return proc;
}

function assertIncludes(text, expected) {
  assert.equal(text.includes(expected), true, `expected text to include: ${expected}`);
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
