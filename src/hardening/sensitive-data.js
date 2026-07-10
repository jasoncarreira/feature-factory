const BASELINE_SENSITIVE_KEY_PATTERN = /(?:secret|token|password|passwd|pwd|api[_-]?key|private[_-]?key|credential|authorization|auth[_-]?header|access[_-]?key|bearer|cookie)/iu;
const BASELINE_SENSITIVE_VALUE_PATTERN = /(?:secret|token|password|passwd|api[_-]?key|private[_-]?key)/iu;
const TOKEN_SHAPED_VALUE_PATTERNS = Object.freeze([
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/iu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/iu,
  /\bhc_[A-Za-z0-9][A-Za-z0-9_-]{10,}\b/iu,
  /\bsk-proj[-_][A-Za-z0-9_-]{20,}\b/iu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/iu,
  /\bxox[abp][_-][A-Za-z0-9-]{10,}(?:-[A-Za-z0-9-]{10,})*\b/iu,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/iu,
  /\beyJ[A-Za-z0-9_-]{7,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/iu,
  /(?:^|[^A-Za-z0-9-])(?:[A-Fa-f0-9]{32,})(?=$|[^A-Za-z0-9-])/u,
  /(?:https?|ssh|git|ftp):\/\/[^/\s:@]+:[^/\s@]+@/iu,
]);
const ENDPOINT_PROVIDER_PREFIX_PATTERN = /(?:hc[a-z0-9_-]*|gh[pousr]|github_pat|sk(?:-proj)?|xox[abp]|glpat)[_-][A-Za-z0-9_-]{10,}/iu;
const ENDPOINT_BARE_HEX_PATTERN = /^[A-Fa-f0-9]{32,}$/u;
const ENDPOINT_SECRET_ASSIGNMENT_PATTERN = /(?:(?:key|token|secret|password|authorization|credential|access|team|api[_-]?key)\s*[=:]|[=:]\s*(?:key|token|secret|password|authorization|credential|access|team|api[_-]?key))/iu;
const ENDPOINT_LONG_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]{24,}$/u;
const HIGH_ENTROPY_SINGLE_TOKEN_MIN_LENGTH = 32;
const HIGH_ENTROPY_MIN_SHANNON = 3.5;
const SAFE_HIGH_ENTROPY_KEY_PATTERN = /^(?:OTEL_EXPORTER_OTLP(?:_(?:TRACES|METRICS|LOGS))?_(?:ENDPOINT|HEADERS|PROTOCOL|TIMEOUT|COMPRESSION|INSECURE|CERTIFICATE)|FEATURE_FACTORY_OTEL_ENABLED)$/u;
const ARRAY_INDEX_MAX = 2 ** 32 - 2;

export const REDACTED_VALUE = "[redacted]";
export const REDACTED_KEY = "[redacted-key]";
export const SCRUB_MARKERS = Object.freeze({
  circular: "[circular]",
  repeated: "[repeated]",
  truncated: "[truncated]",
  unsupported: "[unsupported]",
  unavailable: "[unavailable]",
});

export function isSensitiveKey(value, { mode = "baseline" } = {}) {
  assertMode(mode);
  if (typeof value !== "string") return false;
  return BASELINE_SENSITIVE_KEY_PATTERN.test(value) || isSecretShapedKey(value, { mode });
}

export function isSecretShapedKey(value, { mode = "baseline" } = {}) {
  assertMode(mode);
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || SAFE_HIGH_ENTROPY_KEY_PATTERN.test(trimmed)) return false;
  return tokenShapedValue(trimmed)
    || credentialBearingUrl(trimmed)
    || highEntropySingleToken(trimmed)
    || (mode === "endpoint" && endpointValueLooksSensitive(trimmed));
}

export function isSensitiveValue(value, { mode = "baseline" } = {}) {
  assertMode(mode);
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return BASELINE_SENSITIVE_VALUE_PATTERN.test(trimmed)
    || tokenShapedValue(trimmed)
    || credentialBearingUrl(trimmed)
    || highEntropySingleToken(trimmed)
    || (mode === "endpoint" && endpointValueLooksSensitive(trimmed));
}

export function scrubSensitiveString(value, { mode = "baseline" } = {}) {
  assertMode(mode);
  if (typeof value !== "string") return SCRUB_MARKERS.unsupported;
  return isSensitiveValue(value, { mode }) ? REDACTED_VALUE : value;
}

export function scrubSensitiveData(value, {
  mode = "baseline",
  keyMode = "omit",
  maxDepth = 32,
  maxNodes = 10_000,
  maxKeys = 10_000,
  maxArrayLength = 10_000,
  maxStringLength = 65_536,
} = {}) {
  assertMode(mode);
  if (keyMode !== "omit" && keyMode !== "redact") throw new TypeError("invalid sensitive-data key mode");
  assertBound("maxDepth", maxDepth);
  assertBound("maxNodes", maxNodes);
  assertBound("maxKeys", maxKeys);
  assertBound("maxArrayLength", maxArrayLength, 2 ** 32 - 1, 1);
  assertBound("maxStringLength", maxStringLength);

  const state = {
    mode,
    keyMode,
    maxDepth,
    maxNodes,
    maxKeys,
    maxArrayLength,
    maxStringLength,
    nodes: 0,
    keys: 0,
    active: new WeakSet(),
    completed: new WeakSet(),
  };
  return scrubValue(value, 0, state).value;
}

function scrubValue(value, depth, state) {
  if (state.nodes >= state.maxNodes) return { value: SCRUB_MARKERS.truncated, stop: true };
  state.nodes += 1;

  if (value === null || typeof value === "boolean") return { value, stop: false };
  if (typeof value === "number") {
    return { value: Number.isFinite(value) && !Object.is(value, -0) ? value : SCRUB_MARKERS.unsupported, stop: false };
  }
  if (typeof value === "string") {
    if (value.length > state.maxStringLength) return { value: REDACTED_VALUE, stop: false };
    return { value: scrubSensitiveString(value, { mode: state.mode }), stop: false };
  }
  if (typeof value !== "object") return { value: SCRUB_MARKERS.unsupported, stop: false };

  let array;
  let prototype;
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return { value: SCRUB_MARKERS.unavailable, stop: false };
  }
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
    result = array ? scrubArray(value, depth, state) : scrubObject(value, depth, state);
  } catch {
    result = { value: SCRUB_MARKERS.unavailable, stop: false };
  }
  state.active.delete(value);
  state.completed.add(value);
  return result;
}

function scrubObject(source, depth, state) {
  let keys;
  try {
    keys = Reflect.ownKeys(source);
  } catch {
    return { value: SCRUB_MARKERS.unavailable, stop: false };
  }

  const output = Object.create(null);
  return projectKeys(source, output, keys, depth, state, () => true);
}

function scrubArray(source, depth, state) {
  let lengthDescriptor;
  let keys;
  try {
    lengthDescriptor = Reflect.getOwnPropertyDescriptor(source, "length");
    keys = Reflect.ownKeys(source);
  } catch {
    return { value: SCRUB_MARKERS.unavailable, stop: false };
  }
  if (!lengthDescriptor || !("value" in lengthDescriptor)
    || !Number.isInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > 2 ** 32 - 1) {
    return { value: SCRUB_MARKERS.unavailable, stop: false };
  }

  const sourceLength = lengthDescriptor.value;
  const outputLength = Math.min(sourceLength, state.maxArrayLength);
  const output = new Array(outputLength);
  const overCap = sourceLength > state.maxArrayLength;
  const forcedTruncationIndex = overCap && outputLength > 0 ? outputLength - 1 : -1;
  if (forcedTruncationIndex >= 0) defineData(output, String(forcedTruncationIndex), SCRUB_MARKERS.truncated);

  return projectKeys(source, output, keys, depth, state, (key) => {
    if (key === "length") return false;
    const index = arrayIndex(key);
    if (index === null) return true;
    if (index >= outputLength) return false;
    return index !== forcedTruncationIndex;
  });
}

function projectKeys(source, output, keys, depth, state, include) {
  const prepared = prepareKeys(source, keys, state, include);
  const allocated = new Set(prepared.reserved);
  for (const item of prepared.items) {
    const { key, sensitive, descriptor } = item;
    if (state.keys >= state.maxKeys) {
      addTruncationProperty(output, allocated);
      return { value: output, stop: true };
    }
    state.keys += 1;

    if (item.unavailable) {
      if (state.keyMode === "omit" && sensitive) continue;
      const outputKey = sensitive ? allocateName(REDACTED_KEY, allocated) : key;
      defineData(output, outputKey, SCRUB_MARKERS.unavailable);
      continue;
    }
    if (sensitive) {
      if (state.keyMode === "redact") defineData(output, allocateName(REDACTED_KEY, allocated), REDACTED_VALUE);
      continue;
    }
    if (!("value" in descriptor)) {
      defineData(output, key, SCRUB_MARKERS.unavailable);
      continue;
    }

    const scrubbed = scrubValue(descriptor.value, depth + 1, state);
    defineData(output, key, scrubbed.value);
    if (scrubbed.stop) return { value: output, stop: true };
  }
  if (prepared.truncated) {
    addTruncationProperty(output, allocated);
    return { value: output, stop: true };
  }
  return { value: output, stop: false };
}

function prepareKeys(source, keys, state, include) {
  const items = [];
  const reserved = new Set();
  const remaining = state.maxKeys - state.keys;
  for (const key of keys) {
    if (typeof key !== "string" || !include(key)) continue;
    const sensitive = key.length > state.maxStringLength || isSensitiveKey(key, { mode: state.mode });

    let descriptor;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    } catch {
      descriptor = null;
    }
    if (descriptor && descriptor.enumerable !== true) continue;
    if (items.length >= remaining) return { items, reserved, truncated: true };
    items.push({ key, sensitive, descriptor, unavailable: descriptor === null || descriptor === undefined });
    if (!sensitive) reserved.add(key);
  }
  return { items, reserved, truncated: false };
}

function addTruncationProperty(output, allocated) {
  defineData(output, allocateName(SCRUB_MARKERS.truncated, allocated), SCRUB_MARKERS.truncated);
}

function allocateName(base, allocated) {
  if (!allocated.has(base)) {
    allocated.add(base);
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}#${suffix}`;
    if (!allocated.has(candidate)) {
      allocated.add(candidate);
      return candidate;
    }
  }
}

function defineData(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function arrayIndex(key) {
  if (key === "") return null;
  const number = Number(key);
  if (!Number.isInteger(number) || number < 0 || number > ARRAY_INDEX_MAX || String(number) !== key) return null;
  return number;
}

function endpointValueLooksSensitive(value) {
  return ENDPOINT_PROVIDER_PREFIX_PATTERN.test(value)
    || ENDPOINT_BARE_HEX_PATTERN.test(value)
    || ENDPOINT_SECRET_ASSIGNMENT_PATTERN.test(value)
    || (ENDPOINT_LONG_TOKEN_PATTERN.test(value) && mixedTokenChars(value));
}

function tokenShapedValue(value) {
  return TOKEN_SHAPED_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function credentialBearingUrl(value) {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return false;
  }
}

function highEntropySingleToken(value) {
  if (value.length < HIGH_ENTROPY_SINGLE_TOKEN_MIN_LENGTH || /\s/u.test(value)) return false;
  if (!/^[A-Za-z0-9._~+/=-]+$/u.test(value)) return false;
  return shannonEntropy(value) >= HIGH_ENTROPY_MIN_SHANNON;
}

function shannonEntropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function mixedTokenChars(value) {
  return /[A-Z]/u.test(value) && /[a-z]/u.test(value) && /[0-9]/u.test(value);
}

function assertMode(mode) {
  if (mode !== "baseline" && mode !== "endpoint") throw new TypeError("invalid sensitive-data mode");
}

function assertBound(name, value, maximum = Number.MAX_SAFE_INTEGER, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`invalid sensitive-data ${name}`);
  }
}
