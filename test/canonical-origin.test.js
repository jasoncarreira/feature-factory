import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { observeCanonicalOriginMain, withCanonicalOriginMain } from "../src/canonical-origin/index.js";
import { spawnSync } from "./helpers/git-fixture.js";
import { createCanonicalOriginFixture, git, output } from "./helpers/base-advance-origin/fixture.js";

describe("fresh canonical origin/main observation", () => {
  it("uses a private ref without changing local main, origin/main, or FETCH_HEAD", async () => {
    const fixture = createCanonicalOriginFixture("fresh");
    try {
      const target = fixture.advance("target\n");
      const localMain = output(fixture.repo, ["rev-parse", "refs/heads/main"]);
      const trackingMain = output(fixture.repo, ["rev-parse", "refs/remotes/origin/main"]);
      const fetchHead = join(fixture.repo, ".git", "FETCH_HEAD");
      writeFileSync(fetchHead, "preserved-fetch-head\n");

      const observed = await observeCanonicalOriginMain(fixture.repo, fixture.base);

      assert.deepEqual({
        origin: observed.origin,
        repository: observed.repository,
        ref: observed.ref,
        commit: observed.commit,
        recorded_base: observed.recorded_base,
      }, {
        origin: fixture.canonicalUrl,
        repository: "example/fresh",
        ref: "refs/heads/main",
        commit: target,
        recorded_base: fixture.base,
      });
      assert.equal(output(fixture.repo, ["rev-parse", "refs/heads/main"]), localMain);
      assert.equal(output(fixture.repo, ["rev-parse", "refs/remotes/origin/main"]), trackingMain);
      assert.equal(readFileSync(fetchHead, "utf8"), "preserved-fetch-head\n");
      assert.equal(output(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/base-advance-origin/"]), "");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate and empty origins plus unavailable or malformed advertisements with stable codes", async () => {
    const fixture = createCanonicalOriginFixture("reject");
    try {
      fixture.advance("target\n");
      git(fixture.repo, ["config", "--add", "remote.origin.url", "https://github.com/example/other.git"]);
      await rejectsWithCode(
        () => observeCanonicalOriginMain(fixture.repo, fixture.base),
        "BASE_ADVANCE_ORIGIN_AMBIGUOUS",
      );
      git(fixture.repo, ["config", "--unset-all", "remote.origin.url"]);
      git(fixture.repo, ["config", "--add", "remote.origin.url", fixture.canonicalUrl]);
      git(fixture.repo, ["config", "--add", "remote.origin.url", ""]);
      await rejectsWithCode(
        () => observeCanonicalOriginMain(fixture.repo, fixture.base),
        "BASE_ADVANCE_ORIGIN_AMBIGUOUS",
      );
      git(fixture.repo, ["config", "--unset-all", "remote.origin.url"]);
      git(fixture.repo, ["config", "--add", "remote.origin.url", fixture.canonicalUrl]);

      const unavailable = await rejectsWithCode(
        () => observeCanonicalOriginMain(fixture.repo, fixture.base, { gitOptions: { spawnSync: interceptLsRemote("unavailable") } }),
        "BASE_ADVANCE_ORIGIN_UNAVAILABLE",
      );
      assert.equal(unavailable.message.includes("credential-secret"), false);
      await rejectsWithCode(
        () => observeCanonicalOriginMain(fixture.repo, fixture.base, { gitOptions: { spawnSync: interceptLsRemote("ambiguous") } }),
        "BASE_ADVANCE_ORIGIN_AMBIGUOUS",
      );
      assert.equal(output(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/base-advance-origin/"]), "");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("requires one byte-exact origin/main advertisement row", async () => {
    const fixture = createCanonicalOriginFixture("strict-advertisement");
    try {
      const oid = fixture.advance("target\n");
      const row = `${oid}\trefs/heads/main`;
      const malformed = [
        `\n${row}\n`,
        `${row}\n\n`,
        `${row}\n${row}\n`,
        `${row}\r\n`,
        `${row} \n`,
        `${row}\ntrailing`,
        row,
        `${"A".repeat(40)}\trefs/heads/main\n`,
      ];
      for (const stdout of malformed) {
        await rejectsWithCode(
          () => observeCanonicalOriginMain(fixture.repo, fixture.base, { gitOptions: { spawnSync: replaceLsRemote(stdout) } }),
          "BASE_ADVANCE_ORIGIN_AMBIGUOUS",
        );
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("classifies missing origin, fetch transport, invalid Git state, ancestry, and foreign temporary refs", async () => {
    const fixture = createCanonicalOriginFixture("classifications");
    try {
      fixture.advance("target\n");
      git(fixture.repo, ["config", "--unset-all", "remote.origin.url"]);
      await rejectsWithCode(
        () => observeCanonicalOriginMain(fixture.repo, fixture.base),
        "BASE_ADVANCE_ORIGIN_UNAVAILABLE",
      );
      git(fixture.repo, ["config", "--add", "remote.origin.url", fixture.canonicalUrl]);

      const fetchFailure = await rejectsWithCode(
        () => observeCanonicalOriginMain(fixture.repo, fixture.base, { gitOptions: { spawnSync: failGitCommand("fetch") } }),
        "BASE_ADVANCE_ORIGIN_UNAVAILABLE",
      );
      assert.equal(fetchFailure.message.includes("credential-secret"), false);

      await rejectsWithCode(
        () => observeCanonicalOriginMain(fixture.repo, "f".repeat(40)),
        "BASE_ADVANCE_GIT_STATE_INVALID",
      );
      await rejectsWithCode(
        () => observeCanonicalOriginMain(fixture.repo, fixture.base, { gitOptions: { spawnSync: failGitCommand("merge-base") } }),
        "BASE_ADVANCE_GIT_STATE_INVALID",
      );
      await rejectsWithCode(
        () => observeCanonicalOriginMain(fixture.repo, fixture.base, { gitOptions: { spawnSync: initialForeignTemporaryRef() } }),
        "BASE_ADVANCE_ORIGIN_AMBIGUOUS",
      );
      await rejectsWithCode(
        () => observeCanonicalOriginMain(fixture.repo, fixture.base, { gitOptions: { spawnSync: interceptLsRemote("stale") } }),
        "BASE_ADVANCE_ORIGIN_AMBIGUOUS",
      );

      git(fixture.repo, ["remote", "set-url", "origin", "https://user:credential-secret@github.com/example/classifications.git"]);
      const noncanonical = await rejectsWithCode(
        () => observeCanonicalOriginMain(fixture.repo, fixture.base),
        "BASE_ADVANCE_ORIGIN_AMBIGUOUS",
      );
      assert.equal(noncanonical.message.includes("credential-secret"), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("classifies a proven non-ancestor separately from invalid Git state", async () => {
    const fixture = createCanonicalOriginFixture("non-fast-forward");
    try {
      fixture.advance("target\n");
      writeFileSync(join(fixture.repo, "side.txt"), "side\n");
      git(fixture.repo, ["add", "side.txt"]);
      git(fixture.repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "side"]);
      const sideCommit = output(fixture.repo, ["rev-parse", "HEAD"]);

      await rejectsWithCode(
        () => observeCanonicalOriginMain(fixture.repo, sideCommit),
        "BASE_ADVANCE_NON_FAST_FORWARD",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a remote move during consumption and cleans its exact temporary ref", async () => {
    const fixture = createCanonicalOriginFixture("moved");
    try {
      const firstTarget = fixture.advance("first\n");
      let consumed;
      await assert.rejects(
        () => withCanonicalOriginMain(fixture.repo, fixture.base, (observation) => {
          consumed = observation.commit;
          fixture.advance("second\n");
          return "not-authoritative";
        }),
        (error) => error.code === "BASE_ADVANCE_TARGET_MOVED" && /moved before the checked operation completed/u.test(error.message),
      );
      assert.equal(consumed, firstTarget);
      assert.equal(output(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/base-advance-origin/"]), "");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses to delete a temporary ref whose object identity changed", async () => {
    const fixture = createCanonicalOriginFixture("tampered");
    try {
      fixture.advance("target\n");
      let temporaryRef;
      await assert.rejects(
        () => withCanonicalOriginMain(fixture.repo, fixture.base, (observation) => {
          temporaryRef = observation.temporary_ref;
          git(fixture.repo, ["update-ref", temporaryRef, fixture.base, observation.commit]);
        }),
        (error) => error.code === "BASE_ADVANCE_TEMP_REF_CLEANUP_FAILED" && /temporary ref changed and cannot be cleaned safely/u.test(error.message),
      );
      assert.equal(output(fixture.repo, ["rev-parse", temporaryRef]), fixture.base);
      git(fixture.repo, ["update-ref", "-d", temporaryRef, fixture.base]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("classifies an exact temporary-ref deletion failure without exposing Git diagnostics", async () => {
    const fixture = createCanonicalOriginFixture("cleanup-failure");
    try {
      fixture.advance("target\n");
      const rejected = await rejectsWithCode(
        () => observeCanonicalOriginMain(fixture.repo, fixture.base, { gitOptions: { spawnSync: failTemporaryRefDeletion() } }),
        "BASE_ADVANCE_TEMP_REF_CLEANUP_FAILED",
      );
      assert.equal(rejected.message.includes("credential-secret"), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

function interceptLsRemote(mode) {
  return (file, args, options) => {
    if (args[0] === "ls-remote") {
      if (mode === "unavailable") return { status: 2, stdout: "", stderr: "credential-secret" };
      const oid = "a".repeat(40);
      if (mode === "stale") return { status: 0, stdout: `${oid}\trefs/heads/main\n`, stderr: "" };
      return { status: 0, stdout: `${oid}\trefs/heads/main\n${oid}\trefs/heads/main\n`, stderr: "" };
    }
    return spawnSync(file, args, options);
  };
}

function replaceLsRemote(stdout) {
  return (file, args, options) => {
    if (args[0] === "ls-remote") return { status: 0, stdout, stderr: "" };
    return spawnSync(file, args, options);
  };
}

function failGitCommand(command) {
  return (file, args, options) => {
    if (args[0] === command) return { status: 128, stdout: "https://token@example.invalid/private", stderr: "credential-secret" };
    return spawnSync(file, args, options);
  };
}

function initialForeignTemporaryRef() {
  let temporaryRef;
  return (file, args, options) => {
    if (args[0] === "show-ref" && args[1] === "--verify") {
      temporaryRef = args.at(-1);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (temporaryRef && args[0] === "rev-parse" && args[2] === `${temporaryRef}^{commit}`) {
      return { status: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" };
    }
    return spawnSync(file, args, options);
  };
}

function failTemporaryRefDeletion() {
  return (file, args, options) => {
    if (args[0] === "update-ref" && args[1] === "-d" && args[2].startsWith("refs/opencode/base-advance-origin/")) {
      return { status: 128, stdout: "https://token@example.invalid/private", stderr: "credential-secret" };
    }
    return spawnSync(file, args, options);
  };
}

async function rejectsWithCode(action, code) {
  let rejected;
  await assert.rejects(action, (error) => {
    rejected = error;
    assert.equal(error.code, code);
    assert.equal(typeof error.message, "string");
    assert.notEqual(error.message, "");
    return true;
  });
  return rejected;
}
