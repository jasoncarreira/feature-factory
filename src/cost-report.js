import {
  COST_NUMERIC_FIELDS,
  USAGE_NUMERIC_FIELDS,
  rollupBy,
  rollupEntries,
} from "./cost-attribution.js";
import {
  FEATURE_FACTORY_PARENT_SPAN_ID,
  FEATURE_FACTORY_TRACEPARENT,
  validateParentSpanId,
  validateTraceparent,
} from "./telemetry.js";
import { validateCostAttributionEntries } from "./validate.js";

export const COST_REPORT_SCHEMA_VERSION = 1;

const NUMERIC_FIELDS = Object.freeze([...USAGE_NUMERIC_FIELDS, ...COST_NUMERIC_FIELDS]);
const JSON_LITERAL_CONTROL_PATTERN = /[\u007F-\u009F\u2028\u2029\p{Cf}]/gu;

export function buildCostReport(runId, attribution, options = {}) {
  const entries = reportEntries(attribution);
  validateCostAttributionEntries(entries, runId);
  const projectedEntries = entries.map(projectNumericNulls);
  const totals = rollupEntries(projectedEntries);
  const byAgent = rollupBy(projectedEntries, "agent");
  const byStep = rollupBy(projectedEntries, "step");
  const bySlice = rollupBy(projectedEntries, "slice_id");

  const report = {
    schema_version: COST_REPORT_SCHEMA_VERSION,
    run_id: runId,
    status: totals.status,
    entry_count: totals.entry_count,
    request_count: totals.request_count,
    agent_count: Object.keys(byAgent).length,
    step_count: Object.keys(byStep).length,
    slice_count: Object.keys(bySlice).length,
    unattributed_step_entry_count: projectedEntries.filter((entry) => typeof entry.step !== "string" || entry.step.trim().length === 0).length,
    totals,
    by_agent: byAgent,
    by_step: byStep,
    by_slice: bySlice,
  };

  if (options.telemetry === true) {
    const telemetry = costReportTelemetryCorrelation(options.env ?? process.env);
    if (telemetry) report.telemetry = telemetry;
  }
  return report;
}

export function formatCostReport(report) {
  const lines = [
    `Cost report for ${report.run_id}`,
    "Totals:",
    `  ${formatRollup(report.totals)}`,
  ];
  appendRollupSection(lines, `By agent (${report.agent_count})`, report.by_agent);
  appendRollupSection(lines, `By step (${report.step_count}; unattributed entries=${report.unattributed_step_entry_count})`, report.by_step);
  appendRollupSection(lines, `By slice (${report.slice_count})`, report.by_slice);
  if (report.telemetry) {
    lines.push(
      "Telemetry correlation:",
      `  trace_id=${report.telemetry.trace_id} | parent_span_id=${report.telemetry.parent_span_id}`,
    );
  }
  return lines.join("\n");
}

export function serializeCostReport(report) {
  return JSON.stringify(report, null, 2).replace(JSON_LITERAL_CONTROL_PATTERN, unicodeEscapeText);
}

export function encodeCostReportDisplayLabel(value) {
  const text = String(value);
  let encoded = "\"";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x22) encoded += "\\\"";
    else if (code === 0x5C) encoded += "\\\\";
    else if (code >= 0x20 && code <= 0x7E) encoded += text[index];
    else encoded += unicodeEscape(code);
  }
  return `${encoded}\"`;
}

export function costReportTelemetryCorrelation(env = process.env) {
  const source = env && typeof env === "object" ? env : {};
  const featureFactoryValue = source[FEATURE_FACTORY_TRACEPARENT];
  const standardValue = source.TRACEPARENT;
  const hasFeatureFactoryTraceparent = featureFactoryValue !== undefined && featureFactoryValue !== null;
  const hasStandardTraceparent = standardValue !== undefined && standardValue !== null;

  const featureFactoryTraceparent = hasFeatureFactoryTraceparent ? validTraceparent(featureFactoryValue) : null;
  const standardTraceparent = hasStandardTraceparent ? validTraceparent(standardValue) : null;
  if (featureFactoryTraceparent && standardTraceparent && featureFactoryTraceparent.traceparent !== standardTraceparent.traceparent) {
    throw telemetryError("FEATURE_FACTORY_TRACEPARENT and TRACEPARENT must match");
  }

  const traceparent = featureFactoryTraceparent || standardTraceparent;
  const parentValue = source[FEATURE_FACTORY_PARENT_SPAN_ID];
  const hasParentSpanId = parentValue !== undefined && parentValue !== null;
  const parent = hasParentSpanId ? validParentSpanId(parentValue) : null;
  if (parent && !traceparent) throw telemetryError("FEATURE_FACTORY_PARENT_SPAN_ID requires a traceparent");
  if (parent && parent.spanId !== traceparent.parentSpanId) {
    throw telemetryError("FEATURE_FACTORY_PARENT_SPAN_ID must match traceparent parent span id");
  }
  if (!traceparent) return null;
  return {
    trace_id: traceparent.traceId,
    parent_span_id: traceparent.parentSpanId,
  };
}

function reportEntries(attribution) {
  if (attribution === undefined || attribution === null) return [];
  if (!isRecord(attribution)) throw new Error("run.json.cost_attribution must be an object, null, or absent");
  if (attribution.entries === undefined || attribution.entries === null) return [];
  if (!Array.isArray(attribution.entries)) throw new Error("run.json.cost_attribution.entries must be an array, null, or absent");
  return attribution.entries;
}

function projectNumericNulls(entry) {
  const projected = { ...entry };
  for (const field of NUMERIC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(projected, field) && projected[field] === null) delete projected[field];
  }
  return projected;
}

function appendRollupSection(lines, title, groups) {
  lines.push(`${title}:`);
  const entries = Object.entries(groups);
  if (entries.length === 0) {
    lines.push("  (none)");
    return;
  }
  for (const [label, rollup] of entries) lines.push(`  ${encodeCostReportDisplayLabel(label)}: ${formatRollup(rollup)}`);
}

function formatRollup(rollup) {
  const parts = [
    `status=${rollup.status}`,
    `entries=${rollup.entry_count}`,
    `requests=${rollup.request_count}`,
  ];
  for (const field of NUMERIC_FIELDS) if (rollup[field] !== undefined) parts.push(`${field}=${rollup[field]}`);
  if (rollup.cost_currency !== undefined) parts.push(`cost_currency=${rollup.cost_currency}`);
  parts.push(`mixed_currency=${rollup.mixed_currency === true}`);
  const missing = Array.isArray(rollup.missing) && rollup.missing.length > 0
    ? rollup.missing.map(encodeCostReportDisplayLabel).join(",")
    : "none";
  parts.push(`missing=${missing}`);
  return parts.join(" | ");
}

function validTraceparent(value) {
  const result = validateTraceparent(value);
  if (!result.ok) throw telemetryError(result.error);
  return result;
}

function validParentSpanId(value) {
  const result = validateParentSpanId(value);
  if (!result.ok) throw telemetryError(result.error);
  return result;
}

function telemetryError(message) {
  return new Error(`cost-report telemetry: ${message}`);
}

function unicodeEscape(code) {
  return `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

function unicodeEscapeText(value) {
  let escaped = "";
  for (let index = 0; index < value.length; index += 1) escaped += unicodeEscape(value.charCodeAt(index));
  return escaped;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
