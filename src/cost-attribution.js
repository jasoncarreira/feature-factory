import { randomUUID } from "node:crypto";

export const COST_ATTRIBUTION_SCHEMA_VERSION = 1;
export const MAX_COST_ATTRIBUTION_ENTRIES = 1000;
export const COST_ATTRIBUTION_STATUSES = Object.freeze(["available", "partial", "unavailable"]);
export const COST_CURRENCY_PATTERN = /^[A-Z]{3,12}$/u;

export const USAGE_NUMERIC_FIELDS = Object.freeze([
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "reasoning_tokens",
]);

export const COST_NUMERIC_FIELDS = Object.freeze([
  "cost_total",
  "cost_input",
  "cost_output",
  "cost_cache_creation",
  "cost_cache_read",
]);

const OPTIONAL_STRING_FIELDS = Object.freeze(["step", "slice_id", "source", "operation", "provider", "model", "request_id", "cost_currency"]);
const NUMERIC_FIELDS = Object.freeze([...USAGE_NUMERIC_FIELDS, ...COST_NUMERIC_FIELDS]);
const STATUS_SET = new Set(COST_ATTRIBUTION_STATUSES);
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001F\u007F-\u009F]/gu;

export function normalizeCostUsageEntry(input, options = {}) {
  if (!isRecord(input)) throw new Error("cost usage entry must be an object");
  const entry = {};

  entry.id = nonEmptyString(input.id) || nonEmptyString(options.id) || randomUUID();
  entry.recorded_at = normalizeTimestamp(input.recorded_at ?? input.recordedAt ?? options.now);
  entry.run_id = nonEmptyString(options.runId) || nonEmptyString(input.run_id ?? input.runId);
  entry.agent = nonEmptyString(input.agent);
  if (!entry.run_id) throw new Error("cost usage entry requires run_id");
  if (!entry.agent) throw new Error("cost usage entry requires agent");

  const aliases = {
    slice_id: input.slice_id ?? input.sliceId,
    request_id: input.request_id ?? input.requestId,
    cost_currency: input.cost_currency ?? input.currency,
  };
  for (const field of OPTIONAL_STRING_FIELDS) {
    const value = Object.prototype.hasOwnProperty.call(aliases, field) ? aliases[field] : input[field];
    if (field === "cost_currency") {
      const currency = normalizeCostCurrency(value);
      if (currency) entry[field] = currency;
      continue;
    }
    const text = nonEmptyString(value);
    if (text) entry[field] = text;
  }

  for (const field of NUMERIC_FIELDS) {
    if (input[field] === undefined || input[field] === null) continue;
    entry[field] = normalizeNonNegativeFiniteNumber(input[field], field);
  }

  let missing = normalizeMissing(input.missing);
  const hasUsage = USAGE_NUMERIC_FIELDS.some((field) => entry[field] !== undefined);
  const hasCost = COST_NUMERIC_FIELDS.some((field) => entry[field] !== undefined);
  const hasCostTotal = entry.cost_total !== undefined;
  if (hasCost && !entry.cost_currency) missing = addMissing(missing, "cost_currency");

  if (!entry.provider) missing = addMissing(missing, "provider");
  if (!entry.model) missing = addMissing(missing, "model");
  if (!hasUsage) missing = addMissing(missing, "usage");
  if (!hasCostTotal) missing = addMissing(missing, "cost_total");
  if (!entry.cost_currency) missing = addMissing(missing, "cost_currency");

  const requestedStatus = STATUS_SET.has(input.status) ? input.status : null;
  if (!hasUsage && !hasCost) {
    entry.status = "unavailable";
  } else if (missing.length > 0 || requestedStatus === "partial" || requestedStatus === "unavailable") {
    entry.status = requestedStatus === "unavailable" && !hasUsage && !hasCost ? "unavailable" : "partial";
    if (missing.length === 0) missing = ["metadata"];
  } else {
    entry.status = "available";
  }
  entry.missing = missing;

  return entry;
}

export function appendCostAttributionEntry(costAttribution, input, options = {}) {
  const entries = Array.isArray(costAttribution?.entries) ? costAttribution.entries : [];
  return recomputeCostAttribution({ entries: [...entries, input] }, options);
}

export function normalizeCostAttribution(value = {}, options = {}) {
  return recomputeCostAttribution(value, options);
}

export function recomputeCostAttribution(value = {}, options = {}) {
  const inputEntries = Array.isArray(value) ? value : Array.isArray(value?.entries) ? value.entries : [];
  if (inputEntries.length > MAX_COST_ATTRIBUTION_ENTRIES) throw new Error(`cost attribution entries must have at most ${MAX_COST_ATTRIBUTION_ENTRIES} entries`);
  const entries = inputEntries.map((entry) => normalizeCostUsageEntry(entry, { ...options, now: entry?.recorded_at ?? entry?.recordedAt ?? options.now, id: entry?.id ?? options.id }));
  const updatedAt = normalizeTimestamp(options.now ?? value?.updated_at ?? value?.updatedAt);
  const totals = rollupEntries(entries);
  return {
    schema_version: COST_ATTRIBUTION_SCHEMA_VERSION,
    updated_at: updatedAt,
    status: totals.status,
    totals,
    by_agent: rollupBy(entries, "agent"),
    by_slice: rollupBy(entries, "slice_id"),
    entries,
  };
}

export function publicCostAttributionSummary(runOrAttribution) {
  const attribution = runOrAttribution?.cost_attribution || runOrAttribution;
  const totals = isRecord(attribution?.totals) ? attribution.totals : rollupEntries(Array.isArray(attribution?.entries) ? attribution.entries : []);
  const status = safeCostStatus(attribution?.status) || safeCostStatus(totals.status) || "unavailable";
  const summary = {
    schema_version: COST_ATTRIBUTION_SCHEMA_VERSION,
    updated_at: attribution?.updated_at === undefined || attribution?.updated_at === null ? null : sanitizePublicCostText(attribution.updated_at),
    status,
    entry_count: totals.entry_count || 0,
    agent_count: isRecord(attribution?.by_agent) ? Object.keys(attribution.by_agent).length : 0,
    slice_count: isRecord(attribution?.by_slice) ? Object.keys(attribution.by_slice).length : 0,
    mixed_currency: totals.mixed_currency === true,
    missing: Array.isArray(totals.missing) ? totals.missing.map((item) => sanitizePublicCostText(item)).filter(Boolean) : [],
  };
  for (const field of USAGE_NUMERIC_FIELDS) if (totals[field] !== undefined) summary[field] = totals[field];
  if (totals.cost_total !== undefined) summary.cost_total = totals.cost_total;
  const currency = safeCostCurrency(totals.cost_currency);
  if (currency) summary.cost_currency = currency;
  return summary;
}

export function formatCostAttributionSummary(runOrAttribution) {
  const summary = publicCostAttributionSummary(runOrAttribution);
  const parts = [`cost ${summary.status}`, `${summary.entry_count} ${summary.entry_count === 1 ? "entry" : "entries"}`];
  if (summary.total_tokens !== undefined) parts.push(`${summary.total_tokens} tokens`);
  else if (summary.input_tokens !== undefined || summary.output_tokens !== undefined) parts.push(`${summary.input_tokens ?? "?"}/${summary.output_tokens ?? "?"} tokens`);
  if (summary.mixed_currency) parts.push("mixed currency");
  else if (summary.cost_total !== undefined) parts.push(`${formatCost(summary.cost_total)} ${summary.cost_currency || ""}`.trim());
  if (summary.missing.length > 0) parts.push(`missing ${summary.missing.join(",")}`);
  return sanitizePublicCostText(parts.join(" · "));
}

export function normalizeCostCurrency(value, field = "cost_currency") {
  const text = nonEmptyString(value);
  if (!text) return null;
  if (!COST_CURRENCY_PATTERN.test(text) || hasTerminalControl(text)) {
    throw new Error(`${field} must be an uppercase currency code (3-12 letters) with no control characters`);
  }
  return text;
}

export function isSafeCostCurrency(value) {
  return safeCostCurrency(value) !== null;
}

export function hasTerminalControl(value) {
  TERMINAL_CONTROL_PATTERN.lastIndex = 0;
  return typeof value === "string" && TERMINAL_CONTROL_PATTERN.test(value);
}

export function sanitizePublicCostText(value) {
  return String(value).replace(/[\t\r\n]+/gu, " ").replace(TERMINAL_CONTROL_PATTERN, "").replace(/\s+/gu, " ").trim();
}

function rollupBy(entries, key) {
  const groups = new Map();
  for (const entry of entries) {
    const group = nonEmptyString(entry[key]);
    if (!group) continue;
    const groupEntries = groups.get(group) || [];
    groupEntries.push(entry);
    groups.set(group, groupEntries);
  }
  return Object.fromEntries([...groups.entries()].map(([name, groupEntries]) => [name, rollupEntries(groupEntries)]));
}

function rollupEntries(entries) {
  const rollup = {
    status: "unavailable",
    entry_count: entries.length,
    request_count: entries.length,
    missing: [],
    mixed_currency: false,
  };
  const missing = new Set();
  const currencyByCostField = new Map();
  let availableEntries = 0;
  let partial = entries.length === 0;

  for (const entry of entries) {
    if (entry.status === "available") availableEntries += 1;
    if (entry.status !== "available") partial = true;
    for (const item of Array.isArray(entry.missing) ? entry.missing : []) missing.add(item);

    for (const field of NUMERIC_FIELDS) {
      if (entry[field] === undefined) continue;
      rollup[field] = (rollup[field] ?? 0) + entry[field];
      if (COST_NUMERIC_FIELDS.includes(field)) {
        const currency = safeCostCurrency(entry.cost_currency);
        if (currency) {
          const currencies = currencyByCostField.get(field) || new Set();
          currencies.add(currency);
          currencyByCostField.set(field, currencies);
        } else {
          missing.add("cost_currency");
          partial = true;
        }
      }
    }
  }

  const currenciesForTotal = currencyByCostField.get("cost_total") || new Set();
  if (currenciesForTotal.size === 1) rollup.cost_currency = [...currenciesForTotal][0];
  const hasMixedCurrency = [...currencyByCostField.values()].some((currencies) => currencies.size > 1);
  if (hasMixedCurrency) {
    delete rollup.cost_total;
    delete rollup.cost_currency;
    rollup.mixed_currency = true;
    missing.add("mixed_currency");
    partial = true;
  }

  rollup.missing = [...missing].sort();
  if (entries.length === 0) rollup.missing = ["entries"];
  if (availableEntries === entries.length && entries.length > 0 && !partial) rollup.status = "available";
  else if (entries.some((entry) => entry.status === "available" || entry.status === "partial")) rollup.status = "partial";
  else rollup.status = "unavailable";
  return rollup;
}

function normalizeMissing(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => nonEmptyString(item)).filter(Boolean))].sort();
}

function addMissing(missing, item) {
  return [...new Set([...missing, item])].sort();
}

function normalizeNonNegativeFiniteNumber(value, field) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) throw new Error(`${field} must be a finite non-negative number`);
  return number;
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null) return new Date().toISOString();
  const parsed = typeof value === "number" ? value : value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid cost attribution timestamp");
  return new Date(parsed).toISOString();
}

function formatCost(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

function safeCostCurrency(value) {
  const text = nonEmptyString(value);
  return text && COST_CURRENCY_PATTERN.test(text) && !hasTerminalControl(text) ? text : null;
}

function safeCostStatus(value) {
  return typeof value === "string" && STATUS_SET.has(value) ? value : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
