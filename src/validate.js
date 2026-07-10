import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { COST_ATTRIBUTION_SCHEMA_VERSION, COST_ATTRIBUTION_STATUSES, COST_NUMERIC_FIELDS, MAX_COST_ATTRIBUTION_ENTRIES, USAGE_NUMERIC_FIELDS, hasTerminalControl, isSafeCostCurrency, sanitizePublicCostText } from "./cost-attribution.js";
import { REDACTED_ENV_VALUE, isSensitiveEnvKey, isSensitiveEnvValue } from "./env-snapshot.js";
import { PROCESS_EVIDENCE_FILE, processEvidenceProcessesDir, validateProcessEvidence } from "./process-evidence.js";
import { hashFile, resolveArtifactRef, resolveEvidenceRef, resolveGateRef, resolveReviewRef, resolveSteeringRef } from "./refs.js";

export const TERMINAL_RUN_STATUSES = Object.freeze(["completed", "blocked", "partial", "needs-human"]);
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
export const HEARTBEAT_PROTECTED_GATES = Object.freeze(["story", "brief", "pre_pr"]);

const RUN_STATUSES = new Set(["running", ...TERMINAL_RUN_STATUSES]);
const TERMINAL_STATUSES = new Set(TERMINAL_RUN_STATUSES);
const RUN_MODES = new Set(["interactive", "headless", "autonomous"]);
const PR_MODES = new Set(["draft", "ready"]);
const GATE_STATUSES = new Set(["pending", "approved", "changes_requested", "stopped"]);
const APPROVAL_SOURCES = new Set(["human", "external-driver", "autonomous", "override"]);
const SAFE_GATE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const SLICE_STATUSES = new Set(["pending", "running", "review", "merged", "blocked"]);
const STEP_STATUSES = new Set(["running", "accepted", "rejected", "blocked"]);
const VALIDATOR_VERDICTS = new Set(["GO", "GO-WITH-NITS", "NO-GO"]);
export const PASSING_VALIDATOR_VERDICTS = new Set(["GO", "GO-WITH-NITS"]);
const SECURITY_VERDICTS = new Set(["PASS", "BLOCK"]);
export const PASSING_SECURITY_VERDICTS = new Set(["PASS"]);
const CONTINUATION_KINDS = new Set(["blocked-run-continuation"]);
const BLOCKED_CONTINUATION_PARENT_STATUSES = new Set(["blocked"]);
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DEBUG_SNAPSHOT_KEYS = new Set(["created_with", "last_resumed_with", "resume_count"]);
const DEBUG_SNAPSHOT_EVENT_KEYS = new Set(["collected_at", "event", "diagnostic_only", "env"]);
const COST_ATTRIBUTION_STATUS_SET = new Set(COST_ATTRIBUTION_STATUSES);
const COST_ATTRIBUTION_ENTRY_OPTIONAL_STRINGS = new Set(["step", "slice_id", "source", "operation", "provider", "model", "request_id", "cost_currency"]);
const COST_ATTRIBUTION_NUMERIC_FIELDS = new Set([...USAGE_NUMERIC_FIELDS, ...COST_NUMERIC_FIELDS]);

export class ValidationError extends Error {
  constructor(errors) {
    const safeErrors = errors.map((item) => ({
      ...item,
      path: safeValidationText(item.path),
      message: safeValidationText(item.message),
    }));
    super(safeErrors.map((item) => `${item.path}: ${item.message}`).join("; "));
    this.name = "ValidationError";
    this.errors = safeErrors;
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
  optionalString(errors, run, "base_commit", "run.base_commit");
  optionalString(errors, run, "branch", "run.branch");
  optionalString(errors, run, "worktree", "run.worktree");
  optionalNonEmptyString(errors, run, "github_account", "run.github_account");
  optionalEnum(errors, run, "pr_mode", PR_MODES, "run.pr_mode");
  optionalString(errors, run, "pr_url", "run.pr_url");
  optionalInteger(errors, run, "max_parallel_slices", "run.max_parallel_slices");
  optionalInteger(errors, run, "max_retries", "run.max_retries");
  optionalNonEmptyString(errors, run, "review_tier", "run.review_tier");
  validateDebugSnapshot(errors, run.debug_snapshot, "run.debug_snapshot");
  validateContinuation(errors, run, "run.continuation");
  validateSteering(errors, run.steering, "run.steering");

  validateGateMap(errors, run.gates, "run.gates");
  validateRunSlices(errors, run.slices, "run.slices");
  validateCostAttribution(errors, run.cost_attribution, "run.cost_attribution", run);
  validateSteps(errors, run.steps, "run.steps");
  validateVerdict(errors, run.validator, "run.validator", VALIDATOR_VERDICTS);
  validateVerdict(errors, run.security_review, "run.security_review", SECURITY_VERDICTS);
  validateTerminalResult(errors, run, "run.terminal_result");

  if (errors.length) fail(errors);
  return run;
}

export function validateCostAttributionEntries(entries, runId) {
  const errors = [];
  const path = "run.cost_attribution.entries";
  if (!Array.isArray(entries)) {
    errors.push({ path, message: "must be an array" });
  } else {
    if (entries.length > MAX_COST_ATTRIBUTION_ENTRIES) errors.push({ path, message: `must have at most ${MAX_COST_ATTRIBUTION_ENTRIES} entries` });
    const expectedRunId = stringValue(runId) ? runId : null;
    for (const [index, entry] of entries.entries()) validateCostAttributionEntry(errors, entry, `${path}[${index}]`, null, expectedRunId);
  }
  if (errors.length) fail(errors);
  return entries;
}

export function validateSlicesPlan(plan) {
  const errors = [];
  if (!isRecord(plan)) return fail([{ path: "plan", message: "must be an object" }]);
  if (!Array.isArray(plan.slices)) errors.push({ path: "plan.slices", message: "must be an array" });
  else validatePlannedSlices(errors, plan.slices, "plan.slices");
  if (errors.length) fail(errors);
  return plan;
}

export function validateHeartbeatState(heartbeat) {
  const errors = [];
  if (!isRecord(heartbeat)) return fail([{ path: "heartbeat", message: "must be an object" }]);
  requiredInteger(errors, heartbeat, "schema_version", "heartbeat.schema_version");
  requiredString(errors, heartbeat, "run_id", "heartbeat.run_id");
  requiredString(errors, heartbeat, "phase", "heartbeat.phase");
  optionalNullableInteger(errors, heartbeat, "pid", "heartbeat.pid");
  requiredInteger(errors, heartbeat, "interval_ms", "heartbeat.interval_ms");
  requiredString(errors, heartbeat, "last_tick_at", "heartbeat.last_tick_at");
  if (errors.length) fail(errors);
  return heartbeat;
}

export function validateFactoryLock(factoryLock) {
  const errors = [];
  if (!isRecord(factoryLock)) return fail([{ path: "factory_lock", message: "must be an object" }]);
  requiredInteger(errors, factoryLock, "schema_version", "factory_lock.schema_version");
  requiredString(errors, factoryLock, "run_id", "factory_lock.run_id");
  optionalString(errors, factoryLock, "session_owner", "factory_lock.session_owner");
  optionalString(errors, factoryLock, "updated_at", "factory_lock.updated_at");
  if (errors.length) fail(errors);
  return factoryLock;
}

export function validateProcessSidecar(processSidecar, options = {}) {
  const validation = validateProcessEvidence(processSidecar, { runDir: options.runDir, runId: options.runId });
  if (!validation.ok) fail([{ path: "process", message: validation.reason }]);

  const errors = [];
  validateProcessLogRefContainment(errors, validation.evidence.log_ref, "process.log_ref", options.runDir);
  if (errors.length) fail(errors);
  return validation.evidence;
}

export function validateRunDir(runDir) {
  const checks = [];
  const runFile = join(runDir, "run.json");
  let run = null;
  checks.push(validateFile(runFile, (value) => {
    run = validateRun(value);
    return run;
  }));
  const factoryLockPath = join(runDir, "factory.lock");
  if (existsSync(factoryLockPath)) checks.push(validateFile(factoryLockPath, validateFactoryLock));
  const heartbeatPath = join(runDir, "heartbeat.json");
  if (existsSync(heartbeatPath)) checks.push(validateFile(heartbeatPath, validateHeartbeatState));
  const processPath = join(runDir, PROCESS_EVIDENCE_FILE);
  if (existsSync(processPath)) checks.push(validateFile(processPath, (value) => validateProcessSidecar(value, { runDir, runId: run?.run_id })));
  const slicesPath = join(runDir, "plan", "slices.json");
  if (existsSync(slicesPath)) checks.push(validateFile(slicesPath, validateSlicesPlan));
  if (checks.every((item) => item.ok)) checks.push(...checkRunConsistency(runDir, run).checks);
  return { ok: checks.every((item) => item.ok), checks };
}

export function checkRunConsistency(runDir, run) {
  const checks = [];
  let validRun = null;
  checks.push(runCheck("run.schema", () => {
    validRun = validateRun(run);
    return { run_id: validRun.run_id };
  }));
  if (!validRun) return { ok: false, checks };

  for (const [gateName, gate] of Object.entries(validRun.gates || {})) {
    if (!isRecord(gate)) continue;
    if (stringValue(gate.question_ref)) checks.push(refCheck(`run.gates.${gateName}.question_ref`, () => resolveGateRef(runDir, gate.question_ref, { mustExist: gate.status !== "pending" })));
    if (stringValue(gate.artifact)) checks.push(refCheck(`run.gates.${gateName}.artifact`, () => resolveArtifactRef(runDir, gate.artifact, { mustExist: gate.status !== "pending" })));
    if (gate.status === "approved") {
      checks.push(runCheck(`run.gates.${gateName}.approved`, () => {
        const errors = [];
        if (!stringValue(gate.answer) && !stringValue(gate.answer_ref)) errors.push({ path: `run.gates.${gateName}.answer`, message: "approved gate requires answer or answer_ref" });
        if (!stringValue(gate.answered_at)) errors.push({ path: `run.gates.${gateName}.answered_at`, message: "approved gate requires answered_at" });
        if (errors.length) fail(errors);
        return { gate: gateName };
      }));
    }
    if (stringValue(gate.answer_ref)) {
      checks.push(refCheck(`run.gates.${gateName}.answer_ref`, () => resolveGateRef(runDir, gate.answer_ref, { mustExist: gate.status !== "pending" })));
    }
  }

  for (const [index, step] of (Array.isArray(validRun.steps) ? validRun.steps : []).entries()) {
    if (stringValue(step?.evidence_ref)) checks.push(refCheck(`run.steps[${index}].evidence_ref`, () => resolveEvidenceRef(runDir, step.evidence_ref)));
    if (stringValue(step?.review_ref)) checks.push(refCheck(`run.steps[${index}].review_ref`, () => resolveReviewRef(runDir, step.review_ref)));
    if (stringValue(step?.artifact_ref)) checks.push(refCheck(`run.steps[${index}].artifact_ref`, () => resolveArtifactRef(runDir, step.artifact_ref)));
  }

  for (const [index, slice] of (Array.isArray(validRun.slices) ? validRun.slices : []).entries()) {
    if (stringValue(slice?.evidence_ref)) checks.push(refCheck(`run.slices[${index}].evidence_ref`, () => resolveEvidenceRef(runDir, slice.evidence_ref)));
    if (stringValue(slice?.review_ref)) checks.push(refCheck(`run.slices[${index}].review_ref`, () => resolveReviewRef(runDir, slice.review_ref)));
    if (slice?.status === "merged") {
      checks.push(runCheck(`run.slices[${index}].merged`, () => {
        const errors = [];
        if (!stringValue(slice.merge_commit)) errors.push({ path: `run.slices[${index}].merge_commit`, message: "merged slice requires merge_commit" });
        if (!stringValue(slice.review_ref)) errors.push({ path: `run.slices[${index}].review_ref`, message: "merged slice requires review_ref" });
        if (!stringValue(slice.evidence_ref)) errors.push({ path: `run.slices[${index}].evidence_ref`, message: "merged slice requires evidence_ref" });
        if (errors.length) fail(errors);
        return { slice_id: slice.id };
      }));
    }
  }

  checks.push(...verdictConsistencyChecks(runDir, validRun, "validator", PASSING_VALIDATOR_VERDICTS));
  checks.push(...verdictConsistencyChecks(runDir, validRun, "security_review", PASSING_SECURITY_VERDICTS));

  if (stringValue(validRun.pr_url)) {
    checks.push(runCheck("run.pr_url", () => {
      if (validRun.gates?.pre_pr?.status !== "approved") fail([{ path: "run.pr_url", message: "PR URL requires approved pre_pr gate" }]);
      return { pr_url: validRun.pr_url };
    }));
  }

  checks.push(...steeringConsistencyChecks(runDir, validRun));

  return { ok: checks.every((item) => item.ok), checks };
}

export function steeringConsistencyChecks(runDir, run) {
  const steering = run.steering;
  if (!isRecord(steering)) return [];
  const checks = [];
  const pending = isRecord(steering.pending) ? steering.pending : null;
  if (pending) {
    checks.push(refCheck("run.steering.pending.ref", () => {
      const resolved = resolveSteeringRef(runDir, pending.ref);
      const actualHash = hashFile(resolved.path, { mode: "raw" });
      if (actualHash !== pending.hash) fail([{ path: "run.steering.pending.hash", message: "must match pending steering file" }]);
      return { ref: resolved.ref, path: resolved.path, hash: actualHash };
    }));
  }
  for (const [index, entry] of (Array.isArray(steering.history) ? steering.history : []).entries()) {
    if (!isRecord(entry) || !stringValue(entry.ref)) continue;
    const mustExist = entry.event === "consumed";
    checks.push(refCheck(`run.steering.history[${index}].ref`, () => {
      const resolved = resolveSteeringRef(runDir, entry.ref, { mustExist });
      if (mustExist && stringValue(entry.hash)) {
        const actualHash = hashFile(resolved.path, { mode: "raw" });
        if (actualHash !== entry.hash) fail([{ path: `run.steering.history[${index}].hash`, message: "must match steering file" }]);
        return { ref: resolved.ref, path: resolved.path, hash: actualHash };
      }
      return { ref: resolved.ref, path: resolved.path };
    }));
    if (stringValue(entry.source_ref)) {
      checks.push(refCheck(`run.steering.history[${index}].source_ref`, () => resolveSteeringRef(runDir, entry.source_ref, { mustExist: false })));
    }
  }
  return checks;
}

export function validateFile(file, validator) {
  try {
    validator(JSON.parse(readFileSync(file, "utf8")));
    return { path: file, ok: true, errors: [] };
  } catch (error) {
    return { path: file, ok: false, errors: error instanceof ValidationError ? error.errors : [{ path: file, message: error.message }] };
  }
}

export function pendingProtectedGate(run) {
  if (!isRecord(run) || !isRecord(run.gates)) return null;
  for (const gateName of HEARTBEAT_PROTECTED_GATES) if (isPendingGate(run.gates[gateName])) return gateName;
  return null;
}

function verdictConsistencyChecks(runDir, run, key, passingVerdicts) {
  const value = run[key];
  if (!isRecord(value) || !passingVerdicts.has(value.verdict)) return [];
  const checks = [];
  if (stringValue(value.report)) checks.push(refCheck(`run.${key}.report`, () => resolveArtifactRef(runDir, value.report)));
  if (stringValue(value.review_ref)) checks.push(refCheck(`run.${key}.review_ref`, () => resolveReviewRef(runDir, value.review_ref)));
  checks.push(runCheck(`run.${key}.verdict`, () => {
    if (!stringValue(value.report) && !stringValue(value.review_ref)) {
      fail([{ path: `run.${key}`, message: "passing verdict requires report or review_ref" }]);
    }
    return { verdict: value.verdict };
  }));
  return checks;
}

function refCheck(name, resolver) {
  return runCheck(name, () => {
    const resolved = resolver();
    return { ref: resolved.ref, path: resolved.path };
  });
}

function runCheck(name, fn) {
  try {
    return { name, ok: true, errors: [], details: fn() || {} };
  } catch (error) {
    return { name, ok: false, errors: error instanceof ValidationError ? error.errors : [{ path: name, message: error.message }] };
  }
}

function validateGateMap(errors, gates, path) {
  if (gates === undefined || gates === null) return;
  if (!isRecord(gates)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  for (const [name, gate] of Object.entries(gates)) {
    validateGateName(errors, name, `${path}.${name}`);
    validateGate(errors, gate, `${path}.${name}`);
  }
}

function validateDebugSnapshot(errors, snapshotRoot, path) {
  if (snapshotRoot === undefined || snapshotRoot === null) return;
  if (!isRecord(snapshotRoot)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  for (const key of Object.keys(snapshotRoot)) if (!DEBUG_SNAPSHOT_KEYS.has(key)) errors.push({ path: `${path}.${key}`, message: "is not allowed" });
  validateDebugSnapshotEvent(errors, snapshotRoot.created_with, `${path}.created_with`);
  if (snapshotRoot.last_resumed_with !== undefined && snapshotRoot.last_resumed_with !== null) validateDebugSnapshotEvent(errors, snapshotRoot.last_resumed_with, `${path}.last_resumed_with`);
  requiredInteger(errors, snapshotRoot, "resume_count", `${path}.resume_count`);
}

function validateDebugSnapshotEvent(errors, snapshot, path) {
  if (!isRecord(snapshot)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  for (const key of Object.keys(snapshot)) if (!DEBUG_SNAPSHOT_EVENT_KEYS.has(key)) errors.push({ path: `${path}.${key}`, message: "is not allowed" });
  requiredString(errors, snapshot, "collected_at", `${path}.collected_at`);
  requiredString(errors, snapshot, "event", `${path}.event`);
  if (snapshot.diagnostic_only !== true) errors.push({ path: `${path}.diagnostic_only`, message: "must equal true" });
  const payload = snapshot.env;
  if (!isRecord(payload)) {
    errors.push({ path: `${path}.env`, message: "must be an object" });
    return;
  }
  validateRedactedEnv(errors, payload, `${path}.env`);
}

function validateContinuation(errors, run, path) {
  const continuation = run.continuation;
  if (continuation === undefined || continuation === null) return;
  if (!isRecord(continuation)) {
    errors.push({ path, message: "must be an object" });
    return;
  }

  requiredInteger(errors, continuation, "schema_version", `${path}.schema_version`);
  if (Number.isInteger(continuation.schema_version) && continuation.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  requiredEnum(errors, continuation, "kind", CONTINUATION_KINDS, `${path}.kind`);
  requiredString(errors, continuation, "created_at", `${path}.created_at`);
  requiredString(errors, continuation, "operator_summary", `${path}.operator_summary`);
  validateContinuationParent(errors, continuation.parent, `${path}.parent`);
  validateContinuationReview(errors, continuation.review, `${path}.review`);
  validateContinuationTarget(errors, run, continuation.target, `${path}.target`);
  validateContinuationRefHashArray(errors, continuation.parent_artifacts, `${path}.parent_artifacts`);
  validateContinuationRefHashArray(errors, continuation.parent_evidence, `${path}.parent_evidence`);
  validateContinuationRefHashArray(errors, continuation.parent_reviews, `${path}.parent_reviews`);
  validateContinuationSelectedReview(errors, continuation, path);
  validateContinuationPlanningReuse(errors, continuation.planning_reuse, `${path}.planning_reuse`);
}

function validateContinuationPlanningReuse(errors, reuse, path) {
  if (reuse === undefined || reuse === null) return;
  if (!isRecord(reuse)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  if (typeof reuse.eligible !== "boolean") errors.push({ path: `${path}.eligible`, message: "must be a boolean" });
  if (reuse.eligible === true) {
    requiredString(errors, reuse, "spec_review_ref", `${path}.spec_review_ref`);
    requiredHash(errors, reuse, "spec_review_hash", `${path}.spec_review_hash`);
    requiredString(errors, reuse, "spec_artifact_ref", `${path}.spec_artifact_ref`);
  }
}

function validateSteering(errors, steering, path) {
  if (steering === undefined || steering === null) return;
  if (!isRecord(steering)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  requiredInteger(errors, steering, "schema_version", `${path}.schema_version`);
  if (Number.isInteger(steering.schema_version) && steering.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  if (steering.pending !== undefined && steering.pending !== null) validateSteeringEntry(errors, steering.pending, `${path}.pending`, { pending: true });
  if (steering.pending !== undefined && steering.pending !== null && !isRecord(steering.pending)) errors.push({ path: `${path}.pending`, message: "must be an object or null" });
  if (steering.history === undefined || steering.history === null) return;
  if (!Array.isArray(steering.history)) {
    errors.push({ path: `${path}.history`, message: "must be an array" });
    return;
  }
  for (const [index, entry] of steering.history.entries()) validateSteeringEntry(errors, entry, `${path}.history[${index}]`, { history: true });
}

function validateSteeringEntry(errors, entry, path, options = {}) {
  if (!isRecord(entry)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  if (options.history) requiredEnum(errors, entry, "event", new Set(["queued", "consumed"]), `${path}.event`);
  requiredString(errors, entry, "id", `${path}.id`);
  requiredString(errors, entry, "ref", `${path}.ref`);
  requiredHash(errors, entry, "hash", `${path}.hash`);
  requiredInteger(errors, entry, "message_chars", `${path}.message_chars`);
  requiredString(errors, entry, "created_at", `${path}.created_at`);
  if (entry.event === "consumed") {
    requiredString(errors, entry, "source_ref", `${path}.source_ref`);
    requiredString(errors, entry, "consumed_at", `${path}.consumed_at`);
  }
}

function validateContinuationParent(errors, parent, path) {
  if (!isRecord(parent)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  requiredString(errors, parent, "run_id", `${path}.run_id`);
  requiredEnum(errors, parent, "status", BLOCKED_CONTINUATION_PARENT_STATUSES, `${path}.status`);
  requiredString(errors, parent, "run_ref", `${path}.run_ref`);
  requiredHash(errors, parent, "run_hash", `${path}.run_hash`);
  requiredString(errors, parent, "branch", `${path}.branch`);
  requiredString(errors, parent, "commit", `${path}.commit`);
  requiredString(errors, parent, "worktree", `${path}.worktree`);
}

function validateContinuationReview(errors, review, path) {
  if (!isRecord(review)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  requiredString(errors, review, "ref", `${path}.ref`);
  requiredString(errors, review, "kind", `${path}.kind`);
  optionalString(errors, review, "source", `${path}.source`);
  requiredHash(errors, review, "hash", `${path}.hash`);
  requiredString(errors, review, "subject", `${path}.subject`);
  optionalString(errors, review, "verdict", `${path}.verdict`);
  optionalString(errors, review, "summary", `${path}.summary`);
  validateStringArray(errors, review.required_fixes, `${path}.required_fixes`, { required: false });
  if (!stringValue(review.summary) && !hasNonEmptyStringItem(review.required_fixes)) {
    errors.push({ path, message: "requires summary or required_fixes" });
  }
}

function validateContinuationTarget(errors, run, target, path) {
  if (!isRecord(target)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  requiredString(errors, target, "run_id", `${path}.run_id`);
  requiredString(errors, target, "branch", `${path}.branch`);
  requiredString(errors, target, "worktree", `${path}.worktree`);
  requiredString(errors, target, "base_ref", `${path}.base_ref`);
  requiredString(errors, target, "base_commit", `${path}.base_commit`);
  if (stringValue(target.run_id) && stringValue(run.run_id) && target.run_id !== run.run_id) errors.push({ path: `${path}.run_id`, message: "must match run.run_id" });
  if (stringValue(target.branch) && stringValue(run.branch) && target.branch !== run.branch) errors.push({ path: `${path}.branch`, message: "must match run.branch" });
  if (stringValue(target.worktree) && stringValue(run.worktree) && target.worktree !== run.worktree) errors.push({ path: `${path}.worktree`, message: "must match run.worktree" });
}

function validateContinuationRefHashArray(errors, items, path) {
  if (!Array.isArray(items)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  for (const [index, item] of items.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      errors.push({ path: itemPath, message: "must be an object" });
      continue;
    }
    requiredString(errors, item, "kind", `${itemPath}.kind`);
    requiredString(errors, item, "ref", `${itemPath}.ref`);
    requiredHash(errors, item, "hash", `${itemPath}.hash`);
  }
}

function validateContinuationSelectedReview(errors, continuation, path) {
  const review = continuation.review;
  if (!isRecord(review) || !Array.isArray(continuation.parent_reviews)) return;
  if (!stringValue(review.ref) || typeof review.hash !== "string" || !HASH_PATTERN.test(review.hash)) return;
  const match = continuation.parent_reviews.find((item) => isRecord(item) && item.ref === review.ref);
  if (!match) {
    errors.push({ path: `${path}.parent_reviews`, message: "must include selected review ref" });
    return;
  }
  if (match.hash !== review.hash) {
    errors.push({ path: `${path}.parent_reviews`, message: "selected review hash must match review.hash" });
  }
}

function validateRedactedEnv(errors, value, path) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) validateRedactedEnv(errors, item, `${path}[${index}]`);
    return;
  }
  if (typeof value === "string") {
    if (value !== REDACTED_ENV_VALUE && isSensitiveEnvValue(value)) errors.push({ path, message: "must be redacted in debug snapshot" });
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (isSensitiveEnvKey(key) && item !== REDACTED_ENV_VALUE) errors.push({ path: itemPath, message: "is not allowed in debug snapshot" });
    validateRedactedEnv(errors, item, itemPath);
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
  validatePendingSnapshot(errors, gate.pending_snapshot, `${path}.pending_snapshot`);
}

function validatePendingSnapshot(errors, pendingSnapshot, path) {
  if (pendingSnapshot === undefined || pendingSnapshot === null) return;
  if (!isRecord(pendingSnapshot)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  requiredString(errors, pendingSnapshot, "question_ref", `${path}.question_ref`);
  requiredHash(errors, pendingSnapshot, "question_hash", `${path}.question_hash`);
  requiredString(errors, pendingSnapshot, "artifact_ref", `${path}.artifact_ref`);
  requiredHash(errors, pendingSnapshot, "artifact_hash", `${path}.artifact_hash`);
  optionalString(errors, pendingSnapshot, "answer_ref", `${path}.answer_ref`);
  optionalHash(errors, pendingSnapshot, "answer_hash", `${path}.answer_hash`);
  requiredString(errors, pendingSnapshot, "created_at", `${path}.created_at`);
}

function isPendingGate(gate) {
  return isRecord(gate) && gate.status === "pending";
}

function validateRunSlices(errors, slices, path) {
  if (slices === undefined || slices === null) return;
  if (!Array.isArray(slices)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  const ids = validateSliceIDs(errors, slices, path);
  for (const [index, slice] of slices.entries()) validateRunSlice(errors, slice, `${path}[${index}]`, ids);
}

function validateRunSlice(errors, slice, path, ids) {
  if (!isRecord(slice)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  requiredTerminalSafeString(errors, slice, "id", `${path}.id`);
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
    requiredTerminalSafeString(errors, slice, "id", `${path}[${index}].id`);
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
    if (ids.has(slice.id)) errors.push({ path: `${path}[${index}].id`, message: `duplicate id '${safeValidationIdentifier(slice.id)}'` });
    ids.add(slice.id);
  }
  return ids;
}

function validateAcyclic(errors, slices, ids, path) {
  const graph = new Map();
  for (const slice of slices) if (isRecord(slice) && typeof slice.id === "string" && ids.has(slice.id)) graph.set(slice.id, Array.isArray(slice.depends_on) ? slice.depends_on.filter((id) => ids.has(id)) : []);
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
    requiredTerminalSafeString(errors, step, "agent", `${path}[${index}].agent`);
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
  if (run.terminal_result.status && run.terminal_result.status !== run.status) errors.push({ path: `${path}.status`, message: `must match run.status '${run.status}'` });
  if (run.terminal_result.run_id && run.terminal_result.run_id !== run.run_id) errors.push({ path: `${path}.run_id`, message: "must match run.run_id" });
  if (["blocked", "partial", "needs-human"].includes(run.status) && !stringValue(run.terminal_result.reason)) errors.push({ path: `${path}.reason`, message: `is required for ${run.status}` });
}

function validateCostAttribution(errors, attribution, path, run) {
  if (attribution === undefined || attribution === null) return;
  if (!isRecord(attribution)) {
    errors.push({ path, message: "must be an object" });
    return;
  }

  requiredInteger(errors, attribution, "schema_version", `${path}.schema_version`);
  if (Number.isInteger(attribution.schema_version) && attribution.schema_version !== COST_ATTRIBUTION_SCHEMA_VERSION) errors.push({ path: `${path}.schema_version`, message: `must equal ${COST_ATTRIBUTION_SCHEMA_VERSION}` });
  requiredString(errors, attribution, "updated_at", `${path}.updated_at`);
  requiredEnum(errors, attribution, "status", COST_ATTRIBUTION_STATUS_SET, `${path}.status`);
  validateCostAttributionRollup(errors, attribution.totals, `${path}.totals`, { required: true });
  validateCostAttributionRollupMap(errors, attribution.by_agent, `${path}.by_agent`, { required: true });
  validateCostAttributionRollupMap(errors, attribution.by_slice, `${path}.by_slice`, { required: true, knownKeys: knownRunSliceIds(run) });

  const knownSlices = knownRunSliceIds(run);
  const runId = stringValue(run?.run_id) ? run.run_id : null;
  if (!Array.isArray(attribution.entries)) {
    errors.push({ path: `${path}.entries`, message: "must be an array" });
    return;
  }
  if (attribution.entries.length > MAX_COST_ATTRIBUTION_ENTRIES) errors.push({ path: `${path}.entries`, message: `must have at most ${MAX_COST_ATTRIBUTION_ENTRIES} entries` });
  for (const [index, entry] of attribution.entries.entries()) validateCostAttributionEntry(errors, entry, `${path}.entries[${index}]`, knownSlices, runId);
}

function validateCostAttributionEntry(errors, entry, path, knownSlices, runId) {
  if (!isRecord(entry)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  requiredString(errors, entry, "id", `${path}.id`);
  requiredString(errors, entry, "recorded_at", `${path}.recorded_at`);
  requiredString(errors, entry, "run_id", `${path}.run_id`);
  requiredString(errors, entry, "agent", `${path}.agent`);
  requiredEnum(errors, entry, "status", COST_ATTRIBUTION_STATUS_SET, `${path}.status`);
  validateStringArray(errors, entry.missing, `${path}.missing`, { required: true, noControlChars: true });

  for (const field of COST_ATTRIBUTION_ENTRY_OPTIONAL_STRINGS) optionalString(errors, entry, field, `${path}.${field}`);
  optionalCostCurrency(errors, entry, "cost_currency", `${path}.cost_currency`);
  validateCostAttributionNumbers(errors, entry, path);
  if (hasCostNumber(entry) && !stringValue(entry.cost_currency)) errors.push({ path: `${path}.cost_currency`, message: "is required when cost fields are present" });
  if (runId && stringValue(entry.run_id) && entry.run_id !== runId) errors.push({ path: `${path}.run_id`, message: "must match run.run_id" });
  validateCostAttributionAvailability(errors, entry, path);
  if ((entry.status === "partial" || entry.status === "unavailable") && Array.isArray(entry.missing) && !hasNonEmptyStringItem(entry.missing)) errors.push({ path: `${path}.missing`, message: `is required when status is ${entry.status}` });
  if (stringValue(entry.slice_id) && knownSlices && !knownSlices.has(entry.slice_id)) errors.push({ path: `${path}.slice_id`, message: `unknown slice '${entry.slice_id}'` });
}

function validateCostAttributionAvailability(errors, entry, path) {
  const missing = costAttributionAvailabilityMissing(entry);
  const hasUsage = hasUsageNumber(entry);
  const hasCost = hasCostNumber(entry);
  if (entry.status === "available" && Array.isArray(entry.missing) && entry.missing.length > 0) {
    errors.push({ path: `${path}.missing`, message: "must be empty when status is available" });
  }
  if (entry.status === "available" && missing.length > 0) {
    errors.push({ path: `${path}.status`, message: "available requires provider, model, usage, cost_total, and cost_currency" });
  }
  if (entry.status === "unavailable" && (hasUsage || hasCost)) errors.push({ path: `${path}.status`, message: "must be partial or available when usage or cost fields are present" });
}

function costAttributionAvailabilityMissing(entry) {
  const missing = [];
  if (!stringValue(entry.provider)) missing.push("provider");
  if (!stringValue(entry.model)) missing.push("model");
  if (!hasUsageNumber(entry)) missing.push("usage");
  if (entry.cost_total === undefined || entry.cost_total === null) missing.push("cost_total");
  if (!stringValue(entry.cost_currency)) missing.push("cost_currency");
  return missing;
}

function validateCostAttributionRollupMap(errors, map, path, options = {}) {
  if (!isRecord(map)) {
    if (options.required) errors.push({ path, message: "must be an object" });
    return;
  }
  for (const [key, rollup] of Object.entries(map)) {
    if (!stringValue(key)) errors.push({ path: `${path}.${key}`, message: "must be keyed by non-empty strings" });
    if (options.knownKeys && !options.knownKeys.has(key)) errors.push({ path: `${path}.${key}`, message: `unknown slice '${key}'` });
    validateCostAttributionRollup(errors, rollup, `${path}.${key}`, { required: true });
  }
}

function validateCostAttributionRollup(errors, rollup, path, options = {}) {
  if (!isRecord(rollup)) {
    if (options.required) errors.push({ path, message: "must be an object" });
    return;
  }
  requiredEnum(errors, rollup, "status", COST_ATTRIBUTION_STATUS_SET, `${path}.status`);
  requiredInteger(errors, rollup, "entry_count", `${path}.entry_count`);
  optionalInteger(errors, rollup, "request_count", `${path}.request_count`);
  validateStringArray(errors, rollup.missing, `${path}.missing`, { required: true, noControlChars: true });
  optionalBoolean(errors, rollup, "mixed_currency", `${path}.mixed_currency`);
  optionalString(errors, rollup, "cost_currency", `${path}.cost_currency`);
  optionalCostCurrency(errors, rollup, "cost_currency", `${path}.cost_currency`);
  validateCostAttributionNumbers(errors, rollup, path);
  if (rollup.mixed_currency === true && rollup.cost_total !== undefined && rollup.cost_total !== null) errors.push({ path: `${path}.cost_total`, message: "must be omitted when mixed_currency is true" });
  if (hasCostNumber(rollup) && rollup.mixed_currency !== true && rollup.cost_total !== undefined && !stringValue(rollup.cost_currency)) errors.push({ path: `${path}.cost_currency`, message: "is required when cost_total is present" });
}

function validateCostAttributionNumbers(errors, value, path) {
  for (const field of COST_ATTRIBUTION_NUMERIC_FIELDS) {
    if (value[field] === undefined || value[field] === null) continue;
    if (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] < 0) errors.push({ path: `${path}.${field}`, message: "must be a finite non-negative number" });
  }
}

function knownRunSliceIds(run) {
  if (!Array.isArray(run?.slices)) return null;
  const ids = new Set();
  for (const slice of run.slices) if (stringValue(slice?.id)) ids.add(slice.id);
  return ids;
}

function hasCostNumber(value) {
  return COST_NUMERIC_FIELDS.some((field) => value[field] !== undefined && value[field] !== null);
}

function hasUsageNumber(value) {
  return USAGE_NUMERIC_FIELDS.some((field) => value[field] !== undefined && value[field] !== null);
}

function validateGateName(errors, name, path) {
  if (!SAFE_GATE_NAME_PATTERN.test(name)) errors.push({ path, message: "must match safe gate name pattern [a-z0-9][a-z0-9_-]*[a-z0-9]" });
}

function validateStringMap(errors, value, path) {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  for (const [key, item] of Object.entries(value)) if (typeof item !== "string") errors.push({ path: `${path}.${key}`, message: "must be a string" });
}

function validateProcessLogRefContainment(errors, ref, path, runDir) {
  if (!stringValue(ref) || !stringValue(runDir)) return;
  const processesDir = resolve(processEvidenceProcessesDir(runDir));
  const resolvedLog = resolve(runDir, ref);
  const relativeLog = relative(processesDir, resolvedLog);
  if (relativeLog === "" || relativeLog === ".." || relativeLog.startsWith(`..${sep}`)) {
    errors.push({ path, message: "must stay under run processes directory" });
  }
}

function validateRequiredStringMap(errors, value, path) {
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  for (const [key, item] of Object.entries(value)) if (!stringValue(item)) errors.push({ path: `${path}.${key}`, message: "must be a non-empty string" });
}

function validateRequiredHashMap(errors, value, path) {
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  for (const [key, item] of Object.entries(value)) if (typeof item !== "string" || !HASH_PATTERN.test(item)) errors.push({ path: `${path}.${key}`, message: "must be a sha256 hash" });
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
    else if (options.noControlChars && hasTerminalControl(item)) errors.push({ path: `${path}[${index}]`, message: "must not contain control characters" });
    else if (options.values && !options.values.has(item)) errors.push({ path: `${path}[${index}]`, message: `unknown dependency '${item}'` });
  }
}

function hasNonEmptyStringItem(value) {
  return Array.isArray(value) && value.some((item) => stringValue(item));
}

function requiredString(errors, obj, key, path) {
  if (!stringValue(obj[key])) errors.push({ path, message: "must be a non-empty string" });
}

function requiredTerminalSafeString(errors, obj, key, path) {
  requiredString(errors, obj, key, path);
  if (typeof obj[key] === "string" && hasTerminalControl(obj[key])) errors.push({ path, message: "must not contain control characters" });
}

function optionalString(errors, obj, key, path) {
  if (obj[key] === undefined || obj[key] === null) return;
  if (typeof obj[key] !== "string") errors.push({ path, message: "must be a string or null" });
}

function optionalCostCurrency(errors, obj, key, path) {
  if (obj[key] === undefined || obj[key] === null) return;
  if (typeof obj[key] === "string" && !isSafeCostCurrency(obj[key])) errors.push({ path, message: "must be an uppercase currency code (3-12 letters) with no control characters" });
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

function optionalBoolean(errors, obj, key, path) {
  if (obj[key] === undefined || obj[key] === null) return;
  if (typeof obj[key] !== "boolean") errors.push({ path, message: "must be a boolean" });
}

function requiredInteger(errors, obj, key, path) {
  if (!Number.isInteger(obj[key]) || obj[key] < 0) errors.push({ path, message: "must be a non-negative integer" });
}

function optionalNullableInteger(errors, obj, key, path) {
  if (obj[key] === null) return;
  requiredInteger(errors, obj, key, path);
}

function requiredHash(errors, obj, key, path) {
  if (typeof obj[key] !== "string" || !HASH_PATTERN.test(obj[key])) errors.push({ path, message: "must be a sha256 hash" });
}

function optionalHash(errors, obj, key, path) {
  if (obj[key] === undefined || obj[key] === null) return;
  requiredHash(errors, obj, key, path);
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeValidationIdentifier(value) {
  return safeValidationText(value) || "<control characters removed>";
}

function safeValidationText(value) {
  if (!hasTerminalControl(value)) return value;
  return sanitizePublicCostText(value);
}

function fail(errors) {
  throw new ValidationError(errors);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
