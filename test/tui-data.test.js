import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryRoots, findFactoryRoots, readRuns, selectVisibleRuns, tuiSidebarRefreshMetadata } from "../src/tui-data.js";

describe("sidebar run visibility", () => {
  const run = (run_id, status, diagnostic_status = "ok") => ({ run_id, status, diagnostic_status });

  it("hides healthy completed runs except the most recent completed run", () => {
    const rows = [run("active-1", "running"), run("done-new", "completed"), run("done-old", "completed")];
    assert.deepEqual(selectVisibleRuns(rows).map((r) => r.run_id), ["active-1", "done-new"]);
  });

  it("keeps every completed run that still carries a non-ok diagnostic", () => {
    // Documented exception: more than one completed run can appear at once.
    const rows = [run("done-new", "completed"), run("done-warn", "completed", "warning"), run("done-old", "completed")];
    assert.deepEqual(selectVisibleRuns(rows).map((r) => r.run_id), ["done-warn", "done-new"]);
  });

  it("does not duplicate the most recent completed run when it has diagnostics", () => {
    const rows = [run("done-warn", "completed", "error"), run("blocked-1", "blocked")];
    assert.deepEqual(selectVisibleRuns(rows).map((r) => r.run_id), ["done-warn", "blocked-1"]);
  });

  it("always lists non-completed runs regardless of diagnostics", () => {
    const rows = [run("blocked-1", "blocked"), run("needs-human-1", "needs-human", "warning"), run("running-1", "running")];
    assert.deepEqual(selectVisibleRuns(rows).map((r) => r.run_id), ["blocked-1", "needs-human-1", "running-1"]);
  });
});

describe("TUI factory scanner", () => {
  it("describes sidebar refresh metadata and active-session limitations", () => {
    const metadata = tuiSidebarRefreshMetadata({ version: 7 });

    assert.deepEqual(metadata, {
      schema_version: 1,
      data_version: 7,
      root_cache_ttl_ms: 30000,
      limitation: "An already-open opencode TUI process can keep rendering stale Feature Factory sidebar data after the plugin bundle changes; restart or reload the TUI to pick up plugin changes.",
      label: "sidebar v7 · plugin changes need TUI restart",
    });
  });

  it("sanitizes sidebar refresh data versions for display", () => {
    for (const version of [undefined, -1, 1.5, "7\u001b[2J", Number.NaN]) {
      const metadata = tuiSidebarRefreshMetadata({ version });

      assert.equal(metadata.data_version, 0);
      assert.equal(metadata.label, "sidebar v0 · plugin changes need TUI restart");
      assert.equal(hasTerminalControl(metadata.label), false);
    }
  });

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

  it("projects public cost attribution summary fields from durable run.json", () => {
    const repo = tempDir();
    writeRun(repo, "costed-run", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      cost_attribution: costAttributionFixture("costed-run"),
    });
    writeRun(repo, "legacy-run", { status: "running", updated_at: "2026-07-04T00:00:00Z" });

    const runs = readRuns(findFactoryRoots(repo), { diagnostics: false });
    const costedRun = runs.find((run) => run.run_id === "costed-run");
    const legacyRun = runs.find((run) => run.run_id === "legacy-run");

    assert.equal(costedRun.cost.status, "available");
    assert.equal(costedRun.cost.entry_count, 1);
    assert.equal(costedRun.cost.total_tokens, 5);
    assert.equal(costedRun.cost.cost_total, 0.005);
    assert.equal(costedRun.cost.cost_currency, "USD");
    assert.equal(costedRun.cost.label, "cost available · 1 entry · 5 tokens · 0.005 USD");
    assert.equal(Object.hasOwn(costedRun.cost, "entries"), false);
    assert.equal(legacyRun.cost, null);
    cleanup(repo);
  });

  it("projects cost labels without terminal controls from legacy durable metadata", () => {
    const repo = tempDir();
    const costAttribution = costAttributionFixture("cost-control-run");
    costAttribution.status = "available\u001b[2J";
    costAttribution.totals.cost_currency = "USD\u001b]0;pwned\u0007";
    costAttribution.totals.missing = ["provider\u001b]52;c;U0VDUkVU\u0007"];
    writeRun(repo, "cost-control-run", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      cost_attribution: costAttribution,
    });

    const [run] = readRuns(findFactoryRoots(repo), { diagnostics: false });

    assert.equal(hasTerminalControl(run.cost.label), false);
    assert.equal(hasTerminalControl(run.cost.status), false);
    assert.equal(hasTerminalControl(run.cost.missing.join(",")), false);
    assert.equal(run.cost.cost_currency, undefined);
    cleanup(repo);
  });

  it("scans real pending steering as read-only metadata without raw text", () => {
    const repo = tempDir();
    const rawSteering = "raw operator steering must never reach a TUI row";
    const fixture = writePendingSteeringRun(repo, "steered-run", rawSteering);
    const before = snapshotPendingSteering(fixture);

    try {
      const directRoots = findFactoryRoots(repo);
      const sidebarRoots = factoryRoots({ state: { path: { worktree: repo, directory: repo } } }, { noCache: true });
      const [diagnosticRun] = readRuns(directRoots);
      const [sidebarRun] = readRuns(sidebarRoots, { diagnostics: false });

      for (const run of [diagnosticRun, sidebarRun]) {
        assert.deepEqual(run.steering.pending, fixture.pending);
        assert.deepEqual(Object.keys(run.steering.pending).sort(), ["created_at", "hash", "id", "message_chars", "ref"]);
        assert.equal(run.steering.consumed_count, 0);
        assert.equal(run.steering.latest_consumed, null);
        assert.equal(JSON.stringify(run).includes(rawSteering), false);
      }
      assertPendingSteeringUnchanged(fixture, before);
    } finally {
      cleanup(repo);
    }
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

  it("prefers active work over downstream blocked placeholders", () => {
    const repo = tempDir();
    writeRun(repo, "spec-run", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      steps: [
        { agent: "spec-writer", status: "running", attempts: 0 },
        { agent: "work-decomposer", status: "blocked", attempts: 0 },
        { agent: "test-verifier", status: "blocked", attempts: 0 },
      ],
    });

    const [run] = readRuns(findFactoryRoots(repo));

    assert.equal(run.current, "spec-writer running");
    cleanup(repo);
  });

  it("prefers an active step over a blocked slice", () => {
    const repo = tempDir();
    writeRun(repo, "cross-tier-run", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      slices: [{ id: "docs-authority-contract", status: "blocked", attempts: 1 }],
      steps: [{ agent: "spec-writer", status: "running", attempts: 2 }],
    });

    const [run] = readRuns(findFactoryRoots(repo));

    assert.equal(run.current, "spec-writer running a2");
    cleanup(repo);
  });

  it("sanitizes a legacy active slice before it outranks safe blocked work", () => {
    const repo = tempDir();
    writeRun(repo, "active-control-slice", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      slices: [{ id: "active\u001b[2J-slice\u009b", status: "running", attempts: 2 }],
      steps: [{ agent: "safe-blocked-step", status: "blocked", attempts: 1 }],
    });

    const [run] = readRuns(findFactoryRoots(repo), { diagnostics: false });

    assert.equal(run.current, "active[2J-slice running a2");
    assert.equal(hasTerminalControl(run.current), false);
    cleanup(repo);
  });

  it("sanitizes a legacy active step before it outranks a safe blocked slice", () => {
    const repo = tempDir();
    writeRun(repo, "active-control-step", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      slices: [{ id: "safe-blocked-slice", status: "blocked", attempts: 1 }],
      steps: [{ agent: "active\u001b]0;pwned\u0007-step\u0085", status: "running", attempts: 3 }],
    });

    const [run] = readRuns(findFactoryRoots(repo), { diagnostics: false });

    assert.equal(run.current, "active]0;pwned-step running a3");
    assert.equal(hasTerminalControl(run.current), false);
    cleanup(repo);
  });

  it("keeps blocked work as the fallback when no work is active", () => {
    const repo = tempDir();
    writeRun(repo, "blocked-run", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      slices: [{ id: "docs-authority-contract", status: "blocked", attempts: 1 }],
      steps: [{ agent: "work-decomposer", status: "blocked", attempts: 0 }],
    });

    const [run] = readRuns(findFactoryRoots(repo));

    assert.equal(run.current, "docs-authority-contract blocked a1");
    cleanup(repo);
  });

  it("prefers review work over a blocked step", () => {
    const repo = tempDir();
    writeRun(repo, "review-run", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      slices: [{ id: "docs-authority-contract", status: "review", attempts: 2 }],
      steps: [{ agent: "work-decomposer", status: "blocked", attempts: 0 }],
    });

    const [run] = readRuns(findFactoryRoots(repo));

    assert.equal(run.current, "docs-authority-contract review a2");
    cleanup(repo);
  });

  it("keeps a blocked step as the fallback when no slice is blocked", () => {
    const repo = tempDir();
    writeRun(repo, "blocked-step-run", {
      status: "running",
      updated_at: "2026-07-04T00:00:00Z",
      steps: [{ agent: "work-decomposer", status: "blocked", attempts: 0 }],
    });

    const [run] = readRuns(findFactoryRoots(repo));

    assert.equal(run.current, "work-decomposer blocked");
    cleanup(repo);
  });

  it("infers pre-PR panel progress after test-verifier acceptance", () => {
    const repo = tempDir();
    writeRun(repo, "panel-run", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      gates: {},
      steps: [{ agent: "test-verifier", status: "accepted", attempts: 3 }],
      slices: [{ id: "backend", status: "merged", attempts: 1 }],
    });
    writeRun(repo, "security-run", {
      status: "running",
      updated_at: "2026-07-04T00:00:00Z",
      gates: {},
      steps: [{ agent: "test-verifier", status: "accepted", attempts: 1 }],
      validator: { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" },
    });
    writeRun(repo, "remediation-run", {
      status: "running",
      updated_at: "2026-07-03T00:00:00Z",
      gates: {},
      steps: [{ agent: "test-verifier", status: "accepted", attempts: 1 }],
      validator: { verdict: "NO-GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" },
      security_review: { verdict: "BLOCK", review_ref: "reviews/security-reviewer.json" },
    });

    const runs = readRuns(findFactoryRoots(repo));
    const panelRun = runs.find((run) => run.run_id === "panel-run");
    const securityRun = runs.find((run) => run.run_id === "security-run");
    const remediationRun = runs.find((run) => run.run_id === "remediation-run");

    assert.equal(panelRun.current, "pre-PR panel running");
    assert.equal(securityRun.current, "security-reviewer running");
    assert.equal(remediationRun.current, "panel remediation running");
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

  it("projects duplicate-id diagnostics without terminal controls and preserves safe context", () => {
    const repo = tempDir();
    const maliciousID = "duplicate\u001b[2J\u009b31m\u0007";
    writeRun(repo, "duplicate-diagnostic", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      gates: {},
      slices: [{ id: maliciousID, status: "running" }, { id: maliciousID, status: "blocked" }],
    });

    const [run] = readRuns(findFactoryRoots(repo));

    assert.equal(run.status, "invalid");
    assert.match(run.diagnostic_summary, /Factory run state is invalid: run\.slices\[1\]\.id: duplicate id/u);
    assert.match(run.diagnostics.items[0].evidence.error, /must not contain control characters/u);
    assert.equal(diagnosticStrings(run.diagnostics).some(hasTerminalControl), false);
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
    assert.equal(run.cost, null);
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
      slices: [{ id: "slice", status: "running", attempts: 1 }],
    });
    writeHeartbeat(repo, "heartbeat-run");

    const [run] = readRuns(findFactoryRoots(repo));

    assert.equal(run.diagnostic_status, "warning");
    assert.equal(run.diagnostics.items[0]?.condition, "missing-heartbeat-process");
    cleanup(repo);
  });

  it("does not project stale heartbeat diagnostics for idle or blocked work", () => {
    const repo = tempDir();
    writeRun(repo, "idle-heartbeat-run", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      gates: {},
      steps: [{ agent: "spec-writer", status: "blocked", attempts: 1 }],
    });
    writeHeartbeat(repo, "idle-heartbeat-run");

    const [run] = readRuns(findFactoryRoots(repo));

    assert.equal(run.diagnostic_status, "ok");
    assert.equal(run.diagnostic_classification, "healthy");
    assert.equal(run.diagnostics.items.length, 0);
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
  if (input.validator !== undefined) run.validator = input.validator;
  if (input.security_review !== undefined) run.security_review = input.security_review;
  if (input.steering !== undefined) run.steering = input.steering;
  if (input.cost_attribution !== undefined) run.cost_attribution = input.cost_attribution;
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

function writePendingSteeringRun(repo, id, message) {
  const runDir = join(repo, ".opencode", "factory", id);
  const steeringDir = join(runDir, "steering");
  const createdAt = "2026-07-05T00:00:00.000Z";
  const ref = "steering/pending-20260705T000000000Z-tui-read-only.json";
  const pendingFile = join(runDir, ref);
  const steeringFile = {
    schema_version: 1,
    kind: "operator-steering",
    run_id: id,
    id: "tui-read-only",
    message,
    message_chars: message.length,
    created_at: createdAt,
    source: "factory steer",
  };
  mkdirSync(steeringDir, { recursive: true });
  writeFileSync(pendingFile, `${JSON.stringify(steeringFile, null, 2)}\n`, "utf8");
  const pending = {
    id: steeringFile.id,
    ref,
    hash: `sha256:${createHash("sha256").update(readFileSync(pendingFile)).digest("hex")}`,
    message_chars: message.length,
    created_at: createdAt,
  };
  const history = [{ event: "queued", ...pending }];
  writeRun(repo, id, {
    status: "running",
    updated_at: createdAt,
    gates: {},
    steering: { schema_version: 1, pending, history },
  });
  return { repo, runDir, runFile: join(runDir, "run.json"), pendingFile, pending, history };
}

function snapshotPendingSteering(fixture) {
  return {
    runText: readFileSync(fixture.runFile, "utf8"),
    pendingText: readFileSync(fixture.pendingFile, "utf8"),
    files: readdirSync(join(fixture.runDir, "steering")).sort(),
  };
}

function assertPendingSteeringUnchanged(fixture, before) {
  const run = JSON.parse(readFileSync(fixture.runFile, "utf8"));
  const files = readdirSync(join(fixture.runDir, "steering")).sort();

  assert.equal(readFileSync(fixture.runFile, "utf8"), before.runText);
  assert.deepEqual(run.steering.pending, fixture.pending);
  assert.deepEqual(run.steering.history, fixture.history);
  assert.equal(readFileSync(fixture.pendingFile, "utf8"), before.pendingText);
  assert.deepEqual(files, before.files);
  assert.equal(files.some((file) => file.startsWith("consumed-")), false);
}

function costAttributionFixture(runID) {
  const rollup = {
    status: "available",
    entry_count: 1,
    request_count: 1,
    missing: [],
    mixed_currency: false,
    input_tokens: 2,
    output_tokens: 3,
    total_tokens: 5,
    cost_total: 0.005,
    cost_currency: "USD",
  };
  return {
    schema_version: 1,
    updated_at: "2026-07-05T00:00:00.000Z",
    status: "available",
    totals: rollup,
    by_agent: { "frontend-builder": rollup },
    by_slice: {},
    entries: [{
      id: "usage-1",
      recorded_at: "2026-07-05T00:00:00.000Z",
      run_id: runID,
      agent: "frontend-builder",
      provider: "openai",
      model: "gpt-5.5",
      input_tokens: 2,
      output_tokens: 3,
      total_tokens: 5,
      cost_total: 0.005,
      cost_currency: "USD",
      status: "available",
      missing: [],
    }],
  };
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

function hasTerminalControl(value) {
  return /[\u0000-\u001F\u007F-\u009F]/u.test(value);
}

function diagnosticStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(diagnosticStrings);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(diagnosticStrings);
}
