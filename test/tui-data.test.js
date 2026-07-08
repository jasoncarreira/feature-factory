import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryRoots, findFactoryRoots, readRuns } from "../src/tui-data.js";

describe("TUI factory scanner", () => {
  it("finds runs in the current repo factory", () => {
    const repo = tempDir();
    writeRun(repo, "direct", { status: "running", updated_at: "2026-07-05T00:00:00Z" });

    const roots = findFactoryRoots(repo);
    const runs = readRuns(roots);

    assert.equal(runs.length, 1);
    assert.equal(runs[0].run_id, "direct");
    cleanup(repo);
  });

  it("finds runs in nested repos under the session directory", () => {
    const workspace = tempDir();
    const nested = join(workspace, "nested-repo");
    mkdirSync(nested, { recursive: true });
    writeRun(nested, "nested", { status: "running", updated_at: "2026-07-05T00:00:00Z" });

    const roots = findFactoryRoots(workspace);
    const runs = readRuns(roots);

    assert.equal(runs.length, 1);
    assert.equal(runs[0].run_id, "nested");
    assert.equal(runs[0].status, "running");
    cleanup(workspace);
  });

  it("deduplicates worktree and directory roots", () => {
    const repo = tempDir();
    writeRun(repo, "same", { status: "running", updated_at: "2026-07-05T00:00:00Z" });

    const roots = factoryRoots({ state: { path: { worktree: repo, directory: repo } } });

    assert.equal(roots.length, 1);
    cleanup(repo);
  });

  it("tolerates missing TUI startup path state", () => {
    for (const api of [null, {}, { state: null }, { state: { path: null } }, { state: { path: {} } }]) {
      assert.doesNotThrow(() => factoryRoots(api));
      assert.ok(Array.isArray(factoryRoots(api)));
    }
  });

  it("projects review tier summary fields from durable run.json", () => {
    const repo = tempDir();
    writeRun(repo, "strict-run", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      review_tier: "strict",
    });
    writeRun(repo, "legacy-run", { status: "running", updated_at: "2026-07-04T00:00:00Z" });

    const runs = readRuns(findFactoryRoots(repo));
    const strictRun = runs.find((run) => run.run_id === "strict-run");
    const legacyRun = runs.find((run) => run.run_id === "legacy-run");

    assert.equal(strictRun.review_tier, "strict");
    assert.equal(strictRun.review_tier_source, null);
    assert.equal(legacyRun.review_tier, null);
    assert.equal(legacyRun.review_tier_source, null);
    cleanup(repo);
  });

  it("projects the current slice or step beside gate state", () => {
    const repo = tempDir();
    writeRun(repo, "slice-run", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      slices: [
        { id: "done", status: "pending", attempts: 1 },
        { id: "docs-authority-contract", status: "running", attempts: 2 },
      ],
      steps: [{ agent: "work-decomposer", status: "running", attempts: 1 }],
    });
    writeRun(repo, "step-run", {
      status: "running",
      updated_at: "2026-07-04T00:00:00Z",
      steps: [{ agent: "spec-writer", status: "running", attempts: 2 }],
    });

    const runs = readRuns(findFactoryRoots(repo));
    const sliceRun = runs.find((run) => run.run_id === "slice-run");
    const stepRun = runs.find((run) => run.run_id === "step-run");

    assert.equal(sliceRun.gate, "story");
    assert.equal(sliceRun.current, "docs-authority-contract running a2");
    assert.equal(stepRun.current, "spec-writer running a2");
    cleanup(repo);
  });

  it("projects shared diagnostic envelope fields for TUI rows", () => {
    const repo = tempDir();
    writeRun(repo, "gate-run", { status: "running", updated_at: "2026-07-05T00:00:00Z" });

    const [run] = readRuns(findFactoryRoots(repo));

    assert.equal(run.run_id, "gate-run");
    assert.equal(run.diagnostics.schema_version, 1);
    assert.equal(run.diagnostic_status, "warning");
    assert.equal(run.diagnostic_severity, "warning");
    assert.equal(run.diagnostic_classification, "needs-human");
    assert.match(run.diagnostic_summary, /protected gate 'story'/i);
    cleanup(repo);
  });

  it("can skip expensive diagnostics for responsive sidebar refreshes", () => {
    const repo = tempDir();
    writeRun(repo, "light-run", { status: "running", updated_at: "2026-07-05T00:00:00Z", gates: {} });

    const [run] = readRuns(findFactoryRoots(repo), { diagnostics: false });

    assert.equal(run.run_id, "light-run");
    assert.equal(run.status, "running");
    assert.equal(run.diagnostic_status, "ok");
    assert.equal(run.diagnostic_classification, "healthy");
    cleanup(repo);
  });

  it("keeps invalid JSON visible as a fail-closed fallback row", () => {
    const repo = tempDir();
    writeRawRun(repo, "bad-json", "{\n");

    const [run] = readRuns(findFactoryRoots(repo));

    assert.equal(run.run_id, "bad-json");
    assert.equal(run.status, "invalid");
    assert.equal(run.branch, null);
    assert.equal(run.diagnostic_status, "error");
    assert.equal(run.diagnostic_severity, "critical");
    assert.equal(run.diagnostic_classification, "invalid");
    assert.equal(run.diagnostics.items[0].condition, "invalid-run-state");
    cleanup(repo);
  });

  it("sorts invalid fallback rows before valid stale rows", () => {
    const repo = tempDir();
    writeRun(repo, "valid-newer", { status: "running", updated_at: "2026-07-05T00:00:00Z", gates: {} });
    writeRawRun(repo, "bad-json", "{\n");

    const runs = readRuns(findFactoryRoots(repo));

    assert.equal(runs[0].run_id, "bad-json");
    assert.equal(runs[0].status, "invalid");
    cleanup(repo);
  });

  it("emits a scan-truncated note when nested root scanning is bounded", () => {
    const workspace = tempDir();
    const child = join(workspace, "child");
    mkdirSync(child, { recursive: true });
    const notes = [];

    findFactoryRoots(workspace, { maxScanDirs: 1, notes });

    assert.equal(notes[0].type, "scan-truncated");
    assert.equal(notes[0].scanned, 1);
    cleanup(workspace);
  });

  it("uses the run directory id for invalid run-state fallback rows", () => {
    const repo = tempDir();
    writeRawRun(repo, "bad-schema", JSON.stringify({ run_id: "untrusted-claim", status: "bogus", branch: "do-not-trust" }));

    const [run] = readRuns(findFactoryRoots(repo));

    assert.equal(run.run_id, "bad-schema");
    assert.equal(run.status, "invalid");
    assert.equal(run.branch, null);
    assert.equal(run.diagnostics.items[0].condition, "invalid-run-state");
    cleanup(repo);
  });

  it("keeps simplified consistency issues visible without authority proof diagnostics", () => {
    const repo = tempDir();
    writeRun(repo, "unverifiable", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      slices: [{ id: "merged-without-proof", status: "merged", attempts: 1 }],
    });

    const [run] = readRuns(findFactoryRoots(repo));

    assert.equal(run.run_id, "unverifiable");
    assert.equal(run.status, "running");
    assert.equal(run.diagnostics.items[0]?.condition, "protected-gate");
    cleanup(repo);
  });

  it("projects stale heartbeat diagnostics without hidden lease fields", () => {
    const repo = tempDir();
    writeRun(repo, "heartbeat-run", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      gates: {},
    });
    writeHeartbeat(repo, "heartbeat-run");

    const [run] = readRuns(findFactoryRoots(repo));

    assert.equal(run.diagnostic_status, "warning");
    assert.equal(run.diagnostics.items[0]?.condition, "missing-heartbeat-process");
    cleanup(repo);
  });
});

function tempDir() {
  return mkdtempSync(join(tmpdir(), "feature-factory-tui-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function writeRun(repo, id, input) {
  const dir = join(repo, ".opencode", "factory", id);
  mkdirSync(dir, { recursive: true });
  const run = {
    run_id: id,
    status: input.status,
    updated_at: input.updated_at,
    gates: input.gates === undefined ? { story: { status: "pending" } } : input.gates,
  };
  if (input.review_tier !== undefined) run.review_tier = input.review_tier;
  if (input.slices !== undefined) run.slices = input.slices;
  if (input.steps !== undefined) run.steps = input.steps;
  if (["completed", "blocked", "partial", "needs-human"].includes(input.status)) {
    run.terminal_result = {
      run_id: id,
      status: input.status,
      reason: input.status === "completed" ? null : `${input.status} fixture`,
    };
  }
  writeFileSync(
    join(dir, "run.json"),
    `${JSON.stringify(run, null, 2)}\n`,
  );
}

function writeRawRun(repo, id, contents) {
  const dir = join(repo, ".opencode", "factory", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), contents);
}

function writeHeartbeat(repo, id, input = {}) {
  const dir = join(repo, ".opencode", "factory", id);
  writeFileSync(
    join(dir, "heartbeat.json"),
    `${JSON.stringify({
      schema_version: 1,
      run_id: id,
      phase: "builder-wave",
      pid: 999999,
      last_tick_at: "1970-01-01T00:00:00.000Z",
      interval_ms: 30000,
      ...input,
    }, null, 2)}\n`,
  );
}
