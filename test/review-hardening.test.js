import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { transitionRunSlice, transitionSteeringQueued, transitionSteeringConsumed } from "../src/run-state.js";
import { normalizeCostAttribution } from "../src/cost-attribution.js";
import { runAttributes, sanitizeOtlpEnv, validateTracestate } from "../src/telemetry.js";
import { collectProtectedSteeringState } from "../src/steering-conflicts.js";
import { cancelFactoryRun, cleanupRun, continueFactory, recordCostUsage, startFactory } from "../src/factory.js";

const NOW = "2026-07-09T15:00:00.000Z";

describe("steering consume crash recovery", () => {
  it("finishes an interrupted consume whose pending file was already renamed", async () => {
    const runDir = createRunDir("steer-crash");
    try {
      await transitionSteeringQueued(runDir, "resume after the crash", { now: NOW });
      const run = readJson(join(runDir, "run.json"));
      const pending = run.steering.pending;

      // Simulate a crash between the consume's rename and its run.json write:
      // the file sits at a consumed path while run.json still says pending.
      const consumedName = basename(pending.ref).replace(/^pending-/u, "consumed-");
      renameSync(join(runDir, pending.ref), join(runDir, "steering", consumedName));

      const consumed = await transitionSteeringConsumed(runDir, { ref: pending.ref, hash: pending.hash }, { now: NOW });

      assert.equal(consumed.steering.message, "resume after the crash");
      assert.equal(consumed.steering.trust, "untrusted-operator-data");
      assert.equal(consumed.steering.ref, `steering/${consumedName}`);
      const after = readJson(join(runDir, "run.json"));
      assert.equal(after.steering.pending, null);
      assert.equal(after.steering.history.at(-1).event, "consumed");
      assert.equal(after.steering.history.at(-1).ref, `steering/${consumedName}`);
    } finally {
      cleanupDir(runDir);
    }
  });
});

describe("slice merge transition guard", () => {
  it("rejects direct status merged writes through transitionRunSlice", async () => {
    const runDir = createRunDir("slice-merged-guard", {
      slices: [{ id: "s1", status: "running", attempts: 0 }],
    });
    try {
      await assert.rejects(
        transitionRunSlice(runDir, "s1", { status: "merged", merge_commit: "abc1234" }),
        /merges must use transitionSliceMerged/u,
      );
      assert.equal(readJson(join(runDir, "run.json")).slices[0].status, "running");
    } finally {
      cleanupDir(runDir);
    }
  });

  it("refuses to roll a merged slice back to running/review/blocked via transitionRunSlice", async () => {
    const runDir = createRunDir("slice-merged-immutable", {
      slices: [{ id: "s1", status: "merged", merge_commit: "abc1234", review_ref: "reviews/s1.json", evidence_ref: "evidence/s1.json", attempts: 1 }],
    });
    try {
      for (const status of ["running", "review", "blocked"]) {
        await assert.rejects(
          transitionRunSlice(runDir, "s1", { status }, { mustExist: true }),
          /already merged; merged slices are immutable/u,
          `status=${status}`,
        );
      }
      assert.equal(readJson(join(runDir, "run.json")).slices[0].status, "merged");
    } finally {
      cleanupDir(runDir);
    }
  });
});

describe("cost attribution hardening", () => {
  const base = { run_id: "run-1", agent: "backend-builder" };

  it("treats an identical duplicate entry id as an idempotent no-op", () => {
    const entry = { ...base, id: "e1", recorded_at: NOW, cost_total: 0.5, cost_currency: "USD" };
    const result = normalizeCostAttribution({ entries: [entry, { ...entry }] }, { now: NOW });
    assert.equal(result.entries.length, 1);
    assert.equal(result.totals.cost_total, 0.5);
  });

  it("rejects reusing an entry id with different content", () => {
    const entry = { ...base, id: "e1", recorded_at: NOW, cost_total: 0.5, cost_currency: "USD" };
    assert.throws(
      () => normalizeCostAttribution({ entries: [entry, { ...entry, cost_total: 0.75 }] }, { now: NOW }),
      /already recorded with different content/u,
    );
  });

  it("flags mixed currencies even when they appear in different cost fields", () => {
    const result = normalizeCostAttribution({
      entries: [
        { ...base, id: "e1", recorded_at: NOW, cost_total: 1, cost_currency: "USD" },
        { ...base, id: "e2", recorded_at: NOW, cost_input: 2, cost_currency: "EUR" },
      ],
    }, { now: NOW });
    assert.equal(result.totals.mixed_currency, true);
    assert.equal(result.totals.cost_total, undefined);
    assert.equal(result.totals.cost_currency, undefined);
    assert.ok(result.totals.missing.includes("mixed_currency"));
  });

  it("rejects terminal control characters in provider metadata strings", () => {
    assert.throws(
      () => normalizeCostAttribution({
        entries: [{ ...base, id: "e1", recorded_at: NOW, model: "gpt]0;pwned", cost_total: 1, cost_currency: "USD" }],
      }, { now: NOW }),
      /model must not contain terminal control characters/u,
    );
  });

  it("is idempotent for a retry that omits recorded_at, even at a later time", () => {
    // Reviewer's repro: record {id:'retry', agent, input_tokens:1} at T1, then
    // append the same object at T2 with no --recorded-at. The stored entry keeps
    // its original timestamp; the retry must not be treated as different content.
    const entry = { ...base, id: "retry", input_tokens: 1 };
    const first = normalizeCostAttribution({ entries: [entry] }, { now: "2026-07-10T00:00:00.000Z" });
    const retried = normalizeCostAttribution({ entries: [...first.entries, { ...entry }] }, { now: "2026-07-10T01:00:00.000Z" });
    assert.equal(retried.entries.length, 1);
    assert.equal(retried.entries[0].recorded_at, first.entries[0].recorded_at);
  });

  it("dedupes before the entry cap so an identical retry at capacity is a no-op", () => {
    const entries = [];
    for (let i = 0; i < 1000; i += 1) entries.push({ ...base, id: `e${i}`, recorded_at: NOW, input_tokens: 1 });
    const atCap = normalizeCostAttribution({ entries: [...entries, { ...entries[0] }] }, { now: NOW });
    assert.equal(atCap.entries.length, 1000);
    assert.throws(
      () => normalizeCostAttribution({ entries: [...entries, { ...base, id: "e1000", recorded_at: NOW, input_tokens: 1 }] }, { now: NOW }),
      /at most 1000 entries/u,
    );
  });

  it("is idempotent through recordCostUsage (the cost-record CLI path) with no --recorded-at", async () => {
    const runDir = createRunDir("cost-record-retry");
    const repo = join(runDir, "..", "..", "..");
    try {
      await recordCostUsage("cost-record-retry", { agent: "a", input_tokens: 1 }, { cwd: repo, entryId: "retry", now: "2026-07-10T00:00:00.000Z" });
      await recordCostUsage("cost-record-retry", { agent: "a", input_tokens: 1 }, { cwd: repo, entryId: "retry", now: "2026-07-10T01:00:00.000Z" });
      const run = readJson(join(runDir, "run.json"));
      assert.equal(run.cost_attribution.entries.length, 1);
      assert.equal(run.cost_attribution.entries[0].id, "retry");
    } finally {
      cleanupDir(runDir);
    }
  });
});

describe("telemetry hardening", () => {
  it("rejects tracestate values beyond the W3C 512-character cap", () => {
    const result = validateTracestate(`vendor=${"x".repeat(510)}`);
    assert.equal(result.ok, false);
    assert.match(result.error, /512/u);
    assert.equal(validateTracestate("vendor=value").ok, true);
  });

  it("coerces mixed-type attribute arrays to a JSON string", () => {
    const attrs = runAttributes({ tags: [1, "two", true], counts: [1, 2, 3] });
    assert.equal(typeof attrs.tags, "string");
    assert.deepEqual(JSON.parse(attrs.tags), [1, "two", true]);
    assert.deepEqual(attrs.counts, [1, 2, 3]);
  });

  it("applies header redaction to multi-segment OTLP headers variables", () => {
    const safe = sanitizeOtlpEnv({ OTEL_EXPORTER_OTLP_FOO_BAR_HEADERS: "authorization=Bearer sk-abcdef1234567890" });
    const value = safe.OTEL_EXPORTER_OTLP_FOO_BAR_HEADERS;
    assert.ok(Array.isArray(value), "multi-segment headers var must use the per-header sanitizer");
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes("sk-abcdef1234567890"), false);
    assert.match(serialized, /redacted/iu);
  });
});

describe("steering conflict protected state", () => {
  it("treats stopped gates and in-review slices as protected durable state", () => {
    const protectedState = collectProtectedSteeringState(null, {
      gates: { pre_pr: { status: "stopped" }, story: { status: "pending" } },
      steps: [],
      slices: [{ id: "s1", status: "review" }, { id: "s2", status: "pending" }],
    });
    assert.ok(protectedState.includes("gate:pre_pr"));
    assert.ok(protectedState.includes("slice:s1"));
    assert.equal(protectedState.includes("gate:story"), false);
    assert.equal(protectedState.includes("slice:s2"), false);
  });
});

describe("pre-manifest detached launch recovery", () => {
  it("cancels and cleans a run dir that has process evidence but no manifest", async () => {
    const repo = mkdtempSync(join(tmpdir(), "review-pre-manifest-"));
    const runId = "pre-manifest-run";
    const runDir = join(repo, ".opencode", "factory", runId);
    try {
      mkdirSync(join(runDir, "processes"), { recursive: true });
      writeFileSync(join(runDir, "processes", "opencode.log"), "started\n", "utf8");
      writeJson(join(runDir, "process.json"), {
        schema_version: 1,
        kind: "opencode-process",
        run_id: runId,
        execution_id: "exec-1",
        pid: 4242,
        started_at: NOW,
        updated_at: NOW,
        state: "running",
        cwd: repo,
        identity: { inspector: "test-inspector", start_marker: "start-1", command_name: "opencode" },
        log_ref: "processes/opencode.log",
        cancel: null,
      });

      await assert.rejects(cleanupRun(runId, { cwd: repo }), /run 'factory cancel/u);

      const cancelled = await cancelFactoryRun(runId, {
        cwd: repo,
        inspectorFn: () => ({ ok: false, inspector: "test-inspector", reason: "ESRCH: no such process" }),
        signalFn: () => {},
      });
      assert.equal(cancelled.ok, true);
      assert.equal(cancelled.status, "cancelled");

      const cleaned = await cleanupRun(runId, { cwd: repo });
      assert.equal(cleaned.status, "pre-manifest");
      assert.equal(cleaned.removed_run_dir, true);
      assert.equal(existsSync(runDir), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("continuation and named-start git preflight", () => {
  it("rejects a parent base_commit that no longer resolves", () => {
    const repo = mkdtempSync(join(tmpdir(), "review-continue-base-"));
    const runId = "blocked-parent";
    try {
      initGitRepo(repo);
      runGit(repo, ["branch", runId]);
      const runDir = join(repo, ".opencode", "factory", runId);
      mkdirSync(join(runDir, "artifacts"), { recursive: true });
      mkdirSync(join(runDir, "reviews"), { recursive: true });
      writeFileSync(join(runDir, "artifacts", "story.md"), "story\n", "utf8");
      writeJson(join(runDir, "reviews", "reviewer.json"), { subject: runId, summary: "needs continuation" });
      writeJson(join(runDir, "run.json"), {
        schema_version: 1,
        run_id: runId,
        status: "blocked",
        branch: runId,
        base_commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        worktree: join(repo, ".opencode", "worktrees", runId),
        validator: { verdict: "NO-GO", review_ref: "reviews/reviewer.json" },
        gates: {},
        terminal_result: { status: "blocked", run_id: runId, reason: "review blocked", summary: "blocked", artifacts: {} },
      });

      assert.throws(
        () => continueFactory(runId, { cwd: repo, review: "reviewer.json", runId: `${runId}-next`, dryRun: true }),
        /parent base commit/u,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects a parent base_commit that resolves but is not an ancestor of the parent branch", () => {
    const repo = mkdtempSync(join(tmpdir(), "review-continue-orphan-"));
    const runId = "orphan-base-parent";
    try {
      initGitRepo(repo);
      runGit(repo, ["branch", runId]);
      // A commit that exists but belongs to an unrelated orphan branch — it
      // resolves via rev-parse yet is not in the parent branch's history.
      runGit(repo, ["checkout", "--orphan", "unrelated"]);
      writeFileSync(join(repo, "other.txt"), "unrelated\n", "utf8");
      runGit(repo, ["add", "other.txt"]);
      runGit(repo, ["commit", "-m", "orphan"]);
      const orphanSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
      runGit(repo, ["checkout", "main"]);

      const runDir = join(repo, ".opencode", "factory", runId);
      mkdirSync(join(runDir, "artifacts"), { recursive: true });
      mkdirSync(join(runDir, "reviews"), { recursive: true });
      writeFileSync(join(runDir, "artifacts", "story.md"), "story\n", "utf8");
      writeJson(join(runDir, "reviews", "reviewer.json"), { subject: runId, summary: "needs continuation" });
      writeJson(join(runDir, "run.json"), {
        schema_version: 1,
        run_id: runId,
        status: "blocked",
        branch: runId,
        base_commit: orphanSha,
        worktree: join(repo, ".opencode", "worktrees", runId),
        validator: { verdict: "NO-GO", review_ref: "reviews/reviewer.json" },
        gates: {},
        terminal_result: { status: "blocked", run_id: runId, reason: "review blocked", summary: "blocked", artifacts: {} },
      });

      assert.throws(
        () => continueFactory(runId, { cwd: repo, review: "reviewer.json", runId: `${runId}-next`, dryRun: true }),
        /not an ancestor of parent branch/u,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects named starts that collide with an existing branch or worktree", async () => {
    const repo = mkdtempSync(join(tmpdir(), "review-named-start-"));
    try {
      initGitRepo(repo);
      runGit(repo, ["branch", "taken-branch"]);
      await assert.rejects(
        startFactory(["implement the feature"], { cwd: repo, runId: "taken-branch" }),
        /collides with existing branch/u,
      );

      mkdirSync(join(repo, ".opencode", "worktrees", "taken-worktree"), { recursive: true });
      await assert.rejects(
        startFactory(["implement the feature"], { cwd: repo, runId: "taken-worktree" }),
        /collides with existing worktree/u,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

function createRunDir(name, extra = {}) {
  const repo = mkdtempSync(join(tmpdir(), `review-hardening-${name}-`));
  const runDir = join(repo, ".opencode", "factory", name);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, "run.json"), { schema_version: 1, run_id: name, status: "running", gates: {}, ...extra });
  return runDir;
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
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cleanupDir(runDir) {
  rmSync(join(runDir, "..", "..", ".."), { recursive: true, force: true });
}
