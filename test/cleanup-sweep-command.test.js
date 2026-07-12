import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCleanupSweepCommand, runCleanupSweepCommand } from "../src/cleanup-sweep-command.js";

const DIGEST = `ff-cleanup-v1.${"a".repeat(64)}.${"b".repeat(64)}`;

describe("cleanup sweep command", () => {
  it("parses the frozen preview and execute grammar in unrestricted flag order", () => {
    assert.deepEqual(parseCleanupSweepCommand(["--json", "--dry-run", "--repo", "repo", "--all"], { cwd: "/base" }), {
      mode: "preview", cwd: "/base/repo", json: true,
    });
    assert.deepEqual(parseCleanupSweepCommand(["--digest", DIGEST, "--all"], { cwd: "/repo" }), {
      mode: "execute", cwd: "/repo", json: false, digest: DIGEST,
    });
  });

  it("rejects R42 digest and mode grammar before invoking a handler", async () => {
    const invalid = [
      ["--all"],
      ["--all", "--dry-run", "--digest", DIGEST],
      ["--digest", DIGEST],
      ["--all", "--digest"],
      ["--all", "--digest", ""],
      ["--all", "--digest", "--json"],
      ["--all", "--digest", "bad"],
      ["--all", "--digest", DIGEST, "--digest", DIGEST],
      ["--all", "--dry-run", "--all"],
      ["run-id", "--all", "--dry-run"],
      ["--all", "--dry-run", "--force"],
      ["--all", "--dry-run", "--repo"],
      ["--all", "--dry-run", "--repo", "--json"],
      ["--all", "--dry-run", "--json", "--json"],
      ["--all=true", "--dry-run"],
      ["--all", "--dry-run", "-x"],
      ["--all", "--dry-run", "--"],
    ];
    for (const args of invalid) assert.throws(() => parseCleanupSweepCommand(args), /factory cleanup/u, args.join(" "));

    let calls = 0;
    await assert.rejects(
      runCleanupSweepCommand(["--all", "--digest", "invalid"], {
        preview: () => { calls += 1; }, execute: () => { calls += 1; },
      }),
      /valid cleanup digest/u,
    );
    assert.equal(calls, 0);
  });

  it("invokes exactly one mode handler and returns the report exit code", async () => {
    const calls = [];
    const handlers = {
      cwd: "/repo",
      preview: async (command) => { calls.push(["preview", command]); return { exit_code: 0 }; },
      execute: async (command) => { calls.push(["execute", command]); return { exit_code: 1 }; },
    };
    assert.deepEqual(await runCleanupSweepCommand(["--all", "--dry-run"], handlers), { report: { exit_code: 0 }, exitCode: 0 });
    assert.deepEqual(await runCleanupSweepCommand(["--all", "--digest", DIGEST], handlers), { report: { exit_code: 1 }, exitCode: 1 });
    assert.deepEqual(calls.map(([name]) => name), ["preview", "execute"]);
  });
});
