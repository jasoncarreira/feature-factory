import { readFileSync } from "node:fs";
import { basename, isAbsolute, win32 } from "node:path";
import { parse, printParseErrorCode } from "jsonc-parser";

const JSONC_PARSE_OPTIONS = {
  allowEmptyContent: true,
  allowTrailingComma: true,
  disallowComments: false,
};

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
