import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { continueFactory, resumeFactory, startFactory } from "../src/factory.js";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("factory trace-context propagation", () => {
  it("launches foreground start without adding trace env by default while preserving operator OTEL env", async () => {
    const fixture = createLaunchFixture("start-no-default-env");
    try {
      await withLaunchEnv(fixture, { OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.honeycomb.io" }, async () => {
        await startFactory(["build telemetry"], { cwd: fixture.repo });
      });

      const launched = readJson(fixture.captureFile);
      assert.equal(launched.env.OTEL_EXPORTER_OTLP_ENDPOINT, "https://api.honeycomb.io");
      assert.equal(launched.env.TRACEPARENT, undefined);
      assert.equal(launched.env.TRACESTATE, undefined);
      assert.equal(launched.env.FEATURE_FACTORY_TRACEPARENT, undefined);
      assert.equal(launched.env.FEATURE_FACTORY_TRACESTATE, undefined);
      assert.equal(launched.env.FEATURE_FACTORY_PARENT_SPAN_ID, undefined);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("propagates validated traceparent and tracestate into detached start", async () => {
    const fixture = createLaunchFixture("start-detached-traceparent");
    try {
      await withLaunchEnv(fixture, {}, async () => {
        const result = await startFactory(["build detached telemetry"], { cwd: fixture.repo, detached: true, traceparent, tracestate: "vendor=value" });
        assert.equal(result.status, "started");
        await waitForFile(fixture.captureFile);
      });

      const launched = readJson(fixture.captureFile);
      assert.equal(launched.env.TRACEPARENT, traceparent);
      assert.equal(launched.env.TRACESTATE, "vendor=value");
      assert.equal(launched.env.FEATURE_FACTORY_TRACEPARENT, traceparent);
      assert.equal(launched.env.FEATURE_FACTORY_TRACESTATE, "vendor=value");
      assert.equal(launched.env.FEATURE_FACTORY_PARENT_SPAN_ID, "00f067aa0ba902b7");
    } finally {
      cleanup(fixture.root);
    }
  });

  it("propagates a validated parent span id into foreground start", async () => {
    const fixture = createLaunchFixture("start-parent-span");
    try {
      await withLaunchEnv(fixture, {}, async () => {
        await startFactory(["build parent span telemetry"], { cwd: fixture.repo, parentSpanId: "00F067AA0BA902B7" });
      });

      const launched = readJson(fixture.captureFile);
      assert.equal(launched.env.FEATURE_FACTORY_PARENT_SPAN_ID, "00f067aa0ba902b7");
      assert.equal(launched.env.TRACEPARENT, undefined);
      assert.equal(launched.env.FEATURE_FACTORY_TRACEPARENT, undefined);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("propagates a validated parent span id into foreground resume", async () => {
    const fixture = createResumeLaunchFixture("resume-parent-span");
    try {
      await withLaunchEnv(fixture, {}, async () => {
        await resumeFactory(fixture.runId, { cwd: fixture.repo, parentSpanId: "00F067AA0BA902B7" });
      });

      const launched = readJson(fixture.captureFile);
      assert.equal(launched.env.FEATURE_FACTORY_PARENT_SPAN_ID, "00f067aa0ba902b7");
      assert.equal(launched.env.TRACEPARENT, undefined);
      assert.equal(launched.env.FEATURE_FACTORY_TRACEPARENT, undefined);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("propagates validated trace context into detached continue without putting it in the continuation payload", async () => {
    const fixture = createContinueLaunchFixture("continue-traceparent");
    try {
      await withLaunchEnv(fixture, {}, async () => {
        const result = continueFactory(fixture.runId, {
          cwd: fixture.repo,
          review: "reviewer.json",
          runId: "continue-traceparent-next",
          detached: true,
          traceparent,
        });
        assert.equal(result.status, "started");
        await waitForFile(fixture.captureFile);
      });

      const launched = readJson(fixture.captureFile);
      assert.equal(launched.env.TRACEPARENT, traceparent);
      assert.equal(launched.env.FEATURE_FACTORY_TRACEPARENT, traceparent);
      assert.equal(launched.env.FEATURE_FACTORY_PARENT_SPAN_ID, "00f067aa0ba902b7");
      const payload = JSON.parse(launched.argv.at(-1));
      assert.equal(JSON.stringify(payload).includes("TRACEPARENT"), false);
      assert.equal(JSON.stringify(payload).includes("4bf92f3577b34da6a3ce929d0e0e4736"), false);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("rejects invalid trace context before spawning or seeding start state", async () => {
    const fixture = createLaunchFixture("invalid-traceparent");
    try {
      await withLaunchEnv(fixture, {}, async () => {
        await assert.rejects(
          startFactory(["must not spawn"], { cwd: fixture.repo, traceparent: "not-a-traceparent" }),
          /invalid trace context: traceparent must match W3C format/u,
        );
      });

      assert.equal(existsSync(fixture.captureFile), false);
      assert.equal(existsSync(join(fixture.repo, ".opencode", "skills", "feature", "SKILL.md")), false);
    } finally {
      cleanup(fixture.root);
    }
  });
});

function createLaunchFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `factory-telemetry-${name}-`));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const captureFile = join(root, "launch.json");
  const bin = createFakeOpencode(root);
  return { root, repo, bin, captureFile };
}

function createResumeLaunchFixture(runId) {
  const fixture = createLaunchFixture(runId);
  const runDir = join(fixture.repo, ".opencode", "factory", runId);
  const worktree = join(fixture.repo, ".opencode", "worktrees", runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    status: "running",
    branch: runId,
    worktree,
    gates: {},
    slices: [{ id: "slice", status: "running", attempts: 1, branch: runId, worktree }],
  });
  return { ...fixture, runId, runDir, worktree };
}

function createContinueLaunchFixture(runId) {
  const fixture = createLaunchFixture(runId);
  initGitRepo(fixture.repo);
  runGit(fixture.repo, ["branch", runId]);
  const runDir = join(fixture.repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "story.md"), "story\n", "utf8");
  writeJson(join(runDir, "reviews", "reviewer.json"), { subject: runId, summary: "needs continuation" });
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    status: "blocked",
    branch: runId,
    worktree: join(fixture.repo, ".opencode", "worktrees", runId),
    validator: { verdict: "NO-GO", review_ref: "reviews/reviewer.json" },
    gates: {},
    terminal_result: { status: "blocked", run_id: runId, reason: "review blocked", summary: "blocked", artifacts: {} },
  });
  return { ...fixture, runId, runDir };
}

function createFakeOpencode(root) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const script = join(bin, "opencode");
  writeFileSync(script, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const keys = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "TRACEPARENT",
  "TRACESTATE",
  "FEATURE_FACTORY_TRACEPARENT",
  "FEATURE_FACTORY_TRACESTATE",
  "FEATURE_FACTORY_PARENT_SPAN_ID",
];
const env = Object.fromEntries(keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
writeFileSync(process.env.OPENCODE_CAPTURE_PATH, JSON.stringify({ argv: process.argv.slice(2), env }, null, 2) + "\\n", "utf8");
`, "utf8");
  chmodSync(script, 0o755);
  return bin;
}

async function withLaunchEnv(fixture, env, fn) {
  const keys = new Set([
    "PATH",
    "OPENCODE_CAPTURE_PATH",
    ...Object.keys(env),
    "TRACEPARENT",
    "TRACESTATE",
    "FEATURE_FACTORY_TRACEPARENT",
    "FEATURE_FACTORY_TRACESTATE",
    "FEATURE_FACTORY_PARENT_SPAN_ID",
  ]);
  const previous = new Map([...keys].map((key) => [key, process.env[key]]));
  try {
    for (const key of ["TRACEPARENT", "TRACESTATE", "FEATURE_FACTORY_TRACEPARENT", "FEATURE_FACTORY_TRACESTATE", "FEATURE_FACTORY_PARENT_SPAN_ID"]) {
      delete process.env[key];
    }
    process.env.PATH = `${fixture.bin}:${process.env.PATH}`;
    process.env.OPENCODE_CAPTURE_PATH = fixture.captureFile;
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    return await fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function waitForFile(file) {
  const deadline = Date.now() + 3000;
  while (Date.now() <= deadline) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${file}`);
}

function initGitRepo(repo) {
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "test@example.com"]);
  runGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "test\n", "utf8");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "init"]);
}

function runGit(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}
