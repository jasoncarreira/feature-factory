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

  it("rejects duplicate origins, stale, unavailable or ambiguous advertisements, and non-ancestor bases", async () => {
    const fixture = createCanonicalOriginFixture("reject");
    try {
      fixture.advance("target\n");
      git(fixture.repo, ["config", "--add", "remote.origin.url", "https://github.com/example/other.git"]);
      await assert.rejects(() => observeCanonicalOriginMain(fixture.repo, fixture.base), /exactly one canonical GitHub origin/u);
      git(fixture.repo, ["config", "--unset-all", "remote.origin.url"]);
      git(fixture.repo, ["config", "--add", "remote.origin.url", fixture.canonicalUrl]);

      await assert.rejects(
        () => observeCanonicalOriginMain(fixture.repo, "f".repeat(40)),
        /not an ancestor/u,
      );
      await assert.rejects(
        () => observeCanonicalOriginMain(fixture.repo, fixture.base, { gitOptions: { spawnSync: interceptLsRemote("unavailable") } }),
        /unavailable or ambiguous/u,
      );
      await assert.rejects(
        () => observeCanonicalOriginMain(fixture.repo, fixture.base, { gitOptions: { spawnSync: interceptLsRemote("stale") } }),
        /changed during fresh observation/u,
      );
      await assert.rejects(
        () => observeCanonicalOriginMain(fixture.repo, fixture.base, { gitOptions: { spawnSync: interceptLsRemote("ambiguous") } }),
        /unavailable or ambiguous/u,
      );
      assert.equal(output(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/opencode/base-advance-origin/"]), "");
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
        /moved before the checked operation completed/u,
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
        /temporary ref changed and cannot be cleaned safely/u,
      );
      assert.equal(output(fixture.repo, ["rev-parse", temporaryRef]), fixture.base);
      git(fixture.repo, ["update-ref", "-d", temporaryRef, fixture.base]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

function interceptLsRemote(mode) {
  return (file, args, options) => {
    if (args[0] === "ls-remote") {
      if (mode === "unavailable") return { status: 2, stdout: "", stderr: "offline" };
      const oid = "a".repeat(40);
      if (mode === "stale") return { status: 0, stdout: `${oid}\trefs/heads/main\n`, stderr: "" };
      return { status: 0, stdout: `${oid}\trefs/heads/main\n${oid}\trefs/heads/main\n`, stderr: "" };
    }
    return spawnSync(file, args, options);
  };
}
