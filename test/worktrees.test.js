import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "./helpers/git-fixture.js";
import { createOrRecoverWorktree, deriveExpectedWorktreePath } from "../src/worktrees.js";

describe("worktree path derivation", () => {
  it("adds a stable hash suffix when branch slugs collide", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-worktrees-"));
    try {
      const first = deriveExpectedWorktreePath(repo, "feature/x");
      mkdirSync(first, { recursive: true });

      const second = deriveExpectedWorktreePath(repo, "feature-x");

      assert.equal(basename(first), "feature-x");
      assert.match(basename(second), /^feature-x-[0-9a-f]{8}$/u);
      assert.notEqual(second, first);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("safe continuation worktree creation and recovery", () => {
  it("creates a missing worktree and recovers only the exact registered branch and HEAD", () => {
    const fixture = createGitFixture("exact");
    const target = join(fixture.repo, ".opencode", "worktrees", "child");
    try {
      const created = createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: fixture.head });
      assert.equal(created.recovered, false);
      assert.equal(gitOutput(target, ["rev-parse", "HEAD"]), fixture.head);
      assert.equal(gitOutput(target, ["symbolic-ref", "HEAD"]), "refs/heads/child");

      const recovered = createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: fixture.head });
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.entry.branch, "child");
      assert.equal(recovered.entry.head, fixture.head);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("rejects an existing wrong branch, detached worktree, and wrong HEAD", () => {
    for (const mode of ["wrong-branch", "detached", "wrong-head"]) {
      const fixture = createGitFixture(mode);
      const target = join(fixture.repo, ".opencode", "worktrees", mode);
      try {
        if (mode === "wrong-branch") git(fixture.repo, ["worktree", "add", target, "foreign"]);
        else if (mode === "detached") git(fixture.repo, ["worktree", "add", "--detach", target, fixture.head]);
        else git(fixture.repo, ["worktree", "add", target, "child"]);
        const expectedHead = mode === "wrong-head" ? "f".repeat(40) : fixture.head;
        assert.throws(
          () => createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: expectedHead }),
          /branch\/head|branch-mismatch|head-mismatch/u,
          mode,
        );
        assert.equal(gitOutput(target, ["rev-parse", "HEAD"]), fixture.head, mode);
      } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
    }
  });

  it("does not overwrite a deterministic foreign worktree add race", () => {
    const fixture = createGitFixture("add-race");
    const target = join(fixture.repo, ".opencode", "worktrees", "raced");
    try {
      assert.throws(
        () => createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: fixture.head }, {
          beforeAdd: () => git(fixture.repo, ["worktree", "add", target, "foreign"]),
        }),
        /branch\/head|branch-mismatch/u,
      );
      assert.equal(gitOutput(target, ["symbolic-ref", "HEAD"]), "refs/heads/foreign");
      assert.equal(gitOutput(target, ["rev-parse", "HEAD"]), fixture.head);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("does not adopt a foreign empty directory created after absence observation", () => {
    const fixture = createGitFixture("empty-race");
    const target = join(fixture.repo, ".opencode", "worktrees", "empty-raced");
    try {
      assert.throws(
        () => createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: fixture.head }, {
          beforeAdd: () => mkdirSync(target),
        }),
        /not-a-registered-worktree|branch\/head/u,
      );
      assert.equal(existsSync(target), true);
      assert.equal(existsSync(join(target, ".git")), false);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });
});

function createGitFixture(name) {
  const repo = mkdtempSync(join(tmpdir(), `factory-worktree-${name}-`));
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
  const head = gitOutput(repo, ["rev-parse", "HEAD"]);
  git(repo, ["branch", "child", head]);
  git(repo, ["branch", "foreign", head]);
  return { repo, head };
}

function git(cwd, args) {
  const proc = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function gitOutput(cwd, args) {
  const proc = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout.trim();
}
