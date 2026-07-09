import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkOpenTelemetryApiLoadability,
  evaluateContentCaptureRisk,
  prepareTelemetryEnv,
  recordError,
  runAttributes,
  sanitizeOtlpEnv,
  sanitizeOtlpHeaders,
  validateParentSpanId,
  validateTraceContext,
  validateTraceparent,
  validateTracestate,
  withSpan,
} from "../src/telemetry.js";
import { REDACTED_ENV_VALUE } from "../src/env-snapshot.js";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("OpenTelemetry API loadability", () => {
  it("loads @opentelemetry/api without requiring an SDK/exporter", async () => {
    const result = await checkOpenTelemetryApiLoadability();

    assert.equal(result.ok, true);
    assert.deepEqual(result.exports, ["trace", "context", "SpanStatusCode"]);
  });

  it("reports actionable loadability failures without throwing", async () => {
    const result = await checkOpenTelemetryApiLoadability(async () => {
      throw new Error("missing ghp_123456789012345678901234567890");
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, REDACTED_ENV_VALUE);
  });
});

describe("OTLP sanitizers", () => {
  it("redacts header values and reports only safe header names", () => {
    const headers = sanitizeOtlpHeaders("x-honeycomb-team=hc_api_12345678901234567890,x-honeycomb-dataset=feature-factory,Authorization=Bearer abcdefghijklmnopqrstuvwxyz123456");

    assert.deepEqual(headers, [
      { name: "x-honeycomb-team", present: true, value: REDACTED_ENV_VALUE },
      { name: "x-honeycomb-dataset", present: true, value: REDACTED_ENV_VALUE },
      { name: REDACTED_ENV_VALUE, present: true, value: REDACTED_ENV_VALUE },
    ]);
    assert.doesNotMatch(JSON.stringify(headers), /abcdefghijklmnopqrstuvwxyz/u);
  });

  it("sanitizes only OTLP env and redacts credential-shaped values", () => {
    const safe = sanitizeOtlpEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.honeycomb.io",
      OTEL_EXPORTER_OTLP_HEADERS: "x-honeycomb-team=github_pat_123456789012345678901234567890",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://user:pass@example.test/v1/traces",
      FEATURE_FACTORY_OTEL_ENABLED: "true",
    });

    assert.equal(safe.OTEL_EXPORTER_OTLP_ENDPOINT, "https://api.honeycomb.io");
    assert.equal(safe.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, REDACTED_ENV_VALUE);
    assert.deepEqual(safe.OTEL_EXPORTER_OTLP_HEADERS, [
      { name: "x-honeycomb-team", present: true, value: REDACTED_ENV_VALUE },
    ]);
    assert.equal(safe.FEATURE_FACTORY_OTEL_ENABLED, undefined);
    assert.doesNotMatch(JSON.stringify(safe), /github_pat_/u);
    assert.doesNotMatch(JSON.stringify(safe), /user:pass/u);
  });
});

describe("trace-context validation", () => {
  it("validates parent span id and W3C traceparent", () => {
    assert.deepEqual(validateParentSpanId("00F067AA0BA902B7"), {
      ok: true,
      value: "00f067aa0ba902b7",
      spanId: "00f067aa0ba902b7",
    });
    assert.equal(validateParentSpanId("0000000000000000").ok, false);
    assert.equal(validateParentSpanId("abc").ok, false);

    const parsed = validateTraceparent(traceparent);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert.equal(parsed.parentSpanId, "00f067aa0ba902b7");
    assert.equal(validateTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01").ok, false);
    assert.equal(validateTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01").ok, false);
  });

  it("rejects tracestate control characters and mismatched parent span context", () => {
    assert.equal(validateTracestate("vendor=value,other=state").ok, true);
    assert.equal(validateTracestate("vendor=value\nother=state").ok, false);

    assert.equal(validateTraceContext({ parentSpanId: "00f067aa0ba902b7", traceparent }).ok, true);
    const mismatch = validateTraceContext({ parentSpanId: "1111111111111111", traceparent });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.error, /must match/u);
  });

  it("prepares child env without stripping existing OTEL variables or adding trace env by default", () => {
    const base = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.honeycomb.io",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=test",
      TRACEPARENT: "existing",
    };

    assert.deepEqual(prepareTelemetryEnv(base), base);

    const env = prepareTelemetryEnv(base, { traceparent, tracestate: "vendor=value" });
    assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, base.OTEL_EXPORTER_OTLP_ENDPOINT);
    assert.equal(env.OTEL_RESOURCE_ATTRIBUTES, base.OTEL_RESOURCE_ATTRIBUTES);
    assert.equal(env.TRACEPARENT, traceparent);
    assert.equal(env.TRACESTATE, "vendor=value");
    assert.equal(env.FEATURE_FACTORY_TRACEPARENT, traceparent);
    assert.equal(env.FEATURE_FACTORY_TRACESTATE, "vendor=value");
    assert.equal(env.FEATURE_FACTORY_PARENT_SPAN_ID, "00f067aa0ba902b7");
  });
});

describe("content-capture risk", () => {
  it("is safe by default and warns conservatively for native/content capture", () => {
    assert.deepEqual(evaluateContentCaptureRisk().capture, {
      captureMessages: false,
      captureToolArguments: false,
      captureToolResults: false,
      captureReviews: false,
      captureEvidence: false,
    });
    assert.equal(evaluateContentCaptureRisk().ok, true);

    const risk = evaluateContentCaptureRisk({
      config: { experimental: { openTelemetry: true } },
      telemetry: { captureMessages: true },
    });
    assert.equal(risk.ok, false);
    assert.equal(risk.level, "warning");
    assert.equal(risk.redactionActive, true);
    assert.deepEqual(risk.risks.map((item) => item.kind), [
      "native-opencode-content-capture",
      "feature-factory-content-capture",
    ]);
  });
});

describe("no-op span wrappers", () => {
  it("runs callbacks and redacts attributes without initializing an exporter", async () => {
    const attrs = runAttributes({
      "feature_factory.run_id": "run-123",
      api_token: "github_pat_123456789012345678901234567890",
      nested: { keep: "ok", secret: "value" },
    });

    assert.equal(attrs["feature_factory.run_id"], "run-123");
    assert.equal(attrs.api_token, REDACTED_ENV_VALUE);
    assert.equal(attrs.nested, JSON.stringify({ keep: "ok" }));

    const value = await withSpan("factory.test", attrs, (span) => {
      recordError(span, new Error("boom"));
      return "ok";
    });
    assert.equal(value, "ok");
  });
});
