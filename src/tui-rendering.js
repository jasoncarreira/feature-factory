import {
  DIAGNOSTIC_CLASSIFICATIONS,
  DIAGNOSTIC_STATUSES,
} from "./factory-diagnostics.js";
import {
  freeformSegment,
  identitySegment,
  isDisplaySafeRunId,
  renderTerminalSegmentsOrFallback,
  TRUSTED_SEGMENTS,
} from "./hardening/output-policy.js";
import { REDACTED_VALUE } from "./hardening/sensitive-data.js";

const RUN_STATUSES = new Set(["running", "completed", "blocked", "partial", "needs-human", "invalid"]);
const RUN_MODES = new Set(["interactive", "headless", "autonomous"]);
const DIAGNOSTIC_CLASSIFICATION_SET = new Set(DIAGNOSTIC_CLASSIFICATIONS);
const DIAGNOSTIC_STATUS_SET = new Set(DIAGNOSTIC_STATUSES);
const COST_STATUSES = new Set(["available", "partial", "unavailable"]);
const COST_CURRENCY_PATTERN = /^[A-Z]{3,12}$/u;

export function renderFreeformText(value, max) {
  return truncate(renderTerminalSegmentsOrFallback([freeformSegment(value)]), max);
}

export function renderRunStatus(value) {
  return renderValidatedIdentity(value, RUN_STATUSES);
}

export function renderRunMode(value) {
  return renderValidatedIdentity(value, RUN_MODES);
}

export function renderDiagnosticStatus(value) {
  return renderValidatedIdentity(value, DIAGNOSTIC_STATUS_SET);
}

export function renderDiagnosticLine(run, max = 42) {
  const segments = [];
  if (run?.diagnostic_classification) {
    segments.push(validatedIdentitySegment(run.diagnostic_classification, DIAGNOSTIC_CLASSIFICATION_SET));
    segments.push(TRUSTED_SEGMENTS.COLON_SPACE);
  }
  segments.push(freeformSegment(run?.diagnostic_summary || "Diagnostics require attention"));
  return truncate(renderTerminalSegmentsOrFallback(segments), max);
}

export function renderRunTextFields(run) {
  const status = renderRunStatus(run?.status);
  const mode = run?.mode ? renderRunMode(run.mode) : null;
  const steering = renderSteeringLine(run?.steering);
  const slices = renderSliceLine(run?.slices);
  const diagnostic = renderDiagnosticLine(run);
  return {
    run_id: renderRunId(run?.run_id),
    status_line: mode ? `${status} | ${mode}` : status,
    gate_line: run?.gate ? `gate: ${renderFreeformText(run.gate)}` : null,
    current_line: run?.current ? `current: ${renderFreeformText(run.current, 34)}` : null,
    steering_line: steering,
    slices_line: slices,
    cost_line: renderCostLine(run?.cost),
    panel_line: run?.panel ? `panel: ${renderFreeformText(run.panel)}` : null,
    pr_line: run?.pr_url ? `PR: ${renderFreeformText(run.pr_url, 34)}` : null,
    terminal_reason_line: run?.terminal_reason ? `reason: ${renderFreeformText(run.terminal_reason, 30)}` : null,
    diagnostic_line: `diagnostic: ${diagnostic}`,
    branch_line: run?.branch ? `branch: ${renderFreeformText(run.branch, 30)}` : null,
  };
}

function renderRunId(value) {
  const segment = isDisplaySafeRunId(value) ? identitySegment(value) : freeformSegment(REDACTED_VALUE);
  return truncate(renderTerminalSegmentsOrFallback([segment]), 31);
}

export function renderHiddenRunsLine(value) {
  const count = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return `+ ${renderTerminalSegmentsOrFallback([identitySegment(count)])} more runs`;
}

function renderSteeringLine(steering) {
  if (!steering || typeof steering !== "object") return null;
  if (steering.pending) {
    return `steering pending: ${renderFreeformText(steering.pending.ref || "pending", 34)}`;
  }
  if (steering.latest_consumed) {
    const count = Number.isSafeInteger(steering.consumed_count) && steering.consumed_count >= 0
      ? steering.consumed_count
      : 0;
    const renderedCount = renderTerminalSegmentsOrFallback([identitySegment(count)]);
    const ref = renderFreeformText(steering.latest_consumed.ref || "consumed", 24);
    return `steering consumed: ${renderedCount} latest ${ref}`;
  }
  return null;
}

function renderSliceLine(slices) {
  if (!slices || typeof slices !== "object") return null;
  const merged = nonNegativeInteger(slices.merged);
  const total = nonNegativeInteger(slices.total);
  const blocked = nonNegativeInteger(slices.blocked);
  const base = `slices: ${renderNumber(merged)}/${renderNumber(total)}`;
  return blocked > 0 ? `${base} | blocked ${renderNumber(blocked)}` : base;
}

function renderNumber(value) {
  return renderTerminalSegmentsOrFallback([identitySegment(value)]);
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function renderCostLine(cost) {
  if (!cost || typeof cost !== "object" || !COST_STATUSES.has(cost.status)) return null;
  const entryCount = nonNegativeInteger(cost.entry_count);
  const parts = [`cost ${cost.status}`, `${entryCount} ${entryCount === 1 ? "entry" : "entries"}`];
  if (Number.isFinite(cost.total_tokens) && cost.total_tokens >= 0) parts.push(`${cost.total_tokens} tokens`);
  else if ((Number.isFinite(cost.input_tokens) && cost.input_tokens >= 0)
    || (Number.isFinite(cost.output_tokens) && cost.output_tokens >= 0)) {
    parts.push(`${validCostNumber(cost.input_tokens)}/${validCostNumber(cost.output_tokens)} tokens`);
  }
  if (cost.mixed_currency === true) parts.push("mixed currency");
  else if (Number.isFinite(cost.cost_total) && cost.cost_total >= 0) {
    const currency = typeof cost.cost_currency === "string" && COST_CURRENCY_PATTERN.test(cost.cost_currency)
      ? cost.cost_currency
      : "";
    parts.push(`${formatCost(cost.cost_total)} ${currency}`.trim());
  }
  if (Array.isArray(cost.missing) && cost.missing.length > 0) {
    parts.push(`missing ${cost.missing.map((item) => renderFreeformText(item)).join(",")}`);
  }
  return truncate(parts.join(" · "), 42);
}

function validCostNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : "?";
}

function formatCost(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

function renderValidatedIdentity(value, allowed) {
  return renderTerminalSegmentsOrFallback([validatedIdentitySegment(value, allowed)]);
}

function validatedIdentitySegment(value, allowed) {
  return typeof value === "string" && allowed.has(value)
    ? identitySegment(value)
    : freeformSegment(value ?? "unknown");
}

function truncate(value, max) {
  if (!Number.isSafeInteger(max) || max < 0 || value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}
