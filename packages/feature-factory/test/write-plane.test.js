// The atomic writer and the lock TTL replaced ported, proven code with new code.
// Every protective claim made in their comments is asserted here, because an
// untested claim in crash-safety code is worse than no claim.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { writeProtectedJsonAtomic } from "../core/atomic-write.js";
import { withRunJsonLock } from "../core/run-lock.js";

function root(name) {
  return mkdtempSync(join(tmpdir(), `ff-wp-${name}-`));
}

const hidden = (dir) => readdirSync(dir).filter((entry) => entry.endsWith(".tmp"));

describe("atomic writer", () => {
  it("writes, and leaves no temp file behind", async () => {
    const dir = root("write");
    try {
      await writeProtectedJsonAtomic(dir, "run.json", { version: 1 });
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")), { version: 1 });
      assert.deepEqual(hidden(dir), [], "no temp file may survive a successful write");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a symlinked target, before and after the commit hook", async () => {
    const dir = root("symlink");
    try {
      writeFileSync(join(dir, "elsewhere.json"), "{}\n");
      symlinkSync(join(dir, "elsewhere.json"), join(dir, "run.json"));

      // Refused on the first check.
      await assert.rejects(() => writeProtectedJsonAtomic(dir, "run.json", { version: 1 }),
        /protected file target has an unsafe type/u);
      assert.equal(readFileSync(join(dir, "elsewhere.json"), "utf8"), "{}\n", "the link target must be untouched");

      // Refused on the re-check: the link is planted during beforeCommit, i.e. in
      // the TOCTOU window a single up-front check would miss.
      const clean = root("symlink-race");
      try {
        writeFileSync(join(clean, "elsewhere.json"), "{}\n");
        await assert.rejects(() => writeProtectedJsonAtomic(clean, "run.json", { version: 1 }, {
          hooks: { beforeCommit: () => symlinkSync(join(clean, "elsewhere.json"), join(clean, "run.json")) },
        }), /protected file target has an unsafe type/u);
        assert.equal(readFileSync(join(clean, "elsewhere.json"), "utf8"), "{}\n");
        assert.deepEqual(hidden(clean), [], "the temp file must be cleaned up after a refused commit");
      } finally { rmSync(clean, { recursive: true, force: true }); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a path that escapes its root, and a root that is not absolute", async () => {
    const dir = root("escape");
    try {
      for (const relative of ["../outside.json", "nested/../../outside.json", "/etc/passwd", "", "."]) {
        await assert.rejects(() => writeProtectedJsonAtomic(dir, relative, { version: 1 }),
          /protected relative path (is invalid|escapes its root)/u, `must refuse ${JSON.stringify(relative)}`);
      }
      await assert.rejects(() => writeProtectedJsonAtomic("relative/root", "run.json", { version: 1 }),
        /protected file root is invalid/u);
      // A sibling directory sharing a name prefix is outside the root.
      const sibling = `${dir}-sibling`;
      mkdirSync(sibling, { recursive: true });
      try {
        await assert.rejects(() => writeProtectedJsonAtomic(dir, join("..", `${dir.split("/").pop()}-sibling`, "run.json"), { version: 1 }),
          /escapes its root/u);
      } finally { rmSync(sibling, { recursive: true, force: true }); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("leaves the previous record intact when the commit hook throws", async () => {
    const dir = root("hook-throws");
    try {
      writeFileSync(join(dir, "run.json"), '{"version":1,"generation":"first"}\n');
      const before = readFileSync(join(dir, "run.json"), "utf8");
      await assert.rejects(() => writeProtectedJsonAtomic(dir, "run.json", { version: 1, generation: "second" }, {
        hooks: { beforeCommit: () => { throw new Error("refused at the boundary"); } },
      }), /protected file commit failed/u);
      assert.equal(readFileSync(join(dir, "run.json"), "utf8"), before, "a refused write must not be partially visible");
      assert.deepEqual(hidden(dir), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("surfaces the original failure as the cause", async () => {
    const dir = root("cause");
    try {
      await assert.rejects(() => writeProtectedJsonAtomic(dir, "run.json", { version: 1 }, {
        hooks: { beforeCommit: () => { throw new Error("distinctive inner reason"); } },
      }), (error) => {
        assert.equal(error.name, "ProtectedWriteError");
        assert.match(String(error.cause?.message), /distinctive inner reason/u);
        return true;
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("lock staleness is decided by TTL, not by process probing", () => {
  function seed(name) {
    const dir = root(name);
    writeFileSync(join(dir, "run.json"), '{"version":1}\n');
    return dir;
  }

  // Plant a lock owned by this host with a chosen age, without holding it.
  function plantLock(dir, ageMs) {
    const lockDir = join(dir, "run-json.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), `${JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      acquired_at: new Date(Date.now() - ageMs).toISOString(),
      nonce: "11111111-1111-4111-8111-111111111111",
    }, null, 2)}\n`);
  }

  it("steals a lock older than the TTL", async () => {
    const dir = seed("stale");
    try {
      plantLock(dir, 5000);
      let ran = false;
      await withRunJsonLock(dir, async () => { ran = true; }, { staleLockMs: 100, timeoutMs: 2000 });
      assert.equal(ran, true, "a lock held past the TTL must be reclaimable");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses to steal a lock inside the TTL", async () => {
    const dir = seed("fresh");
    try {
      plantLock(dir, 0);
      await assert.rejects(
        () => withRunJsonLock(dir, async () => {}, { staleLockMs: 60000, timeoutMs: 150 }),
        (error) => {
          assert.match(String(error.message), /lock|contend|timed out/iu);
          return true;
        },
        "a fresh lock must not be stolen",
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses to steal when the owner timestamp is in the future", async () => {
    // Clock skew must not make theft the fallback.
    const dir = seed("skew");
    try {
      plantLock(dir, -600000);
      await assert.rejects(
        () => withRunJsonLock(dir, async () => {}, { staleLockMs: 100, timeoutMs: 150 }),
        /lock|contend|timed out/iu,
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
