import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  b6Attributes,
  checkOpenTelemetryApiLoadability,
  emitB6Span,
  evaluateContentCaptureRisk,
  isB6TelemetryEnabled,
  prepareTelemetryEnv,
  recordError,
  runAttributes,
  sanitizeOtlpEnv,
  sanitizeOtlpHeaders,
  validateParentSpanId,
  validateTraceContext,
  validateTraceparent,
  validateTracestate,
  startB6Span,
  withB6Span,
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

  it("drops malformed comma-split OTLP header fragments and redacts secret-shaped header names", () => {
    const honeycombKey = "hc_api_12345678901234567890";
    const headers = sanitizeOtlpHeaders(`x-honeycomb-team=${honeycombKey},${honeycombKey},hc_api_header_1234567890=value,x-honeycomb-dataset=feature-factory`);

    assert.deepEqual(headers, [
      { name: "x-honeycomb-team", present: true, value: REDACTED_ENV_VALUE },
      { name: REDACTED_ENV_VALUE, present: true, value: REDACTED_ENV_VALUE },
      { name: "x-honeycomb-dataset", present: true, value: REDACTED_ENV_VALUE },
    ]);
    const serialized = JSON.stringify(headers);
    assert.doesNotMatch(serialized, new RegExp(honeycombKey, "u"));
    assert.doesNotMatch(serialized, /hc_api_header/u);
  });

  it("sanitizes only OTLP env and redacts credential-shaped values", () => {
    const hostCredential = "0123456789abcdef0123456789abcdef";
    const pathCredential = "hc_api_12345678901234567890";
    const safe = sanitizeOtlpEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: `https://${hostCredential}.example.test/${pathCredential}/v1/traces?api_key=${pathCredential}`,
      OTEL_EXPORTER_OTLP_HEADERS: "x-honeycomb-team=github_pat_123456789012345678901234567890",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://user:pass@example.test/v1/traces",
      FEATURE_FACTORY_OTEL_ENABLED: "true",
    });

    assert.equal(safe.OTEL_EXPORTER_OTLP_ENDPOINT, `https://${REDACTED_ENV_VALUE}.example.test/${REDACTED_ENV_VALUE}/v1/traces?${REDACTED_ENV_VALUE}`);
    assert.equal(safe.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, "https://example.test/v1/traces");
    assert.deepEqual(safe.OTEL_EXPORTER_OTLP_HEADERS, [
      { name: "x-honeycomb-team", present: true, value: REDACTED_ENV_VALUE },
    ]);
    assert.equal(safe.FEATURE_FACTORY_OTEL_ENABLED, undefined);
    assert.doesNotMatch(JSON.stringify(safe), new RegExp(hostCredential, "u"));
    assert.doesNotMatch(JSON.stringify(safe), new RegExp(pathCredential, "u"));
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

  it("clears the whole inherited trace context before applying a partial explicit override", () => {
    const inherited = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.honeycomb.io",
      TRACEPARENT: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      TRACESTATE: "old-vendor=stale",
      FEATURE_FACTORY_TRACEPARENT: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      FEATURE_FACTORY_TRACESTATE: "old-vendor=stale",
      FEATURE_FACTORY_PARENT_SPAN_ID: "bbbbbbbbbbbbbbbb",
    };

    const newTrace = prepareTelemetryEnv(inherited, { traceparent });
    assert.equal(newTrace.TRACEPARENT, traceparent);
    assert.equal(newTrace.FEATURE_FACTORY_TRACEPARENT, traceparent);
    assert.equal(newTrace.FEATURE_FACTORY_PARENT_SPAN_ID, "00f067aa0ba902b7");
    assert.equal("TRACESTATE" in newTrace, false);
    assert.equal("FEATURE_FACTORY_TRACESTATE" in newTrace, false);
    assert.equal(newTrace.OTEL_EXPORTER_OTLP_ENDPOINT, inherited.OTEL_EXPORTER_OTLP_ENDPOINT);

    const newParent = prepareTelemetryEnv(inherited, { parentSpanId: "00f067aa0ba902b7" });
    assert.equal(newParent.FEATURE_FACTORY_PARENT_SPAN_ID, "00f067aa0ba902b7");
    assert.equal("TRACEPARENT" in newParent, false);
    assert.equal("TRACESTATE" in newParent, false);
    assert.equal("FEATURE_FACTORY_TRACEPARENT" in newParent, false);
    assert.equal("FEATURE_FACTORY_TRACESTATE" in newParent, false);

    const untouched = prepareTelemetryEnv(inherited, {});
    assert.deepEqual(untouched, inherited);
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
      honeycomb_team: "hc_api_12345678901234567890",
      opaque_id: "0123456789abcdef0123456789abcdef",
      nested: { keep: "ok", secret: "value" },
    });

    assert.equal(attrs["feature_factory.run_id"], "run-123");
    assert.equal(attrs.api_token, REDACTED_ENV_VALUE);
    assert.equal(attrs.honeycomb_team, REDACTED_ENV_VALUE);
    assert.equal(attrs.opaque_id, REDACTED_ENV_VALUE);
    assert.equal(attrs.nested, JSON.stringify({ keep: "ok" }));

    const value = await withSpan("factory.test", attrs, (span) => {
      recordError(span, new Error("boom"));
      return "ok";
    });
    assert.equal(value, "ok");
  });

  it("runs the callback without a span when @opentelemetry/api cannot be loaded", async () => {
    const events = [];
    const value = await withSpan(
      "factory.optional",
      { "feature_factory.run_id": "run-optional" },
      (span) => {
        span.setAttribute("k", "v");
        recordError(span, new Error("boom"));
        events.push("ran");
        return "ok";
      },
      { importer: () => Promise.reject(new Error("Cannot find package '@opentelemetry/api'")) },
    );

    assert.equal(value, "ok");
    assert.deepEqual(events, ["ran"]);
  });

  it("drops secret-shaped attribute keys and scrubs nested secret-shaped keys", () => {
    const honeycombKey = "hc_api_12345678901234567890";
    const hexKey = "0123456789abcdef0123456789abcdef";
    const uppercaseKey = "Q7M4Z9N2C8V5B1X6L3K0P7R2T9Y4U8I5";
    const otelishUppercaseKey = `OTEL_EXPORTER_OTLP_${uppercaseKey}_HEADERS`;
    const attrs = runAttributes({
      "feature_factory.run_id": "run-123",
      [honeycombKey]: "safe",
      [uppercaseKey]: "safe",
      [otelishUppercaseKey]: "safe",
      nested: {
        keep: "ok",
        [hexKey]: "safe",
        [uppercaseKey]: "safe",
        [otelishUppercaseKey]: "safe",
      },
    });

    assert.equal(attrs["feature_factory.run_id"], "run-123");
    assert.equal(Object.hasOwn(attrs, honeycombKey), false);
    assert.equal(Object.hasOwn(attrs, uppercaseKey), false);
    assert.equal(Object.hasOwn(attrs, otelishUppercaseKey), false);
    assert.equal(attrs.nested, JSON.stringify({ keep: "ok" }));
    const serialized = JSON.stringify(attrs);
    assert.doesNotMatch(serialized, new RegExp(honeycombKey, "u"));
    assert.doesNotMatch(serialized, new RegExp(hexKey, "u"));
    assert.doesNotMatch(serialized, new RegExp(uppercaseKey, "u"));
    assert.doesNotMatch(serialized, new RegExp(otelishUppercaseKey, "u"));
  });

  it("redacts secret-shaped error messages before recording exceptions", () => {
    const recorded = { exceptions: [], statuses: [], attributes: [] };
    const span = {
      recordException(exception) {
        recorded.exceptions.push(exception);
      },
      setStatus(status) {
        recorded.statuses.push(status);
      },
      setAttribute(key, value) {
        recorded.attributes.push([key, value]);
      },
    };
    const error = new Error("failed with github_pat_123456789012345678901234567890 and hc_api_12345678901234567890");
    error.stack = "Error: failed with github_pat_123456789012345678901234567890\n    at call (sk-123456789012345678901234567890.js:1:1)\n    at token (0123456789abcdef0123456789abcdef.js:1:1)";
    error.api_token = "ghp_123456789012345678901234567890";

    recordError(span, error);

    assert.equal(recorded.exceptions.length, 1);
    assert.notEqual(recorded.exceptions[0], error);
    assert.equal(recorded.exceptions[0].name, "Error");
    assert.equal(recorded.exceptions[0].message, REDACTED_ENV_VALUE);
    assert.equal(recorded.exceptions[0].stack, REDACTED_ENV_VALUE);
    assert.equal(recorded.statuses[0].message, REDACTED_ENV_VALUE);
    assert.deepEqual(recorded.attributes[0], ["error.type", "Error"]);
    const serialized = JSON.stringify(recorded);
    assert.doesNotMatch(serialized, /github_pat_/u);
    assert.doesNotMatch(serialized, /hc_api_/u);
    assert.doesNotMatch(serialized, /ghp_/u);
    assert.doesNotMatch(serialized, /sk-123/u);
    assert.doesNotMatch(serialized, /0123456789abcdef/u);
    assert.doesNotMatch(serialized, /api_token/u);
  });
});

describe("B6 metadata-only spans", () => {
  it("enables only explicit plugin or environment opt-in", () => {
    assert.equal(isB6TelemetryEnabled({}, {}), false);
    assert.equal(isB6TelemetryEnabled({ telemetry: { enabled: true } }, {}), true);
    assert.equal(isB6TelemetryEnabled({ enabled: true }, {}), false);
    assert.equal(isB6TelemetryEnabled({}, { FEATURE_FACTORY_OTEL_ENABLED: "true" }), true);
    assert.equal(isB6TelemetryEnabled({}, { FEATURE_FACTORY_OTEL_ENABLED: "1" }), true);
    assert.equal(isB6TelemetryEnabled({}, { FEATURE_FACTORY_OTEL_ENABLED: "yes" }), false);
  });

  it("projects only bounded canonical identifiers, enums, and attempts", () => {
    const hostile = {
      "feature_factory.run_id": "run-safe",
      "feature_factory.slice_id": "slice-safe",
      "feature_factory.session_id": `s${"x".repeat(128)}`,
      "feature_factory.parent_session_id": "bad\nsession",
      "feature_factory.call_id": "call-safe",
      "feature_factory.target_agent": "backend-builder",
      "feature_factory.route": "ordinary-slice",
      "feature_factory.lane": "backend",
      "feature_factory.task_context": "fresh",
      "feature_factory.span_event": "task-before",
      "feature_factory.span_operation": "execute-task",
      "feature_factory.call_relationship": "task-hook",
      "feature_factory.attempt": 3,
      "feature_factory.verdict": "model-says-pass",
      "gen_ai.conversation.id": "run-safe",
      "gen_ai.agent.name": "backend-builder",
      "gen_ai.operation.name": "execute_tool",
      prompt: "ignore this prompt",
      task_id: "runtime-task",
      traceparent,
      api_token: "github_pat_123456789012345678901234567890",
    };
    assert.deepEqual(b6Attributes(hostile), {
      "feature_factory.run_id": "run-safe",
      "feature_factory.slice_id": "slice-safe",
      "feature_factory.call_id": "call-safe",
      "feature_factory.target_agent": "backend-builder",
      "feature_factory.route": "ordinary-slice",
      "feature_factory.lane": "backend",
      "feature_factory.task_context": "fresh",
      "feature_factory.span_event": "task-before",
      "feature_factory.span_operation": "execute-task",
      "feature_factory.call_relationship": "task-hook",
      "feature_factory.attempt": 3,
      "gen_ai.conversation.id": "run-safe",
      "gen_ai.agent.name": "backend-builder",
      "gen_ai.operation.name": "execute_tool",
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    assert.deepEqual(b6Attributes(revoked.proxy), {});
  });

  it("retains a factory span across dispatch/completion and passes active context", async () => {
    const fake = fakeOtel();
    const controller = startB6Span("feature_factory.task", {
      "feature_factory.run_id": "run-1",
      "feature_factory.session_id": "ses-1",
      "feature_factory.call_id": "call-1",
      "feature_factory.span_event": "task-before",
      "feature_factory.span_operation": "execute-task",
    }, { telemetry: { enabled: true, importer: fake.importer } });
    controller.setAttributes({ "feature_factory.verdict": "REJECT", "feature_factory.convergence": "converging" });
    controller.addEvent("task-after");
    await controller.end();

    assert.equal(fake.spans.length, 1);
    assert.equal(fake.spans[0].name, "feature_factory.task");
    assert.equal(fake.spans[0].context, fake.activeContext);
    assert.equal(fake.spans[0].attributes["feature_factory.verdict"], "REJECT");
    assert.equal(fake.spans[0].attributes["feature_factory.convergence"], "converging");
    assert.deepEqual(fake.spans[0].events, ["task-after"]);
    assert.equal(fake.spans[0].ended, true);
    assert.equal(fake.calls.startSpan, 0);
    assert.equal(fake.calls.startActiveSpan, 1);
  });

  it("is a no-op when disabled or the API/provider is unavailable", async () => {
    const fake = fakeOtel();
    await emitB6Span("feature_factory.session", { "feature_factory.session_id": "ses-1" }, { importer: fake.importer, env: {} });
    assert.equal(fake.spans.length, 0);
    await emitB6Span("hostile-span-name", { "feature_factory.session_id": "ses-1" }, {
      telemetry: { enabled: true, importer: fake.importer },
    });
    assert.equal(fake.spans.length, 0);
    await emitB6Span("feature_factory.session", { "feature_factory.session_id": "ses-1" }, {
      telemetry: { enabled: true, importer: () => Promise.reject(new Error("unavailable")) },
    });
  });

  it("swallows importer, tracer, start, mutation, status, event, and end failures", async () => {
    for (const stage of ["importer", "tracer", "start", "setAttribute", "setStatus", "addEvent", "end"]) {
      const fake = fakeOtel({ failAt: stage });
      const controller = startB6Span("feature_factory.task", {
        "feature_factory.run_id": "run-1",
        "feature_factory.span_event": "task-before",
        "feature_factory.span_operation": "execute-task",
      }, { telemetry: { enabled: true, importer: fake.importer } });
      controller.setAttributes({ "feature_factory.status": "completed" });
      controller.addEvent("task-after");
      controller.fail();
      await controller.end();
    }
  });

  it("preserves exact workflow results and error objects when telemetry fails", async () => {
    const result = { exact: true };
    const failedEnd = fakeOtel({ failAt: "end" });
    assert.equal(await withSpan("factory.exact", {}, () => result, { importer: failedEnd.importer }), result);

    const workflowError = new Error("exact workflow error");
    const failedException = fakeOtel({ failAt: "recordException" });
    await assert.rejects(
      withSpan("factory.error", {}, () => { throw workflowError; }, { importer: failedException.importer }),
      (error) => error === workflowError,
    );

    let callbackCalls = 0;
    const malformedProvider = {
      context: { active: () => ({}) },
      trace: { getTracer: () => ({ startActiveSpan: () => Promise.reject(new Error("provider failed")) }) },
    };
    assert.equal(await withSpan("factory.exact", () => {
      callbackCalls += 1;
      return result;
    }, { importer: async () => malformedProvider }), result);
    assert.equal(callbackCalls, 1);
  });

  it("records only closed error metadata for hostile B6 workflow errors and rethrows the exact object", async () => {
    const fake = fakeOtel();
    const error = new Error("prompt output github_pat_123456789012345678901234567890 /private/repo refs/heads/main https://user:pass@example.test TRACEPARENT=00-secret");
    error.stack = `Error: ${error.message}\n    at /private/repo/secret.js:1:1`;
    await assert.rejects(
      withB6Span("feature_factory.factory.start", {
        "feature_factory.mode": "interactive",
        prompt: "excluded",
      }, () => { throw error; }, { telemetry: { enabled: true, importer: fake.importer } }),
      (actual) => actual === error && actual.message === error.message,
    );
    assert.equal(fake.spans.length, 1);
    assert.deepEqual(fake.spans[0].statuses, [{ code: 2 }]);
    assert.equal(fake.spans[0].attributes["error.type"], "workflow_error");
    assert.deepEqual(fake.spans[0].exceptions, []);
    assert.doesNotMatch(JSON.stringify(fake.spans), /prompt output|github_pat|private|refs\/heads|user:pass|TRACEPARENT|secret\.js/u);
  });
});

function fakeOtel({ failAt = null } = {}) {
  const spans = [];
  const calls = { startSpan: 0, startActiveSpan: 0 };
  const activeContext = { trace: "active-context" };
  const makeSpan = (name, options, context) => {
    if (failAt === "start") throw new Error("start failed");
    const span = {
      name,
      context,
      attributes: { ...(options?.attributes || {}) },
      events: [],
      statuses: [],
      exceptions: [],
      ended: false,
      setAttribute(key, value) {
        if (failAt === "setAttribute") throw new Error("attribute failed");
        this.attributes[key] = value;
      },
      addEvent(event) {
        if (failAt === "addEvent") throw new Error("event failed");
        this.events.push(event);
      },
      setStatus(status) {
        if (failAt === "setStatus") throw new Error("status failed");
        this.statuses.push(status);
      },
      recordException(exception) {
        if (failAt === "recordException") throw new Error("exception failed");
        this.exceptions.push(exception);
      },
      end() {
        if (failAt === "end") throw new Error("end failed");
        this.ended = true;
      },
    };
    spans.push(span);
    return span;
  };
  const api = {
    context: { active: () => activeContext },
    trace: {
      getTracer() {
        if (failAt === "tracer") throw new Error("tracer failed");
        return {
          startActiveSpan(name, options, context, callback) {
            calls.startActiveSpan += 1;
            return callback(makeSpan(name, options, context));
          },
        };
      },
    },
  };
  return {
    spans,
    calls,
    activeContext,
    importer: async () => {
      if (failAt === "importer") throw new Error("import failed");
      return api;
    },
  };
}
