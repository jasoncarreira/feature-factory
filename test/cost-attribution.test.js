import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_COST_ATTRIBUTION_ENTRIES,
  appendCostAttributionEntry,
  formatCostAttributionSummary,
  normalizeCostUsageEntry,
  publicCostAttributionSummary,
  recomputeCostAttribution,
} from "../src/cost-attribution.js";

const NOW = "2026-07-08T12:00:00.000Z";

describe("cost attribution helpers", () => {
  it("normalizes entries and recomputes totals/by_agent/by_slice rollups", () => {
    const attribution = recomputeCostAttribution({ entries: [
      { id: "one", recorded_at: NOW, run_id: "run", agent: "backend-builder", slice_id: "be", input_tokens: 100, output_tokens: 40, total_tokens: 140, cost_total: 0.21, cost_currency: "USD" },
      { id: "two", recorded_at: NOW, run_id: "run", agent: "test-verifier", slice_id: "qa", input_tokens: 10, output_tokens: 5, total_tokens: 15, cost_total: 0.03, cost_currency: "USD" },
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

  it("marks missing usage/cost metadata as partial or unavailable without zero filling", () => {
    const partial = normalizeCostUsageEntry({ id: "partial", recorded_at: NOW, run_id: "run", agent: "backend-builder", input_tokens: 25, missing: ["output_tokens", "cost"] });
    assert.equal(partial.status, "partial");
    assert.equal(partial.output_tokens, undefined);
    assert.deepEqual(partial.missing, ["cost", "output_tokens"]);

    const unavailable = normalizeCostUsageEntry({ id: "none", recorded_at: NOW, run_id: "run", agent: "backend-builder" });
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.input_tokens, undefined);
    assert.deepEqual(unavailable.missing, ["usage", "cost"]);

    const attribution = recomputeCostAttribution({ entries: [partial, unavailable] }, { now: NOW });
    assert.equal(attribution.status, "partial");
    assert.equal(attribution.totals.input_tokens, 25);
    assert.equal(attribution.totals.output_tokens, undefined);
    assert.match(attribution.totals.missing.join(","), /cost/u);
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

  it("bounds retained entries to the latest 1000", () => {
    const entries = Array.from({ length: MAX_COST_ATTRIBUTION_ENTRIES + 3 }, (_, index) => ({
      id: `entry-${index}`,
      recorded_at: NOW,
      run_id: "run",
      agent: "backend-builder",
      input_tokens: index,
    }));

    const attribution = recomputeCostAttribution({ entries }, { now: NOW });

    assert.equal(attribution.entries.length, MAX_COST_ATTRIBUTION_ENTRIES);
    assert.equal(attribution.entries[0].id, "entry-3");
    assert.equal(attribution.totals.entry_count, MAX_COST_ATTRIBUTION_ENTRIES);
  });

  it("appends one entry and exposes a compact public summary", () => {
    const attribution = appendCostAttributionEntry(null, { agent: "backend-builder", input_tokens: 2, output_tokens: 3, total_tokens: 5, cost_total: 0.005, cost_currency: "USD" }, { runId: "run", now: NOW, id: "entry" });
    const summary = publicCostAttributionSummary(attribution);

    assert.equal(summary.status, "available");
    assert.equal(summary.entry_count, 1);
    assert.equal(summary.total_tokens, 5);
    assert.equal(formatCostAttributionSummary(attribution), "cost available · 1 entry · 5 tokens · 0.005 USD");
  });
});
