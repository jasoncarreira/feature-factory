import { readFileSync } from "node:fs";
import { basename, isAbsolute, win32 } from "node:path";
import { parse, printParseErrorCode } from "jsonc-parser";

const JSONC_PARSE_OPTIONS = {
  allowEmptyContent: true,
  allowTrailingComma: true,
  disallowComments: false,
};

export const POST_PR_CI_DEFAULTS = Object.freeze({
  enabled: false,
  wait_ms: 3_600_000,
  initial_poll_ms: 30_000,
  max_poll_ms: 120_000,
  check_start_grace_ms: 300_000,
  max_transient_errors: 12,
});

const POST_PR_PLUGIN_KEYS = new Set(["enabled", "waitMinutes", "initialPollSeconds", "maxPollSeconds", "checkStartGraceSeconds", "maxTransientErrors"]);
const POST_PR_DRIVER_KEYS = new Set(["enabled", "wait_ms", "initial_poll_ms", "max_poll_ms", "check_start_grace_ms", "max_transient_errors"]);

/** Strictly normalize the canonical plugin postPrCi object to persisted units. */
export function normalizePostPrCiConfig(value, { label = "postPrCi", partial = false } = {}) {
  if (value === undefined || value === null) return partial ? {} : { ...POST_PR_CI_DEFAULTS };
  assertPlainObject(value, label);
  assertKnownKeys(value, POST_PR_PLUGIN_KEYS, label);
  const normalized = {};
  if (Object.hasOwn(value, "enabled")) normalized.enabled = booleanValue(value.enabled, `${label}.enabled`);
  normalizeBoundedInteger(normalized, "wait_ms", value.waitMinutes, 30, 1440, 60_000, `${label}.waitMinutes`);
  normalizeBoundedInteger(normalized, "initial_poll_ms", value.initialPollSeconds, 15, 300, 1000, `${label}.initialPollSeconds`);
  normalizeBoundedInteger(normalized, "max_poll_ms", value.maxPollSeconds, 15, 600, 1000, `${label}.maxPollSeconds`);
  normalizeBoundedInteger(normalized, "check_start_grace_ms", value.checkStartGraceSeconds, 60, 900, 1000, `${label}.checkStartGraceSeconds`);
  normalizeBoundedInteger(normalized, "max_transient_errors", value.maxTransientErrors, 1, 50, 1, `${label}.maxTransientErrors`);
  const result = partial ? normalized : { ...POST_PR_CI_DEFAULTS, ...normalized };
  assertPostPrPollOrder(result, label);
  return result;
}

/** Normalize an already unit-converted driver override. Missing fields stay absent. */
export function normalizePostPrCiDriverOverride(value, { label = "driver.post_pr_ci" } = {}) {
  if (value === undefined || value === null) return null;
  assertPlainObject(value, label);
  assertKnownKeys(value, POST_PR_DRIVER_KEYS, label);
  const normalized = {};
  if (Object.hasOwn(value, "enabled")) normalized.enabled = booleanValue(value.enabled, `${label}.enabled`);
  for (const [key, min, max] of [
    ["wait_ms", 1_800_000, 86_400_000],
    ["initial_poll_ms", 15_000, 300_000],
    ["max_poll_ms", 15_000, 600_000],
    ["check_start_grace_ms", 60_000, 900_000],
    ["max_transient_errors", 1, 50],
  ]) {
    if (!Object.hasOwn(value, key)) continue;
    const number = value[key];
    if (!Number.isInteger(number) || number < min || number > max) throw new TypeError(`${label}.${key} must be an integer from ${min} to ${max}`);
    normalized[key] = number;
  }
  return normalized;
}

/** Resolve each field independently: built-in < plugin < inherited parent < driver. */
export function resolvePostPrCiPolicy({ plugin, parent, driver, reviewer } = {}) {
  const pluginPolicy = normalizePostPrCiConfig(plugin, { partial: true });
  const parentPolicy = normalizePersistedPostPrPolicy(parent, "parent post-PR policy");
  const driverPolicy = normalizePostPrCiDriverOverride(driver) ?? {};
  const effective = { ...POST_PR_CI_DEFAULTS, ...pluginPolicy, ...parentPolicy, ...driverPolicy };
  assertPostPrPollOrder(effective, "effective post-PR policy");
  const reviewerLogin = reviewer === undefined || reviewer === null || reviewer === "" ? null : String(reviewer).trim();
  if (reviewerLogin !== null && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(reviewerLogin)) throw new TypeError("reviewer must be a valid non-empty GitHub login");
  return {
    ...effective,
    review: reviewerLogin
      ? { required: true, reviewer_login: reviewerLogin, source: "driver" }
      : parentPolicy?.review ?? { required: false, reviewer_login: null, source: "none" },
  };
}

function normalizePersistedPostPrPolicy(value, label) {
  if (value === undefined || value === null) return {};
  assertPlainObject(value, label);
  const allowed = new Set([...POST_PR_DRIVER_KEYS, "review"]);
  assertKnownKeys(value, allowed, label);
  const base = normalizePostPrCiDriverOverride(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "review")), { label }) ?? {};
  if (value.review !== undefined) base.review = structuredClone(value.review);
  return base;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`${label} contains unknown key '${unknown[0]}'`);
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function normalizeBoundedInteger(target, key, value, min, max, multiplier, label) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${label} must be an integer from ${min} to ${max}`);
  target[key] = value * multiplier;
}

function assertPostPrPollOrder(value, label) {
  if (value.initial_poll_ms !== undefined && value.max_poll_ms !== undefined && value.max_poll_ms < value.initial_poll_ms) {
    throw new TypeError(`${label}.max poll must be greater than or equal to initial poll`);
  }
}

export function parseJsoncConfig(raw, { label = "opencode.jsonc" } = {}) {
  const errors = [];
  const input = stripBom(raw);
  const value = parse(input, errors, JSONC_PARSE_OPTIONS);
  const safeLabel = sanitizeLabel(label, "opencode.jsonc");

  if (errors.length > 0) {
    throw new SyntaxError(formatJsoncParseError(input, errors, safeLabel));
  }

  if (value === undefined) return {};
  assertConfigObject(value, safeLabel);
  return value;
}

export function readJsoncConfig(path, opts = {}) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }

  return parseJsoncConfig(raw, { ...opts, label: opts.label ?? basename(path) });
}

export function parseStrictJsonConfig(raw, { label = "opencode.json" } = {}) {
  const safeLabel = sanitizeLabel(label, "opencode.json");
  const input = stripBom(raw);
  let value;

  try {
    value = JSON.parse(input);
  } catch (error) {
    throw new SyntaxError(formatStrictJsonParseError(input, error, safeLabel));
  }

  assertConfigObject(value, safeLabel);
  return value;
}

export function readStrictJsonConfig(path, opts = {}) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }

  return parseStrictJsonConfig(raw, { ...opts, label: opts.label ?? basename(path) });
}

function assertConfigObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}: expected top-level config value to be a non-array object`);
  }
}

function formatJsoncParseError(raw, errors, label) {
  const first = errors[0];
  const location = lineColumnAt(raw, first.offset);
  const codeMessage = printParseErrorCode(first.error);
  const prefix = errors.length === 1 ? "JSONC parse error" : `${errors.length} JSONC parse errors; first error`;

  return `${label}: ${prefix} at line ${location.line}, column ${location.column}: parser ${codeMessage} (${first.error})`;
}

function formatStrictJsonParseError(raw, error, label) {
  const offset = strictJsonErrorOffset(error);
  if (offset == null) return `${label}: JSON parse error: invalid JSON syntax`;

  const location = lineColumnAt(raw, offset);
  return `${label}: JSON parse error at line ${location.line}, column ${location.column}: invalid JSON syntax`;
}

function strictJsonErrorOffset(error) {
  const message = String(error?.message ?? "");
  const positionMatch = /position (\d+)/u.exec(message);
  if (positionMatch) return Number(positionMatch[1]);

  const lineColumnMatch = /line (\d+) column (\d+)/iu.exec(message);
  if (lineColumnMatch) return { line: Number(lineColumnMatch[1]), column: Number(lineColumnMatch[2]) };

  return null;
}

function lineColumnAt(raw, offsetOrLocation) {
  if (typeof offsetOrLocation === "object" && offsetOrLocation) return offsetOrLocation;

  const offset = Math.max(0, Number(offsetOrLocation) || 0);
  let line = 1;
  let column = 1;

  for (let index = 0; index < raw.length && index < offset; index += 1) {
    if (raw[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

function sanitizeLabel(label, fallback) {
  const raw = String(label ?? fallback);
  const withoutAbsolutePath = isAbsolute(raw) ? basename(raw) : win32.isAbsolute(raw) ? win32.basename(raw) : raw;
  return withoutAbsolutePath.replace(/[\r\n\t]+/gu, " ").trim() || fallback;
}

function stripBom(raw) {
  const text = String(raw);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
