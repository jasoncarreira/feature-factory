import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCostReport,
  costReportTelemetryCorrelation,
  encodeCostReportDisplayLabel,
  formatCostReport,
  serializeCostReport,
} from "../src/cost-report.js";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const NUMERIC_FIELDS = [
  "input_tokens", "output_tokens", "total_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "reasoning_tokens",
  "cost_total", "cost_input", "cost_output", "cost_cache_creation", "cost_cache_read",
];

describe("cost report domain", () => {
  it("returns the exact unavailable report for absent and entry-less attribution", () => {
    const expected = {
      schema_version: 1,
      run_id: "run-123",
      status: "unavailable",
      entry_count: 0,
      request_count: 0,
      agent_count: 0,
      step_count: 0,
      slice_count: 0,
      unattributed_step_entry_count: 0,
      totals: {
        status: "unavailable",
        entry_count: 0,
        request_count: 0,
        mixed_currency: false,
        missing: ["entries"],
      },
      by_agent: {},
      by_step: {},
      by_slice: {},
    };

    for (const attribution of [undefined, null, {}, { entries: undefined }, { entries: null }, { entries: [] }]) {
      assert.deepEqual(buildCostReport("run-123", attribution), expected);
    }
    assert.equal(formatCostReport(expected), [
      "Cost report for run-123",
      "Totals:",
      "  status=unavailable | entries=0 | requests=0 | mixed_currency=false | missing=\"entries\"",
      "By agent (0):",
      "  (none)",
      "By step (0; unattributed entries=0):",
      "  (none)",
      "By slice (0):",
      "  (none)",
    ].join("\n"));
  });

  it("recomputes all views from entries and ignores stale persisted caches", () => {
    const entries = [
      availableEntry({ id: "one", agent: "backend-builder", step: "build", slice_id: "be", input_tokens: 10, output_tokens: 2, total_tokens: 12, cost_total: 0.1 }),
      partialEntry({ id: "two", agent: "backend-builder", slice_id: "be", input_tokens: 3 }),
      unavailableEntry({ id: "three", agent: "test-verifier", step: "test" }),
    ];
    const attribution = {
      entries,
      status: "available",
      totals: { status: "available", entry_count: 99, cost_total: 999 },
      by_agent: { stale: { entry_count: 99 } },
      by_slice: { stale: { entry_count: 99 } },
    };

    const report = buildCostReport("run-123", attribution);

    assert.equal(report.status, "partial");
    assert.equal(report.entry_count, 3);
    assert.equal(report.request_count, 3);
    assert.equal(report.agent_count, 2);
    assert.equal(report.step_count, 2);
    assert.equal(report.slice_count, 1);
    assert.equal(report.unattributed_step_entry_count, 1);
    assert.equal(report.totals.input_tokens, 13);
    assert.equal(report.totals.cost_total, 0.1);
    assert.equal(report.by_agent["backend-builder"].entry_count, 2);
    assert.equal(report.by_step.build.total_tokens, 12);
    assert.equal(report.by_step.test.status, "unavailable");
    assert.equal(report.by_slice.be.entry_count, 2);
    assert.equal(report.by_agent.stale, undefined);
  });

  it("preserves every numeric field, explicit zero, and null-as-absence without mutating entries", () => {
    const allValues = Object.fromEntries(NUMERIC_FIELDS.map((field, index) => [field, index]));
    const zeroEntry = availableEntry({ id: "zero", ...allValues });
    const nullEntry = partialEntry({
      id: "null",
      missing: ["usage", "cost_total"],
      ...Object.fromEntries(NUMERIC_FIELDS.map((field) => [field, null])),
    });
    const before = structuredClone(nullEntry);

    const combined = buildCostReport("run-123", { entries: [zeroEntry, nullEntry] });
    for (const [index, field] of NUMERIC_FIELDS.entries()) assert.equal(combined.totals[field], index, field);
    assert.equal(combined.status, "partial");
    assert.deepEqual(nullEntry, before);

    const nullOnly = buildCostReport("run-123", { entries: [nullEntry] });
    for (const field of NUMERIC_FIELDS) assert.equal(Object.hasOwn(nullOnly.totals, field), false, field);
    assert.equal(nullOnly.status, "partial");
  });

  it("preserves raw identity groups, collision pairs, and safe __proto__ keys", () => {
    const identities = ["agent", " agent ", "agent\nx", "agent x", String.raw`agent\nx`, "__proto__"];
    const entries = identities.map((agent, index) => availableEntry({
      id: `entry-${index}`,
      agent,
      step: agent,
      slice_id: agent,
    }));

    const report = buildCostReport("run-123", { entries });

    assert.deepEqual(Object.keys(report.by_agent), identities);
    assert.deepEqual(Object.keys(report.by_step), identities);
    assert.deepEqual(Object.keys(report.by_slice), identities);
    assert.equal(Object.prototype.hasOwnProperty.call(report.by_agent, "__proto__"), true);
    assert.equal(report.by_agent["agent\nx"].entry_count, 1);
    assert.equal(report.by_agent[String.raw`agent\nx`].entry_count, 1);
  });

  it("excludes missing, null, empty, and whitespace-only steps and counts them", () => {
    const entries = [
      availableEntry({ id: "missing" }),
      availableEntry({ id: "null", step: null }),
      availableEntry({ id: "empty", step: "" }),
      availableEntry({ id: "blank", step: " \t " }),
      availableEntry({ id: "build", step: "build" }),
    ];
    const report = buildCostReport("run-123", { entries });

    assert.deepEqual(Object.keys(report.by_step), ["build"]);
    assert.equal(report.unattributed_step_entry_count, 4);
  });

  it("preserves available, partial, and unavailable rollup status semantics", () => {
    const cases = [
      { entries: [availableEntry()], status: "available" },
      { entries: [partialEntry()], status: "partial" },
      { entries: [unavailableEntry()], status: "unavailable" },
      { entries: [availableEntry(), unavailableEntry({ id: "u" })], status: "partial" },
      { entries: [availableEntry(), partialEntry({ id: "p" })], status: "partial" },
    ];
    for (const item of cases) {
      const report = buildCostReport("run-123", { entries: item.entries });
      assert.equal(report.status, item.status);
      assert.equal(report.totals.status, item.status);
    }
  });

  it("detects cross-field mixed currencies in totals and every dimension while retaining components", () => {
    const report = buildCostReport("run-123", { entries: [
      availableEntry({ id: "usd", agent: "same", step: "same", slice_id: "same", cost_total: 0.1, cost_input: 0.04, cost_currency: "USD" }),
      partialEntry({ id: "eur", agent: "same", step: "same", slice_id: "same", cost_output: 0.05, cost_currency: "EUR", missing: ["cost_total"] }),
    ] });

    for (const rollup of [report.totals, report.by_agent.same, report.by_step.same, report.by_slice.same]) {
      assert.equal(rollup.status, "partial");
      assert.equal(rollup.mixed_currency, true);
      assert.equal(Object.hasOwn(rollup, "cost_total"), false);
      assert.equal(Object.hasOwn(rollup, "cost_currency"), false);
      assert.equal(rollup.cost_input, 0.04);
      assert.equal(rollup.cost_output, 0.05);
      assert.deepEqual(rollup.missing, ["cost_total", "mixed_currency"]);
    }
  });

  it("serializes split-entry rollups in exact report-v1 property order", () => {
    const report = buildCostReport("run-123", { entries: [
      partialEntry({ id: "output", agent: "same", step: "same", slice_id: "same", cost_output: 0.02, cost_currency: "USD", missing: ["cost_total"] }),
      availableEntry({ id: "input", agent: "same", step: "same", slice_id: "same", input_tokens: 3, cost_total: 0.03 }),
    ] });
    const expectedRollup = {
      status: "partial",
      entry_count: 2,
      request_count: 2,
      input_tokens: 3,
      cost_total: 0.03,
      cost_output: 0.02,
      cost_currency: "USD",
      mixed_currency: false,
      missing: ["cost_total"],
    };
    const expected = {
      schema_version: 1,
      run_id: "run-123",
      status: "partial",
      entry_count: 2,
      request_count: 2,
      agent_count: 1,
      step_count: 1,
      slice_count: 1,
      unattributed_step_entry_count: 0,
      totals: expectedRollup,
      by_agent: { same: expectedRollup },
      by_step: { same: expectedRollup },
      by_slice: { same: expectedRollup },
    };

    assert.deepEqual(Object.keys(report.totals), Object.keys(expectedRollup));
    assert.deepEqual(Object.keys(report.by_agent.same), Object.keys(expectedRollup));
    assert.deepEqual(Object.keys(report.by_step.same), Object.keys(expectedRollup));
    assert.deepEqual(Object.keys(report.by_slice.same), Object.keys(expectedRollup));
    assert.equal(serializeCostReport(report), JSON.stringify(expected, null, 2));
  });

  it("rejects finite aggregate overflow before report formatting without mutating entries", () => {
    const entries = [
      availableEntry({ id: "one", step: "build", input_tokens: Number.MAX_VALUE }),
      availableEntry({ id: "two", step: "build", input_tokens: Number.MAX_VALUE }),
    ];
    const before = structuredClone(entries);

    assert.throws(
      () => buildCostReport("run-123", { entries }),
      /cost attribution aggregate overflow for input_tokens/u,
    );
    assert.deepEqual(entries, before);
  });

  it("encodes human labels injectively and emits no terminal controls", () => {
    assert.equal(encodeCostReportDisplayLabel("plain"), "\"plain\"");
    assert.equal(encodeCostReportDisplayLabel("quote\"slash\\"), "\"quote\\\"slash\\\\\"");
    assert.equal(encodeCostReportDisplayLabel("x\nx"), "\"x\\u000Ax\"");
    assert.equal(encodeCostReportDisplayLabel("é😀"), "\"\\u00E9\\uD83D\\uDE00\"");

    const report = buildCostReport("run-123", { entries: [
      availableEntry({ id: "control", agent: "agent\nx", step: "step\u0085x", slice_id: "slice\u2028x" }),
      availableEntry({ id: "space", agent: "agent x", step: "step x", slice_id: "slice x" }),
    ] });
    const output = formatCostReport(report);

    assert.match(output, /"agent\\u000Ax":/u);
    assert.match(output, /"agent x":/u);
    assert.match(output, /"step\\u0085x":/u);
    assert.match(output, /"slice\\u2028x":/u);
    assert.doesNotMatch(output, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/u);
  });

  it("serializes control-safe JSON including bidi formats while preserving decoded raw keys", () => {
    const raw = "group\u0085\u2028\u202Ex\u2066\u2067\u2068\u2069";
    const report = buildCostReport("run-123", { entries: [availableEntry({ agent: raw, step: raw, slice_id: raw })] });
    const serialized = serializeCostReport(report);
    const decoded = JSON.parse(serialized);

    assert.equal(Object.hasOwn(decoded.by_agent, raw), true);
    assert.match(serialized, /group\\u0085\\u2028\\u202Ex\\u2066\\u2067\\u2068\\u2069/u);
    assert.doesNotMatch(serialized, /[\u007F-\u009F\u2028-\u202E\u2066-\u2069]/u);
  });

  it("adds only opt-in invocation telemetry correlation and ignores ambient context by default", () => {
    const env = {
      FEATURE_FACTORY_TRACEPARENT: TRACEPARENT.toUpperCase(),
      TRACEPARENT,
      FEATURE_FACTORY_PARENT_SPAN_ID: "00F067AA0BA902B7",
      TRACESTATE: "secret=value",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
    };
    const plain = buildCostReport("run-123", undefined, { env });
    const optedIn = buildCostReport("run-123", undefined, { telemetry: true, env });

    assert.equal(Object.hasOwn(plain, "telemetry"), false);
    assert.deepEqual(optedIn.telemetry, {
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      parent_span_id: "00f067aa0ba902b7",
    });
    assert.deepEqual(Object.keys(optedIn.telemetry), ["trace_id", "parent_span_id"]);
    assert.doesNotMatch(JSON.stringify(optedIn), /traceparent|tracestate|OTLP/u);
    assert.equal(costReportTelemetryCorrelation({}), null);
  });

  it("rejects invalid or conflicting explicitly enabled telemetry context locally", () => {
    assert.throws(
      () => costReportTelemetryCorrelation({ TRACEPARENT: "invalid" }),
      /cost-report telemetry: traceparent must match W3C format/u,
    );
    assert.throws(
      () => costReportTelemetryCorrelation({ TRACEPARENT, FEATURE_FACTORY_TRACEPARENT: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" }),
      /cost-report telemetry: FEATURE_FACTORY_TRACEPARENT and TRACEPARENT must match/u,
    );
    assert.throws(
      () => costReportTelemetryCorrelation({ TRACEPARENT, FEATURE_FACTORY_PARENT_SPAN_ID: "aaaaaaaaaaaaaaaa" }),
      /cost-report telemetry: FEATURE_FACTORY_PARENT_SPAN_ID must match traceparent parent span id/u,
    );
    assert.throws(
      () => buildCostReport("run-123", undefined, { telemetry: true, env: { FEATURE_FACTORY_PARENT_SPAN_ID: "00f067aa0ba902b7" } }),
      /cost-report telemetry: FEATURE_FACTORY_PARENT_SPAN_ID requires a traceparent/u,
    );
  });

  it("rejects invalid attribution containers and entry schema without full-run validation", () => {
    assert.throws(() => buildCostReport("run-123", []), /run\.json\.cost_attribution must be an object, null, or absent/u);
    assert.throws(() => buildCostReport("run-123", { entries: {} }), /run\.json\.cost_attribution\.entries must be an array, null, or absent/u);
    assert.throws(
      () => buildCostReport("run-123", { entries: [availableEntry({ run_id: "other-run" })] }),
      /run\.cost_attribution\.entries\[0\]\.run_id: must match run\.run_id/u,
    );
    assert.throws(
      () => buildCostReport("run-123", { entries: [availableEntry({ missing: ["usage"] })] }),
      /run\.cost_attribution\.entries\[0\]\.missing: must be empty when status is available/u,
    );
  });
});

function availableEntry(overrides = {}) {
  return {
    id: "available",
    recorded_at: "2026-07-08T12:00:00.000Z",
    run_id: "run-123",
    agent: "backend-builder",
    provider: "unknown-provider",
    model: "unknown-model",
    input_tokens: 1,
    cost_total: 0.01,
    cost_currency: "USD",
    status: "available",
    missing: [],
    ...overrides,
  };
}

function partialEntry(overrides = {}) {
  return {
    id: "partial",
    recorded_at: "2026-07-08T12:00:00.000Z",
    run_id: "run-123",
    agent: "backend-builder",
    status: "partial",
    missing: ["model", "cost_total"],
    ...overrides,
  };
}

function unavailableEntry(overrides = {}) {
  return {
    id: "unavailable",
    recorded_at: "2026-07-08T12:00:00.000Z",
    run_id: "run-123",
    agent: "backend-builder",
    status: "unavailable",
    missing: ["usage", "cost_total"],
    ...overrides,
  };
}
