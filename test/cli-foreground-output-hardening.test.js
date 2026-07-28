import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "./helpers/git-fixture.js";
import { fileURLToPath } from "node:url";
import { resumeFactory } from "../src/factory.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const SECRET = "Basic dXNlcjpzdXBlci1zZWNyZXQ=";

describe("foreground factory output hardening", () => {
  it("filters stdout and stderr while preserving destinations and success", () => {
    const fixture = createFixture("success", 0);
    try {
      const proc = run(fixture, ["factory", "start", "hostile output"]);
      assert.equal(proc.status, 0, proc.stderr);
      assert.match(proc.stdout, /stdout Authorization: Basic \[redacted\]/u);
      assert.match(proc.stderr, /stderr Authorization: Basic \[redacted\]/u);
      assertSafe(proc.stdout);
      assertSafe(proc.stderr);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves a nonzero child exit and emits only a sanitized operational error", () => {
    const fixture = createFixture("failure", 7);
    try {
      const proc = run(fixture, ["factory", "start", "failing output"]);
      assert.equal(proc.status, 1);
      assert.match(proc.stderr, /opencode exited 7/u);
      assertSafe(proc.stdout);
      assertSafe(proc.stderr);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("uses the same awaited filtered runner for resume", async () => {
    const fixture = createFixture("resume", 0);
    const runId = "foreground-resume";
    const runDir = join(fixture.repo, ".opencode", "factory", runId);
    const worktree = join(fixture.repo, ".opencode", "worktrees", runId);
    mkdirSync(runDir, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({
      schema_version: 1,
      run_id: runId,
      status: "running",
      branch: runId,
      worktree,
      gates: {},
      slices: [{ id: "slice", declared_paths: ["slice.txt"], effective_paths: ["slice.txt"], status: "running", attempts: 1, branch: runId, worktree }],
    }) + "\n");
    try {
      await resumeFactory(runId, { cwd: fixture.repo, env: launchEnv(fixture) });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

function createFixture(name, exitCode) {
  const root = mkdtempSync(join(tmpdir(), `factory-foreground-${name}-`));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  const script = join(bin, "opencode");
  writeFileSync(script, `#!/usr/bin/env node
process.stdout.write("stdout Authorization: ${SECRET}\\r\\u001b]8;;https://evil.test\\u0007link\\u001b]8;;\\u0007\\n");
process.stderr.write("stderr Authorization: ${SECRET}\\u001b[31m boom\\u001b[0m\\n");
process.exitCode = ${exitCode};
`, "utf8");
  chmodSync(script, 0o755);
  symlinkSync(CLI, join(bin, "feature-factory"));
  return { root, repo, bin };
}

function run(fixture, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: fixture.repo,
    encoding: "utf8",
    env: launchEnv(fixture),
    timeout: 15000,
  });
}

function launchEnv(fixture) {
  const env = {
    ...process.env,
    HOME: join(fixture.root, "home"),
    XDG_CONFIG_HOME: join(fixture.root, "xdg"),
    PATH: `${fixture.bin}:${process.env.PATH || ""}`,
  };
  delete env.OPENCODE_CONFIG_DIR;
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_CONTENT;
  return env;
}

function assertSafe(output) {
  assert.doesNotMatch(output, /dXNlcjpzdXBlci1zZWNyZXQ/u);
  assert.equal(output.includes("\r"), false);
  assert.equal(output.includes("\u001b"), false);
  assert.equal(output.includes("\u0007"), false);
  assert.equal(output.includes("\u009b"), false);
  assert.equal(output.includes("\u009d"), false);
}
