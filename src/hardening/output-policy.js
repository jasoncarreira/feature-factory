import {
  REDACTED_VALUE,
  SCRUB_MARKERS,
  containsRecognizedSensitiveFragment,
  isSensitiveKey,
  isRecognizedSensitiveValue,
  isSensitiveValue,
  scrubSensitiveData,
  scrubSensitiveString,
} from "./sensitive-data.js";
import { encodeTerminalText, serializeTerminalJson } from "./terminal-encoding.js";

export const SAFE_OUTPUT_FALLBACK = "Output rendering failed safely.";
export const SAFE_GENERIC_ERROR_DETAIL = "An unexpected error occurred.";
export const DIAGNOSTIC_FREEFORM_FIELDS = Object.freeze([
  "error", "message", "reason", "detail", "summary", "action",
]);

const OUTPUT_POLICY_ERROR_CODE = "ERR_OUTPUT_POLICY";
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const DESCRIPTIVE_RUN_ID_PATTERN = /^[a-z][a-z0-9]{0,31}(?:-(?:[a-z][a-z0-9]{0,31}|[0-9]{1,6}))+$/u;
const UUID_PATTERN = /[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}/u;
const segmentBrand = new WeakSet();
const structuredErrorBrand = new WeakSet();
const structuredErrorSegments = new WeakMap();
const TRUSTED_FRAMING_TEXT = Object.freeze({
  EMPTY: "", SPACE: " ", COLON_SPACE: ": ", COMMA_SPACE: ", ",
  DASH_SEPARATOR: " - ", SLASH: "/", EQUALS: "=", TAB: "\t",
  LINE_FEED: "\n", OPEN_PAREN: "(", CLOSE_PAREN: ")",
  OPEN_BRACKET: "[", CLOSE_BRACKET: "]", ERROR_PREFIX: "error: ",
  WARNING_PREFIX: "warning: ",
});

export const TRUSTED_SEGMENTS = createTrustedSegments();

export class OutputPolicyError extends Error {
  constructor(stage = "output") {
    super(SAFE_OUTPUT_FALLBACK);
    this.name = "OutputPolicyError";
    this.code = OUTPUT_POLICY_ERROR_CODE;
    this.stage = safeStage(stage);
  }
}

export class StructuredOutputError extends Error {
  constructor(message, segments) {
    if (typeof message !== "string") fail("error");
    const normalized = normalizeSegments(segments);
    super(message);
    Object.defineProperty(this, "name", {
      value: "StructuredOutputError", enumerable: false, configurable: false, writable: false,
    });
    structuredErrorBrand.add(this);
    structuredErrorSegments.set(this, normalized);
  }

  toString() {
    return renderTerminalSegmentsOrFallback(structuredErrorSegments.get(this));
  }
}

// Trusted framing is constructed only from the repository literals above. Callers
// select a named preconstructed segment; no runtime text construction API exists.
export function trustedSegment(name) {
  try {
    if (typeof name !== "string") fail("segment");
    const descriptor = Reflect.getOwnPropertyDescriptor(TRUSTED_SEGMENTS, name);
    if (!isDataDescriptor(descriptor) || !isOutputSegment(descriptor.value)) fail("segment");
    return descriptor.value;
  } catch (error) {
    if (error instanceof OutputPolicyError) throw error;
    fail("segment");
  }
}

export function identitySegment(value) { return makeSegment("identity", value); }
export function freeformSegment(value) { return makeSegment("freeform", value); }

export function isOutputSegment(value) {
  return (typeof value === "object" || typeof value === "function")
    && value !== null && segmentBrand.has(value);
}

export function renderTerminalSegments(segments) {
  try {
    return normalizeSegments(segments).map(renderSegment).join("");
  } catch (error) {
    if (error instanceof OutputPolicyError) throw error;
    fail("render");
  }
}

export function renderTerminalSegmentsOrFallback(segments) {
  try { return renderTerminalSegments(segments); } catch { return SAFE_OUTPUT_FALLBACK; }
}

export function projectFreeformData(value) {
  try { return scrubSensitiveData(value, { mode: "baseline" }); } catch { fail("projection"); }
}

export function isDisplaySafeRunId(value) {
  if (typeof value !== "string" || !SAFE_RUN_ID_PATTERN.test(value) || value.includes("..") || value.endsWith(".lock") || UUID_PATTERN.test(value)) return false;
  if (isRecognizedSensitiveValue(value, { mode: "baseline" }) || containsRecognizedSensitiveFragment(value)) return false;
  if (!isSensitiveValue(value, { mode: "baseline" })) return true;
  return DESCRIPTIVE_RUN_ID_PATTERN.test(value);
}

export function projectDiagnosticData(value, options = undefined) {
  try {
    const policy = readDiagnosticPolicy(options);
    return projectDiagnosticValue(value, policy, [], 0, createDiagnosticState(policy)).value;
  } catch (error) {
    if (error instanceof OutputPolicyError) throw error;
    fail("projection");
  }
}

export function safeGenericErrorDetail(error) {
  let detail = SAFE_GENERIC_ERROR_DETAIL;
  try {
    if (typeof error === "string") detail = error;
    else if ((typeof error === "object" || typeof error === "function") && error !== null) {
      const descriptor = Reflect.getOwnPropertyDescriptor(error, "message");
      if (descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string") {
        detail = descriptor.value;
      }
    }
  } catch { detail = SAFE_GENERIC_ERROR_DETAIL; }
  try { return scrubSensitiveString(detail, { mode: "baseline" }); }
  catch { return SAFE_GENERIC_ERROR_DETAIL; }
}

export function errorOutputSegments(error) {
  try {
    if (structuredErrorBrand.has(error)) return structuredErrorSegments.get(error);
  } catch { /* Treat malformed or hostile error-like values as unstructured freeform. */ }
  return Object.freeze([freeformSegment(safeGenericErrorDetail(error))]);
}

export function renderErrorForTerminal(error) {
  return renderTerminalSegmentsOrFallback(errorOutputSegments(error));
}

function makeSegment(kind, value) {
  const segment = Object.freeze({ kind, value });
  segmentBrand.add(segment);
  return segment;
}

function createTrustedSegments() {
  const output = Object.create(null);
  for (const name of Object.keys(TRUSTED_FRAMING_TEXT)) {
    defineData(output, name, makeSegment("trusted", TRUSTED_FRAMING_TEXT[name]));
  }
  return Object.freeze(output);
}

function renderSegment(segment) {
  if (segment.kind === "trusted") return segment.value;
  if (segment.kind === "identity") return encodeTerminalText(segment.value, { profile: "ascii-identity" });
  const scrubbed = projectFreeformData(segment.value);
  if (scrubbed !== null && typeof scrubbed === "object") return serializeTerminalJson(scrubbed);
  return encodeTerminalText(scrubbed, { profile: "unicode-prose" });
}

function normalizeSegments(segments) {
  try {
    if (!Array.isArray(segments) || Object.getPrototypeOf(segments) !== Array.prototype) fail("segment");
    const keys = Reflect.ownKeys(segments);
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(segments, "length");
    if (!isDataDescriptor(lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0 || keys.length !== lengthDescriptor.value + 1) fail("segment");
    const normalized = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(segments, String(index));
      if (!isDataDescriptor(descriptor) || descriptor.enumerable !== true
        || !isOutputSegment(descriptor.value)) fail("segment");
      normalized.push(descriptor.value);
    }
    return Object.freeze(normalized);
  } catch (error) {
    if (error instanceof OutputPolicyError) throw error;
    fail("segment");
  }
}

function readDiagnosticPolicy(options) {
  if (options === undefined) return defaultDiagnosticPolicy();
  if (options === null || (typeof options !== "object" && typeof options !== "function")) fail("projection");
  const fields = options.freeformFields === undefined ? DIAGNOSTIC_FREEFORM_FIELDS : options.freeformFields;
  if (!Array.isArray(fields) || fields.some((field) => typeof field !== "string")) fail("projection");
  const paths = options.validatedIdentityPaths === undefined ? [] : options.validatedIdentityPaths;
  if (!Array.isArray(paths)) fail("projection");
  return {
    freeformFields: new Set(fields),
    validatedIdentityPaths: paths.map(readIdentityPath),
    maxDepth: readDiagnosticBound(options, "maxDepth", 32),
    maxNodes: readDiagnosticBound(options, "maxNodes", 10_000),
    maxKeys: readDiagnosticBound(options, "maxKeys", 10_000),
    maxArrayLength: readDiagnosticBound(options, "maxArrayLength", 10_000, 2 ** 32 - 1, 1),
    maxStringLength: readDiagnosticBound(options, "maxStringLength", 65_536),
  };
}

function defaultDiagnosticPolicy() {
  return {
    freeformFields: new Set(DIAGNOSTIC_FREEFORM_FIELDS), validatedIdentityPaths: [],
    maxDepth: 32, maxNodes: 10_000, maxKeys: 10_000,
    maxArrayLength: 10_000, maxStringLength: 65_536,
  };
}

function readDiagnosticBound(options, name, fallback, maximum = Number.MAX_SAFE_INTEGER, minimum = 0) {
  const value = options[name] === undefined ? fallback : options[name];
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("projection");
  return value;
}

function readIdentityPath(path) {
  if (!Array.isArray(path) || path.length === 0) fail("projection");
  const normalized = [];
  for (let index = 0; index < path.length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(path, String(index));
    if (!isDataDescriptor(descriptor) || typeof descriptor.value !== "string"
      || descriptor.value.length === 0) fail("projection");
    normalized.push(descriptor.value);
  }
  if (Reflect.ownKeys(path).length !== path.length + 1) fail("projection");
  return Object.freeze(normalized);
}

function createDiagnosticState(policy) {
  return { nodes: 0, keys: 0, active: new WeakSet(), completed: new WeakSet(), ...policy };
}

function projectDiagnosticValue(value, policy, path, depth, state) {
  if (state.nodes >= state.maxNodes) return { value: SCRUB_MARKERS.truncated, stop: true };
  state.nodes += 1;
  if (isValidatedIdentityPath(policy.validatedIdentityPaths, path)) {
    return { value: validatedIdentityScalar(value), stop: false };
  }
  if (value === null || typeof value === "boolean") return { value, stop: false };
  if (typeof value === "string") {
    return { value: value.length > state.maxStringLength
      ? REDACTED_VALUE : scrubSensitiveString(value, { mode: "baseline" }), stop: false };
  }
  if (typeof value === "number") {
    return { value: Number.isFinite(value) && !Object.is(value, -0)
      ? value : SCRUB_MARKERS.unsupported, stop: false };
  }
  if (typeof value !== "object") return { value: SCRUB_MARKERS.unsupported, stop: false };
  let array;
  let prototype;
  try { array = Array.isArray(value); prototype = Object.getPrototypeOf(value); }
  catch { return { value: SCRUB_MARKERS.unavailable, stop: false }; }
  if ((array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)) {
    return { value: SCRUB_MARKERS.unsupported, stop: false };
  }
  if (depth >= state.maxDepth) return { value: SCRUB_MARKERS.truncated, stop: false };
  if (state.active.has(value)) return { value: SCRUB_MARKERS.circular, stop: false };
  if (state.completed.has(value)) return { value: SCRUB_MARKERS.repeated, stop: false };
  state.active.add(value);
  let result;
  try {
    result = array
      ? projectDiagnosticArray(value, policy, path, depth, state)
      : projectDiagnosticObject(value, policy, path, depth, state);
  } catch (error) {
    if (error instanceof OutputPolicyError) throw error;
    result = { value: SCRUB_MARKERS.unavailable, stop: false };
  }
  state.active.delete(value);
  state.completed.add(value);
  return result;
}

function projectDiagnosticArray(value, policy, path, depth, state) {
  let keys;
  let lengthDescriptor;
  try { keys = Reflect.ownKeys(value); lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length"); }
  catch { return { value: SCRUB_MARKERS.unavailable, stop: false }; }
  if (!isDataDescriptor(lengthDescriptor) || !Number.isInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0 || lengthDescriptor.value > 2 ** 32 - 1
    || keys.length !== lengthDescriptor.value + 1) fail("projection");
  const sourceLength = lengthDescriptor.value;
  const outputLength = Math.min(sourceLength, state.maxArrayLength);
  const forcedTruncationIndex = sourceLength > state.maxArrayLength ? outputLength - 1 : -1;
  const output = [];
  for (let index = 0; index < outputLength; index += 1) {
    if (index === forcedTruncationIndex) {
      defineData(output, String(index), SCRUB_MARKERS.truncated);
      return { value: output, stop: false };
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (!isDataDescriptor(descriptor) || descriptor.enumerable !== true) fail("projection");
    if (state.keys >= state.maxKeys) {
      defineData(output, String(index), SCRUB_MARKERS.truncated);
      return { value: output, stop: true };
    }
    state.keys += 1;
    const projected = projectDiagnosticValue(
      descriptor.value, policy, [...path, String(index)], depth + 1, state,
    );
    defineData(output, String(index), projected.value);
    if (projected.stop) return { value: output, stop: true };
  }
  return { value: output, stop: false };
}

function projectDiagnosticObject(value, policy, path, depth, state) {
  let keys;
  try { keys = Reflect.ownKeys(value); }
  catch { return { value: SCRUB_MARKERS.unavailable, stop: false }; }
  const output = Object.create(null);
  const allocated = new Set();
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const classified = key.length > state.maxStringLength
      || isSensitiveKey(key, { mode: "baseline" });
    let descriptor;
    try { descriptor = Reflect.getOwnPropertyDescriptor(value, key); }
    catch { descriptor = undefined; }
    if (descriptor && descriptor.enumerable !== true) continue;
    if (state.keys >= state.maxKeys) {
      addDiagnosticTruncation(output, allocated);
      return { value: output, stop: true };
    }
    state.keys += 1;
    if (classified) continue;
    if (key === "toJSON") fail("projection");
    allocated.add(key);
    if (!isDataDescriptor(descriptor)) {
      defineData(output, key, SCRUB_MARKERS.unavailable);
      continue;
    }
    const projected = projectDiagnosticValue(
      descriptor.value, policy, [...path, key], depth + 1, state,
    );
    defineData(output, key, projected.value);
    if (projected.stop) return { value: output, stop: true };
  }
  return { value: output, stop: false };
}

function addDiagnosticTruncation(output, allocated) {
  let key = SCRUB_MARKERS.truncated;
  for (let suffix = 2; allocated.has(key); suffix += 1) key = `${SCRUB_MARKERS.truncated}#${suffix}`;
  defineData(output, key, SCRUB_MARKERS.truncated);
}

function validatedIdentityScalar(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  fail("projection");
}

function isValidatedIdentityPath(patterns, path) {
  return patterns.some((pattern) => pattern.length === path.length && pathMatches(pattern, path));
}

function pathMatches(pattern, path) {
  return pattern.every((part, index) => part === "*" || part === path[index]);
}

function isDataDescriptor(descriptor) {
  return descriptor !== undefined && Object.hasOwn(descriptor, "value");
}

function defineData(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function safeStage(stage) {
  return ["segment", "render", "projection", "error", "output"].includes(stage) ? stage : "output";
}

function fail(stage) { throw new OutputPolicyError(stage); }
