import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "./helpers/git-fixture.js";
import { createOrRecoverWorktree, deriveExpectedWorktreePath, observeRegisteredWorktree } from "../src/worktrees.js";

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
      const created = createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: fixture.head, claim: "e".repeat(40) });
      assert.equal(created.recovered, false);
      assert.equal(gitOutput(target, ["rev-parse", "HEAD"]), fixture.head);
      assert.equal(gitOutput(target, ["symbolic-ref", "HEAD"]), "refs/heads/child");

      const recovered = createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: fixture.head, claim: "e".repeat(40) });
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
          () => createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: expectedHead, claim: "e".repeat(40) }),
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
        () => createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: fixture.head, claim: "e".repeat(40) }, {
          beforeAdd: () => git(fixture.repo, ["worktree", "add", target, "foreign"]),
        }),
        /branch\/head|branch-mismatch|target appeared|not be adopted/u,
      );
      assert.equal(gitOutput(target, ["symbolic-ref", "HEAD"]), "refs/heads/foreign");
      assert.equal(gitOutput(target, ["rev-parse", "HEAD"]), fixture.head);
      assert.deepEqual(reservationFiles(fixture.repo), []);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("does not adopt a foreign empty directory created after absence observation", () => {
    const fixture = createGitFixture("empty-race");
    const target = join(fixture.repo, ".opencode", "worktrees", "empty-raced");
    try {
      assert.throws(
        () => createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: fixture.head, claim: "e".repeat(40) }, {
          beforeAdd: () => mkdirSync(target),
        }),
        /not-a-registered-worktree|branch\/head|target appeared|not be adopted/u,
      );
      assert.equal(existsSync(target), true);
      assert.equal(existsSync(join(target, ".git")), false);
      assert.deepEqual(reservationFiles(fixture.repo), []);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("relies on the worktree move mutation to reject a foreign empty target race", () => {
    const fixture = createGitFixture("empty-move-race");
    const target = join(fixture.repo, ".opencode", "worktrees", "empty-move-raced");
    try {
      assert.throws(
        () => createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: fixture.head, claim: "f".repeat(40) }, {
          beforeMove: () => mkdirSync(target),
        }),
        /worktree move failed|not-a-registered-worktree/u,
      );
      assert.equal(existsSync(target), true);
      assert.equal(existsSync(join(target, ".git")), false);
      assert.equal(reservationFiles(fixture.repo).length, 1);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("recovers an interruption after publishing its claim-bound reservation before worktree add", () => {
    const fixture = createGitFixture("reserved-crash");
    const target = join(fixture.repo, ".opencode", "worktrees", "reserved-crash");
    const claimOid = "a".repeat(40);
    let published;
    try {
      assert.throws(() => createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: fixture.head, claim: claimOid }, {
        afterReserve(state) {
          published = state;
          throw new Error("interrupted after reservation");
        },
      }), /interrupted after reservation/u);
      assert.equal(existsSync(target), false);
      assert.equal(existsSync(published.reservationPath), true);
      const reservation = JSON.parse(readFileSync(published.reservationPath, "utf8"));
      assert.equal(reservation.claim_oid, claimOid);
      assert.equal(reservation.target, target);
      assert.equal(reservation.branch, "child");
      assert.equal(reservation.head, fixture.head);

      const recovered = createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: fixture.head, claim: claimOid });
      assert.equal(recovered.recovered, true);
      assert.equal(gitOutput(target, ["rev-parse", "HEAD"]), fixture.head);
      assert.deepEqual(reservationFiles(fixture.repo), []);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("recovers an add failure that leaves its owned staging path unregistered", () => {
    const fixture = createGitFixture("add-failure");
    const target = join(fixture.repo, ".opencode", "worktrees", "add-failure");
    const claimOid = "b".repeat(40);
    try {
      assert.throws(() => createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: fixture.head, claim: claimOid }, {
        spawnSync(file, args, options) {
          if (args[0] === "worktree" && args[1] === "add") return { status: 1, stdout: "", stderr: "injected add failure" };
          return spawnSync(file, args, options);
        },
      }), /injected add failure/u);
      assert.equal(existsSync(target), false);
      assert.equal(reservationFiles(fixture.repo).length, 1);

      const recovered = createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: fixture.head, claim: claimOid });
      assert.equal(recovered.recovered, true);
      assert.equal(gitOutput(target, ["symbolic-ref", "HEAD"]), "refs/heads/child");
      assert.deepEqual(reservationFiles(fixture.repo), []);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("recovers interruptions after successful add and after target move without deleting foreign state", () => {
    for (const hook of ["afterAdd", "afterMove"]) {
      const fixture = createGitFixture(`crash-${hook}`);
      const target = join(fixture.repo, ".opencode", "worktrees", `crash-${hook}`);
      const claimOid = hook === "afterAdd" ? "c".repeat(40) : "d".repeat(40);
      try {
        assert.throws(() => createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: fixture.head, claim: claimOid }, {
          [hook]() { throw new Error(`interrupted ${hook}`); },
        }), new RegExp(`interrupted ${hook}`));
        assert.equal(reservationFiles(fixture.repo).length, 1, hook);

        const recovered = createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: fixture.head, claim: claimOid });
        assert.equal(recovered.recovered, true, hook);
        assert.equal(gitOutput(target, ["rev-parse", "HEAD"]), fixture.head, hook);
        assert.deepEqual(reservationFiles(fixture.repo), [], hook);
      } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
    }
  });

  it("rejects claim mismatch, wrong reservation inode, target files, and target symlinks without adoption", () => {
    const inodeFixture = createGitFixture("wrong-inode");
    const inodeTarget = join(inodeFixture.repo, ".opencode", "worktrees", "wrong-inode");
    let published;
    try {
      assert.throws(() => createOrRecoverWorktree(inodeFixture.repo, inodeTarget, { branch: "child", head: inodeFixture.head, claim: "1".repeat(40) }, {
        afterReserve(state) { published = state; throw new Error("pause for inode mismatch"); },
      }), /pause for inode mismatch/u);
      const marker = JSON.parse(readFileSync(published.reservationPath, "utf8"));
      marker.staging_ino = String(BigInt(marker.staging_ino) + 1n);
      writeFileSync(published.reservationPath, JSON.stringify(marker));
      assert.throws(
        () => createOrRecoverWorktree(inodeFixture.repo, inodeTarget, { branch: "child", head: inodeFixture.head, claim: "1".repeat(40) }),
        /wrong filesystem identity/u,
      );
      assert.throws(
        () => createOrRecoverWorktree(inodeFixture.repo, inodeTarget, { branch: "child", head: inodeFixture.head, claim: "2".repeat(40) }),
        /does not exactly match the claim-bound target identity/u,
      );
      assert.equal(existsSync(inodeTarget), false);
    } finally { rmSync(inodeFixture.repo, { recursive: true, force: true }); }

    for (const kind of ["file", "symlink"]) {
      const fixture = createGitFixture(`foreign-${kind}`);
      const target = join(fixture.repo, ".opencode", "worktrees", `foreign-${kind}`);
      try {
        mkdirSync(join(fixture.repo, ".opencode", "worktrees"), { recursive: true });
        if (kind === "file") writeFileSync(target, "foreign\n");
        else symlinkSync(fixture.repo, target, "dir");
        assert.throws(
          () => createOrRecoverWorktree(fixture.repo, target, { branch: "child", head: fixture.head, claim: "3".repeat(40) }),
          /exists but is unsafe/u,
          kind,
        );
        assert.equal(existsSync(target), true, kind);
      } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
    }
  });
});

describe("registered worktree observation", () => {
  it("returns the exact clean attached branch and physical worktree identity", () => {
    const fixture = createGitFixture("observed");
    const target = join(fixture.repo, ".opencode", "worktrees", "observed");
    try {
      git(fixture.repo, ["worktree", "add", target, "child"]);

      const observed = observeRegisteredWorktree(fixture.repo, target, { branch: "child", head: fixture.head });

      assert.equal(observed.worktree, realpathSync.native(target));
      assert.equal(observed.worktree_root, realpathSync.native(join(fixture.repo, ".opencode", "worktrees")));
      assert.equal(observed.branch, "child");
      assert.equal(observed.head, fixture.head);
    } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
  });

  it("rejects dirty, detached, wrong-branch, wrong-HEAD, outside-root, duplicate, and in-progress worktrees", () => {
    for (const mode of ["dirty", "detached", "wrong-branch", "wrong-head", "outside", "duplicate", "operation"]) {
      const fixture = createGitFixture(`observe-${mode}`);
      const target = mode === "outside"
        ? join(fixture.repo, "outside-worktree")
        : join(fixture.repo, ".opencode", "worktrees", mode);
      try {
        if (mode === "outside") mkdirSync(join(fixture.repo, ".opencode", "worktrees"), { recursive: true });
        if (mode === "detached") git(fixture.repo, ["worktree", "add", "--detach", target, fixture.head]);
        else git(fixture.repo, ["worktree", "add", target, mode === "wrong-branch" ? "foreign" : "child"]);
        if (mode === "dirty") writeFileSync(join(target, "dirty.txt"), "dirty\n");
        if (mode === "operation") {
          const mergeHead = gitOutput(target, ["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"]);
          writeFileSync(mergeHead, `${fixture.head}\n`);
        }
        const options = mode === "duplicate" ? { spawnSync: duplicateWorktreeListing(target) } : {};
        const expectedError = {
          dirty: /dirty/u,
          detached: /not attached/u,
          "wrong-branch": /not attached/u,
          "wrong-head": /does not equal the expected commit/u,
          outside: /must stay under/u,
          duplicate: /exactly one physical registration/u,
          operation: /in-progress Git operation/u,
        }[mode];

        assert.throws(
          () => observeRegisteredWorktree(fixture.repo, target, { branch: "child", head: mode === "wrong-head" ? "f".repeat(40) : fixture.head }, options),
          expectedError,
          mode,
        );
      } finally { rmSync(fixture.repo, { recursive: true, force: true }); }
    }
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

function reservationFiles(repo) {
  const root = join(repo, ".opencode", "worktrees");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.includes("continuation-reservation"));
}

function duplicateWorktreeListing(target) {
  return (file, args, options) => {
    const proc = spawnSync(file, args, options);
    if (args[0] !== "worktree" || args[1] !== "list" || proc.status !== 0) return proc;
    const blocks = proc.stdout.trimEnd().split("\n\n");
    const targetBlock = blocks.find((block) => block.includes("\nbranch refs/heads/child"));
    assert.ok(targetBlock, `missing child worktree block for ${target}`);
    return { ...proc, stdout: `${proc.stdout.trimEnd()}\n\n${targetBlock}\n` };
  };
}
