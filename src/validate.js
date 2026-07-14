import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { COST_ATTRIBUTION_SCHEMA_VERSION, COST_ATTRIBUTION_STATUSES, COST_NUMERIC_FIELDS, MAX_COST_ATTRIBUTION_ENTRIES, USAGE_NUMERIC_FIELDS, hasTerminalControl, isSafeCostCurrency, sanitizePublicCostText } from "./cost-attribution.js";
import { REDACTED_ENV_VALUE, isSensitiveEnvKey, isSensitiveEnvValue } from "./env-snapshot.js";
import { PROCESS_EVIDENCE_FILE, processEvidenceProcessesDir, validateProcessEvidence } from "./process-evidence.js";
import { hashFile, hashValue, resolveArtifactRef, resolveEvidenceRef, resolveGateRef, resolveReviewRef, resolveSteeringRef } from "./refs.js";

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
  "post-pr-observation",
  "post-pr-remediation",
  "post-pr-revalidation",
]);
export const HEARTBEAT_PROTECTED_GATES = Object.freeze(["story", "brief", "pre_pr"]);
export const MAX_SLICE_DEPENDENCY_WAVES = 4;

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
const HANDOFF_RECEIPT_KIND = "interactive-approval-handoff";
const DEBUG_SNAPSHOT_KEYS = new Set(["created_with", "last_resumed_with", "resume_count"]);
const DEBUG_SNAPSHOT_EVENT_KEYS = new Set(["collected_at", "event", "diagnostic_only", "env"]);
const COST_ATTRIBUTION_STATUS_SET = new Set(COST_ATTRIBUTION_STATUSES);
const COST_ATTRIBUTION_ENTRY_OPTIONAL_STRINGS = new Set(["step", "slice_id", "source", "operation", "provider", "model", "request_id", "cost_currency"]);
const COST_ATTRIBUTION_NUMERIC_FIELDS = new Set([...USAGE_NUMERIC_FIELDS, ...COST_NUMERIC_FIELDS]);
export const POST_PR_PHASES = Object.freeze(["disabled", "awaiting-pr", "observing", "failure-recording", "remediation-planned", "remediation-running", "changes-observed", "committed", "revalidating", "validated", "push-pending", "remote-confirmed", "succeeded", "blocked", "needs-human"]);
export const POST_PR_TERMINAL_REASONS = Object.freeze({
  completed: ["post-pr-ci-green", "post-pr-draft-ci-green", "post-pr-external-merge"],
  blocked: ["post-pr-retry-exhausted", "post-pr-observation-timeout", "post-pr-observer-infrastructure", "post-pr-pr-closed"],
  "needs-human": ["post-pr-review-changes-requested", "post-pr-owner-ambiguous", "post-pr-account-switch-failed", "post-pr-head-mismatch", "post-pr-dispatch-start-unknown", "post-pr-path-lane-violation", "post-pr-remote-head-diverged", "post-pr-metadata-unsafe", "post-pr-push-failed", "post-pr-panel-attribution-unsafe"],
});
const POST_PR_PHASE_SET = new Set(POST_PR_PHASES);
const POST_PR_ACTIVE_PHASES = new Set(POST_PR_PHASES.filter((phase) => !["disabled", "awaiting-pr", "succeeded", "blocked", "needs-human"].includes(phase)));
const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

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
  validatePostPr(errors, run, "run.post_pr");

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

export function validateSlicesPlan(plan, { enforceDependencyDepth = true } = {}) {
  const errors = [];
  if (!isRecord(plan)) return fail([{ path: "plan", message: "must be an object" }]);
  if (!Array.isArray(plan.slices)) errors.push({ path: "plan.slices", message: "must be an array" });
  else validatePlannedSlices(errors, plan.slices, "plan.slices", { enforceDependencyDepth });
  if (errors.length) fail(errors);
  return plan;
}

// The dependency-depth cap is grandfathered ONLY for a plan whose durable form is
// the current `run.slices` — i.e. run.slices is the seeded projection of this exact
// plan. A merely nonempty run.slices must not exempt the plan: a stale, partial, or
// unrelated durable slice list would otherwise let the plan be swapped for an
// over-depth graph unchecked. Match on the closed set of slice ids AND each slice's
// dependency set (order-insensitive); any divergence re-enables enforcement.
export function runSlicesMatchPlan(run, plan) {
  const runGraph = normalizeSliceGraph(run?.slices);
  const planGraph = normalizeSliceGraph(plan?.slices);
  if (!runGraph || !planGraph) return false;
  if (runGraph.size === 0 || runGraph.size !== planGraph.size) return false;
  for (const [id, deps] of runGraph) {
    const planDeps = planGraph.get(id);
    if (!planDeps || planDeps.length !== deps.length || planDeps.some((dep, index) => dep !== deps[index])) return false;
  }
  return true;
}

function normalizeSliceGraph(slices) {
  if (!Array.isArray(slices)) return null;
  const graph = new Map();
  for (const slice of slices) {
    if (!isRecord(slice) || !stringValue(slice.id)) return null;
    const id = String(slice.id).trim();
    if (graph.has(id)) return null;
    const deps = Array.isArray(slice.depends_on)
      ? [...new Set(slice.depends_on.filter(stringValue).map((dep) => String(dep).trim()))].sort()
      : [];
    graph.set(id, deps);
  }
  return graph;
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
  if (existsSync(slicesPath)) checks.push(validateFile(slicesPath, (value) => validateSlicesPlan(value, { enforceDependencyDepth: !runSlicesMatchPlan(run, value) })));
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
  checks.push(...postPrConsistencyChecks(runDir, validRun));

  return { ok: checks.every((item) => item.ok), checks };
}

export function postPrConsistencyChecks(runDir, run) {
  const postPr = run?.post_pr;
  if (!isRecord(postPr)) return [];
  const checks = [];
  for (const [index, ref] of (Array.isArray(postPr.evidence_refs) ? postPr.evidence_refs : []).entries()) {
    checks.push(refHashCheck(`run.post_pr.evidence_refs[${index}]`, runDir, ref, resolveEvidenceRef));
  }
  const remediation = postPr.remediation;
  if (isRecord(remediation)) {
    for (const [refKey, hashKey, resolver] of [
      ["failure_evidence_ref", "failure_evidence_hash", resolveEvidenceRef],
      ["remediation_evidence_ref", "remediation_evidence_hash", resolveEvidenceRef],
      ["canonical_evidence_ref", "canonical_evidence_hash", resolveEvidenceRef, "revalidation"],
      ["validator_review_ref", "validator_review_hash", resolveReviewRef, "revalidation"],
      ["security_review_ref", "security_review_hash", resolveReviewRef, "revalidation"],
    ]) {
      const owner = argumentsForNestedRef(remediation, refKey, hashKey, resolver);
      if (owner) checks.push(refHashCheck(`run.post_pr.remediation.${owner.prefix}${refKey}`, runDir, owner.value, resolver));
    }
  }
  if (isRecord(postPr.continuation_review)) checks.push(refHashCheck("run.post_pr.continuation_review", runDir, postPr.continuation_review, resolveReviewRef));
  return checks;
}

function argumentsForNestedRef(remediation, refKey, hashKey, resolver) {
  const nested = ["canonical_evidence_ref", "validator_review_ref", "security_review_ref"].includes(refKey);
  const source = nested ? remediation.revalidation : remediation;
  if (!isRecord(source) || !stringValue(source[refKey])) return null;
  return { prefix: nested ? "revalidation." : "", value: { ref: source[refKey], hash: source[hashKey] }, resolver };
}

function refHashCheck(name, runDir, value, resolver) {
  return runCheck(name, () => {
    const resolved = resolver(runDir, value.ref);
    const actualHash = hashFile(resolved.path);
    if (actualHash !== value.hash) fail([{ path: `${name}.hash`, message: "must match referenced file" }]);
    return { ref: resolved.ref, path: resolved.path, hash: actualHash };
  });
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
  const uncheckpointed = isRecord(steering.uncheckpointed) ? steering.uncheckpointed : null;
  if (uncheckpointed) {
    checks.push(refCheck("run.steering.uncheckpointed.ref", () => {
      const resolved = resolveSteeringRef(runDir, uncheckpointed.ref);
      const actualHash = hashFile(resolved.path, { mode: "raw" });
      if (actualHash !== uncheckpointed.hash) fail([{ path: "run.steering.uncheckpointed.hash", message: "must match consumed steering file" }]);
      return { ref: resolved.ref, path: resolved.path, hash: actualHash };
    }));
  }
  for (const [index, entry] of (Array.isArray(steering.history) ? steering.history : []).entries()) {
    if (!isRecord(entry) || !stringValue(entry.ref)) continue;
    const mustExist = entry.event === "consumed" || entry.event === "acknowledged";
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
    validateGate(errors, gate, `${path}.${name}`, name);
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
  validateContinuationPostPr(errors, continuation.post_pr, `${path}.post_pr`);
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
    requiredHash(errors, reuse, "spec_artifact_hash", `${path}.spec_artifact_hash`);
  }
}

function validateContinuationPostPr(errors, value, path) {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, value, new Set(["pr_url", "repository", "pr_number", "head_sha", "disposition", "policy", "post_pr_hash", "evidence_ref", "evidence_hash", "continuation_review_ref", "continuation_review_hash"]), path);
  requiredString(errors, value, "pr_url", `${path}.pr_url`);
  requiredString(errors, value, "repository", `${path}.repository`);
  boundedInteger(errors, value, "pr_number", 1, Number.MAX_SAFE_INTEGER, `${path}.pr_number`);
  requiredFullGitSha(errors, value, "head_sha", `${path}.head_sha`);
  requiredEnum(errors, value, "disposition", new Set(["leave-unchanged"]), `${path}.disposition`);
  validatePostPrPolicy(errors, value.policy, `${path}.policy`);
  for (const key of ["post_pr_hash", "evidence_hash", "continuation_review_hash"]) requiredHash(errors, value, key, `${path}.${key}`);
  for (const key of ["evidence_ref", "continuation_review_ref"]) requiredString(errors, value, key, `${path}.${key}`);
}

function validatePostPr(errors, run, path) {
  const value = run.post_pr;
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  allowedKeys(errors, value, new Set(["schema_version", "policy", "phase", "attempt", "observation", "remediation", "evidence_refs", "continuation_review", "terminal_fact"]), path);
  requiredInteger(errors, value, "schema_version", `${path}.schema_version`);
  if (value.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  validatePostPrPolicy(errors, value.policy, `${path}.policy`);
  requiredEnum(errors, value, "phase", POST_PR_PHASE_SET, `${path}.phase`);
  requiredInteger(errors, value, "attempt", `${path}.attempt`);
  if (Number.isInteger(value.attempt) && value.attempt < 0) errors.push({ path: `${path}.attempt`, message: "must be non-negative" });
  if (Number.isInteger(value.attempt) && Number.isInteger(run.max_retries) && value.attempt > run.max_retries) errors.push({ path: `${path}.attempt`, message: "must not exceed run.max_retries" });
  validatePostPrObservation(errors, value.observation, `${path}.observation`);
  validatePostPrRemediation(errors, value.remediation, `${path}.remediation`);
  validatePostPrRefHashArray(errors, value.evidence_refs, `${path}.evidence_refs`);
  validatePostPrRefHash(errors, value.continuation_review, `${path}.continuation_review`, { optional: true });
  validatePostPrTerminalFact(errors, run, value, `${path}.terminal_fact`);

  const enabled = value.policy?.enabled === true;
  if (!enabled && value.phase !== "disabled") errors.push({ path: `${path}.phase`, message: "disabled policy requires disabled phase" });
  if (enabled && value.phase === "disabled") errors.push({ path: `${path}.phase`, message: "enabled policy cannot use disabled phase" });
  if (enabled && POST_PR_ACTIVE_PHASES.has(value.phase)) {
    if (run.status !== "running") errors.push({ path: "run.status", message: `must be running while post-PR phase is ${value.phase}` });
    if (!stringValue(run.pr_url)) errors.push({ path: "run.pr_url", message: `is required while post-PR phase is ${value.phase}` });
    if (run.terminal_result !== undefined && run.terminal_result !== null) errors.push({ path: "run.terminal_result", message: "must be null during active post-PR state" });
  }
  if (["observing", "remote-confirmed", "succeeded"].includes(value.phase) && !isRecord(value.observation)) errors.push({ path: `${path}.observation`, message: `is required for ${value.phase}` });
  if (isRecord(value.observation) && isRecord(value.policy)) {
    if (value.observation.current_interval_ms < value.policy.initial_poll_ms || value.observation.current_interval_ms > value.policy.max_poll_ms) errors.push({ path: `${path}.observation.current_interval_ms`, message: "must stay within persisted poll policy" });
    if (value.observation.consecutive_transient_errors > value.policy.max_transient_errors) errors.push({ path: `${path}.observation.consecutive_transient_errors`, message: "must not exceed persisted transient error budget" });
  }
  if (["failure-recording", "remediation-planned", "remediation-running", "changes-observed", "committed", "revalidating", "validated", "push-pending", "remote-confirmed"].includes(value.phase) && !isRecord(value.remediation)) errors.push({ path: `${path}.remediation`, message: `is required for ${value.phase}` });
  if (isRecord(value.remediation) && value.remediation.attempt !== value.attempt) errors.push({ path: `${path}.remediation.attempt`, message: "must equal run.post_pr.attempt" });
  if (isRecord(value.remediation)) {
    const expectedStage = new Map([["remediation-planned", "planned"], ["remediation-running", "running"], ["changes-observed", "changes-observed"], ["committed", "committed"], ["revalidating", "revalidating"], ["validated", "validated"], ["push-pending", "push-pending"], ["remote-confirmed", "remote-confirmed"]]).get(value.phase);
    if (expectedStage && value.remediation.stage !== expectedStage) errors.push({ path: `${path}.remediation.stage`, message: `must be ${expectedStage} while phase is ${value.phase}` });
    const boundFailure = Array.isArray(value.evidence_refs) && value.evidence_refs.some((item) => item?.ref === value.remediation.failure_evidence_ref && item?.hash === value.remediation.failure_evidence_hash);
    if (!boundFailure) errors.push({ path: `${path}.evidence_refs`, message: "must bind the current failure evidence ref/hash" });
  }
  if (isRecord(value.continuation_review) && !(value.phase === "blocked" && run.terminal_result?.reason === "post-pr-retry-exhausted")) errors.push({ path: `${path}.continuation_review`, message: "is allowed only for retry exhaustion" });
  validatePostPrTerminalConsistency(errors, run, value, path);
}

function validatePostPrTerminalFact(errors, run, postPr, path) {
  const fact = postPr.terminal_fact;
  const reason = run.terminal_result?.reason;
  const expectedKinds = new Map([
    ["post-pr-account-switch-failed", "account-switch-failed"],
    ["post-pr-dispatch-start-unknown", "dispatch-start-unknown"],
    ["post-pr-path-lane-violation", "path-lane-violation"],
    ["post-pr-remote-head-diverged", "remote-head-diverged"],
    ["post-pr-push-failed", "push-failed"],
    ["post-pr-panel-attribution-unsafe", "panel-attribution-unsafe"],
  ]);
  const expectedKind = expectedKinds.get(reason) || (reason === "post-pr-metadata-unsafe" && fact?.kind === "panel-runner-result-malformed" ? "panel-runner-result-malformed" : null);
  if (fact === undefined || fact === null) {
    if (expectedKind) errors.push({ path, message: `is required for ${reason}` });
    return;
  }
  if (!isRecord(fact)) { errors.push({ path, message: "must be an object or null" }); return; }
  if (!expectedKind) { errors.push({ path, message: "is allowed only for fact-bound post-PR terminal reasons" }); return; }
  requiredInteger(errors, fact, "schema_version", `${path}.schema_version`);
  if (fact.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  requiredEnum(errors, fact, "kind", new Set([expectedKind]), `${path}.kind`);
  requiredString(errors, fact, "observed_at", `${path}.observed_at`);
  if (!Number.isFinite(Date.parse(fact.observed_at || ""))) errors.push({ path: `${path}.observed_at`, message: "must be an ISO timestamp" });
  const remediation = postPr.remediation;
  if (expectedKind === "account-switch-failed") {
    const pushPhase = fact.operation !== "gh-auth-switch";
    allowedKeys(errors, fact, pushPhase
      ? new Set(["schema_version", "kind", "observed_at", "attempt", "operation", "error_class", "exit_code", "classification", "error_count", "error_limit", "expected_remote_sha", "candidate_head_sha", "next_retry_at"])
      : new Set(["schema_version", "kind", "observed_at", "operation", "github_account", "error_class", "exit_code"]), path);
    requiredEnum(errors, fact, "operation", pushPhase ? new Set(["remote-head", "fast-forward-push", "remote-confirmation"]) : new Set(["gh-auth-switch"]), `${path}.operation`);
    requiredEnum(errors, fact, "error_class", new Set(["account-auth", "permission", "not-found", "protocol", "command"]), `${path}.error_class`);
    if (fact.exit_code !== null) boundedInteger(errors, fact, "exit_code", 0, 255, `${path}.exit_code`);
    if (pushPhase) {
      boundedInteger(errors, fact, "attempt", 1, Number.MAX_SAFE_INTEGER, `${path}.attempt`);
      requiredEnum(errors, fact, "classification", new Set(["permanent"]), `${path}.classification`);
      boundedInteger(errors, fact, "error_count", 1, Number.MAX_SAFE_INTEGER, `${path}.error_count`);
      boundedInteger(errors, fact, "error_limit", 1, Number.MAX_SAFE_INTEGER, `${path}.error_limit`);
      for (const key of ["expected_remote_sha", "candidate_head_sha"]) requiredFullGitSha(errors, fact, key, `${path}.${key}`);
      if (fact.next_retry_at !== null || fact.operation !== remediation?.push?.last_error?.operation) errors.push({ path, message: "must bind the persisted push account failure exactly" });
    } else {
      requiredString(errors, fact, "github_account", `${path}.github_account`);
      if (fact.github_account !== run.github_account) errors.push({ path: `${path}.github_account`, message: "must match run.github_account" });
      if (fact.error_class !== postPr.observation?.last_error?.class || fact.exit_code !== (postPr.observation?.last_error?.exit_code ?? null) || fact.observed_at !== postPr.observation?.last_error?.occurred_at) errors.push({ path, message: "must bind the persisted account-switch error exactly" });
    }
  } else if (expectedKind === "dispatch-start-unknown") {
    allowedKeys(errors, fact, new Set(["schema_version", "kind", "observed_at", "attempt", "activity", "dispatch_id", "dispatch_started_at", "candidate_head_sha", "outcome"]), path);
    boundedInteger(errors, fact, "attempt", 1, Number.MAX_SAFE_INTEGER, `${path}.attempt`);
    requiredString(errors, fact, "dispatch_id", `${path}.dispatch_id`);
    requiredString(errors, fact, "dispatch_started_at", `${path}.dispatch_started_at`);
    if (fact.activity !== undefined) requiredEnum(errors, fact, "activity", new Set(["remediation", "canonical", "validator", "security"]), `${path}.activity`);
    if (fact.candidate_head_sha !== undefined && fact.candidate_head_sha !== null) requiredFullGitSha(errors, fact, "candidate_head_sha", `${path}.candidate_head_sha`);
    requiredEnum(errors, fact, "outcome", new Set(["return-unknown"]), `${path}.outcome`);
    const dispatch = fact.activity && fact.activity !== "remediation" ? remediation?.revalidation?.jobs?.[fact.activity] : remediation?.dispatch;
    const dispatchId = fact.activity && fact.activity !== "remediation" ? dispatch?.dispatch_id : dispatch?.id;
    if (fact.attempt !== postPr.attempt || fact.dispatch_id !== dispatchId || fact.dispatch_started_at !== dispatch?.started_at || dispatch?.status !== "running") errors.push({ path, message: "must bind the running dispatch identity exactly" });
  } else if (expectedKind === "path-lane-violation") {
    allowedKeys(errors, fact, new Set(["schema_version", "kind", "observed_at", "attempt", "lane", "source", "violation", "path_b64url", "changes_hash"]), path);
    boundedInteger(errors, fact, "attempt", 1, Number.MAX_SAFE_INTEGER, `${path}.attempt`);
    requiredEnum(errors, fact, "lane", new Set(["slice", "test"]), `${path}.lane`);
    requiredEnum(errors, fact, "source", new Set(["remediation-diff"]), `${path}.source`);
    requiredEnum(errors, fact, "violation", new Set(["outside-lane", "unsafe-change-kind", "symlink-escape"]), `${path}.violation`);
    requiredString(errors, fact, "path_b64url", `${path}.path_b64url`);
    if (stringValue(fact.path_b64url) && !/^[A-Za-z0-9_-]+$/u.test(fact.path_b64url)) errors.push({ path: `${path}.path_b64url`, message: "must be canonical base64url" });
    const decodedPath = decodeCanonicalBase64url(fact.path_b64url);
    if (stringValue(fact.path_b64url) && decodedPath === null) errors.push({ path: `${path}.path_b64url`, message: "must encode valid UTF-8 path bytes canonically" });
    requiredHash(errors, fact, "changes_hash", `${path}.changes_hash`);
    if (fact.attempt !== postPr.attempt || fact.lane !== remediation?.lane || fact.changes_hash !== hashValueForValidation(remediation?.changes)) errors.push({ path, message: "must bind the remediation lane and changed paths exactly" });
    if (decodedPath !== null && !remediation?.changes?.paths?.includes(decodedPath)) errors.push({ path: `${path}.path_b64url`, message: "must identify a persisted changed path" });
  } else if (expectedKind === "remote-head-diverged") {
    allowedKeys(errors, fact, new Set(["schema_version", "kind", "observed_at", "attempt", "expected_remote_sha", "candidate_head_sha", "observed_remote_sha"]), path);
    boundedInteger(errors, fact, "attempt", 1, Number.MAX_SAFE_INTEGER, `${path}.attempt`);
    for (const key of ["expected_remote_sha", "candidate_head_sha", "observed_remote_sha"]) requiredFullGitSha(errors, fact, key, `${path}.${key}`);
    if (fact.attempt !== postPr.attempt || fact.expected_remote_sha !== remediation?.push?.remote_before_sha || fact.candidate_head_sha !== remediation?.candidate_head_sha) errors.push({ path, message: "must bind the push-pending remote and candidate heads exactly" });
    if (fact.observed_remote_sha === fact.expected_remote_sha || fact.observed_remote_sha === fact.candidate_head_sha) errors.push({ path: `${path}.observed_remote_sha`, message: "must differ from both expected remote and candidate heads" });
  } else if (expectedKind === "panel-runner-result-malformed") {
    allowedKeys(errors, fact, new Set(["schema_version", "kind", "observed_at", "attempt", "activity", "dispatch_id", "candidate_head_sha", "issue"]), path);
    boundedInteger(errors, fact, "attempt", 1, Number.MAX_SAFE_INTEGER, `${path}.attempt`);
    requiredEnum(errors, fact, "activity", new Set(["validator", "security"]), `${path}.activity`);
    requiredString(errors, fact, "dispatch_id", `${path}.dispatch_id`);
    requiredFullGitSha(errors, fact, "candidate_head_sha", `${path}.candidate_head_sha`);
    requiredEnum(errors, fact, "issue", new Set(["non-object", "missing-verdict", "unexpected-result-keys", "invalid-verdict"]), `${path}.issue`);
    const job = remediation?.revalidation?.jobs?.[fact.activity];
    if (fact.attempt !== postPr.attempt || fact.candidate_head_sha !== remediation?.candidate_head_sha || fact.dispatch_id !== job?.dispatch_id || job?.status !== "running") errors.push({ path, message: "must bind the running panel job exactly" });
  } else if (expectedKind === "push-failed") {
    allowedKeys(errors, fact, new Set(["schema_version", "kind", "observed_at", "attempt", "operation", "error_class", "exit_code", "classification", "error_count", "error_limit", "expected_remote_sha", "candidate_head_sha", "next_retry_at"]), path);
    boundedInteger(errors, fact, "attempt", 1, Number.MAX_SAFE_INTEGER, `${path}.attempt`);
    requiredEnum(errors, fact, "operation", new Set(["remote-head", "fast-forward-push", "remote-confirmation"]), `${path}.operation`);
    requiredEnum(errors, fact, "error_class", new Set(["timeout", "network", "rate-limit", "server", "account-auth", "permission", "not-found", "protocol", "command", "non-fast-forward"]), `${path}.error_class`);
    if (fact.exit_code !== null) boundedInteger(errors, fact, "exit_code", 0, 255, `${path}.exit_code`);
    requiredEnum(errors, fact, "classification", new Set(["permanent", "exhausted"]), `${path}.classification`);
    boundedInteger(errors, fact, "error_count", 1, Number.MAX_SAFE_INTEGER, `${path}.error_count`);
    boundedInteger(errors, fact, "error_limit", 1, Number.MAX_SAFE_INTEGER, `${path}.error_limit`);
    for (const key of ["expected_remote_sha", "candidate_head_sha"]) requiredFullGitSha(errors, fact, key, `${path}.${key}`);
    if (fact.next_retry_at !== null) errors.push({ path: `${path}.next_retry_at`, message: "must be null for terminal push failures" });
    if (fact.attempt !== postPr.attempt || fact.error_count !== remediation?.push?.consecutive_transient_errors || fact.error_limit !== postPr.policy?.max_transient_errors || fact.operation !== remediation?.push?.last_error?.operation) errors.push({ path, message: "must bind the persisted push failure exactly" });
  } else if (expectedKind === "panel-attribution-unsafe") {
    allowedKeys(errors, fact, new Set(["schema_version", "kind", "observed_at", "attempt", "candidate_head_sha", "panel", "category", "affected_paths_hash"]), path);
    boundedInteger(errors, fact, "attempt", 1, Number.MAX_SAFE_INTEGER, `${path}.attempt`);
    requiredFullGitSha(errors, fact, "candidate_head_sha", `${path}.candidate_head_sha`);
    requiredEnum(errors, fact, "panel", new Set(["validator", "security", "combined"]), `${path}.panel`);
    requiredEnum(errors, fact, "category", new Set(["missing-paths", "invalid-paths", "empty-paths", "mixed-owner", "unowned-path", "owner-conflict", "security-block-without-slice-owner"]), `${path}.category`);
    requiredBareSha256(errors, fact, "affected_paths_hash", `${path}.affected_paths_hash`);
    if (fact.attempt !== postPr.attempt || fact.candidate_head_sha !== remediation?.candidate_head_sha) errors.push({ path, message: "must bind the current panel candidate exactly" });
  }
}

function hashValueForValidation(value) {
  return value === undefined ? null : hashValue(value);
}

function requiredBareSha256(errors, object, key, path) {
  if (typeof object?.[key] !== "string" || !/^[0-9a-f]{64}$/u.test(object[key])) errors.push({ path, message: "must be a bare lowercase SHA-256 digest" });
}

function decodeCanonicalBase64url(value) {
  if (!stringValue(value) || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  const decoded = bytes.toString("utf8");
  return Buffer.from(decoded, "utf8").toString("base64url") === value ? decoded : null;
}

function validatePostPrPolicy(errors, policy, path) {
  if (!isRecord(policy)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  allowedKeys(errors, policy, new Set(["enabled", "wait_ms", "initial_poll_ms", "max_poll_ms", "check_start_grace_ms", "max_transient_errors", "review"]), path);
  requiredBoolean(errors, policy, "enabled", `${path}.enabled`);
  boundedInteger(errors, policy, "wait_ms", 1_800_000, 86_400_000, `${path}.wait_ms`);
  boundedInteger(errors, policy, "initial_poll_ms", 15_000, 300_000, `${path}.initial_poll_ms`);
  boundedInteger(errors, policy, "max_poll_ms", 15_000, 600_000, `${path}.max_poll_ms`);
  boundedInteger(errors, policy, "check_start_grace_ms", 60_000, 900_000, `${path}.check_start_grace_ms`);
  boundedInteger(errors, policy, "max_transient_errors", 1, 50, `${path}.max_transient_errors`);
  if (Number.isInteger(policy.initial_poll_ms) && Number.isInteger(policy.max_poll_ms) && policy.max_poll_ms < policy.initial_poll_ms) errors.push({ path: `${path}.max_poll_ms`, message: "must be greater than or equal to initial_poll_ms" });
  const review = policy.review;
  if (!isRecord(review)) errors.push({ path: `${path}.review`, message: "must be an object" });
  else {
    allowedKeys(errors, review, new Set(["required", "reviewer_login", "source"]), `${path}.review`);
    requiredBoolean(errors, review, "required", `${path}.review.required`);
    requiredEnum(errors, review, "source", new Set(["driver", "none"]), `${path}.review.source`);
    if (review.required === true) {
      requiredString(errors, review, "reviewer_login", `${path}.review.reviewer_login`);
      if (stringValue(review.reviewer_login) && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(review.reviewer_login)) errors.push({ path: `${path}.review.reviewer_login`, message: "must be a valid GitHub login" });
      if (review.source !== "driver") errors.push({ path: `${path}.review.source`, message: "required review must use driver source" });
    } else if (review.reviewer_login !== null) errors.push({ path: `${path}.review.reviewer_login`, message: "must be null when review is not required" });
  }
}

function validatePostPrObservation(errors, observation, path) {
  if (observation === undefined || observation === null) return;
  if (!isRecord(observation)) {
    errors.push({ path, message: "must be an object or null" });
    return;
  }
  allowedKeys(errors, observation, new Set(["epoch", "expected_head_sha", "started_at", "deadline_at", "next_poll_at", "poll_count", "unchanged_count", "current_interval_ms", "consecutive_transient_errors", "last_observed_at", "last_fingerprint", "last_check_verdict", "last_review_verdict", "last_verdict", "last_error", "review_request", "snapshot"]), path);
  boundedInteger(errors, observation, "epoch", 1, Number.MAX_SAFE_INTEGER, `${path}.epoch`);
  requiredFullGitSha(errors, observation, "expected_head_sha", `${path}.expected_head_sha`);
  for (const key of ["started_at", "deadline_at", "next_poll_at"]) requiredString(errors, observation, key, `${path}.${key}`);
  for (const key of ["poll_count", "unchanged_count", "consecutive_transient_errors"]) boundedInteger(errors, observation, key, 0, Number.MAX_SAFE_INTEGER, `${path}.${key}`);
  boundedInteger(errors, observation, "current_interval_ms", 1, 600_000, `${path}.current_interval_ms`);
  for (const key of ["last_observed_at", "last_fingerprint"]) optionalNullableString(errors, observation, key, `${path}.${key}`);
  requiredEnum(errors, observation, "last_check_verdict", new Set(["not_started", "not_applicable", "pending", "pass", "red", "indeterminate"]), `${path}.last_check_verdict`);
  requiredEnum(errors, observation, "last_review_verdict", new Set(["not_required", "pending", "pass", "red", "indeterminate", "deferred"]), `${path}.last_review_verdict`);
  requiredEnum(errors, observation, "last_verdict", new Set(["pending", "green", "red", "external-merge", "closed", "head-mismatch", "infrastructure"]), `${path}.last_verdict`);
  validatePostPrLastError(errors, observation.last_error, `${path}.last_error`);
  validatePostPrReviewRequest(errors, observation.review_request, `${path}.review_request`);
  if (observation.snapshot !== undefined && observation.snapshot !== null) validatePostPrSanitizedSnapshot(errors, observation.snapshot, `${path}.snapshot`);
  const started = Date.parse(observation.started_at || "");
  const deadline = Date.parse(observation.deadline_at || "");
  const nextPoll = Date.parse(observation.next_poll_at || "");
  if (Number.isFinite(started) && Number.isFinite(deadline) && deadline <= started) errors.push({ path: `${path}.deadline_at`, message: "must be after started_at" });
  if (Number.isFinite(deadline) && Number.isFinite(nextPoll) && nextPoll > deadline) errors.push({ path: `${path}.next_poll_at`, message: "must not exceed deadline_at" });
}

function validatePostPrLastError(errors, value, path) {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) { errors.push({ path, message: "must be an object or null" }); return; }
  allowedKeys(errors, value, new Set(["class", "exit_code", "occurred_at", "next_retry_at"]), path);
  requiredEnum(errors, value, "class", new Set(["timeout", "network", "rate-limit", "server", "account-auth", "permission", "not-found", "protocol", "command"]), `${path}.class`);
  if (value.exit_code !== undefined) optionalNullableInteger(errors, value, "exit_code", `${path}.exit_code`);
  requiredString(errors, value, "occurred_at", `${path}.occurred_at`);
  optionalNullableString(errors, value, "next_retry_at", `${path}.next_retry_at`);
}

function validatePostPrReviewRequest(errors, value, path) {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) { errors.push({ path, message: "must be an object or null" }); return; }
  allowedKeys(errors, value, new Set(["status", "attempts", "requested_at"]), path);
  requiredEnum(errors, value, "status", new Set(["pending", "requested"]), `${path}.status`);
  boundedInteger(errors, value, "attempts", 0, Number.MAX_SAFE_INTEGER, `${path}.attempts`);
  optionalNullableString(errors, value, "requested_at", `${path}.requested_at`);
  if (value.status === "requested" && !stringValue(value.requested_at)) errors.push({ path: `${path}.requested_at`, message: "is required after reviewer request" });
}

function validatePostPrSanitizedSnapshot(errors, value, path) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) validatePostPrSanitizedSnapshot(errors, item, `${path}[${index}]`);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:raw|body|stdout|stderr|headers?|token|credentials?)$/iu.test(key)) errors.push({ path: `${path}.${key}`, message: "untrusted raw or sensitive data is not allowed" });
    validatePostPrSanitizedSnapshot(errors, item, `${path}.${key}`);
  }
}

function validatePostPrRemediation(errors, remediation, path) {
  if (remediation === undefined || remediation === null) return;
  if (!isRecord(remediation)) {
    errors.push({ path, message: "must be an object or null" });
    return;
  }
  allowedKeys(errors, remediation, new Set(["schema_version", "attempt", "reason_code", "failure_fingerprint", "failed_head_sha", "failure_evidence_ref", "failure_evidence_hash", "owner", "route", "lane", "stage", "baseline_head_sha", "dispatch", "changes", "candidate_head_sha", "remediation_evidence_ref", "remediation_evidence_hash", "revalidation", "push"]), path);
  requiredInteger(errors, remediation, "schema_version", `${path}.schema_version`);
  if (remediation.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  boundedInteger(errors, remediation, "attempt", 1, Number.MAX_SAFE_INTEGER, `${path}.attempt`);
  requiredEnum(errors, remediation, "reason_code", new Set(["check-red", "local-red"]), `${path}.reason_code`);
  requiredHash(errors, remediation, "failure_fingerprint", `${path}.failure_fingerprint`);
  requiredFullGitSha(errors, remediation, "failed_head_sha", `${path}.failed_head_sha`);
  requiredString(errors, remediation, "failure_evidence_ref", `${path}.failure_evidence_ref`);
  requiredHash(errors, remediation, "failure_evidence_hash", `${path}.failure_evidence_hash`);
  validatePostPrOwner(errors, remediation.owner, `${path}.owner`, remediation.route, remediation.lane);
  requiredEnum(errors, remediation, "route", new Set(["backend-builder", "frontend-builder", "test-verifier"]), `${path}.route`);
  requiredEnum(errors, remediation, "lane", new Set(["slice", "test"]), `${path}.lane`);
  requiredEnum(errors, remediation, "stage", new Set(["planned", "running", "changes-observed", "committed", "revalidating", "validated", "push-pending", "remote-confirmed"]), `${path}.stage`);
  requiredFullGitSha(errors, remediation, "baseline_head_sha", `${path}.baseline_head_sha`);
  validatePostPrDispatch(errors, remediation.dispatch, `${path}.dispatch`, remediation);
  validatePostPrChanges(errors, remediation.changes, `${path}.changes`);
  optionalNullableFullGitSha(errors, remediation, "candidate_head_sha", `${path}.candidate_head_sha`);
  optionalNullableString(errors, remediation, "remediation_evidence_ref", `${path}.remediation_evidence_ref`);
  optionalNullableHash(errors, remediation, "remediation_evidence_hash", `${path}.remediation_evidence_hash`);
  if ((remediation.remediation_evidence_ref === null) !== (remediation.remediation_evidence_hash === null)) errors.push({ path, message: "remediation evidence ref/hash must be set together" });
  validatePostPrRevalidation(errors, remediation.revalidation, `${path}.revalidation`);
  validatePostPrPush(errors, remediation.push, `${path}.push`);
  if (stringValue(remediation.candidate_head_sha) && remediation.candidate_head_sha === remediation.failed_head_sha) errors.push({ path: `${path}.candidate_head_sha`, message: "must differ from failed_head_sha" });
  if (["validated", "push-pending", "remote-confirmed"].includes(remediation.stage)) validatePostPrValidated(errors, remediation, path);
  if (remediation.stage === "push-pending" && remediation.push?.local_head_sha !== remediation.candidate_head_sha) errors.push({ path: `${path}.push.local_head_sha`, message: "must equal candidate_head_sha while push is pending" });
  if (remediation.stage === "remote-confirmed" && (remediation.push?.status !== "confirmed" || remediation.push?.remote_after_sha !== remediation.candidate_head_sha)) errors.push({ path: `${path}.push`, message: "remote-confirmed requires confirmed remote_after_sha equal to candidate_head_sha" });
}

function validatePostPrOwner(errors, owner, path, route, lane) {
  if (!isRecord(owner)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, owner, new Set(["kind", "slice_id", "stack", "path_b64url", "method"]), path);
  requiredEnum(errors, owner, "kind", new Set(["slice", "integration"]), `${path}.kind`);
  requiredString(errors, owner, "method", `${path}.method`);
  if (owner.kind === "slice") {
    requiredString(errors, owner, "slice_id", `${path}.slice_id`);
    requiredEnum(errors, owner, "stack", new Set(["backend", "frontend"]), `${path}.stack`);
    if (lane !== "slice" || route !== `${owner.stack}-builder`) errors.push({ path, message: "slice owner requires matching slice lane and builder route" });
  } else if (lane !== "test" || route !== "test-verifier") errors.push({ path, message: "integration owner requires test lane and test-verifier route" });
}

function validatePostPrDispatch(errors, dispatch, path, remediation) {
  if (!isRecord(dispatch)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, dispatch, new Set(["id", "status", "role", "subject", "started_at", "returned_at"]), path);
  requiredString(errors, dispatch, "id", `${path}.id`);
  requiredEnum(errors, dispatch, "status", new Set(["planned", "running", "returned"]), `${path}.status`);
  requiredString(errors, dispatch, "role", `${path}.role`);
  requiredString(errors, dispatch, "subject", `${path}.subject`);
  optionalNullableString(errors, dispatch, "started_at", `${path}.started_at`);
  optionalNullableString(errors, dispatch, "returned_at", `${path}.returned_at`);
  if (stringValue(remediation.route) && dispatch.role !== remediation.route) errors.push({ path: `${path}.role`, message: "must match remediation route" });
}

function validatePostPrChanges(errors, changes, path) {
  if (!isRecord(changes)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, changes, new Set(["paths", "entries", "tree_hash"]), path);
  validateStringArray(errors, changes.paths, `${path}.paths`, { required: true });
  if (changes.entries !== undefined) {
    if (!Array.isArray(changes.entries)) errors.push({ path: `${path}.entries`, message: "must be an array" });
    else changes.entries.forEach((entry, index) => validatePostPrChangeEntry(errors, entry, `${path}.entries[${index}]`));
  }
  optionalNullableHash(errors, changes, "tree_hash", `${path}.tree_hash`);
}

function validatePostPrChangeEntry(errors, entry, path) {
  if (!isRecord(entry)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, entry, new Set(["source", "status", "index_status", "worktree_status", "path", "previous_path", "old_mode", "new_mode"]), path);
  requiredEnum(errors, entry, "source", new Set(["worktree", "commit"]), `${path}.source`);
  requiredEnum(errors, entry, "status", new Set(["modified", "added", "untracked", "deleted", "renamed", "copied"]), `${path}.status`);
  requiredString(errors, entry, "path", `${path}.path`);
  for (const key of ["index_status", "worktree_status", "previous_path", "old_mode", "new_mode"]) if (entry[key] !== undefined && entry[key] !== null && typeof entry[key] !== "string") errors.push({ path: `${path}.${key}`, message: "must be a string or null" });
}

function validatePostPrRevalidation(errors, value, path) {
  if (!isRecord(value)) { errors.push({ path, message: "must be an object" }); return; }
  const refs = ["canonical_evidence", "validator_review", "security_review"];
  allowedKeys(errors, value, new Set(refs.flatMap((name) => [`${name}_ref`, `${name}_hash`]).concat(["canonical_verdict", "validator_verdict", "security_verdict", "jobs"])), path);
  for (const name of refs) {
    optionalNullableString(errors, value, `${name}_ref`, `${path}.${name}_ref`);
    optionalNullableHash(errors, value, `${name}_hash`, `${path}.${name}_hash`);
    if ((value[`${name}_ref`] === null) !== (value[`${name}_hash`] === null)) errors.push({ path, message: `${name} ref/hash must be set together` });
  }
  optionalNullableEnum(errors, value, "canonical_verdict", new Set(["pass", "fail"]), `${path}.canonical_verdict`);
  optionalNullableEnum(errors, value, "validator_verdict", VALIDATOR_VERDICTS, `${path}.validator_verdict`);
  optionalNullableEnum(errors, value, "security_verdict", SECURITY_VERDICTS, `${path}.security_verdict`);
  if (value.jobs !== undefined) validatePostPrJobs(errors, value.jobs, `${path}.jobs`);
}

function validatePostPrJobs(errors, jobs, path) {
  if (!isRecord(jobs)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, jobs, new Set(["canonical", "validator", "security"]), path);
  for (const activity of ["canonical", "validator", "security"]) if (jobs[activity] !== undefined) validatePostPrJob(errors, jobs[activity], `${path}.${activity}`, activity);
}

function validatePostPrJob(errors, job, path, activity) {
  if (!isRecord(job)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, job, new Set(["dispatch_id", "status", "action_token", "steering_generation", "started_at", "returned_at", "result_ref", "result_hash", "verdict", "transient_error_count", "next_retry_at", "last_error"]), path);
  requiredString(errors, job, "dispatch_id", `${path}.dispatch_id`);
  requiredEnum(errors, job, "status", new Set(["planned", "running", "retry-wait", "bound"]), `${path}.status`);
  for (const key of ["action_token", "started_at", "returned_at", "result_ref", "result_hash", "verdict", "next_retry_at", "last_error"]) if (job[key] !== null && job[key] !== undefined && typeof job[key] !== "string") errors.push({ path: `${path}.${key}`, message: "must be a string or null" });
  if (job.steering_generation !== null && job.steering_generation !== undefined && (!Number.isInteger(job.steering_generation) || job.steering_generation < 0)) errors.push({ path: `${path}.steering_generation`, message: "must be a non-negative integer or null" });
  boundedInteger(errors, job, "transient_error_count", 0, Number.MAX_SAFE_INTEGER, `${path}.transient_error_count`);
  if (job.status === "running" && (!stringValue(job.action_token) || !stringValue(job.started_at))) errors.push({ path, message: "running job requires action token and start time" });
  if (job.status === "bound" && (!stringValue(job.returned_at) || !stringValue(job.result_ref) || !stringValue(job.result_hash) || !stringValue(job.verdict))) errors.push({ path, message: "bound job requires return/ref/hash/verdict" });
  const vocabulary = activity === "canonical" ? new Set(["pass", "red"]) : activity === "validator" ? VALIDATOR_VERDICTS : SECURITY_VERDICTS;
  if (stringValue(job.verdict) && !vocabulary.has(job.verdict)) errors.push({ path: `${path}.verdict`, message: "is outside the activity verdict vocabulary" });
}

function validatePostPrPush(errors, push, path) {
  if (!isRecord(push)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, push, new Set(["status", "remote_before_sha", "local_head_sha", "remote_after_sha", "consecutive_transient_errors", "next_retry_at", "pushed_at", "last_error"]), path);
  requiredEnum(errors, push, "status", new Set(["not-ready", "pending", "confirmed"]), `${path}.status`);
  for (const key of ["remote_before_sha", "local_head_sha", "remote_after_sha"]) optionalNullableFullGitSha(errors, push, key, `${path}.${key}`);
  boundedInteger(errors, push, "consecutive_transient_errors", 0, Number.MAX_SAFE_INTEGER, `${path}.consecutive_transient_errors`);
  optionalNullableString(errors, push, "next_retry_at", `${path}.next_retry_at`);
  optionalNullableString(errors, push, "pushed_at", `${path}.pushed_at`);
  if (push.last_error !== undefined && push.last_error !== null) {
    const error = push.last_error;
    if (!isRecord(error)) errors.push({ path: `${path}.last_error`, message: "must be an object or null" });
    else {
      allowedKeys(errors, error, new Set(["operation", "observed_at", "error_class", "exit_code", "classification", "error_count", "error_limit", "expected_remote_sha", "candidate_head_sha", "next_retry_at"]), `${path}.last_error`);
      requiredEnum(errors, error, "operation", new Set(["remote-head", "fast-forward-push", "remote-confirmation"]), `${path}.last_error.operation`);
      requiredEnum(errors, error, "classification", new Set(["transient", "permanent", "exhausted"]), `${path}.last_error.classification`);
      requiredString(errors, error, "observed_at", `${path}.last_error.observed_at`);
    }
  }
}

function validatePostPrValidated(errors, remediation, path) {
  const value = remediation.revalidation;
  if (value?.canonical_verdict !== "pass") errors.push({ path: `${path}.revalidation.canonical_verdict`, message: "must be pass when validated" });
  if (!PASSING_VALIDATOR_VERDICTS.has(value?.validator_verdict)) errors.push({ path: `${path}.revalidation.validator_verdict`, message: "must be GO or GO-WITH-NITS when validated" });
  if (!PASSING_SECURITY_VERDICTS.has(value?.security_verdict)) errors.push({ path: `${path}.revalidation.security_verdict`, message: "must be PASS when validated" });
  for (const key of ["canonical_evidence_ref", "canonical_evidence_hash", "validator_review_ref", "validator_review_hash", "security_review_ref", "security_review_hash"]) if (!stringValue(value?.[key])) errors.push({ path: `${path}.revalidation.${key}`, message: "is required when validated" });
  if (!stringValue(remediation.candidate_head_sha)) errors.push({ path: `${path}.candidate_head_sha`, message: "is required when validated" });
}

function validatePostPrTerminalConsistency(errors, run, postPr, path) {
  const expected = postPr.phase === "succeeded" ? "completed" : postPr.phase === "blocked" ? "blocked" : postPr.phase === "needs-human" ? "needs-human" : null;
  if (!expected) return;
  if (run.status !== expected) errors.push({ path: "run.status", message: `must be ${expected} when post-PR phase is ${postPr.phase}` });
  const reason = run.terminal_result?.reason;
  if (!POST_PR_TERMINAL_REASONS[expected]?.includes(reason)) errors.push({ path: "run.terminal_result.reason", message: `must be a closed post-PR ${expected} reason` });
}

function validatePostPrRefHashArray(errors, items, path) {
  if (!Array.isArray(items)) { errors.push({ path, message: "must be an array" }); return; }
  const refs = new Set();
  for (const [index, item] of items.entries()) {
    validatePostPrRefHash(errors, item, `${path}[${index}]`);
    if (stringValue(item?.ref) && refs.has(item.ref)) errors.push({ path: `${path}[${index}].ref`, message: "must be unique" });
    if (stringValue(item?.ref)) refs.add(item.ref);
  }
}

function validatePostPrRefHash(errors, value, path, { optional = false } = {}) {
  if (value === undefined || value === null) { if (!optional) errors.push({ path, message: "must be an object" }); return; }
  if (!isRecord(value)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, value, new Set(["ref", "hash"]), path);
  requiredString(errors, value, "ref", `${path}.ref`);
  requiredHash(errors, value, "hash", `${path}.hash`);
}

function validateSteering(errors, steering, path) {
  if (steering === undefined || steering === null) return;
  if (!isRecord(steering)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  requiredInteger(errors, steering, "schema_version", `${path}.schema_version`);
  if (Number.isInteger(steering.schema_version) && steering.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  optionalInteger(errors, steering, "generation", `${path}.generation`);
  if (Number.isInteger(steering.generation) && steering.generation < 0) errors.push({ path: `${path}.generation`, message: "must be non-negative" });
  if (steering.pending !== undefined && steering.pending !== null) validateSteeringEntry(errors, steering.pending, `${path}.pending`, { pending: true });
  if (steering.pending !== undefined && steering.pending !== null && !isRecord(steering.pending)) errors.push({ path: `${path}.pending`, message: "must be an object or null" });
  if (steering.uncheckpointed !== undefined && steering.uncheckpointed !== null) validateSteeringEntry(errors, steering.uncheckpointed, `${path}.uncheckpointed`, { consumed: true });
  if (steering.uncheckpointed !== undefined && steering.uncheckpointed !== null && !isRecord(steering.uncheckpointed)) errors.push({ path: `${path}.uncheckpointed`, message: "must be an object or null" });
  validateSteeringBoundary(errors, steering.boundary, `${path}.boundary`, { fence: false });
  validateSteeringAction(errors, steering.action_claim, `${path}.action_claim`, { claim: true });
  validateSteeringAction(errors, steering.last_action, `${path}.last_action`, { resolved: true });
  validateSteeringBoundary(errors, steering.pr_fence, `${path}.pr_fence`, { fence: true });
  if (steering.pending !== undefined && steering.pending !== null && steering.uncheckpointed !== undefined && steering.uncheckpointed !== null) {
    errors.push({ path, message: "cannot have both pending and uncheckpointed steering" });
  }
  if (steering.boundary !== undefined && steering.boundary !== null && (steering.pending !== undefined && steering.pending !== null || steering.uncheckpointed !== undefined && steering.uncheckpointed !== null)) {
    errors.push({ path, message: "boundary cannot coexist with pending or uncheckpointed steering" });
  }
  if (steering.action_claim !== undefined && steering.action_claim !== null && (steering.pending !== undefined && steering.pending !== null || steering.uncheckpointed !== undefined && steering.uncheckpointed !== null || steering.boundary !== undefined && steering.boundary !== null)) {
    errors.push({ path, message: "action claim cannot coexist with pending, uncheckpointed, or boundary steering state" });
  }
  if (steering.pr_fence !== undefined && steering.pr_fence !== null && (steering.pending !== undefined && steering.pending !== null || steering.uncheckpointed !== undefined && steering.uncheckpointed !== null || steering.boundary !== undefined && steering.boundary !== null || steering.action_claim !== undefined && steering.action_claim !== null)) {
    errors.push({ path, message: "pre-PR fence cannot coexist with pending, uncheckpointed, boundary, or action claim steering state" });
  }
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
  if (options.history) requiredEnum(errors, entry, "event", new Set(["queued", "consumed", "acknowledged"]), `${path}.event`);
  requiredString(errors, entry, "id", `${path}.id`);
  requiredString(errors, entry, "ref", `${path}.ref`);
  if (stringValue(entry.ref) && (options.consumed || entry.event === "consumed" || entry.event === "acknowledged") && !/^steering\/consumed-[^/]+\.json$/u.test(entry.ref)) errors.push({ path: `${path}.ref`, message: "must name a consumed steering file" });
  requiredHash(errors, entry, "hash", `${path}.hash`);
  requiredInteger(errors, entry, "message_chars", `${path}.message_chars`);
  requiredString(errors, entry, "created_at", `${path}.created_at`);
  if (entry.event === "consumed") {
    requiredString(errors, entry, "source_ref", `${path}.source_ref`);
    requiredString(errors, entry, "consumed_at", `${path}.consumed_at`);
  }
  if (options.consumed || entry.event === "acknowledged") requiredString(errors, entry, "consumed_at", `${path}.consumed_at`);
  if (entry.event === "acknowledged") {
    requiredString(errors, entry, "acknowledged_at", `${path}.acknowledged_at`);
    requiredEnum(errors, entry, "outcome", new Set(["applied-prospectively"]), `${path}.outcome`);
  }
}

function validateSteeringBoundary(errors, boundary, path, options = {}) {
  if (boundary === undefined || boundary === null) return;
  if (!isRecord(boundary)) {
    errors.push({ path, message: "must be an object or null" });
    return;
  }
  if (!options.fence) requiredEnum(errors, boundary, "kind", new Set(["gate", "dispatch", "remediation", "terminal", "post-pr-observe", "post-pr-push"]), `${path}.kind`);
  requiredString(errors, boundary, "token", `${path}.token`);
  if (stringValue(boundary.token) && !/^[A-Za-z0-9_-]{8,128}$/u.test(boundary.token)) errors.push({ path: `${path}.token`, message: "must use 8-128 safe characters" });
  requiredInteger(errors, boundary, "generation", `${path}.generation`);
  if (Number.isInteger(boundary.generation) && boundary.generation < 0) errors.push({ path: `${path}.generation`, message: "must be non-negative" });
  requiredHash(errors, boundary, "state_hash", `${path}.state_hash`);
  requiredString(errors, boundary, "created_at", `${path}.created_at`);
}

function validateSteeringAction(errors, action, path, options = {}) {
  if (action === undefined || action === null) return;
  if (!isRecord(action)) {
    errors.push({ path, message: "must be an object or null" });
    return;
  }
  requiredEnum(errors, action, "kind", new Set(["dispatch", "remediation", "terminal", "post-pr-observe", "post-pr-push"]), `${path}.kind`);
  requiredString(errors, action, "token", `${path}.token`);
  if (stringValue(action.token) && !/^[A-Za-z0-9_-]{8,128}$/u.test(action.token)) errors.push({ path: `${path}.token`, message: "must use 8-128 safe characters" });
  requiredInteger(errors, action, "generation", `${path}.generation`);
  if (Number.isInteger(action.generation) && action.generation < 0) errors.push({ path: `${path}.generation`, message: "must be non-negative" });
  requiredString(errors, action, "claimed_at", `${path}.claimed_at`);
  if (options.resolved) {
    requiredEnum(errors, action, "outcome", new Set(["started", "aborted", "closed"]), `${path}.outcome`);
    requiredString(errors, action, "resolved_at", `${path}.resolved_at`);
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

function validateGate(errors, gate, path, gateName) {
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
  validateGateHandoffReceipt(errors, gate.handoff_receipt, `${path}.handoff_receipt`, gateName);
}

function validateGateHandoffReceipt(errors, receipt, path, gateName) {
  if (receipt === undefined || receipt === null) return;
  if (!isRecord(receipt)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  requiredInteger(errors, receipt, "schema_version", `${path}.schema_version`);
  if (Number.isInteger(receipt.schema_version) && receipt.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  requiredString(errors, receipt, "kind", `${path}.kind`);
  if (stringValue(receipt.kind) && receipt.kind !== HANDOFF_RECEIPT_KIND) errors.push({ path: `${path}.kind`, message: `must equal ${HANDOFF_RECEIPT_KIND}` });
  requiredString(errors, receipt, "gate", `${path}.gate`);
  if (stringValue(receipt.gate) && receipt.gate !== gateName) errors.push({ path: `${path}.gate`, message: "must match its gate key" });
  requiredHash(errors, receipt, "approval_fingerprint", `${path}.approval_fingerprint`);
  requiredHash(errors, receipt, "pending_snapshot_hash", `${path}.pending_snapshot_hash`);
  requiredHash(errors, receipt, "answer_hash", `${path}.answer_hash`);
  requiredInteger(errors, receipt, "steering_generation", `${path}.steering_generation`);
  if (Number.isInteger(receipt.steering_generation) && receipt.steering_generation < 0) errors.push({ path: `${path}.steering_generation`, message: "must be non-negative" });
  requiredString(errors, receipt, "accepted_at", `${path}.accepted_at`);
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

function validatePlannedSlices(errors, slices, path, { enforceDependencyDepth }) {
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
  const acyclic = validateAcyclic(errors, slices, ids, path);
  if (enforceDependencyDepth && errors.length === 0 && acyclic) validateDependencyDepth(errors, slices, path);
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
  let acyclic = true;
  const visit = (id, chain) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      errors.push({ path, message: `dependency cycle: ${[...chain, id].join(" -> ")}` });
      acyclic = false;
      return;
    }
    visiting.add(id);
    for (const dep of graph.get(id) || []) visit(dep, [...chain, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id, []);
  return acyclic;
}

function validateDependencyDepth(errors, slices, path) {
  const byId = new Map(slices.map((slice, index) => [slice.id, { slice, index }]));
  const memo = new Map();
  const longestPath = (id) => {
    if (memo.has(id)) return memo.get(id);
    const dependencies = byId.get(id).slice.depends_on;
    let result = { depth: 1, ids: [id] };
    for (const dependency of dependencies) {
      const parent = longestPath(dependency);
      if (parent.depth + 1 > result.depth) result = { depth: parent.depth + 1, ids: [...parent.ids, id] };
    }
    memo.set(id, result);
    return result;
  };

  for (const [id, { index }] of byId) {
    const result = longestPath(id);
    if (result.depth > MAX_SLICE_DEPENDENCY_WAVES) {
      errors.push({
        path: `${path}[${index}].depends_on`,
        message: `dependency depth ${result.depth} exceeds maximum ${MAX_SLICE_DEPENDENCY_WAVES} waves: ${result.ids.join(" -> ")}`,
      });
    }
  }
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
    validateStepAcceptance(errors, step.acceptance, `${path}[${index}].acceptance`);
    validateStepInheritedAcceptance(errors, step.inherited_acceptance, `${path}[${index}].inherited_acceptance`);
  }
}

function validateStepAcceptance(errors, acceptance, path) {
  if (acceptance === undefined || acceptance === null) return;
  if (!isRecord(acceptance)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  requiredString(errors, acceptance, "artifact_ref", `${path}.artifact_ref`);
  requiredHash(errors, acceptance, "artifact_hash", `${path}.artifact_hash`);
  optionalString(errors, acceptance, "review_ref", `${path}.review_ref`);
  if (acceptance.review_ref !== undefined && acceptance.review_ref !== null) requiredHash(errors, acceptance, "review_hash", `${path}.review_hash`);
}

function validateStepInheritedAcceptance(errors, inherited, path) {
  if (inherited === undefined || inherited === null) return;
  if (!isRecord(inherited)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  requiredString(errors, inherited, "from_run_id", `${path}.from_run_id`);
  requiredString(errors, inherited, "parent_spec_review_ref", `${path}.parent_spec_review_ref`);
  requiredHash(errors, inherited, "artifact_hash", `${path}.artifact_hash`);
  requiredHash(errors, inherited, "review_hash", `${path}.review_hash`);
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

function requiredBoolean(errors, obj, key, path) {
  if (typeof obj[key] !== "boolean") errors.push({ path, message: "must be a boolean" });
}

function boundedInteger(errors, obj, key, min, max, path) {
  if (!Number.isInteger(obj?.[key]) || obj[key] < min || obj[key] > max) errors.push({ path, message: `must be an integer from ${min} to ${max}` });
}

function optionalNullableString(errors, obj, key, path) {
  if (obj[key] === undefined || obj[key] === null) return;
  if (!stringValue(obj[key])) errors.push({ path, message: "must be a non-empty string or null" });
}

function optionalNullableEnum(errors, obj, key, values, path) {
  if (obj[key] === undefined || obj[key] === null) return;
  requiredEnum(errors, obj, key, values, path);
}

function optionalNullableHash(errors, obj, key, path) {
  if (obj[key] === undefined || obj[key] === null) return;
  requiredHash(errors, obj, key, path);
}

function requiredFullGitSha(errors, obj, key, path) {
  if (typeof obj[key] !== "string" || !FULL_GIT_SHA_PATTERN.test(obj[key])) errors.push({ path, message: "must be a full 40-character lowercase git SHA" });
}

function optionalNullableFullGitSha(errors, obj, key, path) {
  if (obj[key] === undefined || obj[key] === null) return;
  requiredFullGitSha(errors, obj, key, path);
}

function allowedKeys(errors, value, allowed, path) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push({ path: `${path}.${key}`, message: "is not allowed" });
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
