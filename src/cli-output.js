import {
  freeformSegment,
  identitySegment,
  isDisplaySafeRunId,
  projectFreeformData,
  renderTerminalSegments,
  TRUSTED_SEGMENTS,
} from "./hardening/output-policy.js";
import { REDACTED_VALUE, isSensitiveValue, scrubSensitiveString } from "./hardening/sensitive-data.js";
import { serializeTerminalJson } from "./hardening/terminal-encoding.js";

const VALIDATED_STATUS_VALUES = new Set([
  "accepted", "approved", "available", "blocked", "cancelled", "changes_requested",
  "completed", "failed", "indeterminate", "invalid", "live", "missing", "needs-human",
  "ok", "partial", "pending", "ready", "rejected", "review", "running", "stopped",
  "unavailable", "warn", "warning",
]);
const SAFE_UUID_PATTERN = /^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/u;
const SAFE_HASH_PATTERN = /^(?:sha256:)?[A-Fa-f0-9]{32,128}$/u;
const SAFE_REF_CHARACTERS = /^[A-Za-z0-9._/-]+$/u;
const SAFE_COST_COLUMN_PATTERN = /^cost (?:available|partial|unavailable) · [0-9]+ (?:entry|entries)(?: · (?:[0-9?]+(?:\/[0-9?]+)? tokens|mixed currency|[0-9]+(?:\.[0-9]{1,6})? [A-Z]{3,12}|missing [A-Za-z0-9_, -]+))*$/u;

export function printCliResult(value, options = {}, helpers = {}) {
  const write = helpers.write || console.log;
  for (const line of renderCliResultLines(value, options, helpers)) write(line);
}

export function renderCliResultLines(value, options = {}, helpers = {}) {
  if (value === undefined) return [];
  if (value === null || options.json || typeof value !== "object") {
    return [typeof value === "string"
      ? renderTerminalSegments([freeformSegment(value)])
      : serializeTerminalJson(projectCliData(value), { space: 2 })];
  }
  if (Array.isArray(value)) return value.map((item) => renderListRow(item, helpers));
  return Object.entries(value).map(([key, entry]) => renderKeyValueRow(key, entry));
}

export function projectCliData(value) {
  return projectCliValue(value, null);
}

function projectCliValue(value, key) {
  if (typeof value === "string") {
    if (validatedIdentity(key, value)) return value;
    return contractualIdentityKey(key) ? REDACTED_VALUE : projectFreeformData(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => projectCliValue(entry, null));
  const projected = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    defineEntry(projected, key, projectCliValue(entry, key));
  }
  return projected;
}

export function projectCostReport(report) {
  const projected = projectCliData(report);
  for (const field of ["by_agent", "by_step", "by_slice"]) {
    if (!projected?.[field] || typeof projected[field] !== "object") continue;
    projected[field] = projectDynamicKeys(projected[field]);
  }
  return projected;
}

export function renderCliFreeform(value) {
  return renderTerminalSegments([freeformSegment(value)]);
}

export function renderCliPath(value) {
  return renderTerminalSegments([identitySegment(projectPath(value))]);
}

function renderListRow(item, helpers) {
  const cost = typeof helpers.formatListCostColumn === "function"
    ? helpers.formatListCostColumn(item)
    : "-";
  return renderTerminalSegments([
    projectedTableSegment("run_id", item?.run_id), TRUSTED_SEGMENTS.TAB,
    projectedTableSegment("status", item?.status), TRUSTED_SEGMENTS.TAB,
    projectedTableSegment("gate", item?.gate || "-"), TRUSTED_SEGMENTS.TAB,
    projectedTableSegment("updated_at", item?.updated_at || "-"), TRUSTED_SEGMENTS.TAB,
    ...projectedTableSegments("cost", cost), TRUSTED_SEGMENTS.TAB,
    ...diagnosticColumnSegments(item?.diagnostics, helpers),
  ]);
}

function diagnosticColumnSegments(diagnostics, helpers) {
  if (!diagnostics || typeof diagnostics !== "object") return [identitySegment("-")];
  if (diagnostics.status === "ok") return [identitySegment("ok")];
  const prefix = [diagnostics.classification, diagnostics.status].filter(stringValue).join("/") || "diagnostic";
  const rawSummary = diagnostics.summary || "check diagnostics";
  const summary = typeof helpers.cleanDiagnosticText === "function"
    ? helpers.cleanDiagnosticText(rawSummary)
    : rawSummary;
  return [freeformSegment(`${prefix}:`), freeformSegment(summary)];
}

function renderKeyValueRow(key, value) {
  const renderedValue = value !== null && typeof value === "object"
    ? identitySegment(serializeTerminalJson(projectCliData(value)))
    : projectedValueSegment(key, value);
  return renderTerminalSegments([identitySegment(key), TRUSTED_SEGMENTS.COLON_SPACE, renderedValue]);
}

function projectDynamicKeys(value) {
  const output = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    let projectedKey = scrubSensitiveString(key, { mode: "baseline" });
    for (let suffix = 2; Object.hasOwn(output, projectedKey); suffix += 1) {
      projectedKey = `${scrubSensitiveString(key, { mode: "baseline" })}#${suffix}`;
    }
    defineEntry(output, projectedKey, entry);
  }
  return output;
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function projectedTableSegments(key, value) {
  if (key === "cost" && (value === "-" || SAFE_COST_COLUMN_PATTERN.test(String(value)))) {
    const parts = String(value).split(" · ");
    return parts.flatMap((part, index) => index === 0
      ? [identitySegment(part)]
      : [freeformSegment(" · "), identitySegment(part)]);
  }
  return [projectedTableSegment(key, value)];
}

function projectedTableSegment(key, value) {
  return projectedValueSegment(key, value);
}

function projectedValueSegment(key, value) {
  if (validatedIdentity(key, value)) return identitySegment(value);
  return freeformSegment(contractualIdentityKey(key) ? REDACTED_VALUE : value);
}

function validatedIdentity(key, value) {
  if (typeof value !== "string") return false;
  if (key === "status" || key === "level") return VALIDATED_STATUS_VALUES.has(value);
  if (key === "run_id") return isDisplaySafeRunId(value);
  if (key === "token" || key === "boundary_token" || key === "action_token" || key === "fence_token") {
    // Factory-issued tokens have exactly one shape: the UUID minted at
    // boundary/action/fence creation (run-state.js randomUUID()); operators only
    // ever echo factory-issued tokens back. Render raw only that closed shape
    // and redact everything else deterministically. This deliberately replaces
    // credential classification for token fields: no blocklist heuristic can
    // separate a provider credential from a descriptive string that mentions
    // credential words, and chasing that precision/recall boundary is what
    // exhausted the autonomous run that produced this slice.
    return SAFE_UUID_PATTERN.test(value);
  }
  if (key === "hash" || key === "trace_id" || key?.endsWith("_hash")) return SAFE_HASH_PATTERN.test(value);
  if (key === "ref" || key?.endsWith("_ref")) return safeContractRef(value, { allowRunRoot: key === "run_ref" });
  if (key === "branch") return safeContractRef(value);
  if (key === "commit" || key?.endsWith("_commit")) return /^[A-Fa-f0-9]{7,64}$/u.test(value);
  if (key === "worktree" || key === "path" || key?.endsWith("_path")) {
    return safeContractPath(value);
  }
  return false;
}

function contractualIdentityKey(key) {
  return key === "run_id"
    || key === "token"
    || key === "boundary_token"
    || key === "action_token"
    || key === "fence_token"
    || key === "hash"
    || key === "trace_id"
    || key?.endsWith("_hash")
    || key === "ref"
    || key?.endsWith("_ref")
    || key === "branch"
    || key === "commit"
    || key?.endsWith("_commit")
    || key === "worktree"
    || key === "path"
    || key?.endsWith("_path");
}

function safeContractRef(value, { allowRunRoot = false } = {}) {
  if (!value) return false;
  const segments = value.split("/");
  if (segments.some(centrallySensitiveStructuredSegment) || !SAFE_REF_CHARACTERS.test(value)) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  if (value === "@" || value.includes("//") || value.includes("..") || value.includes("@{")) return false;
  return segments.every((segment, index) => {
    if (!segment || segment.endsWith(".") || segment.toLowerCase().endsWith(".lock")) return false;
    if (!segment.startsWith(".")) return true;
    return allowRunRoot && index === 0 && segment === ".opencode";
  });
}

function safeContractPath(value) {
  if (!value || hasUnsafeTerminalCodePoint(value)) return false;
  // Evaluate the complete value so credentials spanning path separators remain
  // visible to the centralized policy. The marker prevents its generic
  // single-token entropy heuristic from treating an ordinary long absolute
  // path as opaque secret material; credential/header/URL recognizers still
  // match the unchanged value before the marker.
  if (isSensitiveValue(`${value}#`, { mode: "baseline" })) return false;
  return value.split(/[\\/]/u).every((segment) => !centrallySensitiveStructuredSegment(segment));
}

function centrallySensitiveStructuredSegment(segment) {
  if (!segment || !isSensitiveValue(segment, { mode: "baseline" })) return false;
  const scrubbed = scrubSensitiveString(segment, { mode: "baseline" });
  if (scrubbed !== REDACTED_VALUE) return true;
  if (segment.split(/[-_.]+/u).some((part) => part && isSensitiveValue(part, { mode: "baseline" }))) return true;
  // Central token/PAT recognizers match in windows shorter than the generic
  // high-entropy threshold. This preserves benign generated worktree directory
  // names while still rejecting a credential embedded anywhere in a segment.
  for (let start = 0; start < segment.length; start += 1) {
    if (isSensitiveValue(segment.slice(start, start + 31), { mode: "baseline" })) return true;
  }
  return false;
}

function hasUnsafeTerminalCodePoint(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069)) return true;
  }
  return false;
}

function projectPath(value) {
  const text = String(value ?? "");
  const projected = projectFreeformData(text);
  if (projected !== REDACTED_VALUE) return projected;
  return text
    .split(/([/\\\s-]+)/u)
    .map((part) => /^(?:[/\\\s-]+)$/u.test(part) ? part : projectFreeformData(part))
    .join("");
}

function defineEntry(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
