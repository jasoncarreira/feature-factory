import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  renderDiagnosticLine,
  renderFreeformText,
  renderHiddenRunsLine,
  renderRunMode,
  renderRunStatus,
  renderProcessLine,
  renderRunTextFields,
} from "../src/tui-rendering.js";

const SECRET = "Authorization: Basic dXNlcjpwYXNzd29yZA==";

describe("TUI renderer hardening seam", () => {
  it("preserves the existing line shapes and limits for ordinary rows", () => {
    const rendered = renderRunTextFields({
      run_id: "diagnostics-tui",
      status: "running",
      mode: "headless",
      gate: "story",
      current: "frontend-builder running a1",
      steering: { pending: { ref: "steering/pending.json" } },
      slices: { merged: 2, blocked: 1, total: 5 },
      cost: { status: "available", entry_count: 1, missing: [], label: "cost available · 1 entry" },
      panel: "GO / PASS",
      pr_url: "https://example.test/pull/54",
      terminal_reason: "waiting",
      diagnostic_classification: "recoverable",
      diagnostic_summary: "Heartbeat is stale.",
      branch: "diagnostics-tui",
    });

    assert.deepEqual(rendered, {
      run_id: "diagnostics-tui",
      status_line: "running | headless",
      gate_line: "gate: story",
      current_line: "current: frontend-builder running a1",
      steering_line: "steering pending: steering/pending.json",
      slices_line: "slices: 2/5 | blocked 1",
      cost_line: "cost available · 1 entry",
      panel_line: "panel: GO / PASS",
      pr_line: "PR: https://example.test/pull/54",
      terminal_reason_line: "reason: waiting",
      // Ordinary rows carry no process record, so the line stays absent.
      process_line: null,
      diagnostic_line: "diagnostic: recoverable: Heartbeat is stale.",
      branch_line: "branch: diagnostics-tui",
    });
    assert.equal(renderHiddenRunsLine(4), "+ 4 more runs");
    assert.equal(renderRunTextFields({ run_id: "cleanup-sweep-integration-continuation", status: "running" }).run_id, "cleanup-sweep-integration-co...");
    assert.equal(renderRunTextFields({ run_id: "run-sk-abcdefghijklmnopqrstuvwx", status: "running" }).run_id, "[redacted]");
    assert.equal(renderRunTextFields({ run_id: "a-ask-abcdefghijklmnopqrst", status: "running" }).run_id, "[redacted]");
    assert.equal(renderRunTextFields({ run_id: "run-abcdef12-1234-5678-9012-abcdefabcdef", status: "running" }).run_id, "[redacted]");
    assert.equal(renderRunTextFields({ run_id: "eabcdef12-1234-5678-9012-abcdefabcdef", status: "running" }).run_id, "[redacted]");
    assert.equal(renderRunTextFields({ run_id: "run-abcdef0123456789abcdef0123456789", status: "running" }).run_id, "[redacted]");
    assert.equal(
      renderRunTextFields({ run_id: "issue-69", status: "running", branch: "issue-69-single-slice-acceptance" }).branch_line,
      "branch: issue-69-single-slice-accep...",
    );
    assert.equal(
      renderRunTextFields({
        run_id: "issue-69",
        status: "running",
        steering: { pending: { ref: "steering/pending-2026-07-13T20-55-19-210Z-a21cdd76-6c04-41c6-a890-7403236e8313.json" } },
      }).steering_line,
      "steering pending: steering/pending-2026-07-13T20-...",
    );
  });

  it("reprojects every dynamic child, validates identity enums, and truncates after encoding", () => {
    const hostile = `${SECRET}\u001b[2J\u001b]0;pwned\u0007`;
    const rendered = renderRunTextFields({
      run_id: hostile,
      status: hostile,
      mode: hostile,
      gate: hostile,
      current: hostile,
      steering: { latest_consumed: { ref: hostile }, consumed_count: 2 },
      slices: { merged: 1, blocked: 1, total: 2 },
      cost: { label: hostile },
      panel: hostile,
      pr_url: hostile,
      terminal_reason: hostile,
      diagnostic_classification: hostile,
      diagnostic_summary: hostile,
      branch: hostile,
    });

    for (const value of Object.values(rendered).filter((item) => typeof item === "string")) {
      assert.equal(value.includes("dXNlcjpwYXNzd29yZA=="), false);
      assert.equal(hasTerminalControl(value), false);
    }
    assert.equal(rendered.run_id.includes("[red"), true);
    assert.equal(rendered.status_line.includes("[redacted]"), true);
    assert.equal(renderRunStatus("running"), "running");
    assert.equal(renderRunMode("headless"), "headless");
    assert.equal(renderRunStatus(hostile), "Authorization: Basic [redacted]\\u001B[2J\\u001B]0;pwned\\u0007");
    assert.equal(renderDiagnosticLine({ diagnostic_classification: "recoverable", diagnostic_summary: hostile }), "recoverable: Authorization: Basic [reda...");
    assert.equal(renderFreeformText(`safe\u001b[2Jtail`, 10), "safe\\u0...");
  });

  it("keeps the PR #54 sidebar contract in the final JSX seam", () => {
    const source = readFileSync(new URL("../src/tui.jsx", import.meta.url), "utf8");

    assert.match(source, /<box flexDirection="column" flexGrow=\{1\} flexShrink=\{1\} minHeight=\{0\} overflow="hidden">/u);
    assert.match(source, /fallback=\{<text fg=\{theme\(\)\.textMuted\}>No factory runs yet<\/text>\}/u);
    assert.doesNotMatch(source, /sidebar v|plugin changes need TUI restart|version label/iu);
    assert.match(source, /renderRunTextFields\(run\)/u);
  });
});

function hasTerminalControl(value) {
  return /[\u0000-\u001F\u007F-\u009F]/u.test(value);
}

describe("process line rendering", () => {
  it("stays silent for a healthy running process", () => {
    // A running process with a current heartbeat is the normal case; adding a
    // line for it would be noise, and the absent/unknown classifications are
    // what the operator is actually looking for.
    assert.equal(renderProcessLine({ classification: "running", detail: "process running, heartbeat current" }), null);
    assert.equal(renderProcessLine(null), null);
    assert.equal(renderProcessLine({ classification: "not-a-classification", detail: "x" }), null);
  });

  it("labels every actionable classification", () => {
    const cases = {
      stopped: /^process stopped: /u,
      working: /^working \(heartbeat stale\): /u,
      orphaned: /^process gone \(heartbeat stale\): /u,
      "heartbeat-orphaned": /^heartbeat outlived process: /u,
      unknown: /^process state unknown: /u,
    };
    for (const [classification, pattern] of Object.entries(cases)) {
      assert.match(renderProcessLine({ classification, detail: "detail text" }), pattern, classification);
    }
  });
});
