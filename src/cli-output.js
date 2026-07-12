import {
  freeformSegment,
  identitySegment,
  projectFreeformData,
  renderTerminalSegments,
  TRUSTED_SEGMENTS,
} from "./hardening/output-policy.js";
import { scrubSensitiveString } from "./hardening/sensitive-data.js";
import { serializeTerminalJson } from "./hardening/terminal-encoding.js";

const CLI_FREEFORM_KEYS = new Set([
  "error", "message", "reason", "detail", "summary", "action", "answer",
  "decision_note", "blocked_reason", "operator_request",
]);

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
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(projectCliData);
  const projected = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    defineEntry(projected, key, CLI_FREEFORM_KEYS.has(key) ? projectFreeformData(entry) : projectCliData(entry));
  }
  return projected;
}

export function projectCostReport(report) {
  const projected = { ...report };
  for (const field of ["by_agent", "by_step", "by_slice"]) {
    if (!projected?.[field] || typeof projected[field] !== "object") continue;
    projected[field] = projectDynamicKeys(projected[field]);
  }
  return projected;
}

export function renderCliFreeform(value) {
  return renderTerminalSegments([freeformSegment(value)]);
}

export function renderCliIdentity(value) {
  return renderTerminalSegments([identitySegment(value)]);
}

function renderListRow(item, helpers) {
  const cost = typeof helpers.formatListCostColumn === "function"
    ? helpers.formatListCostColumn(item)
    : "-";
  return renderTerminalSegments([
    identitySegment(item?.run_id), TRUSTED_SEGMENTS.TAB,
    identitySegment(item?.status), TRUSTED_SEGMENTS.TAB,
    identitySegment(item?.gate || "-"), TRUSTED_SEGMENTS.TAB,
    identitySegment(item?.updated_at || "-"), TRUSTED_SEGMENTS.TAB,
    identitySegment(cost), TRUSTED_SEGMENTS.TAB,
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
    : CLI_FREEFORM_KEYS.has(key) ? freeformSegment(value) : identitySegment(value);
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

function defineEntry(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
