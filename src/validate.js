import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const HEARTBEAT_TERMINAL_STATUSES = Object.freeze(["completed", "blocked", "partial", "needs-human"]);
export const TERMINAL_RUN_STATUSES = HEARTBEAT_TERMINAL_STATUSES;
export const HEARTBEAT_PHASES = Object.freeze([
  "spec-review",
  "decomposition-review",
  "builder-wave",
  "slice-review",
  "test-verifier",
  "test-rerun",
  "test-review",
  "implementation-validator",
  "security-reviewer",
  "remediation",
]);
export const HEARTBEAT_STATUSES = Object.freeze(["running", ...HEARTBEAT_TERMINAL_STATUSES]);

const RUN_STATUSES = new Set(HEARTBEAT_STATUSES);
const TERMINAL_STATUSES = new Set(HEARTBEAT_TERMINAL_STATUSES);
const HEARTBEAT_PHASE_SET = new Set(HEARTBEAT_PHASES);
const HEARTBEAT_STATUS_SET = new Set(HEARTBEAT_STATUSES);
const RUN_MODES = new Set(["interactive", "headless", "autonomous"]);
const GATE_STATUSES = new Set(["pending", "approved", "changes_requested", "stopped"]);
const APPROVAL_SOURCES = new Set(["human", "external-driver", "autonomous", "override"]);
const SLICE_STATUSES = new Set(["pending", "running", "review", "merged", "blocked"]);
const STEP_STATUSES = new Set(["running", "accepted", "rejected", "blocked"]);
const REVIEW_TIERS = new Set(["light", "standard", "strict"]);
const REVIEW_TIER_SOURCES = new Set(["explicit", "default"]);
const REVIEW_TIER_RISK_REASONS = new Set([
  "security_or_auth",
  "schema_or_persistence",
  "generated_or_owned_code",
  "external_system_policy",
  "dependency_or_supply_chain",
  "workflow_or_release",
  "destructive_or_broad_scope",
]);

export class ValidationError extends Error {
  constructor(errors) {
    super(errors.map((item) => `${item.path}: ${item.message}`).join("; "));
    this.name = "ValidationError";
    this.errors = errors;
  }
}

export function validateRun(run) {
  const errors = [];
  if (!isRecord(run)) return fail([{ path: "run", message: "must be an object" }]);

  requiredString(errors, run, "run_id", "run.run_id");
  optionalNumber(errors, run, "schema_version", "run.schema_version");
  optionalEnum(errors, run, "mode", RUN_MODES, "run.mode");
  requiredEnum(errors, run, "status", RUN_STATUSES, "run.status");
  optionalString(errors, run, "created_at", "run.created_at");
  optionalString(errors, run, "updated_at", "run.updated_at");
  optionalString(errors, run, "heartbeat_at", "run.heartbeat_at");
  optionalString(errors, run, "base_ref", "run.base_ref");
  optionalString(errors, run, "branch", "run.branch");
  optionalString(errors, run, "worktree", "run.worktree");
  optionalString(errors, run, "pr_url", "run.pr_url");
  optionalInteger(errors, run, "max_parallel_slices", "run.max_parallel_slices");
  optionalInteger(errors, run, "max_retries", "run.max_retries");
  validateReviewTier(errors, run.review_tier, "run.review_tier");

  validateGateMap(errors, run.gates, "run.gates");
  validateRunSlices(errors, run.slices, "run.slices");
  validateSteps(errors, run.steps, "run.steps");
  validateVerdict(errors, run.validator, "run.validator", new Set(["GO", "GO-WITH-NITS", "NO-GO"]));
  validateVerdict(errors, run.security_review, "run.security_review", new Set(["PASS", "BLOCK"]));
  validateTerminalResult(errors, run, "run.terminal_result");

  if (errors.length) fail(errors);
  return run;
}

export function validateSlicesPlan(plan) {
  const errors = [];
  if (!isRecord(plan)) return fail([{ path: "plan", message: "must be an object" }]);
  if (!Array.isArray(plan.slices)) {
    errors.push({ path: "plan.slices", message: "must be an array" });
  } else {
    validatePlannedSlices(errors, plan.slices, "plan.slices");
  }
  if (errors.length) fail(errors);
  return plan;
}

export function validateHeartbeatState(heartbeat) {
  const errors = [];
  if (!isRecord(heartbeat)) return fail([{ path: "heartbeat", message: "must be an object" }]);

  requiredInteger(errors, heartbeat, "schema_version", "heartbeat.schema_version");
  requiredString(errors, heartbeat, "run_id", "heartbeat.run_id");
  requiredString(errors, heartbeat, "token", "heartbeat.token");
  requiredEnum(errors, heartbeat, "phase", HEARTBEAT_PHASE_SET, "heartbeat.phase");
  requiredEnum(errors, heartbeat, "status", HEARTBEAT_STATUS_SET, "heartbeat.status");
  requiredInteger(errors, heartbeat, "pid", "heartbeat.pid");
  validateHeartbeatTimestamps(errors, heartbeat, "heartbeat");
  requiredInteger(errors, heartbeat, "interval_ms", "heartbeat.interval_ms");
  validateHeartbeatDeadline(errors, heartbeat, "heartbeat");

  if (errors.length) fail(errors);
  return heartbeat;
}

export function validateRunDir(runDir) {
  const checks = [];
  checks.push(validateFile(join(runDir, "run.json"), validateRun));
  const heartbeatPath = join(runDir, "heartbeat.json");
  if (existsSync(heartbeatPath)) checks.push(validateFile(heartbeatPath, validateHeartbeatState));
  const slicesPath = join(runDir, "plan", "slices.json");
  if (existsSync(slicesPath)) checks.push(validateFile(slicesPath, validateSlicesPlan));
  return {
    ok: checks.every((item) => item.ok),
    checks,
  };
}

export function validateFile(file, validator) {
  try {
    validator(JSON.parse(readFileSync(file, "utf8")));
    return { path: file, ok: true, errors: [] };
  } catch (error) {
    return {
      path: file,
      ok: false,
      errors: error instanceof ValidationError ? error.errors : [{ path: file, message: error.message }],
    };
  }
}

function validateGateMap(errors, gates, path) {
  if (gates === undefined || gates === null) return;
  if (!isRecord(gates)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  for (const [name, gate] of Object.entries(gates)) validateGate(errors, gate, `${path}.${name}`);
}

function validateReviewTier(errors, reviewTier, path) {
  if (reviewTier === undefined) return;
  if (!isRecord(reviewTier)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  requiredEnum(errors, reviewTier, "selected", REVIEW_TIERS, `${path}.selected`);
  requiredEnum(errors, reviewTier, "source", REVIEW_TIER_SOURCES, `${path}.source`);
  validateReviewTierRiskReasons(errors, reviewTier.risk_reasons, `${path}.risk_reasons`);
  requiredString(errors, reviewTier, "rationale", `${path}.rationale`);
}

function validateReviewTierRiskReasons(errors, riskReasons, path) {
  if (!Array.isArray(riskReasons)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  for (const [index, reason] of riskReasons.entries()) {
    if (!stringValue(reason)) {
      errors.push({ path: `${path}[${index}]`, message: "must be a non-empty string" });
      continue;
    }
    if (!REVIEW_TIER_RISK_REASONS.has(reason)) {
      errors.push({ path: `${path}[${index}]`, message: `must be one of ${[...REVIEW_TIER_RISK_REASONS].join(", ")}` });
    }
  }
}

function validateGate(errors, gate, path) {
  if (!isRecord(gate)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  requiredEnum(errors, gate, "status", GATE_STATUSES, `${path}.status`);
  optionalString(errors, gate, "artifact", `${path}.artifact`);
  optionalString(errors, gate, "question_ref", `${path}.question_ref`);
  optionalString(errors, gate, "answer_ref", `${path}.answer_ref`);
  optionalString(errors, gate, "answered_at", `${path}.answered_at`);
  optionalString(errors, gate, "answer", `${path}.answer`);
  optionalString(errors, gate, "decision_note", `${path}.decision_note`);
  optionalEnum(errors, gate, "approval_source", APPROVAL_SOURCES, `${path}.approval_source`);
}

function validateRunSlices(errors, slices, path) {
  if (slices === undefined || slices === null) return;
  if (!Array.isArray(slices)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  const ids = validateSliceIDs(errors, slices, path);
  for (const [index, slice] of slices.entries()) {
    validateRunSlice(errors, slice, `${path}[${index}]`, ids);
  }
}

function validateRunSlice(errors, slice, path, ids) {
  if (!isRecord(slice)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  requiredString(errors, slice, "id", `${path}.id`);
  optionalString(errors, slice, "stack", `${path}.stack`);
  validateStringArray(errors, slice.depends_on, `${path}.depends_on`, { required: false, values: ids });
  optionalEnum(errors, slice, "status", SLICE_STATUSES, `${path}.status`);
  optionalString(errors, slice, "branch", `${path}.branch`);
  optionalString(errors, slice, "worktree", `${path}.worktree`);
  optionalInteger(errors, slice, "attempts", `${path}.attempts`);
  optionalString(errors, slice, "evidence_ref", `${path}.evidence_ref`);
  optionalString(errors, slice, "review_ref", `${path}.review_ref`);
  optionalString(errors, slice, "merge_commit", `${path}.merge_commit`);
  optionalString(errors, slice, "blocked_reason", `${path}.blocked_reason`);
}

function validatePlannedSlices(errors, slices, path) {
  const ids = validateSliceIDs(errors, slices, path);
  for (const [index, slice] of slices.entries()) {
    if (!isRecord(slice)) {
      errors.push({ path: `${path}[${index}]`, message: "must be an object" });
      continue;
    }
    requiredString(errors, slice, "id", `${path}[${index}].id`);
    requiredString(errors, slice, "stack", `${path}[${index}].stack`);
    validateStringArray(errors, slice.paths, `${path}[${index}].paths`, { required: true, nonEmpty: true });
    validateStringArray(errors, slice.depends_on, `${path}[${index}].depends_on`, { required: true, values: ids });
    validateStringArray(errors, slice.acceptance, `${path}[${index}].acceptance`, { required: true, nonEmpty: true });
    validateStringArray(errors, slice.test_plan, `${path}[${index}].test_plan`, { required: true, nonEmpty: true });
  }
  validateAcyclic(errors, slices, ids, path);
}

function validateSliceIDs(errors, slices, path) {
  const ids = new Set();
  for (const [index, slice] of slices.entries()) {
    if (!isRecord(slice) || typeof slice.id !== "string" || !slice.id.trim()) continue;
    if (ids.has(slice.id)) errors.push({ path: `${path}[${index}].id`, message: `duplicate id '${slice.id}'` });
    ids.add(slice.id);
  }
  return ids;
}

function validateAcyclic(errors, slices, ids, path) {
  const graph = new Map();
  for (const slice of slices) {
    if (!isRecord(slice) || typeof slice.id !== "string" || !ids.has(slice.id)) continue;
    graph.set(slice.id, Array.isArray(slice.depends_on) ? slice.depends_on.filter((id) => ids.has(id)) : []);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, chain) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      errors.push({ path, message: `dependency cycle: ${[...chain, id].join(" -> ")}` });
      return;
    }
    visiting.add(id);
    for (const dep of graph.get(id) || []) visit(dep, [...chain, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id, []);
}

function validateSteps(errors, steps, path) {
  if (steps === undefined || steps === null) return;
  if (!Array.isArray(steps)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  for (const [index, step] of steps.entries()) {
    if (!isRecord(step)) {
      errors.push({ path: `${path}[${index}]`, message: "must be an object" });
      continue;
    }
    requiredString(errors, step, "agent", `${path}[${index}].agent`);
    requiredEnum(errors, step, "status", STEP_STATUSES, `${path}[${index}].status`);
    optionalInteger(errors, step, "attempts", `${path}[${index}].attempts`);
    optionalString(errors, step, "artifact_ref", `${path}[${index}].artifact_ref`);
    optionalString(errors, step, "review_ref", `${path}[${index}].review_ref`);
    optionalString(errors, step, "evidence_ref", `${path}[${index}].evidence_ref`);
  }
}

function validateVerdict(errors, value, path, allowed) {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  optionalEnum(errors, value, "verdict", allowed, `${path}.verdict`);
  optionalString(errors, value, "report", `${path}.report`);
  optionalString(errors, value, "review_ref", `${path}.review_ref`);
  optionalInteger(errors, value, "loops", `${path}.loops`);
}

function validateTerminalResult(errors, run, path) {
  const terminal = TERMINAL_STATUSES.has(run.status);
  if (!terminal && (run.terminal_result === undefined || run.terminal_result === null)) return;
  if (terminal && !isRecord(run.terminal_result)) {
    errors.push({ path, message: "must be present when run.status is terminal" });
    return;
  }
  if (!isRecord(run.terminal_result)) {
    errors.push({ path, message: "must be an object or null" });
    return;
  }
  requiredEnum(errors, run.terminal_result, "status", TERMINAL_STATUSES, `${path}.status`);
  requiredString(errors, run.terminal_result, "run_id", `${path}.run_id`);
  optionalString(errors, run.terminal_result, "pr_url", `${path}.pr_url`);
  optionalString(errors, run.terminal_result, "reason", `${path}.reason`);
  optionalString(errors, run.terminal_result, "summary", `${path}.summary`);
  validateStringMap(errors, run.terminal_result.artifacts, `${path}.artifacts`);
  if (run.terminal_result.status && run.terminal_result.status !== run.status) {
    errors.push({ path: `${path}.status`, message: `must match run.status '${run.status}'` });
  }
  if (run.terminal_result.run_id && run.terminal_result.run_id !== run.run_id) {
    errors.push({ path: `${path}.run_id`, message: "must match run.run_id" });
  }
  if (["blocked", "partial", "needs-human"].includes(run.status) && !stringValue(run.terminal_result.reason)) {
    errors.push({ path: `${path}.reason`, message: `is required for ${run.status}` });
  }
}

function validateHeartbeatTimestamps(errors, heartbeat, path) {
  const started = heartbeat.created_at ?? heartbeat.started_at;
  if (!stringValue(started)) {
    errors.push({ path: `${path}.started_at`, message: "must be a non-empty string (or use heartbeat.created_at)" });
  }
  optionalNonEmptyString(errors, heartbeat, "created_at", `${path}.created_at`);
  optionalNonEmptyString(errors, heartbeat, "started_at", `${path}.started_at`);
  requiredString(errors, heartbeat, "updated_at", `${path}.updated_at`);
  requiredString(errors, heartbeat, "heartbeat_at", `${path}.heartbeat_at`);
}

function validateHeartbeatDeadline(errors, heartbeat, path) {
  if (heartbeat.deadline_at === undefined && heartbeat.deadline_ms === undefined) {
    errors.push({ path: `${path}.deadline_at`, message: "must be a non-empty string (or use heartbeat.deadline_ms)" });
    return;
  }
  optionalNonEmptyString(errors, heartbeat, "deadline_at", `${path}.deadline_at`);
  optionalInteger(errors, heartbeat, "deadline_ms", `${path}.deadline_ms`);
}

function validateStringMap(errors, value, path) {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") errors.push({ path: `${path}.${key}`, message: "must be a string" });
  }
}

function validateStringArray(errors, value, path, options = {}) {
  if (value === undefined || value === null) {
    if (options.required) errors.push({ path, message: "must be an array" });
    return;
  }
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  if (options.nonEmpty && value.length === 0) errors.push({ path, message: "must not be empty" });
  for (const [index, item] of value.entries()) {
    if (!stringValue(item)) errors.push({ path: `${path}[${index}]`, message: "must be a non-empty string" });
    if (options.values && stringValue(item) && !options.values.has(item)) errors.push({ path: `${path}[${index}]`, message: `unknown dependency '${item}'` });
  }
}

function requiredString(errors, obj, key, path) {
  if (!stringValue(obj[key])) errors.push({ path, message: "must be a non-empty string" });
}

function optionalString(errors, obj, key, path) {
  if (obj[key] === undefined || obj[key] === null) return;
  if (typeof obj[key] !== "string") errors.push({ path, message: "must be a string or null" });
}

function optionalNonEmptyString(errors, obj, key, path) {
  if (obj[key] === undefined || obj[key] === null) return;
  if (!stringValue(obj[key])) errors.push({ path, message: "must be a non-empty string" });
}

function requiredEnum(errors, obj, key, values, path) {
  if (typeof obj[key] !== "string" || !values.has(obj[key])) errors.push({ path, message: `must be one of ${[...values].join(", ")}` });
}

function optionalEnum(errors, obj, key, values, path) {
  if (obj[key] === undefined || obj[key] === null) return;
  requiredEnum(errors, obj, key, values, path);
}

function optionalNumber(errors, obj, key, path) {
  if (obj[key] === undefined || obj[key] === null) return;
  if (typeof obj[key] !== "number" || !Number.isFinite(obj[key])) errors.push({ path, message: "must be a number" });
}

function optionalInteger(errors, obj, key, path) {
  if (obj[key] === undefined || obj[key] === null) return;
  if (!Number.isInteger(obj[key]) || obj[key] < 0) errors.push({ path, message: "must be a non-negative integer" });
}

function requiredInteger(errors, obj, key, path) {
  if (!Number.isInteger(obj[key]) || obj[key] < 0) errors.push({ path, message: "must be a non-negative integer" });
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(errors) {
  throw new ValidationError(errors);
}
