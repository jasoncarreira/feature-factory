import { createHash } from "node:crypto";
import {
  REDACTED_ENV_VALUE,
  isSecretShapedEnvKey,
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
const OTLP_ENDPOINT_PATTERN = /^OTEL_EXPORTER_OTLP(?:_[A-Z0-9_]+)?_ENDPOINT$/u;
const OTLP_HEADERS_PATTERN = /^OTEL_EXPORTER_OTLP(?:_[A-Z0-9_]+)?_HEADERS$/u;
// W3C trace-context caps tracestate at 512 characters; oversized values get
// truncated or dropped by downstream propagators, so reject them up front.
const MAX_TRACESTATE_LENGTH = 512;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const SAFE_ATTRIBUTE_ARRAY_TYPES = new Set(["string", "number", "boolean"]);
const B6_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const B6_MAX_IDENTIFIER_BYTES = 128;
const B6_MAX_RETAINED_SPAN_MS = 3_600_000;
const B6_SPAN_NAMES = new Set([
  "feature_factory.session",
  "feature_factory.task",
  "feature_factory.factory.start",
  "feature_factory.factory.continue",
  "feature_factory.factory.resume",
  // Operator and control-plane spans. The taxonomy in SPEC section 14 writes
  // these as `factory.gate <gate>`, but a dynamic span name cannot pass this
  // allowlist, so the subject travels as an identifier attribute instead and the
  // name stays fixed.
  "feature_factory.factory.validate",
  "feature_factory.factory.cleanup",
  "feature_factory.factory.gate",
  "feature_factory.factory.heartbeat",
]);
const B6_IDENTIFIER_ATTRIBUTES = new Set([
  "feature_factory.run_id",
  "feature_factory.slice_id",
  // Plan-defined and operator-supplied subjects. Identifier handling is the right
  // home for them: it pattern-validates, bounds the byte length, and pseudonymizes
  // anything sensitive or high-entropy, which a fixed enum could not do for names
  // this contract does not choose.
  "feature_factory.gate",
  "feature_factory.heartbeat_phase",
  "feature_factory.session_id",
  "feature_factory.parent_session_id",
  "feature_factory.call_id",
  "gen_ai.conversation.id",
]);
const B6_OPAQUE_IDENTIFIER_ATTRIBUTES = new Set([
  "feature_factory.session_id",
  "feature_factory.parent_session_id",
  "feature_factory.call_id",
]);
const B6_ENUM_ATTRIBUTES = new Map([
  ["feature_factory.target_agent", new Set(["feature-factory", "story-reader", "story-writer", "codebase-researcher", "design-interpreter", "spec-writer", "work-decomposer", "backend-builder", "frontend-builder", "test-verifier", "work-reviewer", "implementation-validator", "security-reviewer"])],
  ["feature_factory.route", new Set(["ordinary-slice", "integration-amendment", "integration-amendment-review", "panel-remediation", "post-pr-remediation", "integration-conflict"])],
  ["feature_factory.lane", new Set(["backend", "frontend", "reviewer"])],
  ["feature_factory.task_context", new Set(["fresh", "reuse"])],
  ["feature_factory.call_relationship", new Set(["task-hook", "parent-session"])],
  ["feature_factory.span_event", new Set(["session-created", "session-updated", "session-deleted", "session-status", "session-idle", "session-compacted", "task-before", "task-after"])],
  ["feature_factory.span_operation", new Set(["observe-session", "execute-task"])],
  ["feature_factory.mode", new Set(["interactive", "headless", "autonomous"])],
  ["feature_factory.status", new Set(["started", "dry-run", "completed", "blocked", "partial", "needs-human", "recovery-required", "already-running", "failed"])],
  ["feature_factory.verdict", new Set(["APPROVE", "REJECT", "GO", "GO-WITH-NITS", "NO-GO", "PASS", "BLOCK", "APPROVE-CHECKPOINT", "REDESIGN-REQUIRED"])],
  ["feature_factory.convergence", new Set(["converging", "nonconvergent"])],
  ["feature_factory.continuation_kind", new Set(["full-plan-carry-forward"])],
  ["gen_ai.agent.name", new Set(["feature-factory", "story-reader", "story-writer", "codebase-researcher", "design-interpreter", "spec-writer", "work-decomposer", "backend-builder", "frontend-builder", "test-verifier", "work-reviewer", "implementation-validator", "security-reviewer"])],
  ["gen_ai.operation.name", new Set(["invoke_agent", "execute_tool"])],
  ["feature_factory.gate_decision", new Set(["pending", "approved", "changes_requested", "stopped"])],
  ["feature_factory.heartbeat_operation", new Set(["start", "stop", "tick", "status"])],
]);
// Counts are bounded non-negative integers rather than enums. They are the only
// numeric payload these spans carry, and they answer the questions the taxonomy
// asks of `factory.validate` and `factory.cleanup` ("validation ok/error counts",
// "removed/skipped counts") without naming a single run, path, or artifact.
const B6_COUNT_ATTRIBUTES = new Set([
  "feature_factory.run_count",
  "feature_factory.error_count",
  "feature_factory.removed_count",
  "feature_factory.skipped_count",
]);
// @opentelemetry/api SpanStatusCode.ERROR is the stable enum value 2. Inlined so
// this module never needs a static import of an optional runtime dependency.
const SPAN_STATUS_ERROR = 2;
// Lazy, cached load of the optional @opentelemetry/api package. `undefined` means
// not yet attempted, `null` means unavailable, an object is the loaded module.
let cachedOtelApi;
async function loadOtelApi(importer) {
  if (typeof importer === "function") {
    try {
      return await importer();
    } catch {
      return null;
    }
  }
  if (cachedOtelApi !== undefined) return cachedOtelApi;
  try {
    cachedOtelApi = await import("@opentelemetry/api");
  } catch {
    cachedOtelApi = null;
  }
  return cachedOtelApi;
}
function noopSpan() {
  return {
    addEvent() {},
    recordException() {},
    setStatus() {},
    setAttribute() {},
    end() {},
  };
}
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
  if (isSensitiveEnvKey(key)) return REDACTED_ENV_VALUE;
  if (OTLP_ENDPOINT_PATTERN.test(key)) return sanitizeOtlpEndpointValue(string);
  if (isSensitiveEnvValue(string)) return REDACTED_ENV_VALUE;
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
  if (tracestate.length > MAX_TRACESTATE_LENGTH) return validationError(`tracestate must be at most ${MAX_TRACESTATE_LENGTH} characters`);
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

const TRACE_CONTEXT_ENV_KEYS = Object.freeze([
  "TRACEPARENT",
  "TRACESTATE",
  FEATURE_FACTORY_TRACEPARENT,
  FEATURE_FACTORY_TRACESTATE,
  FEATURE_FACTORY_PARENT_SPAN_ID,
]);

export function prepareTelemetryEnv(baseEnv = process.env, traceContext = {}) {
  const env = { ...(baseEnv || {}) };
  const validated = validateTraceContext(traceContext);
  if (!validated.ok) throw new Error(validated.error);

  const hasExplicitContext = validated.traceparent !== undefined
    || validated.tracestate !== undefined
    || validated.parentSpanId !== undefined;
  if (!hasExplicitContext) return env;

  // An explicit override replaces the whole ambient trace context. Keeping any
  // inherited field alongside supplied ones can pair a stale TRACESTATE with a
  // new trace, or a contradictory inherited TRACEPARENT with an explicit parent
  // span id, leaving the child process with an ambiguous context.
  for (const key of TRACE_CONTEXT_ENV_KEYS) delete env[key];

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

function activeParentContext(api, env) {
  const fallback = api.context?.active?.();
  try {
    const traceparent = env?.[FEATURE_FACTORY_TRACEPARENT] ?? env?.TRACEPARENT;
    if (!traceparent) return fallback;
    const parsed = validateTraceContext({
      traceparent,
      tracestate: env?.[FEATURE_FACTORY_TRACESTATE] ?? env?.TRACESTATE,
    });
    if (!parsed.ok || typeof api.trace?.setSpanContext !== "function") return fallback;
    const spanContext = {
      traceId: parsed.traceId,
      spanId: parsed.traceparentSpanId,
      traceFlags: Number.parseInt(parsed.traceFlags, 16),
      isRemote: true,
      ...(parsed.tracestate && typeof api.createTraceState === "function"
        ? { traceState: api.createTraceState(parsed.tracestate) } : {}),
    };
    return api.trace.setSpanContext(fallback, spanContext);
  } catch {
    return fallback;
  }
}

export async function withSpan(name, attributesOrCallback = {}, callbackOrOptions, maybeOptions = {}) {
  const callback = typeof attributesOrCallback === "function" ? attributesOrCallback : callbackOrOptions;
  if (typeof callback !== "function") throw new Error("withSpan requires a callback");
  const options = typeof attributesOrCallback === "function" ? (callbackOrOptions || {}) : maybeOptions;
  let attributes = {};
  try {
    attributes = typeof attributesOrCallback === "function"
      ? {}
      : options.attributeMode === "metadata-only" ? b6Attributes(attributesOrCallback) : runAttributes(attributesOrCallback);
  } catch {
    attributes = {};
  }

  let api;
  try { api = await loadOtelApi(options.importer); } catch { api = null; }
  if (!api) return callback(noopSpan());

  let tracer;
  let activeContext;
  try {
    tracer = api.trace?.getTracer?.(options.tracerName || TELEMETRY_TRACER_NAME);
    activeContext = options.context ?? activeParentContext(api, options.env ?? process.env);
  } catch {
    return callback(noopSpan());
  }
  if (!tracer || typeof tracer.startActiveSpan !== "function") return callback(noopSpan());

  let workflowStarted = false;
  let workflowPromise;
  const runWorkflow = (span = noopSpan()) => {
    if (workflowStarted) return workflowPromise;
    workflowStarted = true;
    workflowPromise = (async () => {
      try {
        return await callback(span);
      } catch (error) {
        if (options.errorMode === "metadata-only") recordMetadataOnlyError(span);
        else recordError(span, error);
        throw error;
      } finally {
        try { span.end?.(); } catch { /* telemetry-only */ }
      }
    })();
    return workflowPromise;
  };
  try {
    const providerResult = tracer.startActiveSpan(String(name), { attributes }, activeContext, runWorkflow);
    Promise.resolve(providerResult).catch(() => undefined);
  } catch {
    // A provider may throw before or after synchronously invoking the callback.
  }
  if (!workflowStarted) return runWorkflow();
  return workflowPromise;
}

export function recordError(span, error) {
  if (!span || !error) return;
  const message = error instanceof Error ? error.message : String(error);
  const type = error instanceof Error && error.name ? error.name : typeof error;
  try { span.recordException?.(sanitizeException(error)); } catch { /* telemetry-only */ }
  try { span.setStatus?.({ code: SPAN_STATUS_ERROR, message: sanitizeDiagnosticMessage(message) }); } catch { /* telemetry-only */ }
  try { span.setAttribute?.("error.type", sanitizeDiagnosticMessage(type)); } catch { /* telemetry-only */ }
}

function recordMetadataOnlyError(span) {
  try { span.setStatus?.({ code: SPAN_STATUS_ERROR }); } catch { /* telemetry-only */ }
  try { span.setAttribute?.("error.type", "workflow_error"); } catch { /* telemetry-only */ }
}

export function isB6TelemetryEnabled(options = {}, env = process.env) {
  try {
    const value = typeof env?.FEATURE_FACTORY_OTEL_ENABLED === "string" ? env.FEATURE_FACTORY_OTEL_ENABLED.trim().toLowerCase() : "";
    return options?.telemetry?.enabled === true || value === "true" || value === "1";
  } catch {
    return false;
  }
}

export function b6Attributes(input = {}) {
  const output = {};
  try {
    if (!plainObject(input)) return output;
    for (const [key, value] of Object.entries(input)) {
      if (B6_IDENTIFIER_ATTRIBUTES.has(key)) {
        const identifier = b6Identifier(key, value);
        if (identifier) output[key] = identifier;
        continue;
      }
      const values = B6_ENUM_ATTRIBUTES.get(key);
      if (values?.has(value)) {
        output[key] = value;
        continue;
      }
      if (key === "feature_factory.attempt" && Number.isSafeInteger(value) && value >= 1 && value <= 3) {
        output[key] = value;
        continue;
      }
      if (B6_COUNT_ATTRIBUTES.has(key) && Number.isSafeInteger(value) && value >= 0) {
        output[key] = value;
      }
    }
  } catch {
    return {};
  }
  return output;
}

export function startB6Span(name, attributes = {}, options = {}) {
  try {
    if (!isB6TelemetryEnabled(options, options.env ?? process.env)) return inertB6Span();
    if (!B6_SPAN_NAMES.has(name)) return inertB6Span();
  } catch {
    return inertB6Span();
  }

  let ended = false;
  let releaseLifetime;
  let resolveFacade;
  const lifetime = new Promise((resolve) => { releaseLifetime = resolve; });
  const facadeReady = new Promise((resolve) => { resolveFacade = resolve; });
  const execution = withB6Span(name, attributes, async (facade) => {
    resolveFacade(facade);
    await lifetime;
  }, options).catch(() => undefined);
  let operationChain = Promise.resolve();
  let resolveTimeout;
  const timeout = new Promise((resolve) => { resolveTimeout = resolve; });
  const timer = setTimeout(() => {
    ended = true;
    resolveFacade(inertB6Facade());
    releaseLifetime();
    resolveTimeout();
  }, B6_MAX_RETAINED_SPAN_MS);
  timer.unref?.();
  void execution.finally(() => clearTimeout(timer)).catch(() => undefined);

  const queue = (operation) => {
    operationChain = operationChain.then(async () => {
      const facade = await facadeReady;
      try { operation(facade); } catch { /* telemetry-only */ }
    }, () => undefined);
    return operationChain;
  };
  const controller = {
    setAttributes(more) {
      if (ended) return;
      queue((facade) => facade.setAttributes(more));
    },
    addEvent(event) {
      if (ended) return;
      if (!B6_ENUM_ATTRIBUTES.get("feature_factory.span_event").has(event)) return;
      queue((facade) => facade.addEvent(event));
    },
    fail() {
      if (ended) return;
      queue((facade) => facade.fail());
    },
    end(more) {
      if (ended) return controller.done;
      if (more) controller.setAttributes(more);
      ended = true;
      const completion = operationChain.then(() => releaseLifetime(), () => releaseLifetime()).then(() => execution, () => undefined);
      controller.done = Promise.race([completion, timeout]).then(() => undefined, () => undefined);
      return controller.done;
    },
    done: Promise.race([execution, timeout]).then(() => undefined, () => undefined),
  };
  return controller;
}

export function emitB6Span(name, attributes = {}, options = {}) {
  try {
    if (!isB6TelemetryEnabled(options, options.env ?? process.env) || !B6_SPAN_NAMES.has(name)) return Promise.resolve();
    return withB6Span(name, attributes, () => undefined, options).then(() => undefined, () => undefined);
  } catch {
    return Promise.resolve();
  }
}

export function withB6Span(name, attributes, callback, options = {}) {
  if (typeof callback !== "function") return Promise.reject(new Error("withB6Span requires a callback"));
  try {
    if (!isB6TelemetryEnabled(options, options.env ?? process.env) || !B6_SPAN_NAMES.has(name)) return Promise.resolve().then(() => callback(inertB6Facade()));
    return withSpan(name, attributes, (span) => callback(b6Facade(span)), {
      importer: options.importer ?? options.telemetry?.importer,
      tracerName: options.tracerName,
      context: options.context ?? options.telemetry?.context,
      env: options.env ?? process.env,
      errorMode: "metadata-only",
      attributeMode: "metadata-only",
    });
  } catch {
    return Promise.resolve().then(() => callback(inertB6Facade()));
  }
}

function inertB6Span() {
  const done = Promise.resolve();
  return Object.freeze({ setAttributes() {}, addEvent() {}, fail() {}, end() { return done; }, done });
}

function inertB6Facade() {
  return Object.freeze({ setAttributes() {}, addEvent() {}, fail() {} });
}

function b6Facade(span) {
  return Object.freeze({
    setAttributes(more) {
      for (const [key, value] of Object.entries(b6Attributes(more))) {
        try { span.setAttribute?.(key, value); } catch { /* telemetry-only */ }
      }
    },
    addEvent(event) {
      if (!B6_ENUM_ATTRIBUTES.get("feature_factory.span_event").has(event)) return;
      try { span.addEvent?.(event); } catch { /* telemetry-only */ }
    },
    fail() { recordMetadataOnlyError(span); },
  });
}

function b6Identifier(key, value) {
  if (typeof value !== "string" || !B6_IDENTIFIER_PATTERN.test(value)) return null;
  if (Buffer.byteLength(value, "utf8") > B6_MAX_IDENTIFIER_BYTES) return null;
  if (!B6_OPAQUE_IDENTIFIER_ATTRIBUTES.has(key) && !isSensitiveEnvValue(value) && !shortHighEntropyToken(value)) return value;
  return pseudonymizedIdentifier(value);
}

function shortHighEntropyToken(value) {
  if (value.length < 20 || !/^[A-Za-z0-9._~+/:=-]+$/u.test(value)) return false;
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  const entropy = [...counts.values()].reduce((total, count) => {
    const probability = count / value.length;
    return total - probability * Math.log2(probability);
  }, 0);
  return entropy >= 3.5;
}

function pseudonymizedIdentifier(value) {
  return `ffid:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32)}`;
}

export function runAttributes(input = {}) {
  if (!plainObject(input)) return {};
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || typeof value === "function") continue;
    if (isUnsafeAttributeKey(key)) continue;
    output[key] = sanitizeAttribute(key, value);
  }
  return output;
}

function sanitizeOtlpHeaderEntry(entry) {
  const index = String(entry).indexOf("=");
  if (index <= 0) return null;
  const rawName = String(entry).slice(0, index);
  const name = sanitizeHeaderName(rawName);
  if (!name) return null;
  return { name, present: true, value: REDACTED_ENV_VALUE };
}

function sanitizeOtlpEndpointValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return raw;

  try {
    const parsed = new URL(raw);
    const safeHost = sanitizeEndpointHost(parsed);
    const safePath = sanitizeEndpointPath(parsed.pathname, raw);
    const safeQuery = endpointSearchHasValues(parsed.searchParams) ? `?${REDACTED_ENV_VALUE}` : "";
    const safeHash = parsed.hash ? `#${REDACTED_ENV_VALUE}` : "";
    return `${parsed.protocol}//${safeHost}${safePath}${safeQuery}${safeHash}`;
  } catch {
    return scrubSecretEnv(raw);
  }
}

function sanitizeEndpointHost(parsed) {
  const hostname = parsed.hostname;
  const port = parsed.port ? `:${parsed.port}` : "";
  if (!hostname) return scrubSecretEnv(parsed.host || "");
  if (hostname.startsWith("[") && hostname.endsWith("]")) return `${hostname}${port}`;
  const safeHostname = hostname
    .split(".")
    .map((label) => sanitizeEndpointComponent(label))
    .join(".");
  return `${safeHostname}${port}`;
}

function sanitizeEndpointPath(pathname, raw) {
  const safePath = String(pathname || "/")
    .split("/")
    .map((segment) => sanitizeEndpointComponent(segment))
    .join("/") || "/";
  if (safePath === "/" && !/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+\//iu.test(raw)) return "";
  return safePath;
}

function sanitizeEndpointComponent(value) {
  if (!value) return value;
  const decoded = safeDecodeURIComponent(value);
  if (isSensitiveEnvValue(decoded) || scrubSecretEnv(decoded) === REDACTED_ENV_VALUE) return REDACTED_ENV_VALUE;
  return scrubSecretEnv(value);
}

function endpointSearchHasValues(searchParams) {
  for (const [key, value] of searchParams.entries()) {
    if (key || value) return true;
  }
  return false;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
    // OTel attribute arrays must be homogeneous; mixed primitive types get
    // dropped or rejected by SDKs, so coerce them to a JSON string instead.
    const homogeneous = new Set(safe.map((item) => typeof item)).size <= 1;
    return safe.length === value.length && homogeneous ? safe : JSON.stringify(scrubSecretEnv(value));
  }
  return JSON.stringify(scrubSecretEnv(value));
}

function isUnsafeAttributeKey(key) {
  return isSecretShapedEnvKey(key);
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
