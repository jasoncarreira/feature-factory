import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import {
  REDACTED_ENV_VALUE,
  isSensitiveEnvKey,
  isSensitiveEnvValue,
  scrubSecretEnv,
} from "./env-snapshot.js";

export const TELEMETRY_TRACER_NAME = "opencode-feature-factory";
export const FEATURE_FACTORY_TRACEPARENT = "FEATURE_FACTORY_TRACEPARENT";
export const FEATURE_FACTORY_TRACESTATE = "FEATURE_FACTORY_TRACESTATE";
export const FEATURE_FACTORY_PARENT_SPAN_ID = "FEATURE_FACTORY_PARENT_SPAN_ID";

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/iu;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);
const PARENT_SPAN_ID_PATTERN = /^[0-9a-f]{16}$/iu;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/u;
const OTLP_ENV_PATTERN = /^OTEL_EXPORTER_OTLP(?:_[A-Z0-9_]+)?$/u;
const OTLP_HEADERS_PATTERN = /^OTEL_EXPORTER_OTLP(?:_[A-Z0-9]+)?_HEADERS$/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const SAFE_ATTRIBUTE_ARRAY_TYPES = new Set(["string", "number", "boolean"]);
const DEFAULT_CONTENT_CAPTURE = Object.freeze({
  captureMessages: false,
  captureToolArguments: false,
  captureToolResults: false,
  captureReviews: false,
  captureEvidence: false,
});

export async function checkOpenTelemetryApiLoadability(importer = () => import("@opentelemetry/api")) {
  try {
    const api = await importer();
    const missing = ["trace", "context", "SpanStatusCode"].filter((name) => api?.[name] === undefined);
    if (missing.length > 0) {
      return {
        ok: false,
        package: "@opentelemetry/api",
        error: `@opentelemetry/api missing expected export(s): ${missing.join(", ")}`,
      };
    }
    return {
      ok: true,
      package: "@opentelemetry/api",
      exports: ["trace", "context", "SpanStatusCode"],
    };
  } catch (error) {
    return {
      ok: false,
      package: "@opentelemetry/api",
      error: sanitizeDiagnosticMessage(error?.message || String(error)),
    };
  }
}

export function sanitizeOtlpEnv(env = process.env) {
  const output = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (!OTLP_ENV_PATTERN.test(key)) continue;
    output[key] = OTLP_HEADERS_PATTERN.test(key)
      ? sanitizeOtlpHeaders(value)
      : sanitizeTelemetryValue(key, value);
  }
  return output;
}

export function sanitizeOtlpHeaders(value) {
  if (!stringValue(value)) return [];
  return String(value)
    .split(",")
    .map((entry) => sanitizeOtlpHeaderEntry(entry))
    .filter(Boolean);
}

export function sanitizeTelemetryValue(key, value) {
  if (value === undefined || value === null) return value;
  const string = String(value);
  if (isSensitiveEnvKey(key) || isSensitiveEnvValue(string)) return REDACTED_ENV_VALUE;
  return string;
}

export function evaluateContentCaptureRisk(options = {}) {
  const telemetry = {
    ...DEFAULT_CONTENT_CAPTURE,
    ...(plainObject(options.telemetry) ? options.telemetry : {}),
    ...(plainObject(options.config?.telemetry) ? options.config.telemetry : {}),
    ...(plainObject(options.config?.plugin?.telemetry) ? options.config.plugin.telemetry : {}),
  };
  const nativeOpenTelemetry = options.nativeOpenTelemetry === true
    || options.config?.experimental?.openTelemetry === true;
  const enabledCaptureFlags = Object.keys(DEFAULT_CONTENT_CAPTURE)
    .filter((key) => telemetry[key] === true);
  const risks = [];

  if (nativeOpenTelemetry) {
    risks.push({
      kind: "native-opencode-content-capture",
      severity: "warning",
      message: "Native opencode/AI SDK OpenTelemetry may capture prompts, completions, tool arguments, or tool results outside feature-factory redaction.",
    });
  }
  if (enabledCaptureFlags.length > 0) {
    risks.push({
      kind: "feature-factory-content-capture",
      severity: "warning",
      flags: enabledCaptureFlags,
      message: "Feature-factory content capture is enabled; redact and cap content before setting span attributes or events.",
    });
  }

  return {
    ok: risks.length === 0,
    level: risks.length === 0 ? "ok" : "warning",
    redactionActive: true,
    capture: Object.fromEntries(Object.keys(DEFAULT_CONTENT_CAPTURE).map((key) => [key, telemetry[key] === true])),
    risks,
  };
}

export const contentCaptureRisk = evaluateContentCaptureRisk;

export function validateParentSpanId(value) {
  if (!stringValue(value)) return validationError("parent span id is required");
  const spanId = String(value).trim().toLowerCase();
  if (!PARENT_SPAN_ID_PATTERN.test(spanId)) return validationError("parent span id must be 16 hex characters");
  if (spanId === ZERO_SPAN_ID) return validationError("parent span id must not be all zeroes");
  return { ok: true, value: spanId, spanId };
}

export function validateTraceparent(value) {
  if (!stringValue(value)) return validationError("traceparent is required");
  const traceparent = String(value).trim().toLowerCase();
  const match = TRACEPARENT_PATTERN.exec(traceparent);
  if (!match) return validationError("traceparent must match W3C format 00-<32hex trace id>-<16hex span id>-<2hex flags>");

  const [, traceId, parentSpanId, flags] = match;
  if (traceId === ZERO_TRACE_ID) return validationError("traceparent trace id must not be all zeroes");
  if (parentSpanId === ZERO_SPAN_ID) return validationError("traceparent parent span id must not be all zeroes");
  return { ok: true, value: traceparent, traceparent, traceId, parentSpanId, flags };
}

export function validateTracestate(value) {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  const tracestate = String(value);
  if (CONTROL_CHAR_PATTERN.test(tracestate)) return validationError("tracestate must not contain control characters or newlines");
  return { ok: true, value: tracestate, tracestate };
}

export function validateTraceContext(input = {}) {
  const output = {};
  if (input.parentSpanId !== undefined && input.parentSpanId !== null) {
    const parent = validateParentSpanId(input.parentSpanId);
    if (!parent.ok) return parent;
    output.parentSpanId = parent.spanId;
  }
  if (input.traceparent !== undefined && input.traceparent !== null) {
    const parsed = validateTraceparent(input.traceparent);
    if (!parsed.ok) return parsed;
    output.traceparent = parsed.traceparent;
    output.traceId = parsed.traceId;
    output.traceparentSpanId = parsed.parentSpanId;
    output.traceFlags = parsed.flags;
  }
  if (output.parentSpanId && output.traceparentSpanId && output.parentSpanId !== output.traceparentSpanId) {
    return validationError("parent span id must match traceparent span id when both are supplied");
  }
  if (input.tracestate !== undefined && input.tracestate !== null) {
    const state = validateTracestate(input.tracestate);
    if (!state.ok) return state;
    output.tracestate = state.tracestate;
  }
  return { ok: true, ...output };
}

export function prepareTelemetryEnv(baseEnv = process.env, traceContext = {}) {
  const env = { ...(baseEnv || {}) };
  const validated = validateTraceContext(traceContext);
  if (!validated.ok) throw new Error(validated.error);

  if (validated.traceparent) {
    env.TRACEPARENT = validated.traceparent;
    env[FEATURE_FACTORY_TRACEPARENT] = validated.traceparent;
  }
  if (validated.tracestate !== undefined) {
    env.TRACESTATE = validated.tracestate;
    env[FEATURE_FACTORY_TRACESTATE] = validated.tracestate;
  }
  const parentSpanId = validated.parentSpanId || validated.traceparentSpanId;
  if (parentSpanId) env[FEATURE_FACTORY_PARENT_SPAN_ID] = parentSpanId;

  return env;
}

export async function withSpan(name, attributesOrCallback = {}, callbackOrOptions, maybeOptions = {}) {
  const callback = typeof attributesOrCallback === "function" ? attributesOrCallback : callbackOrOptions;
  if (typeof callback !== "function") throw new Error("withSpan requires a callback");
  const attributes = typeof attributesOrCallback === "function" ? {} : runAttributes(attributesOrCallback);
  const options = typeof attributesOrCallback === "function" ? (callbackOrOptions || {}) : maybeOptions;
  const tracer = trace.getTracer(options.tracerName || TELEMETRY_TRACER_NAME);

  return tracer.startActiveSpan(String(name), { attributes }, options.context || context.active(), async (span) => {
    try {
      return await callback(span);
    } catch (error) {
      recordError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

export function recordError(span, error) {
  if (!span || !error) return;
  const message = error instanceof Error ? error.message : String(error);
  const type = error instanceof Error && error.name ? error.name : typeof error;
  span.recordException?.(sanitizeException(error));
  span.setStatus?.({ code: SpanStatusCode.ERROR, message: sanitizeDiagnosticMessage(message) });
  span.setAttribute?.("error.type", sanitizeDiagnosticMessage(type));
}

export function runAttributes(input = {}) {
  if (!plainObject(input)) return {};
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || typeof value === "function") continue;
    output[key] = sanitizeAttribute(key, value);
  }
  return output;
}

function sanitizeOtlpHeaderEntry(entry) {
  const [rawName] = String(entry).split("=", 1);
  const name = sanitizeHeaderName(rawName);
  if (!name) return null;
  return { name, present: true, value: REDACTED_ENV_VALUE };
}

function sanitizeHeaderName(value) {
  const name = String(value || "").trim();
  if (!name) return null;
  if (!HEADER_NAME_PATTERN.test(name)) return REDACTED_ENV_VALUE;
  if (isSensitiveEnvKey(name) || isSensitiveEnvValue(name)) return REDACTED_ENV_VALUE;
  return name.toLowerCase();
}

function sanitizeAttribute(key, value) {
  if (isSensitiveEnvKey(key)) return REDACTED_ENV_VALUE;
  if (typeof value === "string") return isSensitiveEnvValue(value) ? REDACTED_ENV_VALUE : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const safe = value
      .filter((item) => SAFE_ATTRIBUTE_ARRAY_TYPES.has(typeof item))
      .map((item) => (typeof item === "string" && isSensitiveEnvValue(item) ? REDACTED_ENV_VALUE : item));
    return safe.length === value.length ? safe : JSON.stringify(scrubSecretEnv(value));
  }
  return JSON.stringify(scrubSecretEnv(value));
}

function sanitizeException(error) {
  const message = error instanceof Error ? error.message : String(error);
  const type = error instanceof Error && error.name ? error.name : typeof error;
  const exception = {
    name: sanitizeDiagnosticMessage(type),
    message: sanitizeDiagnosticMessage(message),
  };
  if (error instanceof Error && typeof error.stack === "string") {
    exception.stack = sanitizeDiagnosticMessage(error.stack);
  }
  return exception;
}

function sanitizeDiagnosticMessage(message) {
  return scrubSecretEnv(String(message || ""));
}

function validationError(error) {
  return { ok: false, error };
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}
