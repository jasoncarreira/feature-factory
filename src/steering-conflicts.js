import { PASSING_SECURITY_VERDICTS, PASSING_VALIDATOR_VERDICTS } from "./validate.js";

const PROTECTED_GATE_STATUSES = new Set(["approved", "stopped"]);
const PROTECTED_SLICE_STATUSES = new Set(["merged", "blocked", "review"]);

export const STEERING_CONFLICT_SUMMARY = "Consumed untrusted steering would require changing accepted durable state; human reconciliation is required.";

export function collectProtectedSteeringState(runDir, run) {
  void runDir;
  if (!isRecord(run)) return [];

  const protectedState = [];
  for (const [gateName, gate] of Object.entries(isRecord(run.gates) ? run.gates : {})) {
    if (isRecord(gate) && PROTECTED_GATE_STATUSES.has(gate.status)) protectedState.push(`gate:${gateName}`);
  }

  for (const step of Array.isArray(run.steps) ? run.steps : []) {
    if (isRecord(step) && step.status === "accepted" && stringValue(step.agent)) protectedState.push(`step:${step.agent}`);
  }

  for (const slice of Array.isArray(run.slices) ? run.slices : []) {
    if (isRecord(slice) && PROTECTED_SLICE_STATUSES.has(slice.status) && stringValue(slice.id)) protectedState.push(`slice:${slice.id}`);
  }

  if (isRecord(run.validator) && PASSING_VALIDATOR_VERDICTS.has(run.validator.verdict)) protectedState.push(`validator:${run.validator.verdict}`);
  if (isRecord(run.security_review) && PASSING_SECURITY_VERDICTS.has(run.security_review.verdict)) protectedState.push(`security_review:${run.security_review.verdict}`);
  if (stringValue(run.pr_url)) protectedState.push("pr_url");
  if (isRecord(run.terminal_result)) protectedState.push("terminal_result");

  return protectedState;
}

export function formatSteeringConflictReason(ref, protectedState) {
  const steeringRef = requireNonEmptyString(ref, "steering ref");
  const protectedText = normalizeProtectedState(protectedState).join(",") || "none";
  return `operator steering conflicts with accepted durable state: steering=${steeringRef}; protected=${protectedText}; automatic rollback is forbidden`;
}

export function buildSteeringConflictTerminalResult(run, steering, protectedState, input = {}) {
  const ref = requireNonEmptyString(steering?.ref, "steering ref");
  const hash = requireNonEmptyString(steering?.hash, "steering hash");
  const normalizedProtectedState = normalizeProtectedState(protectedState);
  const artifacts = {
    steering_ref: ref,
    steering_hash: hash,
    protected_state: normalizedProtectedState.join(","),
    reason_code: "accepted-state-conflict",
  };
  void input;

  return {
    status: "needs-human",
    run_id: requireNonEmptyString(run?.run_id, "run_id"),
    pr_url: stringValue(run?.pr_url) ? run.pr_url : null,
    reason: formatSteeringConflictReason(ref, normalizedProtectedState),
    summary: STEERING_CONFLICT_SUMMARY,
    artifacts,
  };
}

function normalizeProtectedState(protectedState) {
  if (!Array.isArray(protectedState)) return [];
  return protectedState.filter(stringValue).map((value) => String(value).trim());
}

function requireNonEmptyString(value, label) {
  if (!stringValue(value)) throw new Error(`${label} must be a non-empty string`);
  return String(value).trim();
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}
