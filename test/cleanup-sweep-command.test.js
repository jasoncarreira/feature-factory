import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCleanupSweepCommand, runCleanupSweepCommand } from "../src/cleanup-sweep-command.js";

const DIGEST = `ff-cleanup-v1.${"a".repeat(64)}.${"b".repeat(64)}`;

const R42_CASES = [
  ["R42-A", ["--digest", DIGEST], "factory cleanup --digest requires --all"],
  ["R42-B", ["--json", "--dry-run"], "factory cleanup sweep requires --all"],
  ["R42-C", ["--all"], "factory cleanup --all requires exactly one of --dry-run or --digest"],
  ["R42-D", ["--digest", DIGEST, "--all", "--dry-run"], "factory cleanup --all requires exactly one of --dry-run or --digest"],
  ["R42-E missing", ["--all", "--digest"], "factory cleanup --all requires a value for --digest"],
  ["R42-E empty", ["--digest", "", "--all"], "factory cleanup --all requires a value for --digest"],
  ["R42-E flag-valued", ["--all", "--digest", "--json"], "factory cleanup --all requires a value for --digest"],
  ["R42-F", ["--all", "--digest", "not-a-digest"], "factory cleanup --all requires a valid cleanup digest"],
  ["R42-G missing", ["--all", "--dry-run", "--repo"], "factory cleanup --all requires a value for --repo"],
  ["R42-G empty", ["--repo", "", "--all", "--dry-run"], "factory cleanup --all requires a value for --repo"],
  ["R42-G flag-valued", ["--all", "--repo", "--json", "--dry-run"], "factory cleanup --all requires a value for --repo"],
  ["R42-H", ["--all", "--dry-run", "--all"], "factory cleanup --all does not allow repeated --all"],
  ["R42-I", ["--dry-run", "--all", "--dry-run"], "factory cleanup --all does not allow repeated --dry-run"],
  ["R42-J", ["--all", "--digest", DIGEST, "--digest", DIGEST], "factory cleanup --all does not allow repeated --digest"],
  ["R42-K", ["--repo", "one", "--all", "--dry-run", "--repo", "two"], "factory cleanup --all does not allow repeated --repo"],
  ["R42-L", ["--json", "--all", "--dry-run", "--json"], "factory cleanup --all does not allow repeated --json"],
  ["R42-M", ["--all", "run-id", "--dry-run"], "factory cleanup --all does not accept a run ID"],
  ["R42-N", ["--all", "--force", "--dry-run"], "factory cleanup --all does not support --force"],
  ["R42-O long", ["--all", "--unknown", "--dry-run"], "factory cleanup --all received an unsupported option"],
  ["R42-O short", ["--all", "-x", "--dry-run"], "factory cleanup --all received an unsupported option"],
  ["R42-O equals", ["--all=true", "--dry-run"], "factory cleanup --all received an unsupported option"],
  ["R42-O separator", ["--all", "--", "--dry-run"], "factory cleanup --all received an unsupported option"],
];

describe("cleanup sweep command", () => {
  it("implements R42-A through R42-O with exact details and zero handler calls", async () => {
    let calls = 0;
    const handlers = {
      preview: () => { calls += 1; },
      execute: () => { calls += 1; },
    };
    for (const [name, args, detail] of R42_CASES) {
      assert.throws(
        () => parseCleanupSweepCommand(args),
        (error) => error.message === detail,
        name,
      );
      await assert.rejects(
        runCleanupSweepCommand(args, handlers),
        (error) => error.message === detail,
        name,
      );
    }
    assert.equal(calls, 0);
  });

  it("applies token-scan, mode-relationship, then digest-syntax precedence", () => {
    const cases = [
      [["--digest", "bad", "--force"], "factory cleanup --all does not support --force"],
      [["--all", "--digest", "bad", "--dry-run"], "factory cleanup --all requires exactly one of --dry-run or --digest"],
      [["--digest", "bad"], "factory cleanup --digest requires --all"],
      [["--all", "--digest", "bad"], "factory cleanup --all requires a valid cleanup digest"],
      [["--all", "--digest", DIGEST, "--digest"], "factory cleanup --all does not allow repeated --digest"],
      [["--all", "--repo", "--repo", "x", "--dry-run"], "factory cleanup --all requires a value for --repo"],
    ];
    for (const [args, detail] of cases) {
      assert.throws(() => parseCleanupSweepCommand(args), (error) => error.message === detail, args.join(" "));
    }
  });

  it("accepts every ordering of valid preview and execute flag groups", () => {
    for (const groups of permutations([["--all"], ["--dry-run"], ["--repo", "repo"], ["--json"]])) {
      assert.deepEqual(parseCleanupSweepCommand(groups.flat(), { cwd: "/base" }), {
        mode: "preview", cwd: "/base/repo", json: true,
      });
    }
    for (const groups of permutations([["--all"], ["--digest", DIGEST], ["--repo", "repo"], ["--json"]])) {
      assert.deepEqual(parseCleanupSweepCommand(groups.flat(), { cwd: "/base" }), {
        mode: "execute", cwd: "/base/repo", json: true, digest: DIGEST,
      });
    }
  });

  it("enforces exact digest prefix, lowercase alphabet, component lengths, and boundaries", () => {
    assert.equal(parseCleanupSweepCommand(["--all", "--digest", DIGEST]).digest, DIGEST);
    const invalid = [
      `ff-cleanup-v1.${"a".repeat(63)}.${"b".repeat(64)}`,
      `ff-cleanup-v1.${"a".repeat(65)}.${"b".repeat(64)}`,
      `ff-cleanup-v1.${"a".repeat(64)}.${"b".repeat(63)}`,
      `ff-cleanup-v1.${"a".repeat(64)}.${"b".repeat(65)}`,
      `ff-cleanup-v1.${"A".repeat(64)}.${"b".repeat(64)}`,
      `ff-cleanup-v2.${"a".repeat(64)}.${"b".repeat(64)}`,
      `${DIGEST}\n`,
    ];
    for (const digest of invalid) {
      assert.throws(
        () => parseCleanupSweepCommand(["--all", "--digest", digest]),
        (error) => error.message === "factory cleanup --all requires a valid cleanup digest",
      );
    }
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

function permutations(values) {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) => permutations(values.toSpliced(index, 1)).map((rest) => [value, ...rest]));
}
