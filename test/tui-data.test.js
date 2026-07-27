import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "./helpers/git-fixture.js";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryRoots, findFactoryRoots, projectTuiDiagnosticData, readRuns, selectVisibleRuns } from "../src/tui-data.js";
import { hashValue } from "../src/refs.js";

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

  it("discovers a factory root created after an empty startup scan", () => {
    const workspace = tempDir();
    const api = { state: { path: { worktree: workspace, directory: workspace } } };
    const syntheticRoot = join(workspace, ".opencode", "factory");

    assert.deepEqual(factoryRoots(api), [syntheticRoot]);

    const nested = join(workspace, "new-repo");
    writeRun(nested, "started-later", { status: "running", updated_at: "2026-07-05T00:00:00Z" });
    const roots = factoryRoots(api);

    assert.ok(roots.includes(join(nested, ".opencode", "factory")));
    assert.equal(readRuns(roots)[0].run_id, "started-later");
    cleanup(workspace);
  });

  it("shows a new session-root run on the next poll even when the cache holds another existing root", () => {
    const workspace = tempDir();
    const api = { state: { path: { worktree: workspace, directory: workspace } } };
    const nested = join(workspace, "nested-repo");
    writeRun(nested, "existing", { status: "running", updated_at: "2026-07-05T00:00:00Z" });

    // Warm the root cache with the existing nested root only.
    const warm = factoryRoots(api);
    assert.ok(warm.includes(join(nested, ".opencode", "factory")));

    // A run created at the session root must be visible on the immediately
    // following poll tick — not after the root-cache TTL expires.
    writeRun(workspace, "brand-new", { status: "running", updated_at: "2026-07-06T00:00:00Z" });
    const runs = readRuns(factoryRoots(api));

    assert.ok(runs.some((run) => run.run_id === "brand-new"));
    cleanup(workspace);
  });

  it("shows a new canonical git-root run when the session path is a repo subdirectory and the cache is warm", () => {
    const repo = tempDir();
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
    const sessionDir = join(repo, "subdir");
    mkdirSync(sessionDir, { recursive: true });
    const api = { state: { path: { directory: sessionDir } } };

    // Warm the root cache with an existing nested root so the cache stays valid.
    writeRun(join(sessionDir, "nested-repo"), "existing", { status: "running", updated_at: "2026-07-05T00:00:00Z" });
    const warm = factoryRoots(api);
    assert.ok(warm.includes(join(sessionDir, "nested-repo", ".opencode", "factory")));

    // Factory writes anchor at the Git repository root when the session
    // directory has no local .opencode/factory; the sidebar must see that
    // run on the immediately following poll, not after the cache TTL.
    writeRun(repo, "canonical-new", { status: "running", updated_at: "2026-07-06T00:00:00Z" });
    const runs = readRuns(factoryRoots(api));

    assert.ok(runs.some((run) => run.run_id === "canonical-new"));
    cleanup(repo);
  });

  it("shows a new git-root run when a session-subdirectory factory shadows the direct root", () => {
    const repo = tempDir();
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
    const sessionDir = join(repo, "subdir");
    mkdirSync(join(sessionDir, ".opencode", "factory"), { recursive: true });
    const api = { state: { path: { worktree: sessionDir, directory: sessionDir } } };
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: sessionDir, encoding: "utf8" }).trim();

    // Warm the cache while directFactoryRoot resolves to the session-local
    // factory. Factory commands still anchor durable runs at the Git root.
    assert.deepEqual(factoryRoots(api), [
      join(gitRoot, ".opencode", "factory"),
      join(sessionDir, ".opencode", "factory"),
    ]);

    writeRun(repo, "repo-root-run", { status: "running", updated_at: "2026-07-06T00:00:00Z" });
    const runs = readRuns(factoryRoots(api));

    assert.ok(runs.some((run) => run.run_id === "repo-root-run"));
    cleanup(repo);
  });

  it("does not throw when a scanned root is not a directory", () => {
    const workspace = tempDir();
    mkdirSync(join(workspace, ".opencode"), { recursive: true });
    const rootAsFile = join(workspace, ".opencode", "factory");
    writeFileSync(rootAsFile, "not a directory\n");

    assert.deepEqual(readRuns([rootAsFile]), []);
    cleanup(workspace);
  });

  it("skips symlinked factory roots instead of following them", () => {
    const workspace = tempDir();
    const outside = tempDir();
    writeRun(outside, "outside-run", { status: "running", updated_at: "2026-07-05T00:00:00Z" });
    symlinkSync(join(outside, ".opencode"), join(workspace, ".opencode"), "dir");

    const roots = factoryRoots({ state: { path: { directory: workspace } } }, { noCache: true });
    assert.deepEqual(roots, []);
    assert.deepEqual(readRuns(roots), []);
    cleanup(workspace);
    cleanup(outside);
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
        assert.equal(run.steering.pending.id, fixture.pending.id);
        assert.equal(run.steering.pending.ref, "[redacted]");
        assert.equal(run.steering.pending.hash, "[redacted]");
        assert.equal(run.steering.pending.message_chars, fixture.pending.message_chars);
        assert.equal(run.steering.pending.created_at, fixture.pending.created_at);
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
        { id: "done", declared_paths: ["done.txt"], effective_paths: ["done.txt"], status: "pending", attempts: 0 },
        { id: "docs-authority-contract", declared_paths: ["docs/**"], effective_paths: ["docs/**"], status: "running", attempts: 2 },
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
      slices: [{ id: "docs-authority-contract", declared_paths: ["docs/**"], effective_paths: ["docs/**"], status: "blocked", attempts: 1 }],
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

    assert.equal(run.current, "active\\u001B[2J-slice\\u009B running a2");
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

    assert.equal(run.current, "active\\u001B]0;pwned\\u0007-step\\u0085 running a3");
    assert.equal(hasTerminalControl(run.current), false);
    cleanup(repo);
  });

  it("keeps blocked work as the fallback when no work is active", () => {
    const repo = tempDir();
    writeRun(repo, "blocked-run", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      slices: [{ id: "docs-authority-contract", declared_paths: ["docs/**"], effective_paths: ["docs/**"], status: "blocked", attempts: 1 }],
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
      slices: [{ id: "docs-authority-contract", declared_paths: ["docs/**"], effective_paths: ["docs/**"], status: "review", attempts: 2 }],
      steps: [{ agent: "work-decomposer", status: "blocked", attempts: 0 }],
    });

    const [run] = readRuns(findFactoryRoots(repo));

    assert.equal(run.current, "docs-authority-contract review a2");
    cleanup(repo);
  });

  it("keeps a genuinely attempted blocked step as the fallback when no slice is blocked", () => {
    const repo = tempDir();
    writeRun(repo, "blocked-step-run", {
      status: "running",
      updated_at: "2026-07-04T00:00:00Z",
      steps: [{ agent: "work-decomposer", status: "blocked", attempts: 1 }],
    });

    const [run] = readRuns(findFactoryRoots(repo));

    assert.equal(run.current, "work-decomposer blocked a1");
    cleanup(repo);
  });

  it("does not present zero-attempt bootstrap placeholders as blocked work", () => {
    const repo = tempDir();
    writeRun(repo, "bootstrap-run", {
      status: "running",
      updated_at: "2026-07-04T00:00:00Z",
      steps: [
        { agent: "spec-writer", status: "blocked", attempts: 0 },
        { agent: "work-decomposer", status: "blocked", attempts: 0 },
        { agent: "test-verifier", status: "blocked", attempts: 0 },
      ],
    });

    const [run] = readRuns(findFactoryRoots(repo));

    assert.equal(run.current, null);
    cleanup(repo);
  });

  it("projects authoritative panel state without inferring activity from accepted tests", () => {
    const repo = tempDir();
    writeRun(repo, "panel-run", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      gates: {},
      steps: [{ agent: "test-verifier", status: "accepted", attempts: 3 }],
      slices: [{ id: "backend", declared_paths: ["backend.txt"], effective_paths: ["backend.txt"], status: "merged", attempts: 1,
        evidence_ref: "evidence/backend.json", evidence_hash: `sha256:${"1".repeat(64)}`,
        review_ref: "reviews/backend.json", review_hash: `sha256:${"2".repeat(64)}`, reviewed_commit: "3".repeat(40), merge_commit: "4".repeat(40),
        attempt_reviews: [{ attempt: 1, evidence_ref: "evidence/backend.json", evidence_hash: `sha256:${"1".repeat(64)}`, review_ref: "reviews/backend.json", review_hash: `sha256:${"2".repeat(64)}`, reviewed_commit: "3".repeat(40), diff_base_commit: "3".repeat(40), ratified_paths: [], verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0 }] }],
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

    assert.equal(panelRun.current, null);
    assert.equal(securityRun.current, "security-reviewer pending");
    assert.equal(remediationRun.current, "panel remediation pending");
    cleanup(repo);
  });

  it("TUI-P1 projects authoritative story intake from the running step", () => {
    assert.equal(projectedCurrent({
      steps: [{ agent: "story-reader", status: "running", attempts: 1 }],
    }), "story-reader running a1");
  });

  it("TUI-P2 orders claim-bound running, legacy running, and review slices", () => {
    const variants = [
      {
        name: "claim-bound running outranks earlier legacy running and review rows",
        slices: [
          { id: "legacy-running", status: "running", attempts: 1 },
          { id: "review-row", status: "review", attempts: 3 },
          claimBoundSlice("claim-bound", 2),
        ],
        expected: "claim-bound running a2",
      },
      { name: "legacy running remains displayable", slices: [{ id: "legacy-running", status: "running", attempts: 1 }], expected: "legacy-running running a1" },
      { name: "review remains displayable", slices: [{ id: "review-row", status: "review", attempts: 2 }], expected: "review-row review a2" },
    ];
    for (const variant of variants) {
      assert.equal(projectedCurrent({
        slices: variant.slices,
        steps: [{ agent: "story-reader", status: "running", attempts: 1 }],
      }, `tui-p2-${variant.name.replaceAll(" ", "-")}`), variant.expected, variant.name);
    }
  });

  it("TUI-P3 maps every open and closed build-oriented special dispatch", () => {
    const labels = {
      "merged-slice-repair": ["merged-slice repair running", "merged-slice repair awaiting integration"],
      "integration-amendment": ["integration amendment running", "integration amendment awaiting integration"],
      "integration-conflict": ["integration conflict repair running", "integration conflict repair awaiting integration"],
    };
    for (const [route, expected] of Object.entries(labels)) {
      for (const closed of [false, true]) {
        assert.equal(projectedCurrent({
          special_builder_dispatch: specialDispatch(route, { closed }),
          slices: [{ id: "stale-slice", status: "running", attempts: 1 }],
        }, `tui-p3-${route}-${closed ? "closed" : "open"}`), expected[Number(closed)]);
      }
    }
  });

  it("TUI-P4 lets an active checked whole-story claim outrank a simultaneous story-reader", () => {
    const runId = "tui-p4-active-claim";
    assert.equal(projectedCurrent({
      steps: [
        { agent: "story-reader", status: "running", attempts: 1 },
        checkedExecutionStep(runId, { state: "active", attempt: 2 }),
      ],
    }, runId), "whole-story tests running a2");
  });

  it("TUI-P5 keeps active execution stable across receipt publication and maps every claim result", () => {
    const repo = tempDir();
    const runId = "tui-p5-receipt-flight";
    const input = {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      gates: {},
      steps: [
        { agent: "story-reader", status: "running", attempts: 1 },
        checkedExecutionStep(runId, { state: "active", attempt: 2 }),
      ],
    };
    writeRun(repo, runId, input);
    const current = () => readRuns(findFactoryRoots(repo), { diagnostics: false })[0].current;
    assert.equal(current(), "whole-story tests running a2");
    const evidenceDir = join(repo, ".opencode", "factory", runId, "evidence");
    const receipt = join(evidenceDir, "test-verifier.attempt-2.json");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(receipt, "receipt secret bytes that projection must not read\n");
    assert.equal(current(), "whole-story tests running a2");
    cleanup(repo);

    const variants = [
      { state: "unknown", expected: "whole-story tests needs reconciliation a2" },
      { state: "completed", status: "pass", expected: "whole-story tests passed a2" },
      { state: "completed", status: "fail", expected: "whole-story tests failed a2" },
    ];
    for (const variant of variants) {
      const id = `tui-p5-${variant.state}-${variant.status || "none"}`;
      assert.equal(projectedCurrent({
        steps: [
          { agent: "story-reader", status: "running", attempts: 1 },
          checkedExecutionStep(id, { ...variant, attempt: 2 }),
        ],
      }, id), variant.expected);
    }
  });

  it("TUI-P6 projects named active panel work ahead of completed verification", () => {
    for (const [agent, attempt] of [["implementation-validator", 2], ["security-reviewer", 3]]) {
      const runId = `tui-p6-${agent}`;
      assert.equal(projectedCurrent({
        steps: [
          { agent: "story-reader", status: "running", attempts: 1 },
          checkedExecutionStep(runId, { state: "completed", status: "pass", attempt: 1 }),
          { agent, status: "running", attempts: attempt },
        ],
      }, runId), `${agent} running a${attempt}`);
    }
  });

  it("TUI-P7 covers the complete validator/security verdict partition and legacy partial rows", () => {
    const validators = ["GO", "GO-WITH-NITS", "NO-GO"];
    const securities = ["PASS", "BLOCK"];
    for (const validator of validators) {
      for (const security of securities) {
        const expected = validator !== "NO-GO" && security === "PASS" ? "panels passed" : "panel remediation pending";
        assert.equal(projectedCurrent({
          validator: { verdict: validator },
          security_review: { verdict: security },
          steps: [{ agent: "implementation-validator", status: "running", attempts: 4 }],
        }, `tui-p7-${validator.toLowerCase()}-${security.toLowerCase()}`), expected);
      }
    }
    assert.equal(projectedCurrent({ validator: { verdict: "GO" } }, "tui-p7-validator-only"), "security-reviewer pending");
    assert.equal(projectedCurrent({ security_review: { verdict: "PASS" } }, "tui-p7-security-only"), "implementation-validator pending");
  });

  it("TUI-P8 distinguishes open and closed panel remediation authority", () => {
    for (const [closed, expected] of [
      [false, "panel remediation running"],
      [true, "panel remediation awaiting panel publication"],
    ]) {
      assert.equal(projectedCurrent({
        special_builder_dispatch: specialDispatch("panel-remediation", { closed }),
        validator: { verdict: "NO-GO" },
        security_review: { verdict: "BLOCK" },
      }, `tui-p8-${closed ? "closed" : "open"}`), expected);
    }
  });

  it("TUI-P9 maps every pre-PR gate status ahead of retained panels and steps", () => {
    const variants = {
      pending: "pre-PR approval pending",
      approved: "pre-PR approved",
      changes_requested: "pre-PR changes requested",
      stopped: "pre-PR stopped",
    };
    for (const [status, expected] of Object.entries(variants)) {
      assert.equal(projectedCurrent({
        gates: { pre_pr: { status } },
        validator: { verdict: "GO" },
        security_review: { verdict: "PASS" },
        steps: [{ agent: "story-reader", status: "running", attempts: 1 }],
      }, `tui-p9-${status}`), expected);
    }
  });

  it("TUI-P10 distinguishes active PR creation from a legacy fence that needs reconciliation", () => {
    assert.equal(projectedCurrent({
      gates: { pre_pr: { status: "approved" } },
      steering: { pr_fence: prFence() },
    }, "tui-p10-pr-fence"), "PR creation running");
    assert.equal(projectedCurrent({
      gates: { pre_pr: { status: "approved" } },
      steering: { pr_fence: legacyPrFence() },
    }, "tui-p10-legacy-pr-fence"), "PR creation needs reconciliation");
  });

  it("TUI-P11 projects legacy, disabled-policy, and awaiting-start PR authority", () => {
    const variants = [
      { name: "legacy", input: { pr_url: "https://github.com/example/repo/pull/1" }, expected: "PR created" },
      { name: "disabled", input: { post_pr: postPrFixture("disabled", 0, { pr_operation: prOperation() }) }, expected: "PR created" },
      { name: "awaiting", input: { post_pr: postPrFixture("awaiting-pr", 0, { pr_operation: prOperation() }) }, expected: "PR created; post-PR awaiting start" },
    ];
    for (const variant of variants) assert.equal(projectedCurrent(variant.input, `tui-p11-${variant.name}`), variant.expected);
  });

  it("TUI-P12 keeps dormant disabled and awaiting post-PR state below earlier work", () => {
    for (const phase of ["disabled", "awaiting-pr"]) {
      assert.equal(projectedCurrent({
        post_pr: postPrFixture(phase, 0),
        steps: [{ agent: "story-reader", status: "running", attempts: 1 }],
      }, `tui-p12-${phase}`), "story-reader running a1");
    }
  });

  it("TUI-P13 maps every active and terminal post-PR phase at zero and positive attempts", () => {
    const labels = {
      observing: "post-PR checks running",
      "failure-recording": "post-PR failure recording",
      "remediation-planned": "post-PR remediation planned",
      "remediation-running": "post-PR remediation running",
      "changes-observed": "post-PR changes observed",
      committed: "post-PR remediation committed",
      revalidating: "post-PR revalidation running",
      validated: "post-PR revalidation passed",
      "push-pending": "post-PR push pending",
      "remote-confirmed": "post-PR remote confirmed",
      succeeded: "post-PR succeeded",
      blocked: "post-PR blocked",
      "needs-human": "post-PR needs human",
    };
    for (const [phase, label] of Object.entries(labels)) {
      for (const attempt of [0, 2]) {
        const status = phase === "succeeded" ? "completed" : ["blocked", "needs-human"].includes(phase) ? phase : "running";
        assert.equal(projectedCurrent({
          status,
          post_pr: postPrFixture(phase, attempt),
          pr_url: "https://github.com/example/repo/pull/1",
          steps: [{ agent: "story-reader", status: "running", attempts: 1 }],
        }, `tui-p13-${phase}-${attempt}`), `${label}${attempt > 0 ? ` a${attempt}` : ""}`);
      }
    }
  });

  it("TUI-P14 enforces adjacent precedence and terminal post-PR over a complete overlap", () => {
    const runId = "tui-p14-adjacent";
    const tiers = [
      { name: "active-post-pr", input: { post_pr: postPrFixture("observing", 1), pr_url: "https://github.com/example/repo/pull/1" }, expected: "post-PR checks running a1" },
      { name: "pr-created", input: { pr_url: "https://github.com/example/repo/pull/1" }, expected: "PR created" },
      { name: "pr-fence", input: { steering: { pr_fence: prFence() } }, expected: "PR creation running" },
      { name: "pre-pr", input: { gates: { pre_pr: { status: "approved" } } }, expected: "pre-PR approved" },
      { name: "panel", input: { validator: { verdict: "GO" }, security_review: { verdict: "PASS" } }, expected: "panels passed" },
      { name: "checked-tests", input: { steps: [checkedExecutionStep(runId, { state: "completed", status: "pass", attempt: 1 })] }, expected: "whole-story tests passed a1" },
      { name: "build-special", input: { special_builder_dispatch: specialDispatch("merged-slice-repair") }, expected: "merged-slice repair running" },
      { name: "active-slice", input: { slices: [{ id: "active-slice", status: "running", attempts: 1 }] }, expected: "active-slice running a1" },
      { name: "running-step", input: { steps: [{ agent: "story-reader", status: "running", attempts: 1 }] }, expected: "story-reader running a1" },
      { name: "blocked-slice", input: { slices: [{ id: "blocked-slice", status: "blocked", attempts: 1 }] }, expected: "blocked-slice blocked a1" },
      { name: "pending-step", input: { steps: [{ agent: "next-step", status: "pending", attempts: 0 }] }, expected: "next-step pending" },
    ];
    for (let index = 0; index < tiers.length - 1; index += 1) {
      const higher = tiers[index];
      const lower = tiers[index + 1];
      assert.equal(projectedCurrent(combineProjectionInputs(higher.input, lower.input), runId), higher.expected, `${higher.name} must outrank ${lower.name}`);
    }

    assert.equal(projectedCurrent(combineProjectionInputs(
      { status: "completed", post_pr: postPrFixture("succeeded", 2) },
      ...tiers.slice(1).map((tier) => tier.input),
    ), runId), "post-PR succeeded a2");

    assert.equal(projectedCurrent({ status: "blocked", post_pr: postPrFixture("blocked", 0), pr_url: "https://github.com/example/repo/pull/1" }, "tui-p14-terminal-exclusive"), "post-PR blocked");
    assert.equal(projectedCurrent(tiers[0].input, "tui-p14-active-exclusive"), "post-PR checks running a1");

    const malformedLowerDispatch = specialDispatch("merged-slice-repair", { closed: true });
    delete malformedLowerDispatch.closure_hash;
    assert.equal(projectedCurrent({
      validator: { verdict: "GO" },
      security_review: { verdict: "PASS" },
      special_builder_dispatch: malformedLowerDispatch,
    }, "tui-p14-higher-masks-malformed-lower"), "panels passed");
  });

  it("TUI-P15 preserves generic fallbacks and suppresses zero-attempt blocked placeholders", () => {
    const variants = [
      { name: "running-step", input: { steps: [{ agent: "story-reader", status: "running", attempts: 1 }] }, expected: "story-reader running a1" },
      { name: "slice-review", input: { slices: [{ id: "review-slice", status: "review", attempts: 2 }] }, expected: "review-slice review a2" },
      { name: "blocked-slice", input: { slices: [{ id: "blocked-slice", status: "blocked", attempts: 1 }] }, expected: "blocked-slice blocked a1" },
      { name: "blocked-step", input: { steps: [{ agent: "work-decomposer", status: "blocked", attempts: 1 }] }, expected: "work-decomposer blocked a1" },
      { name: "placeholder", input: { steps: [{ agent: "work-decomposer", status: "blocked", attempts: 0 }] }, expected: null },
    ];
    for (const variant of variants) assert.equal(projectedCurrent(variant.input, `tui-p15-${variant.name}`), variant.expected);
  });

  it("TUI-P16 fails closed without throwing for every malformed authority kind", () => {
    const runId = "tui-p16-malformed";
    const badHashStep = checkedExecutionStep(runId, { state: "active", attempt: 1 });
    badHashStep.execution_claim_hash = `sha256:${"f".repeat(64)}`;
    const duplicateClaim = checkedExecutionStep(runId, { state: "active", attempt: 1 });
    const nonRunningClaim = checkedExecutionStep(runId, { state: "active", attempt: 1 });
    nonRunningClaim.status = "accepted";
    const mismatchedCompleted = checkedExecutionStep(runId, { state: "completed", status: "pass", attempt: 1 });
    mismatchedCompleted.status = "rejected";
    const partialDispatch = specialDispatch("merged-slice-repair", { closed: true });
    delete partialDispatch.closure_hash;
    const partialFence = prFence();
    delete partialFence.repository;
    const variants = [
      ["unknown post-PR phase", { post_pr: postPrFixture("future-phase", 0) }],
      ["invalid post-PR attempt", { post_pr: postPrFixture("observing", -1) }],
      ["active post-PR without PR authority", { post_pr: postPrFixture("observing", 1) }],
      ["mismatched claim hash", { steps: [badHashStep] }],
      ["duplicate claim-bearing verifiers", { steps: [duplicateClaim, structuredClone(duplicateClaim)] }],
      ["active claim on non-running work", { steps: [nonRunningClaim] }],
      ["completed claim status mismatch", { steps: [mismatchedCompleted] }],
      ["unknown validator verdict", { validator: { verdict: "MAYBE" } }],
      ["unknown security verdict", { security_review: { verdict: "WARN" } }],
      ["partial special dispatch", { special_builder_dispatch: partialDispatch }],
      ["partial slice dispatch", { slices: [{ id: "slice", status: "running", attempts: 1, dispatch_required: true, dispatch_claim_ref: "dispatch/claim.json" }] }],
      ["partial PR operation", { post_pr: postPrFixture("disabled", 0, { pr_operation: { operation_id: "partial" } }) }],
      ["partial successor PR fence", { steering: { pr_fence: partialFence } }],
    ];
    for (const [name, input] of variants) {
      let current;
      assert.doesNotThrow(() => { current = projectedCurrent(input, runId); }, name);
      assert.equal(current, "workflow state unknown", name);
    }
  });

  it("TUI-P17 keeps current terminal-safe and excludes credential, ref, and sidecar bytes", () => {
    const repo = tempDir();
    const runId = "tui-p17-terminal-safe";
    const secret = "dXNlcjpwYXNzd29yZA==";
    writeRun(repo, runId, {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      gates: {},
      slices: [{
        id: `worker\u001b[2J Authorization: Basic ${secret}`,
        status: "running",
        attempts: 1,
        review_ref: `reviews/${secret}.json`,
      }],
    });
    const sidecarDir = join(repo, ".opencode", "factory", runId, "dispatch");
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(join(sidecarDir, "unused.json"), `sidecar ${secret}\n`);

    const [run] = readRuns(findFactoryRoots(repo), { diagnostics: false });
    assert.equal(run.current, "worker\\u001B[2J Authorization: Basic [redacted] running a1");
    assert.equal(hasTerminalControl(run.current), false);
    assert.equal(run.current.includes(secret), false);
    assert.equal(run.current.includes("reviews/"), false);
    assert.equal(run.current.includes("sidecar"), false);
    cleanup(repo);
  });

  it("TUI-P18 preserves invalid fallback rows with current null under normal diagnostics", () => {
    const repo = tempDir();
    writeRawRun(repo, "bad-json-current", "{\n");
    writeRun(repo, "bad-phase-current", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      gates: {},
      post_pr: postPrFixture("unknown-phase", 0),
    });

    const runs = readRuns(findFactoryRoots(repo));
    for (const id of ["bad-json-current", "bad-phase-current"]) {
      const run = runs.find((candidate) => candidate.run_id === id);
      assert.equal(run.status, "invalid", id);
      assert.equal(run.current, null, id);
      assert.equal(run.diagnostic_classification, "invalid", id);
    }
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

  it("projects every freeform row field before it reaches the renderer", () => {
    const repo = tempDir();
    const secret = "Authorization: Basic dXNlcjpwYXNzd29yZA==";
    writeRun(repo, "projection-run", {
      run_id: secret,
      status: "running",
      mode: `headless\u001b[2J`,
      branch: secret,
      pr_url: `https://example.test/${secret}`,
      updated_at: `2026-07-05 ${secret}`,
      gates: { [secret]: { status: "pending" } },
      slices: [{ id: secret, status: "running", attempts: 1 }],
      steering: {
        pending: { id: secret, ref: secret, hash: secret, message_chars: 1, created_at: secret },
        boundary: { kind: secret, token: secret, generation: 1, created_at: secret },
        last_action: { kind: secret, token: secret, generation: 1, claimed_at: secret, outcome: secret, resolved_at: secret },
      },
      validator: { verdict: secret },
      terminal_result: { reason: secret },
    });

    const [run] = readRuns(findFactoryRoots(repo), { diagnostics: false });
    const serialized = JSON.stringify(run);

    assert.equal(serialized.includes("dXNlcjpwYXNzd29yZA=="), false, serialized);
    assert.equal(diagnosticStrings(run).some(hasTerminalControl), false);
    assert.equal(run.current, "PR created");
    for (const value of [run.run_id, run.gate, run.branch, run.pr_url, run.panel, run.terminal_reason, run.steering.pending.ref]) {
      assert.equal(value.includes("[redacted]"), true);
    }
    cleanup(repo);
  });

  it("bypasses freeform redaction only for validated diagnostic identity enums", () => {
    const secret = "Authorization: Basic dXNlcjpwYXNzd29yZA==";
    const projected = projectTuiDiagnosticData({
      status: "warning",
      severity: "warning",
      classification: "recoverable",
      summary: secret,
      items: [{
        condition: "stale-heartbeat",
        status: secret,
        severity: "warning",
        classification: "recoverable",
        message: `message ${secret}\u001b[2J`,
        evidence: { path: `/tmp/${secret}`, process_alive: null },
      }],
    });

    assert.equal(projected.status, "warning");
    assert.equal(projected.items[0].condition, "stale-heartbeat");
    assert.equal(projected.items[0].status, "Authorization: Basic [redacted]");
    assert.equal(JSON.stringify(projected).includes("dXNlcjpwYXNzd29yZA=="), false);
    assert.equal(diagnosticStrings(projected).some(hasTerminalControl), false);
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

  it("preserves a validated descriptive run ID that the freeform policy classifies as high entropy", () => {
    const repo = tempDir();
    const runId = "issue-69-planning-seeded-recovery";
    writeRun(repo, runId, { status: "running", updated_at: "2026-07-05T00:00:00Z", gates: {} });

    const [run] = readRuns(findFactoryRoots(repo), { diagnostics: false });

    assert.equal(run.run_id, runId);
    cleanup(repo);
  });

  it("preserves a validated descriptive branch that the freeform policy classifies as high entropy", () => {
    const repo = tempDir();
    const branch = "issue-69-single-slice-acceptance";
    writeRun(repo, "issue-69", { status: "running", updated_at: "2026-07-05T00:00:00Z", gates: {}, branch });

    const [run] = readRuns(findFactoryRoots(repo), { diagnostics: false });

    assert.equal(run.branch, branch);
    cleanup(repo);
  });

  it("redacts recognized credentials and embedded UUIDs even when they are matching run IDs", () => {
    const repo = tempDir();
    const ids = [
      "run-sk-abcdefghijklmnopqrstuvwx",
      "a-ask-abcdefghijklmnopqrst",
      "run-abcdef12-1234-5678-9012-abcdefabcdef",
      "eabcdef12-1234-5678-9012-abcdefabcdef",
      "run-abcdef0123456789abcdef0123456789",
    ];
    for (const runId of ids) writeRun(repo, runId, { status: "running", gates: {} });

    const runs = readRuns(findFactoryRoots(repo), { diagnostics: false });

    assert.equal(runs.length, ids.length);
    assert.equal(runs.every((run) => run.run_id === "[redacted]"), true);
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

  it("surfaces merged rows without review authority as invalid run state", () => {
    const repo = tempDir();
    writeRun(repo, "unverifiable", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      allow_invalid_slice_authority: true,
      slices: [{ id: "merged-without-proof", status: "merged", attempts: 1 }],
    });

    const [run] = readRuns(findFactoryRoots(repo));

    assert.equal(run.run_id, "unverifiable");
    assert.equal(run.status, "invalid");
    assert.equal(run.diagnostics.items[0]?.condition, "invalid-run-state");
    cleanup(repo);
  });

  it("projects stale heartbeat diagnostics without hidden lease fields", () => {
    const repo = tempDir();
    writeRun(repo, "heartbeat-run", {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      gates: {},
      slices: [{ id: "slice", declared_paths: ["slice.txt"], effective_paths: ["slice.txt"], status: "running", attempts: 1 }],
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
    schema_version: 1,
    run_id: input.run_id === undefined ? id : input.run_id,
    status: input.status,
    updated_at: input.updated_at,
    gates: input.gates === undefined ? { story: { status: "pending" } } : input.gates,
  };
  if (input.mode !== undefined) run.mode = input.mode;
  if (input.branch !== undefined) run.branch = input.branch;
  if (input.pr_url !== undefined) run.pr_url = input.pr_url;
  if (input.review_tier !== undefined) run.review_tier = input.review_tier;
  if (input.slices !== undefined) {
    run.slices = input.slices.map((slice) => {
      const attempts = slice.attempts === undefined ? (slice.status === "pending" ? 0 : 1) : slice.attempts;
      const authority = ["review", "merged"].includes(slice.status) && input.allow_invalid_slice_authority !== true
        ? tuiSliceAuthority(slice.id, slice.status, attempts)
        : {};
      return {
        ...slice,
        attempts,
        ...authority,
        ...(slice.status === "blocked" && slice.blocked_reason === undefined ? { blocked_reason: "blocked fixture" } : {}),
      };
    });
  }
  if (input.steps !== undefined) run.steps = input.steps;
  if (input.validator !== undefined) run.validator = input.validator;
  if (input.security_review !== undefined) run.security_review = input.security_review;
  if (input.special_builder_dispatch !== undefined) run.special_builder_dispatch = input.special_builder_dispatch;
  if (input.steering !== undefined) run.steering = input.steering;
  if (input.post_pr !== undefined) run.post_pr = input.post_pr;
  if (input.cost_attribution !== undefined) run.cost_attribution = input.cost_attribution;
  if (input.terminal_result !== undefined) run.terminal_result = input.terminal_result;
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

function tuiSliceAuthority(id, status, attempt) {
  const evidenceRef = `evidence/${id}.json`;
  const reviewRef = `reviews/${id}.json`;
  const evidenceHash = `sha256:${"a".repeat(64)}`;
  const reviewHash = `sha256:${"b".repeat(64)}`;
  const reviewedCommit = "c".repeat(40);
  return {
    attempt_reviews: [{ attempt, evidence_ref: evidenceRef, evidence_hash: evidenceHash, review_ref: reviewRef, review_hash: reviewHash, reviewed_commit: reviewedCommit, diff_base_commit: reviewedCommit, ratified_paths: [], verdict: "APPROVE", convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0 }],
    evidence_ref: evidenceRef,
    evidence_hash: evidenceHash,
    review_ref: reviewRef,
    review_hash: reviewHash,
    reviewed_commit: reviewedCommit,
    ...(status === "merged" ? { merge_commit: reviewedCommit } : {}),
  };
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

function projectedCurrent(input, runId = "tui-phase-projection") {
  const repo = tempDir();
  try {
    writeRun(repo, runId, {
      status: "running",
      updated_at: "2026-07-05T00:00:00Z",
      gates: {},
      ...input,
    });
    return readRuns(findFactoryRoots(repo), { diagnostics: false })[0].current;
  } finally {
    cleanup(repo);
  }
}

function checkedExecutionStep(runId, { state, status = null, attempt = 1 } = {}) {
  const claim = {
    schema_version: 1,
    kind: "checked-test-execution-claim",
    state,
    nonce: "123e4567-e89b-42d3-a456-426614174000",
    run_id: runId,
    attempt,
    plan_ref: "plan/slices.json",
    plan_hash: `sha256:${"1".repeat(64)}`,
    head_sha: "2".repeat(40),
    timeout_ms: 600000,
    receipt_ref: `evidence/test-verifier.attempt-${attempt}.json`,
    claimed_at: "2026-07-05T00:00:00.000Z",
  };
  if (state === "unknown") {
    claim.failed_at = "2026-07-05T00:01:00.000Z";
    claim.reason = "process-outcome-indeterminate";
  }
  if (state === "completed") {
    claim.completed_at = "2026-07-05T00:01:00.000Z";
    claim.status = status;
    claim.receipt_hash = `sha256:${"3".repeat(64)}`;
  }
  const stepStatus = state === "completed" ? status === "pass" ? "accepted" : "rejected" : "running";
  return {
    agent: "test-verifier",
    status: stepStatus,
    attempts: attempt,
    execution_claim: claim,
    execution_claim_hash: hashValue(claim),
  };
}

function claimBoundSlice(id, attempts) {
  return {
    id,
    status: "running",
    attempts,
    dispatch_required: true,
    dispatch_claim_ref: `dispatch/${"4".repeat(64)}.json`,
    dispatch_claim_hash: `sha256:${"5".repeat(64)}`,
  };
}

function specialDispatch(route, { closed = false } = {}) {
  return {
    schema_version: 1,
    route,
    instance: `${route}:fixture`,
    agent: "frontend-builder",
    claim_ref: `dispatch/${"6".repeat(64)}.special.json`,
    claim_hash: `sha256:${"7".repeat(64)}`,
    ...(closed ? {
      closure_ref: `dispatch/${"6".repeat(64)}.special.closed.json`,
      closure_hash: `sha256:${"8".repeat(64)}`,
      completion_head: "9".repeat(40),
    } : {}),
  };
}

function postPrFixture(phase, attempt, overrides = {}) {
  return {
    schema_version: 1,
    policy: {
      enabled: phase !== "disabled",
      wait_ms: 3600000,
      initial_poll_ms: 30000,
      max_poll_ms: 120000,
      check_start_grace_ms: 300000,
      max_transient_errors: 12,
      review: { required: false, reviewer_login: null, source: "none" },
    },
    phase,
    attempt,
    observation: null,
    remediation: null,
    evidence_refs: [],
    continuation_review: null,
    terminal_fact: null,
    pr_operation: null,
    ...overrides,
  };
}

function prOperation() {
  return {
    operation_id: `ffpr-v1-${"a".repeat(64)}`,
    repository: "example/repo",
    created_at: "2026-07-05T00:00:00.000Z",
    head_ref: "feature",
    head_sha: "b".repeat(40),
    base_ref: "main",
    base_sha: "c".repeat(40),
    draft: false,
    pr_url: "https://github.com/example/repo/pull/1",
    pr_number: 1,
    pr_node_id: "PR_fixture",
  };
}

function prFence() {
  return {
    token: "fence-token",
    generation: 0,
    state_hash: `sha256:${"d".repeat(64)}`,
    created_at: "2026-07-05T00:00:00.000Z",
    operation_id: `ffpr-v1-${"a".repeat(64)}`,
    repository: "example/repo",
    head_ref: "feature",
    head_sha: "b".repeat(40),
    base_ref: "main",
    base_sha: "c".repeat(40),
    draft: false,
  };
}

function legacyPrFence() {
  const fence = prFence();
  for (const key of ["operation_id", "repository", "head_ref", "head_sha", "base_ref", "base_sha", "draft"]) delete fence[key];
  return fence;
}

function combineProjectionInputs(...inputs) {
  const combined = {};
  for (const input of inputs) {
    if (!input) continue;
    for (const [key, value] of Object.entries(input)) {
      if (key === "steps" || key === "slices") combined[key] = [...(combined[key] || []), ...value];
      else if (key === "gates" || key === "steering") combined[key] = { ...(combined[key] || {}), ...value };
      else combined[key] = value;
    }
  }
  return combined;
}

describe("process activity projection", () => {
  const NOW = Date.parse("2026-07-27T18:20:00.000Z");
  const FRESH = "2026-07-27T18:19:30.000Z"; // 30s old
  const STALE = "2026-07-27T18:10:00.000Z"; // 10m old

  function fixture({ processState, lastTick, intervalMs, evidence = {} }) {
    const root = mkdtempSync(join(tmpdir(), "tui-process-activity-"));
    const runDir = join(root, ".opencode", "factory", "run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ schema_version: 1, run_id: "run-1", status: "running" }));
    if (lastTick) {
      writeFileSync(join(runDir, "heartbeat.json"), JSON.stringify({
        schema_version: 1, run_id: "run-1", last_tick_at: lastTick,
        ...(intervalMs === undefined ? {} : { interval_ms: intervalMs }),
      }));
    }
    const record = processState === null
      ? { ok: false, missing: true, reason: "missing process evidence", evidence: null }
      : { ok: true, missing: false, reason: null, evidence: { state: processState, updated_at: "2026-07-27T18:03:37.722Z", log_ref: "processes/run-1.log", ...evidence } };
    return { root, factoryRoot: join(root, ".opencode", "factory"), record };
  }

  function activity({ processState, lastTick, verify, evidence, intervalMs }) {
    const f = fixture({ processState, lastTick, intervalMs, evidence });
    try {
      const [row] = readRuns([f.factoryRoot], {
        diagnostics: false,
        now: () => NOW,
        readProcessRecord: () => f.record,
        verifyProcess: () => verify ?? null,
      });
      return row.process;
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }

  it("reports a stopped run when the process exited and the heartbeat is stale", () => {
    // The issue-110 shape: process.json recorded `exited` at the moment ticking
    // stopped, but the only operator signal was a lingering stale-heartbeat warning.
    const projected = activity({ processState: "exited", lastTick: STALE });
    assert.equal(projected.classification, "stopped");
    assert.match(projected.detail, /process exited/u);
    assert.match(projected.log_ref, /processes\/run-1\.log/u);
  });

  it("reports work in progress when the heartbeat is stale but the process verifies live", () => {
    // Single model calls run 10-20+ minutes, so a stale heartbeat over a live
    // process is normal operation and must not read as a failure.
    for (const status of ["live", "live-and-matching"]) {
      const projected = activity({ processState: "running", lastTick: STALE, verify: status });
      assert.equal(projected.classification, "working", status);
      assert.match(projected.detail, /verified live/u);
    }
  });

  it("reports an orphan when the heartbeat is stale and the process is absent or reused", () => {
    assert.equal(activity({ processState: "running", lastTick: STALE, verify: "absent" }).classification, "orphaned");
    assert.equal(activity({ processState: "running", lastTick: STALE, verify: "mismatched" }).classification, "orphaned");
  });

  it("reports unknown rather than guessing when liveness is indeterminate", () => {
    for (const status of ["indeterminate", null]) {
      const projected = activity({ processState: "running", lastTick: STALE, verify: status });
      assert.equal(projected.classification, "unknown", String(status));
      assert.match(projected.detail, /indeterminate/u);
    }
  });

  it("flags a heartbeat that outlives its process", () => {
    const projected = activity({ processState: "exited", lastTick: FRESH });
    assert.equal(projected.classification, "heartbeat-orphaned");
    assert.match(projected.detail, /still ticks/u);
  });

  it("treats every non-running recorded state as stopped", () => {
    for (const state of ["cancelled", "failed-closed", "exited"]) {
      assert.equal(activity({ processState: state, lastTick: STALE }).classification, "stopped", state);
    }
  });

  it("reports a healthy run while the heartbeat is current", () => {
    const projected = activity({ processState: "running", lastTick: FRESH });
    assert.equal(projected.classification, "running");
    assert.equal(projected.state, "running");
  });

  it("treats a missing heartbeat as stale so a dead run cannot look healthy", () => {
    assert.equal(activity({ processState: "exited", lastTick: null }).classification, "stopped");
  });

  it("omits the projection when the run has no process record", () => {
    assert.equal(activity({ processState: null, lastTick: FRESH }), null);
  });

  it("derives staleness from interval_ms exactly as run-state does", () => {
    // run-state's inspectHeartbeatLiveness uses max(2 * interval_ms,
    // MIN_STALE_HEARTBEAT_MS). Hardcoding only the 120s floor made a current
    // heartbeat look stale for any interval above 60s, which then probed the
    // process and reported working/orphaned while run-state still called it fresh.
    const tick = (msAgo) => new Date(NOW - msAgo).toISOString();

    // interval 300s -> threshold 600s: a 5-minute-old tick is still fresh.
    assert.equal(
      activity({ processState: "running", lastTick: tick(300000), intervalMs: 300000 }).classification,
      "running",
    );
    // ...and the same tick with the default interval is stale, since the 120s floor governs.
    assert.equal(
      activity({ processState: "running", lastTick: tick(300000), verify: "absent" }).classification,
      "orphaned",
    );

    // Boundary: threshold is exactly 2 * interval when that exceeds the floor.
    assert.equal(
      activity({ processState: "running", lastTick: tick(179000), intervalMs: 90000 }).classification,
      "running",
      "just inside 2 * 90s",
    );
    assert.equal(
      activity({ processState: "running", lastTick: tick(181000), intervalMs: 90000, verify: "absent" }).classification,
      "orphaned",
      "just outside 2 * 90s",
    );

    // Floor still applies when 2 * interval is below it (2 * 30s < 120s).
    assert.equal(
      activity({ processState: "running", lastTick: tick(119000), intervalMs: 30000 }).classification,
      "running",
    );
    // An invalid interval falls back to the default rather than trusting the record.
    assert.equal(
      activity({ processState: "running", lastTick: tick(119000), intervalMs: -5 }).classification,
      "running",
    );
  });

  it("reads a real process record without injection", () => {
    // Guards the production path: the cases above inject the record, so this
    // one writes a process.json shaped like a real run's and exercises
    // readProcessEvidence itself.
    const root = mkdtempSync(join(tmpdir(), "tui-process-real-"));
    const runDir = join(root, ".opencode", "factory", "run-1");
    mkdirSync(join(runDir, "processes"), { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ schema_version: 1, run_id: "run-1", status: "running" }));
    writeFileSync(join(runDir, "heartbeat.json"), JSON.stringify({ schema_version: 1, run_id: "run-1", last_tick_at: STALE }));
    writeFileSync(join(runDir, "processes", "p.log"), "log\n");
    writeFileSync(join(runDir, "process.json"), JSON.stringify({
      schema_version: 1, kind: "opencode-process", run_id: "run-1",
      execution_id: "7e414401-90d0-4d1c-b084-6969fc009347", pid: 8117,
      started_at: "2026-07-27T15:40:26.150Z", updated_at: "2026-07-27T18:03:37.722Z",
      state: "exited", cwd: root,
      identity: { inspector: "node-process", start_marker: "darwin-ps:x", command_name: "opencode" },
      log_ref: "processes/p.log", cancel: null,
    }));
    try {
      const [row] = readRuns([join(root, ".opencode", "factory")], { diagnostics: false, now: () => NOW });
      assert.equal(row.process.classification, "stopped");
      assert.equal(row.process.state, "exited");
      assert.equal(row.process.log_ref, "processes/p.log");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports unknown when the process record is unreadable", () => {
    const f = fixture({ processState: "running", lastTick: FRESH });
    try {
      const [row] = readRuns([f.factoryRoot], {
        diagnostics: false,
        now: () => NOW,
        readProcessRecord: () => ({ ok: false, missing: false, reason: "invalid process evidence", evidence: null }),
      });
      assert.equal(row.process.classification, "unknown");
      assert.match(row.process.detail, /unreadable/u);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
