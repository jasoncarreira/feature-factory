import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import { COST_ATTRIBUTION_SCHEMA_VERSION, COST_ATTRIBUTION_STATUSES, COST_NUMERIC_FIELDS, MAX_COST_ATTRIBUTION_ENTRIES, USAGE_NUMERIC_FIELDS, hasTerminalControl, isSafeCostCurrency, sanitizePublicCostText } from "./cost-attribution.js";
import { REDACTED_ENV_VALUE, isSensitiveEnvKey, isSensitiveEnvValue } from "./env-snapshot.js";
import { PROCESS_EVIDENCE_FILE, processEvidenceProcessesDir, validateProcessEvidence } from "./process-evidence.js";
import { validatePlanPath } from "./post-pr-ci.js";
import { githubPrUrlParts, hashFile, hashValue, resolveArtifactRef, resolveEvidenceRef, resolveGateRef, resolveReviewRef, resolveSteeringRef } from "./refs.js";
import { evaluateDeliveryEnvelopeAdmission } from "./delivery-envelope/admission-extension.js";
import { evaluateInvariantFamilyReview } from "./delivery-envelope/review-extension.js";
import { DeliveryContractValidationError, validateAdmissionExtensionResult, validateDeliveryEnvelope, validateInvariantFamilyLedger, validateReviewExtensionResult } from "./delivery-envelope/extensions.js";
import { CHECKPOINT_ROUTING_KIND, CHECKPOINT_ROUTING_TERMINAL_REASON, validateCheckpointRoutingManifest, validateReviewedCheckpointPlan } from "./delivery-envelope/checkpoint-routing.js";
import { git } from "./git.js";
import { checkWorktreeIdentity } from "./worktrees.js";
import { effectiveCheckedExecutionTimeoutMs, MAX_CHECKED_EXECUTION_TIMEOUT_MS, MIN_CHECKED_EXECUTION_TIMEOUT_MS } from "./checked-execution-timeout.js";
import { privilegedControlPlanePathReason } from "./privileged-path-policy.js";
import { verificationArtifactExecutionClaimRef } from "./verification-artifact-refs.js";

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
export const MAX_INTEGRATION_GATE_COMMANDS = 32;
export const MAX_INTEGRATION_GATE_ARGS = 64;
export const MAX_INTEGRATION_GATE_PROGRAM_BYTES = 255;
export const MAX_INTEGRATION_GATE_ARG_BYTES = 4096;
export const MAX_INTEGRATION_GATE_ENCODED_BYTES = 64 * 1024;
export const TEST_EXECUTION_STREAM_LIMIT_BYTES = 1024 * 1024;

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
const PROVENANCE_KEYS = new Set(["schema_version", "created", "last_resumed", "resume_count", "review_dispatches"]);
const PROVENANCE_EVENT_KEYS = new Set(["schema_version", "event", "captured_at", "dispatch", "content", "runtime"]);
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
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const RUN_KEYS = new Set(["schema_version", "run_id", "mode", "status", "created_at", "updated_at", "heartbeat_at", "base_ref", "base_commit", "branch", "worktree", "github_account", "pr_mode", "pr_url", "max_parallel_slices", "max_retries", "review_tier", "debug_snapshot", "provenance", "integration_amendment", "special_builder_dispatch", "continuation", "checkpoint_source", "checkpoint_progress", "steering", "post_pr", "gates", "slices", "cost_attribution", "steps", "validator", "security_review", "terminal_result"]);
const PLAN_KEYS = new Set(["slices", "integration_gate", "delivery_envelope"]);
const PLANNED_SLICE_KEYS = new Set(["id", "stack", "paths", "depends_on", "acceptance", "test_plan"]);
const INTEGRATION_GATE_KEYS = new Set(["required_commands", "timeout_ms"]);
const INTEGRATION_GATE_COMMAND_KEYS = new Set(["program", "args"]);
const REQUIRED_FINAL_INTEGRATION_COMMAND = Object.freeze({ program: "npm", args: Object.freeze(["run", "check"]) });
const PLAN_SLICES_REF = "plan/slices.json";
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const TERMINAL_RESULT_COMMON_KEYS = new Set(["status", "run_id", "pr_url", "reason", "summary", "artifacts", "nonconvergence"]);
const TERMINAL_RESULT_COMPLETED_KEYS = new Set([...TERMINAL_RESULT_COMMON_KEYS, "pr_number", "pr_node_id", "repository", "operation_id", "head_ref", "head_sha", "base_ref", "base_sha", "draft"]);
const TERMINAL_NONCONVERGENCE_KEYS = new Set(["schema_version", "kind", "slice_id", "source_review", "continuation"]);
const TERMINAL_NONCONVERGENCE_CONTINUATION_KEYS = new Set(["program", "args"]);
const DURABLE_REF_ROOTS = new Set(["artifacts", "evidence", "reviews", "gates", "steering"]);
const GATE_KEYS = new Set(["status", "artifact", "question_ref", "answer_ref", "answered_at", "answer", "decision_note", "approval_source", "pending_snapshot", "handoff_receipt"]);
const PENDING_SNAPSHOT_KEYS = new Set(["question_ref", "question_hash", "artifact_ref", "artifact_hash", "answer_ref", "answer_hash", "created_at", "checked_authority_hash"]);
const HANDOFF_RECEIPT_KEYS = new Set(["schema_version", "kind", "gate", "approval_fingerprint", "pending_snapshot_hash", "answer_hash", "steering_generation", "accepted_at"]);
const STEP_KEYS = new Set(["agent", "status", "attempts", "artifact_ref", "review_ref", "evidence_ref", "acceptance", "inherited_acceptance", "execution_claim", "execution_claim_hash"]);
const STEP_ACCEPTANCE_KEYS = new Set(["artifact_ref", "artifact_hash", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_head_sha"]);
const STEP_INHERITED_ACCEPTANCE_KEYS = new Set(["from_run_id", "parent_spec_review_ref", "artifact_hash", "review_hash"]);
const CHECKPOINT_CONFIGURATION_KEYS = new Set(["mode", "github_account", "pr_mode", "max_parallel_slices", "max_retries", "post_pr_policy", "review_tier"]);
const CHECKPOINT_SOURCE_KEYS = new Set(["schema_version", "kind", "parent_run_id", "manifest_ref", "manifest_hash", "checkpoint_id", "checkpoint_ordinal", "root_child_run_id", "source_plan_ref", "source_plan_hash", "source_review_ref", "source_review_hash", "source_review_attempt", "parent_review_identity_hash", "child_disposition_hash", "admission_probe_hash", "brief_scope_hash", "child_plan_hash", "acceptance_mapping_hash", "initial_base_ref", "initial_base_commit"]);
const CHECKPOINT_CHILD_PUBLICATION_KEYS = new Set(["schema_version", "kind", "parent_run_id", "manifest_ref", "manifest_hash", "checkpoint_id", "checkpoint_ordinal", "child_run_id", "branch_ref", "worktree", "remote_main_ref", "base_commit", "predecessor_checkpoint_id", "predecessor_completed_run_id", "predecessor_merge_commit", "reserved_at"]);
const CHECKPOINT_PROGRESS_KEYS = new Set(["schema_version", "kind", "manifest_ref", "manifest_hash", "status", "entries", "final_closure"]);
const CHECKPOINT_PROGRESS_ENTRY_COMMON_KEYS = new Set(["state", "checkpoint_id", "ordinal", "root_child_run_id", "branch", "worktree", "base_ref", "base_commit", "predecessor_checkpoint_id", "predecessor_completed_run_id", "predecessor_merge_commit", "configuration", "publication_claim_ref", "publication_claim_oid", "reserved_at"]);
const CHECKPOINT_PROGRESS_ENTRY_KEYS = Object.freeze({
  reserved: new Set(CHECKPOINT_PROGRESS_ENTRY_COMMON_KEYS),
  "child-published": new Set([...CHECKPOINT_PROGRESS_ENTRY_COMMON_KEYS, "child_run_hash", "child_plan_hash", "brief_scope_hash", "published_at"]),
  launched: new Set([...CHECKPOINT_PROGRESS_ENTRY_COMMON_KEYS, "child_run_hash", "child_plan_hash", "brief_scope_hash", "published_at", "launched_at"]),
  merged: new Set([...CHECKPOINT_PROGRESS_ENTRY_COMMON_KEYS, "child_run_hash", "child_plan_hash", "brief_scope_hash", "published_at", "launched_at", "completed_child_run_id", "completed_child_run_hash", "checkpoint_source_hash", "configuration_hash", "lineage", "pull_request", "remote_main", "merged_at"]),
});
const CHECKPOINT_PROGRESS_FINAL_CLOSURE_KEYS = new Set(["ref", "hash", "closed_at"]);
const CHECKPOINT_LINEAGE_KEYS = new Set(["run_id", "run_hash", "parent_run_id", "continuation_claim_ref", "continuation_claim_oid"]);
const CHECKPOINT_PULL_REQUEST_KEYS = new Set(["pr_url", "pr_number", "pr_node_id", "repository", "operation_id", "head_ref", "head_sha", "base_ref", "base_sha", "draft", "merge_commit"]);
const CHECKPOINT_REMOTE_MAIN_KEYS = new Set(["ref", "commit", "observed_at"]);
const CHECKPOINT_CLOSURE_KEYS = new Set(["schema_version", "kind", "parent_run_id", "parent_run_hash", "manifest_ref", "manifest_hash", "source_plan_ref", "source_plan_hash", "source_review_ref", "source_review_hash", "source_review_attempt", "parent_review_identity_hash", "admission_probe_hash", "checkpoints", "remote_main", "closed_at"]);
const CHECKPOINT_CLOSURE_ENTRY_KEYS = new Set(["checkpoint_id", "ordinal", "root_child_run_id", "child_plan_hash", "brief_scope_hash", "completed_child_run_id", "completed_child_run_hash", "checkpoint_source_hash", "configuration", "configuration_hash", "lineage", "pull_request", "merged_at"]);
const TEST_EXECUTION_CLAIM_COMMON_KEYS = new Set(["schema_version", "kind", "state", "nonce", "run_id", "attempt", "plan_ref", "plan_hash", "head_sha", "timeout_ms", "receipt_ref", "claimed_at"]);
const TEST_EXECUTION_CLAIM_COMPLETED_KEYS = new Set([...TEST_EXECUTION_CLAIM_COMMON_KEYS, "completed_at", "status", "receipt_hash"]);
const TEST_EXECUTION_CLAIM_UNKNOWN_KEYS = new Set([...TEST_EXECUTION_CLAIM_COMMON_KEYS, "failed_at", "reason"]);
const TEST_EXECUTION_UNKNOWN_REASONS = new Set(["process-outcome-indeterminate", "authority-changed", "receipt-publication-indeterminate"]);
const TEST_EXECUTION_RECEIPT_KEYS = new Set(["schema_version", "kind", "subject", "run_id", "attempt", "claim_nonce", "plan_ref", "plan_hash", "head_sha", "timeout_ms", "started_at", "completed_at", "duration_ms", "status", "review_ready", "commands"]);
const VERIFICATION_ARTIFACT_RECEIPT_KEYS = new Set(["schema_version", "kind", "subject", "run_id", "slice_id", "attempt", "claim_nonce", "plan_ref", "plan_hash", "head_sha", "timeout_ms", "verification_artifact_id", "probe", "started_at", "completed_at", "duration_ms", "status", "review_ready", "commands", "result"]);
const VERIFICATION_ARTIFACT_CLAIM_COMMON_KEYS = new Set(["schema_version", "kind", "state", "nonce", "run_id", "slice_id", "attempt", "plan_ref", "plan_hash", "head_sha", "timeout_ms", "verification_artifact_id", "probe", "receipt_ref", "claimed_at"]);
const VERIFICATION_ARTIFACT_CLAIM_COMPLETED_KEYS = new Set([...VERIFICATION_ARTIFACT_CLAIM_COMMON_KEYS, "completed_at", "status", "receipt_hash"]);
const VERIFICATION_ARTIFACT_CLAIM_UNKNOWN_KEYS = new Set([...VERIFICATION_ARTIFACT_CLAIM_COMMON_KEYS, "failed_at", "reason", "status", "receipt_hash"]);
const VERIFICATION_ARTIFACT_PROBE_KEYS = new Set(["type", "verification_artifact_id", "test_plan_index", "test_plan_entry", "program", "args"]);
const VERIFICATION_ARTIFACT_RESULT_KEYS = new Set(["type", "outcome", "summary"]);
const TEST_EXECUTION_COMMAND_RESULT_KEYS = new Set(["index", "program", "args", "outcome", "status", "exit_code", "signal", "error_code", "duration_ms", "stdout", "stderr"]);
const TEST_EXECUTION_STREAM_KEYS = new Set(["captured_bytes", "sha256", "truncated"]);
const TEST_EXECUTION_OUTCOMES = new Set(["exited", "signaled", "timeout", "output-limit", "launch-error"]);
const TEST_EXECUTION_STATUSES = new Set(["pass", "fail"]);
const SIGNAL_PATTERN = /^SIG[A-Z0-9]{1,31}$/u;
const SLICE_KEYS = new Set(["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "branch", "worktree", "authorized_baseline_commit", "attempts", "attempt_reviews", "dispatch_required", "dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "merge_commit", "integration_conflict", "blocked_reason", "updated_at"]);
const SLICE_ATTEMPT_REVIEW_KEYS = new Set(["attempt", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "diff_base_commit", "ownership_schema_version", "ratified_paths", "modified_extensions", "verdict", "convergence", "late_discovery_strike", "remaining_fix_count", "dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash"]);
const SLICE_REVIEW_VERDICTS = new Set(["APPROVE", "REJECT"]);
const SLICE_REVIEW_CONVERGENCE = new Set(["converging", "nonconvergent"]);
const SLICE_MAX_ATTEMPTS = 3;
export const SLICE_FIX_CLASSIFICATIONS = Object.freeze([
  "architecture-replacement",
  "ownership-amendment",
  "parallel-authority-removal",
  "schema-redesign",
  "migration-redesign",
  "wholesale-head-replacement",
  "nonconvergent",
  "narrow-correction",
]);
const SLICE_FIX_CLASSIFICATION_SET = new Set(SLICE_FIX_CLASSIFICATIONS);
export const SLICE_FIX_SCOPE_EFFECTS = Object.freeze(["in-lane", "unowned-extension", "sibling-owned", "contract-change"]);
const SLICE_FIX_SCOPE_EFFECT_SET = new Set(SLICE_FIX_SCOPE_EFFECTS);
const SLICE_REMEDIATION_CONTEXT_KEYS = new Set(["schema_version", "fixes"]);
const SLICE_REMEDIATION_V2_FIX_KEYS = new Set(["required_fix_index", "classification", "scope_effect", "likely_paths", "fix_owner"]);
const SLICE_OWNERSHIP_RATIFICATION_V1_KEYS = new Set(["schema_version", "paths"]);
const SLICE_OWNERSHIP_RATIFICATION_V2_KEYS = new Set(["schema_version", "kind"]);
const MODIFIED_EXTENSION_COMMON_KEYS = new Set(["kind", "path", "rationale", "authority"]);
const MODIFIED_EXTENSION_SIBLING_KEYS = new Set([...MODIFIED_EXTENSION_COMMON_KEYS, "owner_slice_id", "owner_attempt", "owner_evidence_ref", "owner_evidence_hash", "owner_review_ref", "owner_review_hash", "owner_dispatch_claim_ref", "owner_dispatch_claim_hash", "owner_dispatch_closure_ref", "owner_dispatch_closure_hash", "owner_reviewed_commit", "owner_diff_base_commit"]);
const VERDICT_KEYS = new Set(["verdict", "report", "report_hash", "review_ref", "review_hash", "reviewed_head_sha", "loops"]);
const SLICE_REVIEW_BINDING_KEYS = Object.freeze(["evidence_hash", "review_hash", "reviewed_commit"]);
const VALIDATOR_BINDING_KEYS = Object.freeze(["report_hash", "review_hash", "reviewed_head_sha"]);
const SECURITY_BINDING_KEYS = Object.freeze(["review_hash", "reviewed_head_sha"]);
const STEERING_BOUNDARY_KEYS = new Set(["kind", "token", "generation", "state_hash", "created_at"]);
const STEERING_FENCE_CONTROL_KEYS = Object.freeze(["token", "generation", "state_hash", "created_at"]);
const PR_OPERATION_IDENTITY_KEYS = Object.freeze(["operation_id", "repository", "head_ref", "head_sha", "base_ref", "base_sha", "draft"]);
const STEERING_FENCE_KEYS = new Set([...STEERING_FENCE_CONTROL_KEYS, ...PR_OPERATION_IDENTITY_KEYS]);
const POST_PR_OPERATION_KEYS = new Set(["operation_id", "repository", "created_at", "head_ref", "head_sha", "base_ref", "base_sha", "draft", "pr_url", "pr_number", "pr_node_id"]);
const STEERING_ACTION_CLAIM_KEYS = new Set(["kind", "token", "generation", "claimed_at"]);
const STEERING_LAST_ACTION_KEYS = new Set(["kind", "token", "generation", "outcome", "claimed_at", "resolved_at"]);
const CONTINUATION_KEYS = new Set(["schema_version", "kind", "created_at", "operator_summary", "parent", "review", "target", "parent_artifacts", "parent_evidence", "parent_reviews", "planning_reuse", "configuration", "carry_forward", "checkpoint_source_hash", "configuration_hash"]);
const CONTINUATION_PARENT_KEYS = new Set(["run_id", "status", "run_ref", "run_hash", "branch", "commit", "worktree"]);
const CONTINUATION_REVIEW_KEYS = new Set(["kind", "ref", "hash", "subject", "verdict", "summary", "required_fixes", "source"]);
const CONTINUATION_REVIEW_KINDS = new Set(["validator", "security_review", "step", "slice", "post_pr"]);
const CONTINUATION_TARGET_KEYS = new Set(["run_id", "branch", "worktree", "base_ref", "base_commit"]);
const CONTINUATION_REF_HASH_KEYS = new Set(["kind", "ref", "hash"]);
const CONTINUATION_ARTIFACT_KINDS = new Set(["artifact", "story", "research_map", "design_brief", "technical_brief", "test_report", "validation_report", "pr_body"]);
const CONTINUATION_PLANNING_REUSE_KEYS = new Set(["eligible", "spec_review_ref", "spec_review_hash", "spec_artifact_ref", "spec_artifact_hash", "child_spec_review_ref"]);
const CHECKPOINT_CONTINUATION_PLANNING_REUSE_KEYS = new Set(["eligible", "plan_ref", "plan_hash", "review_ref", "review_hash"]);
const CONTINUATION_CARRY_FORWARD_KEYS = new Set(["scope", "plan_ref", "plan_hash", "start_commit", "accepted_slices", "remaining_slice_ids"]);
const CONTINUATION_CARRY_FORWARD_ACCEPTED_KEYS = new Set(["id", "declared_paths", "effective_paths", "attempts", "attempt_reviews", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "merge_commit", "integration_conflict"]);
const CONTINUATION_CONFIGURATION_KEYS = new Set(["mode", "github_account", "pr_mode", "max_parallel_slices", "max_retries", "post_pr_policy", "review_tier"]);
const AMENDMENT_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const INTEGRATION_AMENDMENT_COMMON_KEYS = new Set(["schema_version", "kind", "amendment_id", "status", "owner_slice_id", "consumer_slice_id", "defect_path", "verification_artifact_id", "admission", "failure_execution", "max_attempts", "attempts", "created_at", "updated_at"]);
const INTEGRATION_AMENDMENT_ADMISSION_KEYS = new Set(["baseline_ref", "baseline_commit", "baseline_tree", "worktree", "probe", "owner", "consumer"]);
const INTEGRATION_AMENDMENT_OWNER_KEYS = new Set(["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts", "attempt_reviews", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "merge_commit"]);
const INTEGRATION_AMENDMENT_CONSUMER_KEYS = new Set(["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts"]);
const INTEGRATION_AMENDMENT_PROBE_KEYS = new Set(["schema_version", "kind", "delivery_unit_id", "consumer_slice_id", "verification_artifact_id", "test_plan_index", "test_plan_entry", "program", "args", "timeout_ms", "substrate"]);
const INTEGRATION_AMENDMENT_EXECUTION_BINDING_KEYS = new Set(["claim_ref", "claim_hash", "receipt_ref", "receipt_hash"]);
const INTEGRATION_AMENDMENT_BUILDING_KEYS = new Set(["attempt", "state", "build_base_commit", "branch_ref", "worktree"]);
const INTEGRATION_AMENDMENT_REVIEWED_KEYS = new Set([...INTEGRATION_AMENDMENT_BUILDING_KEYS, "dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash", "candidate_commit", "candidate_tree", "changed_paths", "review_ref", "review_hash", "reviewed_commit", "reviewed_tree"]);
const INTEGRATION_AMENDMENT_INTEGRATION_KEYS = new Set(["ref", "worktree", "commit", "tree"]);
const INTEGRATION_AMENDMENT_PUBLICATION_KEYS = new Set(["branch_ref", "previous_commit", "commit", "published_at"]);
const INTEGRATION_AMENDMENT_BLOCKED_KEYS = new Set(["origin", "reason", "blocked_at"]);
const INTEGRATION_AMENDMENT_REVIEW_KEYS = new Set(["schema_version", "kind", "subject", "amendment_id", "attempt", "build_base_commit", "reviewed_commit", "reviewed_tree", "changed_paths", "dispositions", "verdict", "required_fixes", "reviewed_at"]);
const INTEGRATION_AMENDMENT_DISPOSITIONS = Object.freeze(["accepted_contract", "public_contract", "persisted_contract", "product_scope", "security_boundary", "generated_ownership", "decomposition"]);
const INTEGRATION_AMENDMENT_IDENTITY_KEYS = new Set(["schema_version", "kind", "run_id", "defect_path", "admission"]);
const INTEGRATION_AMENDMENT_CLAIM_COMMON_KEYS = new Set(["schema_version", "kind", "phase", "subject", "state", "nonce", "amendment_id", "identity", "run_id", "probe", "head_sha", "tree_sha", "cwd", "timeout_ms", "receipt_ref", "claimed_at"]);
const INTEGRATION_AMENDMENT_CLAIM_COMPLETED_KEYS = new Set([...INTEGRATION_AMENDMENT_CLAIM_COMMON_KEYS, "completed_at", "status", "receipt_hash"]);
const INTEGRATION_AMENDMENT_CLAIM_UNKNOWN_KEYS = new Set([...INTEGRATION_AMENDMENT_CLAIM_COMMON_KEYS, "failed_at", "reason", "receipt_status", "receipt_hash"]);
const INTEGRATION_AMENDMENT_RECEIPT_KEYS = new Set(["schema_version", "kind", "phase", "subject", "run_id", "amendment_id", "claim_nonce", "probe", "head_sha", "tree_sha", "cwd", "timeout_ms", "started_at", "completed_at", "duration_ms", "status", "review_ready", "commands"]);
const INTEGRATION_AMENDMENT_UNKNOWN_REASONS = new Set(["process-outcome-indeterminate", "authority-changed", "receipt-publication-indeterminate"]);

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

export function validateSliceReviewResult(review, { sliceId = "slice", priorReviews = [] } = {}) {
  const errors = [];
  const path = "review";
  if (!isRecord(review)) fail([{ path, message: "must be an object" }]);
  appendDeliveryContractErrors(errors, () => validateInvariantFamilyLedger(review.invariant_family_ledger, {
    reviewedCommit: review.reviewed_commit,
  }));
  appendDeliveryContractErrors(errors, () => validateReviewExtensionResult(evaluateInvariantFamilyReview({ sliceId, review })));
  if (!Array.isArray(review.required_fixes)) errors.push({ path: `${path}.required_fixes`, message: "must be an array" });
  const fixes = Array.isArray(review.required_fixes) ? review.required_fixes : [];
  const canonicalFixes = fixes.map((fix) => typeof fix === "string" ? fix.trim().normalize("NFC") : null);
  if (canonicalFixes.some((fix, index) => !fix || fix !== fixes[index]) || new Set(canonicalFixes).size !== canonicalFixes.length) {
    errors.push({ path: `${path}.required_fixes`, message: "must be unique trimmed NFC-normalized atomic issues" });
  }
  requiredEnum(errors, review, "verdict", SLICE_REVIEW_VERDICTS, `${path}.verdict`);
  requiredEnum(errors, review, "convergence", SLICE_REVIEW_CONVERGENCE, `${path}.convergence`);
  appendSliceReviewStrikePolicyErrors(errors, review, path, priorReviews);
  boundedInteger(errors, review, "remaining_fix_count", 0, Number.MAX_SAFE_INTEGER, `${path}.remaining_fix_count`);
  if (review.remaining_fix_count !== fixes.length) errors.push({ path: `${path}.remaining_fix_count`, message: "must equal required_fixes length" });
  if (review.verdict === "APPROVE" && fixes.length !== 0) errors.push({ path: `${path}.required_fixes`, message: "APPROVE review requires zero remaining fixes" });
  if (review.verdict === "REJECT" && fixes.length < 1) errors.push({ path: `${path}.required_fixes`, message: "REJECT review requires at least one remaining fix" });
  const ratification = review.ownership_ratification;
  if (!isRecord(ratification)) {
    errors.push({ path: `${path}.ownership_ratification`, message: "is required and must be an object" });
  } else {
    requiredInteger(errors, ratification, "schema_version", `${path}.ownership_ratification.schema_version`);
    if (ratification.schema_version === 1) {
      allowedKeys(errors, ratification, SLICE_OWNERSHIP_RATIFICATION_V1_KEYS, `${path}.ownership_ratification`);
      validateCanonicalConcretePathSet(errors, ratification.paths, `${path}.ownership_ratification.paths`, { allowEmpty: true, sorted: true });
      if (review.verdict === "REJECT" && Array.isArray(ratification.paths) && ratification.paths.length !== 0) {
        errors.push({ path: `${path}.ownership_ratification.paths`, message: "must be empty for REJECT" });
      }
    } else if (ratification.schema_version === 2) {
      allowedKeys(errors, ratification, SLICE_OWNERSHIP_RATIFICATION_V2_KEYS, `${path}.ownership_ratification`);
      requiredString(errors, ratification, "kind", `${path}.ownership_ratification.kind`);
      if (ratification.kind !== "factory-derived-modified-extension") {
        errors.push({ path: `${path}.ownership_ratification.kind`, message: "must equal factory-derived-modified-extension" });
      }
    } else {
      errors.push({ path: `${path}.ownership_ratification.schema_version`, message: "must equal 1 or 2" });
    }
  }

  const context = review.remediation_context;
  if (!isRecord(context)) {
    errors.push({ path: `${path}.remediation_context`, message: "is required and must be an object" });
  } else {
    allowedKeys(errors, context, SLICE_REMEDIATION_CONTEXT_KEYS, `${path}.remediation_context`);
    requiredInteger(errors, context, "schema_version", `${path}.remediation_context.schema_version`);
    if (context.schema_version !== 2) errors.push({ path: `${path}.remediation_context.schema_version`, message: "must equal 2" });
    if (!Array.isArray(context.fixes)) {
      errors.push({ path: `${path}.remediation_context.fixes`, message: "must be an array" });
    } else {
      if (context.fixes.length !== fixes.length) errors.push({ path: `${path}.remediation_context.fixes`, message: "must classify every required fix exactly once" });
      for (const [index, classification] of context.fixes.entries()) {
        const fixPath = `${path}.remediation_context.fixes[${index}]`;
        if (!isRecord(classification)) {
          errors.push({ path: fixPath, message: "must be an object" });
          continue;
        }
        allowedKeys(errors, classification, SLICE_REMEDIATION_V2_FIX_KEYS, fixPath);
        boundedInteger(errors, classification, "required_fix_index", 0, Math.max(0, fixes.length - 1), `${fixPath}.required_fix_index`);
        if (classification.required_fix_index !== index) errors.push({ path: `${fixPath}.required_fix_index`, message: "must equal its required_fixes position" });
        requiredEnum(errors, classification, "classification", SLICE_FIX_CLASSIFICATION_SET, `${fixPath}.classification`);
        requiredEnum(errors, classification, "scope_effect", SLICE_FIX_SCOPE_EFFECT_SET, `${fixPath}.scope_effect`);
        requiredTerminalSafeString(errors, classification, "fix_owner", `${fixPath}.fix_owner`);
        validateLikelyRepositoryPaths(errors, classification.likely_paths, `${fixPath}.likely_paths`);
      }
      const hasNonconvergent = context.fixes.some((fix) => fix?.classification === "nonconvergent");
      if ((review.convergence === "nonconvergent") !== hasNonconvergent) {
        errors.push({ path: `${path}.remediation_context.fixes`, message: "must classify nonconvergent exactly when review convergence is nonconvergent" });
      }
    }
  }
  if (errors.length) fail(errors.map((error) => ({ ...error, message: `${error.message} for slice '${sliceId}'` })));
  const classifications = context.fixes.map((fix) => fix.classification);
  return {
    verdict: review.verdict,
    convergence: review.convergence,
    late_discovery_strike: review.late_discovery_strike,
    remaining_fix_count: review.remaining_fix_count,
    ownership_schema_version: ratification.schema_version,
    ratified_paths: ratification.schema_version === 1 && Array.isArray(ratification.paths) ? [...ratification.paths] : [],
    task_context: classifications.length > 0 && classifications.every((classification) => classification === "narrow-correction") ? "reuse" : "fresh",
  };
}

function appendSliceReviewStrikePolicyErrors(errors, review, path, priorReviews = []) {
  requiredBoolean(errors, review, "late_discovery_strike", `${path}.late_discovery_strike`);
  if (review.late_discovery_strike === true) {
    if (review.verdict !== "REJECT" || review.convergence !== "converging") {
      errors.push({ path: `${path}.late_discovery_strike`, message: "requires a converging REJECT" });
    }
    if (!Number.isInteger(review.attempt) || review.attempt <= 1 || review.attempt >= SLICE_MAX_ATTEMPTS) {
      errors.push({ path: `${path}.late_discovery_strike`, message: "requires a later review with one normal attempt remaining" });
    }
    const priorStrike = priorReviews.find((entry) => entry?.late_discovery_strike === true);
    if (priorStrike) {
      errors.push({ path: `${path}.late_discovery_strike`, message: `must not repeat the strike recorded at attempt ${priorStrike.attempt}` });
    }
  }
  if (review.attempt === SLICE_MAX_ATTEMPTS && review.verdict === "REJECT" && review.convergence !== "nonconvergent") {
    errors.push({ path: `${path}.convergence`, message: "must be nonconvergent when the final attempt is rejected" });
  }
}

export function sliceReviewTaskContext(review, options = {}) {
  return validateSliceReviewResult(review, options).task_context;
}

export function validateSliceReviewFeasibility(review, plan, { sliceId = "slice" } = {}) {
  validateSliceReviewResult(review, { sliceId });
  validateSlicesPlan(plan, { enforceDependencyDepth: false });
  try {
    validateReviewExtensionResult(evaluateInvariantFamilyReview({ plan, sliceId, review }));
  } catch (error) {
    if (error instanceof DeliveryContractValidationError) fail(error.errors);
    throw error;
  }
  const byId = new Map(plan.slices.map((slice) => [slice.id, slice]));
  if (!byId.has(sliceId)) {
    fail([{ path: "review.subject", message: `reviewed slice '${sliceId}' must exist in the current plan` }]);
  }
  const planLaneErrors = [];
  const ownershipPlan = plan.slices.map((slice, sliceIndex) => ({
    id: slice.id,
    lanes: slice.paths.map((lane, laneIndex) => canonicalPlanOwnershipLane(lane, planLaneErrors, `plan.slices[${sliceIndex}].paths[${laneIndex}]`)),
  }));
  if (planLaneErrors.length) fail(planLaneErrors);

  const errors = [];
  for (const [index, fix] of review.remediation_context.fixes.entries()) {
    const fixPath = `review.remediation_context.fixes[${index}]`;
    if (!byId.has(fix.fix_owner)) {
      errors.push({ path: `${fixPath}.fix_owner`, message: `must equal an existing current-plan slice id for slice '${sliceId}'` });
      continue;
    }
    if (fix.scope_effect === "contract-change") continue;
    const ownerSets = fix.likely_paths.map((likelyPath) => ownershipPlan
      .filter((planned) => planned.lanes.some((lane) => planLaneOwnsConcretePath(lane, likelyPath)))
      .map((planned) => planned.id));
    if (fix.scope_effect === "in-lane") {
      if (fix.fix_owner !== sliceId) errors.push({ path: `${fixPath}.fix_owner`, message: `in-lane must be owned by reviewed slice '${sliceId}'` });
      if (ownerSets.some((owners) => owners.length !== 1 || owners[0] !== fix.fix_owner)) {
        errors.push({ path: `${fixPath}.likely_paths`, message: "in-lane paths must each have exactly the reviewed slice as their sole plan owner" });
      }
    } else if (fix.scope_effect === "unowned-extension") {
      if (fix.fix_owner !== sliceId) errors.push({ path: `${fixPath}.fix_owner`, message: `unowned-extension must be owned by reviewed slice '${sliceId}'` });
      if (ownerSets.some((owners) => owners.length !== 0)) {
        errors.push({ path: `${fixPath}.likely_paths`, message: "unowned-extension paths must each have zero plan owners" });
      }
    } else if (fix.scope_effect === "sibling-owned") {
      if (fix.fix_owner === sliceId) errors.push({ path: `${fixPath}.fix_owner`, message: "sibling-owned fix_owner must differ from the reviewed slice" });
      if (ownerSets.some((owners) => owners.length !== 1 || owners[0] !== fix.fix_owner)) {
        errors.push({ path: `${fixPath}.likely_paths`, message: "sibling-owned paths must each have fix_owner as their sole plan owner" });
      }
    }
  }
  if (errors.length) fail(errors);
  return {
    schema_version: 2,
    slice_id: sliceId,
    fixes: review.remediation_context.fixes.map((fix) => ({
      required_fix_index: fix.required_fix_index,
      classification: fix.classification,
      scope_effect: fix.scope_effect,
      likely_paths: [...fix.likely_paths],
      fix_owner: fix.fix_owner,
    })),
  };
}

function validateLikelyRepositoryPaths(errors, paths, path) {
  validateCanonicalConcretePathSet(errors, paths, path, { allowEmpty: false, sorted: false });
}

export function isCanonicalConcreteRepositoryPath(value) {
  return validatePlanPath(value) === value && !value.endsWith("/**");
}

function validateCanonicalConcretePathSet(errors, paths, path, { allowEmpty, sorted }) {
  if (!Array.isArray(paths) || (!allowEmpty && paths.length < 1)) {
    errors.push({ path, message: `${allowEmpty ? "must be an array" : "must be a nonempty array"} of unique canonical concrete repository paths` });
    return;
  }
  const canonical = [];
  for (const [index, value] of paths.entries()) {
    if (!isCanonicalConcreteRepositoryPath(value)) errors.push({ path: `${path}[${index}]`, message: "must be a canonical concrete repository path without globs" });
    else canonical.push(value);
  }
  if (new Set(canonical).size !== canonical.length) errors.push({ path, message: "must contain unique paths" });
  if (sorted && canonical.some((value, index) => index > 0 && canonical[index - 1] >= value)) {
    errors.push({ path, message: "must be sorted by canonical repository path" });
  }
}

function canonicalPlanOwnershipLane(value, errors, path) {
  const canonical = validatePlanPath(value);
  if (canonical === null) {
    errors.push({ path, message: `invalid or ambiguous ownership lane '${safeValidationIdentifier(value)}'` });
    return null;
  }
  const recursive = canonical.endsWith("/**");
  const base = recursive ? canonical.slice(0, -3) : canonical;
  return { base, recursive };
}

function planLaneOwnsConcretePath(lane, concretePath) {
  return lane.recursive ? concretePath.startsWith(`${lane.base}/`) : concretePath === lane.base;
}

export function validateRun(run) {
  const errors = [];
  if (!isRecord(run)) return fail([{ path: "run", message: "must be an object" }]);

  allowedKeys(errors, run, RUN_KEYS, "run");
  requiredInteger(errors, run, "schema_version", "run.schema_version");
  if (run.schema_version !== 1) errors.push({ path: "run.schema_version", message: "must equal 1" });
  requiredString(errors, run, "run_id", "run.run_id");
  optionalEnum(errors, run, "mode", RUN_MODES, "run.mode");
  requiredEnum(errors, run, "status", RUN_STATUSES, "run.status");
  optionalTimestamp(errors, run, "created_at", "run.created_at");
  optionalTimestamp(errors, run, "updated_at", "run.updated_at");
  optionalTimestamp(errors, run, "heartbeat_at", "run.heartbeat_at");
  optionalString(errors, run, "base_ref", "run.base_ref");
  optionalString(errors, run, "base_commit", "run.base_commit");
  optionalString(errors, run, "branch", "run.branch");
  if (run.continuation && run.worktree === run.continuation?.target?.worktree) optionalString(errors, run, "worktree", "run.worktree");
  else optionalAbsolutePath(errors, run, "worktree", "run.worktree");
  optionalNonEmptyString(errors, run, "github_account", "run.github_account");
  optionalEnum(errors, run, "pr_mode", PR_MODES, "run.pr_mode");
  optionalString(errors, run, "pr_url", "run.pr_url");
  optionalInteger(errors, run, "max_parallel_slices", "run.max_parallel_slices");
  optionalInteger(errors, run, "max_retries", "run.max_retries");
  optionalNonEmptyString(errors, run, "review_tier", "run.review_tier");
  validateDebugSnapshot(errors, run.debug_snapshot, "run.debug_snapshot");
  validateProvenance(errors, run.provenance, "run.provenance");
  validateIntegrationAmendmentRecord(errors, run, "run.integration_amendment");
  validateSpecialBuilderDispatch(errors, run.special_builder_dispatch, "run.special_builder_dispatch");
  validateContinuation(errors, run, "run.continuation");
  validateCheckpointSourceRecord(errors, run.checkpoint_source, "run.checkpoint_source");
  validateCheckpointProgressRecord(errors, run.checkpoint_progress, "run.checkpoint_progress");
  if (run.checkpoint_source != null && run.checkpoint_progress != null) errors.push({ path: "run", message: "checkpoint_source and checkpoint_progress are mutually exclusive child and parent records" });
  if (run.checkpoint_progress != null) {
    if (run.status !== "blocked" || run.terminal_result?.status !== "blocked" || run.terminal_result?.reason !== CHECKPOINT_ROUTING_TERMINAL_REASON) {
      errors.push({ path: "run.checkpoint_progress", message: "is allowed only on the blocked checkpoint-routing parent" });
    }
    if (run.checkpoint_progress?.manifest_ref !== run.terminal_result?.artifacts?.checkpoint_routing) {
      errors.push({ path: "run.checkpoint_progress.manifest_ref", message: "must match terminal_result.artifacts.checkpoint_routing" });
    }
  }
  validateSteering(errors, run.steering, "run.steering");
  validatePostPr(errors, run, "run.post_pr");

  validateGateMap(errors, run, "run.gates");
  validateRunSlices(errors, run.slices, "run.slices");
  validateCostAttribution(errors, run.cost_attribution, "run.cost_attribution", run);
  validateSteps(errors, run, "run.steps");
  validateVerdict(errors, run.validator, "run.validator", VALIDATOR_VERDICTS);
  validateVerdict(errors, run.security_review, "run.security_review", SECURITY_VERDICTS);
  validatePanelBindingGeneration(errors, run);
  validateTerminalResult(errors, run, "run.terminal_result");

  if (errors.length) fail(errors);
  return run;
}

export function validateCheckpointConfiguration(value) {
  const errors = [];
  validateCheckpointConfigurationRecord(errors, value, "checkpoint_configuration");
  if (errors.length) fail(errors);
  return value;
}

export function validateCheckpointSource(value) {
  const errors = [];
  validateCheckpointSourceRecord(errors, value, "checkpoint_source", { required: true });
  if (errors.length) fail(errors);
  return value;
}

export function validateCheckpointChildPublication(value) {
  const errors = [];
  validateCheckpointChildPublicationRecord(errors, value, "checkpoint_child_publication");
  if (errors.length) fail(errors);
  return value;
}

export function validateCheckpointProgress(value) {
  const errors = [];
  validateCheckpointProgressRecord(errors, value, "checkpoint_progress", { required: true });
  if (errors.length) fail(errors);
  return value;
}

export function validateDeliveryCheckpointFinalClosure(value) {
  const errors = [];
  validateDeliveryCheckpointFinalClosureRecord(errors, value, "checkpoint_final_closure");
  if (errors.length) fail(errors);
  return value;
}

function validateCheckpointConfigurationRecord(errors, value, path) {
  if (!isRecord(value)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, value, CHECKPOINT_CONFIGURATION_KEYS, path);
  requiredEnum(errors, value, "mode", RUN_MODES, `${path}.mode`);
  if (!Object.hasOwn(value, "github_account") || value.github_account !== null && !stringValue(value.github_account)) errors.push({ path: `${path}.github_account`, message: "must be a non-empty string or null" });
  requiredEnum(errors, value, "pr_mode", PR_MODES, `${path}.pr_mode`);
  boundedInteger(errors, value, "max_parallel_slices", 3, 3, `${path}.max_parallel_slices`);
  boundedInteger(errors, value, "max_retries", 3, 3, `${path}.max_retries`);
  validatePostPrPolicy(errors, value.post_pr_policy, `${path}.post_pr_policy`);
  if (!Object.hasOwn(value, "review_tier") || value.review_tier !== null && !stringValue(value.review_tier)) errors.push({ path: `${path}.review_tier`, message: "must be a non-empty string or null" });
}

function validateCheckpointSourceRecord(errors, value, path, { required = false } = {}) {
  if (value === undefined || value === null) { if (required) errors.push({ path, message: "must be an object" }); return; }
  if (!isRecord(value)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, value, CHECKPOINT_SOURCE_KEYS, path);
  exactCheckpointRecordHeader(errors, value, "delivery-checkpoint-source", path);
  for (const key of ["parent_run_id", "checkpoint_id", "root_child_run_id"]) requiredTerminalSafeString(errors, value, key, `${path}.${key}`);
  boundedInteger(errors, value, "checkpoint_ordinal", 1, Number.MAX_SAFE_INTEGER, `${path}.checkpoint_ordinal`);
  validateCheckpointIdOrdinal(errors, value.checkpoint_id, value.checkpoint_ordinal, `${path}.checkpoint_id`);
  validateCheckpointManifestBinding(errors, value, path);
  requiredString(errors, value, "source_plan_ref", `${path}.source_plan_ref`);
  if (value.source_plan_ref !== PLAN_SLICES_REF) errors.push({ path: `${path}.source_plan_ref`, message: `must equal ${PLAN_SLICES_REF}` });
  requiredHash(errors, value, "source_plan_hash", `${path}.source_plan_hash`);
  requiredString(errors, value, "source_review_ref", `${path}.source_review_ref`);
  validateDurableRef(errors, value.source_review_ref, "reviews", `${path}.source_review_ref`);
  requiredHash(errors, value, "source_review_hash", `${path}.source_review_hash`);
  boundedInteger(errors, value, "source_review_attempt", 1, Number.MAX_SAFE_INTEGER, `${path}.source_review_attempt`);
  for (const key of ["parent_review_identity_hash", "child_disposition_hash", "admission_probe_hash", "brief_scope_hash", "child_plan_hash", "acceptance_mapping_hash"]) requiredHash(errors, value, key, `${path}.${key}`);
  requiredString(errors, value, "initial_base_ref", `${path}.initial_base_ref`);
  if (value.initial_base_ref !== "refs/remotes/origin/main") errors.push({ path: `${path}.initial_base_ref`, message: "must equal refs/remotes/origin/main" });
  requiredFullGitSha(errors, value, "initial_base_commit", `${path}.initial_base_commit`);
}

function validateCheckpointChildPublicationRecord(errors, value, path) {
  if (!isRecord(value)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, value, CHECKPOINT_CHILD_PUBLICATION_KEYS, path);
  exactCheckpointRecordHeader(errors, value, "delivery-checkpoint-child-publication", path);
  for (const key of ["parent_run_id", "checkpoint_id", "child_run_id"]) requiredTerminalSafeString(errors, value, key, `${path}.${key}`);
  boundedInteger(errors, value, "checkpoint_ordinal", 1, Number.MAX_SAFE_INTEGER, `${path}.checkpoint_ordinal`);
  validateCheckpointIdOrdinal(errors, value.checkpoint_id, value.checkpoint_ordinal, `${path}.checkpoint_id`);
  validateCheckpointManifestBinding(errors, value, path);
  requiredString(errors, value, "branch_ref", `${path}.branch_ref`);
  if (stringValue(value.child_run_id) && value.branch_ref !== `refs/heads/${value.child_run_id}`) errors.push({ path: `${path}.branch_ref`, message: "must be the exact child run branch ref" });
  requiredString(errors, value, "worktree", `${path}.worktree`);
  if (!isAbsolute(value.worktree ?? "")) errors.push({ path: `${path}.worktree`, message: "must be absolute" });
  requiredString(errors, value, "remote_main_ref", `${path}.remote_main_ref`);
  if (value.remote_main_ref !== "refs/heads/main") errors.push({ path: `${path}.remote_main_ref`, message: "must equal refs/heads/main" });
  requiredFullGitSha(errors, value, "base_commit", `${path}.base_commit`);
  validateCheckpointPredecessor(errors, value, path, "checkpoint_ordinal");
  requiredTimestamp(errors, value, "reserved_at", `${path}.reserved_at`);
}

function validateCheckpointProgressRecord(errors, value, path, { required = false } = {}) {
  if (value === undefined || value === null) { if (required) errors.push({ path, message: "must be an object" }); return; }
  if (!isRecord(value)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, value, CHECKPOINT_PROGRESS_KEYS, path);
  exactCheckpointRecordHeader(errors, value, "delivery-checkpoint-progress", path);
  validateCheckpointManifestBinding(errors, value, path);
  requiredEnum(errors, value, "status", new Set(["active", "closed"]), `${path}.status`);
  if (!Array.isArray(value.entries)) errors.push({ path: `${path}.entries`, message: "must be an array" });
  else {
    for (const [index, entry] of value.entries.entries()) validateCheckpointProgressEntry(errors, entry, `${path}.entries[${index}]`, index, value.entries);
  }
  if (value.final_closure === null) {
    if (value.status === "closed") errors.push({ path: `${path}.final_closure`, message: "must be present when status is closed" });
  } else validateCheckpointProgressFinalClosure(errors, value.final_closure, `${path}.final_closure`);
  if (value.status === "active" && value.final_closure !== null) errors.push({ path: `${path}.final_closure`, message: "must be null while status is active" });
  if (value.status === "closed" && Array.isArray(value.entries) && (value.entries.length === 0 || value.entries.some((entry) => entry?.state !== "merged"))) errors.push({ path: `${path}.entries`, message: "must be nonempty and entirely merged when status is closed" });
}

function validateCheckpointProgressEntry(errors, entry, path, index, entries) {
  if (!isRecord(entry)) { errors.push({ path, message: "must be an object" }); return; }
  const keys = CHECKPOINT_PROGRESS_ENTRY_KEYS[entry.state] ?? CHECKPOINT_PROGRESS_ENTRY_COMMON_KEYS;
  allowedKeys(errors, entry, keys, path);
  requiredEnum(errors, entry, "state", new Set(Object.keys(CHECKPOINT_PROGRESS_ENTRY_KEYS)), `${path}.state`);
  for (const key of ["checkpoint_id", "root_child_run_id", "branch"]) requiredTerminalSafeString(errors, entry, key, `${path}.${key}`);
  boundedInteger(errors, entry, "ordinal", 1, Number.MAX_SAFE_INTEGER, `${path}.ordinal`);
  if (entry.ordinal !== index + 1) errors.push({ path: `${path}.ordinal`, message: "must be contiguous and equal its one-based entry position" });
  validateCheckpointIdOrdinal(errors, entry.checkpoint_id, entry.ordinal, `${path}.checkpoint_id`);
  if (stringValue(entry.root_child_run_id) && entry.branch !== entry.root_child_run_id) errors.push({ path: `${path}.branch`, message: "must equal root_child_run_id" });
  requiredString(errors, entry, "worktree", `${path}.worktree`);
  if (!isAbsolute(entry.worktree ?? "")) errors.push({ path: `${path}.worktree`, message: "must be absolute" });
  requiredString(errors, entry, "base_ref", `${path}.base_ref`);
  if (entry.base_ref !== "refs/remotes/origin/main") errors.push({ path: `${path}.base_ref`, message: "must equal refs/remotes/origin/main" });
  requiredFullGitSha(errors, entry, "base_commit", `${path}.base_commit`);
  validateCheckpointPredecessor(errors, entry, path, "ordinal", entries[index - 1]);
  validateCheckpointConfigurationRecord(errors, entry.configuration, `${path}.configuration`);
  requiredString(errors, entry, "publication_claim_ref", `${path}.publication_claim_ref`);
  if (stringValue(entry.root_child_run_id)) {
    const digest = createHash("sha256").update(entry.root_child_run_id, "utf8").digest("hex");
    if (entry.publication_claim_ref !== `refs/opencode/checkpoint-publications/${digest}`) errors.push({ path: `${path}.publication_claim_ref`, message: "must be the exact child publication claim ref" });
  }
  requiredFullGitSha(errors, entry, "publication_claim_oid", `${path}.publication_claim_oid`);
  requiredTimestamp(errors, entry, "reserved_at", `${path}.reserved_at`);
  if (["child-published", "launched", "merged"].includes(entry.state)) {
    for (const key of ["child_run_hash", "child_plan_hash", "brief_scope_hash"]) requiredHash(errors, entry, key, `${path}.${key}`);
    requiredTimestamp(errors, entry, "published_at", `${path}.published_at`);
    validateTimestampOrder(errors, entry.reserved_at, entry.published_at, `${path}.published_at`, "must not precede reserved_at");
  }
  if (["launched", "merged"].includes(entry.state)) {
    requiredTimestamp(errors, entry, "launched_at", `${path}.launched_at`);
    validateTimestampOrder(errors, entry.published_at, entry.launched_at, `${path}.launched_at`, "must not precede published_at");
  }
  if (entry.state === "merged") validateCheckpointMergedCompletion(errors, entry, path);
  if (index < entries.length - 1 && entry.state !== "merged") errors.push({ path: `${path}.state`, message: "must be merged before a later checkpoint entry exists" });
}

function validateCheckpointMergedCompletion(errors, entry, path) {
  for (const key of ["completed_child_run_id"]) requiredTerminalSafeString(errors, entry, key, `${path}.${key}`);
  for (const key of ["completed_child_run_hash", "checkpoint_source_hash", "configuration_hash"]) requiredHash(errors, entry, key, `${path}.${key}`);
  validateCheckpointLineage(errors, entry.lineage, `${path}.lineage`, entry.root_child_run_id, entry.completed_child_run_id);
  validateCheckpointPullRequest(errors, entry.pull_request, `${path}.pull_request`, entry.completed_child_run_id);
  validateCheckpointRemoteMain(errors, entry.remote_main, `${path}.remote_main`);
  requiredTimestamp(errors, entry, "merged_at", `${path}.merged_at`);
  validateTimestampOrder(errors, entry.launched_at, entry.merged_at, `${path}.merged_at`, "must not precede launched_at");
  validateTimestampOrder(errors, entry.remote_main?.observed_at, entry.merged_at, `${path}.merged_at`, "must not precede remote_main.observed_at");
}

function validateCheckpointLineage(errors, lineage, path, rootRunId, completedRunId) {
  if (!Array.isArray(lineage) || lineage.length === 0) { errors.push({ path, message: "must be a nonempty root-to-leaf array" }); return; }
  const seen = new Set();
  for (const [index, row] of lineage.entries()) {
    const rowPath = `${path}[${index}]`;
    if (!isRecord(row)) { errors.push({ path: rowPath, message: "must be an object" }); continue; }
    allowedKeys(errors, row, CHECKPOINT_LINEAGE_KEYS, rowPath);
    requiredTerminalSafeString(errors, row, "run_id", `${rowPath}.run_id`);
    requiredHash(errors, row, "run_hash", `${rowPath}.run_hash`);
    if (seen.has(row.run_id)) errors.push({ path: `${rowPath}.run_id`, message: "must be unique and acyclic" });
    seen.add(row.run_id);
    if (index === 0) {
      if (row.run_id !== rootRunId) errors.push({ path: `${rowPath}.run_id`, message: "must equal root_child_run_id" });
      for (const key of ["parent_run_id", "continuation_claim_ref", "continuation_claim_oid"]) if (row[key] !== null) errors.push({ path: `${rowPath}.${key}`, message: "must be null for the root lineage row" });
    } else {
      requiredString(errors, row, "parent_run_id", `${rowPath}.parent_run_id`);
      if (row.parent_run_id !== lineage[index - 1]?.run_id) errors.push({ path: `${rowPath}.parent_run_id`, message: "must equal the prior lineage run_id" });
      requiredString(errors, row, "continuation_claim_ref", `${rowPath}.continuation_claim_ref`);
      if (stringValue(row.continuation_claim_ref) && !/^refs\/opencode\/continuation-targets\/[0-9a-f]{64}$/u.test(row.continuation_claim_ref)) errors.push({ path: `${rowPath}.continuation_claim_ref`, message: "must be a continuation target claim ref" });
      requiredFullGitSha(errors, row, "continuation_claim_oid", `${rowPath}.continuation_claim_oid`);
    }
  }
  if (lineage.at(-1)?.run_id !== completedRunId) errors.push({ path: `${path}[${lineage.length - 1}].run_id`, message: "must equal completed_child_run_id" });
}

function validateCheckpointPullRequest(errors, value, path, completedRunId) {
  if (!isRecord(value)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, value, CHECKPOINT_PULL_REQUEST_KEYS, path);
  requiredString(errors, value, "pr_url", `${path}.pr_url`);
  boundedInteger(errors, value, "pr_number", 1, Number.MAX_SAFE_INTEGER, `${path}.pr_number`);
  requiredString(errors, value, "pr_node_id", `${path}.pr_node_id`);
  requiredPrOperationIdentity(errors, value, path);
  requiredFullGitSha(errors, value, "merge_commit", `${path}.merge_commit`);
  if (value.base_ref !== "main") errors.push({ path: `${path}.base_ref`, message: "must equal main" });
  if (stringValue(completedRunId) && value.head_ref !== completedRunId) errors.push({ path: `${path}.head_ref`, message: "must equal completed_child_run_id" });
  try {
    const parts = githubPrUrlParts(value.pr_url);
    if (parts.number !== value.pr_number) errors.push({ path: `${path}.pr_number`, message: "must match pr_url pull request number" });
    if (parts.repository !== value.repository) errors.push({ path: `${path}.repository`, message: "must match pr_url repository" });
  } catch { errors.push({ path: `${path}.pr_url`, message: "must be a canonical GitHub pull request URL" }); }
}

function validateCheckpointRemoteMain(errors, value, path) {
  if (!isRecord(value)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, value, CHECKPOINT_REMOTE_MAIN_KEYS, path);
  requiredString(errors, value, "ref", `${path}.ref`);
  if (value.ref !== "refs/heads/main") errors.push({ path: `${path}.ref`, message: "must equal refs/heads/main" });
  requiredFullGitSha(errors, value, "commit", `${path}.commit`);
  requiredTimestamp(errors, value, "observed_at", `${path}.observed_at`);
}

function validateCheckpointProgressFinalClosure(errors, value, path) {
  if (!isRecord(value)) { errors.push({ path, message: "must be an object or null" }); return; }
  allowedKeys(errors, value, CHECKPOINT_PROGRESS_FINAL_CLOSURE_KEYS, path);
  requiredString(errors, value, "ref", `${path}.ref`);
  validateDurableRef(errors, value.ref, "artifacts", `${path}.ref`);
  requiredHash(errors, value, "hash", `${path}.hash`);
  requiredTimestamp(errors, value, "closed_at", `${path}.closed_at`);
}

function validateDeliveryCheckpointFinalClosureRecord(errors, value, path) {
  if (!isRecord(value)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, value, CHECKPOINT_CLOSURE_KEYS, path);
  exactCheckpointRecordHeader(errors, value, "delivery-checkpoint-final-closure", path);
  requiredTerminalSafeString(errors, value, "parent_run_id", `${path}.parent_run_id`);
  requiredHash(errors, value, "parent_run_hash", `${path}.parent_run_hash`);
  validateCheckpointManifestBinding(errors, value, path);
  requiredString(errors, value, "source_plan_ref", `${path}.source_plan_ref`);
  if (value.source_plan_ref !== PLAN_SLICES_REF) errors.push({ path: `${path}.source_plan_ref`, message: `must equal ${PLAN_SLICES_REF}` });
  requiredHash(errors, value, "source_plan_hash", `${path}.source_plan_hash`);
  requiredString(errors, value, "source_review_ref", `${path}.source_review_ref`);
  validateDurableRef(errors, value.source_review_ref, "reviews", `${path}.source_review_ref`);
  requiredHash(errors, value, "source_review_hash", `${path}.source_review_hash`);
  boundedInteger(errors, value, "source_review_attempt", 1, Number.MAX_SAFE_INTEGER, `${path}.source_review_attempt`);
  for (const key of ["parent_review_identity_hash", "admission_probe_hash"]) requiredHash(errors, value, key, `${path}.${key}`);
  if (!Array.isArray(value.checkpoints) || value.checkpoints.length === 0) errors.push({ path: `${path}.checkpoints`, message: "must be a nonempty array" });
  else value.checkpoints.forEach((entry, index) => validateCheckpointClosureEntry(errors, entry, `${path}.checkpoints[${index}]`, index));
  validateCheckpointRemoteMain(errors, value.remote_main, `${path}.remote_main`);
  requiredTimestamp(errors, value, "closed_at", `${path}.closed_at`);
  validateTimestampOrder(errors, value.remote_main?.observed_at, value.closed_at, `${path}.closed_at`, "must not precede remote_main.observed_at");
}

function validateCheckpointClosureEntry(errors, value, path, index) {
  if (!isRecord(value)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, value, CHECKPOINT_CLOSURE_ENTRY_KEYS, path);
  requiredTerminalSafeString(errors, value, "checkpoint_id", `${path}.checkpoint_id`);
  boundedInteger(errors, value, "ordinal", 1, Number.MAX_SAFE_INTEGER, `${path}.ordinal`);
  if (value.ordinal !== index + 1) errors.push({ path: `${path}.ordinal`, message: "must be contiguous and equal its one-based checkpoint position" });
  validateCheckpointIdOrdinal(errors, value.checkpoint_id, value.ordinal, `${path}.checkpoint_id`);
  for (const key of ["root_child_run_id", "completed_child_run_id"]) requiredTerminalSafeString(errors, value, key, `${path}.${key}`);
  for (const key of ["child_plan_hash", "brief_scope_hash", "completed_child_run_hash", "checkpoint_source_hash", "configuration_hash"]) requiredHash(errors, value, key, `${path}.${key}`);
  validateCheckpointConfigurationRecord(errors, value.configuration, `${path}.configuration`);
  validateCheckpointLineage(errors, value.lineage, `${path}.lineage`, value.root_child_run_id, value.completed_child_run_id);
  validateCheckpointPullRequest(errors, value.pull_request, `${path}.pull_request`, value.completed_child_run_id);
  requiredTimestamp(errors, value, "merged_at", `${path}.merged_at`);
}

function exactCheckpointRecordHeader(errors, value, kind, path) {
  requiredInteger(errors, value, "schema_version", `${path}.schema_version`);
  if (value.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  requiredEnum(errors, value, "kind", new Set([kind]), `${path}.kind`);
}

function validateCheckpointManifestBinding(errors, value, path) {
  requiredString(errors, value, "manifest_ref", `${path}.manifest_ref`);
  requiredHash(errors, value, "manifest_hash", `${path}.manifest_hash`);
  if (!/^artifacts\/checkpoint-routing-[0-9a-f]{64}\.json$/u.test(value.manifest_ref ?? "")) errors.push({ path: `${path}.manifest_ref`, message: "must be a content-addressed checkpoint routing artifact ref" });
  if (HASH_PATTERN.test(value.manifest_hash ?? "") && value.manifest_ref !== `artifacts/checkpoint-routing-${value.manifest_hash.slice("sha256:".length)}.json`) errors.push({ path: `${path}.manifest_ref`, message: "must match manifest_hash" });
}

function validateCheckpointIdOrdinal(errors, checkpointId, ordinal, path) {
  if (Number.isInteger(ordinal) && ordinal > 0 && checkpointId !== `checkpoint-${String(ordinal).padStart(3, "0")}`) errors.push({ path, message: "must match its checkpoint ordinal" });
}

function validateCheckpointPredecessor(errors, value, path, ordinalKey, previousEntry) {
  const ordinal = value[ordinalKey];
  for (const key of ["predecessor_checkpoint_id", "predecessor_completed_run_id", "predecessor_merge_commit"]) if (!Object.hasOwn(value, key)) errors.push({ path: `${path}.${key}`, message: "is required" });
  if (ordinal === 1) {
    for (const key of ["predecessor_checkpoint_id", "predecessor_completed_run_id", "predecessor_merge_commit"]) if (value[key] !== null) errors.push({ path: `${path}.${key}`, message: "must be null for checkpoint ordinal 1" });
  } else if (Number.isInteger(ordinal) && ordinal > 1) {
    requiredString(errors, value, "predecessor_checkpoint_id", `${path}.predecessor_checkpoint_id`);
    requiredString(errors, value, "predecessor_completed_run_id", `${path}.predecessor_completed_run_id`);
    requiredFullGitSha(errors, value, "predecessor_merge_commit", `${path}.predecessor_merge_commit`);
    if (value.predecessor_checkpoint_id !== `checkpoint-${String(ordinal - 1).padStart(3, "0")}`) errors.push({ path: `${path}.predecessor_checkpoint_id`, message: "must identify the immediately prior checkpoint" });
    if (previousEntry) {
      if (previousEntry.state !== "merged") errors.push({ path, message: "requires the immediately prior checkpoint to be merged" });
      if (value.predecessor_completed_run_id !== previousEntry.completed_child_run_id) errors.push({ path: `${path}.predecessor_completed_run_id`, message: "must equal the prior merged completed_child_run_id" });
      if (value.predecessor_merge_commit !== previousEntry.pull_request?.merge_commit) errors.push({ path: `${path}.predecessor_merge_commit`, message: "must equal the prior merged pull request commit" });
    }
  }
}

function validateTimestampOrder(errors, earlier, later, path, message) {
  if (isIsoTimestamp(earlier) && isIsoTimestamp(later) && Date.parse(later) < Date.parse(earlier)) errors.push({ path, message });
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
  allowedKeys(errors, plan, PLAN_KEYS, "plan");
  if (!Array.isArray(plan.slices)) errors.push({ path: "plan.slices", message: "must be an array" });
  else validatePlannedSlices(errors, plan.slices, "plan.slices", { enforceDependencyDepth });
  validateIntegrationGate(errors, plan.integration_gate, "plan.integration_gate", { required: true, requireExecutionTimeouts: true });
  if (plan.delivery_envelope === undefined) {
    errors.push({ path: "plan.delivery_envelope", message: "is required" });
  } else {
    appendDeliveryContractErrors(errors, () => validateDeliveryEnvelope(plan.delivery_envelope, plan.slices, { plan, requireExecutionTimeouts: true }));
  }
  if (plan.delivery_envelope?.checkpoint_plan !== undefined) {
    try { validateReviewedCheckpointPlan(plan); }
    catch (error) { errors.push({ path: "plan.delivery_envelope.checkpoint_plan", message: error.message }); }
  }
  if (plan.integration_gate !== undefined && plan.delivery_envelope !== undefined) {
    appendDeliveryContractErrors(errors, () => validateAdmissionExtensionResult(evaluateDeliveryEnvelopeAdmission({ plan })));
  }
  if (errors.length) fail(errors);
  return plan;
}

function appendDeliveryContractErrors(errors, operation) {
  try {
    operation();
  } catch (error) {
    if (error instanceof DeliveryContractValidationError) errors.push(...error.errors);
    else throw error;
  }
}

export function parseSlicesPlanBytes(bytes, { label = PLAN_SLICES_REF, ...validationOptions } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError(`${label} bytes must be a Uint8Array`);
  let text;
  try {
    text = FATAL_UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error(`${label} must contain valid UTF-8`);
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
  return validateSlicesPlan(plan, validationOptions);
}

export function validateTestExecutionReceipt(receipt) {
  const errors = [];
  if (!isRecord(receipt)) return fail([{ path: "receipt", message: "must be an object" }]);
  allowedKeys(errors, receipt, TEST_EXECUTION_RECEIPT_KEYS, "receipt");
  requiredInteger(errors, receipt, "schema_version", "receipt.schema_version");
  if (receipt.schema_version !== 1) errors.push({ path: "receipt.schema_version", message: "must equal 1" });
  requiredString(errors, receipt, "kind", "receipt.kind");
  if (receipt.kind !== "checked-test-execution-receipt") errors.push({ path: "receipt.kind", message: "must equal checked-test-execution-receipt" });
  requiredString(errors, receipt, "subject", "receipt.subject");
  if (receipt.subject !== "test-verifier") errors.push({ path: "receipt.subject", message: "must equal test-verifier" });
  requiredString(errors, receipt, "run_id", "receipt.run_id");
  boundedInteger(errors, receipt, "attempt", 1, Number.MAX_SAFE_INTEGER, "receipt.attempt");
  requiredString(errors, receipt, "claim_nonce", "receipt.claim_nonce");
  if (!isUuidV4(receipt.claim_nonce)) errors.push({ path: "receipt.claim_nonce", message: "must be a UUID v4" });
  requiredString(errors, receipt, "plan_ref", "receipt.plan_ref");
  if (receipt.plan_ref !== PLAN_SLICES_REF) errors.push({ path: "receipt.plan_ref", message: `must equal ${PLAN_SLICES_REF}` });
  requiredHash(errors, receipt, "plan_hash", "receipt.plan_hash");
  requiredFullGitSha(errors, receipt, "head_sha", "receipt.head_sha");
  optionalCheckedExecutionTimeout(errors, receipt, "receipt.timeout_ms");
  requiredTimestamp(errors, receipt, "started_at", "receipt.started_at");
  requiredTimestamp(errors, receipt, "completed_at", "receipt.completed_at");
  boundedInteger(errors, receipt, "duration_ms", 0, Number.MAX_SAFE_INTEGER, "receipt.duration_ms");
  requiredEnum(errors, receipt, "status", TEST_EXECUTION_STATUSES, "receipt.status");
  if (typeof receipt.review_ready !== "boolean") errors.push({ path: "receipt.review_ready", message: "must be a boolean" });
  if (!Array.isArray(receipt.commands) || receipt.commands.length < 1 || receipt.commands.length > MAX_INTEGRATION_GATE_COMMANDS) {
    errors.push({ path: "receipt.commands", message: `must contain 1-${MAX_INTEGRATION_GATE_COMMANDS} command results` });
  } else {
    receipt.commands.forEach((result, index) => validateTestExecutionCommandResult(errors, result, index));
    const passing = receipt.commands.every((result) => result?.outcome === "exited" && result?.exit_code === 0 && result?.signal === null && result?.status === "pass");
    if (receipt.status !== (passing ? "pass" : "fail")) errors.push({ path: "receipt.status", message: "must equal the aggregate command result status" });
    if (receipt.review_ready !== passing) errors.push({ path: "receipt.review_ready", message: "must equal true exactly when every command passes" });
  }
  if (Number.isFinite(Date.parse(receipt.started_at || "")) && Number.isFinite(Date.parse(receipt.completed_at || ""))
    && Date.parse(receipt.completed_at) < Date.parse(receipt.started_at)) errors.push({ path: "receipt.completed_at", message: "must not precede started_at" });
  if (errors.length) fail(errors);
  return receipt;
}

export function validateVerificationArtifactExecutionReceipt(receipt) {
  const errors = [];
  if (!isRecord(receipt)) return fail([{ path: "receipt", message: "must be an object" }]);
  allowedKeys(errors, receipt, VERIFICATION_ARTIFACT_RECEIPT_KEYS, "receipt");
  requiredInteger(errors, receipt, "schema_version", "receipt.schema_version");
  if (receipt.schema_version !== 1) errors.push({ path: "receipt.schema_version", message: "must equal 1" });
  requiredString(errors, receipt, "kind", "receipt.kind");
  if (receipt.kind !== "checked-verification-artifact-execution-receipt") errors.push({ path: "receipt.kind", message: "must equal checked-verification-artifact-execution-receipt" });
  requiredString(errors, receipt, "subject", "receipt.subject");
  requiredString(errors, receipt, "slice_id", "receipt.slice_id");
  if (stringValue(receipt.subject) && stringValue(receipt.slice_id) && receipt.subject !== receipt.slice_id) errors.push({ path: "receipt.subject", message: "must equal receipt.slice_id" });
  requiredString(errors, receipt, "run_id", "receipt.run_id");
  boundedInteger(errors, receipt, "attempt", 1, Number.MAX_SAFE_INTEGER, "receipt.attempt");
  requiredString(errors, receipt, "claim_nonce", "receipt.claim_nonce");
  if (!isUuidV4(receipt.claim_nonce)) errors.push({ path: "receipt.claim_nonce", message: "must be a UUID v4" });
  requiredString(errors, receipt, "plan_ref", "receipt.plan_ref");
  if (receipt.plan_ref !== PLAN_SLICES_REF) errors.push({ path: "receipt.plan_ref", message: `must equal ${PLAN_SLICES_REF}` });
  requiredHash(errors, receipt, "plan_hash", "receipt.plan_hash");
  requiredFullGitSha(errors, receipt, "head_sha", "receipt.head_sha");
  optionalCheckedExecutionTimeout(errors, receipt, "receipt.timeout_ms");
  requiredString(errors, receipt, "verification_artifact_id", "receipt.verification_artifact_id");
  requiredTimestamp(errors, receipt, "started_at", "receipt.started_at");
  requiredTimestamp(errors, receipt, "completed_at", "receipt.completed_at");
  boundedInteger(errors, receipt, "duration_ms", 0, Number.MAX_SAFE_INTEGER, "receipt.duration_ms");
  requiredEnum(errors, receipt, "status", new Set(["pass", "fail", "skipped"]), "receipt.status");
  if (typeof receipt.review_ready !== "boolean") errors.push({ path: "receipt.review_ready", message: "must be a boolean" });

  validateVerificationArtifactProbe(errors, receipt.probe, receipt.verification_artifact_id, "receipt.probe");
  if (!isRecord(receipt.result)) errors.push({ path: "receipt.result", message: "must be an object" });
  else {
    allowedKeys(errors, receipt.result, VERIFICATION_ARTIFACT_RESULT_KEYS, "receipt.result");
    if (receipt.result.type !== "verification-result") errors.push({ path: "receipt.result.type", message: "must equal verification-result" });
    requiredEnum(errors, receipt.result, "outcome", new Set(["pass", "fail", "skipped"]), "receipt.result.outcome");
    requiredString(errors, receipt.result, "summary", "receipt.result.summary");
    if (receipt.result.outcome !== receipt.status) errors.push({ path: "receipt.result.outcome", message: "must equal receipt.status" });
  }
  if (!Array.isArray(receipt.commands)) errors.push({ path: "receipt.commands", message: "must be an array" });
  else if (receipt.status === "skipped") {
    if (receipt.commands.length !== 0 || receipt.review_ready !== false) errors.push({ path: "receipt.commands", message: "skipped requires zero commands and review_ready false" });
  } else {
    if (receipt.commands.length !== 1) errors.push({ path: "receipt.commands", message: "pass or fail requires exactly one command result" });
    else {
      validateTestExecutionCommandResult(errors, receipt.commands[0], 0);
      if (receipt.commands[0]?.program !== receipt.probe?.program) {
        errors.push({ path: "receipt.commands[0].program", message: "must equal receipt.probe.program" });
      }
      if (JSON.stringify(receipt.commands[0]?.args) !== JSON.stringify(receipt.probe?.args)) {
        errors.push({ path: "receipt.commands[0].args", message: "must equal receipt.probe.args" });
      }
    }
    const passing = receipt.commands.length === 1 && receipt.commands[0]?.outcome === "exited" && receipt.commands[0]?.exit_code === 0 && receipt.commands[0]?.signal === null && receipt.commands[0]?.status === "pass";
    if (receipt.status !== (passing ? "pass" : "fail")) errors.push({ path: "receipt.status", message: "must equal the observed command result status" });
    if (receipt.review_ready !== passing) errors.push({ path: "receipt.review_ready", message: "must equal true exactly for an observed passing command" });
  }
  if (Number.isFinite(Date.parse(receipt.started_at || "")) && Number.isFinite(Date.parse(receipt.completed_at || ""))
    && Date.parse(receipt.completed_at) < Date.parse(receipt.started_at)) errors.push({ path: "receipt.completed_at", message: "must not precede started_at" });
  if (errors.length) fail(errors);
  return receipt;
}

export function validateVerificationArtifactExecutionClaim(claim) {
  const errors = [];
  if (!isRecord(claim)) return fail([{ path: "claim", message: "must be an object" }]);
  const keys = claim.state === "completed" ? VERIFICATION_ARTIFACT_CLAIM_COMPLETED_KEYS
    : claim.state === "unknown" ? VERIFICATION_ARTIFACT_CLAIM_UNKNOWN_KEYS : VERIFICATION_ARTIFACT_CLAIM_COMMON_KEYS;
  allowedKeys(errors, claim, keys, "claim");
  requiredInteger(errors, claim, "schema_version", "claim.schema_version");
  if (claim.schema_version !== 1) errors.push({ path: "claim.schema_version", message: "must equal 1" });
  requiredEnum(errors, claim, "kind", new Set(["checked-verification-artifact-execution-claim"]), "claim.kind");
  requiredEnum(errors, claim, "state", new Set(["active", "completed", "unknown"]), "claim.state");
  requiredString(errors, claim, "nonce", "claim.nonce");
  if (!isUuidV4(claim.nonce)) errors.push({ path: "claim.nonce", message: "must be a UUID v4" });
  for (const key of ["run_id", "slice_id", "plan_ref", "verification_artifact_id", "receipt_ref"]) requiredString(errors, claim, key, `claim.${key}`);
  if (typeof claim.receipt_ref === "string" && (!/^evidence\/[A-Za-z0-9._-]+\.json$/u.test(claim.receipt_ref) || claim.receipt_ref.includes(".."))) errors.push({ path: "claim.receipt_ref", message: "must be a safe evidence JSON ref" });
  boundedInteger(errors, claim, "attempt", 1, Number.MAX_SAFE_INTEGER, "claim.attempt");
  if (claim.plan_ref !== PLAN_SLICES_REF) errors.push({ path: "claim.plan_ref", message: `must equal ${PLAN_SLICES_REF}` });
  requiredHash(errors, claim, "plan_hash", "claim.plan_hash");
  requiredFullGitSha(errors, claim, "head_sha", "claim.head_sha");
  optionalCheckedExecutionTimeout(errors, claim, "claim.timeout_ms");
  requiredTimestamp(errors, claim, "claimed_at", "claim.claimed_at");
  validateVerificationArtifactProbe(errors, claim.probe, claim.verification_artifact_id, "claim.probe");
  if (claim.state === "completed") {
    requiredTimestamp(errors, claim, "completed_at", "claim.completed_at");
    requiredEnum(errors, claim, "status", new Set(["pass", "fail"]), "claim.status");
    requiredHash(errors, claim, "receipt_hash", "claim.receipt_hash");
  } else if (claim.state === "unknown") {
    requiredTimestamp(errors, claim, "failed_at", "claim.failed_at");
    requiredEnum(errors, claim, "reason", new Set(["process-outcome-indeterminate", "receipt-publication-indeterminate"]), "claim.reason");
    const hasReceipt = claim.receipt_hash !== undefined || claim.status !== undefined;
    if (hasReceipt) {
      requiredHash(errors, claim, "receipt_hash", "claim.receipt_hash");
      requiredEnum(errors, claim, "status", new Set(["pass", "fail"]), "claim.status");
    }
  }
  if (errors.length) fail(errors);
  return claim;
}

function validateVerificationArtifactProbe(errors, probe, artifactId, path) {
  if (!isRecord(probe)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  allowedKeys(errors, probe, VERIFICATION_ARTIFACT_PROBE_KEYS, path);
  if (probe.type !== "verification-artifact") errors.push({ path: `${path}.type`, message: "must equal verification-artifact" });
  requiredString(errors, probe, "verification_artifact_id", `${path}.verification_artifact_id`);
  if (probe.verification_artifact_id !== artifactId) errors.push({ path: `${path}.verification_artifact_id`, message: `must equal ${path.startsWith("receipt.") ? "receipt" : "claim"}.verification_artifact_id` });
  boundedInteger(errors, probe, "test_plan_index", 0, Number.MAX_SAFE_INTEGER, `${path}.test_plan_index`);
  requiredString(errors, probe, "test_plan_entry", `${path}.test_plan_entry`);
  validateIntegrationProgram(errors, probe.program, `${path}.program`);
  validateIntegrationArgs(errors, probe.args, `${path}.args`);
}

function validateTestExecutionCommandResult(errors, result, index) {
  const path = `receipt.commands[${index}]`;
  if (!isRecord(result)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, result, TEST_EXECUTION_COMMAND_RESULT_KEYS, path);
  boundedInteger(errors, result, "index", 0, MAX_INTEGRATION_GATE_COMMANDS - 1, `${path}.index`);
  if (result.index !== index) errors.push({ path: `${path}.index`, message: "must equal its ordered command position" });
  validateIntegrationProgram(errors, result.program, `${path}.program`);
  validateIntegrationArgs(errors, result.args, `${path}.args`);
  requiredEnum(errors, result, "outcome", TEST_EXECUTION_OUTCOMES, `${path}.outcome`);
  requiredEnum(errors, result, "status", TEST_EXECUTION_STATUSES, `${path}.status`);
  requireNullableProperty(errors, result, "exit_code", `${path}.exit_code`, (value) => Number.isInteger(value) && value >= 0 && value <= 255, "must be null or an integer from 0 through 255");
  requireNullableProperty(errors, result, "signal", `${path}.signal`, (value) => typeof value === "string" && SIGNAL_PATTERN.test(value), "must be null or a bounded signal name");
  requireNullableProperty(errors, result, "error_code", `${path}.error_code`, (value) => value === "spawn-failed", "must be null or spawn-failed");
  boundedInteger(errors, result, "duration_ms", 0, Number.MAX_SAFE_INTEGER, `${path}.duration_ms`);
  validateTestExecutionStream(errors, result.stdout, `${path}.stdout`);
  validateTestExecutionStream(errors, result.stderr, `${path}.stderr`);
  if (result.outcome === "exited") {
    if (!Number.isInteger(result.exit_code) || result.exit_code < 0 || result.exit_code > 255 || result.signal !== null || result.error_code !== null) errors.push({ path, message: "exited requires an exit code and null signal/error_code" });
    if (result.status !== (result.exit_code === 0 ? "pass" : "fail")) errors.push({ path: `${path}.status`, message: "must reflect the exited code" });
  } else if (result.outcome === "signaled") {
    if (result.exit_code !== null || !SIGNAL_PATTERN.test(String(result.signal || "")) || result.error_code !== null || result.status !== "fail") errors.push({ path, message: "signaled requires a signal, null exit/error, and fail status" });
  } else if (result.outcome === "timeout" || result.outcome === "output-limit") {
    if (result.exit_code !== null || result.signal !== "SIGKILL" || result.error_code !== null || result.status !== "fail") errors.push({ path, message: `${result.outcome} requires SIGKILL, null exit/error, and fail status` });
    if (result.outcome === "output-limit" && result.stdout?.truncated !== true && result.stderr?.truncated !== true) errors.push({ path, message: "output-limit requires a truncated stream" });
  } else if (result.outcome === "launch-error") {
    if (result.exit_code !== null || result.signal !== null || result.error_code !== "spawn-failed" || result.status !== "fail") errors.push({ path, message: "launch-error requires spawn-failed and null exit/signal" });
  }
}

function validateTestExecutionStream(errors, stream, path) {
  if (!isRecord(stream)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, stream, TEST_EXECUTION_STREAM_KEYS, path);
  boundedInteger(errors, stream, "captured_bytes", 0, TEST_EXECUTION_STREAM_LIMIT_BYTES, `${path}.captured_bytes`);
  requiredHash(errors, stream, "sha256", `${path}.sha256`);
  if (typeof stream.truncated !== "boolean") errors.push({ path: `${path}.truncated`, message: "must be a boolean" });
}

function requireNullableProperty(errors, value, key, path, predicate, message) {
  if (!Object.hasOwn(value, key)) { errors.push({ path, message: "is required" }); return; }
  if (value[key] !== null && !predicate(value[key])) errors.push({ path, message });
}

function validateIntegrationGate(errors, gate, path = "plan.integration_gate", { required = true, requireExecutionTimeouts = false } = {}) {
  if (gate === undefined) {
    if (required) errors.push({ path, message: "is required" });
    return;
  }
  if (!isRecord(gate)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  allowedKeys(errors, gate, INTEGRATION_GATE_KEYS, path);
  if (requireExecutionTimeouts && gate.timeout_ms === undefined) errors.push({ path: `${path}.timeout_ms`, message: "is required" });
  else optionalCheckedExecutionTimeout(errors, gate, `${path}.timeout_ms`);
  const commands = gate.required_commands;
  if (!Array.isArray(commands)) {
    errors.push({ path: `${path}.required_commands`, message: "must be an array" });
    return;
  }
  if (commands.length < 1 || commands.length > MAX_INTEGRATION_GATE_COMMANDS) {
    errors.push({ path: `${path}.required_commands`, message: `must contain 1-${MAX_INTEGRATION_GATE_COMMANDS} commands` });
  }
  let finalCommandCount = 0;
  for (const [index, command] of commands.entries()) {
    const commandPath = `${path}.required_commands[${index}]`;
    if (!isRecord(command)) {
      errors.push({ path: commandPath, message: "must be an object" });
      continue;
    }
    allowedKeys(errors, command, INTEGRATION_GATE_COMMAND_KEYS, commandPath);
    validateIntegrationProgram(errors, command.program, `${commandPath}.program`);
    validateIntegrationArgs(errors, command.args, `${commandPath}.args`);
    if (sameIntegrationCommand(command, REQUIRED_FINAL_INTEGRATION_COMMAND)) finalCommandCount += 1;
  }
  if (Buffer.byteLength(JSON.stringify(commands), "utf8") > MAX_INTEGRATION_GATE_ENCODED_BYTES) {
    errors.push({ path: `${path}.required_commands`, message: `encoded command list must be at most ${MAX_INTEGRATION_GATE_ENCODED_BYTES} UTF-8 bytes` });
  }
  if (finalCommandCount !== 1) {
    errors.push({ path: `${path}.required_commands`, message: "must contain exactly one npm run check command" });
  } else if (!sameIntegrationCommand(commands.at(-1), REQUIRED_FINAL_INTEGRATION_COMMAND)) {
    errors.push({ path: `${path}.required_commands`, message: "npm run check must be the final command" });
  }
}

function optionalCheckedExecutionTimeout(errors, value, path) {
  if (value.timeout_ms === undefined) return;
  boundedInteger(errors, value, "timeout_ms", MIN_CHECKED_EXECUTION_TIMEOUT_MS, MAX_CHECKED_EXECUTION_TIMEOUT_MS, path);
}

function validateIntegrationProgram(errors, program, path) {
  if (typeof program !== "string") {
    errors.push({ path, message: "must be a string" });
    return;
  }
  const bytes = Buffer.byteLength(program, "utf8");
  if (program.length === 0 || program !== program.trim()) errors.push({ path, message: "must be non-empty and trimmed" });
  if (!wellFormedUtf8String(program)) errors.push({ path, message: "must be valid UTF-8 text" });
  if (bytes < 1 || bytes > MAX_INTEGRATION_GATE_PROGRAM_BYTES) errors.push({ path, message: `must be 1-${MAX_INTEGRATION_GATE_PROGRAM_BYTES} UTF-8 bytes` });
  if (hasTerminalControl(program)) errors.push({ path, message: "must not contain NUL or control characters" });
}

function validateIntegrationArgs(errors, args, path) {
  if (!Array.isArray(args)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  if (args.length > MAX_INTEGRATION_GATE_ARGS) errors.push({ path, message: `must contain at most ${MAX_INTEGRATION_GATE_ARGS} arguments` });
  for (const [index, arg] of args.entries()) {
    const argPath = `${path}[${index}]`;
    if (typeof arg !== "string") {
      errors.push({ path: argPath, message: "must be a string" });
      continue;
    }
    if (!wellFormedUtf8String(arg)) errors.push({ path: argPath, message: "must be valid UTF-8 text" });
    if (Buffer.byteLength(arg, "utf8") > MAX_INTEGRATION_GATE_ARG_BYTES) errors.push({ path: argPath, message: `must be at most ${MAX_INTEGRATION_GATE_ARG_BYTES} UTF-8 bytes` });
    if (arg.includes("\0")) errors.push({ path: argPath, message: "must not contain NUL" });
  }
}

function sameIntegrationCommand(actual, expected) {
  return isRecord(actual) && actual.program === expected.program && Array.isArray(actual.args)
    && actual.args.length === expected.args.length && actual.args.every((arg, index) => arg === expected.args[index]);
}

function wellFormedUtf8String(value) {
  return Buffer.from(value, "utf8").toString("utf8") === value;
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

export function validateRunSlicesPlanAuthority(runDir, run, plan) {
  const validated = validateSlicesPlan(plan, { enforceDependencyDepth: false });
  if (claimsCheckpointRoutingParent(runDir, run)) {
    assertExactCheckpointRoutingParent(runDir, run, validated);
    return validated;
  }
  return validateSlicesPlan(validated, { enforceDependencyDepth: !runSlicesMatchPlan(run, validated) });
}

export function claimsCheckpointRoutingParent(runDir, run) {
  const artifacts = run?.terminal_result?.artifacts;
  if (run?.terminal_result?.reason === CHECKPOINT_ROUTING_TERMINAL_REASON
    || isRecord(artifacts) && Object.hasOwn(artifacts, "checkpoint_routing")) return true;
  if (!isRecord(artifacts)) return false;
  return Object.values(artifacts).some((ref) => {
    if (!stringValue(ref)) return false;
    try {
      const artifact = resolveArtifactRef(runDir, ref);
      return JSON.parse(readFileSync(artifact.path, "utf8"))?.kind === CHECKPOINT_ROUTING_KIND;
    } catch {
      return false;
    }
  });
}

export function assertExactCheckpointRoutingParent(runDir, run, plan) {
  const terminal = run?.terminal_result;
  const artifacts = terminal?.artifacts;
  const artifactKeys = isRecord(artifacts) ? Object.keys(artifacts) : [];
  const manifestRef = artifacts?.checkpoint_routing;
  if (run?.status !== "blocked" || terminal?.status !== "blocked" || terminal?.run_id !== run.run_id
    || terminal?.reason !== CHECKPOINT_ROUTING_TERMINAL_REASON || run.pr_url != null || terminal.pr_url !== null
    || artifactKeys.length !== 1 || artifactKeys[0] !== "checkpoint_routing"
    || !/^artifacts\/checkpoint-routing-[0-9a-f]{64}\.json$/u.test(manifestRef ?? "")
    || !Array.isArray(run.slices) || run.slices.length !== 0) {
    throw new Error("blocked checkpoint-routing parent terminal authority is not exact");
  }
  const planPath = join(resolve(runDir), PLAN_SLICES_REF);
  if (!existsSync(planPath) || lstatSync(planPath).isSymbolicLink() || !lstatSync(planPath).isFile()) throw new Error("checkpoint-routing plan must be a regular file");
  const planHash = hashFile(planPath);
  const decompositionSteps = (Array.isArray(run.steps) ? run.steps : []).filter((step) => step?.agent === "work-decomposer");
  const step = decompositionSteps.length === 1 ? decompositionSteps[0] : null;
  if (!step || step.status !== "accepted" || step.artifact_ref !== PLAN_SLICES_REF || step.acceptance?.artifact_ref !== PLAN_SLICES_REF
    || step.acceptance?.artifact_hash !== planHash || step.review_ref !== step.acceptance?.review_ref
    || !stringValue(step.review_ref) || !stringValue(step.acceptance?.review_hash) || !Number.isInteger(step.attempts) || step.attempts < 1) {
    throw new Error("checkpoint-routing decomposition authority is not exact");
  }
  const review = resolveReviewRef(runDir, step.review_ref);
  if (hashFile(review.path) !== step.acceptance.review_hash) throw new Error("checkpoint-routing decomposition review hash is stale");
  const reviewValue = JSON.parse(readFileSync(review.path, "utf8"));
  const manifest = resolveArtifactRef(runDir, manifestRef);
  const manifestHash = hashFile(manifest.path);
  if (manifestRef !== `artifacts/checkpoint-routing-${manifestHash.slice("sha256:".length)}.json`) throw new Error("checkpoint-routing manifest content address is stale");
  if (run.checkpoint_progress?.manifest_ref !== manifestRef || run.checkpoint_progress?.manifest_hash !== manifestHash) {
    throw new Error("checkpoint-routing parent progress does not bind the exact manifest");
  }
  const admissionResult = evaluateDeliveryEnvelopeAdmission({ plan });
  validateCheckpointRoutingManifest(JSON.parse(readFileSync(manifest.path, "utf8")), {
    plan,
    planHash,
    admissionResult,
    decompositionAuthority: {
      plan_ref: PLAN_SLICES_REF,
      plan_hash: planHash,
      review_ref: step.review_ref,
      review_hash: step.acceptance.review_hash,
      attempt: step.attempts,
      review: reviewValue,
    },
  });
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
  if (heartbeat.identity !== undefined && heartbeat.identity !== null) {
    if (!isRecord(heartbeat.identity)) errors.push({ path: "heartbeat.identity", message: "must be an object" });
    else {
      for (const key of ["inspector", "start_marker", "command_name", "cwd"]) requiredString(errors, heartbeat.identity, key, `heartbeat.identity.${key}`);
    }
  }
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
  if (existsSync(slicesPath)) checks.push(validateSlicesPlanFile(slicesPath, run));
  if (checks.every((item) => item.ok)) checks.push(...checkRunConsistency(runDir, run).checks);
  return { ok: checks.every((item) => item.ok), checks };
}

export function checkRunConsistency(runDir, run) {
  const checks = [];
  let validRun = null;
  let carryForwardOwnershipSource = null;
  checks.push(runCheck("run.schema", () => {
    validRun = validateRun(run);
    return { run_id: validRun.run_id };
  }));
  if (!validRun) return { ok: false, checks };

  if (requiresCarryForwardOwnershipSource(validRun)) {
    checks.push(runCheck("run.continuation.carry_forward.ownership_source", () => {
      carryForwardOwnershipSource = observeCarryForwardOwnershipSource(runDir, validRun);
      return { parent_run_id: carryForwardOwnershipSource.run.run_id };
    }));
  }

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
      if (gate.status !== "pending") checks.push(runCheck(`run.gates.${gateName}.answer`, () => {
        const answer = resolveGateRef(runDir, gate.answer_ref);
        if (readFileSync(answer.path, "utf8").trim() !== gate.answer) fail([{ path: `run.gates.${gateName}.answer`, message: "must match archived answer_ref bytes" }]);
        return { ref: gate.answer_ref };
      }));
    }
    if (isRecord(gate.pending_snapshot)) {
      checks.push(runCheck(`run.gates.${gateName}.pending_snapshot`, () => {
        const artifact = resolveArtifactRef(runDir, gate.pending_snapshot.artifact_ref, { mustExist: gate.status !== "pending" });
        const question = resolveGateRef(runDir, gate.pending_snapshot.question_ref, { mustExist: gate.status !== "pending" });
        if (gate.status !== "pending" || existsSync(artifact.path)) {
          if (hashFile(artifact.path) !== gate.pending_snapshot.artifact_hash) fail([{ path: `run.gates.${gateName}.pending_snapshot.artifact_hash`, message: "must match artifact_ref bytes" }]);
        }
        if (gate.status !== "pending" || existsSync(question.path)) {
          if (hashFile(question.path) !== gate.pending_snapshot.question_hash) fail([{ path: `run.gates.${gateName}.pending_snapshot.question_hash`, message: "must match question_ref bytes" }]);
        }
        if (stringValue(gate.pending_snapshot.answer_ref) && stringValue(gate.pending_snapshot.answer_hash)) {
          const answer = resolveGateRef(runDir, gate.pending_snapshot.answer_ref);
          if (hashFile(answer.path) !== gate.pending_snapshot.answer_hash) fail([{ path: `run.gates.${gateName}.pending_snapshot.answer_hash`, message: "must match answer_ref bytes" }]);
        }
        return { gate: gateName };
      }));
    }
    if (isRecord(gate.handoff_receipt)) checks.push(runCheck(`run.gates.${gateName}.handoff_receipt`, () => {
      const receipt = gate.handoff_receipt;
      if (receipt.pending_snapshot_hash !== hashValue(gate.pending_snapshot)) fail([{ path: `run.gates.${gateName}.handoff_receipt.pending_snapshot_hash`, message: "must match pending_snapshot" }]);
      const answerHash = stringValue(gate.answer_ref) ? hashFile(resolveGateRef(runDir, gate.answer_ref).path) : hashValue(gate.answer);
      if (receipt.answer_hash !== answerHash) fail([{ path: `run.gates.${gateName}.handoff_receipt.answer_hash`, message: "must match persisted answer bytes" }]);
      if (receipt.approval_fingerprint !== gateApprovalFingerprint(gateName, gate, receipt)) fail([{ path: `run.gates.${gateName}.handoff_receipt.approval_fingerprint`, message: "must match approved gate facts" }]);
      if (isRecord(validRun.steering) && receipt.steering_generation !== validRun.steering.generation) fail([{ path: `run.gates.${gateName}.handoff_receipt.steering_generation`, message: "must match run steering generation" }]);
      return { gate: gateName };
    }));
  }

  for (const [index, step] of (Array.isArray(validRun.steps) ? validRun.steps : []).entries()) {
    if (stringValue(step?.evidence_ref)) checks.push(refCheck(`run.steps[${index}].evidence_ref`, () => resolveEvidenceRef(runDir, step.evidence_ref)));
    if (stringValue(step?.review_ref)) checks.push(refCheck(`run.steps[${index}].review_ref`, () => resolveReviewRef(runDir, step.review_ref)));
    const artifactResolver = step?.agent === "work-decomposer" && step?.artifact_ref === PLAN_SLICES_REF ? resolvePlanSlicesRef : resolveArtifactRef;
    if (stringValue(step?.artifact_ref)) checks.push(refCheck(`run.steps[${index}].artifact_ref`, () => artifactResolver(runDir, step.artifact_ref)));
    if (isRecord(step?.acceptance)) {
      const acceptanceArtifactResolver = step.agent === "work-decomposer" && step.acceptance.artifact_ref === PLAN_SLICES_REF ? resolvePlanSlicesRef : resolveArtifactRef;
      checks.push(refHashCheck(`run.steps[${index}].acceptance.artifact`, runDir, { ref: step.acceptance.artifact_ref, hash: step.acceptance.artifact_hash }, acceptanceArtifactResolver));
      if (stringValue(step.acceptance.review_ref)) checks.push(refHashCheck(`run.steps[${index}].acceptance.review`, runDir, { ref: step.acceptance.review_ref, hash: step.acceptance.review_hash }, resolveReviewRef));
    }
    if (step?.execution_claim?.state === "completed") checks.push(runCheck(`run.steps[${index}].execution_claim.receipt`, () => {
      const receipt = resolveEvidenceRef(runDir, step.execution_claim.receipt_ref);
      const value = validateTestExecutionReceipt(JSON.parse(readFileSync(receipt.path, "utf8")));
      if (hashFile(receipt.path, { mode: "raw" }) !== step.execution_claim.receipt_hash) fail([{ path: `run.steps[${index}].execution_claim.receipt_hash`, message: "must match exact receipt bytes" }]);
      if (value.run_id !== validRun.run_id || value.attempt !== step.attempts || value.claim_nonce !== step.execution_claim.nonce
        || value.plan_ref !== step.execution_claim.plan_ref || value.plan_hash !== step.execution_claim.plan_hash || value.head_sha !== step.execution_claim.head_sha
        || value.status !== step.execution_claim.status) fail([{ path: `run.steps[${index}].execution_claim`, message: "must match the factory receipt identity, plan, head, and status" }]);
      return { ref: receipt.ref, status: value.status };
    }));
  }

  checks.push(runCheck("run.integration_amendment.inventory", () => inspectIntegrationAmendmentInventory(runDir, validRun)));
  if (isRecord(validRun.integration_amendment)) checks.push(runCheck("run.integration_amendment.authority", () => {
    assertIntegrationAmendmentConsistency(runDir, validRun);
    return { amendment_id: validRun.integration_amendment.amendment_id, status: validRun.integration_amendment.status };
  }));
  for (const [index, slice] of (Array.isArray(validRun.slices) ? validRun.slices : []).entries()) {
    if (stringValue(slice?.evidence_ref)) checks.push(refCheck(`run.slices[${index}].evidence_ref`, () => resolveEvidenceRef(runDir, slice.evidence_ref)));
    if (stringValue(slice?.review_ref)) checks.push(refCheck(`run.slices[${index}].review_ref`, () => resolveReviewRef(runDir, slice.review_ref)));
    for (const [reviewIndex, review] of (Array.isArray(slice?.attempt_reviews) ? slice.attempt_reviews : []).entries()) {
      checks.push(runCheck(`run.slices[${index}].attempt_reviews[${reviewIndex}]`, () => {
        const evidence = resolveEvidenceRef(runDir, review.evidence_ref);
        const reviewed = resolveReviewRef(runDir, review.review_ref);
        if (hashFile(evidence.path) !== review.evidence_hash) fail([{ path: `run.slices[${index}].attempt_reviews[${reviewIndex}].evidence_hash`, message: "must match evidence_ref bytes" }]);
        if (hashFile(reviewed.path) !== review.review_hash) fail([{ path: `run.slices[${index}].attempt_reviews[${reviewIndex}].review_hash`, message: "must match review_ref bytes" }]);
        const expectedOwnership = observePersistedSliceAttemptOwnership(runDir, validRun, slice, review, {
          carryForwardOwnershipSource,
        });
        if (!attemptOwnershipEquals(review, expectedOwnership)) {
          fail([{ path: `run.slices[${index}].attempt_reviews[${reviewIndex}]`, message: "persisted ownership authority is stale" }]);
        }
        return { attempt: review.attempt, evidence_ref: review.evidence_ref, review_ref: review.review_ref };
      }));
    }
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

export function integrationAmendmentId(identity) {
  const errors = [];
  validateIntegrationAmendmentIdentity(errors, identity, "identity");
  if (errors.length) fail(errors);
  return createHash("sha256").update(canonicalIntegrationAmendmentJson(identity), "utf8").digest("base64url");
}

const INTEGRATION_AMENDMENT_REVIEW_CLAIM_KEYS = Object.freeze([
  "schema_version", "kind", "run_id", "amendment_id", "attempt", "agent", "baseline_commit", "candidate_commit", "candidate_tree",
  "review_ref", "context_hash", "completion_token_hash", "claimed_at", "closure_ref",
]);
const INTEGRATION_AMENDMENT_REVIEW_CLOSURE_KEYS = Object.freeze([
  "schema_version", "kind", "claim_ref", "claim_hash", "run_id", "amendment_id", "attempt", "agent", "context_hash",
  "review_ref", "review_hash", "completion_token", "returned_at",
]);

export function validateIntegrationAmendmentReviewDispatchClaim(claim, expected = {}) {
  if (!isRecord(claim) || Object.keys(claim).sort().join("\0") !== [...INTEGRATION_AMENDMENT_REVIEW_CLAIM_KEYS].sort().join("\0")
    || claim.schema_version !== 1 || claim.kind !== "checked-integration-amendment-review-dispatch-claim" || claim.agent !== "work-reviewer"
    || !SAFE_RUN_ID_PATTERN.test(claim.run_id || "") || claim.run_id.includes("..") || !AMENDMENT_ID_PATTERN.test(claim.amendment_id || "")
    || ![1, 2].includes(claim.attempt) || !FULL_GIT_SHA_PATTERN.test(claim.baseline_commit || "")
    || !FULL_GIT_SHA_PATTERN.test(claim.candidate_commit || "") || !FULL_GIT_SHA_PATTERN.test(claim.candidate_tree || "")
    || claim.review_ref !== `reviews/integration-amendment-${claim.amendment_id}.attempt-${claim.attempt}.json`
    || !HASH_PATTERN.test(claim.context_hash || "") || !HASH_PATTERN.test(claim.completion_token_hash || "")) {
    throw new Error("integration amendment reviewer claim is invalid or cross-bound");
  }
  const errors = [];
  requiredTimestamp(errors, claim, "claimed_at", "claim.claimed_at");
  if (errors.length) fail(errors);
  const claimRef = expected.claim_ref;
  if (stringValue(claimRef) && claim.closure_ref !== `${claimRef.slice(0, -5)}.closed.json`) throw new Error("integration amendment reviewer claim closure ref is stale or cross-bound");
  for (const key of ["run_id", "amendment_id", "attempt", "agent", "baseline_commit", "candidate_commit", "candidate_tree", "review_ref", "context_hash", "completion_token_hash", "closure_ref"]) {
    if (Object.hasOwn(expected, key) && claim[key] !== expected[key]) throw new Error(`integration amendment reviewer claim ${key} is stale or cross-bound`);
  }
  return claim;
}

export function validateIntegrationAmendmentReviewDispatchClosure(closure, expected = {}) {
  if (!isRecord(closure) || Object.keys(closure).sort().join("\0") !== [...INTEGRATION_AMENDMENT_REVIEW_CLOSURE_KEYS].sort().join("\0")
    || closure.schema_version !== 1 || closure.kind !== "checked-integration-amendment-review-dispatch-closure" || closure.agent !== "work-reviewer"
    || !SAFE_RUN_ID_PATTERN.test(closure.run_id || "") || closure.run_id.includes("..") || !AMENDMENT_ID_PATTERN.test(closure.amendment_id || "")
    || ![1, 2].includes(closure.attempt) || !HASH_PATTERN.test(closure.claim_hash || "") || !HASH_PATTERN.test(closure.context_hash || "")
    || !HASH_PATTERN.test(closure.review_hash || "") || !stringValue(closure.completion_token)
    || closure.review_ref !== `reviews/integration-amendment-${closure.amendment_id}.attempt-${closure.attempt}.json`) {
    throw new Error("integration amendment reviewer closure is invalid or cross-bound");
  }
  const errors = [];
  requiredTimestamp(errors, closure, "returned_at", "closure.returned_at");
  if (errors.length) fail(errors);
  for (const key of ["claim_ref", "claim_hash", "run_id", "amendment_id", "attempt", "agent", "context_hash", "review_ref", "review_hash", "completion_token"]) {
    if (Object.hasOwn(expected, key) && closure[key] !== expected[key]) throw new Error(`integration amendment reviewer closure ${key} is stale or cross-bound`);
  }
  if (stringValue(expected.completion_token_hash) && sha256ValidationBytes(closure.completion_token) !== expected.completion_token_hash) {
    throw new Error("integration amendment reviewer closure completion token is stale or cross-bound");
  }
  return closure;
}

export function inspectIntegrationAmendmentInventory(runDir, run) {
  const evidenceDir = join(runDir, "evidence");
  const reviewDir = join(runDir, "reviews");
  const evidenceNames = existsSync(evidenceDir) ? safeInventoryNames(evidenceDir, "integration amendment evidence directory").filter((name) => name.startsWith("integration-amendment")) : [];
  const reviewNames = existsSync(reviewDir) ? safeInventoryNames(reviewDir, "integration amendment review directory").filter((name) => name.startsWith("integration-amendment-")) : [];
  const fixedName = "integration-amendment.report.claim.json";
  const dispatchInventory = integrationAmendmentDispatchInventory(runDir);
  const hasClaim = evidenceNames.includes(fixedName);
  const manifest = run?.integration_amendment;
  if (!hasClaim) {
    if (evidenceNames.length || reviewNames.length || dispatchInventory.length || manifest) throw new Error("integration amendment cross-bound or orphan sidecar exists without the fixed report claim");
    return { classification: "all-absent", manifest: false, review_effect: { classification: "absent", attempt: null }, review_effects: [] };
  }
  const claimPath = join(evidenceDir, fixedName);
  const reportClaim = validateIntegrationAmendmentExecutionClaim(readInventoryJson(claimPath, "integration amendment report claim"));
  const reportClaimHash = hashFile(claimPath);
  if (reportClaim.phase !== "report") throw new Error("fixed integration amendment report claim must use report phase");
  if (integrationAmendmentId(reportClaim.identity) !== reportClaim.amendment_id) throw new Error("integration amendment report claim identity digest is stale");
  if (reportClaim.run_id !== run?.run_id || reportClaim.identity.run_id !== run?.run_id
    || reportClaim.head_sha !== reportClaim.identity.admission.baseline_commit
    || reportClaim.tree_sha !== reportClaim.identity.admission.baseline_tree
    || resolve(reportClaim.cwd) !== resolve(reportClaim.identity.admission.worktree)) {
    throw new Error("integration amendment report claim is stale or cross-bound to another run or baseline");
  }
  const reportReceiptName = `integration-amendment-${reportClaim.amendment_id}.report.receipt.json`;
  const hasReportReceipt = evidenceNames.includes(reportReceiptName);
  const allowedEvidence = new Set([fixedName, reportReceiptName]);
  if (manifest) {
    const id = manifest.amendment_id;
    allowedEvidence.add(`integration-amendment-${id}.verify.claim.json`);
    allowedEvidence.add(`integration-amendment-${id}.verify.receipt.json`);
  }
  const reviewInventory = inspectIntegrationAmendmentReviewInventory(runDir, run, manifest, reviewNames, dispatchInventory);
  const unknownEvidence = evidenceNames.filter((name) => !allowedEvidence.has(name));
  if (unknownEvidence.length) throw new Error(`integration amendment cross-bound or unknown sidecar inventory: ${unknownEvidence.join(", ")}`);
  const allowedDispatchRefs = new Set();
  for (const attempt of manifest?.attempts || []) {
    if (attempt.state === "reviewed") {
      allowedDispatchRefs.add(attempt.dispatch_claim_ref);
      allowedDispatchRefs.add(attempt.dispatch_closure_ref);
    }
  }
  if (run.special_builder_dispatch?.route === "integration-amendment") {
    allowedDispatchRefs.add(run.special_builder_dispatch.claim_ref);
    if (run.special_builder_dispatch.closure_ref) allowedDispatchRefs.add(run.special_builder_dispatch.closure_ref);
  }
  for (const ref of reviewInventory.allowed_dispatch_refs) allowedDispatchRefs.add(ref);
  const orphanDispatch = dispatchInventory.filter((entry) => !allowedDispatchRefs.has(entry.ref));
  if (orphanDispatch.length) throw new Error(`integration amendment cross-bound or orphan dispatch sidecar: ${orphanDispatch[0].ref}`);
  let verificationEffect = null;
  if (manifest) {
    const verifyClaimName = `integration-amendment-${manifest.amendment_id}.verify.claim.json`;
    const verifyReceiptName = `integration-amendment-${manifest.amendment_id}.verify.receipt.json`;
    const hasVerifyClaim = evidenceNames.includes(verifyClaimName);
    const hasVerifyReceipt = evidenceNames.includes(verifyReceiptName);
    if (hasVerifyReceipt && !hasVerifyClaim) throw new Error("integration amendment verification receipt is orphaned");
    if (hasVerifyClaim) {
      const legalUnboundVerification = manifest.status === "integrated" || manifest.status === "blocked" && manifest.blocked?.origin === "integrated";
      if (!legalUnboundVerification && !isRecord(manifest.verification)) throw new Error("integration amendment verification claim is cross-bound to a state that cannot consume it");
      const verifyClaimPath = join(evidenceDir, verifyClaimName);
      const verifyClaim = validateIntegrationAmendmentExecutionClaim(readInventoryJson(verifyClaimPath, "integration amendment verification claim"));
      if (verifyClaim.phase !== "verify" || verifyClaim.amendment_id !== manifest.amendment_id || verifyClaim.run_id !== run.run_id) throw new Error("integration amendment verification claim is cross-bound");
      const expectedIdentity = { schema_version: 1, kind: "integration-amendment-identity", run_id: run.run_id, defect_path: manifest.defect_path, admission: manifest.admission };
      if (integrationAmendmentId(verifyClaim.identity) !== verifyClaim.amendment_id
        || canonicalIntegrationAmendmentJson(verifyClaim.identity) !== canonicalIntegrationAmendmentJson(expectedIdentity)) {
        throw new Error("integration amendment verification claim identity is stale or cross-bound");
      }
      if (verifyClaim.head_sha !== manifest.integration?.commit || verifyClaim.tree_sha !== manifest.integration?.tree
        || resolve(verifyClaim.cwd) !== resolve(manifest.integration?.worktree || "")) {
        throw new Error("integration amendment verification claim staged head, tree, or worktree is stale or cross-bound");
      }
      let verifyReceipt = null;
      let verifyReceiptHash = null;
      if (hasVerifyReceipt) {
        const verifyReceiptPath = join(evidenceDir, verifyReceiptName);
        verifyReceipt = validateIntegrationAmendmentExecutionReceipt(readInventoryJson(verifyReceiptPath, "integration amendment verification receipt"));
        verifyReceiptHash = hashFile(verifyReceiptPath);
        assertIntegrationAmendmentReceiptClaimPair(verifyClaim, verifyReceipt, verifyReceiptHash);
      }
      if (verifyClaim.state === "active" && hasVerifyReceipt) throw new Error("active integration amendment verification claim cannot carry a receipt");
      if (verifyClaim.state === "completed" && (!hasVerifyReceipt || verifyClaim.receipt_hash !== verifyReceiptHash || verifyClaim.status !== verifyReceipt.status)) throw new Error("completed integration amendment verification claim receipt binding is stale");
      if (verifyClaim.state === "unknown" && (hasVerifyReceipt !== (verifyClaim.receipt_hash !== null)
        || hasVerifyReceipt && (verifyClaim.receipt_hash !== verifyReceiptHash || verifyClaim.receipt_status !== verifyReceipt.status))) {
        throw new Error("unknown integration amendment verification receipt binding is stale");
      }
      verificationEffect = { state: verifyClaim.state, status: verifyClaim.status ?? verifyClaim.receipt_status ?? null, claim_hash: hashFile(verifyClaimPath), receipt_hash: verifyReceiptHash, claim: verifyClaim, receipt: verifyReceipt };
    }
  }
  let reportReceipt = null;
  let reportReceiptHash = null;
  if (hasReportReceipt) {
    const path = join(evidenceDir, reportReceiptName);
    reportReceipt = validateIntegrationAmendmentExecutionReceipt(readInventoryJson(path, "integration amendment report receipt"));
    reportReceiptHash = hashFile(path, { mode: "raw" });
    assertIntegrationAmendmentReceiptClaimPair(reportClaim, reportReceipt, reportReceiptHash);
  }
  if (reportClaim.state === "active") {
    if (hasReportReceipt || manifest) throw new Error("active integration amendment report claim cannot carry a receipt or manifest");
    return { classification: "active-claim-only", manifest: false, review_effect: reviewInventory.current, review_effects: reviewInventory.effects, report_claim: reportClaim, report_claim_hash: reportClaimHash, report_receipt_hash: null };
  }
  if (reportClaim.state === "unknown") {
    if (manifest) throw new Error("unknown integration amendment report claim cannot carry a manifest");
    if (hasReportReceipt !== (reportClaim.receipt_hash !== null)) throw new Error("unknown integration amendment report receipt binding is stale");
    if (hasReportReceipt && (reportClaim.receipt_hash !== reportReceiptHash || reportClaim.receipt_status !== reportReceipt.status)) throw new Error("unknown integration amendment report receipt binding is stale");
    return { classification: "unknown-claim-optional-bound-receipt", manifest: false, review_effect: reviewInventory.current, review_effects: reviewInventory.effects, report_claim: reportClaim, report_receipt: reportReceipt, report_claim_hash: reportClaimHash, report_receipt_hash: reportReceiptHash };
  }
  if (!hasReportReceipt) throw new Error("completed integration amendment report claim has no exact receipt");
  if (reportClaim.receipt_hash !== reportReceiptHash || reportClaim.status !== reportReceipt.status) throw new Error("completed integration amendment report claim receipt binding is stale");
  const outcome = reportReceipt.commands[0].outcome;
  const nonzero = outcome === "exited" && reportReceipt.commands[0].exit_code !== 0;
  if (manifest) {
    if (!nonzero || reportClaim.status !== "fail" || reportReceipt.review_ready !== true || manifest.amendment_id !== reportClaim.amendment_id) throw new Error("integration amendment manifest does not consume an exact nonzero report");
    return { classification: "completed-nonzero-receipt-matching-manifest", manifest: true, review_effect: reviewInventory.current, review_effects: reviewInventory.effects, verification_effect: verificationEffect, report_claim: reportClaim, report_receipt: reportReceipt, report_claim_hash: reportClaimHash, report_receipt_hash: reportReceiptHash };
  }
  if (nonzero) return { classification: "completed-nonzero-receipt-no-manifest", manifest: false, review_effect: reviewInventory.current, review_effects: reviewInventory.effects, report_claim: reportClaim, report_receipt: reportReceipt, report_claim_hash: reportClaimHash, report_receipt_hash: reportReceiptHash };
  if (reportClaim.status === "pass") return { classification: "completed-pass-receipt-no-manifest", manifest: false, review_effect: reviewInventory.current, review_effects: reviewInventory.effects, report_claim: reportClaim, report_receipt: reportReceipt, report_claim_hash: reportClaimHash, report_receipt_hash: reportReceiptHash };
  return { classification: "completed-diagnostic-receipt-no-manifest", manifest: false, review_effect: reviewInventory.current, review_effects: reviewInventory.effects, report_claim: reportClaim, report_receipt: reportReceipt, report_claim_hash: reportClaimHash, report_receipt_hash: reportReceiptHash };
}

function inspectIntegrationAmendmentReviewInventory(runDir, run, manifest, reviewNames, dispatchInventory) {
  const reviewDispatch = new Map(dispatchInventory
    .filter(({ value }) => value.kind === "checked-integration-amendment-review-dispatch-claim"
      || value.kind === "checked-integration-amendment-review-dispatch-closure")
    .map((entry) => [entry.ref, entry]));
  if (!manifest) {
    if (reviewNames.length || reviewDispatch.size) throw new Error("integration amendment reviewer sidecar is orphaned without a manifest");
    return { current: { classification: "absent", attempt: null }, effects: [], allowed_dispatch_refs: new Set() };
  }

  const effects = [];
  const allowedReviewNames = new Set();
  const allowedDispatchRefs = new Set();
  for (const attempt of manifest.attempts || []) {
    const refs = integrationAmendmentReviewProvenanceRefs(run.run_id, manifest.amendment_id, attempt.attempt);
    const reviewName = `integration-amendment-${manifest.amendment_id}.attempt-${attempt.attempt}.json`;
    const reviewRef = `reviews/${reviewName}`;
    const claimEntry = reviewDispatch.get(refs.claim_ref);
    const closureEntry = reviewDispatch.get(refs.closure_ref);
    const hasReview = reviewNames.includes(reviewName);
    if (!claimEntry) {
      if (closureEntry || hasReview || attempt.state === "reviewed") throw new Error("integration amendment reviewer review or closure is orphaned without its claim");
      effects.push({ classification: "absent", attempt: attempt.attempt, claim_ref: refs.claim_ref, closure_ref: refs.closure_ref, review_ref: reviewRef });
      continue;
    }

    allowedDispatchRefs.add(refs.claim_ref);
    const expectedCandidate = attempt.candidate_commit || run.special_builder_dispatch?.completion_head;
    const candidateTree = expectedCandidate ? git(runDir, ["rev-parse", "--verify", `${expectedCandidate}^{tree}`]) : null;
    const expectedTree = attempt.candidate_tree || (candidateTree?.ok ? candidateTree.stdout.trim() : "");
    const claim = validateIntegrationAmendmentReviewDispatchClaim(claimEntry.value, {
      claim_ref: refs.claim_ref,
      run_id: run.run_id,
      amendment_id: manifest.amendment_id,
      attempt: attempt.attempt,
      agent: "work-reviewer",
      baseline_commit: manifest.admission.baseline_commit,
      candidate_commit: expectedCandidate,
      candidate_tree: expectedTree,
      review_ref: reviewRef,
      closure_ref: refs.closure_ref,
    });
    if (closureEntry && !hasReview) throw new Error("integration amendment reviewer closure is orphaned without review bytes");
    if (!hasReview) {
      effects.push({ classification: "active-claim-only", attempt: attempt.attempt, claim_ref: refs.claim_ref, claim_hash: claimEntry.hash, closure_ref: refs.closure_ref, review_ref: reviewRef });
      continue;
    }

    allowedReviewNames.add(reviewName);
    const reviewPath = resolveReviewRef(runDir, reviewRef).path;
    const review = validateIntegrationAmendmentReview(readInventoryJson(reviewPath, "integration amendment checked review"));
    if (review.subject !== `integration-amendment:${manifest.amendment_id}` || review.amendment_id !== manifest.amendment_id
      || review.attempt !== attempt.attempt || review.build_base_commit !== attempt.build_base_commit
      || review.reviewed_commit !== expectedCandidate || review.reviewed_tree !== expectedTree) {
      throw new Error("integration amendment reviewer review bytes are stale or cross-bound");
    }
    const observedPaths = git(runDir, ["diff", "--name-only", "-z", "--no-renames", manifest.admission.baseline_commit, expectedCandidate]);
    const changedPaths = observedPaths.ok ? observedPaths.stdout.split("\0").filter(Boolean).sort() : [];
    if (!observedPaths.ok || JSON.stringify(review.changed_paths) !== JSON.stringify(changedPaths)) throw new Error("integration amendment reviewer changed paths are stale or cross-bound");
    const reviewHash = hashFile(reviewPath);
    if (!closureEntry) {
      if (attempt.state === "reviewed") throw new Error("consumed integration amendment review is missing its reviewer closure");
      effects.push({ classification: "review-published-without-closure", attempt: attempt.attempt, claim_ref: refs.claim_ref, claim_hash: claimEntry.hash, closure_ref: refs.closure_ref, review_ref: reviewRef, review_hash: reviewHash });
      continue;
    }

    allowedDispatchRefs.add(refs.closure_ref);
    const closure = validateIntegrationAmendmentReviewDispatchClosure(closureEntry.value, {
      claim_ref: refs.claim_ref,
      claim_hash: claimEntry.hash,
      run_id: run.run_id,
      amendment_id: manifest.amendment_id,
      attempt: attempt.attempt,
      agent: "work-reviewer",
      context_hash: claim.context_hash,
      review_ref: reviewRef,
      review_hash: reviewHash,
      completion_token_hash: claim.completion_token_hash,
    });
    const classification = attempt.state === "reviewed" ? "consumed" : "closed-unconsumed";
    if (attempt.state !== "reviewed" && attempt.state !== "building") throw new Error("integration amendment reviewer closure is cross-bound to an unsupported attempt state");
    if (classification === "consumed" && (attempt.review_ref !== reviewRef || attempt.review_hash !== reviewHash
      || attempt.reviewed_commit !== claim.candidate_commit || attempt.reviewed_tree !== claim.candidate_tree)) {
      throw new Error("consumed integration amendment reviewer provenance is stale or cross-bound");
    }
    effects.push({ classification, attempt: attempt.attempt, claim_ref: refs.claim_ref, claim_hash: claimEntry.hash, closure_ref: refs.closure_ref,
      closure_hash: closureEntry.hash, review_ref: reviewRef, review_hash: reviewHash, returned_at: closure.returned_at });
  }

  const unknownReviews = reviewNames.filter((name) => !allowedReviewNames.has(name));
  if (unknownReviews.length) throw new Error(`integration amendment cross-bound or orphan review sidecar: ${unknownReviews[0]}`);
  const unknownDispatch = [...reviewDispatch.values()].filter(({ ref }) => !allowedDispatchRefs.has(ref));
  if (unknownDispatch.length) throw new Error(`integration amendment cross-bound or orphan reviewer dispatch sidecar: ${unknownDispatch[0].ref}`);
  return { current: effects.at(-1) || { classification: "absent", attempt: null }, effects, allowed_dispatch_refs: allowedDispatchRefs };
}

export function assertIntegrationAmendmentConsistency(runDir, run, options = {}) {
  const amendment = run.integration_amendment;
  const inventory = inspectIntegrationAmendmentInventory(runDir, run);
  if (inventory.classification !== "completed-nonzero-receipt-matching-manifest") throw new Error("integration amendment report authority is not exactly consumed");
  const identity = inventory.report_claim.identity;
  if (identity.run_id !== run.run_id || identity.defect_path !== amendment.defect_path || JSON.stringify(identity.admission) !== JSON.stringify(amendment.admission)) throw new Error("integration amendment report identity is cross-bound");
  assertIntegrationAmendmentAcceptedAuthority(runDir, run, amendment, options);
  const failure = amendment.failure_execution;
  if (failure.claim_ref !== "evidence/integration-amendment.report.claim.json" || failure.claim_hash !== inventory.report_claim_hash
    || failure.receipt_ref !== `evidence/integration-amendment-${amendment.amendment_id}.report.receipt.json` || failure.receipt_hash !== inventory.report_receipt_hash) throw new Error("integration amendment failure execution binding is stale");
  const reviews = [];
  for (const attempt of amendment.attempts || []) {
    if (attempt.state !== "reviewed") continue;
    const expectedRef = `reviews/integration-amendment-${amendment.amendment_id}.attempt-${attempt.attempt}.json`;
    if (attempt.review_ref !== expectedRef) throw new Error("integration amendment review ref is stale");
    const resolved = resolveReviewRef(runDir, expectedRef);
    const review = validateIntegrationAmendmentReview(readInventoryJson(resolved.path, "integration amendment review"));
    if (hashFile(resolved.path) !== attempt.review_hash || review.subject !== `integration-amendment:${amendment.amendment_id}` || review.amendment_id !== amendment.amendment_id
      || review.attempt !== attempt.attempt || review.build_base_commit !== attempt.build_base_commit || review.reviewed_commit !== attempt.reviewed_commit
      || review.reviewed_tree !== attempt.reviewed_tree || JSON.stringify(review.changed_paths) !== JSON.stringify(attempt.changed_paths)) throw new Error("integration amendment review binding is stale or cross-bound");
    assertIntegrationAmendmentDispatchBinding(runDir, run, amendment, attempt);
    assertIntegrationAmendmentReviewPublication(runDir, run, amendment, attempt);
    assertIntegrationAmendmentChangedPathOwnership(run, amendment, attempt.changed_paths);
    reviews.push(review);
  }
  if ((amendment.attempts || []).length === 2 && (reviews[0]?.verdict !== "REJECT" || !INTEGRATION_AMENDMENT_DISPOSITIONS.every((key) => reviews[0].dispositions[key] === "preserved"))) throw new Error("integration amendment attempt 2 requires an all-preserved attempt-1 REJECT");
  const lastReview = reviews.at(-1);
  if (["integrated", "verified", "merged"].includes(amendment.status) && lastReview?.verdict !== "APPROVE") throw new Error("integration amendment successor state requires APPROVE review");
  if (amendment.status === "reviewed" && !lastReview) throw new Error("reviewed integration amendment has no exact review");
  if (amendment.status === "blocked" && amendment.blocked.origin === "reviewed-approve" && lastReview?.verdict !== "APPROVE") throw new Error("blocked reviewed-approve origin is stale");
  if (amendment.status === "blocked" && amendment.blocked.origin === "reviewed-reject" && lastReview?.verdict !== "REJECT") throw new Error("blocked reviewed-reject origin is stale");
  if (amendment.status === "blocked" && ["integrated", "verified"].includes(amendment.blocked.origin) && lastReview?.verdict !== "APPROVE") throw new Error("blocked integrated or verified origin requires an exact APPROVE review");
  if (isRecord(amendment.verification)) assertIntegrationAmendmentVerificationBinding(runDir, run, amendment);
  assertIntegrationAmendmentGitConsistency(runDir, run, amendment, options);
}

function assertIntegrationAmendmentAcceptedAuthority(runDir, run, amendment, options = {}) {
  const planPath = join(runDir, PLAN_SLICES_REF);
  const plan = parseSlicesPlanBytes(readFileSync(planPath), { label: PLAN_SLICES_REF, enforceDependencyDepth: false });
  const steps = (run.steps || []).filter((entry) => entry?.agent === "work-decomposer");
  const step = steps[0];
  if (steps.length !== 1 || step.status !== "accepted" || step.artifact_ref !== PLAN_SLICES_REF || step.acceptance?.artifact_ref !== PLAN_SLICES_REF
    || step.acceptance.artifact_hash !== hashFile(planPath) || step.acceptance.review_ref !== step.review_ref
    || hashFile(resolveReviewRef(runDir, step.review_ref).path) !== step.acceptance.review_hash) throw new Error("integration amendment accepted decomposition authority is stale");
  const owner = (run.slices || []).find((slice) => slice?.id === amendment.owner_slice_id);
  const consumer = (run.slices || []).find((slice) => slice?.id === amendment.consumer_slice_id);
  const ownerProjection = owner && Object.fromEntries([...INTEGRATION_AMENDMENT_OWNER_KEYS].map((key) => [key, owner[key]]));
  const plannedById = new Map(plan.slices.map((slice) => [slice.id, slice]));
  if (!owner || !consumer || JSON.stringify(ownerProjection) !== JSON.stringify(amendment.admission.owner)
    || plannedById.size !== (run.slices || []).length) throw new Error("integration amendment owner or all-slice snapshot is stale");
  const ownerEntry = owner.attempt_reviews?.at(-1);
  const ownerEvidence = ownerEntry && readInventoryJson(resolveEvidenceRef(runDir, ownerEntry.evidence_ref).path, "integration amendment owner evidence");
  const ownerReview = ownerEntry && readInventoryJson(resolveReviewRef(runDir, ownerEntry.review_ref).path, "integration amendment owner review");
  const ownerResult = ownerReview && validateSliceReviewResult(ownerReview, { sliceId: owner.id });
  if (!ownerEntry || ownerEntry.attempt !== owner.attempts || ownerEvidence.status !== "pass" || ownerEvidence.review_ready !== true
    || ownerEvidence.subject !== owner.id || ownerEvidence.attempt !== owner.attempts || ownerEvidence.head_sha !== owner.reviewed_commit
    || ownerReview.subject !== owner.id || ownerReview.attempt !== owner.attempts || ownerReview.reviewed_commit !== owner.reviewed_commit
    || ownerResult.verdict !== "APPROVE" || owner.evidence_ref !== ownerEntry.evidence_ref || owner.evidence_hash !== ownerEntry.evidence_hash
    || owner.review_ref !== ownerEntry.review_ref || owner.review_hash !== ownerEntry.review_hash) {
    throw new Error("integration amendment owner current evidence or review authority is stale");
  }
  assertConsistencyInvariantFamilyAuthority(runDir, run, plan, owner, ownerReview);
  assertConsistencyOwnerAttemptHistory(runDir, run, owner, plan);
  assertConsistencyReviewedSliceHead(runDir, owner, options);
  for (const slice of run.slices || []) {
    const planned = plannedById.get(slice.id);
    if (!planned || slice.stack !== planned.stack || JSON.stringify(slice.depends_on) !== JSON.stringify(planned.depends_on)
      || JSON.stringify(slice.declared_paths) !== JSON.stringify(planned.paths)) {
      throw new Error("integration amendment accepted plan slice identity or declared scope is stale");
    }
  }
  const immutableConsumerKeys = ["id", "stack", "depends_on", "declared_paths"];
  if (immutableConsumerKeys.some((key) => JSON.stringify(consumer[key]) !== JSON.stringify(amendment.admission.consumer[key]))) {
    throw new Error("integration amendment consumer identity, dependency, or declared scope is stale");
  }
  const pristineConsumer = Object.fromEntries([...INTEGRATION_AMENDMENT_CONSUMER_KEYS].map((key) => [key, consumer[key]]));
  if (consumer.status === "pending" || consumer.attempts === 0) {
    if (JSON.stringify(pristineConsumer) !== JSON.stringify(amendment.admission.consumer)) throw new Error("integration amendment pristine consumer snapshot is stale");
  } else {
    assertIntegrationAmendmentConsumerProgress(runDir, run, consumer);
  }
  const unit = plan.delivery_envelope?.delivery_units?.find((entry) => entry.slice_id === consumer.id);
  const artifact = unit?.verification_artifacts?.find((entry) => entry.id === amendment.verification_artifact_id);
  if (!unit || !artifact || unit.id !== amendment.admission.probe.delivery_unit_id || artifact.test_plan_index !== amendment.admission.probe.test_plan_index
    || artifact.test_plan_entry !== amendment.admission.probe.test_plan_entry) throw new Error("integration amendment consumer probe authority is stale");
  const owners = (run.slices || []).filter((slice) => (slice.effective_paths || []).some((lane) => {
    const normalized = canonicalPlanOwnershipLane(lane, [], "lane");
    return normalized && planLaneOwnsConcretePath(normalized, amendment.defect_path);
  }));
  if (owners.length !== 1 || owners[0].id !== owner.id) throw new Error("integration amendment frozen sole-owner authority is stale");
}

function assertIntegrationAmendmentConsumerProgress(runDir, run, consumer) {
  if (!Number.isInteger(consumer.attempts) || consumer.attempts < 1 || !["running", "review", "merged", "blocked"].includes(consumer.status)) {
    throw new Error("integration amendment consumer lifecycle progression is invalid");
  }
  if (!FULL_GIT_SHA_PATTERN.test(consumer.authorized_baseline_commit || "")) {
    throw new Error("integration amendment downstream slice authorized baseline is missing or invalid");
  }
  const exactCheckedHeads = new Set([run.integration_amendment?.integration?.commit, ...(run.slices || []).filter((slice) => slice?.status === "merged").map((slice) => slice.merge_commit)]);
  if (!exactCheckedHeads.has(consumer.authorized_baseline_commit)) {
    throw new Error("integration amendment downstream slice authorized baseline is not an exact checked feature head");
  }
  for (const entry of consumer.attempt_reviews || []) {
    const evidencePath = resolveEvidenceRef(runDir, entry.evidence_ref).path;
    const reviewPath = resolveReviewRef(runDir, entry.review_ref).path;
    const evidence = readInventoryJson(evidencePath, "integration amendment consumer evidence");
    const review = readInventoryJson(reviewPath, "integration amendment consumer review");
    const result = validateSliceReviewResult(review, { sliceId: consumer.id });
    if (hashFile(evidencePath) !== entry.evidence_hash || hashFile(reviewPath) !== entry.review_hash
      || evidence.subject !== consumer.id || evidence.attempt !== entry.attempt || evidence.status !== "pass" || evidence.review_ready !== true
      || evidence.head_sha !== entry.reviewed_commit || review.subject !== consumer.id || review.attempt !== entry.attempt
      || review.reviewed_commit !== entry.reviewed_commit || review.verdict !== entry.verdict || review.convergence !== entry.convergence
      || result.late_discovery_strike !== entry.late_discovery_strike
      || entry.diff_base_commit !== consumer.authorized_baseline_commit
      || review.remaining_fix_count !== entry.remaining_fix_count
      || !attemptOwnershipEquals(entry, observePersistedSliceAttemptOwnership(runDir, run, consumer, entry))) {
      throw new Error(`integration amendment consumer attempt ${entry.attempt} review authority is stale`);
    }
    assertIntegrationAmendmentConsumerDispatch(runDir, run, consumer, entry);
  }
  assertIntegrationAmendmentCurrentConsumerDispatch(runDir, run, consumer);
  const current = consumer.attempt_reviews?.at(-1);
  if (["review", "merged"].includes(consumer.status) && (!current || current.attempt !== consumer.attempts)) {
    throw new Error("integration amendment consumer current review history is stale");
  }
  if (consumer.status === "merged" && current?.verdict !== "APPROVE") throw new Error("integration amendment merged consumer requires current APPROVE authority");
}

function attemptOwnershipEquals(entry, expected) {
  if (expected.ownership_schema_version === 1) {
    return entry.ownership_schema_version === undefined && entry.modified_extensions === undefined
      && JSON.stringify(entry.ratified_paths) === JSON.stringify(expected.ratified_paths);
  }
  return entry.ownership_schema_version === 2
    && JSON.stringify(entry.ratified_paths) === JSON.stringify(expected.ratified_paths)
    && JSON.stringify(entry.modified_extensions) === JSON.stringify(expected.modified_extensions);
}

export function observePersistedSliceAttemptOwnership(runDir, run, slice, entry, options = {}) {
  const evidencePath = resolveEvidenceRef(runDir, entry.evidence_ref).path;
  const reviewPath = resolveReviewRef(runDir, entry.review_ref).path;
  const evidence = readInventoryJson(evidencePath, `slice '${slice.id}' attempt ${entry.attempt} evidence`);
  const review = readInventoryJson(reviewPath, `slice '${slice.id}' attempt ${entry.attempt} review`);
  const result = validateSliceReviewResult(review, { sliceId: slice.id });
  if (result.ownership_schema_version === 1) {
    return { ownership_schema_version: 1, ratified_paths: result.ratified_paths };
  }

  const planPath = join(runDir, PLAN_SLICES_REF);
  const plan = parseSlicesPlanBytes(readFileSync(planPath), {
    label: PLAN_SLICES_REF,
    enforceDependencyDepth: false,
  });
  const planned = plan.slices.find((candidate) => candidate.id === slice.id);
  if (!planned || JSON.stringify(planned.paths) !== JSON.stringify(slice.declared_paths)) {
    throw new Error(`slice '${slice.id}' persisted ownership declared scope is stale`);
  }
  if (!FULL_GIT_SHA_PATTERN.test(entry.diff_base_commit || "") || !FULL_GIT_SHA_PATTERN.test(entry.reviewed_commit || "")) {
    throw new Error(`slice '${slice.id}' persisted ownership commit binding is invalid`);
  }
  if (evidence.subject !== slice.id || evidence.attempt !== entry.attempt || evidence.head_sha !== entry.reviewed_commit
    || review.subject !== slice.id || review.attempt !== entry.attempt || review.reviewed_commit !== entry.reviewed_commit) {
    throw new Error(`slice '${slice.id}' persisted ownership sidecar identity is stale`);
  }
  const firstEntry = slice.attempt_reviews?.[0];
  if (firstEntry?.dispatch_claim_ref) {
    const firstClaim = readInventoryJson(resolve(runDir, firstEntry.dispatch_claim_ref), `slice '${slice.id}' first dispatch claim`);
    if (firstClaim.head !== entry.diff_base_commit) {
      throw new Error(`slice '${slice.id}' stored diff baseline must equal the first checked dispatch commit`);
    }
  }
  if (!git(runDir, ["merge-base", "--is-ancestor", entry.diff_base_commit, entry.reviewed_commit]).ok) {
    throw new Error(`slice '${slice.id}' persisted ownership ancestry is unobservable`);
  }
  const changedPaths = observeConsistencyPathSet(runDir, entry.diff_base_commit, entry.reviewed_commit, `slice '${slice.id}' persisted ownership diff`);
  const declaredLanes = planned.paths.map(consistencyOwnershipLane);
  const unexpected = [...changedPaths].filter((path) => !declaredLanes.some((lane) => consistencyLaneContains(lane, path))).sort();
  const disclosure = normalizePersistedOwnershipDisclosure(evidence.ownership_disclosure, slice.id, unexpected);
  if (result.verdict === "REJECT") return { ownership_schema_version: 2, ratified_paths: [], modified_extensions: [] };

  const changeKinds = observeConsistencyChangedPathKinds(runDir, entry.diff_base_commit, entry.reviewed_commit);
  const planLanes = plan.slices.map((candidate) => ({ id: candidate.id, lanes: candidate.paths.map(consistencyOwnershipLane) }));
  const disclosedByPath = new Map(disclosure.map((item) => [item.path, item]));
  const modifiedExtensions = unexpected.map((path) => {
    const rationale = disclosedByPath.get(path).rationale;
    const owners = planLanes.filter((candidate) => candidate.lanes.some((lane) => consistencyLaneContains(lane, path))).map((candidate) => candidate.id);
    if (owners.length > 1) throw new Error(`slice '${slice.id}' persisted ownership for '${path}' is ambiguous`);
    const privilegedReason = privilegedControlPlanePathReason(path);
    if (privilegedReason) throw new Error(`slice '${slice.id}' persisted ownership for '${path}' is privileged (${privilegedReason})`);
    const changeKind = changeKinds.get(path);
    if (changeKind === "added") {
      if (owners.length !== 0) throw new Error(`slice '${slice.id}' persisted added ownership for '${path}' is sibling-owned`);
      assertConsistencySafeAdded(runDir, slice.id, path, entry.diff_base_commit, entry.reviewed_commit);
      return { kind: "modified-extension", path, rationale, authority: "unowned" };
    }
    if (changeKind !== "modified") throw new Error(`slice '${slice.id}' persisted ownership for '${path}' has unsafe Git change kind '${changeKind || "unobservable"}'`);
    assertConsistencySafeModification(runDir, slice.id, path, entry.diff_base_commit, entry.reviewed_commit);
    if (owners.length === 0) return { kind: "modified-extension", path, rationale, authority: "unowned" };
    return observeConsistencySiblingAuthority(runDir, run, slice.id, path, rationale, owners[0], plan, options);
  });
  return { ownership_schema_version: 2, ratified_paths: [...unexpected], modified_extensions: modifiedExtensions };
}

function normalizePersistedOwnershipDisclosure(value, sliceId, unexpected) {
  if (unexpected.length === 0) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length !== 0) throw new Error(`slice '${sliceId}' persisted ownership disclosure must be empty`);
    return [];
  }
  if (!Array.isArray(value)) throw new Error(`slice '${sliceId}' persisted ownership disclosure is missing`);
  const normalized = value.map((entry) => {
    if (!isRecord(entry) || Object.keys(entry).sort().join("\0") !== "path\0rationale"
      || !isCanonicalConcreteRepositoryPath(entry.path) || entry.path.normalize("NFC") !== entry.path) {
      throw new Error(`slice '${sliceId}' persisted ownership disclosure path is invalid`);
    }
    const rationale = typeof entry.rationale === "string" ? entry.rationale : "";
    if (!rationale || rationale !== rationale.trim() || rationale !== rationale.normalize("NFC") || /[\x00-\x1f\x7f-\x9f]/u.test(rationale)) {
      throw new Error(`slice '${sliceId}' persisted ownership disclosure rationale is invalid`);
    }
    return { path: entry.path, rationale };
  });
  const paths = normalized.map((entry) => entry.path);
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort()) || new Set(paths).size !== paths.length
    || JSON.stringify(paths) !== JSON.stringify(unexpected)) {
    throw new Error(`slice '${sliceId}' persisted ownership disclosure path set is stale`);
  }
  return normalized;
}

function observeConsistencyPathSet(runDir, from, to, label) {
  const result = git(runDir, ["diff", "--name-only", "-z", "--no-renames", from, to]);
  if (!result.ok || result.stdout && !result.stdout.endsWith("\0")) throw new Error(`${label} cannot be observed`);
  if (result.stdout === "") return new Set();
  const paths = result.stdout.slice(0, -1).split("\0");
  if (paths.some((path) => !isCanonicalConcreteRepositoryPath(path)) || new Set(paths).size !== paths.length) throw new Error(`${label} is malformed`);
  return new Set(paths);
}

function observeConsistencyChangedPathKinds(runDir, from, to) {
  const result = git(runDir, ["diff", "--name-status", "-z", "--find-renames", "--find-copies-harder", from, to]);
  if (!result.ok || result.stdout && !result.stdout.endsWith("\0")) throw new Error("persisted ownership change kinds cannot be observed");
  const records = result.stdout === "" ? [] : result.stdout.slice(0, -1).split("\0");
  const kinds = new Map();
  for (let index = 0; index < records.length;) {
    const status = records[index++];
    if (!/^(?:[AMDTUXB]|[RC][0-9]{1,3})$/u.test(status)) throw new Error("persisted ownership change kinds are malformed");
    const first = records[index++];
    if (!first) throw new Error("persisted ownership change kinds are malformed");
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = records[index++];
      if (!second) throw new Error("persisted ownership change kinds are malformed");
      recordConsistencyChangeKind(kinds, first, status.startsWith("R") ? "renamed" : "copied");
      recordConsistencyChangeKind(kinds, second, status.startsWith("R") ? "renamed" : "copied");
    } else {
      recordConsistencyChangeKind(kinds, first, { A: "added", M: "modified", D: "deleted", T: "type-changed", U: "unmerged", X: "unknown", B: "broken" }[status]);
    }
  }
  return kinds;
}

function recordConsistencyChangeKind(kinds, path, kind) {
  const existing = kinds.get(path);
  if (["renamed", "copied"].includes(existing) && !["renamed", "copied"].includes(kind)) return;
  if (["renamed", "copied"].includes(kind) || existing === undefined) kinds.set(path, kind);
  else kinds.set(path, kind);
}

function consistencyOwnershipLane(path) {
  const canonical = validatePlanPath(path);
  if (canonical !== path) throw new Error("persisted ownership plan lane is invalid");
  return canonical.endsWith("/**") ? { base: canonical.slice(0, -3), recursive: true } : { base: canonical, recursive: false };
}

function consistencyLaneContains(lane, path) { return lane.recursive ? path.startsWith(`${lane.base}/`) : path === lane.base; }

function observeConsistencyTreeEntry(runDir, commit, path, sliceId) {
  const repository = git(runDir, ["rev-parse", "--show-toplevel"]);
  if (!repository.ok) throw new Error(`slice '${sliceId}' persisted ownership repository cannot be observed`);
  const result = git(repository.stdout.trim(), ["ls-tree", "-z", commit, "--", `:(literal)${path}`]);
  if (!result.ok) throw new Error(`slice '${sliceId}' persisted ownership tree entry cannot be observed`);
  if (result.stdout === "") return null;
  const match = /^(\d{6}) ([^ ]+) ([0-9a-f]{40})\t([^\0]+)\0$/u.exec(result.stdout);
  if (!match || match[4] !== path) throw new Error(`slice '${sliceId}' persisted ownership tree entry is malformed`);
  return { mode: match[1], type: match[2], oid: match[3] };
}

function isConsistencyPrivateBlob(entry) { return Boolean(entry && ["100644", "100755"].includes(entry.mode) && entry.type === "blob" && FULL_GIT_SHA_PATTERN.test(entry.oid)); }

function assertConsistencySafeAdded(runDir, sliceId, path, baseline, reviewed) {
  if (observeConsistencyTreeEntry(runDir, baseline, path, sliceId) !== null
    || !isConsistencyPrivateBlob(observeConsistencyTreeEntry(runDir, reviewed, path, sliceId))) {
    throw new Error(`slice '${sliceId}' persisted added ownership for '${path}' is unsafe`);
  }
}

function assertConsistencySafeModification(runDir, sliceId, path, baseline, reviewed) {
  const before = observeConsistencyTreeEntry(runDir, baseline, path, sliceId);
  const after = observeConsistencyTreeEntry(runDir, reviewed, path, sliceId);
  if (!isConsistencyPrivateBlob(before) || !isConsistencyPrivateBlob(after) || before.mode !== after.mode || before.oid === after.oid) {
    throw new Error(`slice '${sliceId}' persisted modified ownership for '${path}' is unsafe`);
  }
}

function requiresCarryForwardOwnershipSource(run) {
  return isRecord(run.continuation) && (run.slices || []).some((slice) =>
    (slice.attempt_reviews || []).some((entry) =>
      (entry.modified_extensions || []).some((extension) => extension?.authority === "non-conflicting-sibling")));
}

function observeCarryForwardOwnershipSource(runDir, run) {
  const continuation = run.continuation;
  const repository = git(runDir, ["rev-parse", "--show-toplevel"]);
  if (!repository.ok) throw new Error("carry-forward ownership source repository cannot be observed");
  const repo = resolve(repository.stdout.trim());
  const parentFile = resolve(repo, continuation.parent.run_ref);
  assertConsistencyRegularFile(repo, parentFile, "carry-forward ownership parent run.json");
  if (hashFile(parentFile) !== continuation.parent.run_hash) {
    throw new Error("carry-forward ownership parent run.json hash is stale");
  }
  const parentRun = validateRun(readInventoryJson(parentFile, "carry-forward ownership parent run.json"));
  for (const key of ["run_id", "status", "branch", "worktree"]) {
    if (parentRun[key] !== continuation.parent[key]) throw new Error(`carry-forward ownership parent ${key} is stale or cross-bound`);
  }
  const parentBranch = git(repo, ["rev-parse", "--verify", `refs/heads/${continuation.parent.branch}^{commit}`]);
  if (!parentBranch.ok || parentBranch.stdout.trim() !== continuation.parent.commit
    || continuation.carry_forward.start_commit !== continuation.parent.commit) {
    throw new Error("carry-forward ownership parent branch/commit is stale or cross-bound");
  }
  const parentRunDir = dirname(parentFile);
  if (hashFile(join(parentRunDir, PLAN_SLICES_REF)) !== continuation.carry_forward.plan_hash
    || hashFile(join(runDir, PLAN_SLICES_REF)) !== continuation.carry_forward.plan_hash) {
    throw new Error("carry-forward ownership plan bytes are stale or cross-bound");
  }

  const parentById = new Map((parentRun.slices || []).map((slice) => [slice.id, slice]));
  const childById = new Map((run.slices || []).map((slice) => [slice.id, slice]));
  const acceptedIds = new Set();
  for (const adopted of continuation.carry_forward.accepted_slices) {
    const parentSlice = parentById.get(adopted.id);
    const childSlice = childById.get(adopted.id);
    if (acceptedIds.has(adopted.id) || parentSlice?.status !== "merged" || childSlice?.status !== "merged"
      || !isDeepStrictEqual(carryForwardOwnershipProjection(parentSlice), adopted)
      || !isDeepStrictEqual(carryForwardOwnershipProjection(childSlice), adopted)) {
      throw new Error(`carry-forward ownership source slice '${adopted.id}' is stale or cross-bound`);
    }
    acceptedIds.add(adopted.id);
  }
  return { run_dir: parentRunDir, run: parentRun, accepted_ids: acceptedIds };
}

function carryForwardOwnershipProjection(slice) {
  if (!isRecord(slice)) return null;
  return {
    id: slice.id,
    declared_paths: slice.declared_paths,
    effective_paths: slice.effective_paths,
    attempts: slice.attempts,
    evidence_ref: slice.evidence_ref,
    evidence_hash: slice.evidence_hash,
    review_ref: slice.review_ref,
    review_hash: slice.review_hash,
    reviewed_commit: slice.reviewed_commit,
    merge_commit: slice.merge_commit,
    attempt_reviews: slice.attempt_reviews,
    ...(slice.integration_conflict ? { integration_conflict: slice.integration_conflict } : {}),
  };
}

function assertConsistencyRegularFile(root, file, label) {
  const relativePath = relative(root, file);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label} escapes the repository`);
  }
  let current = root;
  for (const part of relativePath.split(sep)) {
    current = join(current, part);
    if (!existsSync(current)) throw new Error(`${label} is missing`);
    const entry = lstatSync(current);
    if (entry.isSymbolicLink()) throw new Error(`${label} must not contain symlinks`);
  }
  if (!lstatSync(file).isFile()) throw new Error(`${label} must be a regular file`);
}

function observeConsistencySiblingAuthority(runDir, run, modifyingSliceId, path, rationale, ownerSliceId, plan, options = {}) {
  const inheritedSource = options.carryForwardOwnershipSource;
  const useInheritedSource = inheritedSource?.accepted_ids.has(modifyingSliceId) === true;
  if (useInheritedSource && !inheritedSource.accepted_ids.has(ownerSliceId)) {
    throw new Error(`slice '${modifyingSliceId}' persisted sibling owner '${ownerSliceId}' is unavailable`);
  }
  const authorityRunDir = useInheritedSource ? inheritedSource.run_dir : runDir;
  const authorityRun = useInheritedSource ? inheritedSource.run : run;
  const owner = (authorityRun.slices || []).find((candidate) => candidate.id === ownerSliceId);
  const ownerEntry = owner?.attempt_reviews?.at(-1);
  if (!owner || !["review", "merged"].includes(owner.status) || useInheritedSource && owner.status !== "merged"
    || !ownerEntry || ownerEntry.attempt !== owner.attempts) {
    throw new Error(`slice '${modifyingSliceId}' persisted sibling owner '${ownerSliceId}' is unavailable`);
  }
  const evidencePath = resolveEvidenceRef(authorityRunDir, ownerEntry.evidence_ref).path;
  const reviewPath = resolveReviewRef(authorityRunDir, ownerEntry.review_ref).path;
  const ownerEvidence = readInventoryJson(evidencePath, `slice '${ownerSliceId}' owner evidence`);
  const ownerReview = readInventoryJson(reviewPath, `slice '${ownerSliceId}' owner review`);
  const ownerResult = validateSliceReviewResult(ownerReview, { sliceId: ownerSliceId });
  if (ownerResult.verdict !== "APPROVE" || ownerEvidence.status !== "pass" || ownerEvidence.review_ready !== true
    || ownerEvidence.subject !== ownerSliceId || ownerEvidence.attempt !== owner.attempts
    || ownerEvidence.head_sha !== ownerReview.reviewed_commit || ownerReview.reviewed_commit !== owner.reviewed_commit
    || owner.evidence_ref !== ownerEntry.evidence_ref || owner.review_ref !== ownerEntry.review_ref
    || owner.evidence_hash !== hashFile(evidencePath) || owner.review_hash !== hashFile(reviewPath)
    || ownerEntry.evidence_hash !== owner.evidence_hash || ownerEntry.review_hash !== owner.review_hash) {
    throw new Error(`slice '${modifyingSliceId}' persisted sibling owner '${ownerSliceId}' review authority is stale`);
  }
  assertConsistencyInvariantFamilyAuthority(authorityRunDir, authorityRun, plan, owner, ownerReview, {
    copiedRunDir: useInheritedSource ? runDir : null,
  });
  assertConsistencyOwnerAttemptHistory(authorityRunDir, authorityRun, owner, plan, {
    ...options,
    ownershipObservationStack: new Set([...(options.ownershipObservationStack || []), modifyingSliceId]),
  });
  const dispatch = observeConsistencySliceDispatch(authorityRunDir, authorityRun, owner, ownerEntry);
  const claimPath = resolve(authorityRunDir, dispatch.dispatch_claim_ref);
  const closurePath = resolve(authorityRunDir, dispatch.dispatch_closure_ref);
  if (useInheritedSource) {
    assertConsistencyCopiedArtifact(runDir, authorityRunDir, dispatch.dispatch_claim_ref,
      ownerEntry.dispatch_claim_hash, `slice '${ownerSliceId}' copied dispatch claim`);
    assertConsistencyCopiedArtifact(runDir, authorityRunDir, dispatch.dispatch_closure_ref,
      ownerEntry.dispatch_closure_hash, `slice '${ownerSliceId}' copied dispatch closure`);
  }
  assertConsistencyReviewedSliceHead(authorityRunDir, owner);
  const first = owner.attempt_reviews[0];
  const firstClaim = readInventoryJson(resolve(authorityRunDir, first.dispatch_claim_ref), `slice '${ownerSliceId}' first dispatch claim`);
  if (firstClaim.head !== ownerEntry.diff_base_commit || !git(authorityRunDir, ["merge-base", "--is-ancestor", ownerEntry.diff_base_commit, owner.reviewed_commit]).ok) {
    throw new Error(`slice '${modifyingSliceId}' persisted sibling owner '${ownerSliceId}' baseline is stale`);
  }
  const ownerPaths = observeConsistencyPathSet(authorityRunDir, ownerEntry.diff_base_commit, owner.reviewed_commit, `slice '${ownerSliceId}' persisted sibling diff`);
  if (ownerPaths.has(path)) throw new Error(`slice '${modifyingSliceId}' persisted sibling owner '${ownerSliceId}' touches '${path}'`);
  return {
    kind: "modified-extension", path, rationale, authority: "non-conflicting-sibling",
    owner_slice_id: ownerSliceId, owner_attempt: owner.attempts,
    owner_evidence_ref: ownerEntry.evidence_ref, owner_evidence_hash: hashFile(evidencePath),
    owner_review_ref: ownerEntry.review_ref, owner_review_hash: hashFile(reviewPath),
    owner_dispatch_claim_ref: dispatch.dispatch_claim_ref, owner_dispatch_claim_hash: hashFile(claimPath),
    owner_dispatch_closure_ref: dispatch.dispatch_closure_ref, owner_dispatch_closure_hash: hashFile(closurePath),
    owner_reviewed_commit: ownerReview.reviewed_commit, owner_diff_base_commit: ownerEntry.diff_base_commit,
  };
}

function assertConsistencyOwnerAttemptHistory(runDir, run, owner, plan, options = {}) {
  const stack = new Set(options.ownershipObservationStack || []);
  if (stack.has(owner.id)) throw new Error(`slice '${owner.id}' persisted sibling ownership authority is cyclic`);
  stack.add(owner.id);
  const entries = owner.attempt_reviews || [];
  if (!Number.isInteger(owner.attempts) || owner.attempts < 1 || entries.length !== owner.attempts) {
    throw new Error(`slice '${owner.id}' persisted sibling owner history is partial`);
  }
  const priorReviews = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.attempt !== index + 1) throw new Error(`slice '${owner.id}' persisted sibling owner history is not append-only`);
    const evidencePath = resolveEvidenceRef(runDir, entry.evidence_ref).path;
    const reviewPath = resolveReviewRef(runDir, entry.review_ref).path;
    const evidence = readInventoryJson(evidencePath, `slice '${owner.id}' attempt ${entry.attempt} evidence`);
    const review = readInventoryJson(reviewPath, `slice '${owner.id}' attempt ${entry.attempt} review`);
    const result = validateSliceReviewResult(review, { sliceId: owner.id, priorReviews });
    const dispatch = observeConsistencySliceDispatch(runDir, run, owner, entry);
    const ownership = observePersistedSliceAttemptOwnership(runDir, run, owner, entry, { ...options, ownershipObservationStack: stack });
    const { ownership_schema_version: _schemaVersion, ratified_paths: _ratifiedPaths, task_context: _taskContext, ...reviewResult } = result;
    const expected = {
      attempt: entry.attempt,
      evidence_ref: entry.evidence_ref,
      evidence_hash: hashFile(evidencePath),
      review_ref: entry.review_ref,
      review_hash: hashFile(reviewPath),
      reviewed_commit: review.reviewed_commit,
      diff_base_commit: entry.diff_base_commit,
      ...(ownership.ownership_schema_version === 2 ? ownership : { ratified_paths: ownership.ratified_paths }),
      ...reviewResult,
      ...dispatch,
    };
    if (evidence.subject !== owner.id || evidence.attempt !== entry.attempt || evidence.head_sha !== review.reviewed_commit
      || review.attempt !== entry.attempt || !attemptOwnershipEquals(entry, ownership)
      || !isDeepStrictEqual(expected, entry)) {
      throw new Error(`slice '${owner.id}' persisted sibling owner attempt ${entry.attempt} history is stale`);
    }
    priorReviews.push(expected);
  }
}

function observeConsistencySliceDispatch(runDir, run, slice, entry) {
  const keys = ["dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash"];
  if (keys.some((key) => entry[key] === undefined)) throw new Error(`slice '${slice.id}' attempt ${entry.attempt} dispatch authority is incomplete`);
  const name = createHash("sha256").update(`${run.run_id}\0${slice.id}\0${entry.attempt}`, "utf8").digest("hex");
  const expectedClaimRef = `dispatch/${name}.json`;
  const expectedClosureRef = `dispatch/${name}.closed.json`;
  const claimPath = resolve(runDir, entry.dispatch_claim_ref);
  const closurePath = resolve(runDir, entry.dispatch_closure_ref);
  const claim = readInventoryJson(claimPath, `slice '${slice.id}' attempt ${entry.attempt} dispatch claim`);
  const closure = readInventoryJson(closurePath, `slice '${slice.id}' attempt ${entry.attempt} dispatch closure`);
  const claimKeys = ["schema_version", "kind", "run_id", "slice_id", "attempt", "agent", "branch", "worktree", "head", "context_hash", "completion_token_hash", "claimed_at", "closure_ref"];
  const commonClosureKeys = ["schema_version", "kind", "claim_ref", "claim_hash", "run_id", "slice_id", "attempt", "agent", "branch", "worktree", "head", "completion_head", "context_hash"];
  const callback = closure.kind === "checked-slice-builder-dispatch-closure";
  const adoption = closure.kind === "checked-slice-builder-dispatch-adoption";
  const closureKeys = callback
    ? [...commonClosureKeys, "completion_token", "returned_at"]
    : [...commonClosureKeys, "adopted_at"];
  const expectedHead = entry.attempt === 1 ? slice.attempt_reviews[0].diff_base_commit : slice.attempt_reviews[entry.attempt - 2]?.reviewed_commit;
  if (Object.keys(claim).sort().join("\0") !== [...claimKeys].sort().join("\0") || entry.dispatch_claim_ref !== expectedClaimRef
    || hashFile(claimPath) !== entry.dispatch_claim_hash || claim.schema_version !== 1 || claim.kind !== "checked-slice-builder-dispatch-claim"
    || claim.run_id !== run.run_id || claim.slice_id !== slice.id || claim.attempt !== entry.attempt || claim.agent !== `${slice.stack}-builder`
    || claim.branch !== slice.branch || resolve(claim.worktree) !== resolve(slice.worktree) || claim.head !== expectedHead
    || !HASH_PATTERN.test(claim.context_hash || "") || !HASH_PATTERN.test(claim.completion_token_hash || "")
    || !Number.isFinite(Date.parse(claim.claimed_at || "")) || claim.closure_ref !== expectedClosureRef) {
    throw new Error(`slice '${slice.id}' attempt ${entry.attempt} dispatch claim authority is stale or cross-bound`);
  }
  if ((!callback && !adoption) || Object.keys(closure).sort().join("\0") !== closureKeys.sort().join("\0") || entry.dispatch_closure_ref !== expectedClosureRef
    || hashFile(closurePath) !== entry.dispatch_closure_hash || closure.schema_version !== 1
    || closure.claim_ref !== entry.dispatch_claim_ref || closure.claim_hash !== entry.dispatch_claim_hash || closure.run_id !== claim.run_id
    || closure.slice_id !== claim.slice_id || closure.attempt !== claim.attempt || closure.agent !== claim.agent || closure.branch !== claim.branch
    || resolve(closure.worktree) !== resolve(claim.worktree) || closure.head !== claim.head || closure.completion_head !== entry.reviewed_commit
    || closure.context_hash !== claim.context_hash
    || callback && (!Number.isFinite(Date.parse(closure.returned_at || "")) || sha256ValidationBytes(closure.completion_token) !== claim.completion_token_hash)
    || adoption && !Number.isFinite(Date.parse(closure.adopted_at || ""))) {
    throw new Error(`slice '${slice.id}' attempt ${entry.attempt} dispatch closure authority is stale or cross-bound`);
  }
  return Object.fromEntries(keys.map((key) => [key, entry[key]]));
}

function assertConsistencyReviewedSliceHead(runDir, slice, options = {}) {
  const repository = git(runDir, ["rev-parse", "--show-toplevel"]);
  if (slice.status === "merged") {
    assertConsistencyReviewedMergeProof(repository, slice);
    return;
  }
  const branch = repository.ok ? git(repository.stdout.trim(), ["rev-parse", "--verify", `refs/heads/${slice.branch}^{commit}`]) : null;
  const commit = repository.ok ? git(repository.stdout.trim(), ["rev-parse", "--verify", `${slice.reviewed_commit}^{commit}`]) : null;
  const removedWorktrees = new Set((options.cleanup_removed_worktrees || []).map((worktree) => resolve(worktree)));
  const deletedBranches = new Set(options.cleanup_deleted_branches || []);
  const worktreeWasRemoved = removedWorktrees.has(resolve(slice.worktree));
  const branchWasDeleted = deletedBranches.has(slice.branch);
  const identity = repository?.ok && branch?.ok
    ? checkWorktreeIdentity(repository.stdout.trim(), slice.worktree, { branch: slice.branch, head: slice.reviewed_commit })
    : { ok: false };
  const clean = git(slice.worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const branchIsCurrent = branchWasDeleted ? branch?.ok === false : branch?.stdout.trim() === slice.reviewed_commit;
  const worktreeIsCurrent = worktreeWasRemoved
    ? !existsSync(resolve(slice.worktree))
    : identity.ok && clean.ok && clean.stdout === "";
  if (!FULL_GIT_SHA_PATTERN.test(slice.reviewed_commit || "") || commit?.stdout.trim() !== slice.reviewed_commit
    || !branchIsCurrent || !worktreeIsCurrent) {
    throw new Error(`slice '${slice.id}' persisted sibling owner reviewed branch/worktree head is stale`);
  }
}

function assertConsistencyReviewedMergeProof(repository, slice) {
  if (!repository.ok || !FULL_GIT_SHA_PATTERN.test(slice.reviewed_commit || "") || !FULL_GIT_SHA_PATTERN.test(slice.merge_commit || "")) {
    throw new Error(`slice '${slice.id}' persisted sibling owner merge authority is incomplete`);
  }
  const repo = repository.stdout.trim();
  const parentsResult = git(repo, ["rev-list", "--parents", "-n", "1", slice.merge_commit]);
  const parents = parentsResult.ok ? parentsResult.stdout.trim().split(/\s+/u) : [];
  if (parents.length !== 3 || parents[0] !== slice.merge_commit || parents[2] !== slice.reviewed_commit) {
    throw new Error(`slice '${slice.id}' persisted sibling owner merge parents are stale`);
  }
  const firstParent = parents[1];
  const basesResult = git(repo, ["merge-base", "--all", firstParent, slice.reviewed_commit]);
  const bases = basesResult.ok ? basesResult.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean) : [];
  if (bases.length !== 1 || !FULL_GIT_SHA_PATTERN.test(bases[0]) || bases[0] === slice.reviewed_commit
    || !git(repo, ["merge-base", "--is-ancestor", bases[0], firstParent]).ok
    || !git(repo, ["merge-base", "--is-ancestor", bases[0], slice.reviewed_commit]).ok) {
    throw new Error(`slice '${slice.id}' persisted sibling owner merge base is stale`);
  }
  const reviewedPaths = observeConsistencyPathSet(repo, bases[0], slice.reviewed_commit, `slice '${slice.id}' persisted sibling reviewed diff`);
  const mergedPaths = observeConsistencyPathSet(repo, firstParent, slice.merge_commit, `slice '${slice.id}' persisted sibling merged diff`);
  if (!isDeepStrictEqual([...reviewedPaths].sort(), [...mergedPaths].sort())) {
    throw new Error(`slice '${slice.id}' persisted sibling owner merged path set is stale`);
  }
  for (const path of reviewedPaths) {
    const pathspec = `:(literal)${path}`;
    const reviewedEntry = git(repo, ["ls-tree", "-z", slice.reviewed_commit, "--", pathspec]);
    const mergedEntry = git(repo, ["ls-tree", "-z", slice.merge_commit, "--", pathspec]);
    if (!reviewedEntry.ok || !mergedEntry.ok || reviewedEntry.stdout !== mergedEntry.stdout) {
      throw new Error(`slice '${slice.id}' persisted sibling owner merged tree identity is stale`);
    }
  }
}

function assertConsistencyInvariantFamilyAuthority(runDir, run, plan, owner, review, options = {}) {
  const planHash = hashFile(join(runDir, PLAN_SLICES_REF));
  const extension = validateReviewExtensionResult(evaluateInvariantFamilyReview({
    plan,
    sliceId: owner.id,
    review,
    observeEvidence(ref, disposition) {
      const receiptPath = resolveEvidenceRef(runDir, ref).path;
      const receiptHash = hashFile(receiptPath);
      const receipt = validateVerificationArtifactExecutionReceipt(readInventoryJson(receiptPath, `slice '${owner.id}' invariant-family receipt`));
      const claimRef = verificationArtifactExecutionClaimRef(ref);
      const claimPath = resolveEvidenceRef(runDir, claimRef).path;
      const claim = validateVerificationArtifactExecutionClaim(readInventoryJson(claimPath, `slice '${owner.id}' invariant-family claim`));
      const pairKeys = ["run_id", "slice_id", "attempt", "plan_ref", "plan_hash", "head_sha", "verification_artifact_id", "probe"];
      if (receipt.status !== "pass" || receipt.review_ready !== true || receipt.subject !== owner.id
        || receipt.run_id !== run.run_id || receipt.slice_id !== owner.id || receipt.attempt !== owner.attempts
        || receipt.plan_ref !== PLAN_SLICES_REF || receipt.plan_hash !== planHash || receipt.head_sha !== owner.reviewed_commit
        || receipt.result?.outcome !== "pass" || claim.state !== "completed" || claim.status !== "pass"
        || claim.receipt_ref !== ref || claim.receipt_hash !== receiptHash || receipt.claim_nonce !== claim.nonce
        || pairKeys.some((key) => JSON.stringify(claim[key]) !== JSON.stringify(receipt[key]))) {
        throw new Error(`slice '${owner.id}' invariant-family checked receipt authority is stale or cross-bound`);
      }
      if (options.copiedRunDir) {
        assertConsistencyCopiedArtifact(options.copiedRunDir, runDir, ref, disposition.evidence_hash,
          `slice '${owner.id}' copied invariant-family receipt`);
        assertConsistencyCopiedArtifact(options.copiedRunDir, runDir, claimRef, hashFile(claimPath),
          `slice '${owner.id}' copied invariant-family claim`);
      }
      return { ref, hash: receiptHash, receipt, claim_ref: claimRef, claim };
    },
  }));
  if (plan.delivery_envelope !== undefined && (extension.status !== "active" || extension.decision !== "approve" || extension.grants_b4_authority !== true)) {
    throw new Error(`slice '${owner.id}' persisted sibling owner invariant-family authority is not approving`);
  }
}

function assertConsistencyCopiedArtifact(copiedRunDir, authorityRunDir, ref, expectedHash, label) {
  const authorityPath = resolve(authorityRunDir, ref);
  const copiedPath = resolve(copiedRunDir, ref);
  assertConsistencyRegularFile(authorityRunDir, authorityPath, `${label} authority`);
  assertConsistencyRegularFile(copiedRunDir, copiedPath, label);
  const authorityBytes = readFileSync(authorityPath);
  const copiedBytes = readFileSync(copiedPath);
  if (hashFile(authorityPath) !== expectedHash || hashFile(copiedPath) !== expectedHash
    || !copiedBytes.equals(authorityBytes)) {
    throw new Error(`${label} bytes are stale or cross-bound`);
  }
}

function assertIntegrationAmendmentCurrentConsumerDispatch(runDir, run, consumer) {
  const claimPresent = consumer.dispatch_claim_ref !== undefined || consumer.dispatch_claim_hash !== undefined;
  const closurePresent = consumer.dispatch_closure_ref !== undefined || consumer.dispatch_closure_hash !== undefined;
  if (!claimPresent && !closurePresent) return;
  let completionHead = ["review", "merged"].includes(consumer.status) ? consumer.reviewed_commit : null;
  if (closurePresent && consumer.status === "running") {
    if (!stringValue(consumer.branch) || !stringValue(consumer.worktree)) {
      throw new Error(`integration amendment consumer attempt ${consumer.attempts} dispatch completion Git authority is incomplete`);
    }
    const repositoryResult = git(runDir, ["rev-parse", "--show-toplevel"]);
    const branch = repositoryResult.ok ? git(repositoryResult.stdout.trim(), ["rev-parse", "--verify", `refs/heads/${consumer.branch}^{commit}`]) : null;
    completionHead = branch?.ok ? branch.stdout.trim() : "";
    const identity = repositoryResult.ok && completionHead
      ? checkWorktreeIdentity(repositoryResult.stdout.trim(), consumer.worktree, { branch: consumer.branch, head: completionHead })
      : { ok: false };
    const clean = git(consumer.worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (!FULL_GIT_SHA_PATTERN.test(completionHead) || !identity.ok || !clean.ok || clean.stdout !== "") {
      throw new Error(`integration amendment consumer attempt ${consumer.attempts} dispatch completion Git authority is stale`);
    }
  }
  assertIntegrationAmendmentConsumerDispatch(runDir, run, consumer, { ...consumer, attempt: consumer.attempts }, {
    allowOpen: consumer.status === "running",
    completionHead,
  });
}

function assertIntegrationAmendmentConsumerDispatch(runDir, run, consumer, entry, options = {}) {
  const dispatchKeys = ["dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash"];
  const present = dispatchKeys.filter((key) => entry[key] !== undefined);
  if (present.length === 0) {
    if (consumer.dispatch_required === true) throw new Error(`integration amendment consumer attempt ${entry.attempt} is missing checked dispatch authority`);
    return;
  }
  if (present.length === 2 && options.allowOpen === true && entry.dispatch_claim_ref !== undefined && entry.dispatch_claim_hash !== undefined) {
    // Claim publication is bound before the synchronous builder callback can close it.
  } else if (present.length !== dispatchKeys.length) {
    throw new Error(`integration amendment consumer attempt ${entry.attempt} dispatch authority is incomplete`);
  }
  const expectedName = createHash("sha256").update(`${run.run_id}\0${consumer.id}\0${entry.attempt}`, "utf8").digest("hex");
  const expectedClaimRef = `dispatch/${expectedName}.json`;
  const expectedClosureRef = `dispatch/${expectedName}.closed.json`;
  const claimPath = resolve(runDir, entry.dispatch_claim_ref);
  const claim = readInventoryJson(claimPath, "integration amendment consumer dispatch claim");
  const claimKeys = ["schema_version", "kind", "run_id", "slice_id", "attempt", "agent", "branch", "worktree", "head", "context_hash", "completion_token_hash", "claimed_at", "closure_ref"];
  if (Object.keys(claim).sort().join("\0") !== claimKeys.sort().join("\0") || entry.dispatch_claim_ref !== expectedClaimRef
    || hashFile(claimPath) !== entry.dispatch_claim_hash || claim.schema_version !== 1 || claim.kind !== "checked-slice-builder-dispatch-claim"
    || claim.run_id !== run.run_id || claim.slice_id !== consumer.id || claim.attempt !== entry.attempt || claim.agent !== `${consumer.stack}-builder`
    || claim.branch !== consumer.branch || resolve(claim.worktree) !== resolve(consumer.worktree) || !FULL_GIT_SHA_PATTERN.test(claim.head || "")
    || entry.attempt === 1 && claim.head !== consumer.authorized_baseline_commit
    || entry.attempt > 1 && claim.head !== consumer.attempt_reviews?.find((review) => review.attempt === entry.attempt - 1)?.reviewed_commit
    || !HASH_PATTERN.test(claim.context_hash || "") || !HASH_PATTERN.test(claim.completion_token_hash || "")
    || !Number.isFinite(Date.parse(claim.claimed_at || "")) || claim.closure_ref !== expectedClosureRef) {
    throw new Error(`integration amendment consumer attempt ${entry.attempt} dispatch claim authority is stale or cross-bound`);
  }
  if (present.length === 2) return;
  const closurePath = resolve(runDir, entry.dispatch_closure_ref);
  const closure = readInventoryJson(closurePath, "integration amendment consumer dispatch closure");
  const closureKeys = ["schema_version", "kind", "claim_ref", "claim_hash", "run_id", "slice_id", "attempt", "agent", "branch", "worktree", "head", "completion_head", "context_hash", "completion_token", "returned_at"];
  const expectedCompletionHead = options.completionHead || entry.reviewed_commit || closure.completion_head;
  if (Object.keys(closure).sort().join("\0") !== closureKeys.sort().join("\0") || entry.dispatch_closure_ref !== expectedClosureRef
    || hashFile(closurePath) !== entry.dispatch_closure_hash || closure.schema_version !== 1 || closure.kind !== "checked-slice-builder-dispatch-closure"
    || closure.claim_ref !== entry.dispatch_claim_ref || closure.claim_hash !== entry.dispatch_claim_hash || closure.run_id !== claim.run_id
    || closure.slice_id !== claim.slice_id || closure.attempt !== claim.attempt || closure.agent !== claim.agent || closure.branch !== claim.branch
    || resolve(closure.worktree) !== resolve(claim.worktree) || closure.head !== claim.head || closure.completion_head !== expectedCompletionHead
    || !Number.isFinite(Date.parse(closure.returned_at || "")) || closure.context_hash !== claim.context_hash
    || sha256ValidationBytes(closure.completion_token) !== claim.completion_token_hash) {
    throw new Error(`integration amendment consumer attempt ${entry.attempt} dispatch authority is stale or cross-bound`);
  }
}

function assertIntegrationAmendmentDispatchBinding(runDir, run, amendment, attempt) {
  const claimPath = resolve(runDir, attempt.dispatch_claim_ref);
  const closurePath = resolve(runDir, attempt.dispatch_closure_ref);
  const claim = readInventoryJson(claimPath, "integration amendment dispatch claim");
  const closure = readInventoryJson(closurePath, "integration amendment dispatch closure");
  const claimKeys = ["schema_version", "kind", "run_id", "route", "instance", "agent", "branch", "worktree", "head", "run_hash", "context_hash", "completion_token_hash", "claimed_at", "closure_ref"];
  const closureKeys = ["schema_version", "kind", "claim_ref", "claim_hash", "run_id", "route", "instance", "agent", "branch", "worktree", "head", "completion_head", "run_hash", "context_hash", "completion_token", "returned_at"];
  const instance = `${amendment.amendment_id}:attempt-${attempt.attempt}`;
  if (Object.keys(claim).sort().join("\0") !== [...claimKeys].sort().join("\0") || claim.schema_version !== 1 || claim.kind !== "checked-special-builder-dispatch-claim"
    || claim.run_id !== run.run_id || claim.route !== "integration-amendment" || claim.instance !== instance || claim.agent !== `${amendment.admission.owner.stack}-builder`
    || claim.branch !== attempt.branch_ref.slice("refs/heads/".length) || resolve(claim.worktree) !== resolve(attempt.worktree) || claim.head !== attempt.build_base_commit
    || claim.closure_ref !== attempt.dispatch_closure_ref || hashFile(claimPath) !== attempt.dispatch_claim_hash) throw new Error("integration amendment dispatch claim binding is stale or cross-bound");
  if (Object.keys(closure).sort().join("\0") !== [...closureKeys].sort().join("\0") || closure.schema_version !== 1 || closure.kind !== "checked-special-builder-dispatch-closure"
    || closure.claim_ref !== attempt.dispatch_claim_ref || closure.claim_hash !== attempt.dispatch_claim_hash || closure.run_id !== claim.run_id || closure.route !== claim.route
    || closure.instance !== claim.instance || closure.agent !== claim.agent || closure.branch !== claim.branch || resolve(closure.worktree) !== resolve(claim.worktree)
    || closure.head !== claim.head || closure.completion_head !== attempt.reviewed_commit || closure.run_hash !== claim.run_hash || closure.context_hash !== claim.context_hash
    || sha256ValidationBytes(closure.completion_token) !== claim.completion_token_hash || hashFile(closurePath) !== attempt.dispatch_closure_hash) throw new Error("integration amendment dispatch closure binding is stale or cross-bound");
}

function integrationAmendmentReviewProvenanceRefs(runId, amendmentId, attempt) {
  const name = createHash("sha256").update(`${runId}\0integration-amendment-review\0${amendmentId}\0${attempt}`, "utf8").digest("hex");
  const claimRef = `dispatch/${name}.amendment-review.json`;
  return { claim_ref: claimRef, closure_ref: `${claimRef.slice(0, -5)}.closed.json` };
}

function assertIntegrationAmendmentReviewPublication(runDir, run, amendment, attempt) {
  const refs = integrationAmendmentReviewProvenanceRefs(run.run_id, amendment.amendment_id, attempt.attempt);
  const claimPath = resolve(runDir, refs.claim_ref);
  const closurePath = resolve(runDir, refs.closure_ref);
  const claim = readInventoryJson(claimPath, "integration amendment reviewer claim");
  const closure = readInventoryJson(closurePath, "integration amendment reviewer closure");
  const expectedReviewRef = `reviews/integration-amendment-${amendment.amendment_id}.attempt-${attempt.attempt}.json`;
  const expectedCandidate = attempt.candidate_commit || run.special_builder_dispatch?.completion_head;
  const observedTree = expectedCandidate ? git(runDir, ["rev-parse", "--verify", `${expectedCandidate}^{tree}`]) : null;
  const expectedTree = attempt.candidate_tree || (observedTree?.ok ? observedTree.stdout.trim() : "");
  validateIntegrationAmendmentReviewDispatchClaim(claim, {
    claim_ref: refs.claim_ref, run_id: run.run_id, amendment_id: amendment.amendment_id, attempt: attempt.attempt, agent: "work-reviewer",
    baseline_commit: amendment.admission.baseline_commit, candidate_commit: expectedCandidate, candidate_tree: expectedTree,
    review_ref: expectedReviewRef, closure_ref: refs.closure_ref,
  });
  const claimHash = hashFile(claimPath);
  validateIntegrationAmendmentReviewDispatchClosure(closure, {
    claim_ref: refs.claim_ref, claim_hash: claimHash, run_id: claim.run_id, amendment_id: claim.amendment_id, attempt: claim.attempt,
    agent: claim.agent, context_hash: claim.context_hash, review_ref: expectedReviewRef, completion_token_hash: claim.completion_token_hash,
  });
  const reviewPath = resolveReviewRef(runDir, expectedReviewRef).path;
  if (hashFile(reviewPath) !== closure.review_hash || attempt.review_hash && attempt.review_hash !== closure.review_hash) {
    throw new Error("integration amendment reviewer publication hash is stale");
  }
}

function assertIntegrationAmendmentChangedPathOwnership(run, amendment, changedPaths) {
  for (const path of changedPaths || []) {
    const owners = (run.slices || []).filter((slice) => (slice.effective_paths || []).some((lane) => {
      const normalized = canonicalPlanOwnershipLane(lane, [], "lane");
      return normalized && planLaneOwnsConcretePath(normalized, path);
    }));
    if (owners.length !== 1 || owners[0].id !== amendment.owner_slice_id) {
      throw new Error(`integration amendment changed path '${path}' is not solely owned by admitted owner '${amendment.owner_slice_id}'`);
    }
  }
}

function sha256ValidationBytes(value) {
  return `sha256:${createHash("sha256").update(Buffer.from(String(value), "utf8")).digest("hex")}`;
}

function assertIntegrationAmendmentVerificationBinding(runDir, run, amendment) {
  const binding = amendment.verification;
  const claimPath = resolveEvidenceRef(runDir, binding.claim_ref).path;
  const receiptPath = resolveEvidenceRef(runDir, binding.receipt_ref).path;
  const claim = validateIntegrationAmendmentExecutionClaim(readInventoryJson(claimPath, "integration amendment verification claim"));
  const receipt = validateIntegrationAmendmentExecutionReceipt(readInventoryJson(receiptPath, "integration amendment verification receipt"));
  const receiptHash = hashFile(receiptPath);
  assertIntegrationAmendmentReceiptClaimPair(claim, receipt, receiptHash);
  if (claim.phase !== "verify" || claim.state !== "completed" || claim.status !== "pass" || receipt.status !== "pass" || receipt.review_ready !== true
    || claim.amendment_id !== amendment.amendment_id || claim.run_id !== run.run_id || claim.head_sha !== amendment.integration.commit || claim.tree_sha !== amendment.integration.tree
    || binding.claim_hash !== hashFile(claimPath) || binding.receipt_hash !== receiptHash) throw new Error("integration amendment verification binding is stale or cross-bound");
}

function assertIntegrationAmendmentReceiptClaimPair(claim, receipt, receiptHash) {
  for (const key of ["phase", "subject", "run_id", "amendment_id", "probe", "head_sha", "tree_sha", "cwd"]) {
    if (JSON.stringify(claim[key]) !== JSON.stringify(receipt[key])) throw new Error(`integration amendment receipt ${key} is cross-bound`);
  }
  if (effectiveCheckedExecutionTimeoutMs(claim.timeout_ms) !== effectiveCheckedExecutionTimeoutMs(receipt.timeout_ms)) throw new Error("integration amendment receipt timeout_ms is cross-bound");
  if (receipt.claim_nonce !== claim.nonce) throw new Error("integration amendment receipt nonce is cross-bound");
  if (claim.state === "completed" && claim.receipt_hash !== receiptHash) throw new Error("integration amendment receipt hash is stale");
}

function assertIntegrationAmendmentGitConsistency(runDir, run, amendment, options = {}) {
  const repositoryResult = git(runDir, ["rev-parse", "--show-toplevel"]);
  if (!repositoryResult.ok) throw new Error("integration amendment consistency requires a Git repository");
  const repository = repositoryResult.stdout.trim();
  const baselineBranch = amendment.admission.baseline_ref.slice("refs/heads/".length);
  const resolveCommit = (ref, label) => {
    const result = git(repository, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (!result.ok || !FULL_GIT_SHA_PATTERN.test(result.stdout.trim())) throw new Error(`${label} does not resolve`);
    return result.stdout.trim();
  };
  const featureHead = resolveCommit(amendment.admission.baseline_ref, "integration amendment baseline ref");
  const allowedFeatureHeads = amendment.status === "merged" ? integrationAmendmentFeatureHeads(runDir, repository, run, amendment, featureHead, options)
    : amendment.status === "verified" ? [amendment.admission.baseline_commit, amendment.integration?.commit]
      : [amendment.admission.baseline_commit];
  if (!allowedFeatureHeads.includes(featureHead)) throw new Error("integration amendment feature ref moved outside recoverable publication authority");
  const featureBranch = amendment.admission.baseline_ref.slice("refs/heads/".length);
  const featureIdentity = checkWorktreeIdentity(repository, amendment.admission.worktree, { branch: featureBranch, head: featureHead });
  if (!featureIdentity.ok) throw new Error(`integration amendment feature worktree identity is stale: ${featureIdentity.reason}`);
  const featureIndex = git(amendment.admission.worktree, ["write-tree"]);
  const featureTracked = git(amendment.admission.worktree, ["diff-files", "--quiet"]);
  const featureUntracked = git(amendment.admission.worktree, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const featureMerge = git(amendment.admission.worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  const gitDir = git(amendment.admission.worktree, ["rev-parse", "--git-dir"]);
  const gitDirectory = gitDir.ok ? resolve(amendment.admission.worktree, gitDir.stdout.trim()) : null;
  const featureRebase = gitDirectory && (existsSync(join(gitDirectory, "rebase-merge")) || existsSync(join(gitDirectory, "rebase-apply")));
  if (!featureIndex.ok || !featureTracked.ok || !featureUntracked.ok || featureUntracked.stdout !== "" || featureMerge.ok || featureRebase) {
    throw new Error("integration amendment feature worktree is dirty or has an in-progress Git operation");
  }
  const featureHeadTree = git(repository, ["rev-parse", "--verify", `${featureHead}^{tree}`]);
  const allowedIndexTrees = amendment.status === "merged" ? [featureHeadTree.ok ? featureHeadTree.stdout.trim() : null]
    : amendment.status === "verified" && featureHead === amendment.integration?.commit ? [amendment.admission.baseline_tree, amendment.integration?.tree]
      : [amendment.admission.baseline_tree];
  if (!allowedIndexTrees.includes(featureIndex.stdout.trim())) throw new Error("integration amendment feature worktree index is outside recoverable publication authority");
  if (resolveCommit(amendment.admission.baseline_commit, "integration amendment baseline commit") !== amendment.admission.baseline_commit) throw new Error("integration amendment baseline commit is stale");
  const baselineTree = git(repository, ["rev-parse", "--verify", `${amendment.admission.baseline_commit}^{tree}`]);
  if (!baselineTree.ok || baselineTree.stdout.trim() !== amendment.admission.baseline_tree) throw new Error("integration amendment baseline tree is stale");
  for (const attempt of amendment.attempts || []) {
    const expectedWorktree = resolve(repository, ".opencode", "worktrees", `${baselineBranch}--amend-${amendment.amendment_id}-a${attempt.attempt}`);
    if (realpathSync(attempt.worktree) !== realpathSync(expectedWorktree)) throw new Error("integration amendment attempt worktree is outside the deterministic repository-root path");
    if (resolveCommit(attempt.branch_ref, `integration amendment attempt ${attempt.attempt} branch`) !== (attempt.state === "reviewed" ? attempt.reviewed_commit : attempt.build_base_commit)) throw new Error("integration amendment attempt branch is stale");
    if (attempt.state === "reviewed") {
      const tree = git(repository, ["rev-parse", "--verify", `${attempt.reviewed_commit}^{tree}`]);
      const diff = git(repository, ["diff", "--name-only", "-z", "--no-renames", amendment.admission.baseline_commit, attempt.reviewed_commit]);
      const paths = diff.ok ? diff.stdout.split("\0").filter(Boolean).sort() : [];
      if (!tree.ok || tree.stdout.trim() !== attempt.reviewed_tree || JSON.stringify(paths) !== JSON.stringify(attempt.changed_paths)) throw new Error("integration amendment reviewed Git authority is stale");
    }
  }
  if (isRecord(amendment.integration)) {
    const expectedWorktree = resolve(repository, ".opencode", "worktrees", `${baselineBranch}--amend-${amendment.amendment_id}-staged`);
    if (realpathSync(amendment.integration.worktree) !== realpathSync(expectedWorktree)) throw new Error("integration amendment staging worktree is outside the deterministic repository-root path");
    if (resolveCommit(amendment.integration.ref, "integration amendment staging ref") !== amendment.integration.commit) throw new Error("integration amendment staging ref is stale");
    const tree = git(repository, ["rev-parse", "--verify", `${amendment.integration.commit}^{tree}`]);
    if (!tree.ok || tree.stdout.trim() !== amendment.integration.tree || amendment.integration.tree !== amendment.attempts.at(-1)?.reviewed_tree) throw new Error("integration amendment staged tree is stale");
  }
  if (amendment.status === "merged") {
    if (amendment.publication.branch_ref !== amendment.admission.baseline_ref || amendment.publication.commit !== amendment.integration.commit
      || amendment.publication.previous_commit !== amendment.admission.baseline_commit) throw new Error("integration amendment immutable publication proof is stale");
    const worktreeHead = git(amendment.admission.worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const clean = git(amendment.admission.worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (!worktreeHead.ok || worktreeHead.stdout.trim() !== featureHead || !clean.ok || clean.stdout !== "") throw new Error("integration amendment published worktree or downstream checked head is stale or dirty");
  }
}

function integrationAmendmentFeatureHeads(runDir, repository, run, amendment, featureHead, options) {
  const integrationCommit = amendment.integration?.commit;
  if (!FULL_GIT_SHA_PATTERN.test(integrationCommit || "")) throw new Error("integration amendment merged integration commit is invalid");
  const rows = new Map();
  for (const slice of run.slices || []) {
    if (slice.status !== "merged" || slice.merge_commit === integrationCommit) continue;
    const descendant = git(repository, ["merge-base", "--is-ancestor", integrationCommit, slice.merge_commit]);
    if (!descendant.ok) continue;
    if (rows.has(slice.merge_commit)) throw new Error("integration amendment downstream merge commit is bound by multiple slices");
    assertIntegrationAmendmentConsumerProgress(runDir, run, slice);
    rows.set(slice.merge_commit, slice);
  }
  const pending = options.pending_slice_merge;
  if (pending) {
    const slice = (run.slices || []).find((entry) => entry.id === pending.slice_id);
    if (!slice || slice.status !== "review" || pending.merge_commit !== featureHead || rows.has(pending.merge_commit)) {
      throw new Error("integration amendment pending checked slice merge authority is stale");
    }
    rows.set(pending.merge_commit, { ...slice, status: "merged", merge_commit: pending.merge_commit, pending: true });
  }
  if (featureHead === integrationCommit) {
    if (rows.size !== 0) throw new Error("integration amendment recorded downstream merge is not reflected by the feature head");
    return [integrationCommit];
  }
  const seen = new Set();
  let cursor = featureHead;
  while (cursor !== integrationCommit) {
    const slice = rows.get(cursor);
    if (!slice || seen.has(cursor)) throw new Error("integration amendment feature head is not justified by the checked slice merge chain");
    const proof = observeIntegrationAmendmentSliceMergeProof(repository, slice);
    seen.add(cursor);
    cursor = proof.first_parent;
  }
  if ([...rows.keys()].some((commit) => !seen.has(commit))) throw new Error("integration amendment downstream merge chain omits current merged slice authority");
  return [featureHead];
}

function observeIntegrationAmendmentSliceMergeProof(repository, slice) {
  const parentsResult = git(repository, ["rev-list", "--parents", "-n", "1", slice.merge_commit]);
  const parents = parentsResult.ok ? parentsResult.stdout.trim().split(/\s+/u) : [];
  if (parents.length !== 3 || parents[0] !== slice.merge_commit || parents[2] !== slice.reviewed_commit) {
    throw new Error(`integration amendment downstream slice '${slice.id}' merge parents are stale`);
  }
  const firstParent = parents[1];
  const basesResult = git(repository, ["merge-base", "--all", firstParent, slice.reviewed_commit]);
  const bases = basesResult.ok ? basesResult.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean) : [];
  if (bases.length !== 1 || bases[0] === slice.reviewed_commit || !FULL_GIT_SHA_PATTERN.test(bases[0] || "")) {
    throw new Error(`integration amendment downstream slice '${slice.id}' merge base is stale`);
  }
  const reviewedPaths = integrationAmendmentGitPathSet(repository, bases[0], slice.reviewed_commit);
  const mergedPaths = integrationAmendmentGitPathSet(repository, firstParent, slice.merge_commit);
  const ownershipPaths = integrationAmendmentGitPathSet(repository, slice.authorized_baseline_commit, slice.reviewed_commit);
  if (bases[0] !== slice.authorized_baseline_commit) throw new Error(`integration amendment downstream slice '${slice.id}' merge base differs from its authorized baseline`);
  if (JSON.stringify(reviewedPaths) !== JSON.stringify(ownershipPaths)) throw new Error(`integration amendment downstream slice '${slice.id}' merge paths differ from ownership review`);
  if (JSON.stringify(reviewedPaths) !== JSON.stringify(mergedPaths)) throw new Error(`integration amendment downstream slice '${slice.id}' merged paths differ from review`);
  for (const path of reviewedPaths) {
    const literal = `:(literal)${path}`;
    const reviewed = git(repository, ["ls-tree", "-z", slice.reviewed_commit, "--", literal]);
    const merged = git(repository, ["ls-tree", "-z", slice.merge_commit, "--", literal]);
    if (!reviewed.ok || !merged.ok || reviewed.stdout !== merged.stdout) throw new Error(`integration amendment downstream slice '${slice.id}' merged tree differs from review`);
  }
  return { first_parent: firstParent };
}

function integrationAmendmentGitPathSet(repository, from, to) {
  const result = git(repository, ["diff", "--name-only", "-z", "--no-renames", from, to]);
  if (!result.ok) throw new Error("integration amendment downstream slice paths cannot be observed");
  return result.stdout.split("\0").filter(Boolean).sort();
}

function safeInventoryNames(path, label) {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${label} must be a regular directory`);
  return readdirSync(path);
}

function integrationAmendmentDispatchInventory(runDir) {
  const dispatchDir = join(runDir, "dispatch");
  if (!existsSync(dispatchDir)) return [];
  const names = safeInventoryNames(dispatchDir, "integration amendment dispatch directory");
  const entries = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".special.json") || candidate.endsWith(".special.closed.json")
    || candidate.endsWith(".amendment-review.json") || candidate.endsWith(".amendment-review.closed.json"))) {
    const path = join(dispatchDir, name);
    const value = readInventoryJson(path, "integration amendment dispatch sidecar");
    if (value.route === "integration-amendment" || value.kind === "checked-integration-amendment-review-dispatch-claim"
      || value.kind === "checked-integration-amendment-review-dispatch-closure") entries.push({ ref: `dispatch/${name}`, hash: hashFile(path), value });
  }
  return entries;
}

function readInventoryJson(path, label) {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`${label} must be valid JSON: ${error.message}`); }
}

function canonicalIntegrationAmendmentJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalIntegrationAmendmentJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalIntegrationAmendmentJson(value[key])}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("integration amendment canonical identity contains a non-JSON value");
  return encoded;
}

function gateApprovalFingerprint(gateName, gate, receipt) {
  return hashValue({
    gate: gateName,
    status: gate.status,
    artifact: gate.artifact,
    question_ref: gate.question_ref,
    answer_ref: gate.answer_ref || null,
    answer: gate.answer,
    approval_source: gate.approval_source,
    decision_note: gate.decision_note || null,
    answered_at: gate.answered_at,
    pending_snapshot_hash: receipt.pending_snapshot_hash,
    answer_hash: receipt.answer_hash,
    steering_generation: receipt.steering_generation,
    accepted_at: receipt.accepted_at,
  });
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
    const revalidation = remediation.revalidation;
    for (const [activity, resolver] of [["canonical", resolveEvidenceRef], ["validator", resolveReviewRef], ["security", resolveReviewRef]]) {
      const job = revalidation?.jobs?.[activity];
      if (!isRecord(job) || job.status !== "bound") continue;
      checks.push(runCheck(`run.post_pr.remediation.revalidation.jobs.${activity}.result`, () => {
        const resolved = resolver(runDir, job.result_ref);
        const actualHash = hashFile(resolved.path, { mode: "raw" });
        if (actualHash !== job.result_hash) fail([{ path: `run.post_pr.remediation.revalidation.jobs.${activity}.result_hash`, message: "must match exact result_ref bytes" }]);
        let result;
        try {
          result = JSON.parse(readFileSync(resolved.path, "utf8"));
        } catch (error) {
          fail([{ path: `run.post_pr.remediation.revalidation.jobs.${activity}.result_ref`, message: `must contain valid JSON result bytes: ${error.message}` }]);
        }
        if (!isRecord(result)) fail([{ path: `run.post_pr.remediation.revalidation.jobs.${activity}.result_ref`, message: "must contain a JSON object result" }]);
        if (result.verdict !== job.verdict) fail([{ path: `run.post_pr.remediation.revalidation.jobs.${activity}.verdict`, message: "must equal the verdict in exact result_ref bytes" }]);
        if (Object.hasOwn(result, "dispatch_id") && result.dispatch_id !== job.dispatch_id) {
          fail([{ path: `run.post_pr.remediation.revalidation.jobs.${activity}.dispatch_id`, message: "must equal dispatch_id in exact result_ref bytes when present" }]);
        }
        return { ref: resolved.ref, path: resolved.path, hash: actualHash, verdict: result.verdict };
      }));
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

function resolvePlanSlicesRef(runDir, ref) {
  if (ref !== PLAN_SLICES_REF) throw new Error(`plan ref must be exactly ${PLAN_SLICES_REF}`);
  const planDir = join(resolve(runDir), "plan");
  const planPath = join(planDir, "slices.json");
  if (!existsSync(planDir) || lstatSync(planDir).isSymbolicLink() || !lstatSync(planDir).isDirectory()) throw new Error("plan root must be a regular directory, not a symlink");
  if (!existsSync(planPath) || lstatSync(planPath).isSymbolicLink() || !lstatSync(planPath).isFile()) throw new Error("plan/slices.json must be a regular non-symlink file");
  return { ref: PLAN_SLICES_REF, path: planPath };
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

function validateSlicesPlanFile(file, run) {
  try {
    const bytes = readFileSync(file);
    const plan = parseSlicesPlanBytes(bytes, { label: PLAN_SLICES_REF, enforceDependencyDepth: false });
    validateRunSlicesPlanAuthority(dirname(dirname(file)), run, plan);
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
    const message = error?.code === "ENOENT" ? "referenced authority file does not exist" : error.message;
    return { name, ok: false, errors: error instanceof ValidationError ? error.errors : [{ path: name, message }] };
  }
}

function validateGateMap(errors, run, path) {
  const gates = run.gates;
  if (gates === undefined || gates === null) return;
  if (!isRecord(gates)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  for (const [name, gate] of Object.entries(gates)) {
    validateGateName(errors, name, `${path}.${name}`);
    validateGate(errors, run, gate, `${path}.${name}`, name);
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

export function validateIntegrationAmendment(value, { run = null } = {}) {
  const errors = [];
  validateIntegrationAmendmentRecord(errors, { ...(run || {}), integration_amendment: value }, "integration_amendment");
  if (errors.length) fail(errors);
  return value;
}

function validateIntegrationAmendmentRecord(errors, run, path) {
  const amendment = run.integration_amendment;
  if (amendment === undefined || amendment === null) return;
  if (!isRecord(amendment)) { errors.push({ path, message: "must be an object" }); return; }
  const extra = amendment.status === "integrated" ? ["integration"]
    : amendment.status === "verified" ? ["integration", "verification"]
      : amendment.status === "merged" ? ["integration", "verification", "publication"]
        : amendment.status === "blocked" ? ["blocked", ...(amendment.blocked?.origin === "integrated" ? ["integration"] : amendment.blocked?.origin === "verified" ? ["integration", "verification"] : [])]
          : [];
  allowedKeys(errors, amendment, new Set([...INTEGRATION_AMENDMENT_COMMON_KEYS, ...extra]), path);
  requiredInteger(errors, amendment, "schema_version", `${path}.schema_version`);
  if (amendment.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  requiredEnum(errors, amendment, "kind", new Set(["integration-amendment"]), `${path}.kind`);
  requiredString(errors, amendment, "amendment_id", `${path}.amendment_id`);
  if (stringValue(amendment.amendment_id) && !AMENDMENT_ID_PATTERN.test(amendment.amendment_id)) errors.push({ path: `${path}.amendment_id`, message: "must be an unpadded 43-character SHA-256 base64url digest" });
  requiredEnum(errors, amendment, "status", new Set(["reported", "building", "reviewed", "integrated", "verified", "merged", "blocked"]), `${path}.status`);
  for (const key of ["owner_slice_id", "consumer_slice_id", "verification_artifact_id"]) requiredString(errors, amendment, key, `${path}.${key}`);
  if (amendment.owner_slice_id === amendment.consumer_slice_id) errors.push({ path: `${path}.consumer_slice_id`, message: "must differ from owner_slice_id" });
  if (!isCanonicalConcreteRepositoryPath(amendment.defect_path)) errors.push({ path: `${path}.defect_path`, message: "must be a canonical concrete repository path" });
  validateIntegrationAmendmentAdmission(errors, amendment.admission, `${path}.admission`);
  validateIntegrationAmendmentExecutionBinding(errors, amendment.failure_execution, `${path}.failure_execution`, amendment.amendment_id, "report");
  boundedInteger(errors, amendment, "max_attempts", 2, 2, `${path}.max_attempts`);
  if (!Array.isArray(amendment.attempts) || amendment.attempts.length > 2) errors.push({ path: `${path}.attempts`, message: "must be an append-only array of at most two attempts" });
  else amendment.attempts.forEach((attempt, index) => validateIntegrationAmendmentAttempt(errors, attempt, `${path}.attempts[${index}]`, index + 1, amendment));
  requiredTimestamp(errors, amendment, "created_at", `${path}.created_at`);
  requiredTimestamp(errors, amendment, "updated_at", `${path}.updated_at`);
  validateIntegrationAmendmentVariant(errors, amendment, path);
  if (isRecord(amendment.admission)) {
    if (amendment.owner_slice_id !== amendment.admission.owner?.id) errors.push({ path: `${path}.owner_slice_id`, message: "must match admission.owner.id" });
    if (amendment.consumer_slice_id !== amendment.admission.consumer?.id) errors.push({ path: `${path}.consumer_slice_id`, message: "must match admission.consumer.id" });
    if (amendment.verification_artifact_id !== amendment.admission.probe?.verification_artifact_id) errors.push({ path: `${path}.verification_artifact_id`, message: "must match admission.probe.verification_artifact_id" });
  }
}

function validateIntegrationAmendmentAdmission(errors, admission, path) {
  if (!isRecord(admission)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, admission, INTEGRATION_AMENDMENT_ADMISSION_KEYS, path);
  requiredString(errors, admission, "baseline_ref", `${path}.baseline_ref`);
  if (stringValue(admission.baseline_ref) && !/^refs\/heads\/.+/u.test(admission.baseline_ref)) errors.push({ path: `${path}.baseline_ref`, message: "must be a full refs/heads ref" });
  for (const key of ["baseline_commit", "baseline_tree"]) requiredFullGitSha(errors, admission, key, `${path}.${key}`);
  optionalAbsolutePath(errors, admission, "worktree", `${path}.worktree`);
  if (!stringValue(admission.worktree)) errors.push({ path: `${path}.worktree`, message: "must be an absolute path" });
  validateIntegrationAmendmentProbe(errors, admission.probe, `${path}.probe`);
  validateIntegrationAmendmentOwner(errors, admission.owner, `${path}.owner`);
  validateIntegrationAmendmentConsumer(errors, admission.consumer, `${path}.consumer`);
}

function validateIntegrationAmendmentOwner(errors, owner, path) {
  if (!isRecord(owner)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, owner, INTEGRATION_AMENDMENT_OWNER_KEYS, path);
  for (const key of ["id", "stack", "evidence_ref", "review_ref"]) requiredString(errors, owner, key, `${path}.${key}`);
  validateStringArray(errors, owner.depends_on, `${path}.depends_on`, { required: true });
  validateDurableOwnershipPaths(errors, owner.declared_paths, `${path}.declared_paths`, { concreteOnly: false });
  validateDurableOwnershipPaths(errors, owner.effective_paths, `${path}.effective_paths`, { concreteOnly: false });
  if (owner.status !== "merged") errors.push({ path: `${path}.status`, message: "must equal merged" });
  boundedInteger(errors, owner, "attempts", 1, 3, `${path}.attempts`);
  if (!Array.isArray(owner.attempt_reviews) || owner.attempt_reviews.length < 1) errors.push({ path: `${path}.attempt_reviews`, message: "must be the complete nonempty immutable attempt history" });
  else validateSliceAttemptReviews(errors, owner, path);
  for (const key of ["evidence_hash", "review_hash"]) requiredHash(errors, owner, key, `${path}.${key}`);
  for (const key of ["reviewed_commit", "merge_commit"]) requiredFullGitSha(errors, owner, key, `${path}.${key}`);
}

function validateIntegrationAmendmentConsumer(errors, consumer, path) {
  if (!isRecord(consumer)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, consumer, INTEGRATION_AMENDMENT_CONSUMER_KEYS, path);
  for (const key of ["id", "stack"]) requiredString(errors, consumer, key, `${path}.${key}`);
  validateStringArray(errors, consumer.depends_on, `${path}.depends_on`, { required: true });
  validateDurableOwnershipPaths(errors, consumer.declared_paths, `${path}.declared_paths`, { concreteOnly: false });
  validateDurableOwnershipPaths(errors, consumer.effective_paths, `${path}.effective_paths`, { concreteOnly: false });
  if (consumer.status !== "pending") errors.push({ path: `${path}.status`, message: "must equal pending" });
  if (consumer.attempts !== 0) errors.push({ path: `${path}.attempts`, message: "must equal 0" });
}

function validateIntegrationAmendmentProbe(errors, probe, path) {
  if (!isRecord(probe)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, probe, INTEGRATION_AMENDMENT_PROBE_KEYS, path);
  if (probe.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  if (probe.kind !== "integration-amendment-probe") errors.push({ path: `${path}.kind`, message: "must equal integration-amendment-probe" });
  for (const key of ["delivery_unit_id", "consumer_slice_id", "verification_artifact_id", "test_plan_entry"]) requiredString(errors, probe, key, `${path}.${key}`);
  boundedInteger(errors, probe, "test_plan_index", 0, Number.MAX_SAFE_INTEGER, `${path}.test_plan_index`);
  validateIntegrationProgram(errors, probe.program, `${path}.program`);
  validateIntegrationArgs(errors, probe.args, `${path}.args`);
  optionalCheckedExecutionTimeout(errors, probe, `${path}.timeout_ms`);
  if (probe.substrate !== "feature-baseline") errors.push({ path: `${path}.substrate`, message: "must equal feature-baseline" });
}

function validateIntegrationAmendmentExecutionBinding(errors, binding, path, amendmentId, phase) {
  if (!isRecord(binding)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, binding, INTEGRATION_AMENDMENT_EXECUTION_BINDING_KEYS, path);
  for (const key of ["claim_ref", "receipt_ref"]) requiredString(errors, binding, key, `${path}.${key}`);
  for (const key of ["claim_hash", "receipt_hash"]) requiredHash(errors, binding, key, `${path}.${key}`);
  const claimRef = phase === "report" ? "evidence/integration-amendment.report.claim.json" : `evidence/integration-amendment-${amendmentId}.verify.claim.json`;
  const receiptRef = `evidence/integration-amendment-${amendmentId}.${phase}.receipt.json`;
  if (binding.claim_ref !== claimRef) errors.push({ path: `${path}.claim_ref`, message: `must equal ${claimRef}` });
  if (binding.receipt_ref !== receiptRef) errors.push({ path: `${path}.receipt_ref`, message: `must equal ${receiptRef}` });
}

function validateIntegrationAmendmentAttempt(errors, attempt, path, number, amendment) {
  if (!isRecord(attempt)) { errors.push({ path, message: "must be an object" }); return; }
  const reviewed = attempt.state === "reviewed";
  allowedKeys(errors, attempt, reviewed ? INTEGRATION_AMENDMENT_REVIEWED_KEYS : INTEGRATION_AMENDMENT_BUILDING_KEYS, path);
  if (attempt.attempt !== number) errors.push({ path: `${path}.attempt`, message: `must equal ${number}` });
  requiredEnum(errors, attempt, "state", new Set(["building", "reviewed"]), `${path}.state`);
  requiredFullGitSha(errors, attempt, "build_base_commit", `${path}.build_base_commit`);
  requiredString(errors, attempt, "branch_ref", `${path}.branch_ref`);
  if (stringValue(attempt.branch_ref) && !/^refs\/heads\/.+/u.test(attempt.branch_ref)) errors.push({ path: `${path}.branch_ref`, message: "must be a full refs/heads ref" });
  optionalAbsolutePath(errors, attempt, "worktree", `${path}.worktree`);
  if (!stringValue(attempt.worktree)) errors.push({ path: `${path}.worktree`, message: "must be an absolute path" });
  const baselineBranch = amendment.admission?.baseline_ref?.startsWith("refs/heads/") ? amendment.admission.baseline_ref.slice("refs/heads/".length) : null;
  const expectedBranch = baselineBranch ? `refs/heads/${baselineBranch}--amend-${amendment.amendment_id}-a${number}` : null;
  const expectedWorktreeSuffix = baselineBranch ? `${sep}.opencode${sep}worktrees${sep}${baselineBranch}--amend-${amendment.amendment_id}-a${number}` : null;
  if (expectedBranch && attempt.branch_ref !== expectedBranch) errors.push({ path: `${path}.branch_ref`, message: "must equal the deterministic amendment attempt branch" });
  if (expectedWorktreeSuffix && !resolve(attempt.worktree || "/").endsWith(expectedWorktreeSuffix)) errors.push({ path: `${path}.worktree`, message: "must use the deterministic repository-root amendment attempt worktree" });
  if (!reviewed) return;
  for (const key of ["dispatch_claim_ref", "dispatch_closure_ref", "review_ref"]) requiredString(errors, attempt, key, `${path}.${key}`);
  for (const key of ["dispatch_claim_hash", "dispatch_closure_hash", "review_hash"]) requiredHash(errors, attempt, key, `${path}.${key}`);
  for (const key of ["candidate_commit", "candidate_tree", "reviewed_commit", "reviewed_tree"]) requiredFullGitSha(errors, attempt, key, `${path}.${key}`);
  validateCanonicalConcretePathSet(errors, attempt.changed_paths, `${path}.changed_paths`, { allowEmpty: false, sorted: true });
  if (Array.isArray(attempt.changed_paths) && Array.isArray(amendment.admission?.owner?.effective_paths)) {
    const lanes = amendment.admission.owner.effective_paths.map((lane, index) => canonicalPlanOwnershipLane(lane, errors, `${path}.owner_lane[${index}]`));
    for (const [index, changedPath] of attempt.changed_paths.entries()) if (isCanonicalConcreteRepositoryPath(changedPath) && !lanes.some((lane) => lane && planLaneOwnsConcretePath(lane, changedPath))) errors.push({ path: `${path}.changed_paths[${index}]`, message: "must stay inside frozen owner effective paths" });
  }
  const expectedReview = `reviews/integration-amendment-${amendment.amendment_id}.attempt-${number}.json`;
  if (attempt.review_ref !== expectedReview) errors.push({ path: `${path}.review_ref`, message: `must equal ${expectedReview}` });
  if (attempt.candidate_commit !== attempt.reviewed_commit) errors.push({ path: `${path}.reviewed_commit`, message: "must equal candidate_commit" });
  if (attempt.candidate_tree !== attempt.reviewed_tree) errors.push({ path: `${path}.reviewed_tree`, message: "must equal candidate_tree" });
}

function validateIntegrationAmendmentVariant(errors, amendment, path) {
  const attempts = Array.isArray(amendment.attempts) ? amendment.attempts : [];
  const last = attempts.at(-1);
  const status = amendment.status;
  if (["reported", "building", "reviewed"].includes(status) && ["integration", "verification", "publication", "blocked"].some((key) => amendment[key] !== undefined)) errors.push({ path, message: `${status} carries forbidden successor authority` });
  if (status === "reported" && attempts.length !== 0) errors.push({ path: `${path}.attempts`, message: "reported requires an empty attempts array" });
  if (status === "building" && (attempts.length < 1 || last?.state !== "building")) errors.push({ path: `${path}.attempts`, message: "building requires the last attempt in building state" });
  if (["reviewed", "integrated", "verified", "merged"].includes(status) && (attempts.length < 1 || last?.state !== "reviewed")) errors.push({ path: `${path}.attempts`, message: `${status} requires the last attempt in reviewed state` });
  if (attempts.length === 2 && attempts[0]?.state !== "reviewed") errors.push({ path: `${path}.attempts[0]`, message: "attempt 2 requires retained reviewed attempt 1" });
  if (attempts.length > 0 && attempts[0]?.build_base_commit !== amendment.admission?.baseline_commit) errors.push({ path: `${path}.attempts[0].build_base_commit`, message: "attempt 1 must start at admission.baseline_commit" });
  if (attempts.length === 2 && attempts[1]?.build_base_commit !== attempts[0]?.reviewed_commit) errors.push({ path: `${path}.attempts[1].build_base_commit`, message: "attempt 2 must start at attempt 1 reviewed_commit" });
  if (["integrated", "verified", "merged"].includes(status) || status === "blocked" && ["integrated", "verified"].includes(amendment.blocked?.origin)) validateIntegrationAmendmentIntegration(errors, amendment.integration, `${path}.integration`, amendment);
  if (["verified", "merged"].includes(status) || status === "blocked" && amendment.blocked?.origin === "verified") validateIntegrationAmendmentExecutionBinding(errors, amendment.verification, `${path}.verification`, amendment.amendment_id, "verify");
  if (status === "merged") validateIntegrationAmendmentPublication(errors, amendment.publication, `${path}.publication`, amendment);
  if (status === "blocked") validateIntegrationAmendmentBlocked(errors, amendment.blocked, `${path}.blocked`, attempts);
}

function validateIntegrationAmendmentIntegration(errors, integration, path, amendment) {
  if (!isRecord(integration)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, integration, INTEGRATION_AMENDMENT_INTEGRATION_KEYS, path);
  requiredString(errors, integration, "ref", `${path}.ref`);
  if (stringValue(integration.ref) && !/^refs\/opencode\/integration-amendments\/[A-Za-z0-9_-]{43}\/staged$/u.test(integration.ref)) errors.push({ path: `${path}.ref`, message: "must be the fixed staging ref" });
  optionalAbsolutePath(errors, integration, "worktree", `${path}.worktree`);
  if (!stringValue(integration.worktree)) errors.push({ path: `${path}.worktree`, message: "must be an absolute path" });
  for (const key of ["commit", "tree"]) requiredFullGitSha(errors, integration, key, `${path}.${key}`);
  const expectedRef = `refs/opencode/integration-amendments/${amendment.amendment_id}/staged`;
  const baselineBranch = amendment.admission?.baseline_ref?.slice("refs/heads/".length);
  const expectedWorktreeSuffix = baselineBranch
    ? `${sep}.opencode${sep}worktrees${sep}${baselineBranch}--amend-${amendment.amendment_id}-staged` : null;
  if (integration.ref !== expectedRef) errors.push({ path: `${path}.ref`, message: `must equal ${expectedRef}` });
  if (expectedWorktreeSuffix && !resolve(integration.worktree || "/").endsWith(expectedWorktreeSuffix)) errors.push({ path: `${path}.worktree`, message: "must use the deterministic repository-root amendment staging worktree" });
}

function validateIntegrationAmendmentPublication(errors, publication, path, amendment) {
  if (!isRecord(publication)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, publication, INTEGRATION_AMENDMENT_PUBLICATION_KEYS, path);
  requiredString(errors, publication, "branch_ref", `${path}.branch_ref`);
  for (const key of ["previous_commit", "commit"]) requiredFullGitSha(errors, publication, key, `${path}.${key}`);
  requiredTimestamp(errors, publication, "published_at", `${path}.published_at`);
  if (publication.previous_commit !== amendment.admission?.baseline_commit) errors.push({ path: `${path}.previous_commit`, message: "must equal admission.baseline_commit" });
  if (publication.commit !== amendment.integration?.commit) errors.push({ path: `${path}.commit`, message: "must equal integration.commit" });
  if (publication.branch_ref !== amendment.admission?.baseline_ref) errors.push({ path: `${path}.branch_ref`, message: "must equal admission.baseline_ref" });
}

function validateIntegrationAmendmentBlocked(errors, blocked, path, attempts) {
  if (!isRecord(blocked)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, blocked, INTEGRATION_AMENDMENT_BLOCKED_KEYS, path);
  requiredEnum(errors, blocked, "origin", new Set(["reported", "building", "reviewed-approve", "reviewed-reject", "integrated", "verified"]), `${path}.origin`);
  requiredTerminalSafeString(errors, blocked, "reason", `${path}.reason`);
  requiredTimestamp(errors, blocked, "blocked_at", `${path}.blocked_at`);
  const lastState = attempts.at(-1)?.state;
  if (blocked.origin === "reported" && attempts.length !== 0) errors.push({ path: `${path}.origin`, message: "reported origin requires no attempts" });
  if (blocked.origin === "building" && lastState !== "building") errors.push({ path: `${path}.origin`, message: "building origin requires a building attempt" });
  if (blocked.origin.startsWith("reviewed-") && lastState !== "reviewed") errors.push({ path: `${path}.origin`, message: "reviewed origin requires a reviewed attempt" });
  if (["integrated", "verified"].includes(blocked.origin) && lastState !== "reviewed") errors.push({ path: `${path}.origin`, message: `${blocked.origin} origin requires a reviewed APPROVE-capable attempt` });
}

export function validateIntegrationAmendmentReview(review) {
  const errors = [];
  const path = "review";
  if (!isRecord(review)) fail([{ path, message: "must be an object" }]);
  allowedKeys(errors, review, INTEGRATION_AMENDMENT_REVIEW_KEYS, path);
  if (review.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  if (review.kind !== "integration-amendment-review") errors.push({ path: `${path}.kind`, message: "must equal integration-amendment-review" });
  requiredString(errors, review, "subject", `${path}.subject`);
  requiredString(errors, review, "amendment_id", `${path}.amendment_id`);
  if (!AMENDMENT_ID_PATTERN.test(review.amendment_id || "")) errors.push({ path: `${path}.amendment_id`, message: "must be a 43-character base64url id" });
  boundedInteger(errors, review, "attempt", 1, 2, `${path}.attempt`);
  for (const key of ["build_base_commit", "reviewed_commit", "reviewed_tree"]) requiredFullGitSha(errors, review, key, `${path}.${key}`);
  validateCanonicalConcretePathSet(errors, review.changed_paths, `${path}.changed_paths`, { allowEmpty: false, sorted: true });
  if (!isRecord(review.dispositions)) errors.push({ path: `${path}.dispositions`, message: "must be an object" });
  else {
    allowedKeys(errors, review.dispositions, new Set(INTEGRATION_AMENDMENT_DISPOSITIONS), `${path}.dispositions`);
    for (const key of INTEGRATION_AMENDMENT_DISPOSITIONS) requiredEnum(errors, review.dispositions, key, new Set(["preserved", "changed"]), `${path}.dispositions.${key}`);
  }
  requiredEnum(errors, review, "verdict", new Set(["APPROVE", "REJECT"]), `${path}.verdict`);
  validateStringArray(errors, review.required_fixes, `${path}.required_fixes`, { required: true });
  const normalized = Array.isArray(review.required_fixes) ? review.required_fixes.map((fix) => typeof fix === "string" ? fix.trim().normalize("NFC") : null) : [];
  if (normalized.some((fix, index) => !fix || fix !== review.required_fixes[index]) || new Set(normalized).size !== normalized.length) errors.push({ path: `${path}.required_fixes`, message: "must contain unique trimmed NFC-normalized fixes" });
  const allPreserved = INTEGRATION_AMENDMENT_DISPOSITIONS.every((key) => review.dispositions?.[key] === "preserved");
  if (review.verdict === "APPROVE" && (!allPreserved || normalized.length !== 0)) errors.push({ path, message: "APPROVE requires all dispositions preserved and no required fixes" });
  if (review.verdict === "REJECT" && normalized.length < 1) errors.push({ path: `${path}.required_fixes`, message: "REJECT requires at least one required fix" });
  requiredTimestamp(errors, review, "reviewed_at", `${path}.reviewed_at`);
  if (errors.length) fail(errors);
  return review;
}

export function validateIntegrationAmendmentExecutionClaim(claim) {
  const errors = [];
  const path = "claim";
  if (!isRecord(claim)) fail([{ path, message: "must be an object" }]);
  const keys = claim.state === "completed" ? INTEGRATION_AMENDMENT_CLAIM_COMPLETED_KEYS : claim.state === "unknown" ? INTEGRATION_AMENDMENT_CLAIM_UNKNOWN_KEYS : INTEGRATION_AMENDMENT_CLAIM_COMMON_KEYS;
  allowedKeys(errors, claim, keys, path);
  if (claim.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  if (claim.kind !== "integration-amendment-execution-claim") errors.push({ path: `${path}.kind`, message: "must equal integration-amendment-execution-claim" });
  requiredEnum(errors, claim, "phase", new Set(["report", "verify"]), `${path}.phase`);
  requiredEnum(errors, claim, "state", new Set(["active", "completed", "unknown"]), `${path}.state`);
  requiredString(errors, claim, "nonce", `${path}.nonce`);
  requiredString(errors, claim, "amendment_id", `${path}.amendment_id`);
  if (!AMENDMENT_ID_PATTERN.test(claim.amendment_id || "")) errors.push({ path: `${path}.amendment_id`, message: "must be a 43-character base64url id" });
  validateIntegrationAmendmentIdentity(errors, claim.identity, `${path}.identity`);
  requiredString(errors, claim, "run_id", `${path}.run_id`);
  validateIntegrationAmendmentProbe(errors, claim.probe, `${path}.probe`);
  for (const key of ["head_sha", "tree_sha"]) requiredFullGitSha(errors, claim, key, `${path}.${key}`);
  optionalAbsolutePath(errors, claim, "cwd", `${path}.cwd`);
  if (!stringValue(claim.cwd)) errors.push({ path: `${path}.cwd`, message: "must be an absolute path" });
  optionalCheckedExecutionTimeout(errors, claim, `${path}.timeout_ms`);
  requiredString(errors, claim, "receipt_ref", `${path}.receipt_ref`);
  requiredTimestamp(errors, claim, "claimed_at", `${path}.claimed_at`);
  const expectedSubject = `integration-amendment:${claim.amendment_id}:${claim.phase}`;
  if (claim.subject !== expectedSubject) errors.push({ path: `${path}.subject`, message: "must equal the phase-specific amendment subject" });
  const expectedReceipt = `evidence/integration-amendment-${claim.amendment_id}.${claim.phase}.receipt.json`;
  if (claim.receipt_ref !== expectedReceipt) errors.push({ path: `${path}.receipt_ref`, message: `must equal ${expectedReceipt}` });
  if (claim.identity?.run_id !== claim.run_id || claim.identity?.admission?.probe && JSON.stringify(claim.identity.admission.probe) !== JSON.stringify(claim.probe)) errors.push({ path: `${path}.identity`, message: "must bind the same run and probe" });
  if (claim.state === "completed") {
    requiredTimestamp(errors, claim, "completed_at", `${path}.completed_at`);
    requiredEnum(errors, claim, "status", new Set(["pass", "fail"]), `${path}.status`);
    requiredHash(errors, claim, "receipt_hash", `${path}.receipt_hash`);
  } else if (claim.state === "unknown") {
    requiredTimestamp(errors, claim, "failed_at", `${path}.failed_at`);
    requiredEnum(errors, claim, "reason", INTEGRATION_AMENDMENT_UNKNOWN_REASONS, `${path}.reason`);
    const bothNull = claim.receipt_status === null && claim.receipt_hash === null;
    const bothKnown = ["pass", "fail"].includes(claim.receipt_status) && HASH_PATTERN.test(claim.receipt_hash || "");
    if (!bothNull && !bothKnown) errors.push({ path, message: "unknown receipt_status and receipt_hash must be both null or both bound" });
  }
  if (errors.length) fail(errors);
  return claim;
}

function validateIntegrationAmendmentIdentity(errors, identity, path) {
  if (!isRecord(identity)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, identity, INTEGRATION_AMENDMENT_IDENTITY_KEYS, path);
  if (identity.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  if (identity.kind !== "integration-amendment-identity") errors.push({ path: `${path}.kind`, message: "must equal integration-amendment-identity" });
  requiredString(errors, identity, "run_id", `${path}.run_id`);
  if (!isCanonicalConcreteRepositoryPath(identity.defect_path)) errors.push({ path: `${path}.defect_path`, message: "must be a canonical concrete repository path" });
  validateIntegrationAmendmentAdmission(errors, identity.admission, `${path}.admission`);
}

export function validateIntegrationAmendmentExecutionReceipt(receipt) {
  const errors = [];
  const path = "receipt";
  if (!isRecord(receipt)) fail([{ path, message: "must be an object" }]);
  allowedKeys(errors, receipt, INTEGRATION_AMENDMENT_RECEIPT_KEYS, path);
  if (receipt.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  if (receipt.kind !== "integration-amendment-execution-receipt") errors.push({ path: `${path}.kind`, message: "must equal integration-amendment-execution-receipt" });
  requiredEnum(errors, receipt, "phase", new Set(["report", "verify"]), `${path}.phase`);
  for (const key of ["subject", "run_id", "amendment_id", "claim_nonce"]) requiredString(errors, receipt, key, `${path}.${key}`);
  if (!AMENDMENT_ID_PATTERN.test(receipt.amendment_id || "")) errors.push({ path: `${path}.amendment_id`, message: "must be a 43-character base64url id" });
  validateIntegrationAmendmentProbe(errors, receipt.probe, `${path}.probe`);
  for (const key of ["head_sha", "tree_sha"]) requiredFullGitSha(errors, receipt, key, `${path}.${key}`);
  optionalAbsolutePath(errors, receipt, "cwd", `${path}.cwd`);
  if (!stringValue(receipt.cwd)) errors.push({ path: `${path}.cwd`, message: "must be an absolute path" });
  optionalCheckedExecutionTimeout(errors, receipt, `${path}.timeout_ms`);
  requiredTimestamp(errors, receipt, "started_at", `${path}.started_at`);
  requiredTimestamp(errors, receipt, "completed_at", `${path}.completed_at`);
  boundedInteger(errors, receipt, "duration_ms", 0, Number.MAX_SAFE_INTEGER, `${path}.duration_ms`);
  requiredEnum(errors, receipt, "status", new Set(["pass", "fail"]), `${path}.status`);
  if (typeof receipt.review_ready !== "boolean") errors.push({ path: `${path}.review_ready`, message: "must be a boolean" });
  if (!Array.isArray(receipt.commands) || receipt.commands.length !== 1) errors.push({ path: `${path}.commands`, message: "must contain exactly one command result" });
  else validateTestExecutionCommandResult(errors, receipt.commands[0], 0);
  const result = receipt.commands?.[0];
  const passing = result?.outcome === "exited" && result.exit_code === 0 && result.status === "pass";
  const reportReady = receipt.phase === "report" && result?.outcome === "exited" && Number.isInteger(result.exit_code) && result.exit_code !== 0;
  const verifyReady = receipt.phase === "verify" && passing;
  if (receipt.status !== (passing ? "pass" : "fail")) errors.push({ path: `${path}.status`, message: "must reflect the exact command result" });
  if (receipt.review_ready !== (reportReady || verifyReady)) errors.push({ path: `${path}.review_ready`, message: "must be true only for report nonzero-exit or verification pass" });
  if (result && (result.program !== receipt.probe?.program || JSON.stringify(result.args) !== JSON.stringify(receipt.probe?.args))) errors.push({ path: `${path}.commands[0]`, message: "must execute the exact probe program and args" });
  if (receipt.subject !== `integration-amendment:${receipt.amendment_id}:${receipt.phase}`) errors.push({ path: `${path}.subject`, message: "must equal the phase-specific amendment subject" });
  if (errors.length) fail(errors);
  return receipt;
}

function validateSpecialBuilderDispatch(errors, dispatch, path) {
  if (dispatch === undefined || dispatch === null) return;
  if (!isRecord(dispatch)) { errors.push({ path, message: "must be an object" }); return; }
  const keys = new Set(["schema_version", "route", "instance", "agent", "claim_ref", "claim_hash", "closure_ref", "closure_hash", "completion_head", "owner_slice_id"]);
  allowedKeys(errors, dispatch, keys, path);
  requiredInteger(errors, dispatch, "schema_version", `${path}.schema_version`);
  if (dispatch.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  requiredEnum(errors, dispatch, "route", new Set(["integration-amendment", "panel-remediation", "post-pr-remediation", "integration-conflict"]), `${path}.route`);
  requiredString(errors, dispatch, "instance", `${path}.instance`);
  requiredEnum(errors, dispatch, "agent", new Set(["backend-builder", "frontend-builder"]), `${path}.agent`);
  requiredString(errors, dispatch, "claim_ref", `${path}.claim_ref`);
  requiredHash(errors, dispatch, "claim_hash", `${path}.claim_hash`);
  const closureCount = presentBindingCount(dispatch, ["closure_ref", "closure_hash", "completion_head"]);
  if (![0, 3].includes(closureCount)) errors.push({ path, message: "closure_ref, closure_hash, and completion_head must be all present or all absent" });
  if (closureCount === 3) {
    requiredString(errors, dispatch, "closure_ref", `${path}.closure_ref`);
    requiredHash(errors, dispatch, "closure_hash", `${path}.closure_hash`);
    requiredFullGitSha(errors, dispatch, "completion_head", `${path}.completion_head`);
  }
  if (["panel-remediation", "integration-conflict"].includes(dispatch.route) && (closureCount === 3 || dispatch.route === "integration-conflict")) requiredString(errors, dispatch, "owner_slice_id", `${path}.owner_slice_id`);
  if (!["panel-remediation", "integration-conflict"].includes(dispatch.route) && dispatch.owner_slice_id !== undefined) errors.push({ path: `${path}.owner_slice_id`, message: "is allowed only for panel-remediation or integration-conflict" });
  if (stringValue(dispatch.claim_ref) && !/^dispatch\/[0-9a-f]{64}\.special\.json$/u.test(dispatch.claim_ref)) errors.push({ path: `${path}.claim_ref`, message: "must be a safe special dispatch claim ref" });
  if (stringValue(dispatch.closure_ref) && !/^dispatch\/[0-9a-f]{64}\.special\.closed\.json$/u.test(dispatch.closure_ref)) errors.push({ path: `${path}.closure_ref`, message: "must be a safe special dispatch closure ref" });
}

function validateIntegrationConflict(errors, conflict, path, slice, slices) {
  if (conflict === undefined || conflict === null) return;
  if (!isRecord(conflict)) { errors.push({ path, message: "must be an object" }); return; }
  const keys = new Set(["schema_version", "status", "slice_id", "owner_slice_id", "agent", "integration_baseline", "resolution_commit", "conflict_paths", "claim_ref", "claim_hash", "closure_ref", "closure_hash", "integration_proof", "test_acceptance", "test_artifact_snapshot", "test_execution_claim", "test_execution_claim_hash"]);
  allowedKeys(errors, conflict, keys, path);
  requiredInteger(errors, conflict, "schema_version", `${path}.schema_version`);
  if (conflict.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  requiredEnum(errors, conflict, "status", new Set(["pending-integrated-review", "accepted"]), `${path}.status`);
  requiredString(errors, conflict, "slice_id", `${path}.slice_id`);
  requiredString(errors, conflict, "owner_slice_id", `${path}.owner_slice_id`);
  requiredEnum(errors, conflict, "agent", new Set(["backend-builder", "frontend-builder"]), `${path}.agent`);
  requiredFullGitSha(errors, conflict, "integration_baseline", `${path}.integration_baseline`);
  requiredFullGitSha(errors, conflict, "resolution_commit", `${path}.resolution_commit`);
  validateCanonicalConcretePathSet(errors, conflict.conflict_paths, `${path}.conflict_paths`, { allowEmpty: false, sorted: true });
  for (const key of ["claim_ref", "closure_ref"]) requiredString(errors, conflict, key, `${path}.${key}`);
  for (const key of ["claim_hash", "closure_hash"]) requiredHash(errors, conflict, key, `${path}.${key}`);
  if (stringValue(conflict.claim_ref) && !/^dispatch\/[0-9a-f]{64}\.special\.json$/u.test(conflict.claim_ref)) errors.push({ path: `${path}.claim_ref`, message: "must be a safe special dispatch claim ref" });
  if (stringValue(conflict.closure_ref) && !/^dispatch\/[0-9a-f]{64}\.special\.closed\.json$/u.test(conflict.closure_ref)) errors.push({ path: `${path}.closure_ref`, message: "must be a safe special dispatch closure ref" });
  validateIntegrationConflictProof(errors, conflict.integration_proof, `${path}.integration_proof`, conflict);
  const owner = Array.isArray(slices) ? slices.find((candidate) => candidate?.id === conflict.owner_slice_id) : null;
  if (!slice || conflict.slice_id !== slice.id || slice.status !== "merged" || slice.merge_commit !== conflict.resolution_commit) errors.push({ path: `${path}.slice_id`, message: "must reference its merged conflict slice at resolution_commit" });
  if (Array.isArray(slices) && slices.length > 0 && (!owner || `${owner.stack}-builder` !== conflict.agent)) errors.push({ path: `${path}.owner_slice_id`, message: "must reference the effective owner matching agent" });
  if (conflict.status === "accepted") {
    validateIntegrationConflictTestAcceptance(errors, conflict.test_acceptance, `${path}.test_acceptance`);
    validateConflictArtifactSnapshot(errors, conflict.test_artifact_snapshot, `${path}.test_artifact_snapshot`, conflict.test_acceptance);
    validateTestExecutionClaim(errors, conflict.test_execution_claim, `${path}.test_execution_claim`);
    requiredHash(errors, conflict, "test_execution_claim_hash", `${path}.test_execution_claim_hash`);
  } else for (const key of ["test_acceptance", "test_artifact_snapshot", "test_execution_claim", "test_execution_claim_hash"]) {
    if (conflict[key] !== undefined) errors.push({ path: `${path}.${key}`, message: "is allowed only after integrated acceptance" });
  }
}

function validateIntegrationConflictProof(errors, proof, path, conflict) {
  if (!isRecord(proof)) { errors.push({ path, message: "must be an object" }); return; }
  const keys = new Set(["schema_version", "integration_baseline", "merge_head", "resolution_commit", "merge_base", "conflict_paths", "integrated_entries", "integrated_tree"]);
  allowedKeys(errors, proof, keys, path);
  requiredInteger(errors, proof, "schema_version", `${path}.schema_version`);
  if (proof.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  for (const key of ["integration_baseline", "merge_head", "resolution_commit", "merge_base", "integrated_tree"]) requiredFullGitSha(errors, proof, key, `${path}.${key}`);
  validateCanonicalConcretePathSet(errors, proof.conflict_paths, `${path}.conflict_paths`, { allowEmpty: false, sorted: true });
  if (proof.integration_baseline !== conflict.integration_baseline || proof.resolution_commit !== conflict.resolution_commit || JSON.stringify(proof.conflict_paths) !== JSON.stringify(conflict.conflict_paths)) {
    errors.push({ path, message: "must exactly bind the integration conflict identity" });
  }
  if (!Array.isArray(proof.integrated_entries) || proof.integrated_entries.length !== conflict.conflict_paths?.length) errors.push({ path: `${path}.integrated_entries`, message: "must bind every conflict path exactly once" });
  else for (const [index, entry] of proof.integrated_entries.entries()) {
    const entryPath = `${path}.integrated_entries[${index}]`;
    if (!isRecord(entry)) { errors.push({ path: entryPath, message: "must be an object" }); continue; }
    allowedKeys(errors, entry, new Set(["path", "entry_hash"]), entryPath);
    requiredString(errors, entry, "path", `${entryPath}.path`);
    requiredHash(errors, entry, "entry_hash", `${entryPath}.entry_hash`);
    if (entry.path !== conflict.conflict_paths[index]) errors.push({ path: `${entryPath}.path`, message: "must equal the corresponding conflict path" });
  }
}

function validateIntegrationConflictTestAcceptance(errors, acceptance, path) {
  if (!isRecord(acceptance)) { errors.push({ path, message: "is required and must be an object" }); return; }
  allowedKeys(errors, acceptance, STEP_ACCEPTANCE_KEYS, path);
  for (const key of ["artifact_ref", "evidence_ref", "review_ref"]) requiredString(errors, acceptance, key, `${path}.${key}`);
  for (const key of ["artifact_hash", "evidence_hash", "review_hash"]) requiredHash(errors, acceptance, key, `${path}.${key}`);
  requiredFullGitSha(errors, acceptance, "reviewed_head_sha", `${path}.reviewed_head_sha`);
}

function validateConflictArtifactSnapshot(errors, snapshot, path, acceptance) {
  if (!isRecord(snapshot)) { errors.push({ path, message: "is required and must be an object" }); return; }
  allowedKeys(errors, snapshot, new Set(["ref", "hash"]), path);
  requiredString(errors, snapshot, "ref", `${path}.ref`);
  requiredHash(errors, snapshot, "hash", `${path}.hash`);
  validateDurableRef(errors, snapshot.ref, "artifacts", `${path}.ref`);
  if (stringValue(snapshot.ref) && !/^artifacts\/integration-conflicts\/[0-9a-f]{64}\.test-report\.md$/u.test(snapshot.ref)) {
    errors.push({ path: `${path}.ref`, message: "must be the canonical immutable integration-conflict test snapshot ref" });
  }
  if (isRecord(acceptance) && snapshot.hash !== acceptance.artifact_hash) errors.push({ path: `${path}.hash`, message: "must equal test_acceptance.artifact_hash" });
}

function validateProvenance(errors, provenance, path) {
  if (provenance === undefined || provenance === null) return;
  if (!isRecord(provenance)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, provenance, PROVENANCE_KEYS, path);
  requiredInteger(errors, provenance, "schema_version", `${path}.schema_version`);
  if (provenance.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  if (provenance.created !== null) validateProvenanceEvent(errors, provenance.created, `${path}.created`, "created");
  if (provenance.last_resumed !== null) validateProvenanceEvent(errors, provenance.last_resumed, `${path}.last_resumed`, "resumed");
  boundedInteger(errors, provenance, "resume_count", 0, Number.MAX_SAFE_INTEGER, `${path}.resume_count`);
  if (!Array.isArray(provenance.review_dispatches)) errors.push({ path: `${path}.review_dispatches`, message: "must be an array" });
  else for (const [index, event] of provenance.review_dispatches.entries()) validateProvenanceEvent(errors, event, `${path}.review_dispatches[${index}]`, "review-dispatch");
}

function validateProvenanceEvent(errors, event, path, expectedEvent) {
  if (!isRecord(event)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, event, PROVENANCE_EVENT_KEYS, path);
  requiredInteger(errors, event, "schema_version", `${path}.schema_version`);
  if (event.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  requiredString(errors, event, "event", `${path}.event`);
  if (event.event !== expectedEvent) errors.push({ path: `${path}.event`, message: `must equal ${expectedEvent}` });
  requiredString(errors, event, "captured_at", `${path}.captured_at`);
  validateProvenanceContent(errors, event.content, `${path}.content`);
  validateProvenanceRuntime(errors, event.runtime, `${path}.runtime`);
  if (expectedEvent === "review-dispatch") validateProvenanceDispatch(errors, event.dispatch, `${path}.dispatch`);
  else if (event.dispatch !== undefined) errors.push({ path: `${path}.dispatch`, message: "is not allowed for this event" });
}

function validateProvenanceContent(errors, content, path) {
  if (!isRecord(content)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, content, new Set(["command_hash", "agent_prompt_hashes", "skill_hashes"]), path);
  requiredHash(errors, content, "command_hash", `${path}.command_hash`);
  for (const key of ["agent_prompt_hashes", "skill_hashes"]) {
    const hashes = content[key];
    if (!isRecord(hashes)) { errors.push({ path: `${path}.${key}`, message: "must be an object" }); continue; }
    for (const [name, hash] of Object.entries(hashes)) if (!HASH_PATTERN.test(hash)) errors.push({ path: `${path}.${key}.${name}`, message: "must be a sha256 hash" });
  }
}

function validateProvenanceRuntime(errors, runtime, path) {
  if (!isRecord(runtime)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, runtime, new Set(["plugin", "opencode_version", "configured_models", "configured_variants", "model", "git"]), path);
  const plugin = runtime.plugin;
  if (!isRecord(plugin)) errors.push({ path: `${path}.plugin`, message: "must be an object" });
  else {
    allowedKeys(errors, plugin, new Set(["source", "source_hash", "package_version"]), `${path}.plugin`);
    requiredString(errors, plugin, "source", `${path}.plugin.source`);
    requiredHash(errors, plugin, "source_hash", `${path}.plugin.source_hash`);
    requiredString(errors, plugin, "package_version", `${path}.plugin.package_version`);
  }
  if (runtime.opencode_version !== null) optionalString(errors, runtime, "opencode_version", `${path}.opencode_version`);
  for (const key of ["configured_models", "configured_variants"]) {
    const values = runtime[key];
    if (!isRecord(values)) { errors.push({ path: `${path}.${key}`, message: "must be an object" }); continue; }
    for (const [name, value] of Object.entries(values)) if (value !== null && !stringValue(value)) errors.push({ path: `${path}.${key}.${name}`, message: "must be a string or null" });
  }
  if (runtime.model !== null) {
    const model = runtime.model;
    if (!isRecord(model)) errors.push({ path: `${path}.model`, message: "must be an object or null" });
    else {
      allowedKeys(errors, model, new Set(["configured", "variant", "actual", "actual_source"]), `${path}.model`);
      for (const key of ["configured", "variant", "actual"]) if (model[key] !== null) optionalString(errors, model, key, `${path}.model.${key}`);
      requiredEnum(errors, model, "actual_source", new Set(["unavailable", "opencode-runtime"]), `${path}.model.actual_source`);
    }
  }
  const gitState = runtime.git;
  if (!isRecord(gitState)) errors.push({ path: `${path}.git`, message: "must be an object" });
  else {
    allowedKeys(errors, gitState, new Set(["head", "dirty"]), `${path}.git`);
    if (gitState.head !== null) optionalString(errors, gitState, "head", `${path}.git.head`);
    if (gitState.dirty !== null && typeof gitState.dirty !== "boolean") errors.push({ path: `${path}.git.dirty`, message: "must be a boolean or null" });
  }
}

function validateProvenanceDispatch(errors, dispatch, path) {
  if (!isRecord(dispatch)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, dispatch, new Set(["agent", "subject", "attempt", "prompt_hash", "prompt_bytes"]), path);
  requiredEnum(errors, dispatch, "agent", new Set(["work-reviewer", "implementation-validator", "security-reviewer"]), `${path}.agent`);
  requiredString(errors, dispatch, "subject", `${path}.subject`);
  boundedInteger(errors, dispatch, "attempt", 1, Number.MAX_SAFE_INTEGER, `${path}.attempt`);
  requiredHash(errors, dispatch, "prompt_hash", `${path}.prompt_hash`);
  boundedInteger(errors, dispatch, "prompt_bytes", 0, Number.MAX_SAFE_INTEGER, `${path}.prompt_bytes`);
}

function validateContinuation(errors, run, path) {
  const continuation = run.continuation;
  if (continuation === undefined || continuation === null) return;
  if (!isRecord(continuation)) {
    errors.push({ path, message: "must be an object" });
    return;
  }

  allowedKeys(errors, continuation, CONTINUATION_KEYS, path);
  requiredInteger(errors, continuation, "schema_version", `${path}.schema_version`);
  if (continuation.schema_version !== 2) errors.push({ path: `${path}.schema_version`, message: "must equal 2" });
  requiredEnum(errors, continuation, "kind", CONTINUATION_KINDS, `${path}.kind`);
  requiredTimestamp(errors, continuation, "created_at", `${path}.created_at`);
  requiredString(errors, continuation, "operator_summary", `${path}.operator_summary`);
  validateContinuationParent(errors, continuation.parent, `${path}.parent`);
  validateContinuationReview(errors, continuation.review, `${path}.review`);
  validateContinuationTarget(errors, run, continuation.target, `${path}.target`);
  validateContinuationRefHashArray(errors, continuation.parent_artifacts, `${path}.parent_artifacts`);
  validateContinuationRefHashArray(errors, continuation.parent_evidence, `${path}.parent_evidence`);
  validateContinuationRefHashArray(errors, continuation.parent_reviews, `${path}.parent_reviews`);
  validateContinuationSelectedReview(errors, continuation, path);
  validateContinuationPlanningReuse(errors, continuation, `${path}.planning_reuse`);
  validateContinuationConfiguration(errors, continuation, `${path}.configuration`);
  validateContinuationCarryForward(errors, run, continuation, `${path}.carry_forward`);
}

function validateContinuationConfiguration(errors, continuation, path) {
  const configuration = continuation.configuration;
  if (!isRecord(configuration)) { errors.push({ path, message: "is required for schema_version 2" }); return; }
  allowedKeys(errors, configuration, CONTINUATION_CONFIGURATION_KEYS, path);
  requiredEnum(errors, configuration, "mode", new Set(["interactive", "headless", "autonomous"]), `${path}.mode`);
  if (!Object.hasOwn(configuration, "github_account") || configuration.github_account !== null && !stringValue(configuration.github_account)) errors.push({ path: `${path}.github_account`, message: "must be null or a non-empty string" });
  requiredEnum(errors, configuration, "pr_mode", new Set(["draft", "ready"]), `${path}.pr_mode`);
  boundedInteger(errors, configuration, "max_parallel_slices", 3, 3, `${path}.max_parallel_slices`);
  boundedInteger(errors, configuration, "max_retries", 3, 3, `${path}.max_retries`);
  validatePostPrPolicy(errors, configuration.post_pr_policy, `${path}.post_pr_policy`);
  if (Object.hasOwn(configuration, "review_tier") && configuration.review_tier !== null && !stringValue(configuration.review_tier)) {
    errors.push({ path: `${path}.review_tier`, message: "must be null or a non-empty string" });
  }
  const hasCheckpointSourceHash = Object.hasOwn(continuation, "checkpoint_source_hash");
  const hasConfigurationHash = Object.hasOwn(continuation, "configuration_hash");
  if (hasCheckpointSourceHash !== hasConfigurationHash) errors.push({ path: path.slice(0, -".configuration".length), message: "checkpoint_source_hash and configuration_hash must be present together" });
  if (hasCheckpointSourceHash) {
    requiredHash(errors, continuation, "checkpoint_source_hash", `${path.slice(0, -".configuration".length)}.checkpoint_source_hash`);
    requiredHash(errors, continuation, "configuration_hash", `${path.slice(0, -".configuration".length)}.configuration_hash`);
    if (!Object.hasOwn(configuration, "review_tier")) errors.push({ path: `${path}.review_tier`, message: "is required for a checkpoint-bound continuation" });
  }
}

function validateContinuationCarryForward(errors, run, continuation, path) {
  const carry = continuation.carry_forward;
  if (!isRecord(carry)) { errors.push({ path, message: "is required for schema_version 2" }); return; }
  allowedKeys(errors, carry, CONTINUATION_CARRY_FORWARD_KEYS, path);
  requiredEnum(errors, carry, "scope", new Set(["full-remaining-plan"]), `${path}.scope`);
  requiredString(errors, carry, "plan_ref", `${path}.plan_ref`);
  if (carry.plan_ref !== "plan/slices.json") errors.push({ path: `${path}.plan_ref`, message: "must equal plan/slices.json" });
  requiredHash(errors, carry, "plan_hash", `${path}.plan_hash`);
  requiredFullGitSha(errors, carry, "start_commit", `${path}.start_commit`);
  if (carry.start_commit !== continuation.parent?.commit) errors.push({ path: `${path}.start_commit`, message: "must equal continuation.parent.commit" });
  if (continuation.planning_reuse?.eligible !== true) errors.push({ path: `${path}`, message: "requires planning_reuse.eligible true" });
  const acceptedIds = new Set();
  if (!Array.isArray(carry.accepted_slices)) errors.push({ path: `${path}.accepted_slices`, message: "must be an array" });
  else for (const [index, accepted] of carry.accepted_slices.entries()) {
    const itemPath = `${path}.accepted_slices[${index}]`;
    if (!isRecord(accepted)) { errors.push({ path: itemPath, message: "must be an object" }); continue; }
    allowedKeys(errors, accepted, CONTINUATION_CARRY_FORWARD_ACCEPTED_KEYS, itemPath);
    requiredString(errors, accepted, "id", `${itemPath}.id`);
    if (acceptedIds.has(accepted.id)) errors.push({ path: `${itemPath}.id`, message: "must be unique" });
    acceptedIds.add(accepted.id);
    validateDurableOwnershipPaths(errors, accepted.declared_paths, `${itemPath}.declared_paths`, { concreteOnly: false });
    validateDurableOwnershipPaths(errors, accepted.effective_paths, `${itemPath}.effective_paths`, { concreteOnly: false });
    boundedInteger(errors, accepted, "attempts", 1, Number.MAX_SAFE_INTEGER, `${itemPath}.attempts`);
    for (const [key, root] of [["evidence_ref", "evidence"], ["review_ref", "reviews"]]) {
      requiredString(errors, accepted, key, `${itemPath}.${key}`);
      validateDurableRef(errors, accepted[key], root, `${itemPath}.${key}`);
    }
    for (const key of ["evidence_hash", "review_hash"]) requiredHash(errors, accepted, key, `${itemPath}.${key}`);
    for (const key of ["reviewed_commit", "merge_commit"]) requiredFullGitSha(errors, accepted, key, `${itemPath}.${key}`);
    validateSliceAttemptReviews(errors, { ...accepted, status: "merged" }, itemPath);
    validateSliceEffectiveOwnership(errors, { ...accepted, status: "merged" }, itemPath);
    if (accepted.integration_conflict !== undefined) {
      validateIntegrationConflict(errors, accepted.integration_conflict, `${itemPath}.integration_conflict`, { id: accepted.id, status: "merged", merge_commit: accepted.merge_commit }, run.slices);
    }
  }
  const remainingIds = new Set();
  if (!Array.isArray(carry.remaining_slice_ids) || carry.remaining_slice_ids.length === 0) errors.push({ path: `${path}.remaining_slice_ids`, message: "must contain at least one id" });
  else for (const [index, id] of carry.remaining_slice_ids.entries()) {
    if (!stringValue(id) || remainingIds.has(id) || acceptedIds.has(id)) errors.push({ path: `${path}.remaining_slice_ids[${index}]`, message: "must be a unique id disjoint from accepted_slices" });
    remainingIds.add(id);
  }
  if (Array.isArray(run.slices) && run.slices.length > 0) {
    const ids = run.slices.map((slice) => slice?.id);
    const partition = new Set([...acceptedIds, ...remainingIds]);
    if (ids.length !== partition.size || ids.some((id) => !partition.has(id))) errors.push({ path: "run.slices", message: "must exactly classify the schema-v2 carry-forward partition" });
    let acceptedIndex = 0;
    let remainingIndex = 0;
    for (const slice of run.slices) {
      if (acceptedIds.has(slice?.id)) {
        if (carry.accepted_slices[acceptedIndex++]?.id !== slice.id) errors.push({ path: "run.slices", message: "accepted carry-forward rows must remain in PLAN order" });
        const adopted = carry.accepted_slices.find((entry) => entry.id === slice.id);
        const allowed = new Set(["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts", "attempt_reviews", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "merge_commit", "integration_conflict"]);
        if (Object.keys(slice).some((key) => !allowed.has(key)) || slice.status !== "merged" || slice.attempts !== adopted.attempts
          || JSON.stringify(slice.declared_paths) !== JSON.stringify(adopted.declared_paths) || JSON.stringify(slice.effective_paths) !== JSON.stringify(adopted.effective_paths)
          || slice.evidence_ref !== adopted.evidence_ref || slice.evidence_hash !== adopted.evidence_hash || slice.review_ref !== adopted.review_ref
          || slice.review_hash !== adopted.review_hash || slice.reviewed_commit !== adopted.reviewed_commit || slice.merge_commit !== adopted.merge_commit
          || JSON.stringify(slice.attempt_reviews) !== JSON.stringify(adopted.attempt_reviews)
          || JSON.stringify(slice.integration_conflict) !== JSON.stringify(adopted.integration_conflict)) {
          errors.push({ path: `run.slices.${slice.id}`, message: "adopted carry-forward row is immutable" });
        }
      } else if (remainingIds.has(slice?.id) && carry.remaining_slice_ids[remainingIndex++] !== slice.id) errors.push({ path: "run.slices", message: "remaining carry-forward rows must remain in PLAN order" });
    }
  }
  const checkpointBound = Object.hasOwn(continuation, "checkpoint_source_hash");
  const expectedReviewTier = checkpointBound ? continuation.configuration?.review_tier : undefined;
  const reviewTierMatches = expectedReviewTier === null ? !Object.hasOwn(run, "review_tier") : run.review_tier === expectedReviewTier;
  if (run.mode === undefined || !Object.hasOwn(run, "github_account") || run.pr_mode === undefined || run.max_parallel_slices !== 3 || run.max_retries !== 3
    || !reviewTierMatches || !isRecord(run.post_pr)) {
    errors.push({ path: "run", message: "schema-v2 carry-forward requires its exact closed immutable configuration" });
  }
  const configuration = continuation.configuration;
  if (isRecord(configuration) && (run.mode !== configuration.mode || (run.github_account ?? null) !== configuration.github_account || run.pr_mode !== configuration.pr_mode
    || run.max_parallel_slices !== configuration.max_parallel_slices || run.max_retries !== configuration.max_retries || JSON.stringify(run.post_pr?.policy) !== JSON.stringify(configuration.post_pr_policy)
    || !reviewTierMatches)) {
    errors.push({ path: "run", message: "must exactly match immutable schema-v2 continuation configuration" });
  }
  if (checkpointBound) {
    if (run.checkpoint_source !== undefined && (!isRecord(run.checkpoint_source) || hashValue(run.checkpoint_source) !== continuation.checkpoint_source_hash)) {
      errors.push({ path: "run.checkpoint_source", message: "must exactly match checkpoint-bound continuation authority" });
    }
    if (isRecord(run.checkpoint_source) && continuation.planning_reuse?.eligible === true
      && (continuation.planning_reuse.plan_hash !== run.checkpoint_source.child_plan_hash
        || continuation.planning_reuse.review_hash !== run.checkpoint_source.child_disposition_hash)) {
      errors.push({ path: `${path.slice(0, -".carry_forward".length)}.planning_reuse`, message: "must exactly match checkpoint_source child plan and disposition hashes" });
    }
    if (hashValue(configuration) !== continuation.configuration_hash) {
      errors.push({ path: `${path.slice(0, -".carry_forward".length)}.configuration_hash`, message: "must hash the exact immutable continuation configuration" });
    }
  } else if (run.checkpoint_source !== undefined) {
    errors.push({ path: "run.checkpoint_source", message: "requires checkpoint-bound continuation hashes" });
  }
}

function validateContinuationPlanningReuse(errors, continuation, path) {
  const reuse = continuation.planning_reuse;
  if (reuse === undefined || reuse === null) return;
  if (!isRecord(reuse)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  const checkpointVariant = Object.hasOwn(continuation, "checkpoint_source_hash");
  allowedKeys(errors, reuse, checkpointVariant ? CHECKPOINT_CONTINUATION_PLANNING_REUSE_KEYS : CONTINUATION_PLANNING_REUSE_KEYS, path);
  if (reuse.eligible !== true) errors.push({ path: `${path}.eligible`, message: "must equal true" });
  if (checkpointVariant) {
    requiredString(errors, reuse, "plan_ref", `${path}.plan_ref`);
    requiredHash(errors, reuse, "plan_hash", `${path}.plan_hash`);
    requiredString(errors, reuse, "review_ref", `${path}.review_ref`);
    requiredHash(errors, reuse, "review_hash", `${path}.review_hash`);
    if (reuse.plan_ref !== "plan/slices.json") errors.push({ path: `${path}.plan_ref`, message: "must equal plan/slices.json" });
    if (reuse.review_ref !== "reviews/work-decomposer.json") errors.push({ path: `${path}.review_ref`, message: "must equal reviews/work-decomposer.json" });
    validateDurableRef(errors, reuse.plan_ref, "plan", `${path}.plan_ref`);
    validateDurableRef(errors, reuse.review_ref, "reviews", `${path}.review_ref`);
    if (reuse.plan_hash !== continuation.carry_forward?.plan_hash) errors.push({ path: `${path}.plan_hash`, message: "must equal carry_forward.plan_hash" });
  } else {
    requiredString(errors, reuse, "spec_review_ref", `${path}.spec_review_ref`);
    requiredHash(errors, reuse, "spec_review_hash", `${path}.spec_review_hash`);
    requiredString(errors, reuse, "spec_artifact_ref", `${path}.spec_artifact_ref`);
    requiredHash(errors, reuse, "spec_artifact_hash", `${path}.spec_artifact_hash`);
    optionalString(errors, reuse, "child_spec_review_ref", `${path}.child_spec_review_ref`);
    validateDurableRef(errors, reuse.spec_review_ref, "reviews", `${path}.spec_review_ref`);
    validateDurableRef(errors, reuse.spec_artifact_ref, "artifacts", `${path}.spec_artifact_ref`);
    if (reuse.child_spec_review_ref !== undefined) validateDurableRef(errors, reuse.child_spec_review_ref, "reviews", `${path}.child_spec_review_ref`);
  }
}

function validatePostPr(errors, run, path) {
  const value = run.post_pr;
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  allowedKeys(errors, value, new Set(["schema_version", "policy", "phase", "attempt", "observation", "remediation", "evidence_refs", "continuation_review", "terminal_fact", "pr_operation"]), path);
  requiredInteger(errors, value, "schema_version", `${path}.schema_version`);
  if (value.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  validatePostPrPolicy(errors, value.policy, `${path}.policy`);
  requiredEnum(errors, value, "phase", POST_PR_PHASE_SET, `${path}.phase`);
  requiredInteger(errors, value, "attempt", `${path}.attempt`);
  if (Number.isInteger(value.attempt) && value.attempt < 0) errors.push({ path: `${path}.attempt`, message: "must be non-negative" });
  if (Number.isInteger(value.attempt) && Number.isInteger(run.max_retries) && value.attempt > run.max_retries) errors.push({ path: `${path}.attempt`, message: "must not exceed run.max_retries" });
  for (const key of ["observation", "remediation", "evidence_refs", "continuation_review", "terminal_fact"]) {
    if (!Object.hasOwn(value, key)) errors.push({ path: `${path}.${key}`, message: "is required, using null when unbound" });
  }
  validatePostPrObservation(errors, value.observation, `${path}.observation`);
  validatePostPrRemediation(errors, value.remediation, `${path}.remediation`);
  validatePostPrRefHashArray(errors, value.evidence_refs, `${path}.evidence_refs`);
  validatePostPrRefHash(errors, value.continuation_review, `${path}.continuation_review`, { optional: true });
  validatePostPrTerminalFact(errors, run, value, `${path}.terminal_fact`);
  validatePostPrOperation(errors, value.pr_operation, `${path}.pr_operation`);

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

function validatePostPrOperation(errors, operation, path) {
  if (operation === undefined || operation === null) return;
  if (!isRecord(operation)) { errors.push({ path, message: "must be an object or null" }); return; }
  allowedKeys(errors, operation, POST_PR_OPERATION_KEYS, path);
  requiredPrOperationIdentity(errors, operation, path);
  requiredTimestamp(errors, operation, "created_at", `${path}.created_at`);
  requiredString(errors, operation, "pr_url", `${path}.pr_url`);
  boundedInteger(errors, operation, "pr_number", 1, Number.MAX_SAFE_INTEGER, `${path}.pr_number`);
  requiredString(errors, operation, "pr_node_id", `${path}.pr_node_id`);
  if (stringValue(operation.pr_url)) {
    try {
      const parts = githubPrUrlParts(operation.pr_url);
      if (parts.url !== operation.pr_url) errors.push({ path: `${path}.pr_url`, message: "must be a canonical GitHub PR URL" });
      if (operation.repository !== parts.repository) errors.push({ path: `${path}.repository`, message: "must match pr_url repository" });
      if (operation.pr_number !== parts.number) errors.push({ path: `${path}.pr_number`, message: "must match pr_url pull request number" });
    } catch { errors.push({ path: `${path}.pr_url`, message: "must be a canonical GitHub PR URL" }); }
  }
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
  for (const key of ["started_at", "deadline_at", "next_poll_at"]) requiredTimestamp(errors, observation, key, `${path}.${key}`);
  for (const key of ["poll_count", "unchanged_count", "consecutive_transient_errors"]) boundedInteger(errors, observation, key, 0, Number.MAX_SAFE_INTEGER, `${path}.${key}`);
  boundedInteger(errors, observation, "current_interval_ms", 1, 600_000, `${path}.current_interval_ms`);
  optionalTimestamp(errors, observation, "last_observed_at", `${path}.last_observed_at`);
  optionalNullableString(errors, observation, "last_fingerprint", `${path}.last_fingerprint`);
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
  requiredTimestamp(errors, value, "occurred_at", `${path}.occurred_at`);
  optionalTimestamp(errors, value, "next_retry_at", `${path}.next_retry_at`);
}

function validatePostPrReviewRequest(errors, value, path) {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) { errors.push({ path, message: "must be an object or null" }); return; }
  allowedKeys(errors, value, new Set(["status", "attempts", "requested_at"]), path);
  requiredEnum(errors, value, "status", new Set(["pending", "requested"]), `${path}.status`);
  boundedInteger(errors, value, "attempts", 0, Number.MAX_SAFE_INTEGER, `${path}.attempts`);
  optionalTimestamp(errors, value, "requested_at", `${path}.requested_at`);
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
  validatePostPrPush(errors, remediation.push, `${path}.push`, remediation);
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
  optionalTimestamp(errors, dispatch, "started_at", `${path}.started_at`);
  optionalTimestamp(errors, dispatch, "returned_at", `${path}.returned_at`);
  if (dispatch.status === "planned" && (dispatch.started_at !== null || dispatch.returned_at !== null)) errors.push({ path, message: "planned dispatch requires null start and return times" });
  if (dispatch.status === "running" && (!isIsoTimestamp(dispatch.started_at) || dispatch.returned_at !== null)) errors.push({ path, message: "running dispatch requires a start time and null return time" });
  if (dispatch.status === "returned" && (!isIsoTimestamp(dispatch.started_at) || !isIsoTimestamp(dispatch.returned_at))) errors.push({ path, message: "returned dispatch requires start and return times" });
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
  optionalNullableEnum(errors, value, "canonical_verdict", new Set(["pass", "red", "fail"]), `${path}.canonical_verdict`);
  optionalNullableEnum(errors, value, "validator_verdict", VALIDATOR_VERDICTS, `${path}.validator_verdict`);
  optionalNullableEnum(errors, value, "security_verdict", SECURITY_VERDICTS, `${path}.security_verdict`);
  const tuples = {
    canonical: ["canonical_evidence_ref", "canonical_evidence_hash", "canonical_verdict"],
    validator: ["validator_review_ref", "validator_review_hash", "validator_verdict"],
    security: ["security_review_ref", "security_review_hash", "security_verdict"],
  };
  for (const [activity, keys] of Object.entries(tuples)) {
    const ownCount = keys.filter((key) => Object.hasOwn(value, key)).length;
    const boundCount = keys.filter((key) => value[key] !== undefined && value[key] !== null).length;
    if (ownCount !== 0 && ownCount !== keys.length) errors.push({ path: `${path}.${activity}_verdict`, message: `${activity} authority keys must be all absent or all present` });
    if (boundCount !== 0 && boundCount !== keys.length) errors.push({ path: `${path}.${activity}_verdict`, message: `${activity} authority ref/hash/verdict must be a complete tuple` });
  }
  if (value.jobs !== undefined) {
    validatePostPrJobs(errors, value.jobs, `${path}.jobs`);
    const bindings = {
      canonical: ["canonical_evidence_ref", "canonical_evidence_hash", "canonical_verdict"],
      validator: ["validator_review_ref", "validator_review_hash", "validator_verdict"],
      security: ["security_review_ref", "security_review_hash", "security_verdict"],
    };
    for (const [activity, [refKey, hashKey, verdictKey]] of Object.entries(bindings)) {
      const job = value.jobs?.[activity];
      if (!isRecord(job) || job.status !== "bound") continue;
      for (const [jobKey, topLevelKey] of [["result_ref", refKey], ["result_hash", hashKey], ["verdict", verdictKey]]) {
        if (job[jobKey] !== value[topLevelKey]) errors.push({ path: `${path}.jobs.${activity}.${jobKey}`, message: `must equal revalidation.${topLevelKey} for a bound ${activity} job` });
      }
    }
  }
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
  for (const key of ["started_at", "returned_at", "next_retry_at"]) optionalTimestamp(errors, job, key, `${path}.${key}`);
  if (job.steering_generation !== null && job.steering_generation !== undefined && (!Number.isInteger(job.steering_generation) || job.steering_generation < 0)) errors.push({ path: `${path}.steering_generation`, message: "must be a non-negative integer or null" });
  boundedInteger(errors, job, "transient_error_count", 0, Number.MAX_SAFE_INTEGER, `${path}.transient_error_count`);
  if (job.status === "running" && (!stringValue(job.action_token) || !stringValue(job.started_at))) errors.push({ path, message: "running job requires action token and start time" });
  if (job.status === "bound" && (!stringValue(job.returned_at) || !stringValue(job.result_ref) || !stringValue(job.result_hash) || !stringValue(job.verdict))) errors.push({ path, message: "bound job requires return/ref/hash/verdict" });
  if (job.status === "planned" && (job.action_token !== null || job.steering_generation !== null || job.started_at !== null)) errors.push({ path, message: "planned job must not carry started steering authority" });
  const vocabulary = activity === "canonical" ? new Set(["pass", "red"]) : activity === "validator" ? VALIDATOR_VERDICTS : SECURITY_VERDICTS;
  if (stringValue(job.verdict) && !vocabulary.has(job.verdict)) errors.push({ path: `${path}.verdict`, message: "is outside the activity verdict vocabulary" });
}

function validatePostPrPush(errors, push, path, remediation) {
  if (!isRecord(push)) { errors.push({ path, message: "must be an object" }); return; }
  allowedKeys(errors, push, new Set(["status", "remote_before_sha", "local_head_sha", "remote_after_sha", "consecutive_transient_errors", "next_retry_at", "pushed_at", "last_error"]), path);
  requiredEnum(errors, push, "status", new Set(["not-ready", "pending", "confirmed"]), `${path}.status`);
  for (const key of ["remote_before_sha", "local_head_sha", "remote_after_sha"]) optionalNullableFullGitSha(errors, push, key, `${path}.${key}`);
  boundedInteger(errors, push, "consecutive_transient_errors", 0, Number.MAX_SAFE_INTEGER, `${path}.consecutive_transient_errors`);
  optionalTimestamp(errors, push, "next_retry_at", `${path}.next_retry_at`);
  optionalTimestamp(errors, push, "pushed_at", `${path}.pushed_at`);
  if (push.status === "not-ready" && [push.remote_before_sha, push.local_head_sha, push.remote_after_sha, push.pushed_at].some((value) => value !== null)) errors.push({ path, message: "not-ready push must not carry remote, local, or publication authority" });
  if (push.status === "pending" && (!stringValue(push.remote_before_sha) || push.local_head_sha !== remediation.candidate_head_sha || push.remote_after_sha !== null || push.pushed_at !== null)) errors.push({ path, message: "pending push must bind remote_before and the current candidate only" });
  if (push.status === "confirmed" && (!stringValue(push.remote_before_sha) || push.local_head_sha !== remediation.candidate_head_sha || push.remote_after_sha !== remediation.candidate_head_sha || !isIsoTimestamp(push.pushed_at))) errors.push({ path, message: "confirmed push must bind the published candidate and timestamp" });
  if (push.last_error !== undefined && push.last_error !== null) {
    const error = push.last_error;
    if (!isRecord(error)) errors.push({ path: `${path}.last_error`, message: "must be an object or null" });
    else {
      allowedKeys(errors, error, new Set(["operation", "observed_at", "error_class", "exit_code", "classification", "error_count", "error_limit", "expected_remote_sha", "candidate_head_sha", "next_retry_at"]), `${path}.last_error`);
      requiredEnum(errors, error, "operation", new Set(["remote-head", "fast-forward-push", "remote-confirmation"]), `${path}.last_error.operation`);
      requiredEnum(errors, error, "classification", new Set(["transient", "permanent", "exhausted"]), `${path}.last_error.classification`);
      optionalNullableInteger(errors, error, "exit_code", `${path}.last_error.exit_code`);
      requiredString(errors, error, "observed_at", `${path}.last_error.observed_at`);
      requiredTimestamp(errors, error, "observed_at", `${path}.last_error.observed_at`);
      if (error.candidate_head_sha !== remediation.candidate_head_sha) errors.push({ path: `${path}.last_error.candidate_head_sha`, message: "must equal remediation candidate_head_sha" });
      if (error.next_retry_at !== push.next_retry_at) errors.push({ path: `${path}.last_error.next_retry_at`, message: "must equal push.next_retry_at" });
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
  allowedKeys(errors, boundary, options.fence ? STEERING_FENCE_KEYS : STEERING_BOUNDARY_KEYS, path);
  if (!options.fence) requiredEnum(errors, boundary, "kind", new Set(["gate", "dispatch", "remediation", "terminal", "post-pr-observe", "post-pr-push"]), `${path}.kind`);
  requiredString(errors, boundary, "token", `${path}.token`);
  if (stringValue(boundary.token) && !/^[A-Za-z0-9_-]{8,128}$/u.test(boundary.token)) errors.push({ path: `${path}.token`, message: "must use 8-128 safe characters" });
  requiredInteger(errors, boundary, "generation", `${path}.generation`);
  if (Number.isInteger(boundary.generation) && boundary.generation < 0) errors.push({ path: `${path}.generation`, message: "must be non-negative" });
  requiredHash(errors, boundary, "state_hash", `${path}.state_hash`);
  requiredTimestamp(errors, boundary, "created_at", `${path}.created_at`);
  if (options.fence) {
    const identityOwnCount = PR_OPERATION_IDENTITY_KEYS.filter((key) => Object.hasOwn(boundary, key)).length;
    if (identityOwnCount !== PR_OPERATION_IDENTITY_KEYS.length) errors.push({ path, message: `${PR_OPERATION_IDENTITY_KEYS.join(", ")} must all be present` });
    if (identityOwnCount === PR_OPERATION_IDENTITY_KEYS.length) requiredPrOperationIdentity(errors, boundary, path);
  }
}

function requiredPrOperationIdentity(errors, value, path) {
  requiredString(errors, value, "operation_id", `${path}.operation_id`);
  if (stringValue(value.operation_id) && !/^ffpr-v1-[0-9a-f]{64}$/u.test(value.operation_id)) errors.push({ path: `${path}.operation_id`, message: "must be an ffpr-v1 lowercase SHA-256 identity" });
  requiredString(errors, value, "repository", `${path}.repository`);
  if (stringValue(value.repository) && !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(value.repository)) errors.push({ path: `${path}.repository`, message: "must be a canonical lowercase owner/repository" });
  for (const key of ["head_ref", "base_ref"]) {
    requiredString(errors, value, key, `${path}.${key}`);
    if (stringValue(value[key]) && (value[key].startsWith("refs/") || value[key].includes("..") || /[\s~^:?*[\\\x00-\x1f\x7f]/u.test(value[key]))) errors.push({ path: `${path}.${key}`, message: "must be a safe branch ref" });
  }
  requiredFullGitSha(errors, value, "head_sha", `${path}.head_sha`);
  requiredFullGitSha(errors, value, "base_sha", `${path}.base_sha`);
  requiredBoolean(errors, value, "draft", `${path}.draft`);
}

function validateSteeringAction(errors, action, path, options = {}) {
  if (action === undefined || action === null) return;
  if (!isRecord(action)) {
    errors.push({ path, message: "must be an object or null" });
    return;
  }
  allowedKeys(errors, action, options.resolved ? STEERING_LAST_ACTION_KEYS : STEERING_ACTION_CLAIM_KEYS, path);
  requiredEnum(errors, action, "kind", new Set(["dispatch", "remediation", "terminal", "post-pr-observe", "post-pr-push"]), `${path}.kind`);
  requiredString(errors, action, "token", `${path}.token`);
  if (stringValue(action.token) && !/^[A-Za-z0-9_-]{8,128}$/u.test(action.token)) errors.push({ path: `${path}.token`, message: "must use 8-128 safe characters" });
  requiredInteger(errors, action, "generation", `${path}.generation`);
  if (Number.isInteger(action.generation) && action.generation < 0) errors.push({ path: `${path}.generation`, message: "must be non-negative" });
  requiredTimestamp(errors, action, "claimed_at", `${path}.claimed_at`);
  if (options.resolved) {
    requiredEnum(errors, action, "outcome", new Set(["started", "aborted", "closed"]), `${path}.outcome`);
    requiredTimestamp(errors, action, "resolved_at", `${path}.resolved_at`);
  }
}

function validateContinuationParent(errors, parent, path) {
  if (!isRecord(parent)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  allowedKeys(errors, parent, CONTINUATION_PARENT_KEYS, path);
  requiredString(errors, parent, "run_id", `${path}.run_id`);
  requiredEnum(errors, parent, "status", BLOCKED_CONTINUATION_PARENT_STATUSES, `${path}.status`);
  requiredString(errors, parent, "run_ref", `${path}.run_ref`);
  requiredHash(errors, parent, "run_hash", `${path}.run_hash`);
  requiredString(errors, parent, "branch", `${path}.branch`);
  requiredFullGitSha(errors, parent, "commit", `${path}.commit`);
  requiredString(errors, parent, "worktree", `${path}.worktree`);
  if (stringValue(parent.run_id) && stringValue(parent.run_ref) && parent.run_ref !== `.opencode/factory/${parent.run_id}/run.json`) {
    errors.push({ path: `${path}.run_ref`, message: "must identify the parent run.json" });
  }
}

function validateContinuationReview(errors, review, path) {
  if (!isRecord(review)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  allowedKeys(errors, review, CONTINUATION_REVIEW_KEYS, path);
  requiredString(errors, review, "ref", `${path}.ref`);
  validateDurableRef(errors, review.ref, "reviews", `${path}.ref`);
  requiredEnum(errors, review, "kind", CONTINUATION_REVIEW_KINDS, `${path}.kind`);
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
  allowedKeys(errors, target, CONTINUATION_TARGET_KEYS, path);
  requiredString(errors, target, "run_id", `${path}.run_id`);
  requiredString(errors, target, "branch", `${path}.branch`);
  requiredString(errors, target, "worktree", `${path}.worktree`);
  requiredString(errors, target, "base_ref", `${path}.base_ref`);
  requiredFullGitSha(errors, target, "base_commit", `${path}.base_commit`);
  if (stringValue(target.run_id) && stringValue(run.run_id) && target.run_id !== run.run_id) errors.push({ path: `${path}.run_id`, message: "must match run.run_id" });
  if (stringValue(target.branch) && stringValue(run.branch) && target.branch !== run.branch) errors.push({ path: `${path}.branch`, message: "must match run.branch" });
  if (stringValue(target.worktree) && stringValue(run.worktree) && target.worktree !== run.worktree) errors.push({ path: `${path}.worktree`, message: "must match run.worktree" });
  if (stringValue(target.run_id) && stringValue(run.continuation?.parent?.run_id) && target.run_id === run.continuation.parent.run_id) errors.push({ path: `${path}.run_id`, message: "must differ from continuation.parent.run_id" });
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
    allowedKeys(errors, item, CONTINUATION_REF_HASH_KEYS, itemPath);
    requiredString(errors, item, "kind", `${itemPath}.kind`);
    requiredString(errors, item, "ref", `${itemPath}.ref`);
    requiredHash(errors, item, "hash", `${itemPath}.hash`);
    if (path.endsWith(".parent_artifacts")) {
      if (stringValue(item.kind) && !CONTINUATION_ARTIFACT_KINDS.has(item.kind)) errors.push({ path: `${itemPath}.kind`, message: `must be one of ${[...CONTINUATION_ARTIFACT_KINDS].join(", ")}` });
      validateDurableRef(errors, item.ref, "artifacts", `${itemPath}.ref`);
    } else if (path.endsWith(".parent_evidence")) {
      if (item.kind !== "evidence") errors.push({ path: `${itemPath}.kind`, message: "must equal evidence" });
      validateDurableRef(errors, item.ref, "evidence", `${itemPath}.ref`);
    } else {
      if (item.kind !== "review") errors.push({ path: `${itemPath}.kind`, message: "must equal review" });
      validateDurableRef(errors, item.ref, "reviews", `${itemPath}.ref`);
    }
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

function validateGate(errors, run, gate, path, gateName) {
  if (!isRecord(gate)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  allowedKeys(errors, gate, GATE_KEYS, path);
  requiredEnum(errors, gate, "status", GATE_STATUSES, `${path}.status`);
  optionalString(errors, gate, "artifact", `${path}.artifact`);
  optionalString(errors, gate, "question_ref", `${path}.question_ref`);
  optionalString(errors, gate, "answer_ref", `${path}.answer_ref`);
  validateDurableRef(errors, gate.artifact, "artifacts", `${path}.artifact`);
  validateDurableRef(errors, gate.question_ref, "gates", `${path}.question_ref`);
  validateDurableRef(errors, gate.answer_ref, "gates", `${path}.answer_ref`);
  optionalTimestamp(errors, gate, "answered_at", `${path}.answered_at`);
  optionalString(errors, gate, "answer", `${path}.answer`);
  optionalString(errors, gate, "decision_note", `${path}.decision_note`);
  optionalEnum(errors, gate, "approval_source", APPROVAL_SOURCES, `${path}.approval_source`);
  validatePendingSnapshot(errors, gate.pending_snapshot, `${path}.pending_snapshot`);
  validateGateHandoffReceipt(errors, gate.handoff_receipt, `${path}.handoff_receipt`, gateName);
  validateGateRelationships(errors, run, gate, path);
}

function validateGateHandoffReceipt(errors, receipt, path, gateName) {
  if (receipt === undefined || receipt === null) return;
  if (!isRecord(receipt)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  allowedKeys(errors, receipt, HANDOFF_RECEIPT_KEYS, path);
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
  requiredTimestamp(errors, receipt, "accepted_at", `${path}.accepted_at`);
}

function validatePendingSnapshot(errors, pendingSnapshot, path) {
  if (pendingSnapshot === undefined || pendingSnapshot === null) return;
  if (!isRecord(pendingSnapshot)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  allowedKeys(errors, pendingSnapshot, PENDING_SNAPSHOT_KEYS, path);
  requiredString(errors, pendingSnapshot, "question_ref", `${path}.question_ref`);
  requiredHash(errors, pendingSnapshot, "question_hash", `${path}.question_hash`);
  requiredString(errors, pendingSnapshot, "artifact_ref", `${path}.artifact_ref`);
  requiredHash(errors, pendingSnapshot, "artifact_hash", `${path}.artifact_hash`);
  optionalString(errors, pendingSnapshot, "answer_ref", `${path}.answer_ref`);
  optionalHash(errors, pendingSnapshot, "answer_hash", `${path}.answer_hash`);
  optionalHash(errors, pendingSnapshot, "checked_authority_hash", `${path}.checked_authority_hash`);
  requiredTimestamp(errors, pendingSnapshot, "created_at", `${path}.created_at`);
  validateDurableRef(errors, pendingSnapshot.question_ref, "gates", `${path}.question_ref`);
  validateDurableRef(errors, pendingSnapshot.artifact_ref, "artifacts", `${path}.artifact_ref`);
  if (pendingSnapshot.answer_ref !== undefined) validateDurableRef(errors, pendingSnapshot.answer_ref, "gates", `${path}.answer_ref`);
}

function validateGateRelationships(errors, run, gate, path) {
  const snapshot = gate.pending_snapshot;
  if (isRecord(snapshot)) {
    if (stringValue(gate.artifact) && stringValue(snapshot.artifact_ref) && gate.artifact !== snapshot.artifact_ref) errors.push({ path: `${path}.artifact`, message: "must match pending_snapshot.artifact_ref" });
    if (stringValue(gate.question_ref) && stringValue(snapshot.question_ref) && gate.question_ref !== snapshot.question_ref) errors.push({ path: `${path}.question_ref`, message: "must match pending_snapshot.question_ref" });
  }
  if (gate.status === "pending") {
    for (const key of ["answer", "answered_at", "approval_source", "handoff_receipt"]) if (gate[key] !== undefined && gate[key] !== null) errors.push({ path: `${path}.${key}`, message: "is forbidden for a pending gate" });
    if (stringValue(gate.answer_ref) && stringValue(snapshot?.answer_ref) && gate.answer_ref !== snapshot.answer_ref) errors.push({ path: `${path}.answer_ref`, message: "must match pending_snapshot.answer_ref while pending" });
    return;
  }
  if (gate.answer !== undefined) requiredString(errors, gate, "answer", `${path}.answer`);
  if (stringValue(gate.answer_ref) && stringValue(snapshot?.answer_ref) && !gate.answer_ref.startsWith(`${snapshot.answer_ref}.consumed-`)) errors.push({ path: `${path}.answer_ref`, message: "must be an archived form of pending_snapshot.answer_ref" });
  const expectedAnswer = gate.status === "approved" ? "approve" : gate.status === "stopped" ? "stop" : null;
  if (expectedAnswer && stringValue(gate.answer) && gate.answer !== expectedAnswer) errors.push({ path: `${path}.answer`, message: `must equal ${expectedAnswer} for ${gate.status}` });
  if (gate.status === "changes_requested" && stringValue(gate.answer) && !(gate.answer.startsWith("changes:") && gate.answer.slice("changes:".length).trim())) errors.push({ path: `${path}.answer`, message: "must start with changes: and include a reason" });
  const interactiveApproval = gate.status === "approved" && run.mode === "interactive";
  if (interactiveApproval && !isRecord(gate.handoff_receipt)) errors.push({ path: `${path}.handoff_receipt`, message: "is required for an interactive approval" });
  if (!interactiveApproval && gate.handoff_receipt !== undefined && gate.handoff_receipt !== null) errors.push({ path: `${path}.handoff_receipt`, message: "is forbidden for this gate variant" });
  if (isRecord(gate.handoff_receipt) && stringValue(gate.answered_at) && gate.handoff_receipt.accepted_at !== gate.answered_at) errors.push({ path: `${path}.handoff_receipt.accepted_at`, message: "must match answered_at" });
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
  for (const [index, slice] of slices.entries()) validateRunSlice(errors, slice, `${path}[${index}]`, ids, slices);
}

function validateRunSlice(errors, slice, path, ids, slices) {
  if (!isRecord(slice)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  allowedKeys(errors, slice, SLICE_KEYS, path);
  requiredTerminalSafeString(errors, slice, "id", `${path}.id`);
  optionalString(errors, slice, "stack", `${path}.stack`);
  validateStringArray(errors, slice.depends_on, `${path}.depends_on`, { required: false, values: ids });
  validateDurableOwnershipPaths(errors, slice.declared_paths, `${path}.declared_paths`, { concreteOnly: false });
  validateDurableOwnershipPaths(errors, slice.effective_paths, `${path}.effective_paths`, { concreteOnly: false });
  requiredEnum(errors, slice, "status", SLICE_STATUSES, `${path}.status`);
  optionalString(errors, slice, "branch", `${path}.branch`);
  optionalString(errors, slice, "worktree", `${path}.worktree`);
  if (slice.authorized_baseline_commit !== undefined) requiredFullGitSha(errors, slice, "authorized_baseline_commit", `${path}.authorized_baseline_commit`);
  if (stringValue(slice.worktree) && !isAbsolute(slice.worktree)) {
    const segments = slice.worktree.split("/");
    if (slice.worktree.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      errors.push({ path: `${path}.worktree`, message: "must be an absolute path or safe repository-relative path" });
    }
  }
  optionalInteger(errors, slice, "attempts", `${path}.attempts`);
  if (Number.isInteger(slice.attempts) && slice.attempts > SLICE_MAX_ATTEMPTS) errors.push({ path: `${path}.attempts`, message: `must not exceed ${SLICE_MAX_ATTEMPTS}` });
  if (slice.dispatch_required !== undefined && typeof slice.dispatch_required !== "boolean") errors.push({ path: `${path}.dispatch_required`, message: "must be a boolean" });
  for (const key of ["dispatch_claim_ref", "dispatch_closure_ref"]) optionalString(errors, slice, key, `${path}.${key}`);
  for (const key of ["dispatch_claim_hash", "dispatch_closure_hash"]) optionalHash(errors, slice, key, `${path}.${key}`);
  const dispatchClaimCount = presentBindingCount(slice, ["dispatch_claim_ref", "dispatch_claim_hash"]);
  const dispatchClosureCount = presentBindingCount(slice, ["dispatch_closure_ref", "dispatch_closure_hash"]);
  if (![0, 2].includes(dispatchClaimCount)) errors.push({ path, message: "dispatch_claim_ref and dispatch_claim_hash must be both present or both absent" });
  if (![0, 2].includes(dispatchClosureCount)) errors.push({ path, message: "dispatch_closure_ref and dispatch_closure_hash must be both present or both absent" });
  if (dispatchClosureCount === 2 && dispatchClaimCount !== 2) errors.push({ path, message: "dispatch closure binding requires the claim binding" });
  if (dispatchClaimCount > 0 && slice.dispatch_required !== true) errors.push({ path: `${path}.dispatch_required`, message: "must be true when dispatch authority is bound" });
  if (slice.status === "pending" && (slice.dispatch_required !== undefined || dispatchClaimCount > 0 || dispatchClosureCount > 0)) errors.push({ path, message: "pending slice cannot carry dispatch authority" });
  if (slice.status === "pending" && slice.authorized_baseline_commit !== undefined) errors.push({ path: `${path}.authorized_baseline_commit`, message: "pending slice cannot carry an authorized baseline" });
  if (["review", "merged"].includes(slice.status) && slice.dispatch_required === true && dispatchClosureCount !== 2) errors.push({ path, message: "successor review/merged slice requires exact closed dispatch authority" });
  for (const [key, suffix] of [["dispatch_claim_ref", ".json"], ["dispatch_closure_ref", ".closed.json"]]) {
    if (stringValue(slice[key]) && (!slice[key].startsWith("dispatch/") || !slice[key].endsWith(suffix) || slice[key].includes("..") || slice[key].includes("\\"))) {
      errors.push({ path: `${path}.${key}`, message: `must be a safe dispatch/${suffix === ".json" ? "<hash>.json" : "<hash>.closed.json"} ref` });
    }
  }
  validateSliceAttemptReviews(errors, slice, path);
  optionalString(errors, slice, "evidence_ref", `${path}.evidence_ref`);
  optionalHash(errors, slice, "evidence_hash", `${path}.evidence_hash`);
  optionalString(errors, slice, "review_ref", `${path}.review_ref`);
  optionalHash(errors, slice, "review_hash", `${path}.review_hash`);
  if (slice.reviewed_commit !== undefined && slice.reviewed_commit !== null) requiredFullGitSha(errors, slice, "reviewed_commit", `${path}.reviewed_commit`);
  optionalString(errors, slice, "merge_commit", `${path}.merge_commit`);
  validateIntegrationConflict(errors, slice.integration_conflict, `${path}.integration_conflict`, slice, slices);
  optionalString(errors, slice, "blocked_reason", `${path}.blocked_reason`);
  optionalTimestamp(errors, slice, "updated_at", `${path}.updated_at`);
  validateDurableRef(errors, slice.evidence_ref, "evidence", `${path}.evidence_ref`);
  validateDurableRef(errors, slice.review_ref, "reviews", `${path}.review_ref`);
  if (slice.status === "pending" && slice.attempts !== 0) errors.push({ path: `${path}.attempts`, message: "must equal 0 while pending" });
  if (["running", "review", "merged"].includes(slice.status) && Number.isInteger(slice.attempts) && slice.attempts < 1) errors.push({ path: `${path}.attempts`, message: "must be positive once slice work starts" });
  if (slice.status === "blocked" && !stringValue(slice.blocked_reason)) errors.push({ path: `${path}.blocked_reason`, message: "is required for blocked" });
  const bindingCount = presentBindingCount(slice, SLICE_REVIEW_BINDING_KEYS);
  if (["review", "merged"].includes(slice.status)) {
    if (bindingCount !== SLICE_REVIEW_BINDING_KEYS.length) errors.push({ path, message: "review and merged slices require complete evidence_hash, review_hash, and reviewed_commit bindings" });
    if (!stringValue(slice.evidence_ref)) errors.push({ path: `${path}.evidence_ref`, message: "is required by the successor review binding" });
    if (!stringValue(slice.review_ref)) errors.push({ path: `${path}.review_ref`, message: "is required by the successor review binding" });
  } else if (bindingCount !== 0) {
    errors.push({ path, message: "evidence_hash, review_hash, and reviewed_commit are forbidden outside review or merged" });
  }
  validateSliceEffectiveOwnership(errors, slice, path);
}

function validateSliceAttemptReviews(errors, slice, path) {
  if (slice.attempt_reviews === undefined) {
    if (["review", "merged"].includes(slice.status)) errors.push({ path: `${path}.attempt_reviews`, message: "is required for review and merged slices" });
    return;
  }
  if (!Array.isArray(slice.attempt_reviews)) {
    errors.push({ path: `${path}.attempt_reviews`, message: "must be an array" });
    return;
  }
  let priorAttempt = 0;
  let diffBaseCommit = null;
  for (const [index, review] of slice.attempt_reviews.entries()) {
    const reviewPath = `${path}.attempt_reviews[${index}]`;
    if (!isRecord(review)) {
      errors.push({ path: reviewPath, message: "must be an object" });
      continue;
    }
    allowedKeys(errors, review, SLICE_ATTEMPT_REVIEW_KEYS, reviewPath);
    boundedInteger(errors, review, "attempt", 1, SLICE_MAX_ATTEMPTS, `${reviewPath}.attempt`);
    requiredString(errors, review, "evidence_ref", `${reviewPath}.evidence_ref`);
    requiredHash(errors, review, "evidence_hash", `${reviewPath}.evidence_hash`);
    requiredString(errors, review, "review_ref", `${reviewPath}.review_ref`);
    requiredHash(errors, review, "review_hash", `${reviewPath}.review_hash`);
    requiredFullGitSha(errors, review, "reviewed_commit", `${reviewPath}.reviewed_commit`);
    requiredFullGitSha(errors, review, "diff_base_commit", `${reviewPath}.diff_base_commit`);
    validateCanonicalConcretePathSet(errors, review.ratified_paths, `${reviewPath}.ratified_paths`, { allowEmpty: true, sorted: true });
    const successorHistory = review.ownership_schema_version === 2 || review.modified_extensions !== undefined;
    if (successorHistory) {
      boundedInteger(errors, review, "ownership_schema_version", 2, 2, `${reviewPath}.ownership_schema_version`);
      validateModifiedExtensions(errors, review.modified_extensions, `${reviewPath}.modified_extensions`);
      const extensionPaths = Array.isArray(review.modified_extensions) ? review.modified_extensions.map((entry) => entry?.path) : [];
      if (Array.isArray(review.ratified_paths) && JSON.stringify(review.ratified_paths) !== JSON.stringify(extensionPaths)) {
        errors.push({ path: `${reviewPath}.ratified_paths`, message: "must exactly equal modified_extensions paths" });
      }
    } else if (review.ownership_schema_version !== undefined || review.modified_extensions !== undefined) {
      errors.push({ path: reviewPath, message: "must be either an immutable v1 entry or a complete v2 ownership entry" });
    }
    requiredEnum(errors, review, "verdict", SLICE_REVIEW_VERDICTS, `${reviewPath}.verdict`);
    requiredEnum(errors, review, "convergence", SLICE_REVIEW_CONVERGENCE, `${reviewPath}.convergence`);
    appendSliceReviewStrikePolicyErrors(errors, review, reviewPath, slice.attempt_reviews.slice(0, index));
    boundedInteger(errors, review, "remaining_fix_count", 0, Number.MAX_SAFE_INTEGER, `${reviewPath}.remaining_fix_count`);
    for (const key of ["dispatch_claim_ref", "dispatch_closure_ref"]) optionalString(errors, review, key, `${reviewPath}.${key}`);
    for (const key of ["dispatch_claim_hash", "dispatch_closure_hash"]) optionalHash(errors, review, key, `${reviewPath}.${key}`);
    const dispatchCount = presentBindingCount(review, ["dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash"]);
    if (![0, 4].includes(dispatchCount)) errors.push({ path: reviewPath, message: "attempt dispatch claim and closure bindings must be all present or all absent" });
    for (const [key, suffix] of [["dispatch_claim_ref", ".json"], ["dispatch_closure_ref", ".closed.json"]]) {
      if (stringValue(review[key]) && (!review[key].startsWith("dispatch/") || !review[key].endsWith(suffix) || review[key].includes("..") || review[key].includes("\\"))) {
        errors.push({ path: `${reviewPath}.${key}`, message: `must be a safe dispatch/${suffix === ".json" ? "<hash>.json" : "<hash>.closed.json"} ref` });
      }
    }
    validateDurableRef(errors, review.evidence_ref, "evidence", `${reviewPath}.evidence_ref`);
    validateDurableRef(errors, review.review_ref, "reviews", `${reviewPath}.review_ref`);
    if (Number.isInteger(review.attempt)) {
      if (review.attempt <= priorAttempt) errors.push({ path: `${reviewPath}.attempt`, message: "must be strictly increasing" });
      if (Number.isInteger(slice.attempts) && review.attempt > slice.attempts) errors.push({ path: `${reviewPath}.attempt`, message: "must not exceed slice attempts" });
      priorAttempt = Math.max(priorAttempt, review.attempt);
    }
    if (review.verdict === "APPROVE" && review.remaining_fix_count !== 0) errors.push({ path: `${reviewPath}.remaining_fix_count`, message: "must equal 0 for APPROVE" });
    if (review.verdict === "REJECT" && Number.isInteger(review.remaining_fix_count) && review.remaining_fix_count < 1) errors.push({ path: `${reviewPath}.remaining_fix_count`, message: "must be positive for REJECT" });
    if (review.verdict === "REJECT" && Array.isArray(review.ratified_paths) && review.ratified_paths.length !== 0) errors.push({ path: `${reviewPath}.ratified_paths`, message: "must be empty for REJECT" });
    if (review.verdict === "REJECT" && Array.isArray(review.modified_extensions) && review.modified_extensions.length !== 0) errors.push({ path: `${reviewPath}.modified_extensions`, message: "must be empty for REJECT" });
    if (FULL_GIT_SHA_PATTERN.test(String(review.diff_base_commit || ""))) {
      if (diffBaseCommit === null) diffBaseCommit = review.diff_base_commit;
      else if (review.diff_base_commit !== diffBaseCommit) errors.push({ path: `${reviewPath}.diff_base_commit`, message: "must equal the first checked dispatch baseline for every attempt" });
    }
  }
  const current = slice.attempt_reviews.at(-1);
  if (["review", "merged"].includes(slice.status)) {
    if (!current || !Number.isInteger(slice.attempts) || current.attempt !== slice.attempts) {
      errors.push({ path: `${path}.attempt_reviews`, message: "must end with the current review or merged slice attempt" });
    } else {
      for (const key of ["evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit"]) {
        if (slice[key] !== current[key]) errors.push({ path: `${path}.${key}`, message: `must equal the current attempt_reviews ${key}` });
      }
    }
  }
}

function validateModifiedExtensions(errors, extensions, path) {
  if (!Array.isArray(extensions)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  const paths = [];
  for (const [index, extension] of extensions.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(extension)) {
      errors.push({ path: itemPath, message: "must be an object" });
      continue;
    }
    const sibling = extension.authority === "non-conflicting-sibling";
    allowedKeys(errors, extension, sibling ? MODIFIED_EXTENSION_SIBLING_KEYS : MODIFIED_EXTENSION_COMMON_KEYS, itemPath);
    requiredString(errors, extension, "kind", `${itemPath}.kind`);
    if (extension.kind !== "modified-extension") errors.push({ path: `${itemPath}.kind`, message: "must equal modified-extension" });
    if (!isCanonicalConcreteRepositoryPath(extension.path)) errors.push({ path: `${itemPath}.path`, message: "must be a canonical concrete repository path without globs" });
    else paths.push(extension.path);
    requiredTerminalSafeString(errors, extension, "rationale", `${itemPath}.rationale`);
    if (stringValue(extension.rationale) && (extension.rationale !== extension.rationale.trim() || extension.rationale !== extension.rationale.normalize("NFC"))) {
      errors.push({ path: `${itemPath}.rationale`, message: "must be trimmed NFC-normalized text" });
    }
    requiredEnum(errors, extension, "authority", new Set(["unowned", "non-conflicting-sibling"]), `${itemPath}.authority`);
    if (sibling) {
      requiredTerminalSafeString(errors, extension, "owner_slice_id", `${itemPath}.owner_slice_id`);
      boundedInteger(errors, extension, "owner_attempt", 1, SLICE_MAX_ATTEMPTS, `${itemPath}.owner_attempt`);
      for (const key of ["owner_evidence_ref", "owner_review_ref", "owner_dispatch_claim_ref", "owner_dispatch_closure_ref"]) requiredString(errors, extension, key, `${itemPath}.${key}`);
      for (const key of ["owner_evidence_hash", "owner_review_hash", "owner_dispatch_claim_hash", "owner_dispatch_closure_hash"]) requiredHash(errors, extension, key, `${itemPath}.${key}`);
      requiredFullGitSha(errors, extension, "owner_reviewed_commit", `${itemPath}.owner_reviewed_commit`);
      requiredFullGitSha(errors, extension, "owner_diff_base_commit", `${itemPath}.owner_diff_base_commit`);
      validateDurableRef(errors, extension.owner_evidence_ref, "evidence", `${itemPath}.owner_evidence_ref`);
      validateDurableRef(errors, extension.owner_review_ref, "reviews", `${itemPath}.owner_review_ref`);
      for (const [key, suffix] of [["owner_dispatch_claim_ref", ".json"], ["owner_dispatch_closure_ref", ".closed.json"]]) {
        const value = extension[key];
        if (stringValue(value) && (!value.startsWith("dispatch/") || !value.endsWith(suffix) || value.includes("..") || value.includes("\\"))) {
          errors.push({ path: `${itemPath}.${key}`, message: `must be a safe dispatch/${suffix === ".json" ? "<hash>.json" : "<hash>.closed.json"} ref` });
        }
      }
    }
  }
  if (new Set(paths).size !== paths.length) errors.push({ path, message: "must contain unique paths" });
  if (paths.some((value, index) => index > 0 && paths[index - 1] >= value)) errors.push({ path, message: "must be sorted by path" });
}

function validateDurableOwnershipPaths(errors, paths, path, { concreteOnly }) {
  if (!Array.isArray(paths) || paths.length < 1) {
    errors.push({ path, message: "must be a nonempty array of unique canonical ownership paths" });
    return;
  }
  const valid = [];
  for (const [index, value] of paths.entries()) {
    const canonical = concreteOnly ? isCanonicalConcreteRepositoryPath(value) : validatePlanPath(value) === value;
    if (!canonical) errors.push({ path: `${path}[${index}]`, message: "must be a canonical ownership path" });
    else valid.push(value);
  }
  if (new Set(valid).size !== valid.length) errors.push({ path, message: "must contain unique paths" });
}

function validateSliceEffectiveOwnership(errors, slice, path) {
  if (!Array.isArray(slice.declared_paths) || !Array.isArray(slice.effective_paths)) return;
  const current = Array.isArray(slice.attempt_reviews) ? slice.attempt_reviews.at(-1) : null;
  const ratified = ["review", "merged"].includes(slice.status) && current?.attempt === slice.attempts && current.verdict === "APPROVE" && Array.isArray(current.ratified_paths)
    ? current.ratified_paths
    : [];
  const expected = [...slice.declared_paths, ...ratified];
  if (JSON.stringify(slice.effective_paths) !== JSON.stringify(expected)) {
    errors.push({ path: `${path}.effective_paths`, message: "must equal declared_paths plus only the current APPROVE review ratified_paths" });
  }
}

function validatePlannedSlices(errors, slices, path, { enforceDependencyDepth }) {
  const ids = validateSliceIDs(errors, slices, path);
  for (const [index, slice] of slices.entries()) {
    if (!isRecord(slice)) {
      errors.push({ path: `${path}[${index}]`, message: "must be an object" });
      continue;
    }
    allowedKeys(errors, slice, PLANNED_SLICE_KEYS, `${path}[${index}]`);
    requiredTerminalSafeString(errors, slice, "id", `${path}[${index}].id`);
    requiredString(errors, slice, "stack", `${path}[${index}].stack`);
    validateStringArray(errors, slice.paths, `${path}[${index}].paths`, { required: true, nonEmpty: true });
    if (Array.isArray(slice.paths)) {
      for (const [laneIndex, lane] of slice.paths.entries()) canonicalPlanOwnershipLane(lane, errors, `${path}[${index}].paths[${laneIndex}]`);
      if (new Set(slice.paths).size !== slice.paths.length) errors.push({ path: `${path}[${index}].paths`, message: "must contain unique declared ownership lanes" });
    }
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

function validateSteps(errors, run, path) {
  const steps = run.steps;
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
    allowedKeys(errors, step, STEP_KEYS, `${path}[${index}]`);
    requiredTerminalSafeString(errors, step, "agent", `${path}[${index}].agent`);
    requiredEnum(errors, step, "status", STEP_STATUSES, `${path}[${index}].status`);
    optionalInteger(errors, step, "attempts", `${path}[${index}].attempts`);
    optionalString(errors, step, "artifact_ref", `${path}[${index}].artifact_ref`);
    optionalString(errors, step, "review_ref", `${path}[${index}].review_ref`);
    optionalString(errors, step, "evidence_ref", `${path}[${index}].evidence_ref`);
    if (!(step.agent === "work-decomposer" && step.artifact_ref === PLAN_SLICES_REF)) validateDurableRef(errors, step.artifact_ref, "artifacts", `${path}[${index}].artifact_ref`);
    validateDurableRef(errors, step.review_ref, "reviews", `${path}[${index}].review_ref`);
    validateDurableRef(errors, step.evidence_ref, "evidence", `${path}[${index}].evidence_ref`);
    validateStepAcceptance(errors, step.acceptance, `${path}[${index}].acceptance`, step);
    validateStepInheritedAcceptance(errors, step.inherited_acceptance, `${path}[${index}].inherited_acceptance`);
    validateTestExecutionClaim(errors, step.execution_claim, `${path}[${index}].execution_claim`);
    validateTestExecutionClaimBinding(errors, step, `${path}[${index}]`);
    validateStepRelationships(errors, run, step, `${path}[${index}]`);
  }
}

function validateTestExecutionClaim(errors, claim, path) {
  if (claim === undefined || claim === null) return;
  if (!isRecord(claim)) { errors.push({ path, message: "must be an object" }); return; }
  const allowed = claim.state === "completed" ? TEST_EXECUTION_CLAIM_COMPLETED_KEYS : claim.state === "unknown" ? TEST_EXECUTION_CLAIM_UNKNOWN_KEYS : TEST_EXECUTION_CLAIM_COMMON_KEYS;
  allowedKeys(errors, claim, allowed, path);
  requiredInteger(errors, claim, "schema_version", `${path}.schema_version`);
  if (claim.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  requiredString(errors, claim, "kind", `${path}.kind`);
  if (claim.kind !== "checked-test-execution-claim") errors.push({ path: `${path}.kind`, message: "must equal checked-test-execution-claim" });
  requiredEnum(errors, claim, "state", new Set(["active", "completed", "unknown"]), `${path}.state`);
  requiredString(errors, claim, "nonce", `${path}.nonce`);
  if (!isUuidV4(claim.nonce)) errors.push({ path: `${path}.nonce`, message: "must be a UUID v4" });
  requiredString(errors, claim, "run_id", `${path}.run_id`);
  boundedInteger(errors, claim, "attempt", 1, Number.MAX_SAFE_INTEGER, `${path}.attempt`);
  requiredString(errors, claim, "plan_ref", `${path}.plan_ref`);
  if (claim.plan_ref !== PLAN_SLICES_REF) errors.push({ path: `${path}.plan_ref`, message: `must equal ${PLAN_SLICES_REF}` });
  requiredHash(errors, claim, "plan_hash", `${path}.plan_hash`);
  requiredFullGitSha(errors, claim, "head_sha", `${path}.head_sha`);
  optionalCheckedExecutionTimeout(errors, claim, `${path}.timeout_ms`);
  requiredString(errors, claim, "receipt_ref", `${path}.receipt_ref`);
  if (Number.isInteger(claim.attempt) && claim.receipt_ref !== `evidence/test-verifier.attempt-${claim.attempt}.json`) errors.push({ path: `${path}.receipt_ref`, message: "must equal the fixed attempt receipt ref" });
  requiredTimestamp(errors, claim, "claimed_at", `${path}.claimed_at`);
  if (claim.state === "completed") {
    requiredTimestamp(errors, claim, "completed_at", `${path}.completed_at`);
    requiredEnum(errors, claim, "status", TEST_EXECUTION_STATUSES, `${path}.status`);
    requiredHash(errors, claim, "receipt_hash", `${path}.receipt_hash`);
  }
  if (claim.state === "unknown") {
    requiredTimestamp(errors, claim, "failed_at", `${path}.failed_at`);
    requiredEnum(errors, claim, "reason", TEST_EXECUTION_UNKNOWN_REASONS, `${path}.reason`);
  }
}

function validateTestExecutionClaimBinding(errors, step, path) {
  const hasClaim = step.execution_claim !== undefined && step.execution_claim !== null;
  const hasHash = step.execution_claim_hash !== undefined && step.execution_claim_hash !== null;
  if (hasClaim !== hasHash) {
    errors.push({ path: `${path}.execution_claim_hash`, message: "must be present exactly when execution_claim is present" });
    return;
  }
  if (!hasClaim) return;
  requiredHash(errors, step, "execution_claim_hash", `${path}.execution_claim_hash`);
  if (isRecord(step.execution_claim) && typeof step.execution_claim_hash === "string" && /^sha256:[0-9a-f]{64}$/u.test(step.execution_claim_hash)
    && step.execution_claim_hash !== hashValue(step.execution_claim)) {
    errors.push({ path: `${path}.execution_claim_hash`, message: "must equal the canonical execution_claim hash" });
  }
}

function validateStepAcceptance(errors, acceptance, path, step) {
  if (acceptance === undefined || acceptance === null) return;
  if (!isRecord(acceptance)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  allowedKeys(errors, acceptance, STEP_ACCEPTANCE_KEYS, path);
  requiredString(errors, acceptance, "artifact_ref", `${path}.artifact_ref`);
  requiredHash(errors, acceptance, "artifact_hash", `${path}.artifact_hash`);
  optionalString(errors, acceptance, "evidence_ref", `${path}.evidence_ref`);
  if (acceptance.evidence_ref !== undefined && acceptance.evidence_ref !== null) requiredHash(errors, acceptance, "evidence_hash", `${path}.evidence_hash`);
  if (acceptance.evidence_hash !== undefined && !stringValue(acceptance.evidence_ref)) errors.push({ path: `${path}.evidence_hash`, message: "requires evidence_ref" });
  optionalString(errors, acceptance, "review_ref", `${path}.review_ref`);
  if (acceptance.review_ref !== undefined && acceptance.review_ref !== null) requiredHash(errors, acceptance, "review_hash", `${path}.review_hash`);
  if (acceptance.review_hash !== undefined && !stringValue(acceptance.review_ref)) errors.push({ path: `${path}.review_hash`, message: "requires review_ref" });
  if (!(step?.agent === "work-decomposer" && acceptance.artifact_ref === PLAN_SLICES_REF)) validateDurableRef(errors, acceptance.artifact_ref, "artifacts", `${path}.artifact_ref`);
  if (acceptance.evidence_ref !== undefined) validateDurableRef(errors, acceptance.evidence_ref, "evidence", `${path}.evidence_ref`);
  if (acceptance.review_ref !== undefined) validateDurableRef(errors, acceptance.review_ref, "reviews", `${path}.review_ref`);
  if (acceptance.reviewed_head_sha !== undefined) requiredFullGitSha(errors, acceptance, "reviewed_head_sha", `${path}.reviewed_head_sha`);
}

function validateStepInheritedAcceptance(errors, inherited, path) {
  if (inherited === undefined || inherited === null) return;
  if (!isRecord(inherited)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  allowedKeys(errors, inherited, STEP_INHERITED_ACCEPTANCE_KEYS, path);
  requiredString(errors, inherited, "from_run_id", `${path}.from_run_id`);
  requiredString(errors, inherited, "parent_spec_review_ref", `${path}.parent_spec_review_ref`);
  requiredHash(errors, inherited, "artifact_hash", `${path}.artifact_hash`);
  requiredHash(errors, inherited, "review_hash", `${path}.review_hash`);
  validateDurableRef(errors, inherited.parent_spec_review_ref, "reviews", `${path}.parent_spec_review_ref`);
}

function validateStepRelationships(errors, run, step, path) {
  const claim = step.execution_claim;
  if (claim !== undefined && claim !== null) {
    if (step.agent !== "test-verifier") errors.push({ path: `${path}.execution_claim`, message: "is allowed only for test-verifier" });
    if (claim.run_id !== run.run_id) errors.push({ path: `${path}.execution_claim.run_id`, message: "must match run.run_id" });
    if (claim.attempt !== step.attempts) errors.push({ path: `${path}.execution_claim.attempt`, message: "must match step attempts" });
    if (["active", "unknown"].includes(claim.state) && step.status !== "running") errors.push({ path: `${path}.status`, message: `${claim.state} execution claim requires running status` });
    if (["active", "unknown"].includes(claim.state) && run.status !== "running") errors.push({ path: `${path}.execution_claim.state`, message: `${claim.state} execution claim requires running run status` });
    if (claim.state === "completed" && claim.status === "fail" && step.status !== "rejected") errors.push({ path: `${path}.status`, message: "completed failed execution claim requires rejected status" });
    if (claim.state === "completed" && claim.status === "pass" && !["running", "accepted"].includes(step.status)) errors.push({ path: `${path}.status`, message: "completed passing execution claim requires running or accepted status" });
  }
  if (step.status !== "accepted") {
    for (const key of ["acceptance", "inherited_acceptance"]) if (step[key] !== undefined && step[key] !== null) errors.push({ path: `${path}.${key}`, message: "is allowed only for an accepted step" });
    return;
  }
  const acceptance = step.acceptance;
  if (isRecord(acceptance)) {
    if (stringValue(step.artifact_ref) && stringValue(acceptance.artifact_ref) && step.artifact_ref !== acceptance.artifact_ref) errors.push({ path: `${path}.acceptance.artifact_ref`, message: "must match step artifact_ref" });
    if (stringValue(step.evidence_ref) && stringValue(acceptance.evidence_ref) && step.evidence_ref !== acceptance.evidence_ref) errors.push({ path: `${path}.acceptance.evidence_ref`, message: "must match step evidence_ref" });
    if (stringValue(step.review_ref) && stringValue(acceptance.review_ref) && step.review_ref !== acceptance.review_ref) errors.push({ path: `${path}.acceptance.review_ref`, message: "must match step review_ref" });
    if (!stringValue(step.artifact_ref)) errors.push({ path: `${path}.artifact_ref`, message: "is required when acceptance is present" });
  }
  if (isRecord(run.continuation) && step.agent === "test-verifier") {
    const route = "current continuation";
    if (!isRecord(acceptance)) errors.push({ path: `${path}.acceptance`, message: `is required for accepted ${route} test-verifier` });
    else for (const key of ["artifact_ref", "artifact_hash", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_head_sha"]) {
      if (acceptance[key] === undefined || acceptance[key] === null) errors.push({ path: `${path}.acceptance.${key}`, message: `is required for accepted ${route} test-verifier` });
    }
    if (!isRecord(claim) || claim.state !== "completed" || claim.status !== "pass") errors.push({ path: `${path}.execution_claim`, message: `must be a completed passing checked execution claim for accepted ${route} test-verifier` });
  }
  const inherited = step.inherited_acceptance;
  if (isRecord(inherited)) {
    if (step.agent !== "spec-writer") errors.push({ path: `${path}.inherited_acceptance`, message: "is allowed only for the spec-writer step" });
    if (!isRecord(acceptance)) errors.push({ path: `${path}.acceptance`, message: "is required with inherited_acceptance" });
    else {
      if (inherited.artifact_hash !== acceptance.artifact_hash) errors.push({ path: `${path}.inherited_acceptance.artifact_hash`, message: "must match acceptance.artifact_hash" });
      if (inherited.review_hash !== acceptance.review_hash) errors.push({ path: `${path}.inherited_acceptance.review_hash`, message: "must match acceptance.review_hash" });
    }
    const continuation = run.continuation;
    const reuse = continuation?.planning_reuse;
    if (!isRecord(continuation) || continuation.kind !== "blocked-run-continuation") errors.push({ path: `${path}.inherited_acceptance`, message: "requires a blocked-run continuation" });
    else if (reuse?.eligible !== true) errors.push({ path: `${path}.inherited_acceptance`, message: "requires reuse-eligible continuation metadata" });
    else {
      if (inherited.from_run_id !== continuation.parent?.run_id) errors.push({ path: `${path}.inherited_acceptance.from_run_id`, message: "must match continuation.parent.run_id" });
      if (inherited.parent_spec_review_ref !== reuse.spec_review_ref) errors.push({ path: `${path}.inherited_acceptance.parent_spec_review_ref`, message: "must match continuation.planning_reuse.spec_review_ref" });
      if (inherited.artifact_hash !== reuse.spec_artifact_hash) errors.push({ path: `${path}.inherited_acceptance.artifact_hash`, message: "must match continuation.planning_reuse.spec_artifact_hash" });
      if (inherited.review_hash !== reuse.spec_review_hash) errors.push({ path: `${path}.inherited_acceptance.review_hash`, message: "must match continuation.planning_reuse.spec_review_hash" });
    }
  }
}

function validateVerdict(errors, value, path, allowed) {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  allowedKeys(errors, value, VERDICT_KEYS, path);
  requiredEnum(errors, value, "verdict", allowed, `${path}.verdict`);
  optionalString(errors, value, "report", `${path}.report`);
  optionalHash(errors, value, "report_hash", `${path}.report_hash`);
  optionalString(errors, value, "review_ref", `${path}.review_ref`);
  optionalHash(errors, value, "review_hash", `${path}.review_hash`);
  if (value.reviewed_head_sha !== undefined && value.reviewed_head_sha !== null) requiredFullGitSha(errors, value, "reviewed_head_sha", `${path}.reviewed_head_sha`);
  optionalInteger(errors, value, "loops", `${path}.loops`);
  if (Number.isInteger(value.loops) && value.loops < 0) errors.push({ path: `${path}.loops`, message: "must be non-negative" });
  validateDurableRef(errors, value.report, "artifacts", `${path}.report`);
  validateDurableRef(errors, value.review_ref, "reviews", `${path}.review_ref`);
  const bindingKeys = path.endsWith(".validator") ? VALIDATOR_BINDING_KEYS : SECURITY_BINDING_KEYS;
  if (bindingKeys === SECURITY_BINDING_KEYS && value.report_hash !== undefined) errors.push({ path: `${path}.report_hash`, message: "is not allowed for security_review" });
  const bindingCount = presentBindingCount(value, bindingKeys);
  if (bindingCount !== bindingKeys.length) errors.push({ path, message: `${bindingKeys.join(", ")} must all be present` });
  if (bindingCount === bindingKeys.length) {
    if (!stringValue(value.review_ref)) errors.push({ path: `${path}.review_ref`, message: "is required by the successor verdict binding" });
    if (bindingKeys === VALIDATOR_BINDING_KEYS && !stringValue(value.report)) errors.push({ path: `${path}.report`, message: "is required by the successor verdict binding" });
  }
}

function validatePanelBindingGeneration(errors, run) {
  const validatorSuccessor = hasCompleteBinding(run.validator, VALIDATOR_BINDING_KEYS);
  const securitySuccessor = hasCompleteBinding(run.security_review, SECURITY_BINDING_KEYS);
  if (validatorSuccessor !== securitySuccessor) {
    errors.push({ path: "run", message: "validator and security_review must both use complete current reviewed-head bindings" });
  } else if (validatorSuccessor && run.validator.reviewed_head_sha !== run.security_review.reviewed_head_sha) {
    errors.push({ path: "run", message: "validator and security_review reviewed_head_sha values must match" });
  }
}

function presentBindingCount(value, keys) {
  return keys.filter((key) => value?.[key] !== undefined && value?.[key] !== null).length;
}

function hasCompleteBinding(value, keys) {
  return presentBindingCount(value, keys) === keys.length;
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
  const allowed = run.terminal_result.status === "completed" ? TERMINAL_RESULT_COMPLETED_KEYS : TERMINAL_RESULT_COMMON_KEYS;
  allowedKeys(errors, run.terminal_result, allowed, path);
  requiredEnum(errors, run.terminal_result, "status", TERMINAL_STATUSES, `${path}.status`);
  requiredString(errors, run.terminal_result, "run_id", `${path}.run_id`);
  optionalString(errors, run.terminal_result, "pr_url", `${path}.pr_url`);
  optionalString(errors, run.terminal_result, "reason", `${path}.reason`);
  optionalString(errors, run.terminal_result, "summary", `${path}.summary`);
  validateTerminalArtifactMap(errors, run.terminal_result.artifacts, `${path}.artifacts`, { allowPostPrBindings: run.terminal_result.reason === "post-pr-retry-exhausted" });
  validateTerminalNonconvergence(errors, run, run.terminal_result.nonconvergence, `${path}.nonconvergence`);
  if (run.terminal_result.status && run.terminal_result.status !== run.status) errors.push({ path: `${path}.status`, message: `must match run.status '${run.status}'` });
  if (run.terminal_result.run_id && run.terminal_result.run_id !== run.run_id) errors.push({ path: `${path}.run_id`, message: "must match run.run_id" });
  if (["blocked", "partial", "needs-human"].includes(run.status) && !stringValue(run.terminal_result.reason)) errors.push({ path: `${path}.reason`, message: `is required for ${run.status}` });
  if (run.terminal_result.reason === "oversized-plan-checkpoint-routing-required") {
    const artifacts = run.terminal_result.artifacts;
    const keys = isRecord(artifacts) ? Object.keys(artifacts) : [];
    if (run.status !== "blocked" || run.terminal_result.status !== "blocked" || run.pr_url != null || run.terminal_result.pr_url !== null) {
      errors.push({ path, message: "checkpoint routing requires an exact pre-PR blocked terminal result" });
    }
    if (keys.length !== 1 || keys[0] !== "checkpoint_routing"
      || !/^artifacts\/checkpoint-routing-[0-9a-f]{64}\.json$/u.test(artifacts?.checkpoint_routing ?? "")) {
      errors.push({ path: `${path}.artifacts`, message: "checkpoint routing requires exactly one content-addressed checkpoint_routing artifact" });
    }
    if (!isRecord(run.checkpoint_progress)) errors.push({ path: "run.checkpoint_progress", message: "is required for checkpoint routing" });
  }
  if (run.terminal_result.status === "completed") validateCompletedTerminalPrTuple(errors, run, path);
}

function validateTerminalNonconvergence(errors, run, value, path) {
  const required = run.terminal_result?.reason === "slice-review-nonconvergent";
  if (value === undefined || value === null) {
    if (required) errors.push({ path, message: "is required for slice-review-nonconvergent" });
    return;
  }
  if (!required) errors.push({ path, message: "is allowed only for slice-review-nonconvergent" });
  if (required && (run.status !== "blocked" || run.terminal_result?.status !== "blocked" || run.pr_url != null || run.terminal_result?.pr_url != null)) {
    errors.push({ path, message: "requires an exact pre-PR blocked run and terminal status" });
  }
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  allowedKeys(errors, value, TERMINAL_NONCONVERGENCE_KEYS, path);
  requiredInteger(errors, value, "schema_version", `${path}.schema_version`);
  if (value.schema_version !== 1) errors.push({ path: `${path}.schema_version`, message: "must equal 1" });
  requiredEnum(errors, value, "kind", new Set(["slice-review-nonconvergence"]), `${path}.kind`);
  requiredTerminalSafeString(errors, value, "slice_id", `${path}.slice_id`);
  const source = value.source_review;
  validateSliceAttemptReviews(errors, { attempts: source?.attempt, status: "blocked", attempt_reviews: source === undefined ? undefined : [source] }, `${path}.source`);
  if (!isRecord(value.continuation)) {
    errors.push({ path: `${path}.continuation`, message: "must be an object" });
  } else {
    allowedKeys(errors, value.continuation, TERMINAL_NONCONVERGENCE_CONTINUATION_KEYS, `${path}.continuation`);
    requiredEnum(errors, value.continuation, "program", new Set(["feature-factory"]), `${path}.continuation.program`);
    const expectedArgs = ["factory", "continue", run.run_id, "--review", source?.review_ref, "--run-id", "<new-run-id>", "--carry-forward", "--json"];
    if (!Array.isArray(value.continuation.args) || value.continuation.args.length !== expectedArgs.length
      || value.continuation.args.some((arg, index) => arg !== expectedArgs[index])) {
      errors.push({ path: `${path}.continuation.args`, message: "must be the exact checked carry-forward command template" });
    }
  }
  const slice = Array.isArray(run.slices) ? run.slices.find((candidate) => candidate?.id === value.slice_id) : null;
  if (!slice || slice.status !== "blocked" || slice.blocked_reason !== "slice-review-nonconvergent") {
    errors.push({ path: `${path}.slice_id`, message: "must identify the blocked nonconvergent slice" });
  } else if (!Array.isArray(slice.attempt_reviews) || source?.attempt !== slice.attempts || JSON.stringify(slice.attempt_reviews.at(-1)) !== JSON.stringify(source)) {
    errors.push({ path: `${path}.source_review`, message: "must equal the current latest append-only slice review entry" });
  }
  if (source?.verdict !== "REJECT" || source?.convergence !== "nonconvergent") {
    errors.push({ path: `${path}.source_review`, message: "must be a nonconvergent REJECT review" });
  }
}

function validateCompletedTerminalPrTuple(errors, run, path) {
  const result = run.terminal_result;
  requiredString(errors, result, "pr_url", `${path}.pr_url`);
  optionalBoolean(errors, result, "draft", `${path}.draft`);
  if (result.head_sha !== undefined && result.head_sha !== null) requiredFullGitSha(errors, result, "head_sha", `${path}.head_sha`);
  const successorDiscriminators = ["operation_id", "pr_node_id", "head_ref", "base_ref", "base_sha"];
  if (successorDiscriminators.some((key) => Object.hasOwn(result, key))) {
    const successorKeys = ["pr_url", "pr_number", "pr_node_id", "repository", "operation_id", "head_ref", "head_sha", "base_ref", "base_sha", "draft"];
    for (const key of successorKeys) if (!Object.hasOwn(result, key) || result[key] === undefined || result[key] === null) errors.push({ path: `${path}.${key}`, message: "is required by the successor PR tuple" });
    requiredPrOperationIdentity(errors, result, path);
    requiredString(errors, result, "pr_node_id", `${path}.pr_node_id`);
  }
  if (!stringValue(result.pr_url)) return;
  try {
    const parts = githubPrUrlParts(result.pr_url);
    if (parts.url !== result.pr_url) errors.push({ path: `${path}.pr_url`, message: "must be a canonical GitHub PR URL" });
    if (run.pr_url !== result.pr_url) errors.push({ path: "run.pr_url", message: "must match completed terminal_result.pr_url" });
    const hasTupleDetails = result.repository !== undefined || result.pr_number !== undefined;
    if (hasTupleDetails) {
      requiredString(errors, result, "repository", `${path}.repository`);
      boundedInteger(errors, result, "pr_number", 1, Number.MAX_SAFE_INTEGER, `${path}.pr_number`);
      if (stringValue(result.repository) && result.repository !== parts.repository) errors.push({ path: `${path}.repository`, message: "must match pr_url repository" });
      if (Number.isInteger(result.pr_number) && result.pr_number !== parts.number) errors.push({ path: `${path}.pr_number`, message: "must match pr_url pull request number" });
    }
  } catch {
    errors.push({ path: `${path}.pr_url`, message: "must be a canonical GitHub PR URL" });
  }
}

function validateTerminalArtifactMap(errors, value, path, { allowPostPrBindings = false } = {}) {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (!stringValue(item)) {
      errors.push({ path: itemPath, message: "must be a non-empty repository-relative artifact ref" });
      continue;
    }
    const segments = item.split("/");
    const disallowedDurableRoot = DURABLE_REF_ROOTS.has(segments[0]) && segments[0] !== "artifacts"
      && !(allowPostPrBindings && ["evidence", "reviews"].includes(segments[0]));
    if (isAbsolute(item) || item.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === "..") || disallowedDurableRoot) {
      errors.push({ path: itemPath, message: "must be a repository-relative ref under artifacts/" });
    }
  }
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

function optionalTimestamp(errors, obj, key, path) {
  if (obj[key] === undefined || obj[key] === null) return;
  if (!isIsoTimestamp(obj[key])) errors.push({ path, message: "must be an ISO timestamp or null" });
}

function requiredTimestamp(errors, obj, key, path) {
  if (!isIsoTimestamp(obj[key])) errors.push({ path, message: "must be an ISO timestamp" });
}

function isIsoTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function validateDurableRef(errors, value, root, path) {
  if (!stringValue(value)) return;
  const prefix = `${root}/`;
  if (!value.startsWith(prefix) || value.includes("\\") || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    errors.push({ path, message: `must stay under ${root}/` });
  }
}

function optionalAbsolutePath(errors, obj, key, path) {
  if (obj[key] === undefined || obj[key] === null) return;
  if (typeof obj[key] !== "string" || !isAbsolute(obj[key])) errors.push({ path, message: "must be an absolute path or null" });
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

function isUuidV4(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
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
