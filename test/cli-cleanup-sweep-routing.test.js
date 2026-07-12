import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, it } from "node:test";
import { spawnSync } from "./helpers/git-fixture.js";
import { runCleanupSweepCli } from "../src/cli.js";
import { executeCleanupSweep, previewCleanupSweep } from "../src/cleanup-sweep.js";
import { renderCleanupSweepReport } from "../src/cleanup-sweep-output.js";
import { createCleanupSweepFixture } from "./helpers/cleanup-sweep-fixture.js";

const cli = resolve("src/cli.js");
const DIGEST = `ff-cleanup-v1.${"a".repeat(64)}.${"b".repeat(64)}`;

describe("cleanup sweep CLI routing and output", () => {
  it("uses the exact Wave 1 runner, invokes one preview handler, renders once, and copies exit code", async () => {
    const calls = [];
    const report = { mode: "preview", exit_code: 0 };
    const exitCode = await runCleanupSweepCli(["--all", "--dry-run", "--json"], {
      preview(command) { calls.push(["preview", command]); return report; },
      execute() { calls.push(["execute"]); throw new Error("wrong handler"); },
      render(value, options) { calls.push(["render", value, options]); return "rendered-preview"; },
      stdout(value) { calls.push(["stdout", value]); },
      stderr(value) { calls.push(["stderr", value]); },
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(calls.map(([name]) => name), ["preview", "render", "stdout"]);
    assert.deepEqual(calls[0][1], { mode: "preview", cwd: process.cwd(), json: true });
    assert.deepEqual(calls[1].slice(1), [report, { json: true }]);
  });

  it("routes execute/refused/failed reports through one handler and one exact human/JSON render", async () => {
    const fixture = createCleanupSweepFixture("cli-routing-reports");
    try {
      fixture.addRun("run", { branch: null });
      const preview = await previewCleanupSweep(sweepOptions(fixture));
      writeFileSync(join(fixture.factoryRoot, "new-entry"), "unsafe\n");
      const refused = await executeCleanupSweep({ ...sweepOptions(fixture), digest: preview.authorization.digest });
      const failed = await previewCleanupSweep({ ...sweepOptions(fixture), deleteTemporaryRef: () => false });
      for (const [name, report, json] of [["refused", refused, false], ["failed", failed, true]]) {
        const stdout = [];
        let handlers = 0;
        let renders = 0;
        const args = ["--all", "--digest", DIGEST, ...(json ? ["--json"] : [])];
        const exit = await runCleanupSweepCli(args, {
          execute() { handlers += 1; return report; },
          preview() { throw new Error("wrong handler"); },
          render(value, options) { renders += 1; return renderCleanupSweepReport(value, options); },
          stdout: (line) => stdout.push(line),
        });
        assert.equal(handlers, 1, name);
        assert.equal(renders, 1, name);
        assert.equal(stdout.length, 1, name);
        assert.equal(stdout[0], renderCleanupSweepReport(report, { json }), name);
        assert.equal(exit, report.exit_code, name);
      }
    } finally { fixture.cleanup(); }
  });

  it("routes successful execute reports once with exact human and JSON output and final exit coupling", async () => {
    const fixture = createCleanupSweepFixture("cli-routing-success");
    try {
      fixture.addRun("run", { branch: null });
      const authorization = await previewCleanupSweep(sweepOptions(fixture));
      const completed = await executeCleanupSweep({ ...sweepOptions(fixture), digest: authorization.authorization.digest });
      assert.equal(completed.status, "completed");
      assert.equal(completed.candidates[0].classification, "deleted");
      for (const json of [false, true]) {
        let handlers = 0;
        let renders = 0;
        const stdout = [];
        const args = ["--all", "--digest", DIGEST, ...(json ? ["--json"] : [])];
        const exit = await runCleanupSweepCli(args, {
          execute(command) { handlers += 1; assert.equal(command.mode, "execute"); return completed; },
          preview() { throw new Error("wrong handler"); },
          render(report, options) { renders += 1; return renderCleanupSweepReport(report, options); },
          stdout: (line) => stdout.push(line),
        });
        assert.equal(handlers, 1);
        assert.equal(renders, 1);
        assert.deepEqual(stdout, [renderCleanupSweepReport(completed, { json })]);
        assert.equal(exit, completed.exit_code);
      }
    } finally { fixture.cleanup(); }
  });

  it("couples exit only to the final report and does not infer it from inspection/report errors", async () => {
    for (const report of [
      { mode: "execute", attempted_cleanup_failures: 1, report_errors: [], exit_code: 1 },
      { mode: "execute", attempted_cleanup_failures: 0, report_errors: [{ code: "FAILED_ORCHESTRATION" }], exit_code: 1 },
      { mode: "preview", attempted_cleanup_failures: 0, report_errors: [], candidates: [{ failure_stage: "inspection" }], exit_code: 0 },
    ]) {
      const modeArgs = report.mode === "preview" ? ["--all", "--dry-run"] : ["--all", "--digest", DIGEST];
      const exit = await runCleanupSweepCli(modeArgs, {
        preview: () => report,
        execute: () => report,
        render: () => "one report",
        stdout() {},
      });
      assert.equal(exit, report.exit_code);
    }
  });

  it("emits one fixed terminal-safe grammar error, no stdout, no handlers, and exit 1", async () => {
    const invalid = [
      ["--all", "--force", "--dry-run"],
      ["--all", "--dry-run", "run"],
      ["--all=1", "--dry-run"],
      ["--digest", DIGEST],
      ["--all", "--digest", "bad"],
    ];
    for (const args of invalid) {
      const stdout = [];
      const stderr = [];
      let handlers = 0;
      const exit = await runCleanupSweepCli(args, {
        preview() { handlers += 1; }, execute() { handlers += 1; },
        stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
      });
      assert.equal(exit, 1, args.join(" "));
      assert.equal(handlers, 0);
      assert.deepEqual(stdout, []);
      assert.deepEqual(stderr, ["error: invalid cleanup sweep command"]);
    }
  });

  it("routes real preview JSON before generic options and emits exactly one report", () => {
    const fixture = createCleanupSweepFixture("cli-real-preview");
    try {
      const result = runCli(fixture.repo, ["factory", "cleanup", "--all", "--dry-run", "--repo", fixture.repo, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, "previewed");
      assert.equal(result.stdout.trim().split("\n").filter((line) => line.startsWith("{")).length, 1);
    } finally { fixture.cleanup(); }
  });

  it("preserves existing single-run cleanup routing and output", () => {
    const fixture = createCleanupSweepFixture("cli-single-run");
    try {
      fixture.addRun("run", { branch: null });
      const result = runCli(fixture.repo, ["factory", "cleanup", "run", "--dry-run", "--repo", fixture.repo, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.run_id, "run");
      assert.equal(output.dry_run, true);
      assert.equal(output.removed_run_dir, false);
      assert.equal(existsSync(join(fixture.factoryRoot, "run")), true);
    } finally { fixture.cleanup(); }
  });

  it("publishes all exact cleanup usage forms", () => {
    const result = runCli(process.cwd(), ["--help"]);
    assert.match(result.stdout, /factory cleanup <run-id> \[--dry-run\] \[--force\] \[--repo PATH\] \[--json\]/u);
    assert.match(result.stdout, /factory cleanup --all --dry-run \[--repo PATH\] \[--json\]/u);
    assert.match(result.stdout, /factory cleanup --all --digest ff-cleanup-v1\.<repository-sha256>\.<envelope-sha256> \[--repo PATH\] \[--json\]/u);
  });
});

function runCli(cwd, args) { return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" }); }
function sweepOptions(fixture) {
  return {
    cwd: fixture.repo,
    invocationId: "cli-routing",
    clock: () => Date.parse("2026-07-12T12:00:00.000Z"),
    inspectProcess: () => ({ state: "absent" }),
    githubRunner: fixture.githubRunner,
    gitRunner: fixture.gitRunner,
  };
}
