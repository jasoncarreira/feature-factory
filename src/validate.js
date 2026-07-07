import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { validateProvenanceAuthority } from "./provenance-authority.js";

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
export const HEARTBEAT_ACTIVE_STATUSES = Object.freeze(["active", "running"]);
export const HEARTBEAT_TERMINAL_STATUSES = Object.freeze(["stopped", "error"]);
export const HEARTBEAT_STATUSES = Object.freeze([...HEARTBEAT_ACTIVE_STATUSES, "stopping", ...HEARTBEAT_TERMINAL_STATUSES]);

const RUN_STATUSES = new Set(["running", ...TERMINAL_RUN_STATUSES]);
const TERMINAL_STATUSES = new Set(TERMINAL_RUN_STATUSES);
const HEARTBEAT_PHASE_SET = new Set(HEARTBEAT_PHASES);
const HEARTBEAT_STATUS_SET = new Set(HEARTBEAT_STATUSES);
const HEARTBEAT_ACTIVE_STATUS_SET = new Set(HEARTBEAT_ACTIVE_STATUSES);
const HEARTBEAT_TERMINAL_STATUS_SET = new Set(HEARTBEAT_TERMINAL_STATUSES);
const RUN_MODES = new Set(["interactive", "headless", "autonomous"]);
const GATE_STATUSES = new Set(["pending", "approved", "changes_requested", "stopped"]);
const APPROVAL_SOURCES = new Set(["human", "external-driver", "autonomous", "override"]);
const SAFE_GATE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
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
const PASSING_VALIDATOR_VERDICTS = new Set(["GO", "GO-WITH-NITS"]);
const PASSING_SECURITY_VERDICTS = new Set(["PASS"]);
const SENSITIVE_SLICE_STATUSES = new Set(["review", "merged"]);
const INTEGRATED_FEATURE_SUBJECT_TYPES = new Set(["integrated-feature", "integrated_feature"]);

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
  optionalString(errors, run, "base_commit", "run.base_commit");
  optionalString(errors, run, "branch", "run.branch");
  optionalString(errors, run, "worktree", "run.worktree");
  optionalNonEmptyString(errors, run, "github_account", "run.github_account");
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
  validateHeartbeatLifecycle(errors, heartbeat, "heartbeat");
  requiredInteger(errors, heartbeat, "interval_ms", "heartbeat.interval_ms");

  if (errors.length) fail(errors);
  return heartbeat;
}

export function validateFactoryLock(factoryLock) {
  const errors = [];
  if (!isRecord(factoryLock)) return fail([{ path: "factory_lock", message: "must be an object" }]);

  requiredInteger(errors, factoryLock, "schema_version", "factory_lock.schema_version");
  requiredString(errors, factoryLock, "run_id", "factory_lock.run_id");
  requiredString(errors, factoryLock, "heartbeat_owner", "factory_lock.heartbeat_owner");
  optionalString(errors, factoryLock, "session_owner", "factory_lock.session_owner");
  optionalString(errors, factoryLock, "updated_at", "factory_lock.updated_at");

  if (errors.length) fail(errors);
  return factoryLock;
}

export function validateRunDir(runDir, options = {}) {
  const checks = [];
  const runFile = join(runDir, "run.json");
  checks.push(validateFile(runFile, validateRun));
  const factoryLockPath = join(runDir, "factory.lock");
  if (existsSync(factoryLockPath)) checks.push(validateFile(factoryLockPath, validateFactoryLock));
  const heartbeatPath = join(runDir, "heartbeat.json");
  if (existsSync(heartbeatPath)) checks.push(validateFile(heartbeatPath, validateHeartbeatState));
  const slicesPath = join(runDir, "plan", "slices.json");
  if (existsSync(slicesPath)) checks.push(validateFile(slicesPath, validateSlicesPlan));
  if (checks.every((item) => item.ok)) {
    const authority = validateRunAuthority(runDir, readJsonFile(runFile), options);
    checks.push(...authority.checks);
  }
  return {
    ok: checks.every((item) => item.ok),
    checks,
  };
}

export function validateRunAuthority(runDir, run, options = {}) {
  const sensitiveClaims = collectSensitiveRunClaims(run);
  const attestationIndexPath = join(runDir, "attestations", "index.json");
  const shouldValidateAuthority = sensitiveClaims.length > 0 || hasRunBaseClaims(run) || existsSync(attestationIndexPath);
  if (!shouldValidateAuthority) return { ok: true, checks: [], acceptedAttestations: {}, orderedRefs: [] };

  const authority = validateProvenanceAuthority(runDir, options);
  const checks = [...authority.checks];
  const attestationRecords = acceptedAttestationRecords(authority);
  const runBaseRecord = findLastAttestationRecord(attestationRecords, (record) => record.attestation?.type === "run-base");
  const mergeChainRecord = findLastAttestationRecord(attestationRecords, (record) => record.attestation?.type === "merge-chain");

  if (sensitiveClaims.length > 0 || hasRunBaseClaims(run)) {
    checks.push(
      validateAuthorityCheck("run.provenance.run-base", () => {
        if (!runBaseRecord) {
          fail([{ path: "run", message: "provenance-sensitive run claims require an accepted run-base attestation" }]);
        }
        const bindings = runBaseRecord.attestation.bindings;
        const errors = [];
        compareOptionalString(errors, run.branch, bindings.feature_branch, "run.branch", "accepted feature branch");
        compareOptionalString(errors, run.base_ref, bindings.base_ref, "run.base_ref", "accepted base ref");
        compareOptionalString(errors, run.base_commit, bindings.base_commit, "run.base_commit", "accepted base commit");
        compareOptionalPath(errors, run.worktree, bindings.feature_worktree, bindings.repo_root, "run.worktree", "accepted feature worktree");
        if (errors.length > 0) fail(errors);
        return {
          feature_branch: bindings.feature_branch,
          feature_worktree: bindings.feature_worktree,
          base_ref: bindings.base_ref,
          base_commit: bindings.base_commit,
        };
      }),
    );
  }

  for (const [gateName, gate] of Object.entries(run.gates || {})) {
    if (!isRecord(gate) || gate.status !== "approved") continue;
    checks.push(
      validateAuthorityCheck(`run.provenance.gates.${gateName}`, () => {
        const record = findLastAttestationRecord(
          attestationRecords,
          (item) => item.attestation?.type === "gate-decision" && item.attestation?.bindings?.gate === gateName,
        );
        if (!record) {
          fail([{ path: `run.gates.${gateName}.status`, message: "approved gate requires an accepted gate-decision attestation" }]);
        }
        const bindings = record.attestation.bindings;
        const errors = [];
        if (bindings.decision !== "approved") {
          errors.push({ path: `run.gates.${gateName}.status`, message: `must match latest accepted gate decision '${bindings.decision}'` });
        }
        compareRequiredString(errors, gate.artifact, bindings.artifact_ref, `run.gates.${gateName}.artifact`, "accepted gate artifact ref");
        compareRequiredString(errors, gate.question_ref, bindings.question_ref, `run.gates.${gateName}.question_ref`, "accepted gate question ref");
        compareRequiredString(errors, gate.approval_source, bindings.approval_source, `run.gates.${gateName}.approval_source`, "accepted gate approval source");
        compareRequiredAnswerBinding(errors, gate, bindings, gateName);
        let prePrApprovals = null;
        if (gateName === "pre_pr") {
          prePrApprovals = requireCurrentPrePrApprovals(run, attestationRecords, runBaseRecord, mergeChainRecord);
        }
        if (errors.length > 0) fail(errors);
        return {
          gate: gateName,
          attestation_ref: record.ref,
          ...(prePrApprovals
            ? {
                validator_attestation_ref: prePrApprovals.validatorRecord.ref,
                security_attestation_ref: prePrApprovals.securityRecord.ref,
                head_commit: prePrApprovals.mergeChainBindings.head_commit,
              }
            : {}),
        };
      }),
    );
  }

  const mergeChainBindings = mergeChainRecord?.attestation?.bindings ?? null;
  for (const [index, slice] of (Array.isArray(run.slices) ? run.slices : []).entries()) {
    if (!isRecord(slice) || !sliceRequiresAuthority(slice)) continue;
    checks.push(
      validateAuthorityCheck(`run.provenance.slices[${index}]`, () => {
        const sliceRecord = findLastAttestationRecord(
          attestationRecords,
          (item) => item.attestation?.type === "slice-observation" && sliceMatchesObservation(slice, item.attestation.bindings),
        );
        if (!sliceRecord) {
          fail([{ path: `run.slices[${index}].status`, message: "reviewed or merged slice requires an accepted slice-observation attestation" }]);
        }

        const sliceBindings = sliceRecord.attestation.bindings;
        const errors = [];
        compareOptionalString(errors, slice.branch, sliceBindings.branch, `run.slices[${index}].branch`, "accepted slice branch");
        compareOptionalPath(errors, slice.worktree, sliceBindings.worktree, runBaseRecord?.attestation?.bindings?.repo_root, `run.slices[${index}].worktree`, "accepted slice worktree");
        compareOptionalString(errors, slice.evidence_ref, sliceBindings.evidence_ref, `run.slices[${index}].evidence_ref`, "accepted slice evidence ref");

        if (slice.status === "merged" || stringValue(slice.merge_commit) || stringValue(slice.review_ref)) {
          if (!mergeChainBindings || !Array.isArray(mergeChainBindings.entries)) {
            errors.push({ path: `run.slices[${index}].status`, message: "merged slice requires an accepted merge-chain attestation" });
          } else {
            const mergeEntry = findSliceMergeEntry(mergeChainBindings.entries, slice, sliceRecord);
            if (!mergeEntry) {
              errors.push({ path: `run.slices[${index}].merge_commit`, message: "merged slice must match an accepted merge-chain entry" });
            } else {
              compareOptionalString(errors, slice.merge_commit, mergeEntry.commit, `run.slices[${index}].merge_commit`, "accepted merge commit");
              const reviewRecord = resolveAcceptedRecord(authority.acceptedAttestations, mergeEntry.review_attestation_ref);
              if (!reviewRecord) {
                errors.push({ path: `run.slices[${index}].review_ref`, message: `accepted review attestation not found for ${mergeEntry.review_attestation_ref}` });
              } else {
                compareOptionalString(
                  errors,
                  slice.review_ref,
                  reviewRecord.attestation?.bindings?.review_ref,
                  `run.slices[${index}].review_ref`,
                  "accepted review ref",
                );
              }
            }
          }
        }

        if (errors.length > 0) fail(errors);
        return { slice_id: slice.id || null, attestation_ref: sliceRecord.ref };
      }),
    );
  }

  if (PASSING_VALIDATOR_VERDICTS.has(run.validator?.verdict)) {
    checks.push(
      validateAuthorityCheck("run.provenance.validator", () => {
        const approval = requireIntegratedFeatureReviewApproval({
          reviewer: "implementation-validator",
          attestationRecords,
          runBaseRecord,
          mergeChainRecord,
          path: "run.validator.verdict",
          label: "positive validator verdict",
          verdict: run.validator.verdict,
          verdictPath: "run.validator.verdict",
          reviewRef: run.validator.review_ref,
          reviewRefPath: "run.validator.review_ref",
        });
        return {
          attestation_ref: approval.record.ref,
          head_commit: approval.mergeChainBindings.head_commit,
        };
      }),
    );
  }

  if (PASSING_SECURITY_VERDICTS.has(run.security_review?.verdict)) {
    checks.push(
      validateAuthorityCheck("run.provenance.security-review", () => {
        const approval = requireIntegratedFeatureReviewApproval({
          reviewer: "security-reviewer",
          attestationRecords,
          runBaseRecord,
          mergeChainRecord,
          path: "run.security_review.verdict",
          label: "security PASS verdict",
          verdict: run.security_review.verdict,
          verdictPath: "run.security_review.verdict",
          reviewRef: run.security_review.review_ref,
          reviewRefPath: "run.security_review.review_ref",
        });
        return {
          attestation_ref: approval.record.ref,
          head_commit: approval.mergeChainBindings.head_commit,
        };
      }),
    );
  }

  return {
    ok: checks.every((item) => item.ok),
    checks,
    acceptedAttestations: authority.acceptedAttestations,
    orderedRefs: authority.orderedRefs,
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

export function pendingProtectedGate(run) {
  if (!isRecord(run) || !isRecord(run.gates)) return null;
  for (const gateName of HEARTBEAT_PROTECTED_GATES) {
    if (isPendingGate(run.gates[gateName])) return gateName;
  }
  return null;
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

function validateHeartbeatLifecycle(errors, heartbeat, path) {
  requiredString(errors, heartbeat, "started_at", `${path}.started_at`);
  requiredString(errors, heartbeat, "last_tick_at", `${path}.last_tick_at`);
  requiredString(errors, heartbeat, "deadline_at", `${path}.deadline_at`);
  optionalNonEmptyString(errors, heartbeat, "stop_requested_at", `${path}.stop_requested_at`);
  optionalNonEmptyString(errors, heartbeat, "stopped_at", `${path}.stopped_at`);
  optionalNonEmptyString(errors, heartbeat, "stop_reason", `${path}.stop_reason`);

  if (heartbeat.status === "stopping" && !stringValue(heartbeat.stop_requested_at)) {
    errors.push({ path: `${path}.stop_requested_at`, message: "is required when heartbeat.status is 'stopping'" });
  }
  if (HEARTBEAT_TERMINAL_STATUS_SET.has(heartbeat.status) && !stringValue(heartbeat.stopped_at)) {
    errors.push({ path: `${path}.stopped_at`, message: `is required when heartbeat.status is '${heartbeat.status}'` });
  }
  if (stringValue(heartbeat.stop_requested_at) && HEARTBEAT_ACTIVE_STATUS_SET.has(heartbeat.status)) {
    errors.push({ path: `${path}.stop_requested_at`, message: "is not allowed when heartbeat.status is active" });
  }
  if (stringValue(heartbeat.stop_reason) && HEARTBEAT_ACTIVE_STATUS_SET.has(heartbeat.status)) {
    errors.push({ path: `${path}.stop_reason`, message: "is not allowed when heartbeat.status is active" });
  }
  if (stringValue(heartbeat.stopped_at) && !HEARTBEAT_TERMINAL_STATUS_SET.has(heartbeat.status)) {
    errors.push({ path: `${path}.stopped_at`, message: "is only allowed when heartbeat.status is terminal" });
  }
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

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function collectSensitiveRunClaims(run) {
  const claims = [];
  for (const [gateName, gate] of Object.entries(run.gates || {})) {
    if (isRecord(gate) && gate.status === "approved") claims.push(`gate:${gateName}`);
  }
  for (const [index, slice] of (Array.isArray(run.slices) ? run.slices : []).entries()) {
    if (isRecord(slice) && sliceRequiresAuthority(slice)) claims.push(`slice:${slice.id || index}`);
  }
  if (PASSING_VALIDATOR_VERDICTS.has(run.validator?.verdict)) claims.push("validator");
  if (PASSING_SECURITY_VERDICTS.has(run.security_review?.verdict)) claims.push("security_review");
  return claims;
}

function hasRunBaseClaims(run) {
  return [run.branch, run.worktree, run.base_ref, run.base_commit].some(stringValue);
}

function sliceRequiresAuthority(slice) {
  return SENSITIVE_SLICE_STATUSES.has(slice.status)
    || stringValue(slice.merge_commit)
    || (slice.status === "merged" && stringValue(slice.review_ref));
}

function sliceMatchesObservation(slice, bindings) {
  if (!isRecord(bindings)) return false;
  if (stringValue(slice.id) && stringValue(bindings.slice_id) && slice.id !== bindings.slice_id) return false;
  if (stringValue(slice.branch) && stringValue(bindings.branch) && slice.branch !== bindings.branch) return false;
  return true;
}

function acceptedAttestationRecords(authority) {
  return (authority.orderedRefs || [])
    .map((ref) => resolveAcceptedRecord(authority.acceptedAttestations, ref))
    .filter(Boolean);
}

function resolveAcceptedRecord(acceptedAttestations, ref) {
  return acceptedAttestations && ref ? acceptedAttestations[ref] || null : null;
}

function findLastAttestationRecord(records, predicate) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (predicate(records[index])) return records[index];
  }
  return null;
}

function findSliceMergeEntry(entries, slice, sliceRecord) {
  return [...entries].reverse().find((entry) => {
    if (!isRecord(entry) || entry.type !== "slice_merge") return false;
    if (stringValue(slice.merge_commit) && entry.commit === slice.merge_commit) return true;
    if (entry.slice_attestation_ref === sliceRecord.ref) return true;
    if (stringValue(slice.branch) && entry.slice_commit === sliceRecord.attestation?.bindings?.slice_commit && stringValue(slice.review_ref)) return true;
    return false;
  }) || null;
}

function requireCurrentPrePrApprovals(run, attestationRecords, runBaseRecord, mergeChainRecord) {
  if (stringValue(run.validator?.verdict) && !PASSING_VALIDATOR_VERDICTS.has(run.validator.verdict)) {
    fail([{ path: "run.gates.pre_pr.status", message: `approved pre_pr gate requires a passing validator verdict, found '${run.validator.verdict}'` }]);
  }
  if (stringValue(run.security_review?.verdict) && !PASSING_SECURITY_VERDICTS.has(run.security_review.verdict)) {
    fail([
      {
        path: "run.gates.pre_pr.status",
        message: `approved pre_pr gate requires a passing security verdict, found '${run.security_review.verdict}'`,
      },
    ]);
  }

  const validatorApproval = requireIntegratedFeatureReviewApproval({
    reviewer: "implementation-validator",
    attestationRecords,
    runBaseRecord,
    mergeChainRecord,
    path: "run.gates.pre_pr.status",
    label: "approved pre_pr gate",
    verdict: PASSING_VALIDATOR_VERDICTS.has(run.validator?.verdict) ? run.validator.verdict : null,
    verdictPath: "run.validator.verdict",
    reviewRef: run.validator?.review_ref,
    reviewRefPath: "run.validator.review_ref",
  });
  const securityApproval = requireIntegratedFeatureReviewApproval({
    reviewer: "security-reviewer",
    attestationRecords,
    runBaseRecord,
    mergeChainRecord,
    path: "run.gates.pre_pr.status",
    label: "approved pre_pr gate",
    verdict: PASSING_SECURITY_VERDICTS.has(run.security_review?.verdict) ? run.security_review.verdict : null,
    verdictPath: "run.security_review.verdict",
    reviewRef: run.security_review?.review_ref,
    reviewRefPath: "run.security_review.review_ref",
  });

  return {
    validatorRecord: validatorApproval.record,
    securityRecord: securityApproval.record,
    mergeChainBindings: validatorApproval.mergeChainBindings,
  };
}

function requireIntegratedFeatureReviewApproval({
  reviewer,
  attestationRecords,
  runBaseRecord,
  mergeChainRecord,
  path,
  label,
  verdict,
  verdictPath,
  reviewRef,
  reviewRefPath,
}) {
  const { runBaseBindings, mergeChainBindings } = requireCurrentIntegratedFeatureBindings(runBaseRecord, mergeChainRecord, path, label);
  const record = findLastAttestationRecord(
    attestationRecords,
    (item) => matchesIntegratedFeatureReviewApproval(item, reviewer, runBaseBindings, mergeChainBindings),
  );

  if (!record) {
    fail([
      {
        path,
        message: `${label} requires an accepted ${reviewer} review-approval attestation bound to the current integrated feature head`,
      },
    ]);
  }

  const errors = [];
  if (stringValue(verdict) && record.attestation.bindings.verdict !== verdict) {
    errors.push({
      path: verdictPath || path,
      message: `must match accepted ${reviewer} verdict '${record.attestation.bindings.verdict}'`,
    });
  }
  if (stringValue(reviewRef)) {
    compareOptionalString(
      errors,
      reviewRef,
      record.attestation.bindings.review_ref,
      reviewRefPath || path,
      `accepted ${reviewer} review ref`,
    );
  }
  if (errors.length > 0) fail(errors);

  return {
    record,
    runBaseBindings,
    mergeChainBindings,
  };
}

function requireCurrentIntegratedFeatureBindings(runBaseRecord, mergeChainRecord, path, label) {
  const runBaseBindings = runBaseRecord?.attestation?.bindings ?? null;
  if (!isRecord(runBaseBindings)) {
    fail([{ path, message: `${label} requires an accepted run-base attestation` }]);
  }

  const mergeChainBindings = mergeChainRecord?.attestation?.bindings ?? null;
  if (!isRecord(mergeChainBindings)) {
    fail([{ path, message: `${label} requires an accepted merge-chain attestation for the current feature head` }]);
  }

  return { runBaseBindings, mergeChainBindings };
}

function matchesIntegratedFeatureReviewApproval(record, reviewer, runBaseBindings, mergeChainBindings) {
  const bindings = record?.attestation?.bindings ?? null;
  return record?.attestation?.type === "review-approval"
    && isRecord(bindings)
    && bindings.reviewer === reviewer
    && INTEGRATED_FEATURE_SUBJECT_TYPES.has(bindings.subject_type)
    && bindings.subject === runBaseBindings.feature_branch
    && bindings.subject_commit === mergeChainBindings.head_commit
    && bindings.subject_tree === mergeChainBindings.head_tree
    && isRecord(bindings.guard)
    && bindings.guard.head_commit === mergeChainBindings.head_commit
    && bindings.guard.head_tree === mergeChainBindings.head_tree
    && sameAuthorityPath(bindings.guard.worktree, runBaseBindings.feature_worktree, runBaseBindings.repo_root);
}

function compareOptionalString(errors, actual, expected, path, label) {
  if (!stringValue(actual)) return;
  if (!stringValue(expected)) {
    errors.push({ path, message: `${label} is missing` });
    return;
  }
  if (actual !== expected) errors.push({ path, message: `must match ${label} '${expected}'` });
}

function compareOptionalPath(errors, actual, expected, baseDir, path, label) {
  if (!stringValue(actual)) return;
  if (!stringValue(expected) || !stringValue(baseDir)) {
    errors.push({ path, message: `${label} is missing` });
    return;
  }
  if (!sameAuthorityPath(actual, expected, baseDir)) errors.push({ path, message: `must match ${label} '${expected}'` });
}

function compareRequiredString(errors, actual, expected, path, label) {
  if (!stringValue(actual)) {
    errors.push({ path, message: `${label} is missing` });
    return;
  }
  if (!stringValue(expected)) {
    errors.push({ path, message: `${label} is missing` });
    return;
  }
  if (actual !== expected) errors.push({ path, message: `must match ${label} '${expected}'` });
}

function compareOptionalAnswer(errors, answer, expectedHash, path) {
  if (!stringValue(answer) || !stringValue(expectedHash)) return;
  const actualHash = `sha256:${createHash("sha256").update(String(answer), "utf8").digest("hex")}`;
  if (actualHash !== expectedHash) errors.push({ path, message: `must match accepted answer hash '${expectedHash}'` });
}

function compareRequiredAnswerBinding(errors, gate, bindings, gateName) {
  if (stringValue(bindings?.answer_ref)) {
    compareRequiredString(
      errors,
      gate?.answer_ref,
      bindings.answer_ref,
      `run.gates.${gateName}.answer_ref`,
      "accepted gate answer ref",
    );
    return;
  }

  if (!stringValue(bindings?.answer_text_hash)) {
    errors.push({
      path: `run.gates.${gateName}.answer`,
      message: "accepted gate decision is missing an answer binding",
    });
    return;
  }

  if (!stringValue(gate?.answer)) {
    errors.push({
      path: `run.gates.${gateName}.answer`,
      message: `must carry accepted answer hash '${bindings.answer_text_hash}'`,
    });
    return;
  }

  compareOptionalAnswer(errors, gate.answer, bindings.answer_text_hash, `run.gates.${gateName}.answer`);
}

function normalizeClaimPath(pathValue, baseDir) {
  const resolvedPath = isAbsolute(pathValue) ? resolve(pathValue) : resolve(baseDir, pathValue);
  try {
    return realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function sameAuthorityPath(left, right, baseDir) {
  if (!stringValue(left) || !stringValue(right) || !stringValue(baseDir)) return false;
  return normalizeClaimPath(left, baseDir) === normalizeClaimPath(right, baseDir);
}

function validateAuthorityCheck(name, callback) {
  try {
    return {
      name,
      ok: true,
      errors: [],
      details: callback() || {},
    };
  } catch (error) {
    return {
      name,
      ok: false,
      errors: normalizeAuthorityErrors(error, name),
    };
  }
}

function normalizeAuthorityErrors(error, fallbackPath) {
  if (error instanceof ValidationError) return error.errors;
  if (Array.isArray(error)) return error.map((item) => normalizeAuthorityErrorItem(item, fallbackPath));
  if (isRecord(error) && stringValue(error.path) && stringValue(error.message)) return [normalizeAuthorityErrorItem(error, fallbackPath)];
  return [{ path: fallbackPath, message: error instanceof Error ? error.message : String(error) }];
}

function normalizeAuthorityErrorItem(item, fallbackPath) {
  if (isRecord(item) && stringValue(item.path) && stringValue(item.message)) return item;
  return { path: fallbackPath, message: String(item) };
}

function validateGateName(errors, name, path) {
  if (!SAFE_GATE_NAME_PATTERN.test(name)) {
    errors.push({ path, message: "gate name must match safe pattern [a-z0-9][a-z0-9_-]*[a-z0-9]" });
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(errors) {
  throw new ValidationError(errors);
}
