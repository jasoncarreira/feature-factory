import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

describe("cli factory cancel", () => {
  it("routes cancel to process-evidence cancellation and exits non-zero for ok:false", () => {
    const fixture = createFixture("cli-cancel-missing-evidence");
    try {
      const before = readFileSync(join(fixture.runDir, "run.json"), "utf8");

      const proc = runCli(fixture.repo, ["factory", "cancel", fixture.runId, "--json"]);

      assert.notEqual(proc.status, 0);
      assert.equal(proc.stderr, "");
      const output = JSON.parse(proc.stdout);
      assert.equal(output.ok, false);
      assert.equal(output.status, "failed-closed");
      assert.match(output.reason, /missing process evidence/u);
      assert.equal(output.signaled, false);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), before);
    } finally {
      cleanup(fixture.repo);
    }
  });

  it("requires exactly one explicit run id", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-cli-cancel-"));
    try {
      const proc = runCli(repo, ["factory", "cancel", "--json"]);

      assert.notEqual(proc.status, 0);
      assert.equal(proc.stdout, "");
      assert.match(proc.stderr, /factory cancel requires exactly one <run-id>/u);
    } finally {
      cleanup(repo);
    }
  });
});

function createFixture(runId) {
  const repo = mkdtempSync(join(tmpdir(), "factory-cli-cancel-"));
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, "run.json"), { schema_version: 1, run_id: runId, status: "running", gates: {} });
  return { repo, runDir, runId };
}

function runCli(repo, args) {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: "utf8",
    timeout: 15000,
  });
  if (proc.error) throw proc.error;
  return proc;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
