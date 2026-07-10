const ASCII_IDENTITY_PROFILE = "ascii-identity";
const UNICODE_PROSE_PROFILE = "unicode-prose";
const SAFE_JSON_MESSAGE = "Value is not valid safe JSON data.";

const UNICODE_PROSE_SCALAR = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;
const DEFAULT_IGNORABLE_SCALAR = /^\p{Default_Ignorable_Code_Point}$/u;

export class SafeJsonError extends Error {
  constructor() {
    super(SAFE_JSON_MESSAGE);
    this.name = "SafeJsonError";
  }
}

export function encodeTerminalText(value, options = undefined) {
  return encodeTerminalValue(value, readProfile(options, UNICODE_PROSE_PROFILE), false);
}

export function encodeTerminalLabel(value, options = undefined) {
  const encoded = encodeTerminalValue(value, readProfile(options, ASCII_IDENTITY_PROFILE), true);
  return `"${encoded}"`;
}

export function assertJsonDataModel(value) {
  try {
    return cloneJsonValue(value, new WeakSet());
  } catch {
    throw new SafeJsonError();
  }
}

export function serializeTerminalJson(value, options = undefined) {
  try {
    const space = readJsonSpace(options);
    const clone = cloneJsonValue(value, new WeakSet());
    return escapeJsonTransport(JSON.stringify(clone, null, space));
  } catch {
    throw new SafeJsonError();
  }
}

function readProfile(options, fallback) {
  try {
    if (options === undefined) return fallback;
    if (options === null || (typeof options !== "object" && typeof options !== "function")) {
      throw new TypeError();
    }
    const profile = options.profile === undefined ? fallback : options.profile;
    if (profile !== ASCII_IDENTITY_PROFILE && profile !== UNICODE_PROSE_PROFILE) {
      throw new TypeError();
    }
    return profile;
  } catch {
    throw new TypeError("Invalid terminal encoding options.");
  }
}

function encodeTerminalValue(value, profile, quoteIsReserved) {
  let text;
  try {
    text = String(value);
  } catch {
    throw new TypeError("Terminal text encoding failed.");
  }

  let encoded = "";
  for (let index = 0; index < text.length;) {
    const first = text.charCodeAt(index);

    if (first === 0x5C) {
      encoded += "\\\\";
      index += 1;
      continue;
    }
    if (quoteIsReserved && first === 0x22) {
      encoded += "\\\"";
      index += 1;
      continue;
    }

    if (profile === ASCII_IDENTITY_PROFILE) {
      encoded += first >= 0x20 && first <= 0x7E ? text[index] : unicodeEscape(first);
      index += 1;
      continue;
    }

    const second = text.charCodeAt(index + 1);
    const isPair = first >= 0xD800 && first <= 0xDBFF && second >= 0xDC00 && second <= 0xDFFF;
    if (isPair) {
      const scalar = text.slice(index, index + 2);
      encoded += isSafeUnicodeProseScalar(scalar)
        ? scalar
        : `${unicodeEscape(first)}${unicodeEscape(second)}`;
      index += 2;
      continue;
    }

    const scalar = text[index];
    encoded += isSafeUnicodeProseScalar(scalar) ? scalar : unicodeEscape(first);
    index += 1;
  }
  return encoded;
}

function isSafeUnicodeProseScalar(scalar) {
  if (scalar === " ") return true;
  return UNICODE_PROSE_SCALAR.test(scalar) && !DEFAULT_IGNORABLE_SCALAR.test(scalar);
}

function unicodeEscape(codeUnit) {
  return `\\u${codeUnit.toString(16).toUpperCase().padStart(4, "0")}`;
}

function readJsonSpace(options) {
  if (options === undefined) return 0;
  if (options === null || (typeof options !== "object" && typeof options !== "function")) failJson();
  const space = options.space === undefined ? 0 : options.space;
  if (space !== 0 && space !== 2) failJson();
  return space;
}

function cloneJsonValue(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) failJson();
    return value;
  }
  if (typeof value !== "object") failJson();
  if (seen.has(value)) failJson();
  seen.add(value);

  if (Array.isArray(value)) return cloneJsonArray(value, seen);
  return cloneJsonObject(value, seen);
}

function cloneJsonArray(value, seen) {
  if (Object.getPrototypeOf(value) !== Array.prototype) failJson();

  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!isDataDescriptor(lengthDescriptor)
    || lengthDescriptor.enumerable
    || !Number.isInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > 0xFFFFFFFF
    || keys.length !== lengthDescriptor.value + 1) {
    failJson();
  }

  const clone = [];
  Object.setPrototypeOf(clone, null);
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !isArrayIndex(key, lengthDescriptor.value)) failJson();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!isDataDescriptor(descriptor) || !descriptor.enumerable) failJson();
    defineJsonProperty(clone, key, cloneJsonValue(descriptor.value, seen));
  }
  return clone;
}

function cloneJsonObject(value, seen) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) failJson();

  const clone = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "toJSON") failJson();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!isDataDescriptor(descriptor) || !descriptor.enumerable) failJson();
    defineJsonProperty(clone, key, cloneJsonValue(descriptor.value, seen));
  }
  return clone;
}

function isDataDescriptor(descriptor) {
  return descriptor !== undefined && Object.hasOwn(descriptor, "value");
}

function isArrayIndex(key, length) {
  if (key.length === 0) return false;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function defineJsonProperty(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function escapeJsonTransport(serialized) {
  let safe = "";
  for (let index = 0; index < serialized.length;) {
    const first = serialized.charCodeAt(index);
    if (first <= 0x7E) {
      safe += serialized[index];
      index += 1;
      continue;
    }

    const second = serialized.charCodeAt(index + 1);
    const isPair = first >= 0xD800 && first <= 0xDBFF && second >= 0xDC00 && second <= 0xDFFF;
    if (isPair) {
      const scalar = serialized.slice(index, index + 2);
      safe += isSafeUnicodeProseScalar(scalar)
        ? scalar
        : `${unicodeEscape(first)}${unicodeEscape(second)}`;
      index += 2;
      continue;
    }

    safe += isSafeUnicodeProseScalar(serialized[index]) ? serialized[index] : unicodeEscape(first);
    index += 1;
  }
  return safe;
}

function failJson() {
  throw new Error();
}
