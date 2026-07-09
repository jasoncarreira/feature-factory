import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_COST_ATTRIBUTION_ENTRIES,
  appendCostAttributionEntry,
  formatCostAttributionSummary,
  normalizeCostUsageEntry,
  publicCostAttributionSummary,
  recomputeCostAttribution,
  rollupBy,
  rollupEntries,
} from "../src/cost-attribution.js";

const NOW = "2026-07-08T12:00:00.000Z";
const TERMINAL_CURRENCY_PAYLOADS = Object.freeze([
  "USD\u001b]0;pwned\u0007",
  "USD\u001b[2J",
  "USD\u001b]52;c;U0VDUkVU\u0007",
]);

describe("cost attribution helpers", () => {
  it("normalizes entries and recomputes totals/by_agent/by_slice rollups", () => {
    const attribution = recomputeCostAttribution({ entries: [
      { id: "one", recorded_at: NOW, run_id: "run", agent: "backend-builder", slice_id: "be", provider: "opencode", model: "gpt-5.5", input_tokens: 100, output_tokens: 40, total_tokens: 140, cost_total: 0.21, cost_currency: "USD" },
      { id: "two", recorded_at: NOW, run_id: "run", agent: "test-verifier", slice_id: "qa", provider: "opencode", model: "gpt-5.5", input_tokens: 10, output_tokens: 5, total_tokens: 15, cost_total: 0.03, cost_currency: "USD" },
    ] }, { now: NOW });

    assert.equal(attribution.schema_version, 1);
    assert.equal(attribution.status, "available");
    assert.equal(attribution.totals.input_tokens, 110);
    assert.equal(attribution.totals.output_tokens, 45);
    assert.equal(attribution.totals.total_tokens, 155);
    assert.equal(attribution.totals.cost_total, 0.24);
    assert.equal(attribution.totals.cost_currency, "USD");
    assert.equal(attribution.by_agent["backend-builder"].total_tokens, 140);
    assert.equal(attribution.by_slice.be.cost_total, 0.21);
  });

  it("requires provider, model, usage, cost_total, and cost_currency for available entries", () => {
    const available = normalizeCostUsageEntry({ id: "available", recorded_at: NOW, run_id: "run", agent: "backend-builder", provider: "opencode", model: "gpt-5.5", input_tokens: 25, cost_total: 0.01, cost_currency: "USD" });
    assert.equal(available.status, "available");
    assert.deepEqual(available.missing, []);

    const partial = normalizeCostUsageEntry({ id: "partial", recorded_at: NOW, run_id: "run", agent: "backend-builder", input_tokens: 25, missing: ["output_tokens", "cost"] });
    assert.equal(partial.status, "partial");
    assert.equal(partial.output_tokens, undefined);
    assert.deepEqual(partial.missing, ["cost", "cost_currency", "cost_total", "model", "output_tokens", "provider"]);

    const unavailable = normalizeCostUsageEntry({ id: "none", recorded_at: NOW, run_id: "run", agent: "backend-builder" });
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.input_tokens, undefined);
    assert.deepEqual(unavailable.missing, ["cost_currency", "cost_total", "model", "provider", "usage"]);

    const attribution = recomputeCostAttribution({ entries: [partial, unavailable] }, { now: NOW });
    assert.equal(attribution.status, "partial");
    assert.equal(attribution.totals.input_tokens, 25);
    assert.equal(attribution.totals.output_tokens, undefined);
    assert.match(attribution.totals.missing.join(","), /cost/u);
  });

  it("rejects terminal control currency payloads during normalization", () => {
    for (const payload of TERMINAL_CURRENCY_PAYLOADS) {
      assert.throws(
        () => normalizeCostUsageEntry({ id: "bad", recorded_at: NOW, run_id: "run", agent: "backend-builder", provider: "opencode", model: "gpt-5.5", input_tokens: 1, cost_total: 0.01, cost_currency: payload }),
        /cost_currency must be an uppercase currency code \(3-12 letters\) with no control characters/u,
      );
      assert.throws(
        () => recomputeCostAttribution({ entries: [{ id: "bad", recorded_at: NOW, run_id: "run", agent: "backend-builder", input_tokens: 1, cost_total: 0.01, currency: payload }] }, { now: NOW }),
        /cost_currency must be an uppercase currency code \(3-12 letters\) with no control characters/u,
      );
    }
  });

  it("suppresses aggregate cost_total for mixed currencies", () => {
    const attribution = recomputeCostAttribution({ entries: [
      { id: "usd", recorded_at: NOW, run_id: "run", agent: "a", input_tokens: 1, cost_total: 0.01, cost_currency: "USD" },
      { id: "eur", recorded_at: NOW, run_id: "run", agent: "b", input_tokens: 1, cost_total: 0.02, cost_currency: "EUR" },
    ] }, { now: NOW });

    assert.equal(attribution.status, "partial");
    assert.equal(attribution.totals.mixed_currency, true);
    assert.equal(attribution.totals.cost_total, undefined);
    assert.equal(attribution.totals.cost_currency, undefined);
    assert.equal(attribution.by_agent.a.cost_total, 0.01);
  });

  it("rejects entries beyond the cap instead of truncating", () => {
    const entries = Array.from({ length: MAX_COST_ATTRIBUTION_ENTRIES + 3 }, (_, index) => ({
      id: `entry-${index}`,
      recorded_at: NOW,
      run_id: "run",
      agent: "backend-builder",
      input_tokens: index,
    }));

    assert.throws(
      () => recomputeCostAttribution({ entries }, { now: NOW }),
      /cost attribution entries must have at most 1000 entries/u,
    );

    const cappedEntries = entries.slice(0, MAX_COST_ATTRIBUTION_ENTRIES);
    const attribution = recomputeCostAttribution({ entries: cappedEntries }, { now: NOW });
    const beforeIds = attribution.entries.map((entry) => entry.id);

    assert.throws(
      () => appendCostAttributionEntry(attribution, { id: "overflow", recorded_at: NOW, run_id: "run", agent: "backend-builder", input_tokens: 1 }, { now: NOW }),
      /cost attribution entries must have at most 1000 entries/u,
    );

    assert.equal(attribution.entries.length, MAX_COST_ATTRIBUTION_ENTRIES);
    assert.equal(attribution.entries[0].id, "entry-0");
    assert.equal(attribution.entries.at(-1).id, `entry-${MAX_COST_ATTRIBUTION_ENTRIES - 1}`);
    assert.equal(attribution.totals.entry_count, MAX_COST_ATTRIBUTION_ENTRIES);
    assert.deepEqual(attribution.entries.map((entry) => entry.id), beforeIds);
  });

  it("overrides caller-supplied run_id with the locked run id", () => {
    const entry = normalizeCostUsageEntry({ id: "entry", recorded_at: NOW, run_id: "caller-run", agent: "backend-builder", provider: "opencode", model: "gpt-5.5", input_tokens: 1, cost_total: 0.01, cost_currency: "USD" }, { runId: "locked-run" });
    assert.equal(entry.run_id, "locked-run");

    const attribution = appendCostAttributionEntry(null, { run_id: "caller-run", agent: "backend-builder", provider: "opencode", model: "gpt-5.5", input_tokens: 1, cost_total: 0.01, cost_currency: "USD" }, { runId: "locked-run", now: NOW, id: "entry" });
    assert.equal(attribution.entries[0].run_id, "locked-run");
  });

  it("rolls up arbitrary valid agent and slice keys safely", () => {
    const attribution = recomputeCostAttribution({ entries: [
      { id: "proto", recorded_at: NOW, run_id: "run", agent: "__proto__", slice_id: "__proto__", provider: "opencode", model: "gpt-5.5", input_tokens: 1, cost_total: 0.01, cost_currency: "USD" },
    ] }, { now: NOW });

    assert.equal(Object.prototype.hasOwnProperty.call(attribution.by_agent, "__proto__"), true);
    assert.equal(Object.prototype.hasOwnProperty.call(attribution.by_slice, "__proto__"), true);
    assert.equal(attribution.by_agent["__proto__"].cost_total, 0.01);
    assert.equal(attribution.by_slice["__proto__"].entry_count, 1);
  });

  it("groups on exact raw identities without sanitizer collisions", () => {
    const entries = ["agent", " agent ", "agent\nx", "agent x", "__proto__"].map((agent) => ({
      agent,
      status: "partial",
      missing: ["cost_total"],
      input_tokens: 1,
    }));

    const groups = rollupBy(entries, "agent");

    assert.deepEqual(Object.keys(groups), ["agent", " agent ", "agent\nx", "agent x", "__proto__"]);
    for (const agent of Object.keys(groups)) assert.equal(groups[agent].entry_count, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(groups, "__proto__"), true);
  });

  it("skips null numeric fields defensively while preserving explicit zero and partial status", () => {
    const nullEntry = Object.fromEntries([
      ...["input_tokens", "output_tokens", "total_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "reasoning_tokens"],
      ...["cost_total", "cost_input", "cost_output", "cost_cache_creation", "cost_cache_read"],
    ].map((field) => [field, null]));
    const rollup = rollupEntries([
      { status: "partial", missing: ["usage"], ...nullEntry },
      { status: "available", missing: [], input_tokens: 0, cost_total: 0, cost_currency: "USD" },
    ]);

    assert.equal(rollup.status, "partial");
    assert.equal(rollup.input_tokens, 0);
    assert.equal(rollup.cost_total, 0);
    assert.equal(rollup.cost_currency, "USD");
    assert.equal(rollup.output_tokens, undefined);
    assert.deepEqual(rollup.missing, ["usage"]);
  });

  it("appends one entry and exposes a compact public summary", () => {
    const attribution = appendCostAttributionEntry(null, { agent: "backend-builder", provider: "opencode", model: "gpt-5.5", input_tokens: 2, output_tokens: 3, total_tokens: 5, cost_total: 0.005, cost_currency: "USD" }, { runId: "run", now: NOW, id: "entry" });
    const summary = publicCostAttributionSummary(attribution);

    assert.equal(summary.status, "available");
    assert.equal(summary.entry_count, 1);
    assert.equal(summary.total_tokens, 5);
    assert.equal(formatCostAttributionSummary(attribution), "cost available · 1 entry · 5 tokens · 0.005 USD");
  });

  it("sanitizes public summaries from legacy terminal-control metadata", () => {
    const attribution = {
      updated_at: `${NOW}\u001b[2J`,
      status: "available\u001b[2J",
      totals: {
        status: "available",
        entry_count: 1,
        request_count: 1,
        missing: ["provider\u001b]0;pwned\u0007"],
        mixed_currency: false,
        cost_total: 0.02,
        cost_currency: "USD\u001b]52;c;U0VDUkVU\u0007",
      },
    };

    const summary = publicCostAttributionSummary(attribution);
    const label = formatCostAttributionSummary(attribution);

    assert.equal(summary.status, "available");
    assert.equal(summary.cost_currency, undefined);
    assert.equal(hasTerminalControl(summary.updated_at), false);
    assert.equal(hasTerminalControl(summary.missing.join(",")), false);
    assert.equal(hasTerminalControl(label), false);
  });
});

function hasTerminalControl(value) {
  return /[\u0000-\u001F\u007F-\u009F]/u.test(value);
}
