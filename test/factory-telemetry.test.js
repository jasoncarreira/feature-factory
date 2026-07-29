import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "./helpers/git-fixture.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupRun, continueFactory, resumeFactory, startFactory, stopHeartbeat, validateState } from "../src/factory.js";
import { decodeFeatureCommandPayload, encodeFeatureCommandPayload } from "../src/feature-command-payload.js";
import { withDeliveryEnvelope } from "./helpers/delivery-envelope-fixture.js";
import { createReviewRecord } from "./helpers/review-record-fixture.js";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const PACKAGE_CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

describe("factory trace-context propagation", () => {
  it("launches foreground start without adding trace env by default while preserving operator OTEL env", async () => {
    const fixture = createLaunchFixture("start-no-default-env");
    try {
      await withLaunchEnv(fixture, { OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.honeycomb.io" }, async () => {
        await startFactory(["build telemetry"], { cwd: fixture.repo, runId: "start-no-default-env" });
      });

      const launched = readJson(fixture.captureFile);
      assert.equal(launched.env.OTEL_EXPORTER_OTLP_ENDPOINT, "https://api.honeycomb.io");
      assert.equal(launched.env.TRACEPARENT, undefined);
      assert.equal(launched.env.TRACESTATE, undefined);
      assert.equal(launched.env.FEATURE_FACTORY_TRACEPARENT, undefined);
      assert.equal(launched.env.FEATURE_FACTORY_TRACESTATE, undefined);
      assert.equal(launched.env.FEATURE_FACTORY_PARENT_SPAN_ID, undefined);
      assert.equal(launched.env.FEATURE_FACTORY_RUN_ID, "start-no-default-env");
    } finally {
      cleanup(fixture.root);
    }
  });

  it("propagates validated traceparent and tracestate into detached start", async () => {
    const fixture = createLaunchFixture("start-detached-traceparent");
    let detachedPid;
    try {
      await withLaunchEnv(fixture, { OPENCODE_KEEPALIVE: "1" }, async () => {
        const result = await startFactory(["build detached telemetry"], { cwd: fixture.repo, runId: "start-detached-traceparent", detached: true, traceparent, tracestate: "vendor=value" });
        assert.equal(result.status, "started");
        detachedPid = result.pid;
        await waitForFile(fixture.captureFile);
      });

      const launched = readJson(fixture.captureFile);
      assert.equal(launched.env.TRACEPARENT, traceparent);
      assert.equal(launched.env.TRACESTATE, "vendor=value");
      assert.equal(launched.env.FEATURE_FACTORY_TRACEPARENT, traceparent);
      assert.equal(launched.env.FEATURE_FACTORY_TRACESTATE, "vendor=value");
      assert.equal(launched.env.FEATURE_FACTORY_PARENT_SPAN_ID, "00f067aa0ba902b7");
      assert.equal(launched.env.FEATURE_FACTORY_RUN_ID, "start-detached-traceparent");
      process.kill(detachedPid, "SIGTERM");
      await waitForProcessExit(detachedPid);
      detachedPid = null;
    } finally {
      if (detachedPid) {
        try { process.kill(detachedPid, "SIGTERM"); } catch { /* already exited */ }
        try { await waitForProcessExit(detachedPid); } catch { /* best-effort cleanup */ }
      }
      cleanup(fixture.root);
    }
  });

  it("propagates a validated parent span id into foreground start", async () => {
    const fixture = createLaunchFixture("start-parent-span");
    try {
      await withLaunchEnv(fixture, {}, async () => {
        await startFactory(["build parent span telemetry"], { cwd: fixture.repo, runId: "start-parent-span", parentSpanId: "00F067AA0BA902B7" });
      });

      const launched = readJson(fixture.captureFile);
      assert.equal(launched.env.FEATURE_FACTORY_PARENT_SPAN_ID, "00f067aa0ba902b7");
      assert.equal(launched.env.FEATURE_FACTORY_RUN_ID, "start-parent-span");
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
      assert.equal(launched.env.FEATURE_FACTORY_RUN_ID, fixture.runId);
      assert.equal(launched.env.TRACEPARENT, undefined);
      assert.equal(launched.env.FEATURE_FACTORY_TRACEPARENT, undefined);
      const decoded = decodeFeatureCommandPayload(launched.argv.at(-1), { repo: fixture.repo });
      assert.equal(decoded.ok, true, JSON.stringify(decoded));
      assert.equal(decoded.payload.resume.run_id, fixture.runId);
      assert.equal(decoded.payload.resume.schema_version, 1);
      assert.equal(decoded.payload.driver.mode, "interactive");
      const upgraded = structuredClone(decoded.payload);
      upgraded.resume.schema_version = 2;
      assert.deepEqual(decodeFeatureCommandPayload(encodeFeatureCommandPayload(upgraded), { repo: fixture.repo }), { ok: false, reason: "unpublished-or-mismatched-carry-forward-resume" });
    } finally {
      cleanup(fixture.root);
    }
  });

  it("propagates the checked run identity through factory start resume", async () => {
    const fixture = createResumeLaunchFixture("start-resume-run-id");
    try {
      await withLaunchEnv(fixture, { FEATURE_FACTORY_RUN_ID: "stale-inherited-run" }, async () => {
        await startFactory(["resume", fixture.runId], {
          cwd: fixture.repo,
          recoverDisruptedRunFn: async () => ({ ok: true, run_dir: fixture.runDir, run_file: join(fixture.runDir, "run.json") }),
        });
      });

      const launched = readJson(fixture.captureFile);
      assert.equal(launched.env.FEATURE_FACTORY_RUN_ID, fixture.runId);
      const decoded = decodeFeatureCommandPayload(launched.argv.at(-1), { repo: fixture.repo });
      assert.equal(decoded.ok, true, JSON.stringify(decoded));
      assert.equal(decoded.payload.resume.run_id, fixture.runId);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("clears an inherited run identity for an unnamed new start", async () => {
    const fixture = createLaunchFixture("start-clears-stale-run-id");
    try {
      await withLaunchEnv(fixture, { FEATURE_FACTORY_RUN_ID: "stale-inherited-run" }, async () => {
        await startFactory(["build unnamed telemetry"], { cwd: fixture.repo });
      });

      assert.equal(readJson(fixture.captureFile).env.FEATURE_FACTORY_RUN_ID, undefined);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("propagates validated trace context into detached continue without putting it in the continuation payload", async () => {
    const fixture = createContinueLaunchFixture("continue-traceparent");
    let detachedPid;
    try {
      await withLaunchEnv(fixture, { OPENCODE_KEEPALIVE: "1" }, async () => {
        const result = await continueFactory(fixture.runId, {
          cwd: fixture.repo,
          review: "work-decomposer.json",
          runId: "continue-traceparent-next",
          carryForward: true,
          detached: true,
          traceparent,
        });
        assert.equal(result.status, "started");
        detachedPid = result.pid;
        await waitForFile(fixture.captureFile);
      });

      const launched = readJson(fixture.captureFile);
      assert.equal(launched.env.TRACEPARENT, traceparent);
      assert.equal(launched.env.FEATURE_FACTORY_TRACEPARENT, traceparent);
      assert.equal(launched.env.FEATURE_FACTORY_PARENT_SPAN_ID, "00f067aa0ba902b7");
      assert.equal(launched.env.FEATURE_FACTORY_RUN_ID, "continue-traceparent-next");
      const launchedRepo = launched.argv[launched.argv.indexOf("--dir") + 1];
      const decoded = decodeFeatureCommandPayload(launched.argv.at(-1), { repo: launchedRepo });
      assert.equal(decoded.ok, true, JSON.stringify(decoded));
      const payload = decoded.payload;
      assert.equal(JSON.stringify(payload).includes("TRACEPARENT"), false);
      assert.equal(JSON.stringify(payload).includes("4bf92f3577b34da6a3ce929d0e0e4736"), false);
      process.kill(detachedPid, "SIGTERM");
      await waitForProcessExit(detachedPid);
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

describe("B6.2 factory lifecycle spans", () => {
  it("attaches a requested new-run identity only after successful durable observation", async () => {
    const fixture = createLaunchFixture("start-b6-span");
    const fake = fakeB6Otel();
    try {
      await withLaunchEnv(fixture, { OPENCODE_CREATE_RUN_ID: "checked-run" }, () => startFactory(["hostile prompt github_pat_123456789012345678901234567890"], {
        cwd: fixture.repo, runId: "checked-run", traceparent, telemetry: { enabled: true, importer: fake.importer },
      }));
      await flushB6Telemetry();

      assert.equal(fake.spans.length, 1);
      assert.deepEqual(fake.spans[0].attributes, {
        "feature_factory.mode": "interactive",
        "gen_ai.agent.name": "feature-factory",
        "gen_ai.operation.name": "invoke_agent",
        "feature_factory.run_id": "checked-run",
        "gen_ai.conversation.id": "checked-run",
      });
      assert.equal(fake.spans[0].name, "feature_factory.factory.start");
      assert.equal(fake.spans[0].context, fake.activeContext);
      assert.equal(fake.spans[0].ended, true);
      assert.doesNotMatch(JSON.stringify(fake.spans), /hostile prompt|github_pat|traceparent|00f067|repo|path|url|pid/u);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("uses the observed durable terminal outcome when foreground execution returns no result", async () => {
    const fixture = createLaunchFixture("start-b6-terminal-status");
    const fake = fakeB6Otel();
    try {
      await withLaunchEnv(fixture, {
        OPENCODE_CREATE_RUN_ID: "checked-blocked-run",
        OPENCODE_CREATE_RUN_STATUS: "blocked",
      }, () => startFactory(["blocked foreground run"], {
        cwd: fixture.repo,
        runId: "checked-blocked-run",
        telemetry: { enabled: true, importer: fake.importer },
      }));
      await flushB6Telemetry();

      assert.equal(fake.spans[0].attributes["feature_factory.run_id"], "checked-blocked-run");
      assert.equal(fake.spans[0].attributes["feature_factory.status"], "blocked");
      assert.equal(fake.spans[0].ended, true);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("does not claim requested or allocated new-run identity before durable creation, including failures", async () => {
    const requested = createLaunchFixture("requested-failure");
    const allocated = createLaunchFixture("allocated-detached");
    const fake = fakeB6Otel();
    let detachedPid;
    try {
      await assert.rejects(startFactory(["failed"], {
        cwd: requested.repo,
        runId: "requested-but-unproven",
        traceparent: "invalid",
        telemetry: { enabled: true, importer: fake.importer },
      }), /invalid trace context/u);
      await withLaunchEnv(allocated, { OPENCODE_KEEPALIVE: "1" }, async () => {
        const result = await startFactory(["allocated"], {
          cwd: allocated.repo,
          detached: true,
          createRunId: () => "allocated-before-creation",
          telemetry: { enabled: true, importer: fake.importer },
        });
        detachedPid = result.pid;
      });
      await flushB6Telemetry();
      assert.equal(fake.spans.length, 2);
      assert.equal(fake.spans.every((span) => span.attributes["feature_factory.run_id"] === undefined), true);
      assert.equal(fake.spans[0].attributes["error.type"], "workflow_error");
      assert.deepEqual(fake.spans[0].exceptions, []);
      assert.doesNotMatch(JSON.stringify(fake.spans), /requested-but-unproven|allocated-before-creation|prompt output|private|refs\/heads|user:pass|TRACEPARENT/u);
    } finally {
      if (detachedPid) {
        try { process.kill(detachedPid, "SIGTERM"); } catch { /* already exited */ }
        try { await waitForProcessExit(detachedPid); } catch { /* best-effort cleanup */ }
      }
      cleanup(requested.root);
      cleanup(allocated.root);
    }
  });

  it("attaches continuation identity only after successful checked durable child publication", async () => {
    const dry = createContinueLaunchFixture("continue-dry-parent");
    const failed = createContinueLaunchFixture("continue-failed-parent");
    const success = createContinueLaunchFixture("continue-success-parent");
    const fake = fakeB6Otel();
    try {
      const dryResult = continueFactory(dry.runId, {
        cwd: dry.repo, review: "work-decomposer.json", runId: "dry-child", carryForward: true, dryRun: true,
        telemetry: { enabled: true, importer: fake.importer },
      });
      assert.equal(dryResult.status, "dry-run");
      await assert.rejects(continueFactory(failed.runId, {
        cwd: failed.repo, review: "work-decomposer.json", runId: "failed-child", carryForward: true,
        traceparent: "invalid",
        telemetry: { enabled: true, importer: fake.importer },
      }), /invalid trace context/u);
      assert.throws(() => continueFactory("missing-carry-parent", {
        cwd: failed.repo, carryForward: true,
        telemetry: { enabled: true, importer: fake.importer },
      }));
      const continued = await withLaunchEnv(success, {
        OPENCODE_CREATE_RUN_ID: "durable-child",
      }, () => continueFactory(success.runId, {
        cwd: success.repo, review: "work-decomposer.json", runId: "durable-child", carryForward: true, telemetry: { enabled: true, importer: fake.importer },
      }));
      assert.equal(continued, undefined);
      await flushB6Telemetry();
      const spans = fake.spans.filter((span) => span.name === "feature_factory.factory.continue");
      assert.equal(spans.length, 4);
      assert.deepEqual(spans.map((span) => span.attributes["feature_factory.continuation_kind"]), [
        "full-plan-carry-forward",
        "full-plan-carry-forward",
        "full-plan-carry-forward",
        "full-plan-carry-forward",
      ]);
      assert.equal(spans[0].attributes["feature_factory.run_id"], undefined);
      assert.equal(spans[1].attributes["feature_factory.run_id"], undefined);
      assert.equal(spans[2].attributes["feature_factory.run_id"], undefined);
      assert.equal(spans[3].attributes["feature_factory.run_id"], "durable-child");
      assert.equal(spans[3].attributes["gen_ai.conversation.id"], "durable-child");
    } finally {
      cleanup(dry.root);
      cleanup(failed.root);
      cleanup(success.root);
    }
  });

  it("attaches checked existing identity for direct resume and start-resume", async () => {
    const direct = createResumeLaunchFixture("direct-resume-run");
    const startResume = createResumeLaunchFixture("start-resume-run");
    const fake = fakeB6Otel();
    try {
      const resumed = await withLaunchEnv(direct, {}, () => resumeFactory(direct.runId, {
        cwd: direct.repo,
        telemetry: { enabled: true, importer: fake.importer },
      }));
      assert.equal(resumed, undefined);
      const startResumed = await withLaunchEnv(startResume, {}, () => startFactory(["resume", startResume.runId], {
        cwd: startResume.repo,
        telemetry: { enabled: true, importer: fake.importer },
      }));
      assert.equal(startResumed.run_id, startResume.runId);
      assert.equal(startResumed.status, "blocked");
      await flushB6Telemetry();

      const resumeSpan = fake.spans.find((span) => span.name === "feature_factory.factory.resume");
      const startSpan = fake.spans.find((span) => span.name === "feature_factory.factory.start");
      assert.equal(resumeSpan.attributes["feature_factory.run_id"], direct.runId);
      assert.equal(startSpan.attributes["feature_factory.run_id"], startResume.runId);
      assert.equal(resumeSpan.ended && startSpan.ended, true);
    } finally {
      cleanup(direct.root);
      cleanup(startResume.root);
    }
  });

  it("does not emit by default and isolates lifecycle telemetry failures", async () => {
    const disabled = createLaunchFixture("disabled-b6-span");
    const broken = createLaunchFixture("broken-b6-span");
    const fake = fakeB6Otel();
    try {
      const disabledResult = await withLaunchEnv(disabled, {}, () => startFactory(["disabled"], {
        cwd: disabled.repo,
        telemetry: { importer: fake.importer },
      }));
      const brokenResult = await withLaunchEnv(broken, {}, () => startFactory(["broken telemetry"], {
        cwd: broken.repo,
        telemetry: { enabled: true, importer: async () => { throw new Error("telemetry-only failure"); } },
      }));
      assert.equal(disabledResult, undefined);
      assert.equal(brokenResult, undefined);
      await flushB6Telemetry();
      assert.equal(fake.spans.length, 0);
    } finally {
      cleanup(disabled.root);
      cleanup(broken.root);
    }
  });
});

function createLaunchFixture(name) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `factory-telemetry-${name}-`)));
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
    slices: [{ id: "slice", declared_paths: ["slice.txt"], effective_paths: ["slice.txt"], status: "running", attempts: 1, branch: runId, worktree }],
  });
  return { ...fixture, runId, runDir, worktree };
}

function createContinueLaunchFixture(runId) {
  const fixture = createLaunchFixture(runId);
  initGitRepo(fixture.repo);
  const origin = join(fixture.root, "origin.git");
  runGit(fixture.repo, ["init", "--bare", origin]);
  runGit(fixture.repo, ["remote", "add", "origin", origin]);
  runGit(fixture.repo, ["push", "-u", "origin", "main"]);
  const baseCommit = gitOutput(fixture.repo, ["rev-parse", "HEAD"]);
  runGit(fixture.repo, ["checkout", "-b", runId]);
  const runDir = join(fixture.repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  mkdirSync(join(runDir, "plan"), { recursive: true });
  writeFileSync(join(runDir, "artifacts", "story.md"), "story\n", "utf8");
  writeFileSync(join(runDir, "artifacts", "research-map.md"), "research\n", "utf8");
  writeFileSync(join(runDir, "artifacts", "design-brief.md"), "design\n", "utf8");
  writeFileSync(join(runDir, "artifacts", "technical-brief.md"), "accepted brief\n", "utf8");
  writeJson(join(runDir, "reviews", "spec-writer.json"), createReviewRecord({
    subject: "spec-writer", verdict: "APPROVE", required_fixes: [], summary: "accepted planning",
  }));
  writeJson(join(runDir, "reviews", "work-decomposer.json"), createReviewRecord({
    subject: "work-decomposer", verdict: "APPROVE", required_fixes: [], summary: "accepted decomposition",
  }));
  const plan = withDeliveryEnvelope({
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: [{ id: "slice", stack: "backend", paths: ["slice.txt"], depends_on: [], acceptance: ["accepted"], test_plan: ["test slice"] }],
  });
  writeJson(join(runDir, "plan", "slices.json"), plan);
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    status: "blocked",
    base_ref: "main",
    base_commit: baseCommit,
    branch: runId,
    worktree: fixture.repo,
    gates: {},
    slices: [{ id: "slice", stack: "backend", depends_on: [], declared_paths: ["slice.txt"], effective_paths: ["slice.txt"], status: "pending", attempts: 0 }],
    steps: [
      {
        agent: "spec-writer", status: "accepted", attempts: 1, artifact_ref: "artifacts/technical-brief.md", review_ref: "reviews/spec-writer.json",
        acceptance: {
          artifact_ref: "artifacts/technical-brief.md", artifact_hash: fileHash(join(runDir, "artifacts", "technical-brief.md")),
          review_ref: "reviews/spec-writer.json", review_hash: fileHash(join(runDir, "reviews", "spec-writer.json")),
        },
      },
      {
        agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
        acceptance: {
          artifact_ref: "plan/slices.json", artifact_hash: fileHash(join(runDir, "plan", "slices.json")),
          review_ref: "reviews/work-decomposer.json", review_hash: fileHash(join(runDir, "reviews", "work-decomposer.json")),
        },
      },
    ],
    terminal_result: { status: "blocked", run_id: runId, reason: "carry-forward-required", summary: "blocked", artifacts: {} },
  });
  return { ...fixture, runId, runDir };
}

function createFakeOpencode(root) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const script = join(bin, "opencode");
  writeFileSync(script, `#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv[2] === "--version") { console.log("opencode-test 1"); process.exit(0); }
const keys = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "TRACEPARENT",
  "TRACESTATE",
  "FEATURE_FACTORY_TRACEPARENT",
  "FEATURE_FACTORY_TRACESTATE",
  "FEATURE_FACTORY_PARENT_SPAN_ID",
  "FEATURE_FACTORY_RUN_ID",
];
const env = Object.fromEntries(keys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
writeFileSync(process.env.OPENCODE_CAPTURE_PATH, JSON.stringify({ argv: process.argv.slice(2), env }, null, 2) + "\\n", "utf8");
if (process.env.OPENCODE_CREATE_RUN_ID) {
  const repo = process.argv[process.argv.indexOf("--dir") + 1];
  const runId = process.env.OPENCODE_CREATE_RUN_ID;
  const runDir = join(repo, ".opencode", "factory", runId);
  const worktree = join(repo, ".opencode", "worktrees", runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const rawPayload = process.argv.at(-1);
  const payload = rawPayload?.startsWith("ffpayload-v1:") ? JSON.parse(Buffer.from(rawPayload.slice("ffpayload-v1:".length), "base64url").toString("utf8")) : null;
  const continuation = payload?.continuation;
  const status = process.env.OPENCODE_CREATE_RUN_STATUS || "running";
  const terminal = status === "blocked" ? { terminal_result: { status, run_id: runId, pr_url: null, reason: "test-blocked", summary: null, artifacts: {} } } : {};
  if (!existsSync(join(runDir, "run.json"))) {
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ schema_version: 1, run_id: runId, status, branch: runId, worktree, gates: {}, slices: [], ...(continuation ? { continuation } : {}), ...terminal }, null, 2) + "\\n", "utf8");
  }
}
if (process.env.OPENCODE_KEEPALIVE === "1") setInterval(() => {}, 1000);
`, "utf8");
  chmodSync(script, 0o755);
  symlinkSync(PACKAGE_CLI, join(bin, "feature-factory"));
  return bin;
}

async function withLaunchEnv(fixture, env, fn) {
  const keys = new Set([
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_CAPTURE_PATH",
    "OPENCODE_CREATE_RUN_ID",
    ...Object.keys(env),
    "TRACEPARENT",
    "TRACESTATE",
    "FEATURE_FACTORY_TRACEPARENT",
    "FEATURE_FACTORY_TRACESTATE",
    "FEATURE_FACTORY_PARENT_SPAN_ID",
    "FEATURE_FACTORY_RUN_ID",
  ]);
  const previous = new Map([...keys].map((key) => [key, process.env[key]]));
  try {
    for (const key of ["TRACEPARENT", "TRACESTATE", "FEATURE_FACTORY_TRACEPARENT", "FEATURE_FACTORY_TRACESTATE", "FEATURE_FACTORY_PARENT_SPAN_ID", "FEATURE_FACTORY_RUN_ID"]) {
      delete process.env[key];
    }
    process.env.PATH = `${fixture.bin}:${process.env.PATH}`;
    process.env.HOME = join(fixture.root, "home");
    process.env.XDG_CONFIG_HOME = join(fixture.root, "xdg");
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG;
    delete process.env.OPENCODE_CONFIG_CONTENT;
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

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() <= deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for detached process ${pid}`);
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

function gitOutput(repo, args) {
  const proc = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

function fileHash(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
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

function fakeB6Otel() {
  const spans = [];
  const activeContext = { trace: "factory-active-context" };
  const api = {
    context: { active: () => activeContext },
    trace: {
      getTracer: () => ({
        startActiveSpan(name, options, context, callback) {
          const span = {
            name,
            context,
            attributes: { ...(options?.attributes || {}) },
            exceptions: [],
            statuses: [],
            ended: false,
            setAttribute(key, value) { this.attributes[key] = value; },
            addEvent() {},
            recordException(error) { this.exceptions.push(error); },
            setStatus(status) { this.statuses.push(status); },
            end() { this.ended = true; },
          };
          spans.push(span);
          return callback(span);
        },
      }),
    },
  };
  return { spans, activeContext, importer: async () => api };
}

async function flushB6Telemetry() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

// SPEC section 14 taxonomy rows factory.validate / factory.cleanup / factory.gate /
// factory.heartbeat. These wrap calls that already existed, so every assertion here
// also checks the operation itself still behaves.
describe("factory operator span taxonomy", () => {
  it("reports validate run and error counts, and marks an invalid run as a span error", async () => {
    const fixture = createOperatorSpanFixture("validate");
    try {
      const healthy = fakeB6Otel();
      const ok = validateState(fixture.runId, { cwd: fixture.repo, telemetry: { enabled: true, importer: healthy.importer } });
      await flushB6Telemetry();

      assert.equal(ok.ok, true, "the wrapped operation must still return its result");
      const span = healthy.spans.find((item) => item.name === "feature_factory.factory.validate");
      assert.ok(span, `expected a validate span, saw ${JSON.stringify(healthy.spans.map((item) => item.name))}`);
      assert.equal(span.attributes["feature_factory.run_id"], fixture.runId);
      assert.equal(span.attributes["feature_factory.status"], "completed");
      assert.equal(span.attributes["feature_factory.run_count"], 1);
      assert.equal(span.attributes["feature_factory.error_count"], 0);
      assert.equal(span.ended, true);
      assert.deepEqual(span.statuses, [], "a passing validation must not set an error status");

      // Authority/validation failures must surface as span errors for Agent
      // Timeline failure filtering, not merely as a status attribute.
      writeJson(join(fixture.runDir, "run.json"), { schema_version: 1, run_id: fixture.runId, status: "not-a-status" });
      const broken = fakeB6Otel();
      const failed = validateState(fixture.runId, { cwd: fixture.repo, telemetry: { enabled: true, importer: broken.importer } });
      await flushB6Telemetry();

      assert.equal(failed.ok, false);
      const failedSpan = broken.spans.find((item) => item.name === "feature_factory.factory.validate");
      assert.equal(failedSpan.attributes["feature_factory.status"], "failed");
      assert.equal(failedSpan.attributes["feature_factory.error_count"], 1);
      assert.ok(failedSpan.statuses.length > 0, "an invalid run must set an error status on the span");
    } finally {
      cleanup(fixture.root);
    }
  });

  it("carries the bounded heartbeat operation and phase", async () => {
    const fixture = createOperatorSpanFixture("heartbeat");
    try {
      const fake = fakeB6Otel();
      // No heartbeat file exists, so the operation is a no-op that still traces.
      await stopHeartbeat(fixture.runId, { phase: "builders" }, { cwd: fixture.repo, telemetry: { enabled: true, importer: fake.importer } });
      await flushB6Telemetry();

      const span = fake.spans.find((item) => item.name === "feature_factory.factory.heartbeat");
      assert.ok(span);
      assert.equal(span.attributes["feature_factory.heartbeat_operation"], "stop");
      assert.equal(span.attributes["feature_factory.heartbeat_phase"], "builders");
      assert.equal(span.attributes["feature_factory.run_id"], fixture.runId);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("emits nothing when telemetry is disabled and never fails the operation when telemetry breaks", async () => {
    const fixture = createOperatorSpanFixture("isolation");
    try {
      const disabled = fakeB6Otel();
      const quiet = validateState(fixture.runId, { cwd: fixture.repo, telemetry: { importer: disabled.importer } });
      await flushB6Telemetry();
      assert.equal(quiet.ok, true);
      assert.deepEqual(disabled.spans, [], "telemetry is opt-in; no span may be produced when it is not enabled");

      // An exporter that throws is a telemetry problem, never the caller's.
      const result = validateState(fixture.runId, {
        cwd: fixture.repo,
        telemetry: { enabled: true, importer: async () => { throw new Error("telemetry-only failure"); } },
      });
      await flushB6Telemetry();
      assert.equal(result.ok, true);
    } finally {
      cleanup(fixture.root);
    }
  });

  it("traces a cleanup with coarse totals and propagates its failure", async () => {
    const fixture = createOperatorSpanFixture("cleanup");
    try {
      const fake = fakeB6Otel();
      // A running run is not cleanup-eligible, so this rejects. The span must
      // record the failure rather than swallow it.
      await assert.rejects(() => cleanupRun(fixture.runId, { cwd: fixture.repo, telemetry: { enabled: true, importer: fake.importer } }));
      await flushB6Telemetry();

      const span = fake.spans.find((item) => item.name === "feature_factory.factory.cleanup");
      assert.ok(span, `expected a cleanup span, saw ${JSON.stringify(fake.spans.map((item) => item.name))}`);
      assert.equal(span.attributes["feature_factory.status"], "failed");
      assert.ok(span.statuses.length > 0);
      // Never per-entry paths or branch names.
      assert.ok(!Object.keys(span.attributes).some((key) => /path|branch|worktree/u.test(key)));
    } finally {
      cleanup(fixture.root);
    }
  });
});

function createOperatorSpanFixture(name) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `factory-operator-span-${name}-`)));
  const repo = join(root, "repo");
  mkdirSync(repo);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  // Deliberately short: `feature_factory.run_id` passes through as-is unless it
  // looks like a secret, and a longer slug trips the high-entropy pseudonymizer,
  // which would test the identifier hashing rather than these spans.
  const runId = `op-${name}`;
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    mode: "interactive",
    status: "running",
    created_at: "2026-07-29T00:00:00.000Z",
    updated_at: "2026-07-29T00:00:00.000Z",
  });
  return { root, repo, runId, runDir };
}
