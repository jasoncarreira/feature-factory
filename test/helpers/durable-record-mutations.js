import { createHash } from "node:crypto";
import { withDeliveryEnvelope } from "./delivery-envelope-fixture.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const WRONG_HASH_A = `sha256:${"0".repeat(64)}`;
const WRONG_HASH_B = `sha256:${"1".repeat(64)}`;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const NOW = "2026-07-16T12:00:00.000Z";
const PR_OPERATION_ID = `ffpr-v1-${"d".repeat(64)}`;

export const DURABLE_MUTATION_FAMILIES = Object.freeze([
  "missing-key",
  "unknown-key",
  "wrong-schema",
  "wrong-kind",
  "wrong-time",
  "wrong-type",
  "wrong-ref",
  "wrong-hash",
  "wrong-bytes",
  "descriptor-key-shape-drift",
  "stale-identity",
  "cross-bound-identity",
]);

export const DURABLE_AUTHORITY_PRODUCTION_COVERED_RECORD_IDS = Object.freeze([
  "plan-slices-json",
  "plan-v2-integration-gate",
  "plan-delivery-envelope-v1",
  "checkpoint-reviewed-plan-v1",
  "checkpoint-admission-probe-valid",
  "checkpoint-child-disposition-v1",
  "checkpoint-routing-artifact-v1",
  "checkpoint-child-publication-v1",
  "checkpoint-source-v1",
  "checkpoint-progress-reserved",
  "checkpoint-progress-child-published",
  "checkpoint-progress-launched",
  "checkpoint-progress-merged",
  "checkpoint-progress-closed",
  "checkpoint-merged-completion-v1",
  "checkpoint-final-closure-v1",
  "run-envelope-running",
  "run-envelope-terminal",
  "terminal-result-completed",
  "terminal-result-blocked",
  "terminal-result-blocked-checkpoint-routing",
  "terminal-result-blocked-nonconvergence",
  "terminal-result-partial",
  "terminal-result-needs-human",
  "gate-pending",
  "gate-approved-without-receipt",
  "gate-approved-interactive",
  "gate-changes-requested",
  "gate-stopped",
  "step-running",
  "step-rejected",
  "step-blocked",
  "step-accepted",
  "step-work-decomposer-accepted-plan",
  "step-inherited-acceptance",
  "test-execution-claim-active",
  "test-execution-claim-completed-pass",
  "test-execution-claim-completed-fail",
  "test-execution-claim-unknown-process-outcome-indeterminate",
  "test-execution-claim-unknown-authority-changed",
  "test-execution-claim-unknown-receipt-publication-indeterminate",
  "test-execution-receipt-pass",
  "test-execution-receipt-failed-nonzero-exit",
  "test-execution-receipt-failed-signal",
  "test-execution-receipt-failed-launch-error",
  "test-execution-receipt-failed-timeout",
  "test-execution-receipt-failed-output-limit",
  "continuation-v2-envelope",
  "continuation-v2-parent-binding",
  "continuation-v2-selected-review",
  "continuation-v2-target-binding",
  "continuation-v2-parent-artifact-sidecar",
  "continuation-v2-parent-evidence-sidecar",
  "continuation-v2-parent-review-sidecar",
  "continuation-v2-planning-reuse",
  "slice-pending",
  "slice-running",
  "slice-review",
  "review-invariant-family-ledger-v1",
  "verification-artifact-claim-active",
  "verification-artifact-claim-completed-pass",
  "verification-artifact-claim-completed-fail",
  "verification-artifact-claim-unknown-process",
  "verification-artifact-claim-unknown-receipt",
  "verification-artifact-execution-receipt-pass",
  "verification-artifact-execution-receipt-fail",
  "slice-merged",
  "slice-blocked-ordinary",
  "slice-blocked",
  "validator-verdict-binding",
  "security-verdict-binding",
  "steering-boundary",
  "steering-action-claim",
  "steering-last-action",
  "steering-pr-fence",
  "pr-created-result",
  "post-pr-phase-disabled",
  "post-pr-phase-awaiting-pr",
  "post-pr-phase-observing",
  "post-pr-phase-failure-recording",
  "post-pr-phase-remediation-planned",
  "post-pr-phase-remediation-running",
  "post-pr-phase-changes-observed",
  "post-pr-phase-committed",
  "post-pr-phase-revalidating",
  "post-pr-phase-validated",
  "post-pr-phase-push-pending",
  "post-pr-phase-remote-confirmed",
  "post-pr-phase-succeeded",
  "post-pr-phase-blocked",
  "post-pr-phase-needs-human",
  "post-pr-policy-disabled",
  "post-pr-policy-enabled",
  "post-pr-observation-null",
  "post-pr-observation-active",
  "post-pr-observation-last-error",
  "post-pr-observation-review-request",
  "post-pr-observation-snapshot",
  "post-pr-remediation-null",
  "post-pr-remediation-active",
  "post-pr-remediation-owner",
  "post-pr-remediation-changes",
  "post-pr-remediation-change-entry",
  "post-pr-dispatch-planned",
  "post-pr-dispatch-running",
  "post-pr-dispatch-returned",
  "post-pr-revalidation-empty",
  "post-pr-revalidation-bound",
  "post-pr-canonical-job-planned",
  "post-pr-canonical-job-running",
  "post-pr-canonical-job-retry-wait",
  "post-pr-canonical-job-bound",
  "post-pr-validator-job-planned",
  "post-pr-validator-job-running",
  "post-pr-validator-job-retry-wait",
  "post-pr-validator-job-bound",
  "post-pr-security-job-planned",
  "post-pr-security-job-running",
  "post-pr-security-job-retry-wait",
  "post-pr-security-job-bound",
  "post-pr-push-not-ready",
  "post-pr-push-pending",
  "post-pr-push-confirmed",
  "post-pr-push-last-error",
  "post-pr-evidence-sidecar",
  "post-pr-continuation-review-null",
  "post-pr-continuation-review-bound",
  "post-pr-terminal-fact-null",
  "post-pr-terminal-fact-account-switch-failed-github-auth",
  "post-pr-terminal-fact-account-switch-failed-push",
  "post-pr-terminal-fact-dispatch-start-unknown",
  "post-pr-terminal-fact-path-lane-violation",
  "post-pr-terminal-fact-remote-head-diverged",
  "post-pr-terminal-fact-panel-runner-result-malformed",
  "post-pr-terminal-fact-push-failed",
  "post-pr-terminal-fact-panel-attribution-unsafe",
  "amendment-reported",
  "amendment-building-attempt-1",
  "amendment-building-attempt-2",
  "amendment-reviewed-approve-attempt-1",
  "amendment-reviewed-reject-attempt-1",
  "amendment-reviewed-approve-attempt-2",
  "amendment-reviewed-reject-attempt-2",
  "amendment-integrated",
  "amendment-verified",
  "amendment-merged",
  "amendment-blocked-from-reported",
  "amendment-blocked-from-building",
  "amendment-blocked-from-reviewed-approve",
  "amendment-blocked-from-reviewed-reject",
  "amendment-blocked-from-integrated",
  "amendment-blocked-from-verified",
  "amendment-report-claim-active",
  "amendment-report-claim-completed-pass",
  "amendment-report-claim-completed-fail",
  "amendment-report-claim-unknown-process-outcome-indeterminate",
  "amendment-report-claim-unknown-authority-changed",
  "amendment-report-claim-unknown-receipt-publication-indeterminate",
  "amendment-verify-claim-active",
  "amendment-verify-claim-completed-pass",
  "amendment-verify-claim-completed-fail",
  "amendment-verify-claim-unknown-process-outcome-indeterminate",
  "amendment-verify-claim-unknown-authority-changed",
  "amendment-verify-claim-unknown-receipt-publication-indeterminate",
  "amendment-report-receipt-pass",
  "amendment-report-receipt-nonzero-exit",
  "amendment-report-receipt-signal",
  "amendment-report-receipt-launch-error",
  "amendment-report-receipt-timeout",
  "amendment-report-receipt-output-limit",
  "amendment-verify-receipt-pass",
  "amendment-verify-receipt-nonzero-exit",
  "amendment-verify-receipt-signal",
  "amendment-verify-receipt-launch-error",
  "amendment-verify-receipt-timeout",
  "amendment-verify-receipt-output-limit",
  "amendment-review-approve",
  "amendment-review-reject",
  "amendment-dispatch-binding-active",
  "amendment-dispatch-binding-closed",
  "amendment-dispatch-claim",
  "amendment-dispatch-closure",
  "amendment-review-dispatch-claim",
  "amendment-review-dispatch-closure",
]);

const AUTHORITY_CLASSES = Object.freeze([
  ["plan-slices-graph", "Plan and slices graph"],
  ["run-envelope-terminal-result", "Run envelope and terminal result"],
  ["gates-snapshot-handoff", "Gates, pending snapshot, and handoff receipt"],
  ["steps-acceptance-inheritance", "Steps and acceptance inheritance"],
  ["slices-review-evidence-bindings", "Slices and review/evidence bindings"],
  ["validator-security-pr-result", "Validator, security, and PR-created result"],
  ["continuation-v2-carry-forward", "Schema-v2 continuation carry-forward"],
  ["post-pr-nested-records", "Post-PR nested records"],
  ["pr79-merged-slice-repair", "PR79 merged slice repair"],
]);

const POST_PR_PHASES = Object.freeze(["disabled", "awaiting-pr", "observing", "failure-recording", "remediation-planned", "remediation-running", "changes-observed", "committed", "revalidating", "validated", "push-pending", "remote-confirmed", "succeeded", "blocked", "needs-human"]);
const POST_PR_JOB_ACTIVITIES = Object.freeze(["canonical", "validator", "security"]);
const POST_PR_JOB_STATES = Object.freeze(["planned", "running", "retry-wait", "bound"]);
const POST_PR_EXTERNAL = Object.freeze({
  failure: { ref: "evidence/post-pr-ci.attempt-1.json", bytes: "{\"kind\":\"post-pr-ci\",\"verdict\":\"red\"}\n" },
  remediation: { ref: "evidence/post-pr-remediation.attempt-1.json", bytes: "{\"kind\":\"post-pr-remediation\",\"paths\":[\"src/backend.js\"]}\n" },
  canonical: { ref: "evidence/post-pr-canonical.attempt-1.json", bytes: "{\"kind\":\"post-pr-canonical\",\"verdict\":\"pass\"}\n" },
  validator: { ref: "reviews/post-pr-validator.attempt-1.json", bytes: "{\"kind\":\"post-pr-validator-review\",\"verdict\":\"GO\"}\n" },
  security: { ref: "reviews/post-pr-security.attempt-1.json", bytes: "{\"kind\":\"post-pr-security-review\",\"verdict\":\"PASS\"}\n" },
  continuation: { ref: "reviews/post-pr-continuation.attempt-1.json", bytes: "{\"kind\":\"post-pr-continuation\",\"verdict\":\"BLOCKED\"}\n" },
});
const PLAN_EXTERNAL = Object.freeze({
  plan: {
    ref: "plan/slices.json",
    bytes: `${JSON.stringify(withDeliveryEnvelope({
      slices: [
        { id: "B0.2", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["AC2"], test_plan: ["node --test"] },
        { id: "B0.3", stack: "backend", paths: ["test/**"], depends_on: ["B0.2"], acceptance: ["AC3"], test_plan: ["node --test"] },
      ],
      integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    }, { explicitExecutionTimeouts: true }))}\n`,
  },
});
const PLAN_V2 = withDeliveryEnvelope({
  slices: [{ id: "B1C", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["AC1"], test_plan: ["node --test test/acceptance.test.js"] }],
  integration_gate: { required_commands: [{ program: "node", args: ["--test", "test/acceptance.test.js"] }, { program: "npm", args: ["run", "check"] }] },
}, { explicitExecutionTimeouts: true });
const PLAN_V2_EXTERNAL = Object.freeze({
  plan: { ref: "plan/slices.json", bytes: `${JSON.stringify(PLAN_V2)}\n` },
});
const DELIVERY_ENVELOPE_PLAN = Object.freeze({
  slices: [{ id: "backend", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["AC1"], test_plan: ["node --test test/backend.test.js"] }],
  integration_gate: { timeout_ms: 600_000, required_commands: [{ program: "npm", args: ["run", "check"] }] },
  delivery_envelope: {
    schema_version: 1,
    delivery_units: [{
      id: "backend-unit",
      slice_id: "backend",
      invariant_families: [{ id: "backend-behavior", description: "Backend behavior remains stable" }],
      obligations: [{ id: "backend-obligation", description: "Meet the backend contract", invariant_family_id: "backend-behavior", verification_artifact_id: "backend-tests" }],
      verification_artifacts: [{ id: "backend-tests", test_plan_index: 0, test_plan_entry: "node --test test/backend.test.js", timeout_ms: 600_000 }],
    }],
  },
});
const DELIVERY_ENVELOPE_EXTERNAL = Object.freeze({
  plan: { ref: "plan/slices.json", bytes: `${JSON.stringify(DELIVERY_ENVELOPE_PLAN)}\n` },
});
const INVARIANT_RECEIPT = Object.freeze({
  schema_version: 1,
  kind: "checked-verification-artifact-execution-receipt",
  subject: "backend",
  run_id: "catalog-run",
  slice_id: "backend",
  attempt: 1,
  claim_nonce: "123e4567-e89b-42d3-a456-426614174000",
  plan_ref: "plan/slices.json",
  plan_hash: hashBytes(DELIVERY_ENVELOPE_EXTERNAL.plan.bytes),
  head_sha: SHA_B,
  timeout_ms: 600_000,
  verification_artifact_id: "backend-tests",
  probe: { type: "verification-artifact", verification_artifact_id: "backend-tests", test_plan_index: 0, test_plan_entry: "node --test test/backend.test.js", program: "node", args: ["--test", "test/backend.test.js"] },
  started_at: NOW,
  completed_at: "2026-07-16T12:00:01.000Z",
  duration_ms: 1000,
  status: "fail",
  review_ready: false,
  commands: [{ index: 0, program: "node", args: ["--test", "test/backend.test.js"], outcome: "exited", status: "fail", exit_code: 1, signal: null, error_code: null, duration_ms: 1000, stdout: { captured_bytes: 0, sha256: `sha256:${createHash("sha256").digest("hex")}`, truncated: false }, stderr: { captured_bytes: 0, sha256: `sha256:${createHash("sha256").digest("hex")}`, truncated: false } }],
  result: { type: "verification-result", outcome: "fail", summary: "The observed probe failed" },
});
const VERIFICATION_ARTIFACT_RECEIPT_PASS = deepFreeze({ ...structuredClone(INVARIANT_RECEIPT), status: "pass", review_ready: true, commands: [{ ...structuredClone(INVARIANT_RECEIPT.commands[0]), status: "pass", exit_code: 0 }], result: { type: "verification-result", outcome: "pass", summary: "The observed probe passed" } });
const VERIFICATION_ARTIFACT_CLAIM_BASE = Object.freeze({
  schema_version: 1, kind: "checked-verification-artifact-execution-claim", state: "active",
  nonce: INVARIANT_RECEIPT.claim_nonce, run_id: INVARIANT_RECEIPT.run_id, slice_id: INVARIANT_RECEIPT.slice_id,
  attempt: INVARIANT_RECEIPT.attempt, plan_ref: INVARIANT_RECEIPT.plan_ref, plan_hash: INVARIANT_RECEIPT.plan_hash,
  head_sha: INVARIANT_RECEIPT.head_sha, timeout_ms: INVARIANT_RECEIPT.timeout_ms, verification_artifact_id: INVARIANT_RECEIPT.verification_artifact_id,
  probe: INVARIANT_RECEIPT.probe, receipt_ref: "evidence/backend.artifact-backend-tests.attempt-1.json", claimed_at: NOW,
});
const INVARIANT_LEDGER_EXTERNAL = Object.freeze({
  plan: DELIVERY_ENVELOPE_EXTERNAL.plan,
  evidence: { ref: VERIFICATION_ARTIFACT_CLAIM_BASE.receipt_ref, bytes: `${JSON.stringify(INVARIANT_RECEIPT)}\n` },
  claim: {
    ref: `${VERIFICATION_ARTIFACT_CLAIM_BASE.receipt_ref.slice(0, -5)}.claim.json`,
    bytes: `${JSON.stringify({ ...VERIFICATION_ARTIFACT_CLAIM_BASE, state: "completed", completed_at: INVARIANT_RECEIPT.completed_at, status: INVARIANT_RECEIPT.status, receipt_hash: hashBytes(`${JSON.stringify(INVARIANT_RECEIPT)}\n`) })}\n`,
  },
});
const INVARIANT_FAMILY_LEDGER = Object.freeze({
  schema_version: 1,
  delivery_unit_id: "backend-unit",
  dispositions: [{
    invariant_family_id: "backend-behavior",
    verification_artifact_id: "backend-tests",
    evidence_ref: INVARIANT_LEDGER_EXTERNAL.evidence.ref,
    evidence_hash: hashBytes(INVARIANT_LEDGER_EXTERNAL.evidence.bytes),
    probe: { type: "verification-artifact", verification_artifact_id: "backend-tests" },
    result: { type: "verification-result", outcome: "fail", summary: "The observed probe failed" },
    reviewed_commit: SHA_B,
    unresolved_findings: ["The family remains unresolved"],
  }],
});
const CHECKPOINT_PLAN = {
  slices: [{ id: "backend", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["AC1", "AC2"], test_plan: ["node --test test/backend-1.test.js", "node --test test/security-1.test.js", "node --test test/backend-2.test.js", "node --test test/security-2.test.js", "node --test test/backend-3.test.js", "node --test test/security-3.test.js"] }],
  integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
  delivery_envelope: {
    schema_version: 1,
    delivery_units: [{
      id: "backend-unit", slice_id: "backend",
      invariant_families: [
        { id: "backend-behavior", description: "Backend behavior remains stable" },
        { id: "backend-security", description: "Backend security remains stable" },
      ],
      obligations: [
        { id: "behavior-1", description: "Behavior 1", invariant_family_id: "backend-behavior", verification_artifact_id: "artifact-1" },
        { id: "security-1", description: "Security 1", invariant_family_id: "backend-security", verification_artifact_id: "artifact-2" },
        { id: "behavior-2", description: "Behavior 2", invariant_family_id: "backend-behavior", verification_artifact_id: "artifact-3" },
        { id: "security-2", description: "Security 2", invariant_family_id: "backend-security", verification_artifact_id: "artifact-4" },
        { id: "behavior-3", description: "Behavior 3", invariant_family_id: "backend-behavior", verification_artifact_id: "artifact-5" },
        { id: "security-3", description: "Security 3", invariant_family_id: "backend-security", verification_artifact_id: "artifact-6" },
      ],
      verification_artifacts: [
        { id: "artifact-1", test_plan_index: 0, test_plan_entry: "node --test test/backend-1.test.js" },
        { id: "artifact-2", test_plan_index: 1, test_plan_entry: "node --test test/security-1.test.js" },
        { id: "artifact-3", test_plan_index: 2, test_plan_entry: "node --test test/backend-2.test.js" },
        { id: "artifact-4", test_plan_index: 3, test_plan_entry: "node --test test/security-2.test.js" },
        { id: "artifact-5", test_plan_index: 4, test_plan_entry: "node --test test/backend-3.test.js" },
        { id: "artifact-6", test_plan_index: 5, test_plan_entry: "node --test test/security-3.test.js" },
      ],
    }],
  },
};
const CHECKPOINT_ADMISSION = Object.freeze({
  schema_version: 1, extension: "delivery-envelope-admission", status: "active", grants_b4_authority: false, decision: "checkpoint",
  reasons: ["checkpoint:mixed-invariant-families:unit=backend-unit:families=2:obligations=6"],
});
CHECKPOINT_PLAN.delivery_envelope.checkpoint_plan = checkpointCatalogPlan(CHECKPOINT_PLAN);
deepFreeze(CHECKPOINT_PLAN);
const CHECKPOINT_REVIEW = deepFreeze(checkpointCatalogReview());
const CHECKPOINT_EXTERNAL = deepFreeze({
  plan: { ref: "plan/slices.json", bytes: `${JSON.stringify(CHECKPOINT_PLAN)}\n` },
  review: { ref: "reviews/work-decomposer.json", bytes: `${JSON.stringify(CHECKPOINT_REVIEW)}\n` },
});
const CHECKPOINT_ROUTING_MANIFEST = Object.freeze(checkpointCatalogManifest());
const CHECKPOINT_ROUTING_BYTES = `${JSON.stringify(CHECKPOINT_ROUTING_MANIFEST, null, 2)}\n`;
const CHECKPOINT_ROUTING_REF = `artifacts/checkpoint-routing-${hashBytes(CHECKPOINT_ROUTING_BYTES).slice("sha256:".length)}.json`;
const CHECKPOINT_CONFIGURATION = deepFreeze({
  mode: "autonomous",
  github_account: "acme",
  pr_mode: "ready",
  max_parallel_slices: 3,
  max_retries: 3,
  post_pr_policy: {
    enabled: false,
    wait_ms: 3600000,
    initial_poll_ms: 30000,
    max_poll_ms: 120000,
    check_start_grace_ms: 300000,
    max_transient_errors: 12,
    review: { required: false, reviewer_login: null, source: "none" },
  },
  review_tier: null,
});
const CHECKPOINT_CHILD_PUBLICATION = deepFreeze({
  schema_version: 1,
  kind: "delivery-checkpoint-child-publication",
  parent_run_id: "catalog-parent",
  manifest_ref: CHECKPOINT_ROUTING_REF,
  manifest_hash: hashBytes(CHECKPOINT_ROUTING_BYTES),
  checkpoint_id: "checkpoint-001",
  checkpoint_ordinal: 1,
  child_run_id: "catalog-checkpoint-child",
  branch_ref: "refs/heads/catalog-checkpoint-child",
  worktree: "/tmp/catalog-checkpoint-child",
  remote_main_ref: "refs/heads/main",
  base_commit: SHA_A,
  predecessor_checkpoint_id: null,
  predecessor_completed_run_id: null,
  predecessor_merge_commit: null,
  reserved_at: "2026-07-16T12:00:00.000Z",
});
const CHECKPOINT_SOURCE = deepFreeze({
  schema_version: 1,
  kind: "delivery-checkpoint-source",
  parent_run_id: "catalog-parent",
  manifest_ref: CHECKPOINT_ROUTING_REF,
  manifest_hash: hashBytes(CHECKPOINT_ROUTING_BYTES),
  checkpoint_id: "checkpoint-001",
  checkpoint_ordinal: 1,
  root_child_run_id: CHECKPOINT_CHILD_PUBLICATION.child_run_id,
  source_plan_ref: CHECKPOINT_EXTERNAL.plan.ref,
  source_plan_hash: hashBytes(CHECKPOINT_EXTERNAL.plan.bytes),
  source_review_ref: CHECKPOINT_EXTERNAL.review.ref,
  source_review_hash: hashBytes(CHECKPOINT_EXTERNAL.review.bytes),
  source_review_attempt: 1,
  parent_review_identity_hash: CHECKPOINT_REVIEW.review_identity.identity_hash,
  child_disposition_hash: checkpointCanonicalHash(CHECKPOINT_REVIEW.checkpoint_dispositions[0]),
  admission_probe_hash: checkpointCanonicalHash(CHECKPOINT_REVIEW.admission_probe),
  brief_scope_hash: CHECKPOINT_REVIEW.checkpoint_dispositions[0].brief_scope_hash,
  child_plan_hash: CHECKPOINT_REVIEW.checkpoint_dispositions[0].child_plan_hash,
  acceptance_mapping_hash: CHECKPOINT_REVIEW.checkpoint_dispositions[0].acceptance_mapping_hash,
  initial_base_ref: "refs/remotes/origin/main",
  initial_base_commit: SHA_A,
});
const CHECKPOINT_RESERVED_ENTRY = deepFreeze({
  state: "reserved",
  checkpoint_id: "checkpoint-001",
  ordinal: 1,
  root_child_run_id: CHECKPOINT_CHILD_PUBLICATION.child_run_id,
  branch: CHECKPOINT_CHILD_PUBLICATION.child_run_id,
  worktree: CHECKPOINT_CHILD_PUBLICATION.worktree,
  base_ref: "refs/remotes/origin/main",
  base_commit: SHA_A,
  predecessor_checkpoint_id: null,
  predecessor_completed_run_id: null,
  predecessor_merge_commit: null,
  configuration: CHECKPOINT_CONFIGURATION,
  publication_claim_ref: `refs/opencode/checkpoint-publications/${createHash("sha256").update(CHECKPOINT_CHILD_PUBLICATION.child_run_id).digest("hex")}`,
  publication_claim_oid: SHA_C,
  reserved_at: CHECKPOINT_CHILD_PUBLICATION.reserved_at,
});
const CHECKPOINT_PUBLISHED_ENTRY = deepFreeze({
  ...structuredClone(CHECKPOINT_RESERVED_ENTRY),
  state: "child-published",
  child_run_hash: HASH_C,
  child_plan_hash: CHECKPOINT_SOURCE.child_plan_hash,
  brief_scope_hash: CHECKPOINT_SOURCE.brief_scope_hash,
  published_at: "2026-07-16T12:01:00.000Z",
});
const CHECKPOINT_LAUNCHED_ENTRY = deepFreeze({
  ...structuredClone(CHECKPOINT_PUBLISHED_ENTRY),
  state: "launched",
  launched_at: "2026-07-16T12:02:00.000Z",
});
const CHECKPOINT_MERGED_ENTRY = deepFreeze({
  ...structuredClone(CHECKPOINT_LAUNCHED_ENTRY),
  state: "merged",
  completed_child_run_id: CHECKPOINT_CHILD_PUBLICATION.child_run_id,
  completed_child_run_hash: HASH_C,
  checkpoint_source_hash: checkpointCanonicalHash(CHECKPOINT_SOURCE),
  configuration_hash: checkpointCanonicalHash(CHECKPOINT_CONFIGURATION),
  lineage: [{
    run_id: CHECKPOINT_CHILD_PUBLICATION.child_run_id,
    run_hash: HASH_C,
    parent_run_id: null,
    continuation_claim_ref: null,
    continuation_claim_oid: null,
  }],
  pull_request: {
    pr_url: "https://github.com/acme/repo/pull/7",
    pr_number: 7,
    pr_node_id: "PR_catalog_operation",
    repository: "acme/repo",
    operation_id: PR_OPERATION_ID,
    head_ref: CHECKPOINT_CHILD_PUBLICATION.child_run_id,
    head_sha: SHA_B,
    base_ref: "main",
    base_sha: SHA_A,
    draft: false,
    merge_commit: SHA_C,
  },
  remote_main: { ref: "refs/heads/main", commit: SHA_C, observed_at: "2026-07-16T12:03:00.000Z" },
  merged_at: "2026-07-16T12:03:00.000Z",
});
const CHECKPOINT_FINAL_CLOSURE = deepFreeze({
  schema_version: 1,
  kind: "delivery-checkpoint-final-closure",
  parent_run_id: "catalog-parent",
  parent_run_hash: HASH_A,
  manifest_ref: CHECKPOINT_ROUTING_REF,
  manifest_hash: hashBytes(CHECKPOINT_ROUTING_BYTES),
  source_plan_ref: CHECKPOINT_EXTERNAL.plan.ref,
  source_plan_hash: hashBytes(CHECKPOINT_EXTERNAL.plan.bytes),
  source_review_ref: CHECKPOINT_EXTERNAL.review.ref,
  source_review_hash: hashBytes(CHECKPOINT_EXTERNAL.review.bytes),
  source_review_attempt: 1,
  parent_review_identity_hash: CHECKPOINT_REVIEW.review_identity.identity_hash,
  admission_probe_hash: checkpointCanonicalHash(CHECKPOINT_REVIEW.admission_probe),
  checkpoints: [{
    checkpoint_id: CHECKPOINT_MERGED_ENTRY.checkpoint_id,
    ordinal: CHECKPOINT_MERGED_ENTRY.ordinal,
    root_child_run_id: CHECKPOINT_MERGED_ENTRY.root_child_run_id,
    child_plan_hash: CHECKPOINT_MERGED_ENTRY.child_plan_hash,
    brief_scope_hash: CHECKPOINT_MERGED_ENTRY.brief_scope_hash,
    completed_child_run_id: CHECKPOINT_MERGED_ENTRY.completed_child_run_id,
    completed_child_run_hash: CHECKPOINT_MERGED_ENTRY.completed_child_run_hash,
    checkpoint_source_hash: CHECKPOINT_MERGED_ENTRY.checkpoint_source_hash,
    configuration: CHECKPOINT_CONFIGURATION,
    configuration_hash: CHECKPOINT_MERGED_ENTRY.configuration_hash,
    lineage: CHECKPOINT_MERGED_ENTRY.lineage,
    pull_request: CHECKPOINT_MERGED_ENTRY.pull_request,
    merged_at: CHECKPOINT_MERGED_ENTRY.merged_at,
  }],
  remote_main: { ref: "refs/heads/main", commit: SHA_C, observed_at: "2026-07-16T12:04:00.000Z" },
  closed_at: "2026-07-16T12:04:00.000Z",
});
const CHECKPOINT_CLOSURE_BYTES = `${JSON.stringify(canonicalCheckpointValue(CHECKPOINT_FINAL_CLOSURE), null, 2)}\n`;
const CHECKPOINT_CLOSURE_REF = `artifacts/checkpoint-closure-${hashBytes(CHECKPOINT_CLOSURE_BYTES).slice("sha256:".length)}.json`;
function checkpointProgress(entry, closed = false) {
  return deepFreeze({
    schema_version: 1,
    kind: "delivery-checkpoint-progress",
    manifest_ref: CHECKPOINT_ROUTING_REF,
    manifest_hash: hashBytes(CHECKPOINT_ROUTING_BYTES),
    status: closed ? "closed" : "active",
    entries: [structuredClone(entry)],
    final_closure: closed ? { ref: CHECKPOINT_CLOSURE_REF, hash: hashBytes(CHECKPOINT_CLOSURE_BYTES), closed_at: CHECKPOINT_FINAL_CLOSURE.closed_at } : null,
  });
}
const CHECKPOINT_PROGRESS = deepFreeze({
  reserved: checkpointProgress(CHECKPOINT_RESERVED_ENTRY),
  "child-published": checkpointProgress(CHECKPOINT_PUBLISHED_ENTRY),
  launched: checkpointProgress(CHECKPOINT_LAUNCHED_ENTRY),
  merged: checkpointProgress(CHECKPOINT_MERGED_ENTRY),
  closed: checkpointProgress(CHECKPOINT_MERGED_ENTRY, true),
});
const DECOMPOSITION_EXTERNAL = Object.freeze({
  plan: PLAN_V2_EXTERNAL.plan,
  review: { ref: "reviews/work-decomposer.json", bytes: "{\"subject\":\"work-decomposer\",\"attempt\":1,\"verdict\":\"APPROVE\",\"required_fixes\":[]}\n" },
});
const TEST_EXECUTION_NONCE = "123e4567-e89b-42d3-a456-426614174000";
const EMPTY_STREAM = Object.freeze({ captured_bytes: 0, sha256: `sha256:${createHash("sha256").digest("hex")}`, truncated: false });
const TRUNCATED_STREAM = Object.freeze({ captured_bytes: 1048576, sha256: `sha256:${"9".repeat(64)}`, truncated: true });
const CONTINUATION_V2_EXTERNAL = Object.freeze({
  parentRun: { ref: ".opencode/factory/parent-run/run.json", bytes: "{\"schema_version\":1,\"run_id\":\"parent-run\",\"status\":\"blocked\",\"gates\":{}}\n" },
  selectedReview: { ref: "reviews/remediation-review.json", bytes: "{\"subject\":\"parent\",\"verdict\":\"NO-GO\",\"required_fixes\":[\"fix\"]}\n" },
  artifact: { ref: "artifacts/technical-brief.md", bytes: "Accepted technical brief.\n" },
  evidence: { ref: "evidence/test-verifier.json", bytes: "{\"subject\":\"test-verifier\",\"status\":\"pass\"}\n" },
  review: { ref: "reviews/spec-writer.json", bytes: "{\"subject\":\"spec-writer\",\"verdict\":\"APPROVE\"}\n" },
});
const SLICE_EXTERNAL = Object.freeze({
  evidence: { ref: "evidence/backend.json", bytes: `{"subject":"backend","attempt":1,"status":"pass","review_ready":true,"head_sha":"${SHA_B}"}\n` },
  review: { ref: "reviews/backend.json", bytes: `{"subject":"backend","attempt":1,"verdict":"APPROVE","convergence":"converging","late_discovery_strike":false,"remaining_fix_count":0,"required_fixes":[],"ownership_ratification":{"schema_version":1,"paths":[]},"remediation_context":{"schema_version":2,"fixes":[]},"reviewed_commit":"${SHA_B}"}\n` },
});
const SLICE_DISPATCH_CLAIM_REF = `dispatch/${createHash("sha256").update(`catalog-run\0backend\0${1}`, "utf8").digest("hex")}.json`;
const SLICE_DISPATCH_CLOSURE_REF = `${SLICE_DISPATCH_CLAIM_REF.slice(0, -5)}.closed.json`;
const SLICE_DISPATCH_TOKEN = "catalog-dispatch-completion-capability";
const SLICE_DISPATCH_CLAIM_BYTES = `${JSON.stringify({
  schema_version: 1, kind: "checked-slice-builder-dispatch-claim", run_id: "catalog-run", slice_id: "backend", attempt: 1,
  agent: "backend-builder", branch: "feature--backend", worktree: "/tmp/backend", head: SHA_B, context_hash: HASH_A,
  completion_token_hash: hashBytes(SLICE_DISPATCH_TOKEN), claimed_at: NOW, closure_ref: SLICE_DISPATCH_CLOSURE_REF,
}, null, 2)}\n`;
const SLICE_DISPATCH_CLOSURE_BYTES = `${JSON.stringify({
  schema_version: 1, kind: "checked-slice-builder-dispatch-closure", claim_ref: SLICE_DISPATCH_CLAIM_REF,
  claim_hash: hashBytes(SLICE_DISPATCH_CLAIM_BYTES), run_id: "catalog-run", slice_id: "backend", attempt: 1,
  agent: "backend-builder", branch: "feature--backend", worktree: "/tmp/backend", head: SHA_B, completion_head: SHA_B, context_hash: HASH_A,
  completion_token: SLICE_DISPATCH_TOKEN, returned_at: NOW,
}, null, 2)}\n`;
const SLICE_DISPATCH_EXTERNAL = Object.freeze({
  claim: { ref: SLICE_DISPATCH_CLAIM_REF, bytes: SLICE_DISPATCH_CLAIM_BYTES },
  closure: { ref: SLICE_DISPATCH_CLOSURE_REF, bytes: SLICE_DISPATCH_CLOSURE_BYTES },
});
const SLICE_NONCONVERGENCE_EXTERNAL = Object.freeze({
  evidence: SLICE_EXTERNAL.evidence,
  review: { ref: "reviews/backend.json", bytes: `{"subject":"backend","attempt":1,"verdict":"REJECT","convergence":"nonconvergent","late_discovery_strike":false,"remaining_fix_count":1,"required_fixes":["replace missed category"],"ownership_ratification":{"schema_version":1,"paths":[]},"remediation_context":{"schema_version":2,"fixes":[{"required_fix_index":0,"classification":"nonconvergent","scope_effect":"in-lane","likely_paths":["src/backend.js"],"fix_owner":"backend"}]},"reviewed_commit":"${SHA_B}"}\n` },
  ...SLICE_DISPATCH_EXTERNAL,
});
const SLICE_BLOCKED_EXTERNAL = Object.freeze({
  evidence: SLICE_EXTERNAL.evidence,
  review: { ref: "reviews/backend.json", bytes: `{"subject":"backend","attempt":1,"verdict":"REJECT","convergence":"converging","late_discovery_strike":false,"remaining_fix_count":1,"required_fixes":["apply narrow correction"],"ownership_ratification":{"schema_version":1,"paths":[]},"remediation_context":{"schema_version":2,"fixes":[{"required_fix_index":0,"classification":"narrow-correction","scope_effect":"in-lane","likely_paths":["src/backend.js"],"fix_owner":"backend"}]},"reviewed_commit":"${SHA_B}"}\n` },
  ...SLICE_DISPATCH_EXTERNAL,
});
const PANEL_EXTERNAL = Object.freeze({
  report: { ref: "artifacts/validation-report.md", bytes: "GO\n" },
  validator: { ref: "reviews/implementation-validator.json", bytes: `{"subject":"feature--catalog","attempt":1,"verdict":"GO","reviewed_head_sha":"${SHA_B}"}\n` },
  security: { ref: "reviews/security-reviewer.json", bytes: `{"subject":"feature--catalog","attempt":1,"verdict":"PASS","reviewed_head_sha":"${SHA_B}"}\n` },
});
const AMENDMENT_REVIEW_ID = "A".repeat(43);
const AMENDMENT_REVIEW_CLAIM_REF = `dispatch/${"d".repeat(64)}.amendment-review.json`;
const AMENDMENT_REVIEW_CLOSURE_REF = `dispatch/${"d".repeat(64)}.amendment-review.closed.json`;
const AMENDMENT_REVIEW_REF = `reviews/integration-amendment-${AMENDMENT_REVIEW_ID}.attempt-1.json`;
const AMENDMENT_REVIEW_TOKEN = "catalog-review-capability";
const AMENDMENT_REVIEW_CLAIM = Object.freeze({
  schema_version: 1,
  kind: "checked-integration-amendment-review-dispatch-claim",
  run_id: "catalog-run",
  amendment_id: AMENDMENT_REVIEW_ID,
  attempt: 1,
  agent: "work-reviewer",
  baseline_commit: SHA_A,
  candidate_commit: SHA_B,
  candidate_tree: SHA_C,
  review_ref: AMENDMENT_REVIEW_REF,
  context_hash: HASH_A,
  completion_token_hash: hashBytes(AMENDMENT_REVIEW_TOKEN),
  claimed_at: NOW,
  closure_ref: AMENDMENT_REVIEW_CLOSURE_REF,
});
const AMENDMENT_REVIEW_CLOSURE = Object.freeze({
  schema_version: 1,
  kind: "checked-integration-amendment-review-dispatch-closure",
  claim_ref: AMENDMENT_REVIEW_CLAIM_REF,
  claim_hash: HASH_B,
  run_id: "catalog-run",
  amendment_id: AMENDMENT_REVIEW_ID,
  attempt: 1,
  agent: "work-reviewer",
  context_hash: HASH_A,
  review_ref: AMENDMENT_REVIEW_REF,
  review_hash: HASH_C,
  completion_token: AMENDMENT_REVIEW_TOKEN,
  returned_at: NOW,
});

const AMENDMENT_MANIFEST_VARIANTS = Object.freeze([
  ["amendment-reported", "reported"],
  ["amendment-building-attempt-1", "building-1"],
  ["amendment-building-attempt-2", "building-2"],
  ["amendment-reviewed-approve-attempt-1", "reviewed-approve-1"],
  ["amendment-reviewed-reject-attempt-1", "reviewed-reject-1"],
  ["amendment-reviewed-approve-attempt-2", "reviewed-approve-2"],
  ["amendment-reviewed-reject-attempt-2", "reviewed-reject-2"],
  ["amendment-integrated", "integrated"],
  ["amendment-verified", "verified"],
  ["amendment-merged", "merged"],
  ["amendment-blocked-from-reported", "blocked-reported"],
  ["amendment-blocked-from-building", "blocked-building"],
  ["amendment-blocked-from-reviewed-approve", "blocked-reviewed-approve"],
  ["amendment-blocked-from-reviewed-reject", "blocked-reviewed-reject"],
  ["amendment-blocked-from-integrated", "blocked-integrated"],
  ["amendment-blocked-from-verified", "blocked-verified"],
]);
const AMENDMENT_CLAIM_VARIANTS = Object.freeze(["report", "verify"].flatMap((phase) => [
  [`amendment-${phase}-claim-active`, phase, "active", null],
  [`amendment-${phase}-claim-completed-pass`, phase, "completed", "pass"],
  [`amendment-${phase}-claim-completed-fail`, phase, "completed", "fail"],
  [`amendment-${phase}-claim-unknown-process-outcome-indeterminate`, phase, "unknown", "process-outcome-indeterminate"],
  [`amendment-${phase}-claim-unknown-authority-changed`, phase, "unknown", "authority-changed"],
  [`amendment-${phase}-claim-unknown-receipt-publication-indeterminate`, phase, "unknown", "receipt-publication-indeterminate"],
]));
const AMENDMENT_RECEIPT_VARIANTS = Object.freeze(["report", "verify"].flatMap((phase) => [
  "pass", "nonzero-exit", "signal", "launch-error", "timeout", "output-limit",
].map((outcome) => [`amendment-${phase}-receipt-${outcome}`, phase, outcome])));

const AMENDMENT_CATALOG = buildAmendmentCatalogFixtures();

// These literals are accepted only after reviewing renderDurableAuthorityOracleReviewSnapshot
// output for each row. Keeping the three digests adjacent makes that review auditable.
const AMENDMENT_ORACLE_DIGESTS = Object.freeze([
  ["amendment-reported", "f2e567378f7b512bb048f4d0a10c0a68a25b2bae4070701f00cc8e461a3bcc00", "51a4f80c2dc278c38fb6a93b1035e3b00c23e2e78cbf0eedf93e046de4ad4e65", "d1d641315132bc91e32a46c84aaaf087685164704ae5e9e1e059386647c5f171"],
  ["amendment-building-attempt-1", "07f59d567a7ecd572167bb8911e330cc2dbfdf2d724ccb6672d35788a236847c", "51a4f80c2dc278c38fb6a93b1035e3b00c23e2e78cbf0eedf93e046de4ad4e65", "4b37208eb15db262443a17dda966c0159b372ecfc2d7049420924f9f815aff9c"],
  ["amendment-building-attempt-2", "86801c19a361bd508c1acf9ad78f7afc29108648a68f05f7e60ada5ef8233ab0", "a9c814eba867db0b4cd8a6eba471f9be82ece9c771ebf4e755ebd96f2b7f9359", "af8201a61e7857cd018c4d6a5faf9ca9853fdaa5329341350686d16f4f99c0e3"],
  ["amendment-reviewed-approve-attempt-1", "02107e308bd08ee02f16343d4af22be1e93964f5e286a0686b139c2a5f7048ee", "a9c814eba867db0b4cd8a6eba471f9be82ece9c771ebf4e755ebd96f2b7f9359", "d3c89da34071a39ab578d1cbffe0423dfea9e860854657368f06f53e3c4c04c6"],
  ["amendment-reviewed-reject-attempt-1", "da814772cd67a39b2cc914318398458da45d74d6aee8ce49d2a37d01325880e3", "a9c814eba867db0b4cd8a6eba471f9be82ece9c771ebf4e755ebd96f2b7f9359", "fe1d10f8bb3f5538c3b45f7ef56636e5d19ebe1a9e2f80a1f887d86cac8693e6"],
  ["amendment-reviewed-approve-attempt-2", "0c5713c6c88f6d9fa4982f953a339031b631f3d264bf3db44a11aefd66819f44", "bafa5d6e8793b5ac5bfe5c41a7cbd0c5be5e98c56bc37df50b62eeea59984e3d", "16de10fcb61ebeaf5f87be2e3e3e2abd30a59326a634e1123937f7cd580e041f"],
  ["amendment-reviewed-reject-attempt-2", "9f312747a1086bd2c76ca063796422bc71ed38a637a500b3cc6ee7f7b7f55f5f", "bafa5d6e8793b5ac5bfe5c41a7cbd0c5be5e98c56bc37df50b62eeea59984e3d", "75870130df88ee7adde8008c73d39760d1d3e197427802a3f9e0c9cc3150dd93"],
  ["amendment-integrated", "bb5a8eb0f2424e2a6b9d67f3022cbbca22bd0e38a0121b6ca3b6742799b46f20", "a9c814eba867db0b4cd8a6eba471f9be82ece9c771ebf4e755ebd96f2b7f9359", "6ca78fb895f9db2c034960e84cb0ca5a0dfbb6a190f18aaaeb51752d3aeb55ac"],
  ["amendment-verified", "f0b893fa235e20c7c3a8f213789c115bbcea541233b99ecf5d32b94f898c89bf", "e21dbda8b174ec99e9c987082320d56304f358d441483c23ddfaae91534a8904", "5d95a822bd366baecf5beb5b70e84cd9c7f6a1c0c9a1d31591571e0734d315eb"],
  ["amendment-merged", "cf4f62216e01eac271289d097ffe002a0b158d334861c29d092c16d99cfb25c4", "e21dbda8b174ec99e9c987082320d56304f358d441483c23ddfaae91534a8904", "18ca951179cb03c9de667945d797d9704fe26793980503ecb01983e31d9257e5"],
  ["amendment-blocked-from-reported", "7d949dce8af0b86e9a524af1e1df602d510e5e389703a8da09339e878e4e61ae", "51a4f80c2dc278c38fb6a93b1035e3b00c23e2e78cbf0eedf93e046de4ad4e65", "c43eabfe841a9303c8308748317886d9287d6e34057b0f24bdedfb30a31c5749"],
  ["amendment-blocked-from-building", "10229f98d37ccc598b4dae37bb5dd19a83c096591c41f7cde77bfa7e3f1bc946", "51a4f80c2dc278c38fb6a93b1035e3b00c23e2e78cbf0eedf93e046de4ad4e65", "33abde46eb9d90fce7232179172d0a96ea57000ec5d51f228ccd9e0ed0b14e65"],
  ["amendment-blocked-from-reviewed-approve", "75f51a5d5318a815c4d1cb98889f1888dca6d42c2f04567a54acc13175da0f75", "a9c814eba867db0b4cd8a6eba471f9be82ece9c771ebf4e755ebd96f2b7f9359", "dabb20af15a2c0bb2412cf4cc324700c28de6f7e0673dfb4ff0ecf77ff0c4689"],
  ["amendment-blocked-from-reviewed-reject", "d99dbf79b6e66ac7d956b9a90f52bf107c8c6ff1a5319c62a01db6d333a6b439", "a9c814eba867db0b4cd8a6eba471f9be82ece9c771ebf4e755ebd96f2b7f9359", "a37a127b6046001d3bdfa164db90372dd6743a8f69d4d3f1daba153988e4bb55"],
  ["amendment-blocked-from-integrated", "26099ed07c0293a9ce2362c80388b6b85274c54e52c67495f93fbba97ca878fb", "a9c814eba867db0b4cd8a6eba471f9be82ece9c771ebf4e755ebd96f2b7f9359", "17e7c228e8ae6688a39e4fa352a38a13a0172ae9cc79654ed9d904e38cc096c8"],
  ["amendment-blocked-from-verified", "f8176931a7e6e287756242aa68fc0aa94ed462c6e17a31a21bdd2cb18c5ece61", "e21dbda8b174ec99e9c987082320d56304f358d441483c23ddfaae91534a8904", "c143e0542cbb87294a00876fa1f09d3997c2bd6556bd9e2995a3361333d633c6"],
  ["amendment-report-claim-active", "66d66dadae878f69dbaa70423ed8449bf8e041bc98ff4b6362666b6c058eef62", "f7591d94dcc72d7c550873c4d559bf9f5567840a6397505b3c2c5acd93973e63", "a76e9c2e8cdbc57ea0203b5fd30e4b44b40ef2c494088e89e04426f1caf5fabd"],
  ["amendment-report-claim-completed-pass", "a16a2200497ae7ca062939700c95b37b3c932b8e63c9138c0ec34684de7cf5c8", "8640d1ba3e74b68bf4336d592484bafa68bf5feec0bb0e4347d7a5de0265f69c", "088d658cf32b88ee4cf1e60434494025b35320b60cfb465ca7a0e560db4acb5e"],
  ["amendment-report-claim-completed-fail", "89277e0030238ecde96b6668d5205023c84be7ab387dfd578cfaaa62f4747ab4", "8640d1ba3e74b68bf4336d592484bafa68bf5feec0bb0e4347d7a5de0265f69c", "6245bf31e86e2d9fc3c336ae33c9e7feb903def962c27e0fdfbab2ebb5a84881"],
  ["amendment-report-claim-unknown-process-outcome-indeterminate", "7e9452afdfc9c857a94e2f5ce5a406d9587a47fea08f1a4755c422a50414e79f", "d13c737aec1cc55239c2e2eeca59401bf76b861b3e689e7ba6c03bd6eee8dc33", "ab83795d24aa728c68a7975831c432f8325d27226f343493a411589d9c5f38c2"],
  ["amendment-report-claim-unknown-authority-changed", "3ccd93aa4d609bd3065d5c08fb1c36b24c25768134e7e8608edf8ba9e85c1700", "78524e5a41d6d47973a5c290dd20ff15884018f10b8715b48c22dc547f025d93", "3a14668d53ff5266eab1b35632d6cf6f700d7b02cdd03249a085ef56843dc9df"],
  ["amendment-report-claim-unknown-receipt-publication-indeterminate", "c4d8d770ea4aeb09bca4bbaa731cd14187ee73d1f678e7af9c0c44e1e83b4ad2", "bb4dc5d868455e2fe488cb0331ff4c494e1af84a7dd1c33a6603f7b02418db37", "acf69486213a83d94e5d39ffad8800c12a5888e27206a84153fd26d6523af1f5"],
  ["amendment-verify-claim-active", "258b2fd82803e5e3c1f904d0ac76c9c4b38e135d733052d7fb94940f0baa27ac", "ecec94c733ceb29d0ab34163c161d566704415493f33e54b189b310b67227b18", "50aeaa83cc22d9f026817c12f6659ea7ce5f0407d9d354053b879b0c2004f6f3"],
  ["amendment-verify-claim-completed-pass", "8b1572e70ed1c089f792c05a6309c31e1c772f31f240ff161f5cf388fae861c8", "7e21eeb2ead2098769e0e49ac10a2c42f946284bbe8a6811533841a6e5c45fe3", "bd1560167788ab138a8107ed8550477fdbbc4d4bfb1812d684147eb78881cc06"],
  ["amendment-verify-claim-completed-fail", "9289c066185c676045aec73b070481a865451cdfb43bd4a77bd25e127e836e4c", "7e21eeb2ead2098769e0e49ac10a2c42f946284bbe8a6811533841a6e5c45fe3", "13f8bfb27c1a7a7c652533537ea94b78173bdc4a693440cfcdd81f2bebeff153"],
  ["amendment-verify-claim-unknown-process-outcome-indeterminate", "05d1f9206acc640028151dfb2165bfe94c39044d88d66a4dc0409a34069b05c7", "1c53cea6b9f2d2425005c924b6d22589c438ae4f1957ddb1be9352dd5abc3087", "5c4182a9126bfa9728b6297e041fe3d4793e3ea1e4efaf5bc15631fa9b455397"],
  ["amendment-verify-claim-unknown-authority-changed", "f7c8c0cd67ea365e6719c19041902d33d2b38ab9dae741d7e0c0aa822b0d71d5", "f09bbb85cde78ab2f9a5923da939e2e9a894ba6ebae05c26aec06b22a526920d", "6ffc100f936c468112a1863315084295c2c717a4fdaf2cbbfe84e57203925905"],
  ["amendment-verify-claim-unknown-receipt-publication-indeterminate", "d425a449d7e6fe8aee45d941a16fc48becbd337803337a628d46f5980e214830", "082b741f9c64a4a2e62c5f3ae71cda135cb007ade705a47ff78a3c496f48c9be", "b8d60b1c8b3954337ac49d1f7dc1114d2e0913e27c7c13ae57b625aa91264de7"],
  ["amendment-report-receipt-pass", "f0b3a1dd824f7b5683655c39f926ba89ecc337106b784ee82a141709217fd9b3", "550c02cdc9722e545633c183da80eab0a420dc1adc1d1a964f2f79cb41ccf26f", "e7a4035462952289013bb689b92cd4bc2335f2d25374b878bd6a4fb28acceb7e"],
  ["amendment-report-receipt-nonzero-exit", "64e8aab9c1eb6a1877d6439cef2f9fb53e9f645e7c5cd20ddf7fb437998babd6", "20258fa0daadb0c989c08f63fd2f5a057d5b10a1fa0931e45a687845cc887cd3", "4165e17146d6643fb3877f9e9a7f0e59f58565c50b8172c96da0c7b1001929b5"],
  ["amendment-report-receipt-signal", "9515da3cc328723faefe9ca76a00be441be6c7e46f54a5175e99c43f370237c9", "ef340366dc25784d964873a90a23152f21c1455891b253528938051c84971f4f", "41807ab1cf67e7c0d5913f1cdfdbeb639920aba0d9b38b6c5fd5770246e7cd73"],
  ["amendment-report-receipt-launch-error", "4ca824286ce812e9291ed00775698c8bbcd469c8314c1443900c348601eb390f", "df64bc870f176e07107870ae30b7820800bb4e1d6fffdeb0350f125da585bd49", "ba465db6c9bbca6e81eb04d847b144de8192fbcb496c3cffcc8d6a640cd44e51"],
  ["amendment-report-receipt-timeout", "a47ad66914e8a80bad3128997db115efde2c15bf4467fceb8cf63f8566f11fd2", "16b575e226578e0c0b5ed3c67a506d116c16f84a77b1563e0bb4a513971c8178", "259fd00996ca864a21ef0cf3530cce7029595b5051af13be607688fdfe2cea7d"],
  ["amendment-report-receipt-output-limit", "31d230c2e72aa23b83458e9ea4fb5553e1a9928f96434a66d37a28dd89bcee13", "a2f2a0722d164b97d0fd0ed545bc503e88227e68975565774c78f2ddfd52fbb7", "9efa5feac1e33e3951a4f25f3e082c56ed9f201671564b0bc35d68fb536d0e0a"],
  ["amendment-verify-receipt-pass", "948d6b00798a8d0e5f0acad655777fa4456cd7ec8a1173fbdeb8037579caef83", "19c6ea360800631b124bf581debae778fbc7c1ef60e0ebb226e5fba4850bdc3b", "149ee190ac05d7c1272902a852ab068de6b379a4f61aa23fec24b13701b60ff7"],
  ["amendment-verify-receipt-nonzero-exit", "46bd91a289b4953578d69ab06e60e486326f22a5166d679e98685622ad13fcdc", "7fc5de859af42f3dfe9cf24eacb45806b1ef489b72267656619b14e72f239685", "24513b48f0b3122e5eac718557d36632c9eb6a4edbf4bf7b84766d3e0f871cba"],
  ["amendment-verify-receipt-signal", "b294805247cb5a7903b60f17848217ca56957bb46b3240221d0ece9bb5aaf9b3", "d9eca6bd7e7c25bd5b344103eb6cd6e7786075b1f874196bd01c24d7a4f1a0ea", "6370a4098cd8d5c06d3ac75249edaf38e43849efe9bc3eaa8df5ac4cd9d330fb"],
  ["amendment-verify-receipt-launch-error", "b4267a5caf0f7ee6af5126e61618222bbe33f4145fa9d7b9e93ef24d29bac6f5", "ec875584a48c3624edaf6ce7653a3c0de04e34d9e228fd85c5c4db390663a8f1", "889a292a6c514f44303ab25352665bd13634f67dfe65d7dd72aff436efba6b0f"],
  ["amendment-verify-receipt-timeout", "a637f9d2d6d4fb097042c922d4a61597dc506b03239f1962fb9378bbf5d26a3e", "5f9eb8570773d3636f2c453b9bd5fda151ab9c44f2707e4d68ecfe76db37ca1e", "65044ab474cf5d1219dd208b9e623b50ee42eb357f2901736bbb27f87b091705"],
  ["amendment-verify-receipt-output-limit", "d533e6794c427487f873cd964a858b8663c3727e6603bdef16057ae1a93ebe66", "ebace15d1efb94794690b9375ab8d04b97136ee6e98fd4f6f0c59f4a7ec9e88d", "127456b4d40bef9c5a078f12083d5802394bba15bd181434699e088992aaffcf"],
  ["amendment-review-approve", "f7bf97adf59ced3042ab5a2bdf21322b362ab82dee4dcf30d38efd8eabf203f0", "3a1b3cf38797f0efbe5c338d877217f9b51a7647b8d9adf6f30c5d42aa4c1521", "ff7a09d527769a71ad4bf45640e9e02d1d6ea96992d6f843bf0c5e3b7d52bb94"],
  ["amendment-review-reject", "b9415b49699f1bca44923477eaa562c94d7da2e0147500757f9bddc8c505c617", "c1b9c3a012c3c7ea17883e50e754622149a3b3e3489e51433f2375a6a2484d2e", "d2f4a8f97d21acd4bcb0428dbdd14e447e7876fdcd9119eaaa190b92670c2b85"],
  ["amendment-dispatch-binding-active", "a0bf0001fa0cf2450074e109a4711b1f3d96985fc985c879eb2ba99380089509", "5991be6b8f984f0a48140e5dfd2371711ac828f3b4eeb711d6f300e10f053817", "eed707b82166d3b6bab75258803be5f57d2533f6d8d29b9e38291dda490344fe"],
  ["amendment-dispatch-binding-closed", "1b185bff8cfdee4c151685135bce9f18f82a56ab12321f74e40fe1912790bb90", "805350ba8beff76307dbfe11c78710338661182e302e5e4781465fb7505c422c", "4e79afd5e8939706954e96a1bcd82715cf8659ed308fb9f42e1683b9638cf5ac"],
  ["amendment-dispatch-claim", "1007c5572f98d7bf9c51ffd8190b16596934418912bd021873182b70a3a550b9", "b5efc2ee8d3b9c3c38918686b8923ec9e937dbed48568baafdf731bbbfc69bde", "95268884aea6496aa642a64ca421da810d97d1f24c9e7520bce19be28e53d26f"],
  ["amendment-dispatch-closure", "69e00caafc0228e91ee290bee350edf92e30e6a4eea030d411b10ff2e4bddc25", "f1cd4bf2fc19d8e52edc4acaa5005f839e9fd529a8197fb347edcace6380ece2", "d6995a50df7674e59cd0fce0cee2f7b070b945205e2eada00923927366b82f9f"],
]);

export const DURABLE_AUTHORITY_REQUIRED_RECORD_IDS = deepFreeze({
  "plan-slices-graph": [
    "plan-slices-json",
    "plan-v2-integration-gate",
    "plan-delivery-envelope-v1",
    "checkpoint-reviewed-plan-v1",
    "checkpoint-admission-probe-valid",
    "checkpoint-child-disposition-v1",
    "checkpoint-routing-artifact-v1",
    "checkpoint-child-publication-v1",
    "checkpoint-source-v1",
    "checkpoint-progress-reserved",
    "checkpoint-progress-child-published",
    "checkpoint-progress-launched",
    "checkpoint-progress-merged",
    "checkpoint-progress-closed",
    "checkpoint-merged-completion-v1",
    "checkpoint-final-closure-v1",
    "final-plan-descriptor",
  ],
  "run-envelope-terminal-result": [
    "run-envelope-running",
    "run-envelope-terminal",
    "terminal-result-completed",
    "terminal-result-blocked",
    "terminal-result-blocked-checkpoint-routing",
    "terminal-result-blocked-nonconvergence",
    "terminal-result-partial",
    "terminal-result-needs-human",
  ],
  "gates-snapshot-handoff": [
    "gate-pending",
    "gate-approved-without-receipt",
    "gate-approved-interactive",
    "gate-changes-requested",
    "gate-stopped",
  ],
  "steps-acceptance-inheritance": [
    "step-running",
    "step-rejected",
    "step-blocked",
    "step-accepted",
    "step-work-decomposer-accepted-plan",
    "step-inherited-acceptance",
    "test-execution-claim-active",
    "test-execution-claim-completed-pass",
    "test-execution-claim-completed-fail",
    "test-execution-claim-unknown-process-outcome-indeterminate",
    "test-execution-claim-unknown-authority-changed",
    "test-execution-claim-unknown-receipt-publication-indeterminate",
    "test-execution-receipt-pass",
    "test-execution-receipt-failed-nonzero-exit",
    "test-execution-receipt-failed-signal",
    "test-execution-receipt-failed-launch-error",
    "test-execution-receipt-failed-timeout",
    "test-execution-receipt-failed-output-limit",
  ],
  "slices-review-evidence-bindings": [
    "slice-pending",
    "slice-running",
    "slice-review",
    "review-invariant-family-ledger-v1",
    "verification-artifact-claim-active",
    "verification-artifact-claim-completed-pass",
    "verification-artifact-claim-completed-fail",
    "verification-artifact-claim-unknown-process",
    "verification-artifact-claim-unknown-receipt",
    "verification-artifact-execution-receipt-pass",
    "verification-artifact-execution-receipt-fail",
    "slice-merged",
    "slice-blocked-ordinary",
    "slice-blocked",
  ],
  "validator-security-pr-result": [
    "validator-verdict-binding",
    "security-verdict-binding",
    "steering-boundary",
    "steering-action-claim",
    "steering-last-action",
    "steering-pr-fence",
    "pr-created-result",
  ],
  "continuation-v2-carry-forward": [
    "continuation-v2-envelope",
    "continuation-v2-parent-binding",
    "continuation-v2-selected-review",
    "continuation-v2-target-binding",
    "continuation-v2-parent-artifact-sidecar",
    "continuation-v2-parent-evidence-sidecar",
    "continuation-v2-parent-review-sidecar",
    "continuation-v2-planning-reuse",
  ],
  "post-pr-nested-records": [
    "post-pr-phase-disabled",
    "post-pr-phase-awaiting-pr",
    "post-pr-phase-observing",
    "post-pr-phase-failure-recording",
    "post-pr-phase-remediation-planned",
    "post-pr-phase-remediation-running",
    "post-pr-phase-changes-observed",
    "post-pr-phase-committed",
    "post-pr-phase-revalidating",
    "post-pr-phase-validated",
    "post-pr-phase-push-pending",
    "post-pr-phase-remote-confirmed",
    "post-pr-phase-succeeded",
    "post-pr-phase-blocked",
    "post-pr-phase-needs-human",
    "post-pr-policy-disabled",
    "post-pr-policy-enabled",
    "post-pr-observation-null",
    "post-pr-observation-active",
    "post-pr-observation-last-error",
    "post-pr-observation-review-request",
    "post-pr-observation-snapshot",
    "post-pr-remediation-null",
    "post-pr-remediation-active",
    "post-pr-remediation-owner",
    "post-pr-remediation-changes",
    "post-pr-remediation-change-entry",
    "post-pr-dispatch-planned",
    "post-pr-dispatch-running",
    "post-pr-dispatch-returned",
    "post-pr-revalidation-empty",
    "post-pr-revalidation-bound",
    "post-pr-canonical-job-planned",
    "post-pr-canonical-job-running",
    "post-pr-canonical-job-retry-wait",
    "post-pr-canonical-job-bound",
    "post-pr-validator-job-planned",
    "post-pr-validator-job-running",
    "post-pr-validator-job-retry-wait",
    "post-pr-validator-job-bound",
    "post-pr-security-job-planned",
    "post-pr-security-job-running",
    "post-pr-security-job-retry-wait",
    "post-pr-security-job-bound",
    "post-pr-push-not-ready",
    "post-pr-push-pending",
    "post-pr-push-confirmed",
    "post-pr-push-last-error",
    "post-pr-evidence-sidecar",
    "post-pr-continuation-review-null",
    "post-pr-continuation-review-bound",
    "post-pr-terminal-fact-null",
    "post-pr-terminal-fact-account-switch-failed-github-auth",
    "post-pr-terminal-fact-account-switch-failed-push",
    "post-pr-terminal-fact-dispatch-start-unknown",
    "post-pr-terminal-fact-path-lane-violation",
    "post-pr-terminal-fact-remote-head-diverged",
    "post-pr-terminal-fact-panel-runner-result-malformed",
    "post-pr-terminal-fact-push-failed",
    "post-pr-terminal-fact-panel-attribution-unsafe",
  ],
  "pr79-merged-slice-repair": [
    "amendment-reported",
    "amendment-building-attempt-1",
    "amendment-building-attempt-2",
    "amendment-reviewed-approve-attempt-1",
    "amendment-reviewed-reject-attempt-1",
    "amendment-reviewed-approve-attempt-2",
    "amendment-reviewed-reject-attempt-2",
    "amendment-integrated",
    "amendment-verified",
    "amendment-merged",
    "amendment-blocked-from-reported",
    "amendment-blocked-from-building",
    "amendment-blocked-from-reviewed-approve",
    "amendment-blocked-from-reviewed-reject",
    "amendment-blocked-from-integrated",
    "amendment-blocked-from-verified",
    "amendment-report-claim-active",
    "amendment-report-claim-completed-pass",
    "amendment-report-claim-completed-fail",
    "amendment-report-claim-unknown-process-outcome-indeterminate",
    "amendment-report-claim-unknown-authority-changed",
    "amendment-report-claim-unknown-receipt-publication-indeterminate",
    "amendment-verify-claim-active",
    "amendment-verify-claim-completed-pass",
    "amendment-verify-claim-completed-fail",
    "amendment-verify-claim-unknown-process-outcome-indeterminate",
    "amendment-verify-claim-unknown-authority-changed",
    "amendment-verify-claim-unknown-receipt-publication-indeterminate",
    "amendment-report-receipt-pass",
    "amendment-report-receipt-nonzero-exit",
    "amendment-report-receipt-signal",
    "amendment-report-receipt-launch-error",
    "amendment-report-receipt-timeout",
    "amendment-report-receipt-output-limit",
    "amendment-verify-receipt-pass",
    "amendment-verify-receipt-nonzero-exit",
    "amendment-verify-receipt-signal",
    "amendment-verify-receipt-launch-error",
    "amendment-verify-receipt-timeout",
    "amendment-verify-receipt-output-limit",
    "amendment-review-approve",
    "amendment-review-reject",
    "amendment-dispatch-binding-active",
    "amendment-dispatch-binding-closed",
    "amendment-dispatch-claim",
    "amendment-dispatch-closure",
    "amendment-review-dispatch-claim",
    "amendment-review-dispatch-closure",
  ],
});

const FAMILY_BY_CODE = Object.freeze({ m: "missing-key", u: "unknown-key", s: "wrong-schema", k: "wrong-kind", t: "wrong-time", y: "wrong-type", r: "wrong-ref", h: "wrong-hash", b: "wrong-bytes", d: "descriptor-key-shape-drift", i: "stale-identity", c: "cross-bound-identity" });

// This closed source-boundary registry is deliberately independent from RECORDS. Each value
// explicitly classifies the families excluded by that entry; every other family must be targeted.
const EXPLICIT_EXCLUDED_FAMILY_CODES = deepFreeze({
  "plan-slices-json": "sktrhb",
  "plan-v2-integration-gate": "sktrhb",
  "plan-delivery-envelope-v1": "ktrhb",
  "checkpoint-reviewed-plan-v1": "trhb",
  "checkpoint-admission-probe-valid": "tb",
  "checkpoint-child-disposition-v1": "tb",
  "checkpoint-routing-artifact-v1": "t",
  "checkpoint-child-publication-v1": "b",
  "checkpoint-source-v1": "tb",
  "checkpoint-progress-reserved": "b",
  "checkpoint-progress-child-published": "b",
  "checkpoint-progress-launched": "b",
  "checkpoint-progress-merged": "b",
  "checkpoint-progress-closed": "b",
  "checkpoint-merged-completion-v1": "b",
  "checkpoint-final-closure-v1": "b",
  "final-plan-descriptor": "",
  "run-envelope-running": "khbd",
  "run-envelope-terminal": "krhbd",
  "terminal-result-completed": "skthbd",
  "terminal-result-blocked": "sktrhbd",
  "terminal-result-blocked-checkpoint-routing": "skthb",
  "terminal-result-blocked-nonconvergence": "skt",
  "terminal-result-partial": "sktrhbd",
  "terminal-result-needs-human": "sktrhbd",
  "gate-pending": "sk",
  "gate-approved-without-receipt": "sk",
  "gate-approved-interactive": "",
  "gate-changes-requested": "sk",
  "gate-stopped": "sk",
  "step-running": "sktrhbd",
  "step-rejected": "skthbd",
  "step-blocked": "skthbd",
  "step-accepted": "skt",
  "step-work-decomposer-accepted-plan": "skt",
  "step-inherited-acceptance": "skt",
  "test-execution-claim-active": "b",
  "test-execution-claim-completed-pass": "",
  "test-execution-claim-completed-fail": "",
  "test-execution-claim-unknown-process-outcome-indeterminate": "b",
  "test-execution-claim-unknown-authority-changed": "b",
  "test-execution-claim-unknown-receipt-publication-indeterminate": "b",
  "test-execution-receipt-pass": "b",
  "test-execution-receipt-failed-nonzero-exit": "b",
  "test-execution-receipt-failed-signal": "b",
  "test-execution-receipt-failed-launch-error": "b",
  "test-execution-receipt-failed-timeout": "b",
  "test-execution-receipt-failed-output-limit": "b",
  "slice-pending": "sktrhbd",
  "slice-running": "sktd",
  "slice-review": "skt",
  "review-invariant-family-ledger-v1": "kt",
  "verification-artifact-claim-active": "b",
  "verification-artifact-claim-completed-pass": "b",
  "verification-artifact-claim-completed-fail": "b",
  "verification-artifact-claim-unknown-process": "b",
  "verification-artifact-claim-unknown-receipt": "b",
  "verification-artifact-execution-receipt-pass": "b",
  "verification-artifact-execution-receipt-fail": "b",
  "slice-merged": "sk",
  "slice-blocked-ordinary": "skt",
  "slice-blocked": "skt",
  "validator-verdict-binding": "sktd",
  "security-verdict-binding": "sktd",
  "steering-boundary": "srb",
  "steering-action-claim": "srhb",
  "steering-last-action": "srhb",
  "steering-pr-fence": "skb",
  "pr-created-result": "skthbd",
  "continuation-v2-envelope": "rhbd",
  "continuation-v2-parent-binding": "sktd",
  "continuation-v2-selected-review": "std",
  "continuation-v2-target-binding": "skthbd",
  "continuation-v2-parent-artifact-sidecar": "std",
  "continuation-v2-parent-evidence-sidecar": "std",
  "continuation-v2-parent-review-sidecar": "std",
  "continuation-v2-planning-reuse": "sktd",
  "post-pr-phase-disabled": "ktrhbd",
  "post-pr-phase-awaiting-pr": "ktrhbd",
  "post-pr-phase-observing": "ktrhbd",
  "post-pr-phase-failure-recording": "ktrhbd",
  "post-pr-phase-remediation-planned": "ktrhbd",
  "post-pr-phase-remediation-running": "ktrhbd",
  "post-pr-phase-changes-observed": "ktd",
  "post-pr-phase-committed": "ktd",
  "post-pr-phase-revalidating": "ktd",
  "post-pr-phase-validated": "ktd",
  "post-pr-phase-push-pending": "ktd",
  "post-pr-phase-remote-confirmed": "ktd",
  "post-pr-phase-succeeded": "ktrhbd",
  "post-pr-phase-blocked": "ktrhbd",
  "post-pr-phase-needs-human": "ktrhbd",
  "post-pr-policy-disabled": "sktrhb",
  "post-pr-policy-enabled": "sktrhb",
  "post-pr-observation-null": "sktrhbd",
  "post-pr-observation-active": "skrhb",
  "post-pr-observation-last-error": "skrhbd",
  "post-pr-observation-review-request": "skrhbd",
  "post-pr-observation-snapshot": "sktrhb",
  "post-pr-remediation-null": "sktrhbd",
  "post-pr-remediation-active": "td",
  "post-pr-remediation-owner": "strhbd",
  "post-pr-remediation-changes": "sktrb",
  "post-pr-remediation-change-entry": "skthb",
  "post-pr-dispatch-planned": "skrhbd",
  "post-pr-dispatch-running": "skrhbd",
  "post-pr-dispatch-returned": "skrhbd",
  "post-pr-revalidation-empty": "sktrhbd",
  "post-pr-revalidation-bound": "sktd",
  "post-pr-canonical-job-planned": "skrhbd",
  "post-pr-canonical-job-running": "skrhbd",
  "post-pr-canonical-job-retry-wait": "skrhbd",
  "post-pr-canonical-job-bound": "sktd",
  "post-pr-validator-job-planned": "skrhbd",
  "post-pr-validator-job-running": "skrhbd",
  "post-pr-validator-job-retry-wait": "skrhbd",
  "post-pr-validator-job-bound": "sktd",
  "post-pr-security-job-planned": "skrhbd",
  "post-pr-security-job-running": "skrhbd",
  "post-pr-security-job-retry-wait": "skrhbd",
  "post-pr-security-job-bound": "sktd",
  "post-pr-push-not-ready": "skrhbd",
  "post-pr-push-pending": "skrhbd",
  "post-pr-push-confirmed": "skrhbd",
  "post-pr-push-last-error": "skrhbd",
  "post-pr-evidence-sidecar": "sktd",
  "post-pr-continuation-review-null": "sktrhbd",
  "post-pr-continuation-review-bound": "sktd",
  "post-pr-terminal-fact-null": "sktrhbd",
  "post-pr-terminal-fact-account-switch-failed-github-auth": "rhbd",
  "post-pr-terminal-fact-account-switch-failed-push": "rhbd",
  "post-pr-terminal-fact-dispatch-start-unknown": "rhbd",
  "post-pr-terminal-fact-path-lane-violation": "rhbd",
  "post-pr-terminal-fact-remote-head-diverged": "rhbd",
  "post-pr-terminal-fact-panel-runner-result-malformed": "rhbd",
  "post-pr-terminal-fact-push-failed": "rhbd",
  "post-pr-terminal-fact-panel-attribution-unsafe": "rhbd",
  "amendment-reported": "",
  "amendment-building-attempt-1": "",
  "amendment-building-attempt-2": "",
  "amendment-reviewed-approve-attempt-1": "",
  "amendment-reviewed-reject-attempt-1": "",
  "amendment-reviewed-approve-attempt-2": "",
  "amendment-reviewed-reject-attempt-2": "",
  "amendment-integrated": "",
  "amendment-verified": "",
  "amendment-merged": "",
  "amendment-blocked-from-reported": "",
  "amendment-blocked-from-building": "",
  "amendment-blocked-from-reviewed-approve": "",
  "amendment-blocked-from-reviewed-reject": "",
  "amendment-blocked-from-integrated": "",
  "amendment-blocked-from-verified": "",
  "amendment-report-claim-active": "hb",
  "amendment-report-claim-completed-pass": "",
  "amendment-report-claim-completed-fail": "",
  "amendment-report-claim-unknown-process-outcome-indeterminate": "b",
  "amendment-report-claim-unknown-authority-changed": "b",
  "amendment-report-claim-unknown-receipt-publication-indeterminate": "b",
  "amendment-verify-claim-active": "hb",
  "amendment-verify-claim-completed-pass": "",
  "amendment-verify-claim-completed-fail": "",
  "amendment-verify-claim-unknown-process-outcome-indeterminate": "b",
  "amendment-verify-claim-unknown-authority-changed": "b",
  "amendment-verify-claim-unknown-receipt-publication-indeterminate": "b",
  "amendment-report-receipt-pass": "rhb",
  "amendment-report-receipt-nonzero-exit": "rhb",
  "amendment-report-receipt-signal": "rhb",
  "amendment-report-receipt-launch-error": "rhb",
  "amendment-report-receipt-timeout": "rhb",
  "amendment-report-receipt-output-limit": "rhb",
  "amendment-verify-receipt-pass": "rhb",
  "amendment-verify-receipt-nonzero-exit": "rhb",
  "amendment-verify-receipt-signal": "rhb",
  "amendment-verify-receipt-launch-error": "rhb",
  "amendment-verify-receipt-timeout": "rhb",
  "amendment-verify-receipt-output-limit": "rhb",
  "amendment-review-approve": "rhb",
  "amendment-review-reject": "rhb",
  "amendment-dispatch-binding-active": "t",
  "amendment-dispatch-binding-closed": "t",
  "amendment-dispatch-claim": "b",
  "amendment-dispatch-closure": "",
  "amendment-review-dispatch-claim": "b",
  "amendment-review-dispatch-closure": "",
});

// Hashes are independent, immutable exact-value snapshots over writer, all readers, named tests,
// authority facts, and complete sidecar descriptors, in that order. They are not derived from RECORDS.
export const DURABLE_AUTHORITY_METADATA_MANIFEST = deepFreeze([
  ["plan-slices-json", "9df4c015456f1a3e7df8f7c5ab6d646e59b55d718b28514cec41ec082ee433e3"],
  ["plan-v2-integration-gate", "5af20fb944661b40cf225b9ca0ccf1489f64cf62f06efd8c813dafadf9a6b781"],
  ["plan-delivery-envelope-v1", "3f197e85283502ae65c5236a8a68fe4948657dfbd9c2b523d624486587b8cc33"],
  ["checkpoint-reviewed-plan-v1", "c9971fbcc7abc04bb7cf6bba21728347e7e6e949b80f2f9e641ce68d3eeed48a"],
  ["checkpoint-admission-probe-valid", "2797da6a207352f26c09919aeb03a61876d3aad763a5afd788f67bf803588d71"],
  ["checkpoint-child-disposition-v1", "f509c0ad77439d63d18512288afc2ccb3b45eb31c1de9f14a8673f3ae3220d54"],
  ["checkpoint-routing-artifact-v1", "452388e863d440fcdf1e24fe82675269bcec71dc83a5276c6b9af38617faa2a2"],
  ["checkpoint-child-publication-v1", "2a99002e601a4ecb14f9caccb0514ab9d87b43bbc824414bfb4f724bfd9ee2b3"],
  ["checkpoint-source-v1", "8b6e56b64d8bb95ce4ebf676dc8133f6d4ce96eb252fb2b5c58611f491705d1c"],
  ["checkpoint-progress-reserved", "72470df204c88139e3b3d9c12860cfdeb4e024df5141cf0700ab6d683b555005"],
  ["checkpoint-progress-child-published", "7f48b28bc0f5c87d5bffd49d2955fc3cb819c9597ebbd8e0e9fb91c010aba6a7"],
  ["checkpoint-progress-launched", "66122bcfd83597c228660aaf5e7e2b3ed0aa7436f311842b9d8beac308b76a71"],
  ["checkpoint-progress-merged", "668a8c1678569ad4513c9c01b6a932a995047b68905d1ae96a0c67c74eff52d2"],
  ["checkpoint-progress-closed", "0720c7e4322f0d13b514abb2af07f7a618381f1193f1da0aef992bcc2ac110fe"],
  ["checkpoint-merged-completion-v1", "0052306d0c53fc9a886370200fd7a9059a0de130d32617a553a3a91c559fca88"],
  ["checkpoint-final-closure-v1", "18d5d61dd734f836e562520166de8e47bad8c4d6ad97cb416d2f5cda51f46cc3"],
  ["final-plan-descriptor", "f6148197c8baa1f9662a399cd4eca3d3ea713d9bc95f77b30bf608d2c784bac1"],
  ["run-envelope-running", "707c057f31eeb1213ea82cf16229bb1de2097c2961956eee0a6d0c32bccc6b3d"],
  ["run-envelope-terminal", "d0199700f70c4f08427631780dae93cf197fd46ab3e0ed78d001020b7c7ee1f4"],
  ["terminal-result-completed", "624dd6c0050e64037c95aca7904c9841656bd09684c3d8548b05e15601ba094c"],
  ["terminal-result-blocked", "681845bd946f1cb11d6f2d0a528946365756a79f2ce284179856360e3d9b631e"],
  ["terminal-result-blocked-checkpoint-routing", "cb7bb5cb412088a8be48b834477260fc58a5d1ecdf43a7fb580a8a9c8ae8a4dd"],
  ["terminal-result-blocked-nonconvergence", "1b119c91d1ead2e56f7fe0a4dd87f843a8b625a81130fdeac64f590ef50f90f1"],
  ["terminal-result-partial", "6726223fbe9f4850a9d6815d78ccf5b5fbbdfdebcd6bf5c7611ace16569b9705"],
  ["terminal-result-needs-human", "8b7d4e6f6533c6072da2e83300c1f2503055905c0bcf5d69a54a91196f6c2eef"],
  ["gate-pending", "fed011780d644435b702f54dec1207d1b9d1a9990ce61c617c1a716c76ada680"],
  ["gate-approved-without-receipt", "805e0dca68680ab259f17e6bb87d585114f4d9ae4c50bd9eeae23a329194bd32"],
  ["gate-approved-interactive", "7eac2d735ca841d24003ff24c911b7efc1939fb7e16740f70da6b591189735e5"],
  ["gate-changes-requested", "4a2085087fb628d88274a2a980c4835d2fbe6ca0ebc68a2b63574ac04e0baba9"],
  ["gate-stopped", "b22015d0a2054d890e82b48fc7e4973cd76853327a2f973a1248f7e54d40e5dd"],
  ["step-running", "71cca35dbbf733ff91d7b65c0a7fc79dc030e6d349f0df5482cebdd625a924eb"],
  ["step-rejected", "d54549ecdbbda07370535e204db33722a56d1d958fa36af9e977fec2f2dc9f2b"],
  ["step-blocked", "d3a8fc846c39704346d34938951062d884fb3e03eedb522bfd4e15161c26885a"],
  ["step-accepted", "a10f57321f62fb099ae381316e62a2c089a83a89f160178400e7f3d994b1c699"],
  ["step-work-decomposer-accepted-plan", "87d09615354c5b6d504cbe03853d489458ad54bf5cf69bfa8f2c84b6211f3abf"],
  ["step-inherited-acceptance", "c995fe9943a2898b6f9405e2a427f3de3b61d198f6d7b9d2edf46f177ff4f0f9"],
  ["test-execution-claim-active", "03f1ff020067bf61c7b7a9d5eafa733280c87ed543db7ad60b35a1f9fd959ff4"],
  ["test-execution-claim-completed-pass", "35f8b7d639d27df70c71a8fa6ca5dd8b6566def00de6436c69bd8a72c7314d11"],
  ["test-execution-claim-completed-fail", "cd062085e9a3ef6faa7574e51ee02e411b5c8a47f62572a03fb773e664ecc899"],
  ["test-execution-claim-unknown-process-outcome-indeterminate", "4c046c97ba3a20072a6d8d3ad3683b07338586ed2eca6b71fbce59cf56bf7a9a"],
  ["test-execution-claim-unknown-authority-changed", "7bf43890ef2730f9a564d6e326bf94ad685e1cdd22f442fe3e65a19df75f66cf"],
  ["test-execution-claim-unknown-receipt-publication-indeterminate", "7891c097a81f751a63d4a0b22e355587e28ef38f99dda5a6bf6be6107f3ab625"],
  ["test-execution-receipt-pass", "af10a4bb1555afcb16e84a99dad77db4077b974fa96691c946a12a78d436118e"],
  ["test-execution-receipt-failed-nonzero-exit", "77902b7325c16ba6bd8be03f332ace59a1e9eb146311ec197e722366fe256bb1"],
  ["test-execution-receipt-failed-signal", "a1062a17a8fa090df073a67da2420c47c3310f2541777e8a14a0d98d10c51aeb"],
  ["test-execution-receipt-failed-launch-error", "d2bd3056c8c63416fd2f267ccf501e761ab6c5c2d2f1e0b153fd339cab88ca56"],
  ["test-execution-receipt-failed-timeout", "892f06549abd30822f2874d1bb273afc5ea38e489558ec4478f4d02fadd00d68"],
  ["test-execution-receipt-failed-output-limit", "6eca685723654ba1d6c4e8b2a3ba2b1a4dc56f65fbd4731e848823f76a07e727"],
  ["slice-pending", "8d4bbec759c17fb00ead204f403603e1185b430f21f0306f9bb240f7f79d4ec1"],
  ["slice-running", "9144cf9afff4ee300711b783015cb338985c1bee73e42b5596ba53ad89bf1a64"],
  ["slice-review", "ae319993929a22cc824eadcb09bf7abbf7a95d4e814e54d44e2dd6eed10a3721"],
  ["review-invariant-family-ledger-v1", "ca2a193d88c36c720308edba304dbedfd6676ad756964fbb6cb200b23d593a67"],
  ["verification-artifact-claim-active", "f6aed8c19510132eeddad5a88caaa16c4a76f98552b7881d23a9e3e11e80c4be"],
  ["verification-artifact-claim-completed-pass", "2a198a037257674186f2c8d4c05847c48c31a89ad94ecf262171dfcff0c8d445"],
  ["verification-artifact-claim-completed-fail", "4659fe531cdea256d13ab0339f812068a3d4ca364cb74e49a0f04eaa7f8df5e9"],
  ["verification-artifact-claim-unknown-process", "137fc780b5c84fb076685af1f1c276ff755fcf23066c0e2585e44ea0f58279ee"],
  ["verification-artifact-claim-unknown-receipt", "0c41cb718774c1bdad13e95fdcf76a6b0b43a1bc798ebfb7ffd3ca287154ae4d"],
  ["verification-artifact-execution-receipt-pass", "200fd4667caf5abf1834bac5d7519c8d0269fe84d49b5e9d53ef522cb34df06b"],
  ["verification-artifact-execution-receipt-fail", "6b58de4e0cd0cd95f137c6e78558a84033f413c631572a5ada0f2fb3e19fdc96"],
  ["slice-merged", "a92aff127c2a340e4a925fab9e0a083e0f54e664ca315c148d77ee7eb3da1a81"],
  ["slice-blocked-ordinary", "ace9300f4383ecf9b15556fb58345aa4c981b03ef2a62d436a2b29acbf97ef3c"],
  ["slice-blocked", "76bede870d7e85a8529c5191aa0405dacc2150bded0bab5411c654c004a8e336"],
  ["validator-verdict-binding", "ce1205fb84feece303f45e9841916d68fe26431d3117636aecc4b0cdccc79e14"],
  ["security-verdict-binding", "81cbb46158b44646aabf50e0152b80d5ed6dc423826337bf45fe6be7c24e5995"],
  ["steering-boundary", "efff0777e2943f002136ce1a38aad484c5d7ab7143e07eb5b93e2475c497ca55"],
  ["steering-action-claim", "9a94c1f05fec7cad1d2930995c464530088b99175c8430f336fe4f00a76d7384"],
  ["steering-last-action", "986caa05859db8fa98077f1d3e0b08340be3922854cb5cd33a95415fd5b250b4"],
  ["steering-pr-fence", "e21025a5e584db627db74d3c4b186de64f259bbe3711c22586c6b9a6db87f628"],
  ["pr-created-result", "3b863980fbc4b34d584f7ef02b57e5a16ca37858f2c8dc347addcdb02c8446a3"],
  ["continuation-v2-envelope", "5e79487bd2d9c06622c9a90ff9ccff117dec10d6b230a134ecec6e22dd49749e"],
  ["continuation-v2-parent-binding", "18a11882f7aa24ae43b9e95670109daf944aeb768083f2a7c5705dd5f517bf2c"],
  ["continuation-v2-selected-review", "b8028d2d4d70760fd558b010f437d07fccf07aed8839146019fa3f973a47e240"],
  ["continuation-v2-target-binding", "bdec8993e20104c0f36e11e412503d9903c044a2756f29d16942a4641e70ab2f"],
  ["continuation-v2-parent-artifact-sidecar", "dbeae202afdee1f48a1bb9cbbdfa727d9a0108c762b5c5d34553d6158ad77c86"],
  ["continuation-v2-parent-evidence-sidecar", "f7ca89d8ef6abb5295c9eee695df721c6268f7fb36b5210e05b2fd5c459d9cf4"],
  ["continuation-v2-parent-review-sidecar", "3b8e458cfdae3affcdfd5f2be8d6dc02fae1b3d2e58009360467e05860acbeb6"],
  ["continuation-v2-planning-reuse", "ba241b2710ea3088a54e9743029321a3b261bfbab719398ac84a3719eed34690"],
  ["post-pr-phase-disabled", "3759b74ccea805c737ff3e1ed51e0aac37ed8a41ef91046e98b455f3ef53381c"],
  ["post-pr-phase-awaiting-pr", "940393c6d7cef5b19f8c3d8c8915ab3d42962bec7bb1dc270fb9436d4f9ec139"],
  ["post-pr-phase-observing", "46ad44282906d504922581ea07d169dfbf409f4f5a4043a221480bad8c31a6da"],
  ["post-pr-phase-failure-recording", "ce62fb142d27f61c0bd5349c34d6cb6ce296631042d723c5016f348ec07e8a77"],
  ["post-pr-phase-remediation-planned", "41420ec34d679574ec8030d475af2558382e2299c7a21f03ca08e871f112aa06"],
  ["post-pr-phase-remediation-running", "f82004b088fd60e59ada70c53916299a8de31c2903f78002319df7c7ef282d74"],
  ["post-pr-phase-changes-observed", "90ad408d5236cf5d189c9ec62c0c575002f45471c7ce86a04eda2f8cafc405f9"],
  ["post-pr-phase-committed", "a3323edcb9895bc799f68873c68c2a4c219f6899c813ce94b303ce2eb97f4837"],
  ["post-pr-phase-revalidating", "bb6f14aebdd43671f2894d5e93698520cae5a936e3a8385f13dc45383279f473"],
  ["post-pr-phase-validated", "4be6a6d2914136e48bb73878e8d15293c05672eee3c5acacfc8632b5d30b035a"],
  ["post-pr-phase-push-pending", "c286baa3c63272f96b445c27764d8b0d7be33eb649889a5548029345e40fe7ca"],
  ["post-pr-phase-remote-confirmed", "c09af62c9947a5b441a8ccc989f481f5f73401a2cb03ae7a4706d7f7625aa802"],
  ["post-pr-phase-succeeded", "e0b6e19b620fe59a3a92cd909b83a52a2887e6978909d1b1e14f623488052339"],
  ["post-pr-phase-blocked", "6810ba0d65030de06f23373e0d547b351039c679cb10d131f497176254c78e6d"],
  ["post-pr-phase-needs-human", "6f70fa6e0c6edf2cc9837b5539f168581f0cee03ca043fac6774c7f1f471467d"],
  ["post-pr-policy-disabled", "bdcf6c56ed3a43cf56fefa085896758b3e7a6ffbdc27a14f7b9672596620db4c"],
  ["post-pr-policy-enabled", "b3524729fefa3c50664880b50b87702f4cf43a816750b0809b205e489796fe6d"],
  ["post-pr-observation-null", "1525259ef60080fbace643023ffbf600773bb1bb8f0c71e064c05dd154fd547d"],
  ["post-pr-observation-active", "d2b89469ea46432ca3f8bfcaabd7ccd89fd257995fbcb57bd307806fc285d024"],
  ["post-pr-observation-last-error", "86a079822e80f5a1237e430a66678cb4d917a08f1010b9849df25afc7c864a30"],
  ["post-pr-observation-review-request", "e29dbae9a8a7e7207fa41d2aa4e39b2360239800ce7744f8dd9951d30d80e919"],
  ["post-pr-observation-snapshot", "cca0f8f2a92e680b1ab3744b0d96d61900c424c4b71c6a85a50aa001d8b37fff"],
  ["post-pr-remediation-null", "94b4f5784f8cad86269dc0c40ca39db823f05d5dbb2eff6ef9369585fd16f273"],
  ["post-pr-remediation-active", "fb21c115d06e585f85b1e5cc0cd2542c0e525f4d2e8feb475ee779a11d9d8522"],
  ["post-pr-remediation-owner", "a88dc76de76b7c27e25cd4f85b1061953839efc60943779bdf5915409e37de78"],
  ["post-pr-remediation-changes", "fec2603740f35975dbbac06c9515f8d41265cbb779a341c23d8ca82d7d39a184"],
  ["post-pr-remediation-change-entry", "f5fa0ac940c8fcdedf9c3261a00707d5f3a176bfdcf04ddbb7e20e3af6edb788"],
  ["post-pr-dispatch-planned", "a60bf0e1736dcb38631e9991137dd861aaf636ef8ef7795d82eb144caea0b812"],
  ["post-pr-dispatch-running", "0dcd73fe68768f528f97bfed3063c16a7e64c757178add0318e49eca530c2b3a"],
  ["post-pr-dispatch-returned", "5764a701307d326ba78c1ce8ecf821d08f10b67ad5345b57a0c84fa3246d1a6e"],
  ["post-pr-revalidation-empty", "95ef3a3f7dcf0f15f72dede2b8e43316a43f7125cf3d21a91dab65eed83f0cab"],
  ["post-pr-revalidation-bound", "8deaae1885a60a4a25dff5c8951837c9b391794f3ffbe29559f11d0e7169c571"],
  ["post-pr-canonical-job-planned", "eece03f93b92bd884bf0e36d5c68c5c19be91d096eebfb94c1352eaf21291904"],
  ["post-pr-canonical-job-running", "79bd5467e0f5f863cca753efedfa5ef47f5920368331e1dee2ba821b44199a56"],
  ["post-pr-canonical-job-retry-wait", "df8f66a73013c6877941720d90e376099e430621bf9f04cb1c04da2aa64b7426"],
  ["post-pr-canonical-job-bound", "f46c064f2dde5a0e8247d843b1296cc1891ce20a8b47bb4910c936ef2b1bf51a"],
  ["post-pr-validator-job-planned", "eef1839ddcf0082bdee3e05f430cf123fa12de326b39806654df5fec91187895"],
  ["post-pr-validator-job-running", "d907d99904e0586ed8d69d230cba2196e7ae2fbbb9c419e3bc0afc418d435dba"],
  ["post-pr-validator-job-retry-wait", "45e34ad3caa6c7b3c00f35857a0050266c94697fa7637deb63c9c17707543140"],
  ["post-pr-validator-job-bound", "bc75732a7057402cf4870f804eb666a6b203b4602e7f295e5e8f1d8604ab267e"],
  ["post-pr-security-job-planned", "7d1f69a3df4a7575a80fe0e2c0e0fa9de3e2bb942323acd51b8b823a01ebbb40"],
  ["post-pr-security-job-running", "be287a9850ac588000b9002967453e3ad0314b78f81caf679a2d6e4941a28ecc"],
  ["post-pr-security-job-retry-wait", "6e9bb9c6c1a68b91dedb4d23c27327e183cf25ad37b7bc64283d8a0988ba7358"],
  ["post-pr-security-job-bound", "d14c3ca9c828246aa6c6f7d06a61a8c38cb1069287af8cee99f704a97ae5f9e9"],
  ["post-pr-push-not-ready", "df7d82c0cfa60daeb1fe4fc6ee8f2dd4073204e5ded8507435151f0cde1c9169"],
  ["post-pr-push-pending", "709c0f2a85622da906467766984a9e2d9b7f536ad0ded82be7090e61ffc0d7b6"],
  ["post-pr-push-confirmed", "be5d37302a22711c897139803ab92c438cae8b3b34c42e747081a5f4c512ffeb"],
  ["post-pr-push-last-error", "b12b75072715f0bc9dc16ad0a0c0b4c373f97546f90ddec29ee312e8875860c2"],
  ["post-pr-evidence-sidecar", "aeb6d9ae9ccb90b5a7205923656b2c4b54ea9b7d118f06b3a1f1fa0486945de1"],
  ["post-pr-continuation-review-null", "d006ed909f83741e76c871d9e1582da32e7ebe02f4d9ee50b034041d8e3d1f16"],
  ["post-pr-continuation-review-bound", "475465302fd2ea1ae169e8c257801db63bdb90dedd6456a4b44ae04d2ac72c37"],
  ["post-pr-terminal-fact-null", "795a09fbe4b13712febede689a85fc8b0ca0bce2c538126466a9d2553372d3b6"],
  ["post-pr-terminal-fact-account-switch-failed-github-auth", "2355ea6e114f1960bf030918b7689f466f0579c17c50307ef044fc8aa9a61851"],
  ["post-pr-terminal-fact-account-switch-failed-push", "0fca102c6296957faea76853a7ec1b015c29cd6c0628b9777ecbfafc8f19823e"],
  ["post-pr-terminal-fact-dispatch-start-unknown", "594a1346943fa4d30452ded1fd47f7260daf99172d2e7d40423c6dacc72061cd"],
  ["post-pr-terminal-fact-path-lane-violation", "a3505d03a61d5069da362ae08e3fba5bc3d19fd456e0bd7639b86c0d735c5465"],
  ["post-pr-terminal-fact-remote-head-diverged", "421baa6870c969cbf05dc76ffa13b7b108fdc9e1161a5f095dd10a4ed297f976"],
  ["post-pr-terminal-fact-panel-runner-result-malformed", "1b13f36bec4e54b12aff5730cd564a6911d0a17dc935d38b588380215316ee17"],
  ["post-pr-terminal-fact-push-failed", "ddc110607d329d5398fefba3120102128a3311a51788bfb4e7d8a9af04c2a19d"],
  ["post-pr-terminal-fact-panel-attribution-unsafe", "cf177ac488305d7daccaefa5cd1051cce2cfb7163c233cb1611b14bddcad9b42"],
  ...AMENDMENT_ORACLE_DIGESTS.map(([id, metadata]) => [id, metadata]),
  ["amendment-review-dispatch-claim", "917f82b7c79d76eec77d19e00021a16aaccd6a0990b157eb8c2439e0239a4b64"],
  ["amendment-review-dispatch-closure", "c1fa91187cea6bbb6c8b8d0684f5f81060c55c10b8b59f2480fcdf707f9be915"],
]);
const DURABLE_AUTHORITY_METADATA_BY_ID = new Map(DURABLE_AUTHORITY_METADATA_MANIFEST);

// Independently authored exact-value snapshots over each descriptor's complete targets and
// exclusions. The hash input is canonical JSON for { targets, exclusions }; it binds target
// order and every family, path, value, from, to, key, sidecar, and label without reading RECORDS.
export const DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST = deepFreeze([
  ["plan-slices-json", "3c923442fe75f188546037455e61dca6f3172bb766399c4df4289de2f1c6f726"],
  ["plan-v2-integration-gate", "c6c3afe58c9e60a6c90093bffb3c284453ccd614d460f078dff391748a08b057"],
  ["plan-delivery-envelope-v1", "3c384a1faac474c9554319fc8216e5837a589d5071430f67cd67980a6f1bab89"],
  ["checkpoint-reviewed-plan-v1", "16eb4fee5a6119610b28a0a71ed6cde61f69313b44790d39d8746d80b3019d59"],
  ["checkpoint-admission-probe-valid", "c41b53ab83ab80e23207d16132faeb42236d36dc8b93dafcce56f72b7d747b92"],
  ["checkpoint-child-disposition-v1", "a6c3075415039564e47fc96926b6b63c33024990c4721f4ee51b99518de270f6"],
  ["checkpoint-routing-artifact-v1", "0ae8734ab0b4101cb43d7167b9c2aac993f151be11a736d8c7d983c323ed726d"],
  ["checkpoint-child-publication-v1", "3e12594c7fff0b8493b0586bb2f600f05bc2059f7cccda4abbbb4dfd0e730836"],
  ["checkpoint-source-v1", "52cc4c2f23402c8cd2c601a73c62b3a1742a1ed3bf3e06ebfbde815fd115b288"],
  ["checkpoint-progress-reserved", "72ff624bcc7563046947b5fe11eb6974c0e8705662b92a1e6db296d34d20a733"],
  ["checkpoint-progress-child-published", "106702033c0c1eb30bb7fd19a8c6814d39d2f393e53fbe4acfac9aab94a0dc31"],
  ["checkpoint-progress-launched", "88043ad23cc0f1e0279588e0507c2bc33f462d9da353d7c27d2870aba4107ac9"],
  ["checkpoint-progress-merged", "ece5b3d6f99cb09664ba3513b8b62b7b24c1146ead539a1e8cdbf13a98c84f06"],
  ["checkpoint-progress-closed", "47d1977574cae01d98431f99620e9e1fdf0f9c29522580dc4ab39360efb52061"],
  ["checkpoint-merged-completion-v1", "43746c9122a72b0e86a8253f9ce13f935b1c76082ffc5d469e958f07595d0eca"],
  ["checkpoint-final-closure-v1", "2476c74a5e8a883159faf9eed4d8dbf97e4fa8aac592feb7174af8ab4af1f549"],
  ["final-plan-descriptor", "b8ef8dbfe1f1e54cae98fb0960aa315fe4479e33533b63d0a9e0b88f0df959da"],
  ["run-envelope-running", "0dfdf9c52ba1ee909070da85617630bbb0cac990f109bdc3c7f25c4f686276dd"],
  ["run-envelope-terminal", "7e1272e9374eb193833d700f54b15b5453e92a8475a8f942c72f6f64ca5645cd"],
  ["terminal-result-completed", "8156685012bdcf0072fc38331dd34c2ee2f0ac59c94d14418a0cadc3f92b84be"],
  ["terminal-result-blocked", "9e2aac2293e6a2aa0ff69725ec484565d1ba598e4f921be01c44267eaab6d231"],
  ["terminal-result-blocked-checkpoint-routing", "2c8c39a212248223cbc907dac170f95ab50fdd34afa8a867f25fe1e3bc2fff89"],
  ["terminal-result-blocked-nonconvergence", "ced0d4f02aac844c1b226f371cd76f04ba4e616179c7ada1105d5f6c63fde7ab"],
  ["terminal-result-partial", "c7c56d99562df246e6e5219fb7ca002924103fea7be86bc2cab1b8c04eada6f6"],
  ["terminal-result-needs-human", "f10e0e1b566924c9b223e63b30426d6004b3210b0be12d884c63ec42310af5b9"],
  ["gate-pending", "9af58fac48dd996f8f66431b251cae4ec56e5ed1bdd956a903beb70de3ab504e"],
  ["gate-approved-without-receipt", "dbd4468f8168a3bb46d3bbf3d91e837410a494b40c5f477f3b16cc1e2494310b"],
  ["gate-approved-interactive", "9997569b182ad0d650977ec8165e396ad6cc4ca061ff640377b1b25ee19482cf"],
  ["gate-changes-requested", "369718efac910615a0bfabf7fcc9da2215c5a8975d7335e4f8c52f56302abaa3"],
  ["gate-stopped", "769caedbc61f6e3f7ec161df1f00f05adf0988a4a4b2970a14697e4d8c6516e5"],
  ["step-running", "d81cad11e94cf0a75dea629f6fbccf0f50eba87aaea3ebe0c5fd69351f64a64c"],
  ["step-rejected", "a61fead311954856883b3876e50c14e41256951a84fb5550bd2184e3712753fa"],
  ["step-blocked", "68ee4697dcb1a92d8ba39e32d9091eeeb0e74c03818da5cf53ca8c2bf25c3f43"],
  ["step-accepted", "738ac9fd074c33be9c9aefa66abc6de1a4880b244d7625960f3e6febffaf0e94"],
  ["step-work-decomposer-accepted-plan", "cbe47dca87af01e53b5a9897f3640d1e63b33ea38301f066b1895973a30e593d"],
  ["step-inherited-acceptance", "1eb12c653d87652e1fd82b8bc0f7fa40810fb892616ee3327cbfeea3b32ca531"],
  ["test-execution-claim-active", "e55cad41c016c8dee103465c0edbd8d0420c5be200b7469a0c487eb584cd1998"],
  ["test-execution-claim-completed-pass", "6300c1839365a0e71a880ef8600632b6d3b451e9f2198d3fc6f6847f57860e98"],
  ["test-execution-claim-completed-fail", "b692a52e9978c8081ce71eb32c292aa8cf1c2b2084b48732cae8767265155d74"],
  ["test-execution-claim-unknown-process-outcome-indeterminate", "b1f923be4789d44f8499ab7e8582ed1b1851c8003c66f7aa1e758b16c0d36766"],
  ["test-execution-claim-unknown-authority-changed", "315a0338114bf60c9ca237fcb2813f393bd9d2a8f16d5ef50e3bac684f1549e6"],
  ["test-execution-claim-unknown-receipt-publication-indeterminate", "0590889d9899011ce0b033b9b6b6beb905cf6e6c25ed990a3a5bf748de7946d5"],
  ["test-execution-receipt-pass", "62c1cf9a8dd6280fb852f0bf59e8998879b93f2867ff74664bd4060b6161b253"],
  ["test-execution-receipt-failed-nonzero-exit", "4a155144f55284460d7a4a1ad152e2f1ec7d654e6818f5d09413f76fa33cb06e"],
  ["test-execution-receipt-failed-signal", "ef1b84677a9f39273f2cfed12f764ab655824dcefc02896e93b082bbd37261eb"],
  ["test-execution-receipt-failed-launch-error", "98fb5aed768d553eb1cf4aba84b389bab19adc6631c0ed699296b23449a53d5c"],
  ["test-execution-receipt-failed-timeout", "3458081e9dd7f4e65d1ed6e2f5002ab07906a675f2fdff2bfac16b0fcdc50dc2"],
  ["test-execution-receipt-failed-output-limit", "833673e91272686dedee1555e3e9d2a66961789abeec53f6a0ed4e21edd8af0a"],
  ["slice-pending", "63b63efe898da669ae80a855536c52a7f00a0009a0465a2ec6cee66477b11f50"],
  ["slice-running", "fc42986c22298a35eab703ba8490a9607de4e6a1a1b40259ed8f8ed67f38bb6c"],
  ["slice-review", "9f3c77e866b5987bfa102140e14c09abda335b82886e293384bcddefabe2af88"],
  ["review-invariant-family-ledger-v1", "c63d47a42fc7e6f72beb10013c9c9fbb6c3288c94961d93a2962838d11bffe7b"],
  ["verification-artifact-claim-active", "60aaf5b848a66868519f120fab8e83d5990cab5726f103a854307ee98f078cee"],
  ["verification-artifact-claim-completed-pass", "9585e7070cd5fa8cdfa8fd9871712e07e565bfe5d7184d7f11daab6f6205dc1e"],
  ["verification-artifact-claim-completed-fail", "57b032d4469cd36667914e85ef11d7ebe9a2612338384837f361bcd171205b93"],
  ["verification-artifact-claim-unknown-process", "eb66f9bdd20d89a62fc8a693d07c757946cfb4a507097c8884680136f4a6cb71"],
  ["verification-artifact-claim-unknown-receipt", "fce93003046e6c21ea94d49608c5ce36a0dd0261925eefd0967c5fba98391308"],
  ["verification-artifact-execution-receipt-pass", "3592c402f76224b6e1ade0ea031ffc416c54fe0e51799fb6d665b8e87383d9b3"],
  ["verification-artifact-execution-receipt-fail", "dbe35f24ab47a987945bb95469133d29376e795cf9490cfdb95f016eac95381c"],
  ["slice-merged", "87e840a2ecb570c87c604c7f5fa24e06568905ded5e03e964639dd61b5f1e579"],
  ["slice-blocked-ordinary", "31e9a613be88e8b2821d1bd88a6d82bf6884a3001074c807175eb91e2988a1f1"],
  ["slice-blocked", "745738f57c24027e1a41fbf0a2e5c85a1a743ccee174797496ff5a08b5b15d4b"],
  ["validator-verdict-binding", "d5663f22b888f878625141430a2602863730f8ab122a815359dd545d876b49cb"],
  ["security-verdict-binding", "88c89ebb14e5f14121dc022da8f0c73dc1e5e9639d570337edcfb09cef5c17d7"],
  ["steering-boundary", "7842e29ee7d10b4465db99127739e4b602479aff47b848a5c7bb9d2e30ecf732"],
  ["steering-action-claim", "0acedda0cd1d2cf887d58482c179d90183e43650546d3e919b5f5cee92627b4f"],
  ["steering-last-action", "8d42d520ec811dad436e84cdc48b7ae6d2f13a442fdef2ba6397b13bdea16e67"],
  ["steering-pr-fence", "aae0a3986f100717159038cc2b06cfd835b1313305e22fc7beeea4929db3d662"],
  ["pr-created-result", "6b510aefac2fe46ad7ea3679ab0b023eda0ad0702139fdcfe62176b0404272bc"],
  ["continuation-v2-envelope", "f598a72021464f9139b6de89f662842d549dbb65f4762a89cecb0839eebd9050"],
  ["continuation-v2-parent-binding", "8d2150f32d7d9b2239214c01af0530f5b2e6a52e5745a894217567c1f7ebca6d"],
  ["continuation-v2-selected-review", "eb780a0d4d1a434210ed51b242eaa161f57f33008b08b608bfe4f835d6b1d212"],
  ["continuation-v2-target-binding", "6decadf8c34f411a91d67f783fb7ff2951aee77d93161830bfc3b794f87a4ee9"],
  ["continuation-v2-parent-artifact-sidecar", "ef0463f78e00df72afb713b47ab16c65bf3f6d5fb4b3b358339328e3206704fb"],
  ["continuation-v2-parent-evidence-sidecar", "4969be8ad436e902b16853b9d6f3864ea22916efd11783f2349533bc784c842d"],
  ["continuation-v2-parent-review-sidecar", "de01c8595fbb8e27bb68da4edff8c61168f6c7d7eac0eb4b1007151c0528d983"],
  ["continuation-v2-planning-reuse", "98eb221b379b4e1ad90e001922d4776d967d9d1b13ccd504b881566d4ba19134"],
  ["post-pr-phase-disabled", "513971086c59d58641e60d94eafbcd2bf14874ba9c6ccfc647232b41b7b07e34"],
  ["post-pr-phase-awaiting-pr", "bf1c21e663f13eb7e6a1be999f3909712e1c40b510ec6116c98d0cd01dc8e130"],
  ["post-pr-phase-observing", "e6a25d74454166eb044c588a5a59a3a711c1232821b9a06d7cdf26e7f098c8ce"],
  ["post-pr-phase-failure-recording", "069fdc97c5857cb5f2db059b088a26c093745a7e57f97a2d205ff0bf602525f5"],
  ["post-pr-phase-remediation-planned", "e206193f01349bd009a9a3d0e7369fda199d609bafe325dea0db0290c6e9a401"],
  ["post-pr-phase-remediation-running", "754e04090cdda9c8cc099bc794c6154534fcfd616187e9633ac3cc739fbaac2c"],
  ["post-pr-phase-changes-observed", "9d80b5b8b25d47dc7d46f2ac7983144c7711a747e272e2f1986f241bb1835f54"],
  ["post-pr-phase-committed", "fc72621784b1f2eda40ce0342e22dced9e226ecb4b87020d726a82a58d3841d8"],
  ["post-pr-phase-revalidating", "6962c268ba0df5134784df560b878ae815256daf256559857491e57b67bb9102"],
  ["post-pr-phase-validated", "ac9e6baa4b46a5b5ae05160743536d16dde031abdca85798bdf406b00f8fd113"],
  ["post-pr-phase-push-pending", "b26b83e2b19fa8c6ffd9c496a34856becb40f26e41c9cd50fc345a79a2a68ee9"],
  ["post-pr-phase-remote-confirmed", "dc10ad2e1d72bac8d56e14f412700b307395787bb25f4e2e28215cccf66cf9eb"],
  ["post-pr-phase-succeeded", "f85af2b48c0926e215e4e52aa8ffd21c73009f3b83e3b58fa35ed98a1355a3f8"],
  ["post-pr-phase-blocked", "cb252153402eb377af2749e935a7c2fa95c5e38d2caa5320c2c0d5399d8679e1"],
  ["post-pr-phase-needs-human", "7cbad4902c5adc539c29f71d39d45bf7544e5d7fb0d670e46b750599a11caf5e"],
  ["post-pr-policy-disabled", "8a44a31fbc1cd4b8b51040c52bbdcd561d6e6012b84f8bea93f29cfc748a5384"],
  ["post-pr-policy-enabled", "f2515d3cfb5915970b533c2196a3c701babd1c43ddbf1b639540b33c98f25d7d"],
  ["post-pr-observation-null", "e228b8ad83fe3fc1b865ba26c489f923c30750b790ed386decdbbcdd0f7f5a7a"],
  ["post-pr-observation-active", "e0f334f36636f4c4cd7fdfeef2e7de13a92c714272ca227205df487810ad7c54"],
  ["post-pr-observation-last-error", "732e1bb8f0c5dc307f0415288bd6c599681043994a26fe3a152d870c413a9af9"],
  ["post-pr-observation-review-request", "56615c1ed43d8357ceefc407b96b3a3458743c480e5bd650919528f99c0e64ed"],
  ["post-pr-observation-snapshot", "4d184a362df7a52c9c49a94419ace41595b7c2272d403298ead7643e2f019186"],
  ["post-pr-remediation-null", "b11b44e67fedeadb2f7ecd4d591f05ce615eaea5b2622950ae35a82b29cadb5e"],
  ["post-pr-remediation-active", "87701ff8ce97e141b1ed1467941692a018b04659f607f3064dfa20f395e796ce"],
  ["post-pr-remediation-owner", "d0de8ce88fb6d4fd46f561423ec15cbbd9c0d9f673d978803d181cb48f4e62ca"],
  ["post-pr-remediation-changes", "5a29d8918015f6e1684ff8081d320c440479fb9fd4f96b2f8799d3099de638d8"],
  ["post-pr-remediation-change-entry", "c696de34634555c76db0c6a4818cba73e5cff137a1dc784ec5df4c599b5fb76a"],
  ["post-pr-dispatch-planned", "a71360216563456d2dad79c83a7018800b98727041b342e48ad81d69c7fccea7"],
  ["post-pr-dispatch-running", "3eab951f904a67218716f18047cbe976ef336b7f6e6488a578a5e6e91f4fe147"],
  ["post-pr-dispatch-returned", "2ffb3a5e416345718902ea9e864391547b0797c16646efe4d161cc5f32f6f70d"],
  ["post-pr-revalidation-empty", "302761cb949ccc43da4f9a602a7ebd091df624097011bb7958cfdeab319a80bc"],
  ["post-pr-revalidation-bound", "672206703515df26227f80dccc394bfbb027bfca14447c098ed2e50e1ee488b8"],
  ["post-pr-canonical-job-planned", "da66b9a24dce3d5f39dba7de43567244ce98a2e236700026c427a5a9db0a1354"],
  ["post-pr-canonical-job-running", "fc33c41aa3ce0fa4df42af7b33405415564d453763d5c9bc07654d90f4444c3e"],
  ["post-pr-canonical-job-retry-wait", "bd1c9e9194488a16122331b2f0342cf3d2fa1ba620e2cab0590f948d44247dd2"],
  ["post-pr-canonical-job-bound", "48368ad3fd81ae80bf9b38a30ff472714e8cbd153c56172bf4857ceb025dc43a"],
  ["post-pr-validator-job-planned", "6aba7c2d5508fb1721e07710ffe5cdb7a586913be912fbb13ff605d0eac496ed"],
  ["post-pr-validator-job-running", "1ab84f8d6b675ccb12ec6f266acd8710da74d8a1d10d596b963fd73393798d77"],
  ["post-pr-validator-job-retry-wait", "d05820c27e6c8f10a25e8818264da10b325c744eecbbc8dbd9870310fcfc2929"],
  ["post-pr-validator-job-bound", "2cba87b9d3d6febef3a1c7dbbd0a2b590dd8276c7e9ea320ac6f173cc5a0e727"],
  ["post-pr-security-job-planned", "0fcf0e6d48e81333d73cb908394382890af9bdd43120e5f9981d00450fee1b1e"],
  ["post-pr-security-job-running", "3a90f0cb1692ba8141b175585f345ac12406b1852de6aa1c35ce30ad1009beaa"],
  ["post-pr-security-job-retry-wait", "7d3734ebd954bbc2acad5a1ac1a7a50206586fca10f990fe6a13edd5f606c2f1"],
  ["post-pr-security-job-bound", "3fe923e72f62dd9e248d09f868192676e246b0d274d741010d19de1aa74a7b8e"],
  ["post-pr-push-not-ready", "75e6634266a30cf17b0cd021da9d1dc92ae1abb169b1a55a9df946bf4be56952"],
  ["post-pr-push-pending", "ac97e631f9618c582a1b55b07229967e2531d271c8516065435155dba49123f9"],
  ["post-pr-push-confirmed", "70a523f94e9711765f33721aaeeb93603f6cf3b600fd28a49a3edd4f841f7b7c"],
  ["post-pr-push-last-error", "2488926b85aac8d01c8efabf743d157b64c52d9f5f511885ba895352389c30c8"],
  ["post-pr-evidence-sidecar", "18bc62ed278dde02fa8482b4b575a1618ceeec907fd2f3efe734efad99525491"],
  ["post-pr-continuation-review-null", "35902cbb67570dbe26041495dc70aaec1708cb379d9a4966dd792f94e14361cc"],
  ["post-pr-continuation-review-bound", "e5862dc1dc6c055b87640208c9cbf2634e28c705b0dd24a36ca4730349df64f4"],
  ["post-pr-terminal-fact-null", "2e779339034eec52db0602b42534a7097eaa4e908313d3648f3c71ce7add196f"],
  ["post-pr-terminal-fact-account-switch-failed-github-auth", "89db42abf207f47db3f5f2dcc28cb1f61ade51b7679e3e5b0be805d6d7b94436"],
  ["post-pr-terminal-fact-account-switch-failed-push", "a8a67f1c8e774c621d92c8a4e69bdbcd3b9cacb06da840cd55d0593e956bfa1a"],
  ["post-pr-terminal-fact-dispatch-start-unknown", "7a2d731df3167d87dec0923f1316a9ab4b0b4a919d31bf5344e09a7fecb4dee4"],
  ["post-pr-terminal-fact-path-lane-violation", "500e294346fe7f0d09dab8503578549c5bf1cb8deafd9e74102d5a9db690c20f"],
  ["post-pr-terminal-fact-remote-head-diverged", "7fe532840107a81679fc124cdde6e499aaf4e02313b791d6a44189eb5ce77432"],
  ["post-pr-terminal-fact-panel-runner-result-malformed", "78c5bc14d1c19f8bd3b449d2ba59160173d05698cbc61a6fab5f2b3e76e1ac2a"],
  ["post-pr-terminal-fact-push-failed", "2d49a423c4c8a2f70c1af4f3d598afdf6f22fad34df57b5cc323d4ac01c49511"],
  ["post-pr-terminal-fact-panel-attribution-unsafe", "7681ab4e932991797750ed39c61569748ed8690a291f27f6f0a4f91a5cd65844"],
  ...AMENDMENT_ORACLE_DIGESTS.map(([id, , descriptor]) => [id, descriptor]),
  ["amendment-review-dispatch-claim", "b6fb871bb80fe23f8810e53c2a1a3053a1537d3d138f9d0dffb2e1f2875bfb7a"],
  ["amendment-review-dispatch-closure", "3eea5e9b4d020f60782edced5bab1e92c1130f5b5022e77d646f61aa7a8f0cda"],
]);
const DURABLE_AUTHORITY_DESCRIPTOR_BY_ID = new Map(DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST);

const CANONICAL_SOURCE_RECORD_IDS = Object.freeze(Object.values(DURABLE_AUTHORITY_REQUIRED_RECORD_IDS).flat());
const CANONICAL_SOURCE_RECORD_ID_SET = new Set(CANONICAL_SOURCE_RECORD_IDS);

// Independently authored exact-value commitments over class/id placement, persisted
// record/variant labels, canonical run path, exact persisted source shape, authority
// fact declarations, and separately modeled external source bytes. These digests are
// literals rather than values derived from RECORDS or DURABLE_AUTHORITY_CATALOG.
export const DURABLE_AUTHORITY_CANONICAL_SOURCE_MANIFEST = deepFreeze([
  ["plan-slices-json", "16896892b7010ddf41ba8d8fbdd72564e1ad5f98724ff60de6d2adb75aa11988"],
  ["plan-v2-integration-gate", "591e877c46d2bceb598775cf19e83f49379c62e3911291f33bf5899c8b595fad"],
  ["plan-delivery-envelope-v1", "1d8ee7be00fedfa973646ad465831a398db446e378bd6f577546a1484348dafc"],
  ["checkpoint-reviewed-plan-v1", "bf3611b6140afc7cf630e77e597bcf492a1841baa5d501742c7dc276fc0b633f"],
  ["checkpoint-admission-probe-valid", "97c9cf73e95e6fd79292d64e53d84c322f56ee91ebaa11e22e67b2cedec73f75"],
  ["checkpoint-child-disposition-v1", "e0e10e98fd221f35b2d0968163246c4679561a4ded649fa73b3bda634b8517dc"],
  ["checkpoint-routing-artifact-v1", "3ad5bbbacacb5391b981893b855a889c8a7753c6c74972599a14249b1d7655d4"],
  ["checkpoint-child-publication-v1", "365e44c9f0cf6ddf248f4faaded679a2b3b14cb98c6a8f92620f822cafb42870"],
  ["checkpoint-source-v1", "0d46fa0bb014fa11e95e18c498cb8b5554dcda3aaa38d25e4064836ffacba196"],
  ["checkpoint-progress-reserved", "66cdb52efdb2a09d707d2f34c7befbbf3be5f14de27c0c6c133b632291617c81"],
  ["checkpoint-progress-child-published", "1492fa66df9d1bc0af5f36af5b31d8ea44df590299fb17c5e32e492cc4979dfb"],
  ["checkpoint-progress-launched", "42caa2718a7fc6a385fd919a040008fd85f1e0366d135444c90308a4ecd613e2"],
  ["checkpoint-progress-merged", "f2203f808a00da62a6e248d67753e4b2b26d237de2dbcad7ac3bec3ccf8c30c2"],
  ["checkpoint-progress-closed", "50529713d8c192fcd1df1d08967893879e9a176430e70dbb0af58b4a119df321"],
  ["checkpoint-merged-completion-v1", "d53c1705f8e93992d8d16533ee57e80bdbf2a2df730a06550668a92fc2efac7b"],
  ["checkpoint-final-closure-v1", "6a931bdf49c42feab51f0ae1a671ff88b08c1ce21d68012e60f17ada96d46292"],
  ["final-plan-descriptor", "56fbcdaf9dd4e9b243535c46ef7725bbe9ed783dafff96fcdafe03f077f863a5"],
  ["run-envelope-running", "f98a34215fdd5d0b2c4861bab4c6e6be104439e358a8e737095618955f227594"],
  ["run-envelope-terminal", "0e8365b1d3e99b2db1038cf9a2939fc6f4c421f199236307a1e1f4c300260e04"],
  ["terminal-result-completed", "67cc3ac4f4bc522a7e48be30ea4b1cdfcba2016a309ba99224197641cfcb059e"],
  ["terminal-result-blocked", "2e50300aa3e14e8fd6c935f3dae3fa44dd388c6ff386091ecbc28109f82ad855"],
  ["terminal-result-blocked-checkpoint-routing", "a1c5882e705ada277f6703c4186686e182dd57334c467579fe64b30ab7493a6c"],
  ["terminal-result-blocked-nonconvergence", "d103c2ca471cda13f1f010cb5ef51ad15ebb12960e8776b62fc9b3568b123f31"],
  ["terminal-result-partial", "b5808744bc1ae0146a9a59e9814be3d58712a04c0cfbaf6f5d1858ab698c7746"],
  ["terminal-result-needs-human", "4c5aee988d94853ac78432435d4b65f7ebe8720dfa0652b6c9eeb8ee30bd0581"],
  ["gate-pending", "802c580efe10eaa5728775d05bb1f088c4831455b3763763b9daf3885c6442f4"],
  ["gate-approved-without-receipt", "9df0792243e07d8ee3ce2efb420e688522e78d645350806a54399294f810113d"],
  ["gate-approved-interactive", "d02715d4e0cf1db63f2cdbfae3770c0e959dfb48f6c14658bc9f43e6c99b5911"],
  ["gate-changes-requested", "d96271b80dceff6d730fca729958c56189052861e62eea50b98cb975cad4de55"],
  ["gate-stopped", "c48d58bed8be553eb2d48eac7ea40a38a002b98d2e62602721be8e6df5ba43a9"],
  ["step-running", "f856e67b5458b8b653194fcc014513e748eccc868d2c9e7d815a905d0373d846"],
  ["step-rejected", "4012aaf36e583d5636a126cdc40a36ddc3fabf32e1a150503dd6ee62d317fd87"],
  ["step-blocked", "8d9ce53c44e2bccca8b3555f4906bedf95fc91de76ee37fd886d47ad64942ad6"],
  ["step-accepted", "29ad392882b94a0bc78a5b0bac4df748cae19d80965e6a0c62cc758df8fd89c0"],
  ["step-work-decomposer-accepted-plan", "ce12b1322982e48e6eaaca8c6883de11771bf94f6250b515bd237520c574b3bf"],
  ["step-inherited-acceptance", "ba9a7a06a122aa68917e10675cf6b2ec97eab054ab7f40353904ef16ef226657"],
  ["test-execution-claim-active", "d4a4d2bb577573da8940bf2a2d76157cf36d9519dd5cef85e5dbe4312a252969"],
  ["test-execution-claim-completed-pass", "d5d7cc2956e521212b5d9f3bf452684ebea1c1ddbcce56cfbb9baa789af3cf96"],
  ["test-execution-claim-completed-fail", "1b1f3f27c3ee12cc66f312a394075fbe9488d39f7221518ea79e3583dc8e7308"],
  ["test-execution-claim-unknown-process-outcome-indeterminate", "7c24ac0448dce935ccb7a6861738a16c0a14661a27a0601db4580661b9863c96"],
  ["test-execution-claim-unknown-authority-changed", "2da0ca8cbea018f74abb0a794a8bddfb28e77f7a1c0db5e25ce498608cd05704"],
  ["test-execution-claim-unknown-receipt-publication-indeterminate", "b0072954c0f3939c2d696eee6e71a5ac37387fc5c7ed4a3a79733cca5d5b380b"],
  ["test-execution-receipt-pass", "dd7438d18b5391af5f938d6f0aae45c17b307badca132acc2bda5abae6df1ce1"],
  ["test-execution-receipt-failed-nonzero-exit", "f1c96dedd17251a4d275d183eb598bc2665718bf4b72e447b927c62858342131"],
  ["test-execution-receipt-failed-signal", "ded1cb25e9a2e20360a1e80904a9d0e1a07726eadcc3cd5a97b5dce80e3c53cf"],
  ["test-execution-receipt-failed-launch-error", "7d91074f027be0361cdaa2fb7eb1850209b2837504225a30b968363ee36fe8b1"],
  ["test-execution-receipt-failed-timeout", "5d5a2975e970c83e77b746e50ee1899859e4ebdbb07139a1b8798d015012ca36"],
  ["test-execution-receipt-failed-output-limit", "9e7b99607828b8f8cbcf232b0187ded202f9fd921fbae90570269b8ed2dc0cb5"],
  ["slice-pending", "0f66b96672a90c960a5cff760325c7e63a9a69dd95f19207406de97959afa113"],
  ["slice-running", "ccf77d9effc8e1ea2f3e668ea0c2f323c875fb14dfbafc120fb65d5c956c5d4c"],
  ["slice-review", "e2b04184fee064abab12827bd7ed2f9cacc80b671fef9524aaf1533fc6e69836"],
  ["review-invariant-family-ledger-v1", "e993b49518a7d4f09c4a2c184bac1e0f4c84b328c4c5bfba8065bb9b70638d6e"],
  ["verification-artifact-claim-active", "2b4306b4a2b4387e4e8dc21ba0bb15dd37e9b9f553e7d7996b6f25f6ef20acb9"],
  ["verification-artifact-claim-completed-pass", "44d8055df0345a58e5f7eec046056d68777b4436e0e560a4582f3bd4c7826ccd"],
  ["verification-artifact-claim-completed-fail", "a250c413b159258a9ade113785f31c1aa3b6fc4a3a8542505f1a01e920646847"],
  ["verification-artifact-claim-unknown-process", "9d1b79e18930322098dd9bf3a897f4ee65c052e3165dad7ae63ec1771b5a1d68"],
  ["verification-artifact-claim-unknown-receipt", "c4ce80613e0578cc441f71323ba623c0a4843337a82331acffd0a5f524224a52"],
  ["verification-artifact-execution-receipt-pass", "d355271db1673dff3195be1a69a7d0736a03d2247bfd325c32d1d83a0eafcfff"],
  ["verification-artifact-execution-receipt-fail", "4e888bca89482b6a20f9f88c15e827ec315e840997bfb5ca0446852b2b40dda8"],
  ["slice-merged", "071d7624f6ac5d954ba74d403a795c16055c0b454dbf7f67728753e7e58075b4"],
  ["slice-blocked-ordinary", "a194a4b95b518a9135d4726277520e3baa5c8399ccd408eb991fac2d515839cd"],
  ["slice-blocked", "ba543529dac064e1f63239efbc8a2d4f168246b0f56a1d337def9b1f5204f90d"],
  ["validator-verdict-binding", "22c22e8e118609a58e29101a6f6a89dacc8ddfddcc92974c810fe4b51cc5fdc9"],
  ["security-verdict-binding", "56e34d4427dc76cb46caee5a002856e4e97ef2dc870543fc489a750e384e6d99"],
  ["steering-boundary", "b3477a6967254d04f869b97b8d15d00ddb952673f00807ebec41f05afdbdacfc"],
  ["steering-action-claim", "00866d18d439d808d2829e6d0967675629175bf8c1f00bec2130fa2728b30a21"],
  ["steering-last-action", "4fc3088a51000b12aed4ca3216c8e60b74c5206d8d9e75e4dea319cb31c62820"],
  ["steering-pr-fence", "16fa47900dbcbd6618a6ebd0eed5cb705910a2ccfc8478bd1f554c7f8ebef406"],
  ["pr-created-result", "619a77468645eec8923dec7f7e3c8b0d1aa11064aac4494e039b7aa282e6f9ea"],
  ["continuation-v2-envelope", "99eecc5216b6ed35f44f94f57503f363cfb182805a6e9965aa65b15dc1565e5d"],
  ["continuation-v2-parent-binding", "de3f7db2b2af1afb9e6bf8ff5a573bfb1c553748461c1aa4f82a04ca0ba49393"],
  ["continuation-v2-selected-review", "e6f8787a792ce2db73e657e60574eadffcb5629675af1a09622a5d5102542139"],
  ["continuation-v2-target-binding", "aa90a1ba18fd3f672cd485134887efe2b28e23ec76167af8e41c1cb53debcda2"],
  ["continuation-v2-parent-artifact-sidecar", "0a1d55178089fc305f9841ed49962ec7c0047d62d9f9f3f655663e3127c8b5d6"],
  ["continuation-v2-parent-evidence-sidecar", "780e1d52985780f26912602a93657120529e11587d7068c5f4cf172121c387ed"],
  ["continuation-v2-parent-review-sidecar", "d59e5ba3bb367947afe511e0ad7a4ddb6988e95be324907cdc4e34487ae9a4ff"],
  ["continuation-v2-planning-reuse", "db49c73b2044271f0c1bf18fb8c36811622258d38d1a559460387dd03e48f798"],
  ["post-pr-phase-disabled", "4898a84d6f95e1a649122eadba90daab5786164dcbe11b6accbbe04b17b91a07"],
  ["post-pr-phase-awaiting-pr", "cf30eab403b52bdaf1e3e54c2ce0ab4bc24e7bd70d6f07ad2372a57647497fed"],
  ["post-pr-phase-observing", "5338e2ad9975937758224fdf86e9abe6ef7c7c5caf12fb2b59871fab4e6fd0b1"],
  ["post-pr-phase-failure-recording", "ef5b03ce1abb67a02bd7493e7ad5e964da09a6b26326b6d27ec8a04bda5088e1"],
  ["post-pr-phase-remediation-planned", "816bab2a078623e6a8d39fbb41176fbd11c357f46c5aac421636dd1d20d33d6f"],
  ["post-pr-phase-remediation-running", "0cfb6a7260f9926803f4c3f3f9d96e9a6e5526dc4d6d7ea7b2c11f04b123847f"],
  ["post-pr-phase-changes-observed", "1b7bcf42457346eb32da7c6b7545cc102e4ea45d902d6b14fc97234f2584a4dc"],
  ["post-pr-phase-committed", "bc466d11d309732d3cb979d960335acad3e1f6b7d9a0776511c28e08985f3def"],
  ["post-pr-phase-revalidating", "d8b055416763c9261bdecd322435b44d9a4aad475a6c50d5c5f83b5454eea09b"],
  ["post-pr-phase-validated", "7cd547f3fbb088c7db8b97e588e512e6b7a1287b8e8edd1a09117e41acc8d64a"],
  ["post-pr-phase-push-pending", "d7fd7fd0b1f98c7af6df04743983cbc6ed71cac4c745e140ad9593327c6f87bb"],
  ["post-pr-phase-remote-confirmed", "7965e94274f632d5f60920e0af0438271a4fe9d0d5f6bf75514d8d5e52f0ebf5"],
  ["post-pr-phase-succeeded", "a27c6ea8f6ad9b5b698a6e9247d8cfd3890eebd6d3ce967068e56242a7bd6ec9"],
  ["post-pr-phase-blocked", "b2414b57f1b6b7b6b0d749f4df4649e0f15d56c421b07c260456ca4d3fd790d5"],
  ["post-pr-phase-needs-human", "26a4bc9cd330e9462ddd6775b934c0b9ac246f85667d61e9ed4c89a35fae38a8"],
  ["post-pr-policy-disabled", "fe6fa58804a25d10747ce503905d3a5de7663d11e8faee2e7b3e52de0a308148"],
  ["post-pr-policy-enabled", "7bdebab5a364fd95834181922dedb2a6f4f178efd5b35abcd3524922d0354967"],
  ["post-pr-observation-null", "2228fab1e0b7b5df83161bcf28eed483cace381e1e63788665a1fa6655f369b5"],
  ["post-pr-observation-active", "21785edba15479cf549af033d0319101ebe4db20ab51990fe35eb70cc9e43e0d"],
  ["post-pr-observation-last-error", "8bfe1a1d5755f1b90c01355781d501040a9b1c4b77b0bd9dbcf3a8e6a3e9f85b"],
  ["post-pr-observation-review-request", "9566fd52bdcfd2827381ca03279711585eab7ecc3286e419e40420c72113d0bb"],
  ["post-pr-observation-snapshot", "19ded9f482060bd5202c40e356b13a3bb0cab5eb11213f9856add41a2cdb7f6b"],
  ["post-pr-remediation-null", "14d2db7f0f845f2efeab959de21c8b7f14e675358120358957e480c8138b427c"],
  ["post-pr-remediation-active", "71afb14f76720ef63877104a8c775761ceaf9d8e98aa7dcaa4de24235f474e12"],
  ["post-pr-remediation-owner", "61efc1abafdc6517729de0b3b42049a296be26101cc4dcc65dc5fb09990e9e1c"],
  ["post-pr-remediation-changes", "4c9443025aaee7943f100038014098e14ce736341300f7316c87493bb55584bf"],
  ["post-pr-remediation-change-entry", "4a21102892d5722e04e8fed6a834e1a64ba27833589b05287f6dd5ed0d2672ce"],
  ["post-pr-dispatch-planned", "f646f06d9d00613fdcc7b1b359d08e0f0de55bde936f9d3c7db749c9b7845502"],
  ["post-pr-dispatch-running", "e671613ce2d2562fb92153f8f2a8c3e36306c3af8100a42e14329b682c8477cc"],
  ["post-pr-dispatch-returned", "fe1c4b8b18b89b9df1b43b03fb6401889045e3f74295784c9d6b51538371953e"],
  ["post-pr-revalidation-empty", "bc500dbc508342382ae34920b39e00812e7a62c76f0d577a4b4474bcd38f5817"],
  ["post-pr-revalidation-bound", "8fba2f20a42a891e0d03a161aedd692275b05729a521ece01ff2f363eb8274c5"],
  ["post-pr-canonical-job-planned", "4f74dbc8d01c7718a5b137d20faa96c2256ca7507f3ddc53f56d051da9804065"],
  ["post-pr-canonical-job-running", "ec2b228514350f528c5a41e818747b7fd081755fd49ff0114f916aca9a5c1cda"],
  ["post-pr-canonical-job-retry-wait", "3ad67692dc4e8801e58f5c23f892018ee49c38a39c7bf8df9831b5a9f8a7fa61"],
  ["post-pr-canonical-job-bound", "499bc66f2304d9275eb6441f18a02132d9a4b739706339f6120f8d1c985c9d41"],
  ["post-pr-validator-job-planned", "7cd517c8d1e501c03aca8cbfda5dab78269a073c798850b2c956cb25c3a5058d"],
  ["post-pr-validator-job-running", "fe0318485017bde3aaa7ee933665ef5d13439bffe65ca0241d347b642f05ee75"],
  ["post-pr-validator-job-retry-wait", "d819db74d03e86a4cf549b3d16517047e1d531697252d6d7509bfcdfebd344fd"],
  ["post-pr-validator-job-bound", "45fa96cdd08ef039db8ad4600cda529a7aae3d9d4e9a070d97ed22f38479a256"],
  ["post-pr-security-job-planned", "0c8897d0b264c4271e737b0cd42070933a7c1a9962965f20b807f72d0e940a31"],
  ["post-pr-security-job-running", "5508c23e76fccbbb0f7e18942dc24cce8d98b304951ef6dfdb7e57863e2a5372"],
  ["post-pr-security-job-retry-wait", "074069f4417cec250cb6330f97ac45ca8ecc3a485649a74295cc2cc7a6e29186"],
  ["post-pr-security-job-bound", "d43241bac0d7fd6bf4acb89b7382896c2a2136cfa4555c4af92506c10ab943b7"],
  ["post-pr-push-not-ready", "a056a15a3578b5393bc7e9f4d26075a435bfea0a0c0c8d3cc4617b2fa52f5f17"],
  ["post-pr-push-pending", "4ce29f28ff843d4b3fc182ed02f186c884994991e2c48d7fb82024720b6a53e4"],
  ["post-pr-push-confirmed", "542c9ecdbea6b4fddeee57b135dd6901c136282ed7298309a7854706555f940e"],
  ["post-pr-push-last-error", "43faeff2318d79d1ea650ef80d99cf0987b0b4b837e414d51549b93038e25439"],
  ["post-pr-evidence-sidecar", "bfe2d8f9d1353cba917aaaec7f6e8647fa64155cea4a07ecc92cdfaf963aa046"],
  ["post-pr-continuation-review-null", "79ecc88e42f7a817bc23b208171ddb2bf6a54f01c8ca47b1b1db186ab28e1770"],
  ["post-pr-continuation-review-bound", "5509a5ff084a310ecc8f4ef1f8a8c81c6b7ead265d26501ded237b9ef60adcd9"],
  ["post-pr-terminal-fact-null", "d8fa57672d8e8ba41e80f3807bd66196959073876fcea0cf7182b1b3a7c3496c"],
  ["post-pr-terminal-fact-account-switch-failed-github-auth", "02a0dcc9b2a1742ef49ccf5bd6417d84e53b99b50ae8febe06c38ca536adc97f"],
  ["post-pr-terminal-fact-account-switch-failed-push", "d3b21f1e9e711265ca534f15f11a2af1b7f865b8ccd4e2f0af6bfb2c3d779482"],
  ["post-pr-terminal-fact-dispatch-start-unknown", "03ac494ca561932a87426256a8d8207d2db69c7d89832da86d85459918af79d3"],
  ["post-pr-terminal-fact-path-lane-violation", "bc7393b42afe9e00cc5aec7ee4c60673921722e844094889d60f2138828c4e3e"],
  ["post-pr-terminal-fact-remote-head-diverged", "5d735cb843b6ecb62867b5cc5e13c435a4f8656da463af57d6d6805e5703dc04"],
  ["post-pr-terminal-fact-panel-runner-result-malformed", "beed81bad84f5734e6da8fb9044685de9f4939e93fb061f241759305ea5d97df"],
  ["post-pr-terminal-fact-push-failed", "83425c5f79198714cd764be913ac0deb3f93b87510e9aa66599d405eb0456f09"],
  ["post-pr-terminal-fact-panel-attribution-unsafe", "f3a27a8a2f12f532be7a44e0521da95a309b8bda559a850a96dd21f5d9b38c38"],
  ...AMENDMENT_ORACLE_DIGESTS.map(([id, , , source]) => [id, source]),
  ["amendment-review-dispatch-claim", "b51371578cccf189480241170f4628364442be7d76a077c925ffdce322b7516c"],
  ["amendment-review-dispatch-closure", "e687f0960cdffa32397c72b098352e7e8f07d9ee11b87dac75af0e953bdfbb1b"],
]);
const DURABLE_AUTHORITY_CANONICAL_SOURCE_BY_ID = new Map(DURABLE_AUTHORITY_CANONICAL_SOURCE_MANIFEST);

export function emitDurableRecordMutations(source, descriptor, externalSources = {}) {
  requireRecord(source, "source");
  requireRecord(descriptor, "descriptor");
  requireRecord(externalSources, "externalSources");
  const recordName = requireText(descriptor.record, "descriptor.record");
  if (!Array.isArray(descriptor.targets)) throw new TypeError("descriptor.targets must be an array");
  requireRecord(descriptor.exclusions, "descriptor.exclusions");

  const targetsByFamily = new Map(DURABLE_MUTATION_FAMILIES.map((family) => [family, []]));
  for (const [index, mutationTarget] of descriptor.targets.entries()) {
    requireRecord(mutationTarget, `descriptor.targets[${index}]`);
    if (!targetsByFamily.has(mutationTarget.family)) throw new TypeError(`descriptor.targets[${index}].family is unknown`);
    requirePath(mutationTarget.path, `descriptor.targets[${index}].path`);
    if (mutationTarget.label !== undefined) requireText(mutationTarget.label, `descriptor.targets[${index}].label`);
    targetsByFamily.get(mutationTarget.family).push(mutationTarget);
  }

  for (const key of Object.keys(descriptor.exclusions)) {
    if (!targetsByFamily.has(key)) throw new TypeError(`descriptor.exclusions.${key} is unknown`);
  }

  const cases = [];
  for (const family of DURABLE_MUTATION_FAMILIES) {
    const targets = targetsByFamily.get(family);
    const hasExclusion = Object.hasOwn(descriptor.exclusions, family);
    if (targets.length > 0 && hasExclusion) throw new TypeError(`${recordName}.${family} cannot be both targeted and excluded`);
    if (targets.length === 0) {
      if (!hasExclusion) throw new TypeError(`${recordName}.${family} must have a target or a record-specific exclusion`);
      requireText(descriptor.exclusions[family], `descriptor.exclusions.${family}`);
      continue;
    }

    for (const mutationTarget of targets) {
      const record = structuredClone(source);
      const mutatedExternalSources = structuredClone(externalSources);
      try {
        const targetRoot = mutationTarget.path[0] === "$external" ? mutatedExternalSources : record;
        const targetDefinition = mutationTarget.path[0] === "$external"
          ? { ...mutationTarget, path: mutationTarget.path.slice(1) }
          : mutationTarget;
        applyMutation(targetRoot, family, targetDefinition);
      } catch (error) {
        throw new TypeError(`${recordName}: ${error.message}`, { cause: error });
      }
      const label = mutationTarget.label ?? renderPath(mutationTarget.path);
      cases.push({
        name: `${recordName}: ${family} (${label})`,
        family,
        recordName,
        record,
        externalSources: mutatedExternalSources,
      });
    }
  }

  const names = cases.map(({ name }) => name);
  if (new Set(names).size !== names.length) throw new TypeError(`${recordName} mutation case names must be unique`);
  return cases;
}

export function renderDurableAuthorityOracleReviewSnapshot(record) {
  requireRecord(record, "record");
  const snapshot = {
    metadata: {
      writer: record.writer,
      readers: record.readers,
      tests: record.tests,
      facts: record.facts,
      sidecars: record.sidecars,
      ...(record.observations === undefined ? {} : { observations: record.observations }),
    },
    descriptor: {
      targets: record.descriptor?.targets,
      exclusions: record.descriptor?.exclusions,
    },
    canonicalSource: {
      authorityClassId: record.authorityClassId,
      id: record.id,
      record: record.record,
      variant: record.variant,
      canonicalPath: record.canonicalPath,
      source: record.source,
      facts: record.facts,
      externalSources: record.externalSources ?? {},
      ...(record.observations === undefined ? {} : { observations: record.observations }),
    },
  };
  return `${JSON.stringify(JSON.parse(canonicalJson(snapshot)), null, 2)}\n`;
}

export function assertDurableAuthorityCatalogComplete(catalog) {
  if (!Array.isArray(catalog)) throw new TypeError("durable authority catalog must be an array");
  const expectedClassIds = AUTHORITY_CLASSES.map(([id]) => id);
  const actualClassIds = catalog.map(({ id }) => id);
  if (!sameList(actualClassIds, expectedClassIds)) throw new TypeError("durable authority catalog must contain exactly the nine registered authority classes in order");
  const expectedManifestIds = Object.values(DURABLE_AUTHORITY_REQUIRED_RECORD_IDS).flat();
  if (!sameList(DURABLE_AUTHORITY_METADATA_MANIFEST.map(([id]) => id), expectedManifestIds)) throw new TypeError("independent metadata manifest must contain every required record id exactly once in source order");
  if (!sameList(DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST.map(([id]) => id), expectedManifestIds)) throw new TypeError("independent descriptor manifest must contain every required record id exactly once in source order");
  if (!sameList(Object.keys(EXPLICIT_EXCLUDED_FAMILY_CODES), expectedManifestIds)) throw new TypeError("explicit family disposition registry must contain every required record id exactly once in source order");
  if (!sameList(DURABLE_AUTHORITY_CANONICAL_SOURCE_MANIFEST.map(([id]) => id), CANONICAL_SOURCE_RECORD_IDS)) throw new TypeError("independent canonical source manifest must contain every required catalog row exactly once in source order");

  const seenRecordIds = new Set();
  for (const authorityClass of catalog) {
    requireText(authorityClass.name, `${authorityClass.id}.name`);
    if (!Array.isArray(authorityClass.records)) throw new TypeError(`${authorityClass.id}.records must register per-record entries`);
    const expectedRecordIds = DURABLE_AUTHORITY_REQUIRED_RECORD_IDS[authorityClass.id];
    const actualRecordIds = authorityClass.records.map(({ id }) => id);
    if (!sameList(actualRecordIds, expectedRecordIds)) throw new TypeError(`${authorityClass.id} must contain every required per-record and per-variant entry in order`);

    for (const record of authorityClass.records) {
      const path = `${authorityClass.id}.${record.id}`;
      if (seenRecordIds.has(record.id)) throw new TypeError(`${path} duplicates a record id`);
      seenRecordIds.add(record.id);
      if (record.authorityClassId !== authorityClass.id) throw new TypeError(`${path}.authorityClassId must match its containing class`);
      requireText(record.record, `${path}.record`);
      requireText(record.variant, `${path}.variant`);
      requireText(record.writer, `${path}.writer`);
      requireTextArray(record.readers, `${path}.readers`);
      requireTextArray(record.tests, `${path}.tests`);
      const expectedMetadataHash = DURABLE_AUTHORITY_METADATA_BY_ID.get(record.id);
      const actualMetadataHash = metadataHash(record);
      if (actualMetadataHash !== expectedMetadataHash) throw new TypeError(`${path} writer, readers, tests, facts, and sidecars must exactly match the independent metadata manifest`);
      requireRecord(record.source, `${path}.source`);
      requireRecord(record.descriptor, `${path}.descriptor`);
      if (record.descriptor.record !== record.id) throw new TypeError(`${path}.descriptor.record must equal the record id`);
      validateExpectedDescriptorDispositions(record, path);
      const expectedDescriptorHash = DURABLE_AUTHORITY_DESCRIPTOR_BY_ID.get(record.id);
      const actualDescriptorHash = descriptorHash(record.descriptor);
      if (actualDescriptorHash !== expectedDescriptorHash) throw new TypeError(`${path} mutation target definitions and exclusions must exactly match the independent descriptor manifest`);
      if (CANONICAL_SOURCE_RECORD_ID_SET.has(record.id)) validateCanonicalCoreRecord(record, path);
      else if (record.canonicalPath !== undefined || record.externalSources !== undefined) throw new TypeError(`${path} canonical source declarations are reserved for the registered core source manifest`);
      emitDurableRecordMutations(record.source, record.descriptor, record.externalSources);
      validateRecordSidecars(record, path);
    }
  }
  return true;
}

const RECORDS = [
  recordEntry({
    authorityClassId: "plan-slices-graph", id: "plan-slices-json", record: "plan/slices.json", variant: "accepted graph",
    writer: "factory slices-seed (checked plan validation and seed transition)",
    readers: ["validateSlicesPlan", "factory slices-seed", "transitionRunSlice and transitionSliceMerged"],
    canonicalPath: ["plan/slices.json"], source: JSON.parse(PLAN_EXTERNAL.plan.bytes), externalSources: PLAN_EXTERNAL,
    facts: exactFacts(JSON.parse(PLAN_EXTERNAL.plan.bytes)),
    requiredPath: ["slices"], typePath: ["slices"],
    targets: [drift(["slices", 1], "depends_on", "dependencies"), stale(["slices", 1, "depends_on", 0], "stale-slice"), cross(["slices", 1, "depends_on", 0], "other-wave")],
  }),
  recordEntry({
    authorityClassId: "plan-slices-graph", id: "plan-v2-integration-gate", record: "plan/slices.json.integration_gate", variant: "schema-v2 required command authority",
    writer: "work-decomposer plan production followed by checked factory slices-seed",
    readers: ["validateSlicesPlan creation mode", "transitionSlicesSeed checked source authority", "observeCarryForwardAuthority and schema-v2 publication/adoption/replay"],
    canonicalPath: ["plan/slices.json"], source: JSON.parse(PLAN_V2_EXTERNAL.plan.bytes), externalSources: PLAN_V2_EXTERNAL,
    facts: exactFacts(JSON.parse(PLAN_V2_EXTERNAL.plan.bytes)),
    requiredPath: ["integration_gate", "timeout_ms"], unknownPath: ["integration_gate"], typePath: ["integration_gate", "timeout_ms"],
    targets: [drift(["integration_gate", "required_commands", 0], "program", "command"), stale(["integration_gate", "required_commands", 1, "args", 1], "test"), cross(["integration_gate", "required_commands", 1, "program"], "pnpm")],
  }),
  recordEntry({
    authorityClassId: "plan-slices-graph", id: "plan-delivery-envelope-v1", record: "plan/slices.json.delivery_envelope", variant: "optional delivery envelope schema v1",
    writer: "work-decomposer plan production followed by checked factory slices-seed",
    readers: ["validateDeliveryEnvelope", "evaluateDeliveryEnvelopeAdmission", "transitionSlicesSeed checked source authority", "accepted work-decomposer observation"],
    canonicalPath: ["delivery_envelope"], source: structuredClone(DELIVERY_ENVELOPE_PLAN.delivery_envelope), externalSources: DELIVERY_ENVELOPE_EXTERNAL,
    facts: exactFacts(DELIVERY_ENVELOPE_PLAN.delivery_envelope),
    requiredPath: ["delivery_units", 0, "verification_artifacts", 0, "timeout_ms"], unknownPath: [], typePath: ["delivery_units", 0, "verification_artifacts", 0, "timeout_ms"],
    targets: [
      schema(["schema_version"]),
      drift(["delivery_units", 0], "slice_id", "slice"),
      stale(["delivery_units", 0, "verification_artifacts", 0, "test_plan_index"], 1),
      cross(["delivery_units", 0, "obligations", 0, "verification_artifact_id"], "other-tests"),
    ],
  }),
  recordEntry({
    authorityClassId: "plan-slices-graph", id: "checkpoint-reviewed-plan-v1", record: "plan/slices.json.delivery_envelope.checkpoint_plan", variant: "explicit reviewed checkpoint plan",
    writer: "work-decomposer plan production before factory slices-probe",
    readers: ["validateReviewedCheckpointPlan", "buildDeliveryPlanAdmissionProbe", "work-reviewer checkpoint review", "buildCheckpointRoutingManifest"],
    canonicalPath: ["delivery_envelope", "checkpoint_plan"], source: structuredClone(CHECKPOINT_PLAN.delivery_envelope.checkpoint_plan), externalSources: CHECKPOINT_EXTERNAL,
    facts: exactFacts(CHECKPOINT_PLAN.delivery_envelope.checkpoint_plan), requiredPath: ["kind"], unknownPath: [], typePath: ["checkpoints"],
    targets: [schema(["schema_version"]), kind(["kind"], "other-plan"), drift([], "acceptance_inventory", "inventory"), stale(["checkpoints", 0, "ordinal"], 0), cross(["checkpoints", 0, "child_plan", "slices", 0, "id"], "other-slice")],
  }),
  recordEntry({
    authorityClassId: "plan-slices-graph", id: "checkpoint-admission-probe-valid", record: "reviews/work-decomposer.json.admission_probe", variant: "valid typed checkpoint probe",
    writer: "factory slices-probe through buildDeliveryPlanAdmissionProbe",
    readers: ["work-reviewer checkpoint review", "observeAcceptedDecompositionAuthority", "buildCheckpointRoutingManifest", "transitionCheckpointRouting"],
    canonicalPath: ["admission_probe"], source: structuredClone(CHECKPOINT_REVIEW.admission_probe), externalSources: CHECKPOINT_EXTERNAL,
    facts: exactFacts(CHECKPOINT_REVIEW.admission_probe), requiredPath: ["status"], unknownPath: [], typePath: ["checkpoints"],
    targets: [schema(["schema_version"]), kind(["kind"], "other-probe"), ref(["plan_ref"]), hash(["plan_hash"]), drift([], "status", "probe_status"), stale(["checkpoint_plan_hash"], WRONG_HASH_A), cross(["decision"], "admit")],
  }),
  recordEntry({
    authorityClassId: "plan-slices-graph", id: "checkpoint-child-disposition-v1", record: "reviews/work-decomposer.json.checkpoint_dispositions[]", variant: "exact approving child disposition",
    writer: "work-reviewer same-attempt APPROVE-CHECKPOINT review",
    readers: ["observeAcceptedDecompositionAuthority", "buildCheckpointRoutingManifest", "reconcileCheckpointPublication", "checkpoint child accepted decomposition"],
    canonicalPath: ["checkpoint_dispositions", 0], source: structuredClone(CHECKPOINT_REVIEW.checkpoint_dispositions[0]), externalSources: CHECKPOINT_EXTERNAL,
    facts: exactFacts(CHECKPOINT_REVIEW.checkpoint_dispositions[0]), requiredPath: ["kind"], unknownPath: [], typePath: ["checkpoint_ordinal"],
    targets: [schema(["schema_version"]), kind(["kind"], "other-disposition"), ref(["reviewed_plan_ref"]), hash(["child_plan_hash"]), drift([], "checkpoint_id", "route_id"), stale(["checkpoint_ordinal"], 0), cross(["parent_review_identity", "plan_hash"], WRONG_HASH_B)],
  }),
  recordEntry({
    authorityClassId: "plan-slices-graph", id: "checkpoint-routing-artifact-v1", record: "artifacts/checkpoint-routing-<sha256>.json", variant: "reviewed oversized-plan checkpoint route",
    writer: "transitionCheckpointRouting after accepted work-decomposer review observation",
    readers: ["validateCheckpointRoutingManifest", "transitionCheckpointRouting replay", "factory checkpoint-start child admission"],
    canonicalPath: ["artifacts", "checkpoint_routing"], source: structuredClone(CHECKPOINT_ROUTING_MANIFEST), externalSources: CHECKPOINT_EXTERNAL,
    facts: exactFacts(CHECKPOINT_ROUTING_MANIFEST),
    requiredPath: ["source", "plan_hash"], unknownPath: [], typePath: ["checkpoints"],
    sidecars: [
      externalSidecar("plan", ["source", "plan_ref"], ["source", "plan_hash"]),
      externalSidecar("review", ["source", "decomposition_review_ref"], ["source", "decomposition_review_hash"]),
    ],
    targets: [
      schema(["schema_version"]), kind(["kind"], "other-routing"),
      ...externalSidecarTargets("plan", ["source", "plan_ref"], ["source", "plan_hash"]),
      ...externalSidecarTargets("review", ["source", "decomposition_review_ref"], ["source", "decomposition_review_hash"]),
      drift(["source"], "decomposition_attempt", "review_attempt"),
      stale(["source", "decomposition_attempt"], 0),
      cross(["checkpoints", 1], "prerequisite_checkpoint_id", "checkpoint-999"),
    ],
  }),
  recordEntry({
    authorityClassId: "plan-slices-graph", id: "checkpoint-child-publication-v1", record: "refs/opencode/checkpoint-publications/<sha256-child-run-id>", variant: "creation-only child publication claim",
    writer: "factory checkpoint-start reserveCheckpointPublication",
    readers: ["validateCheckpointChildPublication", "reconcileCheckpointPublication", "checkpoint publication exact replay", "checkpoint worktree creation claim"],
    canonicalPath: ["checkpoint_child_publication"], source: structuredClone(CHECKPOINT_CHILD_PUBLICATION), facts: exactFacts(CHECKPOINT_CHILD_PUBLICATION),
    requiredPath: ["kind"], unknownPath: [], typePath: ["checkpoint_ordinal"],
    targets: [schema(["schema_version"]), kind(["kind"], "other-publication"), time(["reserved_at"]), ref(["manifest_ref"]), hash(["manifest_hash"]), drift([], "child_run_id", "run_id"), stale(["checkpoint_ordinal"], 2), cross(["child_run_id"], "other-child")],
  }),
  recordEntry({
    authorityClassId: "plan-slices-graph", id: "checkpoint-source-v1", record: "run.json.checkpoint_source", variant: "immutable normal-child checkpoint source",
    writer: "reconcileCheckpointPublication complete child publication",
    readers: ["validateCheckpointSource", "validateRun", "schema-v2 same-checkpoint carry-forward construction/adoption", "resolveCheckpointCompletionLineage", "checkpoint cleanup authorization"],
    canonicalPath: ["checkpoint_source"], source: structuredClone(CHECKPOINT_SOURCE), externalSources: CHECKPOINT_EXTERNAL, facts: exactFacts(CHECKPOINT_SOURCE),
    requiredPath: ["kind"], unknownPath: [], typePath: ["checkpoint_ordinal"],
    targets: [schema(["schema_version"]), kind(["kind"], "other-source"), ref(["manifest_ref"]), hash(["manifest_hash"]), drift([], "source_plan_ref", "parent_plan_ref"), stale(["checkpoint_ordinal"], 2), cross(["initial_base_ref"], "refs/remotes/origin/other")],
  }),
  checkpointProgressEntry("checkpoint-progress-reserved", "reserved"),
  checkpointProgressEntry("checkpoint-progress-child-published", "child-published"),
  checkpointProgressEntry("checkpoint-progress-launched", "launched"),
  checkpointProgressEntry("checkpoint-progress-merged", "merged"),
  checkpointProgressEntry("checkpoint-progress-closed", "closed"),
  recordEntry({
    authorityClassId: "plan-slices-graph", id: "checkpoint-merged-completion-v1", record: "run.json.checkpoint_progress.entries[].merged completion", variant: "normal child or same-checkpoint B1 merged completion",
    writer: "factory checkpoint-record-merged through transitionCheckpointProgressMerged",
    readers: ["validateCheckpointProgress", "buildCheckpointMergedCompletion replay", "factory checkpoint-start predecessor recovery", "factory checkpoint-close final recovery", "assertCheckpointCleanupEligible"],
    canonicalPath: ["checkpoint_progress"], source: structuredClone(CHECKPOINT_PROGRESS.merged), facts: exactFacts(CHECKPOINT_PROGRESS.merged),
    requiredPath: ["entries", 0, "completed_child_run_id"], unknownPath: [], typePath: ["entries", 0, "lineage"],
    targets: [schema(["schema_version"]), kind(["kind"], "other-progress"), time(["entries", 0, "merged_at"]), ref(["entries", 0, "pull_request", "pr_url"]), hash(["manifest_hash"]), drift(["entries", 0], "lineage", "completion_lineage"), stale(["entries", 0, "pull_request", "base_ref"], "other"), cross(["entries", 0, "completed_child_run_id"], "other-child")],
  }),
  recordEntry({
    authorityClassId: "plan-slices-graph", id: "checkpoint-final-closure-v1", record: "artifacts/checkpoint-closure-<sha256>.json", variant: "reservation-free content-addressed route closure",
    writer: "factory checkpoint-close publishCheckpointClosureArtifact",
    readers: ["validateDeliveryCheckpointFinalClosure", "buildCheckpointFinalClosure replay", "factory checkpoint-close parent binding", "checkpoint route audit"],
    canonicalPath: ["checkpoint_final_closure"], source: structuredClone(CHECKPOINT_FINAL_CLOSURE), externalSources: CHECKPOINT_EXTERNAL, facts: exactFacts(CHECKPOINT_FINAL_CLOSURE),
    requiredPath: ["kind"], unknownPath: [], typePath: ["checkpoints"],
    targets: [schema(["schema_version"]), kind(["kind"], "other-closure"), time(["closed_at"]), ref(["manifest_ref"]), hash(["manifest_hash"]), drift([], "checkpoints", "completed_checkpoints"), stale(["checkpoints", 0, "ordinal"], 2), cross(["checkpoints", 0, "completed_child_run_id"], "other-child")],
  }),
  recordEntry({
    authorityClassId: "plan-slices-graph", id: "final-plan-descriptor", record: "final.plan.json descriptor", variant: "required descriptor",
    writer: "work-decomposer final plan write followed by reviewed planning acceptance",
    readers: ["work-reviewer decomposition review", "factory slices-seed descriptor consumption"],
    canonicalPath: ["final.plan.json"],
    source: { schema_version: 1, kind: "final-plan", created_at: NOW, run_id: "catalog-run", descriptor: { kind: "slices-graph", ref: PLAN_EXTERNAL.plan.ref, hash: hashBytes(PLAN_EXTERNAL.plan.bytes) } },
    externalSources: PLAN_EXTERNAL,
    facts: exactFacts({ schema_version: 1, kind: "final-plan", created_at: NOW, run_id: "catalog-run", descriptor: { kind: "slices-graph", ref: PLAN_EXTERNAL.plan.ref, hash: hashBytes(PLAN_EXTERNAL.plan.bytes) } }),
    requiredPath: ["descriptor", "kind"], typePath: ["descriptor"], sidecars: [externalSidecar("plan", ["descriptor", "ref"], ["descriptor", "hash"])],
    targets: [schema(["schema_version"]), kind(["descriptor", "kind"], "unknown-graph", "required descriptor.kind"), time(["created_at"]), ...externalSidecarTargets("plan", ["descriptor", "ref"], ["descriptor", "hash"]), drift(["descriptor"], "kind", "record_kind"), stale(["run_id"], "stale-run"), cross(["descriptor", "kind"], "other-boundary-kind", "descriptor boundary")],
  }),

  recordEntry({
    authorityClassId: "run-envelope-terminal-result", id: "run-envelope-running", record: "run.json", variant: "running",
    writer: "manifest bootstrap and transitionRunJson checked locked writers",
    readers: ["validateRun", "resumeFactory", "all checked run-state transitions through transitionRunJson", "factory status/list/watch eligibility readers"],
    canonicalPath: [], source: { schema_version: 1, run_id: "catalog-run", status: "running", updated_at: NOW, base_commit: SHA_A, branch: "catalog-run", worktree: "/tmp/catalog-run", terminal_result: null },
    facts: exactFacts({ schema_version: 1, run_id: "catalog-run", status: "running", updated_at: NOW, base_commit: SHA_A, branch: "catalog-run", worktree: "/tmp/catalog-run", terminal_result: null }),
    requiredPath: ["run_id"], typePath: ["status"], targets: [schema(["schema_version"]), time(["updated_at"]), ref(["worktree"]), stale(["base_commit"], SHA_B), cross(["run_id"], "other-run")],
  }),
  recordEntry({
    authorityClassId: "run-envelope-terminal-result", id: "run-envelope-terminal", record: "run.json", variant: "terminal envelope",
    writer: "transitionTerminalResult, transitionPrCreated, or transitionPostPrTerminal",
    readers: ["validateRun", "resumeFactory terminal check", "factory status/list/watch terminal readers", "cleanup eligibility readers"],
    canonicalPath: [], source: { schema_version: 1, run_id: "catalog-run", status: "blocked", updated_at: NOW, terminal_result: { status: "blocked", run_id: "catalog-run", reason: "review-blocked" } },
    facts: exactFacts({ schema_version: 1, run_id: "catalog-run", status: "blocked", updated_at: NOW, terminal_result: { status: "blocked", run_id: "catalog-run", reason: "review-blocked" } }),
    requiredPath: ["terminal_result"], typePath: ["status"], targets: [schema(["schema_version"]), time(["updated_at"]), stale(["status"], "running"), cross(["terminal_result", "run_id"], "other-run")],
  }),
  terminalResultEntry("terminal-result-completed", "completed", { pr_url: "https://github.com/acme/repo/pull/7", pr_number: 7, pr_node_id: "PR_catalog_operation", repository: "acme/repo", operation_id: PR_OPERATION_ID, head_ref: "feature--catalog", head_sha: SHA_B, base_ref: "main", base_sha: SHA_A, draft: false, artifacts: { test_report: "artifacts/test-report.md" } }, [ref(["artifacts", "test_report"]), stale(["head_sha"], SHA_A), cross(["operation_id"], `ffpr-v1-${"e".repeat(64)}`)]),
  terminalResultEntry("terminal-result-blocked", "blocked", { reason: "review-blocked", summary: "Review blocked." }),
  terminalResultEntry("terminal-result-blocked-checkpoint-routing", "blocked", {
    reason: "oversized-plan-checkpoint-routing-required",
    summary: "Oversized plan routed to 2 sequential independently shippable checkpoints.",
    pr_url: null,
    artifacts: { checkpoint_routing: CHECKPOINT_ROUTING_REF },
  }, [ref(["artifacts", "checkpoint_routing"]), drift(["artifacts"], "checkpoint_routing", "routing"), stale(["reason"], "review-blocked")]),
  nonconvergenceTerminalResultEntry(),
  terminalResultEntry("terminal-result-partial", "partial", { reason: "partial-completion", summary: "Some work completed." }),
  terminalResultEntry("terminal-result-needs-human", "needs-human", { reason: "operator-reconciliation", summary: "Operator action required." }),

  gateEntry("gate-pending", "pending"),
  gateEntry("gate-approved-without-receipt", "approved-without-receipt"),
  gateEntry("gate-approved-interactive", "approved-interactive"),
  gateEntry("gate-changes-requested", "changes_requested"),
  gateEntry("gate-stopped", "stopped"),

  stepEntry("step-running", "running"),
  stepEntry("step-rejected", "rejected"),
  stepEntry("step-blocked", "blocked"),
  stepEntry("step-accepted", "accepted"),
  workDecomposerAcceptedEntry(),
  stepEntry("step-inherited-acceptance", "inherited-acceptance"),
  testExecutionClaimEntry("test-execution-claim-active", "active"),
  testExecutionClaimEntry("test-execution-claim-completed-pass", "completed-pass"),
  testExecutionClaimEntry("test-execution-claim-completed-fail", "completed-fail"),
  testExecutionClaimEntry("test-execution-claim-unknown-process-outcome-indeterminate", "unknown-process-outcome-indeterminate"),
  testExecutionClaimEntry("test-execution-claim-unknown-authority-changed", "unknown-authority-changed"),
  testExecutionClaimEntry("test-execution-claim-unknown-receipt-publication-indeterminate", "unknown-receipt-publication-indeterminate"),
  testExecutionReceiptEntry("test-execution-receipt-pass", "pass"),
  testExecutionReceiptEntry("test-execution-receipt-failed-nonzero-exit", "failed-nonzero-exit"),
  testExecutionReceiptEntry("test-execution-receipt-failed-signal", "failed-signal"),
  testExecutionReceiptEntry("test-execution-receipt-failed-launch-error", "failed-launch-error"),
  testExecutionReceiptEntry("test-execution-receipt-failed-timeout", "failed-timeout"),
  testExecutionReceiptEntry("test-execution-receipt-failed-output-limit", "failed-output-limit"),

  sliceEntry("slice-pending", "pending"),
  sliceEntry("slice-running", "running"),
  sliceEntry("slice-review", "review"),
  recordEntry({
    authorityClassId: "slices-review-evidence-bindings", id: "review-invariant-family-ledger-v1", record: "reviews/<slice-id>.json.invariant_family_ledger", variant: "optional review ledger schema v1",
    writer: "work-reviewer slice review publication consumed by transitionRunSlice",
    readers: ["validateInvariantFamilyLedger", "evaluateInvariantFamilyReview", "observeSliceReviewPublicationAuthority", "review publication commit-boundary re-observation"],
    canonicalPath: ["invariant_family_ledger"], source: structuredClone(INVARIANT_FAMILY_LEDGER), externalSources: INVARIANT_LEDGER_EXTERNAL,
    facts: exactFacts(INVARIANT_FAMILY_LEDGER),
    observations: [
      { name: "delivery-unit-reference", source: "plan", path: ["delivery_envelope", "delivery_units", 0, "id"], expected: "backend-unit", consumer: "evaluateInvariantFamilyReview" },
      { name: "family-reference", source: "plan", path: ["delivery_envelope", "delivery_units", 0, "invariant_families", 0, "id"], expected: "backend-behavior", consumer: "evaluateInvariantFamilyReview" },
      { name: "artifact-reference", source: "plan", path: ["delivery_envelope", "delivery_units", 0, "verification_artifacts", 0, "id"], expected: "backend-tests", consumer: "evaluateInvariantFamilyReview" },
    ],
    requiredPath: ["delivery_unit_id"], unknownPath: [], typePath: ["dispositions"],
    sidecars: [externalSidecar("evidence", ["dispositions", 0, "evidence_ref"], ["dispositions", 0, "evidence_hash"])],
    targets: [
      schema(["schema_version"]),
      ...externalSidecarTargets("evidence", ["dispositions", 0, "evidence_ref"], ["dispositions", 0, "evidence_hash"]),
      drift(["dispositions", 0], "probe", "verification_probe"),
      stale(["dispositions", 0, "reviewed_commit"], SHA_A),
      cross(["dispositions", 0, "invariant_family_id"], "other-family"),
    ],
  }),
  verificationArtifactClaimEntry("verification-artifact-claim-active", "active"),
  verificationArtifactClaimEntry("verification-artifact-claim-completed-pass", "completed-pass"),
  verificationArtifactClaimEntry("verification-artifact-claim-completed-fail", "completed-fail"),
  verificationArtifactClaimEntry("verification-artifact-claim-unknown-process", "unknown-process"),
  verificationArtifactClaimEntry("verification-artifact-claim-unknown-receipt", "unknown-receipt"),
  verificationArtifactReceiptEntry("verification-artifact-execution-receipt-pass", "pass"),
  verificationArtifactReceiptEntry("verification-artifact-execution-receipt-fail", "fail"),
  sliceEntry("slice-merged", "merged"),
  sliceEntry("slice-blocked-ordinary", "blocked-ordinary"),
  sliceEntry("slice-blocked", "blocked"),

  panelEntry("validator-verdict-binding", "run.json.validator", "validator", { verdict: "GO", report: "artifacts/validation-report.md", review_ref: "reviews/implementation-validator.json" }),
  panelEntry("security-verdict-binding", "run.json.security_review", "security_review", { verdict: "PASS", review_ref: "reviews/security-reviewer.json" }),
  steeringEntry("steering-boundary", "boundary"),
  steeringEntry("steering-action-claim", "action_claim"),
  steeringEntry("steering-last-action", "last_action"),
  prFenceEntry(),
  recordEntry({
    authorityClassId: "validator-security-pr-result", id: "pr-created-result", record: "PR-created terminal_result", variant: "completed external PR",
    writer: "transitionPrCreated after fenced external PR creation/re-observation",
    readers: ["validateRun terminal consistency", "resumeFactory terminal reader", "cleanup eligibility", "post-PR initialization and continuation admission"],
    canonicalPath: ["terminal_result"], source: { status: "completed", run_id: "catalog-run", pr_url: "https://github.com/acme/repo/pull/7", pr_number: 7, pr_node_id: "PR_catalog_operation", repository: "acme/repo", operation_id: PR_OPERATION_ID, head_ref: "feature--catalog", head_sha: SHA_B, base_ref: "main", base_sha: SHA_A, draft: false },
    facts: exactFacts({ status: "completed", run_id: "catalog-run", pr_url: "https://github.com/acme/repo/pull/7", pr_number: 7, pr_node_id: "PR_catalog_operation", repository: "acme/repo", operation_id: PR_OPERATION_ID, head_ref: "feature--catalog", head_sha: SHA_B, base_ref: "main", base_sha: SHA_A, draft: false }),
    requiredPath: ["operation_id"], typePath: ["pr_number"], targets: [ref(["pr_url"]), stale(["head_sha"], SHA_A), cross(["operation_id"], `ffpr-v1-${"e".repeat(64)}`)],
  }),

  continuationV2EnvelopeEntry(),
  continuationV2ParentEntry(),
  continuationV2ReviewEntry(),
  continuationV2TargetEntry(),
  continuationV2ContextEntry("continuation-v2-parent-artifact-sidecar", "parent_artifacts", "artifact"),
  continuationV2ContextEntry("continuation-v2-parent-evidence-sidecar", "parent_evidence", "evidence"),
  continuationV2ContextEntry("continuation-v2-parent-review-sidecar", "parent_reviews", "review"),
  recordEntry({
    authorityClassId: "continuation-v2-carry-forward", id: "continuation-v2-planning-reuse", record: "continuation.planning_reuse", variant: "accepted immutable planning bytes",
    writer: "checked schema-v2 carry-forward publication",
    readers: ["validateContinuationPlanningReuse", "feature command payload normalization", "published carry-forward authority"],
    ...continuationV2RecordSource("continuation-v2-planning-reuse"),
    requiredPath: ["eligible"], typePath: ["spec_review_hash"],
    sidecars: [externalSidecar("review", ["spec_review_ref"], ["spec_review_hash"]), externalSidecar("artifact", ["spec_artifact_ref"], ["spec_artifact_hash"])],
    targets: [...externalSidecarTargets("review", ["spec_review_ref"], ["spec_review_hash"]), ...externalSidecarTargets("artifact", ["spec_artifact_ref"], ["spec_artifact_hash"]), stale(["eligible"], false), cross(["spec_review_ref"], "reviews/other-run.json")],
  }),

  ...POST_PR_PHASES.map(postPrPhaseEntry),
  postPrPolicyEntry("post-pr-policy-disabled", false),
  postPrPolicyEntry("post-pr-policy-enabled", true),
  postPrNullEntry("post-pr-observation-null", "post_pr.observation", "observation", "awaiting-pr", "transitionPrCreated initializes observation", ["validatePostPrObservation", "transitionPostPrState monotonic observation checks", "transitionPostPrTerminal observation preconditions"]),
  postPrObservationEntry(),
  postPrObservationNestedEntry("last-error"),
  postPrObservationNestedEntry("review-request"),
  postPrObservationNestedEntry("snapshot"),
  postPrNullEntry("post-pr-remediation-null", "post_pr.remediation", "remediation", "observing", "transitionPostPrFailure creates remediation", ["validatePostPrRemediation", "transitionPostPrFailure replay checks", "transitionPostPrTerminal failure preconditions"]),
  postPrRemediationEntry(),
  postPrRemediationNestedEntry("owner"),
  postPrRemediationNestedEntry("changes"),
  postPrRemediationNestedEntry("change-entry"),
  postPrDispatchEntry("post-pr-dispatch-planned", "planned", null, null),
  postPrDispatchEntry("post-pr-dispatch-running", "running", NOW, null),
  postPrDispatchEntry("post-pr-dispatch-returned", "returned", NOW, "2026-07-16T12:05:00.000Z"),
  postPrRevalidationEntry("post-pr-revalidation-empty", false),
  postPrRevalidationEntry("post-pr-revalidation-bound", true),
  ...POST_PR_JOB_ACTIVITIES.flatMap((activity) => POST_PR_JOB_STATES.map((state) => postPrJobEntry(activity, state))),
  postPrPushEntry("post-pr-push-not-ready", "not-ready", null, null),
  postPrPushEntry("post-pr-push-pending", "pending", SHA_A, null),
  postPrPushEntry("post-pr-push-confirmed", "confirmed", SHA_A, SHA_B),
  postPrPushLastErrorEntry(),
  postPrEvidenceEntry(),
  postPrNullEntry("post-pr-continuation-review-null", "post_pr.continuation_review", "continuation_review", "observing", "transitionPostPrTerminal binds only retry exhaustion", ["validatePostPr", "transitionPostPrTerminal retry-exhaustion checks", "factory continue post-PR admission"]),
  postPrContinuationReviewEntry(),
  postPrNullEntry("post-pr-terminal-fact-null", "post_pr.terminal_fact", "terminal_fact", "succeeded", "transitionPostPrTerminal writes null for non-fact terminal reasons", ["validatePostPrTerminalFact", "terminal status/readers"]),
  postPrTerminalFactEntry("account-switch-failed-github-auth"),
  postPrTerminalFactEntry("account-switch-failed-push"),
  postPrTerminalFactEntry("dispatch-start-unknown"),
  postPrTerminalFactEntry("path-lane-violation"),
  postPrTerminalFactEntry("remote-head-diverged"),
  postPrTerminalFactEntry("panel-runner-result-malformed"),
  postPrTerminalFactEntry("push-failed"),
  postPrTerminalFactEntry("panel-attribution-unsafe"),

  ...AMENDMENT_MANIFEST_VARIANTS.map(([id, variant]) => amendmentManifestEntry(id, variant)),
  ...AMENDMENT_CLAIM_VARIANTS.map(([id, phase, state, outcome]) => amendmentExecutionClaimEntry(id, phase, state, outcome)),
  ...AMENDMENT_RECEIPT_VARIANTS.map(([id, phase, outcome]) => amendmentExecutionReceiptEntry(id, phase, outcome)),
  amendmentReviewEntry("amendment-review-approve", "APPROVE"),
  amendmentReviewEntry("amendment-review-reject", "REJECT"),
  amendmentBuilderDispatchEntry("amendment-dispatch-binding-active", "binding-active"),
  amendmentBuilderDispatchEntry("amendment-dispatch-binding-closed", "binding-closed"),
  amendmentBuilderDispatchEntry("amendment-dispatch-claim", "claim"),
  amendmentBuilderDispatchEntry("amendment-dispatch-closure", "closure"),
  amendmentReviewProvenanceEntry("amendment-review-dispatch-claim", "claim"),
  amendmentReviewProvenanceEntry("amendment-review-dispatch-closure", "closure"),
];

const mutableCatalog = AUTHORITY_CLASSES.map(([id, name]) => ({
  id,
  name,
  records: RECORDS.filter(({ authorityClassId }) => authorityClassId === id),
}));

assertDurableAuthorityCatalogComplete(mutableCatalog);
export const DURABLE_AUTHORITY_CATALOG = deepFreeze(mutableCatalog);

export const DURABLE_AUTHORITY_EXCLUSIONS = deepFreeze([
  {
    records: ["run.json.debug_snapshot", "run.json.provenance", "run.json.cost_attribution"],
    reason: "Diagnostic records do not authorize workflow decisions and are outside the durable-authority integrity catalog.",
  },
  {
    records: ["heartbeat.json", "run.json.heartbeat_at"],
    reason: "Liveness records report activity only and do not authorize semantic state transitions.",
  },
  {
    records: ["factory.lock", "run-json.lock/owner.json", "process-launch.lock/owner.json"],
    reason: "Lock ownership records are transient coordination mechanisms, not records in this durable semantic-authority catalog.",
  },
  {
    records: ["process.json", "processes/*.log"],
    reason: "Process records and logs are sidecar execution evidence rather than durable semantic workflow authority.",
  },
]);

function terminalResultEntry(id, status, extras, targets = []) {
  const source = { status, run_id: "catalog-run", reason: status === "completed" ? null : extras.reason, summary: extras.summary ?? "PR created.", ...extras };
  return recordEntry({
    authorityClassId: "run-envelope-terminal-result", id, record: "run.json.terminal_result", variant: status,
    writer: status === "completed" ? "transitionPrCreated" : "transitionTerminalResult or transitionPostPrTerminal",
    readers: ["validateRun terminal consistency", "resumeFactory terminal check", "factory status/list/watch terminal readers", "cleanup eligibility readers"],
    canonicalPath: ["terminal_result"], source, facts: exactFacts(source),
    requiredPath: ["status"], typePath: ["run_id"], targets: [...targets, stale(["status"], "running"), cross(["run_id"], "other-run")],
  });
}

function nonconvergenceTerminalResultEntry() {
  const sourceReview = {
    attempt: 1,
    evidence_ref: SLICE_NONCONVERGENCE_EXTERNAL.evidence.ref,
    evidence_hash: hashBytes(SLICE_NONCONVERGENCE_EXTERNAL.evidence.bytes),
    review_ref: SLICE_NONCONVERGENCE_EXTERNAL.review.ref,
    review_hash: hashBytes(SLICE_NONCONVERGENCE_EXTERNAL.review.bytes),
    reviewed_commit: SHA_B,
    diff_base_commit: SHA_B,
    ratified_paths: [],
    verdict: "REJECT",
    convergence: "nonconvergent",
    late_discovery_strike: false,
    remaining_fix_count: 1,
    dispatch_claim_ref: SLICE_NONCONVERGENCE_EXTERNAL.claim.ref,
    dispatch_claim_hash: hashBytes(SLICE_NONCONVERGENCE_EXTERNAL.claim.bytes),
    dispatch_closure_ref: SLICE_NONCONVERGENCE_EXTERNAL.closure.ref,
    dispatch_closure_hash: hashBytes(SLICE_NONCONVERGENCE_EXTERNAL.closure.bytes),
  };
  const source = {
    status: "blocked",
    run_id: "catalog-run",
    pr_url: null,
    reason: "slice-review-nonconvergent",
    summary: "Slice 'backend' review marked attempt 1 nonconvergent; continue from the reviewed integration state.",
    artifacts: {},
    nonconvergence: {
      schema_version: 1,
      kind: "slice-review-nonconvergence",
      slice_id: "backend",
      source_review: sourceReview,
      continuation: { program: "feature-factory", args: ["factory", "continue", "catalog-run", "--review", sourceReview.review_ref, "--run-id", "<new-run-id>", "--carry-forward", "--json"] },
    },
  };
  return recordEntry({
    authorityClassId: "run-envelope-terminal-result",
    id: "terminal-result-blocked-nonconvergence",
    record: "run.json.terminal_result",
    variant: "blocked slice-review nonconvergence",
    writer: "transitionRunSlice checked nonconvergence terminalization",
    readers: ["validateRun terminal nonconvergence consistency", "factory continue schema-v2 selector", "schema-v2 child dispatch parent authority", "terminal and continuation diagnostics"],
    canonicalPath: ["terminal_result"],
    source,
    externalSources: { evidence: SLICE_NONCONVERGENCE_EXTERNAL.evidence, review: SLICE_NONCONVERGENCE_EXTERNAL.review },
    sidecars: [
      externalSidecar("evidence", ["nonconvergence", "source_review", "evidence_ref"], ["nonconvergence", "source_review", "evidence_hash"]),
      externalSidecar("review", ["nonconvergence", "source_review", "review_ref"], ["nonconvergence", "source_review", "review_hash"]),
    ],
    facts: exactFacts(source),
    requiredPath: ["nonconvergence"],
    typePath: ["nonconvergence", "source_review", "attempt"],
    targets: [
      ...externalSidecarTargets("evidence", ["nonconvergence", "source_review", "evidence_ref"], ["nonconvergence", "source_review", "evidence_hash"]),
      ...externalSidecarTargets("review", ["nonconvergence", "source_review", "review_ref"], ["nonconvergence", "source_review", "review_hash"]),
      target("missing-key", ["nonconvergence", "source_review", "late_discovery_strike"], "required late-discovery strike marker"),
      target("wrong-type", ["nonconvergence", "source_review", "late_discovery_strike"], "boolean late-discovery strike marker"),
      drift(["nonconvergence"], "kind", "terminal source kind"),
      stale(["nonconvergence", "source_review", "attempt"], 0),
      cross(["nonconvergence", "slice_id"], "frontend"),
    ],
  });
}

function gateEntry(id, variant) {
  const artifactRef = "artifacts/story.md";
  const questionRef = "gates/story.question.md";
  const pendingAnswerRef = "gates/story.answer";
  const artifactBytes = "Approved story bytes.\n";
  const questionBytes = "Approve this story?\n";
  const snapshot = {
    question_ref: questionRef,
    question_hash: hashBytes(questionBytes),
    artifact_ref: artifactRef,
    artifact_hash: hashBytes(artifactBytes),
    answer_ref: pendingAnswerRef,
    created_at: NOW,
  };
  const pending = variant === "pending";
  const interactive = variant === "approved-interactive";
  const status = variant.startsWith("approved") ? "approved" : variant;
  const answer = status === "approved" ? "approve" : status === "changes_requested" ? "changes: revise scope" : status === "stopped" ? "stop" : null;
  const answerBytes = pending ? null : `${answer}\n`;
  const answerRef = pending ? pendingAnswerRef : `${pendingAnswerRef}.consumed-1`;
  const source = pending
    ? { status, artifact: artifactRef, question_ref: questionRef, answer_ref: answerRef, pending_snapshot: snapshot }
    : { status, artifact: artifactRef, question_ref: questionRef, answer_ref: answerRef, approval_source: "external-driver", answered_at: NOW, answer, pending_snapshot: snapshot };
  if (interactive) {
    const receipt = {
      schema_version: 1,
      kind: "interactive-approval-handoff",
      gate: "story",
      approval_fingerprint: "",
      pending_snapshot_hash: hashCanonical(snapshot),
      answer_hash: hashBytes(answerBytes),
      steering_generation: 2,
      accepted_at: NOW,
    };
    receipt.approval_fingerprint = hashCanonical({
      gate: "story", status: source.status, artifact: source.artifact, question_ref: source.question_ref,
      answer_ref: source.answer_ref, answer: source.answer, approval_source: source.approval_source,
      decision_note: null, answered_at: source.answered_at, pending_snapshot_hash: receipt.pending_snapshot_hash,
      answer_hash: receipt.answer_hash, steering_generation: receipt.steering_generation, accepted_at: receipt.accepted_at,
    });
    source.handoff_receipt = receipt;
  }
  const externalSources = {
    artifact: { ref: artifactRef, bytes: artifactBytes },
    question: { ref: questionRef, bytes: questionBytes },
    answer: { ref: answerRef, bytes: answerBytes },
  };
  const sidecars = [
    externalSidecar("artifact", ["pending_snapshot", "artifact_ref"], ["pending_snapshot", "artifact_hash"]),
    externalSidecar("question", ["pending_snapshot", "question_ref"], ["pending_snapshot", "question_hash"]),
  ];
  const targets = [
    time(["pending_snapshot", "created_at"]),
    ...externalSidecarTargets("artifact", ["pending_snapshot", "artifact_ref"], ["pending_snapshot", "artifact_hash"]),
    ...externalSidecarTargets("question", ["pending_snapshot", "question_ref"], ["pending_snapshot", "question_hash"]),
    drift(["pending_snapshot"], "artifact_ref", "artifact"),
    stale(["status"], pending ? "approved" : "pending"),
    cross(["answer_ref"], "gates/brief.answer.consumed-1"),
  ];
  if (!pending) {
    const answerHashPath = interactive ? ["handoff_receipt", "answer_hash"] : null;
    sidecars.push(externalSidecar("answer", ["answer_ref"], answerHashPath));
    targets.push(time(["answered_at"]), ...externalSidecarTargets("answer", ["answer_ref"], answerHashPath));
  }
  if (interactive) {
    targets.push(
      schema(["handoff_receipt", "schema_version"]),
      kind(["handoff_receipt", "kind"], "approval"),
      time(["handoff_receipt", "accepted_at"]),
      hash(["handoff_receipt", "pending_snapshot_hash"], "pending-snapshot"),
    );
  }
  return recordEntry({
    authorityClassId: "gates-snapshot-handoff", id, record: "run.json.gates.story", variant,
    writer: pending ? "transitionGateDecision pending transition" : "transitionGateDecision checked decision transition",
    readers: ["validateRun gate validation", "transitionGateDecision decision admission", "approval handoff eligibility", "resume and protected-gate readers"],
    canonicalPath: ["gates", "story"], source, externalSources, sidecars,
    facts: [
      fact(["status"], status), fact(["artifact"], artifactRef), fact(["question_ref"], questionRef), fact(["answer_ref"], answerRef),
      fact(["pending_snapshot", "question_ref"], questionRef), fact(["pending_snapshot", "question_hash"], snapshot.question_hash),
      fact(["pending_snapshot", "artifact_ref"], artifactRef), fact(["pending_snapshot", "artifact_hash"], snapshot.artifact_hash),
      fact(["pending_snapshot", "answer_ref"], pendingAnswerRef), fact(["pending_snapshot", "created_at"], NOW),
      ...(!pending ? [fact(["answer"], answer), fact(["approval_source"], "external-driver"), fact(["answered_at"], NOW)] : []),
      ...(interactive ? [
        fact(["handoff_receipt", "kind"], "interactive-approval-handoff"), fact(["handoff_receipt", "gate"], "story"),
        fact(["handoff_receipt", "pending_snapshot_hash"], source.handoff_receipt.pending_snapshot_hash),
        fact(["handoff_receipt", "answer_hash"], source.handoff_receipt.answer_hash),
        fact(["handoff_receipt", "steering_generation"], 2), fact(["handoff_receipt", "accepted_at"], NOW),
      ] : []),
    ],
    requiredPath: ["status"], typePath: pending ? ["pending_snapshot"] : ["approval_source"], targets,
  });
}

function stepEntry(id, variant) {
  const status = variant === "inherited-acceptance" ? "accepted" : variant;
  const source = { agent: "spec-writer", status, attempts: 1 };
  const targets = [stale(["attempts"], 0), cross(["agent"], "security-reviewer")];
  let sidecars = [];
  let externalSources = {};
  if (["rejected", "blocked", "accepted", "inherited-acceptance"].includes(variant)) {
    source.artifact_ref = "artifacts/technical-brief.md";
    source.review_ref = "reviews/spec-writer.json";
    targets.push(ref(["artifact_ref"]), ref(["review_ref"]));
  }
  if (["accepted", "inherited-acceptance"].includes(variant)) {
    const artifactBytes = "Canonical technical brief.\n";
    const reviewBytes = "{\"verdict\":\"APPROVE\"}\n";
    source.acceptance = {
      artifact_ref: source.artifact_ref,
      artifact_hash: hashBytes(artifactBytes),
      review_ref: source.review_ref,
      review_hash: hashBytes(reviewBytes),
    };
    externalSources = {
      artifact: { ref: source.artifact_ref, bytes: artifactBytes },
      review: { ref: source.review_ref, bytes: reviewBytes },
    };
    sidecars = [
      externalSidecar("artifact", ["acceptance", "artifact_ref"], ["acceptance", "artifact_hash"]),
      externalSidecar("review", ["acceptance", "review_ref"], ["acceptance", "review_hash"]),
    ];
    targets.push(
      ...externalSidecarTargets("artifact", ["acceptance", "artifact_ref"], ["acceptance", "artifact_hash"]),
      ...externalSidecarTargets("review", ["acceptance", "review_ref"], ["acceptance", "review_hash"]),
      drift(["acceptance"], "artifact_ref", "artifact"),
    );
  }
  if (variant === "inherited-acceptance") {
    source.inherited_acceptance = {
      from_run_id: "parent-run",
      parent_spec_review_ref: "reviews/spec-writer.json",
      artifact_hash: source.acceptance.artifact_hash,
      review_hash: source.acceptance.review_hash,
    };
    targets.push(
      target("wrong-hash", ["inherited_acceptance", "artifact_hash"], "inherited artifact hash", { value: WRONG_HASH_A, sidecar: "artifact" }),
      target("wrong-hash", ["inherited_acceptance", "review_hash"], "inherited review hash", { value: WRONG_HASH_A, sidecar: "review" }),
      target("wrong-ref", ["inherited_acceptance", "parent_spec_review_ref"], "parent review ref", { value: "../outside.json", sidecar: "review" }),
      stale(["inherited_acceptance", "from_run_id"], "stale-parent"),
    );
  }
  return recordEntry({
    authorityClassId: "steps-acceptance-inheritance", id, record: "run.json.steps[]", variant,
    writer: variant === "inherited-acceptance" ? "adoptContinuation checked adoption transition through transitionRunStep" : "transitionRunStep checked step transition",
    readers: ["validateRun step validation", "workflow dispatch/acceptance routing", "test-verifier and continuation eligibility readers"],
    canonicalPath: ["steps", 0], source, externalSources, sidecars,
    facts: [
      fact(["agent"], "spec-writer"), fact(["status"], status), fact(["attempts"], 1),
      ...("artifact_ref" in source ? [fact(["artifact_ref"], source.artifact_ref), fact(["review_ref"], source.review_ref)] : []),
      ...(source.acceptance ? [
        fact(["acceptance", "artifact_ref"], source.acceptance.artifact_ref), fact(["acceptance", "artifact_hash"], source.acceptance.artifact_hash),
        fact(["acceptance", "review_ref"], source.acceptance.review_ref), fact(["acceptance", "review_hash"], source.acceptance.review_hash),
      ] : []),
      ...(source.inherited_acceptance ? [
        fact(["inherited_acceptance", "from_run_id"], "parent-run"),
        fact(["inherited_acceptance", "parent_spec_review_ref"], "reviews/spec-writer.json"),
        fact(["inherited_acceptance", "artifact_hash"], source.inherited_acceptance.artifact_hash),
        fact(["inherited_acceptance", "review_hash"], source.inherited_acceptance.review_hash),
      ] : []),
    ],
    requiredPath: ["agent"], typePath: ["attempts"], targets,
  });
}

function testExecutionClaimEntry(id, variant) {
  const completed = variant.startsWith("completed-");
  const unknown = variant.startsWith("unknown-");
  const status = completed && variant.endsWith("fail") ? "fail" : "pass";
  const receipt = completed ? testExecutionReceipt(status === "pass" ? "pass" : "failed-nonzero-exit") : null;
  const receiptBytes = receipt ? `${JSON.stringify(receipt)}\n` : null;
  const claim = {
    schema_version: 1, kind: "checked-test-execution-claim", state: completed ? "completed" : unknown ? "unknown" : "active",
    nonce: TEST_EXECUTION_NONCE, run_id: "catalog-run", attempt: 1, plan_ref: "plan/slices.json", plan_hash: hashBytes(PLAN_V2_EXTERNAL.plan.bytes),
    head_sha: SHA_B, timeout_ms: PLAN_V2.integration_gate.timeout_ms, receipt_ref: "evidence/test-verifier.attempt-1.json", claimed_at: NOW,
  };
  if (completed) Object.assign(claim, { completed_at: NOW, status, receipt_hash: hashBytes(receiptBytes) });
  if (unknown) Object.assign(claim, { failed_at: NOW, reason: variant.slice("unknown-".length) });
  const source = {
    agent: "test-verifier", status: completed && status === "fail" ? "rejected" : "running", attempts: 1,
    execution_claim: claim, execution_claim_hash: hashCanonical(claim),
  };
  const externalSources = completed ? { receipt: { ref: claim.receipt_ref, bytes: receiptBytes } } : {};
  if (completed) source.evidence_ref = claim.receipt_ref;
  const sidecars = completed ? [externalSidecar("receipt", ["evidence_ref"], ["execution_claim", "receipt_hash"])] : [];
  const targets = [
    schema(["execution_claim", "schema_version"]), kind(["execution_claim", "kind"], "other-claim"),
    time(["execution_claim", "claimed_at"]), ...(completed || unknown ? [time(["execution_claim", completed ? "completed_at" : "failed_at"])] : []),
    ref(["execution_claim", "plan_ref"]), ref(["execution_claim", "receipt_ref"]), hash(["execution_claim", "plan_hash"]),
    drift(["execution_claim"], "state", "claim_state"), stale(["execution_claim", "attempt"], 2), stale(["execution_claim", "head_sha"], SHA_A),
    cross(["execution_claim", "nonce"], "223e4567-e89b-42d3-a456-426614174000"),
    cross(["execution_claim", "state"], completed ? "active" : unknown ? "active" : "unknown"),
    cross(["execution_claim", "run_id"], "other-run"),
    ...(completed ? [cross(["execution_claim", "status"], status === "pass" ? "fail" : "pass")] : []),
    ...(unknown ? [cross(["execution_claim", "reason"], variant.endsWith("authority-changed") ? "process-outcome-indeterminate" : "authority-changed")] : []),
    ...(completed ? externalSidecarTargets("receipt", ["evidence_ref"], ["execution_claim", "receipt_hash"]) : []),
  ];
  return recordEntry({
    authorityClassId: "steps-acceptance-inheritance", id, record: "run.json.steps[].execution_claim", variant,
    writer: completed ? "completeCheckedTestExecution protected completion transition" : unknown ? "markCheckedTestExecutionUnknown protected terminal claim transition" : "claimCheckedTestExecution protected active claim transition",
    readers: [
      "executeCheckedTestExecution replay and retry refusal", "schema-v2 generic test-verifier acceptance",
      "assertV2FreshDownstreamAuthority panels/gates/fence/PR consumers", "validateRun sibling execution_claim_hash binding",
      ...(!completed ? ["transitionRecoverOrphan public fail-closed recovery refusal"] : []),
      ...(!completed ? ["cleanupRun and cleanupRunLocked fail-closed cleanup refusal"] : []),
    ],
    tests: [
      `test/durable-record-mutations.test.js: ${id} mutation matrix`,
      "test/durable-record-mutations.test.js: executes every generated checked execution claim mutation through production consumers",
      ...(!completed ? ["test/durable-record-mutations.test.js: routes canonical and generated active/unknown claims through cleanup refusal"] : []),
      ...(completed && status === "pass" ? ["test/durable-record-mutations.test.js: rejects checked claim cross-bindings at panel, gate, fence, and PR consumers"] : []),
    ],
    canonicalPath: ["steps", 0], source, externalSources, sidecars, facts: exactFacts(source),
    requiredPath: ["execution_claim", "state"], unknownPath: ["execution_claim"], typePath: ["execution_claim", "timeout_ms"],
    targets: [...targets, hash(["execution_claim_hash"])],
  });
}

function testExecutionReceiptEntry(id, variant) {
  const source = testExecutionReceipt(variant);
  return recordEntry({
    authorityClassId: "steps-acceptance-inheritance", id, record: "evidence/test-verifier.attempt-N.json", variant,
    writer: "completeCheckedTestExecution create-only factory receipt publication",
    readers: ["completeCheckedTestExecution protected completion transition", "executeCheckedTestExecution completed replay", "transitionRunStep schema-v2 generic acceptance"],
    tests: [
      `test/durable-record-mutations.test.js: ${id} mutation matrix`,
      "test/durable-record-mutations.test.js: executes every generated checked receipt mutation through production completion, replay, and applicable acceptance consumers",
    ],
    canonicalPath: ["evidence", "test-verifier.attempt-1.json"], source, facts: exactFacts(source),
    requiredPath: ["kind"], typePath: ["timeout_ms"],
    targets: [schema(["schema_version"]), kind(["kind"], "other-receipt"), time(["completed_at"]), ref(["plan_ref"]), hash(["plan_hash"]), drift([], "kind", "record_kind"), stale(["head_sha"], SHA_A), cross(["run_id"], "other-run")],
  });
}

function testExecutionReceipt(variant) {
  const result = {
    index: 0, program: "npm", args: ["run", "check"], outcome: "exited", status: "pass", exit_code: 0, signal: null, error_code: null,
    duration_ms: 1, stdout: EMPTY_STREAM, stderr: EMPTY_STREAM,
  };
  if (variant === "failed-nonzero-exit") Object.assign(result, { status: "fail", exit_code: 7 });
  if (variant === "failed-signal") Object.assign(result, { outcome: "signaled", status: "fail", exit_code: null, signal: "SIGTERM" });
  if (variant === "failed-launch-error") Object.assign(result, { outcome: "launch-error", status: "fail", exit_code: null, error_code: "spawn-failed" });
  if (variant === "failed-timeout") Object.assign(result, { outcome: "timeout", status: "fail", exit_code: null, signal: "SIGKILL" });
  if (variant === "failed-output-limit") Object.assign(result, { outcome: "output-limit", status: "fail", exit_code: null, signal: "SIGKILL", stdout: TRUNCATED_STREAM });
  const passing = variant === "pass";
  return {
    schema_version: 1, kind: "checked-test-execution-receipt", subject: "test-verifier", run_id: "catalog-run", attempt: 1,
    claim_nonce: TEST_EXECUTION_NONCE, plan_ref: "plan/slices.json", plan_hash: hashBytes(PLAN_V2_EXTERNAL.plan.bytes), head_sha: SHA_B,
    timeout_ms: PLAN_V2.integration_gate.timeout_ms,
    started_at: NOW, completed_at: NOW, duration_ms: 1, status: passing ? "pass" : "fail", review_ready: passing, commands: [result],
  };
}

function checkpointProgressEntry(id, state) {
  const source = structuredClone(CHECKPOINT_PROGRESS[state]);
  const entry = source.entries[0];
  return recordEntry({
    authorityClassId: "plan-slices-graph",
    id,
    record: "run.json.checkpoint_progress",
    variant: state,
    writer: state === "reserved"
      ? "transitionCheckpointProgressReserved"
      : state === "child-published"
        ? "transitionCheckpointProgressChildPublished"
        : state === "launched"
          ? "transitionCheckpointProgressLaunched"
          : state === "merged"
            ? "transitionCheckpointProgressMerged"
            : "transitionCheckpointProgressClosed",
    readers: [
      "validateCheckpointProgress",
      "validateRun blocked routing parent",
      "factory checkpoint-start sequencing and replay",
      ...(state === "merged" ? ["factory checkpoint-record-merged replay", "factory checkpoint-close", "assertCheckpointCleanupEligible"] : []),
      ...(state === "closed" ? ["factory checkpoint-close exact replay", "checkpoint route audit"] : []),
    ],
    canonicalPath: ["checkpoint_progress"],
    source,
    facts: exactFacts(source),
    requiredPath: ["status"],
    unknownPath: [],
    typePath: ["entries"],
    targets: [
      schema(["schema_version"]),
      kind(["kind"], "other-progress"),
      time(state === "closed" ? ["final_closure", "closed_at"] : ["entries", 0, state === "reserved" ? "reserved_at" : state === "child-published" ? "published_at" : state === "launched" ? "launched_at" : "merged_at"]),
      ref(["manifest_ref"]),
      hash(["manifest_hash"]),
      drift(entry ? ["entries", 0] : [], "state", "progress_state"),
      stale(state === "closed" ? ["status"] : ["entries", 0, "ordinal"], state === "closed" ? "active" : 0),
      cross(["entries", 0, "root_child_run_id"], "other-child"),
    ],
  });
}

function verificationArtifactClaimEntry(id, variant) {
  const source = structuredClone(VERIFICATION_ARTIFACT_CLAIM_BASE);
  const completed = variant.startsWith("completed-");
  const unknown = variant.startsWith("unknown-");
  source.state = completed ? "completed" : unknown ? "unknown" : "active";
  if (completed) {
    const receipt = variant.endsWith("pass") ? VERIFICATION_ARTIFACT_RECEIPT_PASS : INVARIANT_RECEIPT;
    Object.assign(source, { completed_at: NOW, status: receipt.status, receipt_hash: hashBytes(`${JSON.stringify(receipt)}\n`) });
  }
  if (unknown) {
    Object.assign(source, { failed_at: NOW, reason: variant === "unknown-process" ? "process-outcome-indeterminate" : "receipt-publication-indeterminate" });
    if (variant === "unknown-receipt") Object.assign(source, { status: INVARIANT_RECEIPT.status, receipt_hash: hashBytes(`${JSON.stringify(INVARIANT_RECEIPT)}\n`) });
  }
  return recordEntry({
    authorityClassId: "slices-review-evidence-bindings", id, record: "evidence/<slice>.artifact-<id>.attempt-N.claim.json", variant,
    writer: completed ? "completeCheckedVerificationArtifactExecution protected claim closure" : unknown ? "markCheckedVerificationArtifactExecutionUnknown protected fail-closed transition" : "claimCheckedVerificationArtifactExecution create-only pre-spawn publication",
    readers: ["validateVerificationArtifactExecutionClaim", "executeCheckedVerificationArtifact replay/retry refusal", "observeReviewExtensionEvidence", "evaluateInvariantFamilyReview completed claim authority"],
    canonicalPath: ["evidence", id], source, facts: exactFacts(source), requiredPath: ["state"], typePath: ["timeout_ms"],
    targets: [schema(["schema_version"]), kind(["kind"], "other-claim"), time([completed ? "completed_at" : unknown ? "failed_at" : "claimed_at"]), ref(["receipt_ref"]), target("wrong-hash", ["plan_hash"], "plan hash", { value: "sha256:invalid" }), drift([], "state", "claim_state"), stale(["attempt"], 0), cross(["verification_artifact_id"], "other-artifact")],
  });
}

function verificationArtifactReceiptEntry(id, variant) {
  const source = structuredClone(variant === "pass" ? VERIFICATION_ARTIFACT_RECEIPT_PASS : INVARIANT_RECEIPT);
  return recordEntry({
    authorityClassId: "slices-review-evidence-bindings", id, record: "evidence/<slice>.artifact-<id>.attempt-N.json", variant,
    writer: "completeCheckedVerificationArtifactExecution create-only receipt publication",
    readers: ["validateVerificationArtifactExecutionReceipt", "executeCheckedVerificationArtifact replay", "observeReviewExtensionEvidence", "evaluateInvariantFamilyReview exact claim/receipt authority"],
    canonicalPath: ["evidence", id], source, facts: exactFacts(source), requiredPath: ["kind"], typePath: ["timeout_ms"],
    targets: [schema(["schema_version"]), kind(["kind"], "other-receipt"), time(["completed_at"]), ref(["plan_ref"]), target("wrong-hash", ["plan_hash"], "plan hash", { value: "sha256:invalid" }), drift([], "kind", "record_kind"), stale(["attempt"], 0), cross(["verification_artifact_id"], "other-artifact")],
  });
}

function workDecomposerAcceptedEntry() {
  const source = {
    agent: "work-decomposer",
    status: "accepted",
    attempts: 1,
    artifact_ref: DECOMPOSITION_EXTERNAL.plan.ref,
    review_ref: DECOMPOSITION_EXTERNAL.review.ref,
    acceptance: {
      artifact_ref: DECOMPOSITION_EXTERNAL.plan.ref,
      artifact_hash: hashBytes(DECOMPOSITION_EXTERNAL.plan.bytes),
      review_ref: DECOMPOSITION_EXTERNAL.review.ref,
      review_hash: hashBytes(DECOMPOSITION_EXTERNAL.review.bytes),
    },
  };
  return recordEntry({
    authorityClassId: "steps-acceptance-inheritance",
    id: "step-work-decomposer-accepted-plan",
    record: "run.json.steps[].work-decomposer accepted plan binding",
    variant: "accepted exact plan and decomposition review",
    writer: "transitionRunStep checked work-decomposer acceptance",
    readers: ["test-verifier dispatch", "schema-v2 construction/publication/adoption/replay/resume", "schema-v2 downstream authority checks"],
    canonicalPath: ["steps", 0],
    source,
    externalSources: DECOMPOSITION_EXTERNAL,
    sidecars: [
      externalSidecar("plan", ["acceptance", "artifact_ref"], ["acceptance", "artifact_hash"]),
      externalSidecar("review", ["acceptance", "review_ref"], ["acceptance", "review_hash"]),
    ],
    facts: exactFacts(source),
    requiredPath: ["acceptance"],
    typePath: ["attempts"],
    targets: [
      ...externalSidecarTargets("plan", ["acceptance", "artifact_ref"], ["acceptance", "artifact_hash"]),
      ...externalSidecarTargets("review", ["acceptance", "review_ref"], ["acceptance", "review_hash"]),
      drift(["acceptance"], "artifact_ref", "artifact"),
      stale(["attempts"], 0),
      cross(["agent"], "test-verifier"),
    ],
  });
}

function sliceEntry(id, variant) {
  const status = variant === "blocked-ordinary" ? "blocked" : variant;
  const blocked = status === "blocked";
  const source = { id: "backend", stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status, attempts: variant === "pending" ? 0 : 1 };
  const targets = [stale(["attempts"], variant === "pending" ? 1 : 0), cross(["id"], "frontend")];
  let externalSources = {};
  const sidecars = [];
  const observations = [];
  if (variant !== "pending") {
    source.branch = "feature--backend";
    source.worktree = "/tmp/backend";
    source.authorized_baseline_commit = SHA_B;
    source.dispatch_required = true;
    source.dispatch_claim_ref = SLICE_DISPATCH_EXTERNAL.claim.ref;
    source.dispatch_claim_hash = hashBytes(SLICE_DISPATCH_EXTERNAL.claim.bytes);
    externalSources = { claim: SLICE_DISPATCH_EXTERNAL.claim };
    sidecars.push(externalSidecar("claim", ["dispatch_claim_ref"], ["dispatch_claim_hash"]));
    targets.push(...externalSidecarTargets("claim", ["dispatch_claim_ref"], ["dispatch_claim_hash"]), stale(["authorized_baseline_commit"], SHA_A, "stale authorized feature baseline"));
    observations.push({ name: "dispatch-claim-head", source: "claim", path: ["head"], expected: SHA_B, consumer: "checked slice dispatch and terminal/continuation unresolved-dispatch guard" });
    targets.push(ref(["worktree"]));
  }
  if (["review", "merged", "blocked", "blocked-ordinary"].includes(variant)) {
    const reviewSources = variant === "blocked"
      ? SLICE_NONCONVERGENCE_EXTERNAL
      : variant === "blocked-ordinary"
        ? SLICE_BLOCKED_EXTERNAL
        : { ...SLICE_EXTERNAL, ...SLICE_DISPATCH_EXTERNAL };
    const historyEntry = {
      attempt: 1,
      evidence_ref: reviewSources.evidence.ref,
      evidence_hash: hashBytes(reviewSources.evidence.bytes),
      review_ref: reviewSources.review.ref,
      review_hash: hashBytes(reviewSources.review.bytes),
      reviewed_commit: SHA_B,
      diff_base_commit: SHA_B,
      ratified_paths: [],
      verdict: blocked ? "REJECT" : "APPROVE",
      convergence: variant === "blocked" ? "nonconvergent" : "converging",
      late_discovery_strike: false,
      remaining_fix_count: blocked ? 1 : 0,
      dispatch_claim_ref: reviewSources.claim.ref,
      dispatch_claim_hash: hashBytes(reviewSources.claim.bytes),
      dispatch_closure_ref: reviewSources.closure.ref,
      dispatch_closure_hash: hashBytes(reviewSources.closure.bytes),
    };
    source.attempt_reviews = [historyEntry];
    source.dispatch_closure_ref = reviewSources.closure.ref;
    source.dispatch_closure_hash = hashBytes(reviewSources.closure.bytes);
    source.evidence_ref = reviewSources.evidence.ref;
    source.review_ref = reviewSources.review.ref;
    if (!blocked) {
      source.evidence_hash = historyEntry.evidence_hash;
      source.review_hash = historyEntry.review_hash;
    }
    source.reviewed_commit = SHA_B;
    if (blocked) delete source.reviewed_commit;
    externalSources = reviewSources;
    sidecars.push(externalSidecar("closure", ["dispatch_closure_ref"], ["dispatch_closure_hash"]));
    targets.push(...externalSidecarTargets("closure", ["dispatch_closure_ref"], ["dispatch_closure_hash"]));
    const evidenceRefPath = blocked ? ["attempt_reviews", 0, "evidence_ref"] : ["evidence_ref"];
    const evidenceHashPath = blocked ? ["attempt_reviews", 0, "evidence_hash"] : ["evidence_hash"];
    const reviewRefPath = blocked ? ["attempt_reviews", 0, "review_ref"] : ["review_ref"];
    const reviewHashPath = blocked ? ["attempt_reviews", 0, "review_hash"] : ["review_hash"];
    sidecars.push(externalSidecar("evidence", evidenceRefPath, evidenceHashPath), externalSidecar("review", reviewRefPath, reviewHashPath));
    targets.push(
      ...externalSidecarTargets("evidence", evidenceRefPath, evidenceHashPath),
      ...externalSidecarTargets("review", reviewRefPath, reviewHashPath),
      target("missing-key", ["attempt_reviews", 0, "late_discovery_strike"], "required late-discovery strike marker"),
      target("wrong-type", ["attempt_reviews", 0, "late_discovery_strike"], "boolean late-discovery strike marker"),
      stale(["attempt_reviews", 0, "late_discovery_strike"], true, "invalid strike timing or sidecar mismatch"),
      drift(["attempt_reviews", 0], "verdict", "attempt review result"),
      stale(["attempt_reviews", 0, "attempt"], 0, "stale attempt review"),
      cross(["attempt_reviews", 0, "reviewed_commit"], SHA_C, "cross-bound reviewed head"),
    );
    if (!blocked) targets.push(stale(["reviewed_commit"], SHA_A, "stale current reviewed head"));
    observations.push(
      { name: "evidence-head", source: "evidence", path: ["head_sha"], expected: SHA_B, consumer: "transitionRunSlice and PR readiness" },
      { name: "reviewed-commit", source: "review", path: ["reviewed_commit"], expected: SHA_B, consumer: "transitionRunSlice, transitionSliceMerged, and nonconvergence continuation" },
      { name: "dispatch-closure-claim", source: "closure", path: ["claim_hash"], expected: hashBytes(SLICE_DISPATCH_CLAIM_BYTES), consumer: "checked slice review and terminal/continuation unresolved-dispatch guard" },
    );
  }
  if (variant === "merged") {
    source.merge_commit = SHA_B;
    source.updated_at = NOW;
    targets.push(time(["updated_at"]));
  }
  if (variant === "blocked") source.blocked_reason = "slice-review-nonconvergent";
  if (variant === "blocked-ordinary") source.blocked_reason = "review rejected";
  return recordEntry({
    authorityClassId: "slices-review-evidence-bindings", id, record: "run.json.slices[]", variant,
    writer: variant === "merged" ? "transitionSliceMerged checked transition" : variant === "pending" ? "factory slices-seed checked transition" : "transitionRunSlice checked transition",
    readers: variant === "pending"
      ? ["validateRun slice validation", "builder-wave dependency scheduler", "transitionSliceMerged", "PR readiness and repair admission readers"]
      : ["validateRun slice validation", "checked builder dispatch claim/closure publication", "transitionRunSlice review/history and commit-bound retry", "terminal/continuation unresolved-dispatch guard", "transitionSliceMerged and PR readiness"],
    canonicalPath: ["slices", 0], source,
    ...(variant === "blocked-ordinary" ? { tests: [
      "test/durable-record-mutations.test.js: slice-blocked-ordinary mutation matrix",
      "test/durable-record-mutations.test.js: executes every ordinary blocked-slice mutation through production authority consumers",
    ] } : {}),
    ...(Object.keys(externalSources).length ? { externalSources, sidecars, observations } : {}),
    facts: exactFacts(source),
    requiredPath: ["id"], typePath: ["attempts"], targets,
  });
}

function sidecarRecord(authorityClassId, id, record, variant, writer, readers, refValue, sidecarBytes) {
  const source = { subject: "backend", attempt: 1, ref: refValue, hash: hashBytes(sidecarBytes) };
  const externalSources = { sidecar: { ref: refValue, bytes: sidecarBytes } };
  return recordEntry({
    authorityClassId, id, record, variant, writer, readers,
    source, externalSources,
    requiredPath: ["subject"], typePath: ["attempt"], sidecars: [externalSidecar("sidecar", ["ref"], ["hash"])],
    targets: [...externalSidecarTargets("sidecar", ["ref"], ["hash"]), stale(["attempt"], 0), cross(["subject"], "other-subject")],
  });
}

function panelEntry(id, record, key, source) {
  const externalName = key === "validator" ? "validator" : "security";
  const externalSources = key === "validator"
    ? { report: PANEL_EXTERNAL.report, review: PANEL_EXTERNAL.validator }
    : { review: PANEL_EXTERNAL.security };
  source = {
    ...source,
    ...(key === "validator" ? { report_hash: hashBytes(PANEL_EXTERNAL.report.bytes) } : {}),
    review_hash: hashBytes(externalSources.review.bytes),
    reviewed_head_sha: SHA_B,
  };
  const targets = [
    ...externalSidecarTargets("review", ["review_ref"], ["review_hash"]),
    stale(["verdict"], key === "validator" ? "NO-GO" : "BLOCK"),
    stale(["reviewed_head_sha"], SHA_A, "stale reviewed integration head"),
    cross(["reviewed_head_sha"], SHA_C, "cross-bound reviewed integration head"),
  ];
  if (source.report) targets.push(...externalSidecarTargets("report", ["report"], ["report_hash"]));
  return recordEntry({
    authorityClassId: "validator-security-pr-result", id, record, variant: `${source.verdict} successor byte/head binding`,
    writer: "factory verdicts checked transition",
    readers: ["validateRun verdict validation", "transitionPanelVerdicts atomic publication", "assertPrCreatedReadiness ref/hash/head re-observation", "post-PR revalidation", "terminal/panel remediation routing"],
    canonicalPath: [key], source, externalSources,
    sidecars: [...(source.report ? [externalSidecar("report", ["report"], ["report_hash"])] : []), externalSidecar("review", ["review_ref"], ["review_hash"])],
    observations: [{ name: `${externalName}-reviewed-head`, source: "review", path: ["reviewed_head_sha"], expected: SHA_B, consumer: "transitionPanelVerdicts and PR readiness" }],
    facts: [fact(["verdict"], source.verdict), ...(source.report ? [fact(["report"], source.report), fact(["report_hash"], source.report_hash)] : []), fact(["review_ref"], source.review_ref), fact(["review_hash"], source.review_hash), fact(["reviewed_head_sha"], source.reviewed_head_sha)],
    requiredPath: ["verdict"], typePath: ["verdict"], targets,
  });
}

function steeringEntry(id, key) {
  const token = "dispatch-token-1";
  const source = key === "boundary"
    ? { kind: "dispatch", token, generation: 2, state_hash: HASH_A, created_at: NOW }
    : key === "action_claim"
      ? { kind: "dispatch", token, generation: 2, claimed_at: NOW }
      : { kind: "dispatch", token, generation: 2, outcome: "started", claimed_at: NOW, resolved_at: "2026-07-16T12:00:01.000Z" };
  const targets = [
    kind(["kind"], "unknown-action"),
    time([key === "boundary" ? "created_at" : key === "action_claim" ? "claimed_at" : "resolved_at"]),
    drift([], "token", "operation_token"),
    stale(["generation"], 1),
    cross(["token"], "other-operation-token"),
  ];
  if (key === "boundary") targets.push(hash(["state_hash"]));
  return recordEntry({
    authorityClassId: "validator-security-pr-result", id, record: `run.json.steering.${key}`, variant: key.replaceAll("_", "-"),
    writer: key === "boundary" ? "transitionSteeringBoundaryOpened" : key === "action_claim" ? "transitionSteeringBoundaryCrossed" : "transitionSteeringActionStarted",
    readers: ["validateSteering", "checked steering boundary/action transitions", "assertRunJsonWriterAllowed and external-effect admission"],
    canonicalPath: ["steering", key], source,
    facts: [
      fact(["kind"], "dispatch"), fact(["token"], token), fact(["generation"], 2),
      ...(source.state_hash ? [fact(["state_hash"], source.state_hash), fact(["created_at"], source.created_at)] : []),
      ...(source.claimed_at ? [fact(["claimed_at"], source.claimed_at)] : []),
      ...(source.outcome ? [fact(["outcome"], source.outcome), fact(["resolved_at"], source.resolved_at)] : []),
    ],
    requiredPath: ["token"], typePath: ["generation"], targets,
  });
}

function prFenceEntry() {
  const source = {
    token: "pr-fence-token-1",
    generation: 2,
    state_hash: HASH_A,
    created_at: NOW,
    operation_id: PR_OPERATION_ID,
    repository: "acme/repo",
    head_ref: "feature--catalog",
    head_sha: SHA_B,
    base_ref: "main",
    base_sha: SHA_A,
    draft: false,
  };
  return recordEntry({
    authorityClassId: "validator-security-pr-result", id: "steering-pr-fence", record: "run.json.steering.pr_fence", variant: "successor PR operation fence",
    writer: "transitionPrePrFenceEstablished from checked local/worktree/origin Git authority",
    readers: ["validateSteering successor fence validation", "transitionPrCreated and transitionPrePrFenceCleared checked GitHub reconciliation"],
    canonicalPath: ["steering", "pr_fence"], source, facts: exactFacts(source),
    requiredPath: ["operation_id"], typePath: ["draft"],
    targets: [time(["created_at"]), ref(["repository"]), hash(["state_hash"]), drift([], "operation_id", "operation"), stale(["head_sha"], SHA_A), cross(["operation_id"], `ffpr-v1-${"e".repeat(64)}`)],
  });
}

function continuationV2EnvelopeEntry() {
  const fixture = continuationV2CatalogFixture("continuation-v2-envelope");
  return recordEntry({
    authorityClassId: "continuation-v2-carry-forward", id: "continuation-v2-envelope", record: "run.json.continuation", variant: "schema-v2 carry-forward envelope",
    writer: "checked schema-v2 carry-forward publication",
    readers: ["validateContinuation", "feature command payload normalization", "continuation workflow routing"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, externalSources: fixture.externalSources, facts: exactFacts(fixture.source),
    requiredPath: ["kind"], typePath: ["operator_summary"],
    targets: [target("wrong-schema", ["schema_version"], "schema version", { value: 1 }), kind(["kind"], "resume"), time(["created_at"]), stale(["kind"], "existing-run-resume"), cross(["operator_summary"], "other run")],
  });
}

function continuationV2ParentEntry() {
  const fixture = continuationV2CatalogFixture("continuation-v2-parent-binding");
  return recordEntry({
    authorityClassId: "continuation-v2-carry-forward", id: "continuation-v2-parent-binding", record: "continuation.parent", variant: "blocked parent",
    writer: "checked schema-v2 parent admission",
    readers: ["validateContinuationParent", "factory continue source revalidation", "published carry-forward authority"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, externalSources: fixture.externalSources, facts: exactFacts(fixture.source),
    requiredPath: ["run_id"], typePath: ["status"], sidecars: [externalSidecar("parent-run", ["run_ref"], ["run_hash"])],
    targets: [...externalSidecarTargets("parent-run", ["run_ref"], ["run_hash"]), stale(["commit"], SHA_B), cross(["run_id"], "child-run")],
  });
}

function continuationV2ReviewEntry() {
  const fixture = continuationV2CatalogFixture("continuation-v2-selected-review");
  return recordEntry({
    authorityClassId: "continuation-v2-carry-forward", id: "continuation-v2-selected-review", record: "continuation.review", variant: "selected blocking review",
    writer: "checked schema-v2 selected-review admission",
    readers: ["validateContinuationReview", "validateContinuationSelectedReview", "continuation remediation decomposition"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, externalSources: fixture.externalSources, facts: exactFacts(fixture.source),
    requiredPath: ["kind"], typePath: ["required_fixes"], sidecars: [externalSidecar("selected-review", ["ref"], ["hash"])],
    targets: [kind(["kind"], "unknown-review"), ...externalSidecarTargets("selected-review", ["ref"], ["hash"]), stale(["verdict"], "APPROVE"), cross(["subject"], "other-branch")],
  });
}

function continuationV2TargetEntry() {
  const fixture = continuationV2CatalogFixture("continuation-v2-target-binding");
  return recordEntry({
    authorityClassId: "continuation-v2-carry-forward", id: "continuation-v2-target-binding", record: "continuation.target", variant: "fresh child target",
    writer: "checked schema-v2 child target allocation",
    readers: ["validateContinuationTarget", "feature command payload normalization", "child bootstrap and Git/worktree creation"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, facts: exactFacts(fixture.source),
    requiredPath: ["run_id"], typePath: ["base_commit"], targets: [ref(["worktree"]), stale(["base_commit"], SHA_B), cross(["run_id"], "parent-run")],
  });
}

function continuationV2ContextEntry(id, field, sourceName) {
  const fixture = continuationV2CatalogFixture(id);
  return recordEntry({
    authorityClassId: "continuation-v2-carry-forward", id, record: `continuation.${field}[]`, variant: `${sourceName} context binding`,
    writer: "checked schema-v2 parent context inventory",
    readers: ["validateContinuationRefHashArray", "feature command payload normalization", "continuation planning/remediation context loader"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, externalSources: fixture.externalSources, facts: exactFacts(fixture.source),
    requiredPath: ["kind"], typePath: ["kind"], sidecars: [externalSidecar(sourceName, ["ref"], ["hash"])],
    targets: [kind(["kind"], "other-kind"), ...externalSidecarTargets(sourceName, ["ref"], ["hash"]), stale(["hash"], HASH_B), cross(["ref"], `reviews/other-${sourceName}.json`)],
  });
}

function continuationV2RecordSource(id) {
  const fixture = continuationV2CatalogFixture(id);
  return { canonicalPath: fixture.canonicalPath, source: fixture.source, externalSources: fixture.externalSources, facts: exactFacts(fixture.source) };
}

function continuationV2CatalogFixture(id) {
  const parent = { run_id: "parent-run", status: "blocked", run_ref: CONTINUATION_V2_EXTERNAL.parentRun.ref, run_hash: hashBytes(CONTINUATION_V2_EXTERNAL.parentRun.bytes), branch: "parent", commit: SHA_A, worktree: "/tmp/parent" };
  const review = { kind: "validator", ref: CONTINUATION_V2_EXTERNAL.selectedReview.ref, hash: hashBytes(CONTINUATION_V2_EXTERNAL.selectedReview.bytes), subject: "parent", verdict: "NO-GO", summary: "Continue the blocked work.", required_fixes: ["fix"], source: "run.validator.review_ref" };
  const targetBinding = { run_id: "child-run", branch: "child", worktree: "/tmp/child", base_ref: "main", base_commit: SHA_A };
  const artifact = { kind: "technical_brief", ref: CONTINUATION_V2_EXTERNAL.artifact.ref, hash: hashBytes(CONTINUATION_V2_EXTERNAL.artifact.bytes) };
  const evidence = { kind: "evidence", ref: CONTINUATION_V2_EXTERNAL.evidence.ref, hash: hashBytes(CONTINUATION_V2_EXTERNAL.evidence.bytes) };
  const parentReview = { kind: "review", ref: CONTINUATION_V2_EXTERNAL.review.ref, hash: hashBytes(CONTINUATION_V2_EXTERNAL.review.bytes) };
  const selectedParentReview = { kind: "review", ref: review.ref, hash: review.hash };
  const policy = postPrPolicy(false);
  const continuation = {
    schema_version: 2, kind: "blocked-run-continuation", created_at: NOW, operator_summary: "Continue blocked run.",
    parent, review, target: targetBinding,
    parent_artifacts: [artifact], parent_evidence: [evidence], parent_reviews: [parentReview, selectedParentReview],
    planning_reuse: { eligible: true, spec_review_ref: parentReview.ref, spec_review_hash: parentReview.hash, spec_artifact_ref: artifact.ref, spec_artifact_hash: artifact.hash },
    configuration: { mode: "autonomous", github_account: null, pr_mode: "ready", max_parallel_slices: 3, max_retries: 3, post_pr_policy: policy },
    carry_forward: { scope: "full-remaining-plan", plan_ref: "plan/slices.json", plan_hash: HASH_A, start_commit: SHA_A, accepted_slices: [], remaining_slice_ids: ["slice"] },
  };
  const paths = {
    "continuation-v2-envelope": ["continuation"],
    "continuation-v2-parent-binding": ["continuation", "parent"],
    "continuation-v2-selected-review": ["continuation", "review"],
    "continuation-v2-target-binding": ["continuation", "target"],
    "continuation-v2-parent-artifact-sidecar": ["continuation", "parent_artifacts", 0],
    "continuation-v2-parent-evidence-sidecar": ["continuation", "parent_evidence", 0],
    "continuation-v2-parent-review-sidecar": ["continuation", "parent_reviews", 0],
    "continuation-v2-planning-reuse": ["continuation", "planning_reuse"],
  };
  const sources = {
    "continuation-v2-envelope": { "parent-run": CONTINUATION_V2_EXTERNAL.parentRun, "selected-review": CONTINUATION_V2_EXTERNAL.selectedReview, artifact: CONTINUATION_V2_EXTERNAL.artifact, evidence: CONTINUATION_V2_EXTERNAL.evidence, review: CONTINUATION_V2_EXTERNAL.review },
    "continuation-v2-parent-binding": { "parent-run": CONTINUATION_V2_EXTERNAL.parentRun },
    "continuation-v2-selected-review": { "selected-review": CONTINUATION_V2_EXTERNAL.selectedReview },
    "continuation-v2-parent-artifact-sidecar": { artifact: CONTINUATION_V2_EXTERNAL.artifact },
    "continuation-v2-parent-evidence-sidecar": { evidence: CONTINUATION_V2_EXTERNAL.evidence },
    "continuation-v2-parent-review-sidecar": { review: CONTINUATION_V2_EXTERNAL.review },
    "continuation-v2-planning-reuse": { review: CONTINUATION_V2_EXTERNAL.review, artifact: CONTINUATION_V2_EXTERNAL.artifact },
  };
  const canonicalPath = paths[id];
  if (!canonicalPath) throw new TypeError(`missing canonical schema-v2 continuation fixture for ${id}`);
  const run = {
    schema_version: 1, run_id: "child-run", mode: "autonomous", status: "running", base_ref: "main", base_commit: SHA_A,
    branch: "child", worktree: "/tmp/child", github_account: null, pr_mode: "ready", max_parallel_slices: 3, max_retries: 3, gates: {}, continuation,
    post_pr: { schema_version: 1, policy, phase: "disabled", attempt: 0, observation: null, remediation: null, evidence_refs: [], continuation_review: null, terminal_fact: null, pr_operation: null },
    slices: [{ id: "slice", stack: "backend", depends_on: [], declared_paths: ["README.md"], effective_paths: ["README.md"], status: "pending", attempts: 0 }],
    steps: [],
  };
  return { run, canonicalPath, source: structuredClone(valueAt(run, canonicalPath, id)), externalSources: structuredClone(sources[id] ?? {}) };
}

function postPrPhaseEntry(phase) {
  const fixture = postPrCatalogFixture(`post-pr-phase-${phase}`);
  const bindsCandidate = ["changes-observed", "committed", "revalidating", "validated", "push-pending", "remote-confirmed"].includes(phase);
  const sidecars = bindsCandidate ? [externalSidecar("remediation", ["remediation", "remediation_evidence_ref"], ["remediation", "remediation_evidence_hash"])] : [];
  const authorityTargets = bindsCandidate ? [
    ...externalSidecarTargets("remediation", ["remediation", "remediation_evidence_ref"], ["remediation", "remediation_evidence_hash"]),
    stale(["remediation", "candidate_head_sha"], SHA_C),
    cross(["remediation", "candidate_head_sha"], SHA_A, "cross-bound candidate head"),
  ] : [];
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: `post-pr-phase-${phase}`, record: "run.json.post_pr", variant: phase,
    writer: phase === "disabled" || phase === "awaiting-pr" ? "createPostPrState policy initialization" : phase === "observing" ? "transitionPrCreated or transitionPostPrState observation transition" : ["blocked", "needs-human", "succeeded"].includes(phase) ? "transitionPostPrTerminal checked terminal transition" : phase === "failure-recording" ? "transitionPostPrFailure checked failure admission" : "transitionPostPrState checked phase transition",
    readers: ["validatePostPr phase/state consistency", "assertPostPrPhaseTransition", "assertPostPrMonotonicState", "post-PR workflow dispatch decision", "transitionPostPrTerminal reason preconditions", "resume and heartbeat eligibility"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, externalSources: fixture.externalSources, sidecars, facts: exactFacts(fixture.source),
    requiredPath: ["phase"], typePath: ["attempt"], targets: [schema(["schema_version"]), stale(["attempt"], fixture.source.attempt === 0 ? 1 : 0), cross(["phase"], phase === "disabled" ? "observing" : "disabled"), ...authorityTargets],
  });
}

function postPrPolicyEntry(id, enabled) {
  const fixture = postPrCatalogFixture(id);
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: "run.json.post_pr.policy", variant: enabled ? "enabled" : "disabled",
    writer: "createPostPrState from effective start-time policy",
    readers: ["validatePostPrPolicy", "transitionPrCreated observation initialization", "all post-PR timing/retry/review decisions", "assertPostPrPhaseTransition immutable policy check"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, facts: exactFacts(fixture.source),
    requiredPath: ["enabled"], typePath: ["wait_ms"], targets: [stale(["max_transient_errors"], 1), cross(["review", "required"], !enabled), drift(["review"], "reviewer_login", "login")],
  });
}

function postPrNullEntry(id, record, key, phase, writer, readers) {
  const fixture = postPrCatalogFixture(id);
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: `run.json.${record}`, variant: "null",
    writer, readers,
    canonicalPath: fixture.canonicalPath, source: fixture.source, externalSources: fixture.externalSources, facts: exactFacts(fixture.source),
    requiredPath: [key], typePath: [key], targets: [stale(["phase"], fixture.source.phase === "observing" ? "awaiting-pr" : fixture.source.phase === "succeeded" ? "blocked" : "observing"), cross([key], { from_other_attempt: true })],
  });
}

function postPrObservationEntry() {
  const fixture = postPrCatalogFixture("post-pr-observation-active");
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: "post-pr-observation-active", record: "run.json.post_pr.observation", variant: "active non-null epoch",
    writer: "transitionPrCreated initialization and transitionPostPrState observations",
    readers: ["validatePostPrObservation", "assertPostPrMonotonicState", "transitionPostPrFailure source/replay checks", "transitionPostPrTerminal preconditions"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, facts: exactFacts(fixture.source),
    requiredPath: ["epoch"], typePath: ["poll_count"], targets: [time(["started_at"]), stale(["epoch"], 0), cross(["expected_head_sha"], SHA_B), drift([], "expected_head_sha", "head_sha")],
  });
}

function postPrObservationNestedEntry(kindName) {
  const id = `post-pr-observation-${kindName}`;
  const definitions = {
    "last-error": { record: "run.json.post_pr.observation.last_error", writer: "transitionPostPrState observation error transition", readers: ["validatePostPrLastError", "assertPostPrMonotonicState result identity", "transitionPostPrTerminal infrastructure/account preconditions", "post-PR retry scheduler"], requiredPath: ["class"], typePath: ["exit_code"], targets: [time(["occurred_at"]), stale(["next_retry_at"], NOW), cross(["class"], "account-auth")] },
    "review-request": { record: "run.json.post_pr.observation.review_request", writer: "transitionPostPrState reviewer-request transition", readers: ["validatePostPrReviewRequest", "assertMonotonicReviewerRequest", "post-PR review observation scheduler", "transitionPostPrTerminal review preconditions"], requiredPath: ["status"], typePath: ["attempts"], targets: [time(["requested_at"]), stale(["attempts"], 0), cross(["status"], "pending")] },
    snapshot: { record: "run.json.post_pr.observation.snapshot", writer: "transitionPostPrState sanitized observation binding", readers: ["validatePostPrSanitizedSnapshot", "observationResultIdentity", "post-PR fingerprint/backoff decision", "terminal metadata safety decision"], requiredPath: ["checks"], typePath: ["reviews"], targets: [drift([], "checks", "check_results"), stale(["checks", 0, "verdict"], "pending"), cross(["reviews", 0, "login"], "other-reviewer")] },
  };
  const definition = definitions[kindName];
  const fixture = postPrCatalogFixture(id);
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: definition.record, variant: "non-null",
    writer: definition.writer, readers: definition.readers, canonicalPath: fixture.canonicalPath, source: fixture.source, facts: exactFacts(fixture.source), requiredPath: definition.requiredPath, typePath: definition.typePath, targets: definition.targets,
  });
}

function postPrRemediationEntry() {
  const fixture = postPrCatalogFixture("post-pr-remediation-active");
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: "post-pr-remediation-active", record: "run.json.post_pr.remediation", variant: "active non-null attempt",
    writer: "transitionPostPrFailure and transitionPostPrState",
    readers: ["validatePostPrRemediation", "assertPostPrAttemptTransition", "assertPostPrMonotonicState", "post-PR revalidation/push/terminal decisions"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, externalSources: fixture.externalSources, facts: exactFacts(fixture.source),
    requiredPath: ["attempt"], typePath: ["owner"], sidecars: [externalSidecar("failure-evidence", ["failure_evidence_ref"], ["failure_evidence_hash"]), externalSidecar("remediation", ["remediation_evidence_ref"], ["remediation_evidence_hash"])],
    targets: [schema(["schema_version"]), ...externalSidecarTargets("failure-evidence", ["failure_evidence_ref"], ["failure_evidence_hash"]), ...externalSidecarTargets("remediation", ["remediation_evidence_ref"], ["remediation_evidence_hash"]), kind(["owner", "kind"], "other-owner"), stale(["candidate_head_sha"], SHA_C), cross(["candidate_head_sha"], SHA_A, "cross-bound candidate head")],
  });
}

function postPrRemediationNestedEntry(kindName) {
  const id = `post-pr-remediation-${kindName}`;
  const definitions = {
    owner: { record: "run.json.post_pr.remediation.owner", writer: "transitionPostPrFailure owner attribution", readers: ["validatePostPrOwner", "post-PR route/lane dispatch decision", "assertPostPrMonotonicState owner immutability", "panel attribution and terminal owner safety decisions"], requiredPath: ["kind"], typePath: ["slice_id"], targets: [kind(["kind"], "integration"), stale(["slice_id"], "stale-slice"), cross(["stack"], "frontend")] },
    changes: { record: "run.json.post_pr.remediation.changes", writer: "transitionPostPrState observed changes transition", readers: ["validatePostPrChanges", "assertPostPrMonotonicState changes immutability", "post-PR lane ownership decision", "assertPostPrCandidateGitState", "terminal path-lane fact validation"], requiredPath: ["paths"], typePath: ["entries"], targets: [hash(["tree_hash"]), drift([], "paths", "changed_paths"), stale(["tree_hash"], HASH_B), cross(["paths", 0], "src/frontend.js")] },
    "change-entry": { record: "run.json.post_pr.remediation.changes.entries[]", writer: "transitionPostPrState Git-observed change entry binding", readers: ["validatePostPrChangeEntry", "post-PR safe change-kind decision", "owner lane/path validation", "candidate Git state and terminal path-lane fact readers"], requiredPath: ["path"], typePath: ["status"], targets: [ref(["path"], undefined, "changed path"), drift([], "previous_path", "old_path"), stale(["old_mode"], "120000"), cross(["path"], "src/frontend.js")] },
  };
  const definition = definitions[kindName];
  const fixture = postPrCatalogFixture(id);
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: definition.record, variant: "bound",
    writer: definition.writer, readers: definition.readers, canonicalPath: fixture.canonicalPath, source: fixture.source, facts: exactFacts(fixture.source), requiredPath: definition.requiredPath, typePath: definition.typePath, targets: definition.targets,
  });
}

function postPrDispatchEntry(id, variant) {
  const fixture = postPrCatalogFixture(id);
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: "run.json.post_pr.remediation.dispatch", variant,
    writer: "transitionPostPrState dispatch phase transition",
    readers: ["validatePostPrDispatch", "assertPostPrMonotonicState", "transitionPostPrTerminal dispatch-start reconciliation"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, facts: exactFacts(fixture.source),
    requiredPath: ["id"], typePath: ["status"], targets: [time([variant === "returned" ? "returned_at" : "started_at"], "not-started"), stale(["status"], variant === "planned" ? "running" : "planned"), cross(["subject"], "other-slice")],
  });
}

function postPrRevalidationEntry(id, bound) {
  const fixture = postPrCatalogFixture(id);
  const sidecars = bound ? [externalSidecar("canonical", ["canonical_evidence_ref"], ["canonical_evidence_hash"]), externalSidecar("validator", ["validator_review_ref"], ["validator_review_hash"]), externalSidecar("security", ["security_review_ref"], ["security_review_hash"])] : [];
  const targets = bound ? [...externalSidecarTargets("canonical", ["canonical_evidence_ref"], ["canonical_evidence_hash"]), ...externalSidecarTargets("validator", ["validator_review_ref"], ["validator_review_hash"]), ...externalSidecarTargets("security", ["security_review_ref"], ["security_review_hash"]), stale(["canonical_verdict"], "fail"), cross(["security_verdict"], "BLOCK")] : [stale(["canonical_verdict"], "pass"), cross(["validator_verdict"], "GO")];
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: "run.json.post_pr.remediation.revalidation", variant: bound ? "bound panel results" : "empty/unbound",
    writer: "transitionPostPrState revalidation transition",
    readers: ["validatePostPrRevalidation", "assertPostPrMonotonicState once-bound checks", "post-PR validated/push admission", "transitionPostPrTerminal panel-failure decisions"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, externalSources: fixture.externalSources, facts: exactFacts(fixture.source), requiredPath: ["canonical_verdict"], typePath: ["validator_verdict"], sidecars, targets,
  });
}

function postPrJobEntry(activity, state) {
  const id = `post-pr-${activity}-job-${state}`;
  const fixture = postPrCatalogFixture(id);
  const bound = state === "bound";
  const resultSidecars = bound ? [externalSidecar(`${activity}-result`, ["result_ref"], ["result_hash"])] : [];
  const targets = bound ? [...externalSidecarTargets(`${activity}-result`, ["result_ref"], ["result_hash"]), stale(["verdict"], activity === "canonical" ? "red" : activity === "validator" ? "NO-GO" : "BLOCK"), cross(["dispatch_id"], "other-dispatch")] : [time([state === "retry-wait" ? "next_retry_at" : "started_at"]), stale(["steering_generation"], state === "planned" ? 2 : 1), cross(["dispatch_id"], "other-dispatch")];
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: `run.json.post_pr.remediation.revalidation.jobs.${activity}`, variant: state,
    writer: "transitionPostPrState revalidation job transition",
    readers: ["validatePostPrJob", "assertPostPrJobMonotonic", "post-PR revalidation dispatch/retry scheduler", "validated-state admission", "transitionPostPrTerminal dispatch/panel fact checks"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, externalSources: fixture.externalSources, requiredPath: ["dispatch_id"], typePath: ["status"], sidecars: resultSidecars, facts: exactFacts(fixture.source), targets,
  });
}

function postPrPushEntry(id, status) {
  const fixture = postPrCatalogFixture(id);
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: "run.json.post_pr.remediation.push", variant: status,
    writer: "transitionPostPrState checked push transition",
    readers: ["validatePostPrPush", "assertPostPrMonotonicState", "transitionPostPrTerminal push reconciliation", "remote-confirmed observation restart"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, facts: exactFacts(fixture.source),
    requiredPath: ["status"], typePath: ["consecutive_transient_errors"], targets: [time(["pushed_at"], "not-time"), stale(["remote_before_sha"], status === "not-ready" ? SHA_A : SHA_C), cross(["local_head_sha"], SHA_C)],
  });
}

function postPrPushLastErrorEntry() {
  const fixture = postPrCatalogFixture("post-pr-push-last-error");
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: "post-pr-push-last-error", record: "run.json.post_pr.remediation.push.last_error", variant: "retryable network failure",
    writer: "transitionPostPrState checked push error transition",
    readers: ["validatePostPrPush last_error validation", "assertPostPrMonotonicState push retry checks", "post-PR push retry scheduler", "transitionPostPrTerminal push/account failure fact checks"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, facts: exactFacts(fixture.source),
    requiredPath: ["operation"], typePath: ["exit_code"], targets: [time(["observed_at"]), stale(["next_retry_at"], NOW), cross(["candidate_head_sha"], SHA_C)],
  });
}

function postPrEvidenceEntry() {
  const fixture = postPrCatalogFixture("post-pr-evidence-sidecar");
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: "post-pr-evidence-sidecar", record: "run.json.post_pr.evidence_refs[]", variant: "failure evidence ref/hash binding",
    writer: "transitionPostPrFailure or transitionPostPrState append",
    readers: ["assertPostPrRefsConsistent", "bindPostPrContinuationReview", "transitionPostPrTerminal"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, externalSources: fixture.externalSources, facts: exactFacts(fixture.source),
    requiredPath: ["ref"], typePath: ["hash"], sidecars: [externalSidecar("sidecar", ["ref"], ["hash"])],
    targets: [...externalSidecarTargets("sidecar", ["ref"], ["hash"]), stale(["hash"], HASH_B), cross(["ref"], "evidence/other-attempt.json")],
  });
}

function postPrContinuationReviewEntry() {
  const fixture = postPrCatalogFixture("post-pr-continuation-review-bound");
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id: "post-pr-continuation-review-bound", record: "run.json.post_pr.continuation_review", variant: "retry-exhaustion ref/hash bound",
    writer: "bindPostPrContinuationReview inside transitionPostPrTerminal",
    readers: ["validatePostPr retry-exhaustion consistency", "factory continue post-PR admission", "post-PR terminal audit readers"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, externalSources: fixture.externalSources, facts: exactFacts(fixture.source),
    requiredPath: ["ref"], typePath: ["hash"], sidecars: [externalSidecar("continuation-review", ["ref"], ["hash"])],
    targets: [...externalSidecarTargets("continuation-review", ["ref"], ["hash"]), stale(["hash"], HASH_B), cross(["ref"], "reviews/other-run.json")],
  });
}

function postPrTerminalFactEntry(factVariant) {
  const id = `post-pr-terminal-fact-${factVariant}`;
  const fixture = postPrCatalogFixture(id);
  const source = fixture.source;
  const crossDefinitions = {
    "account-switch-failed-github-auth": [["github_account"], "other-account"],
    "account-switch-failed-push": [["candidate_head_sha"], SHA_C],
    "dispatch-start-unknown": [["dispatch_id"], "other-dispatch"],
    "path-lane-violation": [["lane"], "test"],
    "remote-head-diverged": [["candidate_head_sha"], SHA_C],
    "panel-runner-result-malformed": [["dispatch_id"], "other-dispatch"],
    "push-failed": [["candidate_head_sha"], SHA_C],
    "panel-attribution-unsafe": [["panel"], "validator"],
  };
  return recordEntry({
    authorityClassId: "post-pr-nested-records", id, record: "run.json.post_pr.terminal_fact", variant: factVariant,
    writer: "normalizedPostPrTerminalFact inside transitionPostPrTerminal",
    readers: ["validatePostPrTerminalFact kind-specific validation", "transitionPostPrTerminal fact/reason preconditions", "terminal idempotent replay", "terminal diagnostics/audit readers"],
    canonicalPath: fixture.canonicalPath, source, facts: exactFacts(source),
    requiredPath: ["kind"], typePath: Object.hasOwn(source, "attempt") ? ["attempt"] : ["exit_code"], targets: [schema(["schema_version"]), kind(["kind"], "other-fact"), time(["observed_at"]), stale(Object.hasOwn(source, "attempt") ? ["attempt"] : ["exit_code"], 0), cross(...crossDefinitions[factVariant])],
  });
}

export function createPostPrCatalogBaseline(record) {
  const fixture = postPrCatalogFixture(record?.id);
  if (canonicalJson(record?.source) !== canonicalJson(fixture.source) || canonicalJson(record?.canonicalPath) !== canonicalJson(fixture.canonicalPath)) throw new TypeError(`${record?.id ?? "post-pr record"} does not match its canonical post-PR baseline fixture`);
  return structuredClone({ run: fixture.run, externalSources: postPrExternalSourcesFor(fixture.run.post_pr, "post-pr-baseline"), transitionOnly: fixture.transitionOnly ?? null });
}

export function createDurableCatalogBaseline(record) {
  if (!record || !CANONICAL_SOURCE_RECORD_ID_SET.has(record.id)) throw new TypeError("catalog baseline requires a registered canonical source row");
  if (["plan-slices-json", "plan-v2-integration-gate"].includes(record.id)) {
    return structuredClone({ consumer: "validateSlicesPlan", plan: record.source, externalSources: record.externalSources ?? {} });
  }
  if (record.id === "plan-delivery-envelope-v1") {
    return structuredClone({ consumer: "validateSlicesPlan", plan: JSON.parse(record.externalSources.plan.bytes), externalSources: record.externalSources });
  }
  if (record.id === "checkpoint-reviewed-plan-v1") {
    const plan = JSON.parse(record.externalSources.plan.bytes);
    plan.delivery_envelope.checkpoint_plan = structuredClone(record.source);
    return structuredClone({ consumer: "validateReviewedCheckpointPlan", checkpointPlan: record.source, plan, externalSources: record.externalSources });
  }
  if (record.id === "checkpoint-admission-probe-valid" || record.id === "checkpoint-child-disposition-v1") {
    const plan = JSON.parse(record.externalSources.plan.bytes);
    const review = JSON.parse(record.externalSources.review.bytes);
    if (record.id === "checkpoint-admission-probe-valid") review.admission_probe = structuredClone(record.source);
    else review.checkpoint_dispositions[0] = structuredClone(record.source);
    return structuredClone({
      consumer: "buildCheckpointRoutingManifest",
      probe: review.admission_probe,
      disposition: review.checkpoint_dispositions[0],
      plan,
      planHash: hashBytes(record.externalSources.plan.bytes),
      admissionResult: CHECKPOINT_ADMISSION,
      decompositionAuthority: {
        plan_ref: "plan/slices.json",
        plan_hash: hashBytes(record.externalSources.plan.bytes),
        review_ref: "reviews/work-decomposer.json",
        review_hash: hashBytes(record.externalSources.review.bytes),
        attempt: 1,
        review,
      },
      externalSources: record.externalSources,
    });
  }
  if (record.id === "checkpoint-routing-artifact-v1") {
    const plan = JSON.parse(record.externalSources.plan.bytes);
    const review = JSON.parse(record.externalSources.review.bytes);
    return structuredClone({
      consumer: "validateCheckpointRoutingManifest",
      manifest: record.source,
      plan,
      planHash: record.source.source.plan_hash,
      admissionResult: record.source.source.admission_result,
      decompositionAuthority: {
        plan_ref: record.source.source.plan_ref,
        plan_hash: record.source.source.plan_hash,
        review_ref: record.source.source.decomposition_review_ref,
        review_hash: record.source.source.decomposition_review_hash,
        attempt: record.source.source.decomposition_attempt,
        review,
      },
      externalSources: record.externalSources,
    });
  }
  if (record.id === "checkpoint-child-publication-v1") {
    return structuredClone({ consumer: "validateCheckpointChildPublication", publication: record.source, externalSources: {} });
  }
  if (record.id === "checkpoint-source-v1") {
    return structuredClone({ consumer: "validateCheckpointSource", checkpointSource: record.source, externalSources: record.externalSources });
  }
  if (record.id.startsWith("checkpoint-progress-") || record.id === "checkpoint-merged-completion-v1") {
    return structuredClone({ consumer: "validateCheckpointProgress", progress: record.source, externalSources: {} });
  }
  if (record.id === "checkpoint-final-closure-v1") {
    return structuredClone({ consumer: "validateDeliveryCheckpointFinalClosure", closure: record.source, externalSources: record.externalSources });
  }
  if (record.id === "review-invariant-family-ledger-v1") {
    return structuredClone({ consumer: "evaluateInvariantFamilyReview", ledger: record.source, plan: JSON.parse(record.externalSources.plan.bytes), externalSources: record.externalSources });
  }
  if (record.id.startsWith("verification-artifact-claim-")) {
    return structuredClone({ consumer: "validateVerificationArtifactExecutionClaim", claim: record.source, externalSources: {} });
  }
  if (record.id.startsWith("verification-artifact-execution-receipt-")) {
    return structuredClone({ consumer: "validateVerificationArtifactExecutionReceipt", receipt: record.source, externalSources: {} });
  }
  if (record.id === "final-plan-descriptor") {
    return structuredClone({ consumer: "final-plan-descriptor-contract", descriptor: record.source, externalSources: record.externalSources ?? {} });
  }
  if (record.id.startsWith("test-execution-receipt-")) {
    return structuredClone({ consumer: "validateTestExecutionReceipt", receipt: record.source, externalSources: {} });
  }
  if (record.authorityClassId === "post-pr-nested-records") {
    return { consumer: "validateRun/checkRunConsistency", ...createPostPrCatalogBaseline(record) };
  }
  if (record.authorityClassId === "pr79-merged-slice-repair") {
    if (AMENDMENT_MANIFEST_VARIANTS.some(([id]) => id === record.id)) {
      return structuredClone({ consumer: "validateIntegrationAmendment", amendment: record.source, externalSources: record.externalSources ?? {} });
    }
    if (AMENDMENT_CLAIM_VARIANTS.some(([id]) => id === record.id)) {
      return structuredClone({ consumer: "validateIntegrationAmendmentExecutionClaim", claim: record.source, externalSources: record.externalSources ?? {} });
    }
    if (AMENDMENT_RECEIPT_VARIANTS.some(([id]) => id === record.id)) {
      return structuredClone({ consumer: "validateIntegrationAmendmentExecutionReceipt", receipt: record.source, externalSources: {} });
    }
    if (["amendment-review-approve", "amendment-review-reject"].includes(record.id)) {
      return structuredClone({ consumer: "validateIntegrationAmendmentReview", review: record.source, externalSources: {} });
    }
    if (["amendment-dispatch-binding-active", "amendment-dispatch-binding-closed"].includes(record.id)) {
      return structuredClone({ consumer: "validateRun", run: { schema_version: 1, run_id: "catalog-run", status: "running", gates: {}, slices: [], steps: [], special_builder_dispatch: record.source }, externalSources: record.externalSources ?? {} });
    }
    if (record.id === "amendment-dispatch-claim") {
      return structuredClone({ consumer: "prepare/completeSpecialBuilderTaskDispatch", claim: record.source, externalSources: {} });
    }
    if (record.id === "amendment-dispatch-closure") {
      return structuredClone({ consumer: "prepare/completeSpecialBuilderTaskDispatch", closure: record.source, externalSources: record.externalSources ?? {} });
    }
    if (record.id === "amendment-review-dispatch-claim") {
      return structuredClone({ consumer: "validateIntegrationAmendmentReviewDispatchClaim", claim: record.source, expected: {
        claim_ref: AMENDMENT_REVIEW_CLAIM_REF, ...AMENDMENT_REVIEW_CLAIM,
      }, externalSources: {} });
    }
    if (record.id === "amendment-review-dispatch-closure") {
      return structuredClone({ consumer: "validateIntegrationAmendmentReviewDispatchClosure", closure: record.source, expected: {
        ...AMENDMENT_REVIEW_CLOSURE, completion_token_hash: AMENDMENT_REVIEW_CLAIM.completion_token_hash,
      }, externalSources: {} });
    }
    throw new TypeError(`unrecognized integration amendment catalog row ${record.id}`);
  }
  if (record.authorityClassId === "continuation-v2-carry-forward") {
    const fixture = continuationV2CatalogFixture(record.id);
    if (canonicalJson(record.source) !== canonicalJson(fixture.source) || canonicalJson(record.canonicalPath) !== canonicalJson(fixture.canonicalPath)) throw new TypeError(`${record.id} does not match its canonical continuation baseline fixture`);
    return structuredClone({ consumer: "validateRun", run: fixture.run, externalSources: fixture.externalSources });
  }
  return structuredClone({ consumer: "validateRun", run: canonicalRunFixture(record), externalSources: record.externalSources ?? {} });
}

export const ISSUE128_FINISH_AND_DISCLOSE_RECORD_IDS = Object.freeze([
  "slice-attempt-review-v2-reject",
  "slice-attempt-review-v2-approve-empty",
  "slice-attempt-review-v2-approve-unowned",
  "slice-attempt-review-v2-approve-sibling",
  "slice-modified-extension-unowned-v2",
  "slice-modified-extension-sibling-v2",
  "slice-running-with-v2-history",
  "slice-review-v2-reject",
  "slice-review-v2-approve-empty",
  "slice-review-v2-approve-unowned",
  "slice-review-v2-approve-sibling",
  "slice-merged-v2-approve-empty",
  "slice-merged-v2-unowned",
  "slice-merged-v2-sibling",
  "slice-blocked-ordinary-v2-history",
  "slice-blocked-nonconvergent-v2-history",
  "terminal-nonconvergence-v2-source-review",
  "continuation-carry-forward-accepted-slice-v2",
  "checkpoint-carry-forward-accepted-slice-v2",
  "amendment-owner-snapshot-v2-history",
]);

export const ISSUE128_BASELINE_ROUTE_INVENTORY = deepFreeze({
  "slice-attempt-review-v2-reject": { route: "durable-run-consistency", consumer: "issue128RunAuthorityFailures", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
  "slice-attempt-review-v2-approve-empty": { route: "durable-run-consistency", consumer: "issue128RunAuthorityFailures", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
  "slice-attempt-review-v2-approve-unowned": { route: "durable-run-consistency", consumer: "issue128RunAuthorityFailures", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
  "slice-attempt-review-v2-approve-sibling": { route: "durable-run-consistency", consumer: "issue128RunAuthorityFailures", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
  "slice-modified-extension-unowned-v2": { route: "durable-run-consistency", consumer: "issue128RunAuthorityFailures", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
  "slice-modified-extension-sibling-v2": { route: "durable-run-consistency", consumer: "issue128RunAuthorityFailures", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
  "slice-running-with-v2-history": { route: "durable-run-consistency", consumer: "issue128RunAuthorityFailures", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
  "slice-review-v2-reject": { route: "durable-run-consistency", consumer: "issue128RunAuthorityFailures", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
  "slice-review-v2-approve-empty": { route: "durable-run-consistency", consumer: "issue128RunAuthorityFailures", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
  "slice-review-v2-approve-unowned": { route: "durable-run-consistency", consumer: "issue128RunAuthorityFailures", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
  "slice-review-v2-approve-sibling": { route: "durable-run-consistency", consumer: "issue128RunAuthorityFailures", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
  "slice-merged-v2-approve-empty": { route: "durable-run-consistency", consumer: "issue128RunAuthorityFailures", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
  "slice-merged-v2-unowned": { route: "durable-run-consistency", consumer: "issue128RunAuthorityFailures", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
  "slice-merged-v2-sibling": { route: "durable-run-consistency", consumer: "issue128RunAuthorityFailures", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
  "slice-blocked-ordinary-v2-history": { route: "durable-run-consistency", consumer: "issue128RunAuthorityFailures", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
  "slice-blocked-nonconvergent-v2-history": { route: "durable-run-consistency", consumer: "issue128RunAuthorityFailures", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
  "terminal-nonconvergence-v2-source-review": { route: "durable-run-consistency", consumer: "issue128RunAuthorityFailures", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
  "continuation-carry-forward-accepted-slice-v2": { route: "ordinary-continuation", consumer: "continueFactory ordinary carry-forward authority", test: "test/factory-continue.test.js :: preserves an ordinary merged A2/S2 row only with its same-binding merged owner" },
  "checkpoint-carry-forward-accepted-slice-v2": { route: "checkpoint-continuation", consumer: "continueFactory checkpoint carry-forward authority", test: "test/factory-continue.test.js :: preserves a checkpoint-bound merged A2/S2 owner pair and rejects owner drift before publication" },
  "amendment-owner-snapshot-v2-history": { route: "durable-amendment-consistency", consumer: "assertIntegrationAmendmentConsistency", test: "test/durable-record-mutations.test.js :: executes every non-continuation baseline and physical mutation through production consistency" },
});

const ISSUE128_RUN_ID = "issue128-oracle";
const ISSUE128_BASE_COMMIT = "8b20ea435c507974bec4acb19f81e17969a8cf23";
const ISSUE128_OWNER_REVIEWED_COMMIT = "ff72597376c2c7c3771198a766a1ba1c049da558";
const ISSUE128_OWNER_MERGE_COMMIT = "84ae9626ea3f547d151a9bc024393e5737805355";
const ISSUE128_EMPTY_REVIEWED_COMMIT = "08f147e9f78c7a13c5b1e8159c6d85c8beb6a5fe";
const ISSUE128_EMPTY_MERGE_COMMIT = "cc372a426a85607b070337de5ddc601dc1604354";
const ISSUE128_UNOWNED_REVIEWED_COMMIT = "2ab370fb56a397c11c1dd1defe59203a1587797a";
const ISSUE128_UNOWNED_MERGE_COMMIT = "3b45f19f7ee2421894135a8dbd4462a49ead2209";
const ISSUE128_SIBLING_REVIEWED_COMMIT = "ddc920e780e08f2a3561d407b880f22a726b7c9d";
const ISSUE128_SIBLING_MERGE_COMMIT = "d209b10df237a6893c2aae54e4a36676588feda9";
const ISSUE128_AMENDMENT_REVIEWED_COMMIT = "d29a5e849c5c73bc0d8dfe723fb51578ee6dfc06";
const ISSUE128_AMENDMENT_MERGE_COMMIT = "32c7160a87fd07fb9125ca31af1e46123f1dbbef";
const ISSUE128_DECLARED_PATH = "src/consumer/**";
const ISSUE128_UNOWNED_PATH = "docs/consumer.md";
const ISSUE128_SIBLING_PATH = "src/owner/shared.js";
const ISSUE128_RATIONALE = "The checked consumer requires this exact pre-existing file modification.";
const ISSUE128_SIDECAR_HASHES = Object.freeze({
  owner: Object.freeze({ evidence: "sha256:be2cd6801d813141c52b486305dda0af5570fe71834b90b035bdb7ed934a6f0e", review: "sha256:41fe478c3b2b854c2efc3ca052944cdb2450d1b727158a7206383613ac1440e1", dispatch_claim: "sha256:7ba13019185455aa29441f78a45a201ed925e9d524b4bf54166d666a2ec6bc7f", dispatch_closure: "sha256:38be09b529ef2442de5d09ae042cd946780c912f1f4ea080406c77781af1caaf" }),
  amendment_owner: Object.freeze({ evidence: "sha256:1828ef4466b3255c8e5644bdf9b400928baaf6c33a4d4d31b26f1a6025b96059", review: "sha256:2534ed987cb961cd8805fc0e085bc63e99ab26fad3805b101102e6b2ce21338f", dispatch_claim: "sha256:7ba13019185455aa29441f78a45a201ed925e9d524b4bf54166d666a2ec6bc7f", dispatch_closure: "sha256:86a79d00f15a8ae493abf0499434b4ee8c8b6016f437423a6206d57369a6159e" }),
  empty: Object.freeze({ evidence: "sha256:cf4f5894bf53d3569d46a14a3a00f8d042975f20e49db36c1b57b4d05e1edd4b", review: "sha256:7b2d4317eb143421ebda160b63bcc6aa3a7d5747abd2e7a8e4749ab7e45b7807", dispatch_claim: "sha256:5aebc7a7e5941a7eae1f1d6f621e7c20a860f305760d8ab8ef6ea9fbe2c1c920", dispatch_closure: "sha256:947041102a28ae1bdb8b6f591559e66185d1a066625d6eba97a3b5f8221aa36e" }),
  reject: Object.freeze({ evidence: "sha256:cf4f5894bf53d3569d46a14a3a00f8d042975f20e49db36c1b57b4d05e1edd4b", review: "sha256:5ea9e7199f87afdfd90e4670d391e20d7d45999aa26121653e14525dc1af70d8", dispatch_claim: "sha256:5aebc7a7e5941a7eae1f1d6f621e7c20a860f305760d8ab8ef6ea9fbe2c1c920", dispatch_closure: "sha256:947041102a28ae1bdb8b6f591559e66185d1a066625d6eba97a3b5f8221aa36e" }),
  nonconvergent: Object.freeze({ evidence: "sha256:cf4f5894bf53d3569d46a14a3a00f8d042975f20e49db36c1b57b4d05e1edd4b", review: "sha256:d12407ae31d4ce32e36cb2fb113a80920f9818487c47ba313c857f5ae66ee48f", dispatch_claim: "sha256:5aebc7a7e5941a7eae1f1d6f621e7c20a860f305760d8ab8ef6ea9fbe2c1c920", dispatch_closure: "sha256:947041102a28ae1bdb8b6f591559e66185d1a066625d6eba97a3b5f8221aa36e" }),
  unowned: Object.freeze({ evidence: "sha256:b63d2a315c5ecaf2d4f9a6eafdaefc53f9fe29751c1bfc3a7c0f08f122911da9", review: "sha256:2014bdf7f14e57adb357f05dbd80ba693bb2dc9a15b2c7d5dfb08b08166edfe9", dispatch_claim: "sha256:5aebc7a7e5941a7eae1f1d6f621e7c20a860f305760d8ab8ef6ea9fbe2c1c920", dispatch_closure: "sha256:9ff26e0eeef27073ecc3dc35495c4b49b2acba684f87abcb5f7bfced163859fa" }),
  sibling: Object.freeze({ evidence: "sha256:949cd707025a38b5102cb598f3517acbccd1eda0e27258171592f6088303d4bb", review: "sha256:1c64ce25515121ab02e43f3711c7f50ef65b1196f509ed29ddd93842a6ec7d7e", dispatch_claim: "sha256:5aebc7a7e5941a7eae1f1d6f621e7c20a860f305760d8ab8ef6ea9fbe2c1c920", dispatch_closure: "sha256:c0a63e52c21eb07ed96c3d0618e275e5c6972685de27dadf4e7148f653ff8e0c" }),
});

const ISSUE128_READERS = Object.freeze({
  P: ["validateRun slice/history validator", "checked review publication", "checked retry dispatch", "review/history re-observation", "checked merge observation", "transitionSliceMerged"],
  C: ["ordinary carry-forward observation", "checkpoint carry-forward observation", "carry-forward candidate construction", "feature payload normalization", "child publication", "resume", "consistency readers"],
  N: ["slice nonconvergence terminalization", "terminal validation", "continuation source readers"],
  A: ["integration-amendment owner snapshot validation", "checked integration-amendment readers"],
  D: ["validateRun", "checkRunConsistency", "named checked transition or consumer"],
});

const ISSUE128_PRODUCTION_TESTS = Object.freeze({
  "slice-attempt-review-v2-reject": "test/run-state.test.js :: executes the closed issue-128 publication model and exact REJECT disclosure boundary",
  "slice-attempt-review-v2-approve-empty": "test/validate.test.js :: requires durable ownership and derives effective paths only from the current APPROVE",
  "slice-attempt-review-v2-approve-unowned": "test/run-state.test.js :: derives exact v2 authority for a disclosed content-only modification of a pre-existing unowned file",
  "slice-attempt-review-v2-approve-sibling": "test/run-state.test.js :: freezes sole non-touching sibling authority and defers modifying merge until that owner merges unchanged",
  "slice-modified-extension-unowned-v2": "test/run-state.test.js :: derives exact v2 authority for a disclosed content-only modification of a pre-existing unowned file",
  "slice-modified-extension-sibling-v2": "test/run-state.test.js :: re-derives every persisted v2 sibling authority field in history and consistency readers",
  "slice-running-with-v2-history": "test/run-state.test.js :: enforces slice lifecycle identity, attempts, rejected retries, blocking, and current sidecars",
  "slice-review-v2-reject": "test/run-state.test.js :: publishes a complete failing REJECT ledger without granting merge authority",
  "slice-review-v2-approve-empty": "test/validate.test.js :: requires durable ownership and derives effective paths only from the current APPROVE",
  "slice-review-v2-approve-unowned": "test/run-state.test.js :: derives exact v2 authority for a disclosed content-only modification of a pre-existing unowned file",
  "slice-review-v2-approve-sibling": "test/run-state.test.js :: freezes sole non-touching sibling authority and defers modifying merge until that owner merges unchanged",
  "slice-merged-v2-approve-empty": "test/run-state.test.js :: records slice merge after transition-time preconditions",
  "slice-merged-v2-unowned": "test/run-state.test.js :: derives exact v2 authority for a disclosed content-only modification of a pre-existing unowned file",
  "slice-merged-v2-sibling": "test/run-state.test.js :: freezes sole non-touching sibling authority and defers modifying merge until that owner merges unchanged",
  "slice-blocked-ordinary-v2-history": "test/run-state.test.js :: resets approved ratified ownership on review-to-blocked while rejecting caller-authored ownership",
  "slice-blocked-nonconvergent-v2-history": "test/slice-attempt-budget.test.js :: terminalizes an attempted retry from the exact nonconvergent review into checked carry-forward",
  "terminal-nonconvergence-v2-source-review": "test/slice-attempt-budget.test.js :: terminalizes an attempted retry from the exact nonconvergent review into checked carry-forward",
  "continuation-carry-forward-accepted-slice-v2": "test/factory-continue.test.js :: preserves an ordinary merged A2/S2 row only with its same-binding merged owner",
  "checkpoint-carry-forward-accepted-slice-v2": "test/factory-continue.test.js :: preserves a checkpoint-bound merged A2/S2 owner pair and rejects owner drift before publication",
  "amendment-owner-snapshot-v2-history": "test/run-state.test.js :: denies every applicable owner U2 field drift in integration amendment consistency",
});

function issue128ProductionTests(id) {
  const test = ISSUE128_PRODUCTION_TESTS[id];
  if (!test) throw new TypeError(`issue #128 row '${id}' has no production consumer test`);
  return [test];
}

function issue128Readers(...groups) {
  return [...new Set(groups.flatMap((group) => ISSUE128_READERS[group]))];
}

function issue128ExternalSources(variant = "empty") {
  const owner = variant === "owner" || variant === "amendment_owner";
  const subject = owner ? "owner" : "consumer";
  const reviewedCommit = {
    owner: ISSUE128_OWNER_REVIEWED_COMMIT,
    amendment_owner: ISSUE128_AMENDMENT_REVIEWED_COMMIT,
    empty: ISSUE128_EMPTY_REVIEWED_COMMIT,
    reject: ISSUE128_EMPTY_REVIEWED_COMMIT,
    nonconvergent: ISSUE128_EMPTY_REVIEWED_COMMIT,
    unowned: ISSUE128_UNOWNED_REVIEWED_COMMIT,
    sibling: ISSUE128_SIBLING_REVIEWED_COMMIT,
  }[variant];
  const verdict = ["reject", "nonconvergent"].includes(variant) ? "REJECT" : "APPROVE";
  const convergence = variant === "nonconvergent" ? "nonconvergent" : "converging";
  const disclosure = variant === "unowned" || variant === "amendment_owner"
    ? [{ path: ISSUE128_UNOWNED_PATH, rationale: ISSUE128_RATIONALE }]
    : variant === "sibling" ? [{ path: ISSUE128_SIBLING_PATH, rationale: ISSUE128_RATIONALE }] : [];
  const rejected = verdict === "REJECT";
  const evidence = { subject, attempt: 1, status: "pass", review_ready: true, head_sha: reviewedCommit, ownership_disclosure: disclosure };
  const review = {
    subject, attempt: 1, verdict, convergence, late_discovery_strike: false, remaining_fix_count: rejected ? 1 : 0,
    required_fixes: rejected ? ["Repair the rejected implementation"] : [],
    ownership_ratification: { schema_version: 2, kind: "factory-derived-modified-extension" },
    remediation_context: { schema_version: 2, fixes: rejected ? [{ required_fix_index: 0, classification: convergence === "nonconvergent" ? "nonconvergent" : "narrow-correction", scope_effect: "in-lane", likely_paths: [`src/${subject}/fix.js`], fix_owner: subject }] : [] },
    reviewed_commit: reviewedCommit,
  };
  if (owner) {
    review.invariant_family_ledger = {
      schema_version: 1,
      delivery_unit_id: "fixture-unit-1",
      dispositions: [{
        invariant_family_id: "fixture-family-1", verification_artifact_id: "fixture-artifact-1",
        evidence_ref: "evidence/owner.family.json",
        evidence_hash: variant === "owner" ? "sha256:e6ce2b2551458ce741e09ce3823075af6187850034e58ff488d14bea048a7382" : "sha256:7f8f603b9f01807db4f01590e13a9980db2462385fdfe16e25fdd6e66960b555",
        probe: { type: "verification-artifact", verification_artifact_id: "fixture-artifact-1" },
        result: { type: "verification-result", outcome: "pass", summary: "Verify owner behavior passed" },
        reviewed_commit: reviewedCommit, unresolved_findings: [],
      }],
    };
  }
  const stem = createHash("sha256").update(`${ISSUE128_RUN_ID}\0${subject}\0${1}`, "utf8").digest("hex");
  const claimRef = `dispatch/${stem}.json`;
  const closureRef = `dispatch/${stem}.closed.json`;
  const token = `issue128-${subject}-completion`;
  const claim = {
    schema_version: 1, kind: "checked-slice-builder-dispatch-claim", run_id: ISSUE128_RUN_ID, slice_id: subject, attempt: 1,
    agent: "backend-builder", branch: `issue128-${subject}`, worktree: `/tmp/issue128-${subject}`, head: ISSUE128_BASE_COMMIT,
    context_hash: `sha256:${"a".repeat(64)}`, completion_token_hash: hashBytes(token), claimed_at: "2026-01-01T00:00:00.000Z", closure_ref: closureRef,
  };
  const claimBytes = `${JSON.stringify(claim)}\n`;
  const closure = {
    schema_version: 1, kind: "checked-slice-builder-dispatch-closure", claim_ref: claimRef, claim_hash: ISSUE128_SIDECAR_HASHES[variant].dispatch_claim,
    run_id: ISSUE128_RUN_ID, slice_id: subject, attempt: 1, agent: "backend-builder", branch: claim.branch, worktree: claim.worktree,
    head: ISSUE128_BASE_COMMIT, completion_head: reviewedCommit, context_hash: claim.context_hash, completion_token: token, returned_at: "2026-01-01T00:01:00.000Z",
  };
  const values = { evidence, review, dispatch_claim: claim, dispatch_closure: closure };
  const refs = { evidence: `evidence/${subject}.json`, review: `reviews/${subject}.json`, dispatch_claim: claimRef, dispatch_closure: closureRef };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
    ref: refs[key], hash: ISSUE128_SIDECAR_HASHES[variant][key], bytes: key === "dispatch_claim" ? claimBytes : `${JSON.stringify(value)}\n`,
  }]));
}

function issue128Attempt({ verdict = "APPROVE", extension = null, convergence = "converging", owner = false, amendmentOwner = false } = {}) {
  const variant = amendmentOwner ? "amendment_owner" : owner ? "owner" : verdict === "REJECT" ? convergence === "nonconvergent" ? "nonconvergent" : "reject" : extension?.authority === "unowned" ? "unowned" : extension?.authority === "non-conflicting-sibling" ? "sibling" : "empty";
  const external = issue128ExternalSources(variant);
  const reviewedCommit = JSON.parse(external.evidence.bytes).head_sha;
  return {
    attempt: 1,
    evidence_ref: external.evidence.ref,
    evidence_hash: external.evidence.hash,
    review_ref: external.review.ref,
    review_hash: external.review.hash,
    reviewed_commit: reviewedCommit,
    diff_base_commit: ISSUE128_BASE_COMMIT,
    ownership_schema_version: 2,
    ratified_paths: extension ? [extension.path] : [],
    modified_extensions: extension ? [structuredClone(extension)] : [],
    verdict,
    convergence,
    late_discovery_strike: false,
    remaining_fix_count: verdict === "APPROVE" ? 0 : 1,
    dispatch_claim_ref: external.dispatch_claim.ref,
    dispatch_claim_hash: external.dispatch_claim.hash,
    dispatch_closure_ref: external.dispatch_closure.ref,
    dispatch_closure_hash: external.dispatch_closure.hash,
  };
}

function issue128UnownedExtension() {
  return { kind: "modified-extension", path: ISSUE128_UNOWNED_PATH, rationale: ISSUE128_RATIONALE, authority: "unowned" };
}

function issue128SiblingExtension() {
  const owner = issue128ExternalSources("owner");
  return {
    kind: "modified-extension",
    path: ISSUE128_SIBLING_PATH,
    rationale: ISSUE128_RATIONALE,
    authority: "non-conflicting-sibling",
    owner_slice_id: "owner",
    owner_attempt: 1,
    owner_evidence_ref: owner.evidence.ref,
    owner_evidence_hash: owner.evidence.hash,
    owner_review_ref: owner.review.ref,
    owner_review_hash: owner.review.hash,
    owner_dispatch_claim_ref: owner.dispatch_claim.ref,
    owner_dispatch_claim_hash: owner.dispatch_claim.hash,
    owner_dispatch_closure_ref: owner.dispatch_closure.ref,
    owner_dispatch_closure_hash: owner.dispatch_closure.hash,
    owner_reviewed_commit: ISSUE128_OWNER_REVIEWED_COMMIT,
    owner_diff_base_commit: ISSUE128_BASE_COMMIT,
  };
}

function issue128Slice(status, attempt, { id = "consumer", merged = false, blockedReason = null, mergeCommit = null } = {}) {
  const currentApproved = attempt.verdict === "APPROVE";
  const row = {
    id,
    stack: "backend",
    depends_on: id === "consumer" ? ["owner"] : [],
    declared_paths: [id === "consumer" ? ISSUE128_DECLARED_PATH : "src/owner/**"],
    effective_paths: [id === "consumer" ? ISSUE128_DECLARED_PATH : "src/owner/**", ...(currentApproved ? attempt.ratified_paths : [])],
    status,
    attempts: status === "running" ? 2 : 1,
    branch: `issue128-${id}`,
    worktree: `/tmp/issue128-${id}`,
    attempt_reviews: [structuredClone(attempt)],
  };
  if (["review", "merged"].includes(status)) {
    Object.assign(row, {
      evidence_ref: attempt.evidence_ref,
      evidence_hash: attempt.evidence_hash,
      review_ref: attempt.review_ref,
      review_hash: attempt.review_hash,
      reviewed_commit: attempt.reviewed_commit,
      dispatch_required: true,
      dispatch_claim_ref: attempt.dispatch_claim_ref,
      dispatch_claim_hash: attempt.dispatch_claim_hash,
      dispatch_closure_ref: attempt.dispatch_closure_ref,
      dispatch_closure_hash: attempt.dispatch_closure_hash,
    });
  }
  if (merged) row.merge_commit = mergeCommit || issue128MergeCommit(attempt, id);
  if (blockedReason) row.blocked_reason = blockedReason;
  return row;
}

function issue128OwnerSlice(status = "merged") {
  const attempt = issue128Attempt({ owner: true });
  return issue128Slice(status, attempt, { id: "owner", merged: status === "merged", mergeCommit: ISSUE128_OWNER_MERGE_COMMIT });
}

function issue128OrdinaryBlockedSlice(attempt) {
  const slice = issue128Slice("blocked", attempt, { blockedReason: "slice review rejected" });
  slice.attempts = 2;
  return slice;
}

function issue128MergeCommit(attempt, id) {
  if (id === "owner") return attempt.reviewed_commit === ISSUE128_AMENDMENT_REVIEWED_COMMIT ? ISSUE128_AMENDMENT_MERGE_COMMIT : ISSUE128_OWNER_MERGE_COMMIT;
  if (attempt.reviewed_commit === ISSUE128_UNOWNED_REVIEWED_COMMIT) return ISSUE128_UNOWNED_MERGE_COMMIT;
  if (attempt.reviewed_commit === ISSUE128_SIBLING_REVIEWED_COMMIT) return ISSUE128_SIBLING_MERGE_COMMIT;
  return ISSUE128_EMPTY_MERGE_COMMIT;
}

function issue128Dispositions(id, source, ownerSource = null) {
  const target = (targets) => ({ disposition: "target", targets });
  const exclusion = (reason) => ({ disposition: "exclusion", reason });
  const context = {
    source,
    ...(id.startsWith("slice-modified-extension-") ? { enclosing_source: issue128Attempt({ extension: source }) } : {}),
    ...(ownerSource ? { owner_source: ownerSource } : {}),
    external_sources: issue128CatalogExternalSources(id, source),
  };
  const paths = Object.fromEntries(["K", "V", "R", "H", "B", "D", "I", "X"].map((code) => [code, []]));
  const add = (code, path) => paths[code].push({ path, expected: structuredClone(issue128ValueAt(context, path)) });
  const addUnknown = (path, boundary) => paths.K.push({
    path,
    expected: structuredClone(issue128ValueAt(context, path)),
    operation: "unknown-key",
    key: `unsupported_issue128_${boundary.replaceAll("-", "_")}`,
    value: `unsupported-${boundary}`,
  });
  const addFields = (code, root, fields) => fields.forEach((field) => add(code, [...root, field]));
  const addAttempt = (root) => {
    addFields("K", root, ["attempt", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "diff_base_commit", "ownership_schema_version", "ratified_paths", "modified_extensions", "verdict", "convergence", "late_discovery_strike", "remaining_fix_count", "dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash"]);
    addFields("V", root, ["attempt", "ownership_schema_version", "verdict", "convergence", "late_discovery_strike", "remaining_fix_count"]);
    addFields("R", root, ["evidence_ref", "review_ref", "dispatch_claim_ref", "dispatch_closure_ref"]);
    addFields("H", root, ["evidence_hash", "review_hash", "dispatch_claim_hash", "dispatch_closure_hash"]);
    addFields("D", root, ["ratified_paths", "modified_extensions"]);
    add("I", [...root, "reviewed_commit"]);
    add("X", [...root, "diff_base_commit"]);
  };
  const addExtension = (root, sibling) => {
    addFields("K", root, sibling ? ["kind", "path", "rationale", "authority", "owner_slice_id", "owner_attempt", "owner_evidence_ref", "owner_evidence_hash", "owner_review_ref", "owner_review_hash", "owner_dispatch_claim_ref", "owner_dispatch_claim_hash", "owner_dispatch_closure_ref", "owner_dispatch_closure_hash", "owner_reviewed_commit", "owner_diff_base_commit"] : ["kind", "path", "rationale", "authority"]);
    addFields("V", root, ["kind", "path", "rationale", "authority"]);
    addFields("D", root, ["kind", "path", "rationale", "authority"]);
    if (sibling) {
      addFields("R", root, ["owner_evidence_ref", "owner_review_ref", "owner_dispatch_claim_ref", "owner_dispatch_closure_ref"]);
      addFields("H", root, ["owner_evidence_hash", "owner_review_hash", "owner_dispatch_claim_hash", "owner_dispatch_closure_hash"]);
      addFields("I", root, ["owner_slice_id", "owner_attempt", "owner_reviewed_commit"]);
      add("X", [...root, "owner_diff_base_commit"]);
    }
  };
  const addSlice = (root) => {
    const sliceValue = issue128ValueAt(context, root);
    const rootFields = [
      "id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts", "attempt_reviews", "branch", "worktree",
      "dispatch_required", "dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash",
      "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "merge_commit", "blocked_reason",
    ].filter((field) => Object.hasOwn(sliceValue || {}, field));
    addFields("K", root, rootFields);
    add("V", [...root, "attempts"]);
    if (sliceValue?.status !== undefined) add("V", [...root, "status"]);
    addFields("D", root, ["declared_paths", "effective_paths", "attempt_reviews"]);
    if (sliceValue?.evidence_ref !== undefined) {
      const currentFields = ["evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash"].filter((field) => sliceValue[field] !== undefined);
      addFields("R", root, ["evidence_ref", "review_ref", "dispatch_claim_ref", "dispatch_closure_ref"].filter((field) => sliceValue[field] !== undefined));
      addFields("H", root, ["evidence_hash", "review_hash", "dispatch_claim_hash", "dispatch_closure_hash"].filter((field) => sliceValue[field] !== undefined));
      add("I", [...root, "reviewed_commit"]);
    }
    if (sliceValue?.merge_commit !== undefined) {
      add("I", [...root, "merge_commit"]);
    }
  };
  const addExternalBytes = (ownerIncluded) => {
    for (const key of ["evidence", "review", "dispatch_claim", "dispatch_closure"]) add("B", ["external_sources", key, "bytes"]);
    if (ownerIncluded) for (const key of ["owner_evidence", "owner_review", "owner_dispatch_claim", "owner_dispatch_closure"]) add("B", ["external_sources", key, "bytes"]);
  };

  if (id.startsWith("slice-attempt-review-")) {
    addAttempt(["source"]);
    if (source.modified_extensions[0]) addExtension(["source", "modified_extensions", 0], source.modified_extensions[0].authority === "non-conflicting-sibling");
  } else if (id.startsWith("slice-modified-extension-")) {
    addAttempt(["enclosing_source"]);
    addExtension(["source"], source.authority === "non-conflicting-sibling");
  } else if (id === "terminal-nonconvergence-v2-source-review") {
    addFields("K", ["source"], ["schema_version", "kind", "slice_id", "source_review", "continuation"]);
    addFields("V", ["source"], ["schema_version", "kind"]);
    addFields("K", ["source", "continuation"], ["program", "args"]);
    addFields("V", ["source", "continuation"], ["program", "args"]);
    add("D", ["source", "continuation", "args"]);
    add("I", ["source", "slice_id"]);
    addAttempt(["source", "source_review"]);
  } else {
    addSlice(["source"]);
    addAttempt(["source", "attempt_reviews", 0]);
    const extension = source.attempt_reviews[0]?.modified_extensions?.[0];
    if (extension) addExtension(["source", "attempt_reviews", 0, "modified_extensions", 0], extension.authority === "non-conflicting-sibling");
  }
  const attemptRoot = id.startsWith("slice-attempt-review-") ? ["source"]
    : id.startsWith("slice-modified-extension-") ? ["enclosing_source"]
      : id === "terminal-nonconvergence-v2-source-review" ? ["source", "source_review"]
        : ["source", "attempt_reviews", 0];
  addUnknown(attemptRoot, "a2-boundary");
  const extensionRoot = id.startsWith("slice-modified-extension-") ? ["source"]
    : id.startsWith("slice-attempt-review-") ? ["source", "modified_extensions", 0]
      : ["source", "attempt_reviews", 0, "modified_extensions", 0];
  const extensionValue = issue128ValueAt(context, extensionRoot);
  if (extensionValue?.authority === "unowned") addUnknown(extensionRoot, "u2-boundary");
  if (extensionValue?.authority === "non-conflicting-sibling") addUnknown(extensionRoot, "s2-boundary");
  if (ownerSource) {
    addSlice(["owner_source"]);
    addAttempt(["owner_source", "attempt_reviews", 0]);
    addUnknown(["owner_source"], "owner-root-boundary");
    addUnknown(["owner_source", "attempt_reviews", 0], "owner-a2-boundary");
  }
  if (id === "terminal-nonconvergence-v2-source-review") {
    addUnknown(["source"], "nonconvergence-root-boundary");
    addUnknown(["source", "continuation"], "nonconvergence-continuation-boundary");
  } else if (!id.startsWith("slice-attempt-review-") && !id.startsWith("slice-modified-extension-")) {
    addUnknown(["source"], id.includes("carry-forward") ? "cf2-root-boundary" : id === "amendment-owner-snapshot-v2-history" ? "amendment-owner-root-boundary" : "slice-root-boundary");
  }
  addExternalBytes(id.includes("sibling") || id.includes("carry-forward"));
  for (const [code, targets] of Object.entries(paths)) {
    const identities = targets.map((target) => `${target.operation || "field"}\0${target.path.join(".")}\0${target.key || ""}`);
    if (new Set(identities).size !== identities.length) throw new TypeError(`${id} has duplicate ${code} mutation targets`);
    for (const target of targets) Object.assign(target, issue128ExpectedRejection(id, code, target));
  }
  return { ...Object.fromEntries(Object.entries(paths).map(([code, targets]) => [code, target(targets)])), time: exclusion("This variant has no independent timestamp field.") };
}

function issue128ExpectedRejection(id, code, target) {
  const field = target.operation === "unknown-key" ? target.key : String(target.path.at(-1));
  const sourceName = target.path[0];
  const rootSliceTarget = sourceName === "owner_source" || sourceName === "source" && !id.startsWith("slice-attempt-review-") && !id.startsWith("slice-modified-extension-") && id !== "terminal-nonconvergence-v2-source-review";
  if (id.includes("carry-forward")) {
    const schemaValidExtensionValue = code === "V" && target.path.includes("modified_extensions") && field === "rationale";
    return {
      expected_check: id.startsWith("checkpoint-") ? "continueFactory checkpoint carry-forward authority" : "continueFactory ordinary carry-forward authority",
      expected_rejection: target.operation === "unknown-key" ? `${field}.*(?:not allowed|invalid-continuation-carry-forward)`
        : code === "K" && field === "merge_commit" ? sourceName === "owner_source"
          ? "slice 'owner' persisted sibling owner merge authority is incomplete"
          : "v2 carry-forward first-parent range must contain all and only accepted merge commits exactly once"
        : code === "K" && sourceName === "owner_source" && ["stack", "branch", "worktree"].includes(field) ? "slice builder dispatch claim identity is invalid"
          : code === "K" && sourceName === "owner_source" && field === "depends_on" ? id.startsWith("checkpoint-")
            ? "parent run slices must exactly classify the bound plan"
            : "accepted work-decomposer plan authority for the bound plan is invalid: parent run slices must exactly classify the bound plan"
          : code === "V" && target.path.includes("modified_extensions") && field === "path" ? "ratified_paths: must exactly equal modified_extensions paths"
        : code === "K" || code === "V" && !schemaValidExtensionValue ? issue128SchemaDiscriminator(field)
          : schemaValidExtensionValue ? "(?:ownership|review history|persisted).*stale"
            : issue128RejectionDiscriminator(code, field, target),
    };
  }
  if (id === "amendment-owner-snapshot-v2-history") {
    const schemaValidExtensionValue = code === "V" && target.path.includes("modified_extensions") && ["path", "rationale"].includes(field);
    const amendmentBytes = code === "B" ? target.path[1] : null;
    return {
      expected_check: target.operation === "unknown-key" || code === "K" || code === "V" && !schemaValidExtensionValue ? "validateRun" : "assertIntegrationAmendmentConsistency",
      expected_rejection: target.operation === "unknown-key" ? `${field}.*is not allowed`
        : code === "K" || code === "V" && !schemaValidExtensionValue ? issue128SchemaDiscriminator(field)
          : schemaValidExtensionValue ? "integration amendment report identity is cross-bound"
            : code !== "B" ? "integration amendment report identity is cross-bound"
              : amendmentBytes.includes("dispatch") ? "dispatch.*(?:bound|binding|invalid|stale|closed)"
                : "slice 'owner'.*(?:history|authority).*stale",
    };
  }
  if (id === "terminal-nonconvergence-v2-source-review" && code !== "B") {
    const continuation = target.path.includes("continuation");
    return {
      expected_check: "validateRun",
      expected_rejection: target.operation === "unknown-key" ? `${field}.*is not allowed`
        : continuation ? `${field}.*(?:exact checked carry-forward command template|required|must|allowed)`
          : `(?:${field}.*(?:required|must|allowed|equal|invalid)|nonconvergence.source_review: must equal the current latest append-only slice review entry)`,
    };
  }
  if (target.operation === "unknown-key") return { expected_check: "validateRun", expected_rejection: `${field}.*is not allowed` };
  if (sourceName === "source" && ["stack", "depends_on"].includes(field) && id.startsWith("slice-")) {
    return { expected_check: "observeAcceptedDecompositionAuthority", expected_rejection: "parent run slices must exactly classify the bound plan" };
  }
  if (sourceName === "source" && ["branch", "worktree"].includes(field)) {
    return { expected_check: `assertSliceAttemptHistoryCurrent(${id === "amendment-owner-snapshot-v2-history" ? "owner" : "consumer"})`, expected_rejection: "(?:slice '.*' attempt 1 (?:dispatch|review history)|dispatch claim identity is invalid)" };
  }
  if (sourceName === "owner_source" && ["stack", "depends_on"].includes(field)) {
    return { expected_check: "observeAcceptedDecompositionAuthority", expected_rejection: "parent run slices must exactly classify the bound plan" };
  }
  if (sourceName === "owner_source" && ["branch", "worktree"].includes(field)) {
    return { expected_check: "assertSliceAttemptHistoryCurrent(owner)", expected_rejection: "(?:slice 'owner' attempt 1 (?:dispatch|review history)|dispatch claim identity is invalid)" };
  }
  if (code === "V" && (target.path.includes("modified_extensions") || id.startsWith("slice-modified-extension-")) && ["path", "rationale"].includes(field)) {
    return { expected_check: `assertSliceAttemptHistoryCurrent(${sourceName === "owner_source" ? "owner" : "consumer"})`, expected_rejection: "review history is stale" };
  }
  if (code === "K" && id === "slice-running-with-v2-history" && field === "attempts") {
    return { expected_check: "assertNoUnresolvedSliceDispatches", expected_rejection: "slice 'consumer' has a future attempt 1 claim" };
  }
  if (code === "K" && id === "slice-running-with-v2-history" && field === "attempt_reviews") {
    return { expected_check: "assertNoUnresolvedSliceDispatches", expected_rejection: "slice 'consumer' attempt 1 sidecars are not bound by run state" };
  }
  if (code === "K" && id === "slice-blocked-ordinary-v2-history" && field === "attempts") {
    return { expected_check: "assertNoUnresolvedSliceDispatches", expected_rejection: "slice 'consumer' has a future attempt 1 claim" };
  }
  if (code === "K" && id === "slice-blocked-ordinary-v2-history" && field === "attempt_reviews") {
    return { expected_check: "assertNoUnresolvedSliceDispatches", expected_rejection: "slice 'consumer' attempt 1 sidecars are not bound by run state" };
  }
  if (code === "K" && id === "slice-blocked-nonconvergent-v2-history" && ["attempts", "attempt_reviews"].includes(field)) {
    return { expected_check: "validateRun", expected_rejection: "nonconvergence.source_review: must equal the current latest append-only slice review entry" };
  }
  if (code === "K" && field === "merge_commit") {
    const owner = sourceName === "owner_source";
    return { expected_check: `checkRunConsistency: run.slices[${owner ? 0 : 1}].merged`, expected_rejection: "merge_commit: merged slice requires merge_commit" };
  }
  if (code === "K" || code === "V") return { expected_check: "validateRun", expected_rejection: issue128SchemaDiscriminator(field) };
  if (["R", "H"].includes(code) && rootSliceTarget && target.path.length === 2 && ["evidence_ref", "evidence_hash", "review_ref", "review_hash"].includes(field)) {
    return { expected_check: "validateRun", expected_rejection: `${field}: must equal the current attempt_reviews ${field}` };
  }
  if (["R", "H"].includes(code) && rootSliceTarget && target.path.length === 2 && field.includes("dispatch_")) {
    return { expected_check: "assertNoUnresolvedSliceDispatches", expected_rejection: field.includes("closure") ? "slice '.*' attempt 1 is not exactly closed" : "dispatch claim is not bound by current run state" };
  }
  if (code === "D" && rootSliceTarget && target.path.length === 2) {
    return { expected_check: "validateRun", expected_rejection: `${field}.*(?:must|current|object|array)` };
  }
  if (["I", "X"].includes(code) && rootSliceTarget && target.path.length === 2 && field === "reviewed_commit") {
    return { expected_check: "validateRun", expected_rejection: "reviewed_commit: must equal the current attempt_reviews reviewed_commit" };
  }
  if (code === "B") {
    const owner = target.path[1]?.startsWith("owner_");
    if (target.path[1]?.includes("dispatch_")) {
      return { expected_check: `assertSliceAttemptHistoryCurrent(${owner ? "owner" : "consumer"})`, expected_rejection: "dispatch.*(?:claim|closure|bound|binding|invalid)" };
    }
    return { expected_check: `checkRunConsistency: run.slices[${owner ? 0 : 1}].attempt_reviews[0]`, expected_rejection: "(?:evidence_hash|review_hash|persisted ownership authority).*stale|must match.*bytes" };
  }
  if (field === "merge_commit") return { expected_check: `observeReviewedMergeProof(${sourceName === "owner_source" ? "owner" : "consumer"})`, expected_rejection: "merge (?:parents|commit|second parent|base)" };
  return {
    expected_check: `assertSliceAttemptHistoryCurrent(${sourceName === "owner_source" ? "owner" : "consumer"})`,
    expected_rejection: issue128RejectionDiscriminator(code, field, target),
  };
}

function issue128SchemaDiscriminator(field) {
  if (field.includes("dispatch_")) return "dispatch.*(?:claim|closure|authority|binding)";
  if (field === "attempts") return "attempt(?:s|_reviews).*(?:required|must|positive|equal|invalid|current)";
  if (["evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit"].includes(field)) {
    return `(?:${field}|review and merged slices require complete|current attempt_reviews)`;
  }
  return `${field}.*(?:required|must|allowed|forbidden|positive|equal|invalid)`;
}

function issue128RejectionDiscriminator(code, field, target, prefix = "") {
  const scoped = prefix ? `${prefix}.*` : "";
  const byteSource = code === "B" ? String(target.path[1]) : "";
  if (target.operation === "unknown-key") return `${field}.*(?:not allowed|invalid-continuation-carry-forward)`;
  if (code === "R") return `(?:${scoped}${field.includes("dispatch") ? "dispatch" : field.includes("evidence") ? "evidence" : "review"}.*(?:missing|stale|invalid|authority|binding|bound|must (?:equal|be a safe))|review history is stale)`;
  if (code === "H") return `(?:${scoped}${field.includes("dispatch") ? "dispatch" : field.includes("evidence") ? "evidence" : "review"}.*(?:hash|stale|authority|binding|bound)|review history is stale|slice '.*' attempt 1 is not exactly closed)`;
  if (code === "B") return byteSource.includes("dispatch")
    ? "(?:dispatch.*(?:bytes|hash|stale|invalid|authority|binding|bound)|slice '.*' attempt 1 is not exactly closed)"
    : byteSource.includes("evidence") ? "(?:evidence.*(?:bytes|hash|stale|invalid|authority|binding)|review history is stale)"
      : `${scoped}review.*(?:bytes|hash|stale|invalid|authority|binding)`;
  if (code === "D") return `${scoped}(?:${field}|ownership|projection|history|path|authority).*(?:stale|equal|match|invalid|authority|must|not allowed)`;
  if (code === "I" || code === "X") return `${scoped}(?:${field}|owner|reviewed|commit|baseline|identity|review history|first-parent).*(?:stale|cross-bound|match|equal|invalid|authority|contain)`;
  return `${scoped}${field}.*(?:required|must|allowed|forbidden|stale|invalid)`;
}

function issue128ValueAt(value, path) {
  let current = value;
  for (const segment of path) current = current?.[segment];
  return current;
}

function issue128CatalogExternalSources(id, source) {
  const attempt = id.startsWith("slice-modified-extension-") ? issue128Attempt({ extension: source })
    : id === "terminal-nonconvergence-v2-source-review" ? source.source_review
      : source?.attempt_reviews?.[0] || source;
  const variant = source?.id === "owner" ? "amendment_owner"
    : attempt?.verdict === "REJECT" ? attempt.convergence === "nonconvergent" ? "nonconvergent" : "reject"
      : attempt?.modified_extensions?.[0]?.authority === "unowned" ? "unowned"
        : attempt?.modified_extensions?.[0]?.authority === "non-conflicting-sibling" ? "sibling" : "empty";
  const modifying = issue128ExternalSources(variant);
  const owner = issue128ExternalSources("owner");
  const sources = {
    evidence: modifying.evidence,
    review: modifying.review,
    dispatch_claim: modifying.dispatch_claim,
    dispatch_closure: modifying.dispatch_closure,
  };
  if (id.includes("sibling") || id.includes("carry-forward")) {
    Object.assign(sources, {
      owner_evidence: owner.evidence,
      owner_review: owner.review,
      owner_dispatch_claim: owner.dispatch_claim,
      owner_dispatch_closure: owner.dispatch_closure,
    });
  }
  return sources;
}

function issue128Row({ id, authorityClass, variant, canonicalPath, shape, writer, readers, tests, source, enclosingSource, ownerSource, externalSources, dispositions, facts }) {
  return {
    id,
    authority_class: authorityClass,
    variant,
    canonical_path: canonicalPath,
    canonical_shape: shape,
    writer,
    readers,
    tests,
    facts,
    source,
    ...(enclosingSource ? { enclosing_source: enclosingSource } : {}),
    ...(ownerSource ? { owner_source: ownerSource } : {}),
    external_sources: externalSources,
    dispositions,
  };
}

function buildIssue128FinishAndDiscloseCatalog() {
  const reject = issue128Attempt({ verdict: "REJECT" });
  const approveEmpty = issue128Attempt();
  const approveUnowned = issue128Attempt({ extension: issue128UnownedExtension() });
  const approveSibling = issue128Attempt({ extension: issue128SiblingExtension() });
  const nonconvergent = issue128Attempt({ verdict: "REJECT", convergence: "nonconvergent" });
  const definitions = [
    ["slice-attempt-review-v2-reject", "slices-review-evidence-bindings", "A2 REJECT with empty extension projection", "run.slices[i].attempt_reviews[j]", "A2", "checked transitionRunSlice review publication", issue128Readers("P", "C", "N", "D"), reject],
    ["slice-attempt-review-v2-approve-empty", "slices-review-evidence-bindings", "A2 APPROVE with empty extension projection", "run.slices[i].attempt_reviews[j]", "A2", "checked transitionRunSlice review publication", issue128Readers("P", "C", "D"), approveEmpty],
    ["slice-attempt-review-v2-approve-unowned", "slices-review-evidence-bindings", "A2 APPROVE with U2", "run.slices[i].attempt_reviews[j]", "A2+U2", "checked transitionRunSlice review publication", issue128Readers("P", "C", "D"), approveUnowned],
    ["slice-attempt-review-v2-approve-sibling", "slices-review-evidence-bindings", "A2 APPROVE with S2", "run.slices[i].attempt_reviews[j]", "A2+S2", "checked transitionRunSlice review publication", issue128Readers("P", "C", "D"), approveSibling],
    ["slice-modified-extension-unowned-v2", "slices-review-evidence-bindings", "exact U2 nested modified extension", "run.slices[i].attempt_reviews[j].modified_extensions[k]", "U2", "transitionRunSlice A2 derivation", issue128Readers("P", "C", "D"), issue128UnownedExtension()],
    ["slice-modified-extension-sibling-v2", "slices-review-evidence-bindings", "exact S2 nested modified extension", "run.slices[i].attempt_reviews[j].modified_extensions[k]", "S2", "transitionRunSlice A2 derivation", issue128Readers("P", "C", "D"), issue128SiblingExtension()],
    ["slice-running-with-v2-history", "slices-review-evidence-bindings", "running retry retaining A2 history", "run.slices[i]", "slice-running+A2", "checked retry transition", issue128Readers("P", "D"), issue128Slice("running", reject)],
    ["slice-review-v2-reject", "slices-review-evidence-bindings", "review root with current A2 REJECT", "run.slices[i]", "slice-review+A2", "transitionRunSlice", issue128Readers("P", "N", "D"), issue128Slice("review", reject)],
    ["slice-review-v2-approve-empty", "slices-review-evidence-bindings", "review root with current approve-empty A2", "run.slices[i]", "slice-review+A2", "transitionRunSlice", issue128Readers("P", "C", "D"), issue128Slice("review", approveEmpty)],
    ["slice-review-v2-approve-unowned", "slices-review-evidence-bindings", "review root with U2 authority", "run.slices[i]", "slice-review+A2+U2", "transitionRunSlice", issue128Readers("P", "C", "D"), issue128Slice("review", approveUnowned)],
    ["slice-review-v2-approve-sibling", "slices-review-evidence-bindings", "review root with S2 authority", "run.slices[i]", "slice-review+A2+S2", "transitionRunSlice", issue128Readers("P", "C", "D"), issue128Slice("review", approveSibling)],
    ["slice-merged-v2-approve-empty", "slices-review-evidence-bindings", "merged root with approve-empty A2", "run.slices[i]", "slice-merged+A2", "transitionSliceMerged", issue128Readers("P", "C", "D"), issue128Slice("merged", approveEmpty, { merged: true })],
    ["slice-merged-v2-unowned", "slices-review-evidence-bindings", "merged root with U2 authority", "run.slices[i]", "slice-merged+A2+U2", "transitionSliceMerged", issue128Readers("P", "C", "D"), issue128Slice("merged", approveUnowned, { merged: true })],
    ["slice-merged-v2-sibling", "slices-review-evidence-bindings", "merged modifying root with S2 and same-bound owner", "run.slices[i]", "slice-merged+A2+S2", "transitionSliceMerged", issue128Readers("P", "C", "D"), issue128Slice("merged", approveSibling, { merged: true })],
    ["slice-blocked-ordinary-v2-history", "slices-review-evidence-bindings", "ordinary blocked root retaining A2 history", "run.slices[i]", "slice-blocked+A2", "ordinary blocked transition", issue128Readers("P", "C", "D"), issue128OrdinaryBlockedSlice(reject)],
    ["slice-blocked-nonconvergent-v2-history", "slices-review-evidence-bindings", "nonconvergent blocked root retaining latest A2 REJECT", "run.slices[i]", "slice-blocked+A2-nonconvergent", "nonconvergence checked transition", issue128Readers("P", "N", "C", "D"), issue128Slice("blocked", nonconvergent, { blockedReason: "slice-review-nonconvergent" })],
  ];
  const rows = definitions.map(([id, authorityClass, variant, canonicalPath, shape, writer, readers, source]) => {
    const ownerSource = id.includes("sibling") ? issue128OwnerSlice() : null;
    return issue128Row({
      id, authorityClass, variant, canonicalPath, shape, writer, readers,
      tests: issue128ProductionTests(id),
      ...(id.startsWith("slice-modified-extension-") ? { enclosingSource: issue128Attempt({ extension: source }) } : {}),
      ...(ownerSource ? { ownerSource } : {}),
      source: structuredClone(source), externalSources: issue128CatalogExternalSources(id, source), dispositions: issue128Dispositions(id, source, ownerSource),
      facts: [
        { path: ["canonical_path"], expected: canonicalPath },
        { path: ["canonical_shape"], expected: shape },
        { path: ["variant"], expected: variant },
      ],
    });
  });
  const terminalSource = {
    schema_version: 1,
    kind: "slice-review-nonconvergence",
    slice_id: "consumer",
    source_review: structuredClone(nonconvergent),
    continuation: { program: "feature-factory", args: ["factory", "continue", ISSUE128_RUN_ID, "--review", nonconvergent.review_ref, "--run-id", "<new-run-id>", "--carry-forward", "--json"] },
  };
  rows.push(issue128Row({
    id: "terminal-nonconvergence-v2-source-review", authorityClass: "run-envelope-terminal-result", variant: "terminal nonconvergence bound to latest A2", canonicalPath: "run.terminal_result.nonconvergence", shape: "N+A2", writer: "nonconvergence terminalization", readers: issue128Readers("N", "C", "D"),
    tests: issue128ProductionTests("terminal-nonconvergence-v2-source-review"), source: terminalSource, externalSources: issue128CatalogExternalSources("terminal-nonconvergence-v2-source-review", terminalSource), dispositions: issue128Dispositions("terminal-nonconvergence-v2-source-review", terminalSource), facts: [{ path: ["source", "slice_id"], expected: "consumer" }],
  }));
  for (const checkpoint of [false, true]) {
    const id = checkpoint ? "checkpoint-carry-forward-accepted-slice-v2" : "continuation-carry-forward-accepted-slice-v2";
    const accepted = issue128Slice("merged", approveSibling, { merged: true });
    const ownerSource = issue128OwnerSlice();
    for (const key of ["stack", "depends_on", "status", "branch", "worktree", "dispatch_required", "dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash"]) delete accepted[key];
    rows.push(issue128Row({
      id, authorityClass: "continuation-v2-carry-forward", variant: checkpoint ? "checkpoint CF2 with A2/S2 owner pair" : "ordinary CF2 with A2/S2 owner pair", canonicalPath: "continuation.carry_forward.accepted_slices[i]", shape: "CF2+A2+S2", writer: checkpoint ? "checked checkpoint-bound factory continue" : "checked ordinary factory continue", readers: issue128Readers("C", "P", "D"),
      tests: issue128ProductionTests(id), source: accepted, ownerSource, externalSources: issue128CatalogExternalSources(id, accepted), dispositions: issue128Dispositions(id, accepted, ownerSource), facts: [{ path: ["source", "effective_paths"], expected: [ISSUE128_DECLARED_PATH, ISSUE128_SIBLING_PATH] }, { path: ["source", "attempt_reviews", 0, "modified_extensions", 0, "authority"], expected: "non-conflicting-sibling" }],
    }));
  }
  const amendmentAttempt = issue128Attempt({ extension: issue128UnownedExtension(), amendmentOwner: true });
  const amendmentOwner = issue128Slice("merged", amendmentAttempt, { id: "owner", merged: true, mergeCommit: ISSUE128_AMENDMENT_MERGE_COMMIT });
  for (const key of ["branch", "worktree", "dispatch_required", "dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash"]) delete amendmentOwner[key];
  rows.push(issue128Row({
    id: "amendment-owner-snapshot-v2-history", authorityClass: "pr79-merged-slice-repair", variant: "integration-amendment owner snapshot with A2/U2", canonicalPath: "run.integration_amendment.admission.owner", shape: "amendment-owner+A2+U2", writer: "checked integration-amendment admission", readers: issue128Readers("A", "P", "D"),
    tests: issue128ProductionTests("amendment-owner-snapshot-v2-history"), source: amendmentOwner, externalSources: issue128CatalogExternalSources("amendment-owner-snapshot-v2-history", amendmentOwner), dispositions: issue128Dispositions("amendment-owner-snapshot-v2-history", amendmentOwner), facts: [{ path: ["source", "id"], expected: "owner" }, { path: ["source", "attempt_reviews", 0, "ownership_schema_version"], expected: 2 }],
  }));
  return rows;
}

export const ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG = deepFreeze(buildIssue128FinishAndDiscloseCatalog());

// These independent digests deliberately do not derive from the catalog during
// validation. Update them only after reviewing the complete oracle snapshot.
const ISSUE128_FINISH_AND_DISCLOSE_ORACLE_DIGESTS = Object.freeze([
  ["slice-attempt-review-v2-reject", "37d833621d5d3063036324443b2739a792727ed3f604c376816bd959fa40a077", "f3fd5426fe0c571b234d1169c943d4d6c655e03ea2f123cb74803e403dc8f50c", "ab44344c122d2bd743f9778f938b831fdb992e36a1f81d70912e4655960aa7c2"],
  ["slice-attempt-review-v2-approve-empty", "1112bf934e4b4bb34047f0ab4dd22478ef8b8557d06fb742cd97af6fd13f8019", "ee9461c488f4f31203e5cd09eff48c1781237f4e374ec2ff5981eba407da38af", "f2baf4b0b23ae3933421be1173266cd924eca72ea2378466ae38a577b78fc1a7"],
  ["slice-attempt-review-v2-approve-unowned", "69616301f1cfb17cdfa788314ffe849a77e8b5842c7123acb299fb2be0670eb5", "929feb587841636b53ca9ddb2013b8573a6b7267dd7cf681a53f5341e891aacb", "e6bdef1e84bd5e4c5db0bbd77dc1d34015e0d00343bb4ed4d174b68e821f95f5"],
  ["slice-attempt-review-v2-approve-sibling", "23729b362ae4fb9478a7bd7653154b9d8fd75c4b4293b1a3fdaa026eca73bb0a", "07486203405ca7623d1f1b4a495044da2338b5c877e8d84f4d955c95c16ecedb", "7d882fed2a0f3c7b42d2257a24973916f1d76416c4ac13f01ddbe8fe49b68915"],
  ["slice-modified-extension-unowned-v2", "1f74f6c9d862b3385b3bf9cae7c0a132272a0bd9ffdb25f58ba8675cc0cb90aa", "beb702d07e637fcf4351749dca2e93685a2f1216ceb2c57211b0dc0636d8e6cd", "666ad541800e39f781d5c92f417bc108540770c19b10ac931b2673d7d6dae331"],
  ["slice-modified-extension-sibling-v2", "fa3a6f2664f8c5b8a4bd9ab9f85d5309331002c1c30b5773651f5363bcfa5ddf", "e5c80ff7464aeb6ad4da9d69eda757c36ef1a3d16c8361ec0cfa31e6da7ff443", "941a8df00c7c2be534a5d6e23d3408503c2e7062db5d792bf3a4cb0ce6c91ec3"],
  ["slice-running-with-v2-history", "89068e2d1e883882f9b542a61a3727c625d7ab7ecc3dddc80e692572dc32413d", "fcf2f9a52ad57bd71d7fce2a7ef71305049ed096709bb09cbccd5871e158d723", "4159a22d4335701291af4e4b7b602f042640d3f8dba1bf6611accf999d9f19dc"],
  ["slice-review-v2-reject", "102310055c7fa2abc6b2e46890e793f05bdccce62ac2235c0a6995636e308730", "49d59f093d67d2e45ad595d476f631069836ad4f81465d353b7aa9c73c0fa531", "000d4e55d8436c72e624ae64aafc743f85411d7d3026821415d4d05ec1d5b669"],
  ["slice-review-v2-approve-empty", "b42a7984c3b8ec55b747bcd75bcab997d1bec34294397eb7d14283758617be5f", "cd6b09dedf8f1679706d343fcfa48c9f4a884f8963aa21ae909ae5ddcdb7c839", "d4b6db87b0d7cc65ee6633656507ba9dcc2af8f28474372366fa20dffcc41e4d"],
  ["slice-review-v2-approve-unowned", "90f74854bdc2996b98abcd5cdc75850110acc33093e8220e37c3b8f5fe4de02a", "514a0ec00e48d4fb6c38783549ec2bb0f0f35d987dd5fddf2c8c72224e3063d6", "8a3cac108fb33ed7452e26c47097f4fa3289b4300725a6a7d2b5b941b555c01d"],
  ["slice-review-v2-approve-sibling", "79ea82fb8dd87777449788fa5fd3d64a07f8c3fe6922ca13ad0155a814065dab", "3c5dd7a418beb5c5a29097436db7f0410bc626bc6a402340ba486e597629d86b", "bd3db71e6afe9b4e5b50c5e046079823bc8892ced491b0321d4c0d84cfea8443"],
  ["slice-merged-v2-approve-empty", "2176dd79c4151df78057f82f630d3d22fef75dba61f9d018b195040c8de6dadc", "9725215bfd8651a0e2ba57f65d0f525a74ed0905f9c608124d6f7b32c77dfcdc", "920696f8e71d724af00c84af39baa3622490a08d470c24077d9d8223cfb82665"],
  ["slice-merged-v2-unowned", "e82025b07582aedf85cfcb37851c695c83ce4ab6bab4f5de7d2b992b3c5b9133", "9a3f2a253dd645c2976779cda982ed38c98f6adf1cc531253cbbbad09b96c15e", "9c7e3ae6d174809699ae1143f138d6f87fd0615accc9d633e071aad1951eaef6"],
  ["slice-merged-v2-sibling", "0e39f7947cef51f314dc0821d2753123deabe48cb8f59f7a07b473fa56b707ba", "17186d04a801a12718d3ddf641799fa124fea23d6df2dc37fa5b4a8889085822", "c5830ce93cdc978e69af92044e381f9758f8fd719d8bb6d10f5e2487c8687857"],
  ["slice-blocked-ordinary-v2-history", "5ba31480ba4732fd6056c4f7eef5c1de0b0b31f2172f498a5bc9cdcfeb7b6497", "da46ffdc524250765f1091358e0ab5dfa7fc46f040cf01ae83a6de972b92ef9a", "b0c844056b7ca090b3bd2300e8a2837dc54d920e3c123b66a199101f4f61bf2b"],
  ["slice-blocked-nonconvergent-v2-history", "880c51c472c9d996172f4ebbd304e9c21127ff6beb0aeafbd9d15d2499a1535e", "13482462ee238cd5ef40645c04155c3c86bb4e212509f8c5393eb402c0739165", "16ac9022bcb20caf262715e3881292102324f5ca142ed7ce75740f8119b20076"],
  ["terminal-nonconvergence-v2-source-review", "b02c8ee1d2a58e1a86b6bdb7831f0973d95eb5b3213335122a09cb3dc8281053", "580ea713f4df3dff696d7aed6f99fa82eb443c02f45857a4fd6389ace854371c", "ef82a147840477858dd1d479b567c104254a8b19274fb89413656636a97fd221"],
  ["continuation-carry-forward-accepted-slice-v2", "5728a3ee594b4e2d176084bc2dff29ab3891b0f736f9cac7ad00b366e28c1e7f", "08ac2f6b7d1df33055d34a052d37635f28fc828dc40227163379e3b5e001ec68", "7710e61652b301ceb71fdcae2c9101166cbcec71adfde38ee0866f274af87a4f"],
  ["checkpoint-carry-forward-accepted-slice-v2", "5e1bf57cb6108616792e154346b2b2ee667ba0868db0265a677c9b9e633c0fcd", "08ac2f6b7d1df33055d34a052d37635f28fc828dc40227163379e3b5e001ec68", "7cba293192110828d2b6bc35a2d86ccf79c5e8865480e95d3fe1a31019f4a1bc"],
  ["amendment-owner-snapshot-v2-history", "bc3058f7fd9bee9165de32300fddcd12e12e54fa864efb95ca4b5c536eaa3e21", "ef9dbacdb8e20470e0a75cd22420ba3b512eac876207b0a1a3f6fc847bdaede0", "2bf2354da6b3663af1d1ea3fe4f79f01573135ff14125082822c240d36fb64e7"],
]);

function issue128OracleSnapshot(row) {
  return {
    metadata: {
      authority_class: row.authority_class,
      id: row.id,
      variant: row.variant,
      canonical_path: row.canonical_path,
      canonical_shape: row.canonical_shape,
      writer: row.writer,
      readers: row.readers,
      tests: row.tests,
      facts: row.facts,
    },
    source_boundary: { source: row.source, ...(row.enclosing_source ? { enclosing_source: row.enclosing_source } : {}), ...(row.owner_source ? { owner_source: row.owner_source } : {}), external_sources: row.external_sources },
    dispositions: row.dispositions,
  };
}

export function renderIssue128FinishAndDiscloseAuthorityOracleSnapshot(catalog = ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG) {
  return `${JSON.stringify(catalog.map((row) => ({
    id: row.id,
    metadata_digest: createHash("sha256").update(canonicalJson(issue128OracleSnapshot(row).metadata)).digest("hex"),
    source_digest: createHash("sha256").update(canonicalJson(issue128OracleSnapshot(row).source_boundary)).digest("hex"),
    disposition_digest: createHash("sha256").update(canonicalJson(issue128OracleSnapshot(row).dispositions)).digest("hex"),
  })), null, 2)}\n`;
}

export function issue128FinishAndDiscloseAuthorityOracle(catalog = ISSUE128_FINISH_AND_DISCLOSE_AUTHORITY_CATALOG) {
  if (!Array.isArray(catalog)) throw new TypeError("issue #128 durable catalog must be an array");
  if (!sameList(catalog.map(({ id }) => id), ISSUE128_FINISH_AND_DISCLOSE_RECORD_IDS)) throw new TypeError("issue #128 durable catalog must contain exactly the 20 registered rows in order");
  if (!sameList(ISSUE128_FINISH_AND_DISCLOSE_ORACLE_DIGESTS.map(([id]) => id), ISSUE128_FINISH_AND_DISCLOSE_RECORD_IDS)) throw new TypeError("issue #128 independent oracle must bind exactly the 20 registered rows in order");
  const expected = new Map(ISSUE128_FINISH_AND_DISCLOSE_ORACLE_DIGESTS.map(([id, metadata, source, dispositions]) => [id, { metadata, source, dispositions }]));
  for (const row of catalog) {
    const snapshot = issue128OracleSnapshot(row);
    const actual = {
      metadata: createHash("sha256").update(canonicalJson(snapshot.metadata)).digest("hex"),
      source: createHash("sha256").update(canonicalJson(snapshot.source_boundary)).digest("hex"),
      dispositions: createHash("sha256").update(canonicalJson(snapshot.dispositions)).digest("hex"),
    };
    if (canonicalJson(actual) !== canonicalJson(expected.get(row.id))) throw new TypeError(`issue #128 oracle binding changed for ${row.id}`);
    for (const code of ["K", "V", "R", "H", "B", "D", "I", "X"]) {
      if (!row.dispositions?.[code] || !["target", "exclusion"].includes(row.dispositions[code].disposition)) throw new TypeError(`${row.id} must bind disposition ${code}`);
    }
  }
  return true;
}

export function emitIssue128FinishAndDiscloseMutations(row) {
  if (!ISSUE128_FINISH_AND_DISCLOSE_RECORD_IDS.includes(row?.id)) throw new TypeError("issue #128 mutations require a registered row");
  return ["K", "V", "R", "H", "B", "D", "I", "X"].flatMap((code) => {
    const disposition = row.dispositions[code];
    if (disposition.disposition === "exclusion") return [];
    return disposition.targets.map((target) => ({
      name: target.operation === "unknown-key"
        ? `${row.id}: ${code} (unknown ${target.key} at ${target.path.join(".")})`
        : `${row.id}: ${code} (${target.path.join(".")})`,
      code,
      path: [...target.path],
      expected: structuredClone(target.expected),
      ...(target.operation ? { operation: target.operation, key: target.key, value: target.value } : {}),
      expected_check: target.expected_check,
      expected_rejection: target.expected_rejection,
    }));
  });
}

export function createIssue128DurableRunBaseline(row) {
  if (!ISSUE128_FINISH_AND_DISCLOSE_RECORD_IDS.includes(row?.id)) throw new TypeError("issue #128 baseline requires a registered row");
  const owner = issue128OwnerSlice();
  if (row.id.startsWith("slice-attempt-review-") || row.id.startsWith("slice-modified-extension-")) {
    const attempt = row.id.startsWith("slice-modified-extension-")
      ? issue128Attempt({ extension: structuredClone(row.source) })
      : structuredClone(row.source);
    const consumer = issue128Slice("review", attempt);
    return { schema_version: 1, run_id: "issue128-oracle", status: "running", gates: {}, slices: [owner, consumer] };
  }
  if (row.id.startsWith("slice-")) {
    const slices = row.source.id === "owner" ? [structuredClone(row.source)] : [owner, structuredClone(row.source)];
    const run = { schema_version: 1, run_id: "issue128-oracle", status: "running", gates: {}, slices };
    if (row.id === "slice-blocked-nonconvergent-v2-history") {
      const sourceReview = structuredClone(row.source.attempt_reviews.at(-1));
      run.status = "blocked";
      run.terminal_result = {
        status: "blocked", run_id: ISSUE128_RUN_ID, pr_url: null, reason: "slice-review-nonconvergent", summary: "nonconvergent", artifacts: {},
        nonconvergence: {
          schema_version: 1, kind: "slice-review-nonconvergence", slice_id: row.source.id, source_review: sourceReview,
          continuation: { program: "feature-factory", args: ["factory", "continue", ISSUE128_RUN_ID, "--review", sourceReview.review_ref, "--run-id", "<new-run-id>", "--carry-forward", "--json"] },
        },
      };
    }
    return run;
  }
  if (row.id === "terminal-nonconvergence-v2-source-review") {
    const blocked = issue128Slice("blocked", nonconvergentIssue128Attempt(), { blockedReason: "slice-review-nonconvergent" });
    return {
      schema_version: 1, run_id: ISSUE128_RUN_ID, status: "blocked", gates: {}, slices: [owner, blocked],
      terminal_result: { status: "blocked", run_id: ISSUE128_RUN_ID, pr_url: null, reason: "slice-review-nonconvergent", summary: "nonconvergent", artifacts: {}, nonconvergence: structuredClone(row.source) },
    };
  }
  if (row.id === "amendment-owner-snapshot-v2-history") return { schema_version: 1, run_id: "issue128-oracle", status: "running", gates: {}, slices: [structuredClone(row.source)] };
  throw new TypeError(`${row.id} is validated by checked factory continue rather than a synthetic run baseline`);
}

function nonconvergentIssue128Attempt() {
  return issue128Attempt({ verdict: "REJECT", convergence: "nonconvergent" });
}

function canonicalRunFixture(record) {
  if (record.canonicalPath.length === 0) return structuredClone(record.source);
  if (record.id === "terminal-result-blocked-nonconvergence") {
    const blockedSlice = RECORDS.find((candidate) => candidate.id === "slice-blocked")?.source;
    if (!blockedSlice) throw new TypeError("terminal nonconvergence baseline requires the canonical blocked slice source");
    return {
      schema_version: 1,
      run_id: "catalog-run",
      status: "blocked",
      gates: {},
      slices: [structuredClone(blockedSlice)],
      terminal_result: structuredClone(record.source),
    };
  }
  if (record.canonicalPath[0] === "terminal_result") {
    return {
      schema_version: 1,
      run_id: "catalog-run",
      status: record.source.status,
      gates: {},
      ...(record.source.pr_url ? { pr_url: record.source.pr_url } : {}),
      ...(record.id === "terminal-result-blocked-checkpoint-routing" ? {
        checkpoint_progress: {
          schema_version: 1,
          kind: "delivery-checkpoint-progress",
          manifest_ref: record.source.artifacts.checkpoint_routing,
          manifest_hash: hashBytes(CHECKPOINT_ROUTING_BYTES),
          status: "active",
          entries: [],
          final_closure: null,
        },
      } : {}),
      terminal_result: structuredClone(record.source),
    };
  }
  const run = {
    schema_version: 1,
    run_id: "catalog-run",
    mode: record.id === "gate-approved-interactive" ? "interactive" : "autonomous",
    status: "running",
    gates: {},
  };
  if (record.id === "validator-verdict-binding") run.security_review = canonicalSecurityVerdictBinding();
  if (record.id === "security-verdict-binding") run.validator = canonicalValidatorVerdictBinding();
  if (record.canonicalPath[0] === "steering") {
    run.steering = {
      schema_version: 1,
      generation: 2,
      pending: null,
      uncheckpointed: null,
      boundary: null,
      action_claim: null,
      last_action: null,
      pr_fence: null,
      history: [],
    };
  }
  let container = run;
  for (let index = 0; index < record.canonicalPath.length - 1; index += 1) {
    const segment = record.canonicalPath[index];
    if (container[segment] === undefined) container[segment] = typeof record.canonicalPath[index + 1] === "number" ? [] : {};
    container = container[segment];
  }
  container[record.canonicalPath.at(-1)] = structuredClone(record.source);
  if (record.id === "step-inherited-acceptance") {
    run.branch = "catalog-child";
    run.worktree = "/tmp/catalog-child";
    run.mode = "autonomous";
    run.github_account = null;
    run.pr_mode = "ready";
    run.max_parallel_slices = 3;
    run.max_retries = 3;
    const policy = postPrPolicy(false);
    run.post_pr = { schema_version: 1, policy, phase: "disabled", attempt: 0, observation: null, remediation: null, evidence_refs: [], continuation_review: null, terminal_fact: null, pr_operation: null };
    run.continuation = {
      schema_version: 2,
      kind: "blocked-run-continuation",
      created_at: NOW,
      operator_summary: "Continue blocked run 'parent-run' from reviews/parent.json.",
      parent: { run_id: "parent-run", status: "blocked", run_ref: ".opencode/factory/parent-run/run.json", run_hash: HASH_A, branch: "parent-run", commit: SHA_A, worktree: "/tmp/parent-run" },
      review: { kind: "validator", ref: "reviews/parent.json", hash: HASH_A, subject: "parent-run", summary: "Continue current carry-forward.", required_fixes: ["finish"], source: "run.validator.review_ref" },
      target: { run_id: run.run_id, branch: run.branch, worktree: run.worktree, base_ref: "refs/remotes/origin/main", base_commit: SHA_A },
      parent_artifacts: [],
      parent_evidence: [],
      parent_reviews: [{ kind: "review", ref: "reviews/parent.json", hash: HASH_A }],
      planning_reuse: {
        eligible: true,
        spec_review_ref: record.source.inherited_acceptance.parent_spec_review_ref,
        spec_review_hash: record.source.inherited_acceptance.review_hash,
        spec_artifact_ref: record.source.acceptance.artifact_ref,
        spec_artifact_hash: record.source.inherited_acceptance.artifact_hash,
        child_spec_review_ref: record.source.review_ref,
      },
      configuration: { mode: run.mode, github_account: null, pr_mode: run.pr_mode, max_parallel_slices: 3, max_retries: 3, post_pr_policy: policy },
      carry_forward: { scope: "full-remaining-plan", plan_ref: "plan/slices.json", plan_hash: HASH_A, start_commit: SHA_A, accepted_slices: [], remaining_slice_ids: ["slice"] },
    };
  }
  return run;
}

function canonicalValidatorVerdictBinding() {
  return {
    verdict: "GO",
    report: PANEL_EXTERNAL.report.ref,
    report_hash: hashBytes(PANEL_EXTERNAL.report.bytes),
    review_ref: PANEL_EXTERNAL.validator.ref,
    review_hash: hashBytes(PANEL_EXTERNAL.validator.bytes),
    reviewed_head_sha: SHA_B,
  };
}

function canonicalSecurityVerdictBinding() {
  return {
    verdict: "PASS",
    review_ref: PANEL_EXTERNAL.security.ref,
    review_hash: hashBytes(PANEL_EXTERNAL.security.bytes),
    reviewed_head_sha: SHA_B,
  };
}

function postPrCatalogFixture(id) {
  if (typeof id !== "string" || !id.startsWith("post-pr-")) throw new TypeError("post-PR fixture requires a registered post-pr record id");
  let run;
  let canonicalPath;
  if (id.startsWith("post-pr-phase-")) {
    const phase = id.slice("post-pr-phase-".length);
    run = postPrRunForPhase(phase);
    canonicalPath = ["post_pr"];
  } else if (id === "post-pr-policy-disabled") {
    run = postPrRunForPhase("disabled"); canonicalPath = ["post_pr", "policy"];
  } else if (id === "post-pr-policy-enabled") {
    run = postPrRunForPhase("awaiting-pr"); canonicalPath = ["post_pr", "policy"];
  } else if (id === "post-pr-observation-null") {
    run = postPrRunForPhase("awaiting-pr"); canonicalPath = ["post_pr"];
  } else if (id === "post-pr-observation-active") {
    run = postPrRunForPhase("observing"); canonicalPath = ["post_pr", "observation"];
  } else if (id === "post-pr-observation-last-error") {
    run = postPrRunForPhase("observing", { observation: postPrObservation({ consecutive_transient_errors: 1, last_error: postPrObservationError() }) }); canonicalPath = ["post_pr", "observation", "last_error"];
  } else if (id === "post-pr-observation-review-request") {
    run = postPrRunForPhase("observing", { observation: postPrObservation({ review_request: { status: "requested", attempts: 1, requested_at: NOW } }) }); canonicalPath = ["post_pr", "observation", "review_request"];
  } else if (id === "post-pr-observation-snapshot") {
    run = postPrRunForPhase("observing", { observation: postPrObservation({ poll_count: 1, last_observed_at: NOW, last_fingerprint: HASH_A, snapshot: postPrSnapshot() }) }); canonicalPath = ["post_pr", "observation", "snapshot"];
  } else if (id === "post-pr-remediation-null") {
    run = postPrRunForPhase("observing"); canonicalPath = ["post_pr"];
  } else if (id === "post-pr-remediation-active") {
    run = postPrRunForPhase("changes-observed"); canonicalPath = ["post_pr", "remediation"];
  } else if (id === "post-pr-remediation-owner") {
    run = postPrRunForPhase("remediation-planned"); canonicalPath = ["post_pr", "remediation", "owner"];
  } else if (id === "post-pr-remediation-changes") {
    run = postPrRunForPhase("changes-observed"); canonicalPath = ["post_pr", "remediation", "changes"];
  } else if (id === "post-pr-remediation-change-entry") {
    run = postPrRunForPhase("changes-observed"); canonicalPath = ["post_pr", "remediation", "changes", "entries", 0];
  } else if (id.startsWith("post-pr-dispatch-")) {
    const status = id.slice("post-pr-dispatch-".length);
    run = postPrRunForPhase(status === "planned" ? "remediation-planned" : status === "running" ? "remediation-running" : "changes-observed"); canonicalPath = ["post_pr", "remediation", "dispatch"];
  } else if (id === "post-pr-revalidation-empty") {
    run = postPrRunForPhase("revalidating"); canonicalPath = ["post_pr", "remediation", "revalidation"];
  } else if (id === "post-pr-revalidation-bound") {
    run = postPrRunForPhase("validated"); canonicalPath = ["post_pr", "remediation", "revalidation"];
  } else if (/^post-pr-(canonical|validator|security)-job-(planned|running|retry-wait|bound)$/u.test(id)) {
    const [, activity, state] = id.match(/^post-pr-(canonical|validator|security)-job-(planned|running|retry-wait|bound)$/u);
    run = postPrRunWithJob(activity, state); canonicalPath = ["post_pr", "remediation", "revalidation", "jobs", activity];
  } else if (id.startsWith("post-pr-push-") && id !== "post-pr-push-last-error") {
    const status = id.slice("post-pr-push-".length);
    run = postPrRunForPhase(status === "not-ready" ? "validated" : status === "pending" ? "push-pending" : "remote-confirmed"); canonicalPath = ["post_pr", "remediation", "push"];
  } else if (id === "post-pr-push-last-error") {
    run = postPrRunForPhase("push-pending", { pushError: true }); canonicalPath = ["post_pr", "remediation", "push", "last_error"];
  } else if (id === "post-pr-evidence-sidecar") {
    run = postPrRunForPhase("failure-recording"); canonicalPath = ["post_pr", "evidence_refs", 0];
  } else if (id === "post-pr-continuation-review-null") {
    run = postPrRunForPhase("succeeded"); canonicalPath = ["post_pr"];
  } else if (id === "post-pr-continuation-review-bound") {
    run = postPrRunForContinuationReview(); canonicalPath = ["post_pr", "continuation_review"];
  } else if (id === "post-pr-terminal-fact-null") {
    run = postPrRunForPhase("succeeded"); canonicalPath = ["post_pr"];
  } else if (id.startsWith("post-pr-terminal-fact-")) {
    run = postPrRunForTerminalFact(id.slice("post-pr-terminal-fact-".length)); canonicalPath = ["post_pr", "terminal_fact"];
  } else throw new TypeError(`missing canonical post-PR fixture for ${id}`);
  const source = valueAt(run, canonicalPath, id);
  const externalSources = postPrExternalSourcesFor(source, id);
  const transitionOnly = id.includes("job-retry-wait") ? "retry-wait is schema-valid only as the checked transition consumer state between a running job and its next running retry" : null;
  return { run, canonicalPath, source: structuredClone(source), externalSources, transitionOnly };
}

function postPrPolicy(enabled = true) {
  return { enabled, wait_ms: 3_600_000, initial_poll_ms: 30_000, max_poll_ms: 120_000, check_start_grace_ms: 300_000, max_transient_errors: 12, review: { required: enabled, reviewer_login: enabled ? "reviewer" : null, source: enabled ? "driver" : "none" } };
}

function postPrObservation(overrides = {}) {
  return { epoch: 1, expected_head_sha: SHA_A, started_at: NOW, deadline_at: "2026-07-16T13:00:00.000Z", next_poll_at: NOW, poll_count: 0, unchanged_count: 0, current_interval_ms: 30_000, consecutive_transient_errors: 0, last_observed_at: null, last_fingerprint: null, last_check_verdict: "not_started", last_review_verdict: "pending", last_verdict: "pending", last_error: null, review_request: { status: "pending", attempts: 0, requested_at: null }, snapshot: null, ...overrides };
}

function postPrObservationError() { return { class: "network", exit_code: 1, occurred_at: NOW, next_retry_at: "2026-07-16T12:01:00.000Z" }; }
function postPrSnapshot() { return { checks: [{ name: "ci", verdict: "red" }], reviews: [{ login: "reviewer", verdict: "pending" }] }; }
function postPrOwner() { return { kind: "slice", slice_id: "backend", stack: "backend", path_b64url: null, method: "check-slice-id" }; }
function postPrChangeEntry(path = "src/backend.js") { return { source: "commit", status: "modified", index_status: null, worktree_status: null, path, previous_path: null, old_mode: "100644", new_mode: "100644" }; }
function postPrChanges(bound = false, path = "src/backend.js") { return bound ? { paths: [path], entries: [postPrChangeEntry(path)], tree_hash: HASH_A } : { paths: [], entries: [], tree_hash: null }; }

function postPrDispatch(status = "planned") {
  return { id: "dispatch-1", status, role: "backend-builder", subject: "backend", started_at: status === "planned" ? null : NOW, returned_at: status === "returned" ? "2026-07-16T12:05:00.000Z" : null };
}

function postPrJob(activity, status) {
  const bound = status === "bound";
  const started = status !== "planned";
  const external = POST_PR_EXTERNAL[activity];
  return { dispatch_id: `${activity}-dispatch-1`, status, action_token: started ? `${activity}-action-1` : null, steering_generation: started ? 2 : null, started_at: started ? NOW : null, returned_at: bound ? "2026-07-16T12:05:00.000Z" : null, result_ref: bound ? external.ref : null, result_hash: bound ? hashBytes(external.bytes) : null, verdict: bound ? (activity === "canonical" ? "pass" : activity === "validator" ? "GO" : "PASS") : null, transient_error_count: status === "retry-wait" ? 1 : 0, next_retry_at: status === "retry-wait" ? "2026-07-16T12:06:00.000Z" : null, last_error: status === "retry-wait" ? "network" : null };
}

function postPrRevalidation(bound = false, jobs = {}) {
  return { canonical_evidence_ref: bound ? POST_PR_EXTERNAL.canonical.ref : null, canonical_evidence_hash: bound ? hashBytes(POST_PR_EXTERNAL.canonical.bytes) : null, canonical_verdict: bound ? "pass" : null, validator_review_ref: bound ? POST_PR_EXTERNAL.validator.ref : null, validator_review_hash: bound ? hashBytes(POST_PR_EXTERNAL.validator.bytes) : null, validator_verdict: bound ? "GO" : null, security_review_ref: bound ? POST_PR_EXTERNAL.security.ref : null, security_review_hash: bound ? hashBytes(POST_PR_EXTERNAL.security.bytes) : null, security_verdict: bound ? "PASS" : null, jobs: structuredClone(jobs) };
}

function postPrPush(status = "not-ready", lastError = null) {
  return { status, remote_before_sha: status === "not-ready" ? null : SHA_A, local_head_sha: status === "not-ready" ? null : SHA_B, remote_after_sha: status === "confirmed" ? SHA_B : null, consecutive_transient_errors: lastError ? lastError.error_count : 0, next_retry_at: lastError?.next_retry_at ?? null, pushed_at: status === "confirmed" ? NOW : null, last_error: lastError };
}

function postPrPushError({ classification = "transient", errorCount = 1, nextRetryAt = "2026-07-16T12:01:00.000Z", errorClass = "network" } = {}) {
  return { operation: "fast-forward-push", observed_at: NOW, error_class: errorClass, exit_code: 1, classification, error_count: errorCount, error_limit: 12, expected_remote_sha: SHA_A, candidate_head_sha: SHA_B, next_retry_at: nextRetryAt };
}

function postPrRemediation(stage = "planned", options = {}) {
  const changed = ["changes-observed", "committed", "revalidating", "validated", "push-pending", "remote-confirmed"].includes(stage);
  const revalidationBound = ["validated", "push-pending", "remote-confirmed"].includes(stage);
  const dispatchStatus = stage === "planned" ? "planned" : stage === "running" ? "running" : "returned";
  const jobs = revalidationBound ? { canonical: postPrJob("canonical", "bound"), validator: postPrJob("validator", "bound"), security: postPrJob("security", "bound") } : {};
  const pushStatus = stage === "push-pending" ? "pending" : stage === "remote-confirmed" ? "confirmed" : "not-ready";
  const pushError = options.pushError ? postPrPushError() : null;
  return { schema_version: 1, attempt: 1, reason_code: "check-red", failure_fingerprint: HASH_A, failed_head_sha: SHA_A, failure_evidence_ref: POST_PR_EXTERNAL.failure.ref, failure_evidence_hash: hashBytes(POST_PR_EXTERNAL.failure.bytes), owner: postPrOwner(), route: "backend-builder", lane: "slice", stage, baseline_head_sha: SHA_A, dispatch: postPrDispatch(dispatchStatus), changes: postPrChanges(changed), candidate_head_sha: changed ? SHA_B : null, remediation_evidence_ref: changed ? POST_PR_EXTERNAL.remediation.ref : null, remediation_evidence_hash: changed ? hashBytes(POST_PR_EXTERNAL.remediation.bytes) : null, revalidation: postPrRevalidation(revalidationBound, jobs), push: postPrPush(pushStatus, pushError), ...options.overrides };
}

function postPrRoot({ policy = postPrPolicy(true), phase = "awaiting-pr", attempt = 0, observation = null, remediation = null, evidenceRefs = [], continuationReview = null, terminalFact = null } = {}) {
  return { schema_version: 1, policy, phase, attempt, observation, remediation, evidence_refs: evidenceRefs, continuation_review: continuationReview, terminal_fact: terminalFact };
}

function postPrRunForPhase(phase, options = {}) {
  const disabled = phase === "disabled";
  const terminal = ["succeeded", "blocked", "needs-human"].includes(phase);
  const activeObservation = !["disabled", "awaiting-pr"].includes(phase);
  let observation = options.observation ?? (activeObservation ? postPrObservation() : null);
  let remediation = null;
  let attempt = 0;
  let evidenceRefs = [];
  if (["failure-recording", "remediation-planned", "remediation-running", "changes-observed", "committed", "revalidating", "validated", "push-pending", "remote-confirmed"].includes(phase)) {
    const stage = phase === "failure-recording" ? "planned" : phase.replace("remediation-", "");
    remediation = postPrRemediation(stage, options);
    attempt = 1;
    evidenceRefs = [{ ref: remediation.failure_evidence_ref, hash: remediation.failure_evidence_hash }];
    observation = options.observation ?? postPrObservation({ poll_count: 1, last_observed_at: NOW, last_fingerprint: HASH_A, last_check_verdict: "red", last_verdict: "red", snapshot: postPrSnapshot() });
  }
  if (phase === "succeeded") observation = postPrObservation({ poll_count: 1, last_observed_at: NOW, last_check_verdict: "pass", last_review_verdict: "pass", last_verdict: "green" });
  if (phase === "blocked") observation = postPrObservation({ poll_count: 1, last_observed_at: NOW, last_verdict: "infrastructure" });
  if (phase === "needs-human") observation = postPrObservation({ poll_count: 1, last_observed_at: NOW, last_review_verdict: "red", last_verdict: "red" });
  const postPr = postPrRoot({ policy: postPrPolicy(!disabled), phase, attempt, observation, remediation, evidenceRefs });
  const status = phase === "succeeded" ? "completed" : phase === "blocked" ? "blocked" : phase === "needs-human" ? "needs-human" : "running";
  const reason = phase === "succeeded" ? "post-pr-ci-green" : phase === "blocked" ? "post-pr-observer-infrastructure" : phase === "needs-human" ? "post-pr-review-changes-requested" : null;
  return postPrRun(postPr, { status, reason, terminal });
}

function postPrRunWithJob(activity, state) {
  const remediation = postPrRemediation("revalidating");
  const jobs = {};
  if (activity !== "canonical") jobs.canonical = postPrJob("canonical", "bound");
  if (activity === "security") jobs.validator = postPrJob("validator", "bound");
  jobs[activity] = postPrJob(activity, state);
  remediation.revalidation = postPrRevalidation(false, jobs);
  for (const prior of ["canonical", "validator", "security"]) {
    const job = jobs[prior];
    if (job?.status !== "bound") continue;
    const refPrefix = prior === "canonical" ? "canonical_evidence" : `${prior}_review`;
    remediation.revalidation[`${refPrefix}_ref`] = job.result_ref;
    remediation.revalidation[`${refPrefix}_hash`] = job.result_hash;
    remediation.revalidation[`${prior}_verdict`] = job.verdict;
  }
  const observation = postPrObservation({ poll_count: 1, last_observed_at: NOW, last_check_verdict: "red", last_verdict: "red" });
  const postPr = postPrRoot({ phase: "revalidating", attempt: 1, observation, remediation, evidenceRefs: [{ ref: remediation.failure_evidence_ref, hash: remediation.failure_evidence_hash }] });
  return postPrRun(postPr);
}

function postPrRunForContinuationReview() {
  const remediation = postPrRemediation("planned");
  const binding = { ref: POST_PR_EXTERNAL.continuation.ref, hash: hashBytes(POST_PR_EXTERNAL.continuation.bytes) };
  const postPr = postPrRoot({ phase: "blocked", attempt: 1, observation: postPrObservation({ poll_count: 1, last_observed_at: NOW, last_check_verdict: "red", last_verdict: "red" }), remediation, evidenceRefs: [{ ref: remediation.failure_evidence_ref, hash: remediation.failure_evidence_hash }], continuationReview: binding });
  return postPrRun(postPr, { status: "blocked", reason: "post-pr-retry-exhausted", terminal: true, maxRetries: 1 });
}

function postPrRunForTerminalFact(variant) {
  let remediation = null;
  let observation = postPrObservation();
  let reason;
  let fact;
  if (variant === "account-switch-failed-github-auth") {
    reason = "post-pr-account-switch-failed";
    observation = postPrObservation({ last_error: { class: "account-auth", exit_code: 1, occurred_at: NOW, next_retry_at: null } });
    fact = { schema_version: 1, kind: "account-switch-failed", observed_at: NOW, operation: "gh-auth-switch", github_account: "acme", error_class: "account-auth", exit_code: 1 };
  } else {
    remediation = postPrRemediation("revalidating");
    if (variant === "account-switch-failed-push") {
      reason = "post-pr-account-switch-failed";
      const error = postPrPushError({ classification: "permanent", nextRetryAt: null, errorClass: "permission" }); remediation = postPrRemediation("push-pending"); remediation.push = postPrPush("pending", error);
      fact = { schema_version: 1, kind: "account-switch-failed", observed_at: NOW, attempt: 1, operation: error.operation, error_class: error.error_class, exit_code: error.exit_code, classification: "permanent", error_count: 1, error_limit: 12, expected_remote_sha: SHA_A, candidate_head_sha: SHA_B, next_retry_at: null };
    } else if (variant === "dispatch-start-unknown") {
      reason = "post-pr-dispatch-start-unknown"; remediation.revalidation.jobs = { validator: postPrJob("validator", "running") };
      fact = { schema_version: 1, kind: "dispatch-start-unknown", observed_at: NOW, attempt: 1, activity: "validator", dispatch_id: "validator-dispatch-1", dispatch_started_at: NOW, candidate_head_sha: SHA_B, outcome: "return-unknown" };
    } else if (variant === "path-lane-violation") {
      reason = "post-pr-path-lane-violation"; remediation.stage = "changes-observed"; remediation.changes = postPrChanges(true, "src/other.js");
      fact = { schema_version: 1, kind: "path-lane-violation", observed_at: NOW, attempt: 1, lane: "slice", source: "remediation-diff", violation: "outside-lane", path_b64url: Buffer.from("src/other.js").toString("base64url"), changes_hash: hashCanonical(remediation.changes) };
    } else if (variant === "remote-head-diverged") {
      reason = "post-pr-remote-head-diverged"; remediation = postPrRemediation("push-pending");
      fact = { schema_version: 1, kind: "remote-head-diverged", observed_at: NOW, attempt: 1, expected_remote_sha: SHA_A, candidate_head_sha: SHA_B, observed_remote_sha: SHA_C };
    } else if (variant === "panel-runner-result-malformed") {
      reason = "post-pr-metadata-unsafe"; remediation.revalidation.jobs = { security: postPrJob("security", "running") };
      fact = { schema_version: 1, kind: "panel-runner-result-malformed", observed_at: NOW, attempt: 1, activity: "security", dispatch_id: "security-dispatch-1", candidate_head_sha: SHA_B, issue: "missing-verdict" };
    } else if (variant === "push-failed") {
      reason = "post-pr-push-failed"; const error = postPrPushError({ classification: "exhausted", errorCount: 12, nextRetryAt: null }); remediation = postPrRemediation("push-pending"); remediation.push = postPrPush("pending", error);
      fact = { schema_version: 1, kind: "push-failed", observed_at: NOW, attempt: 1, operation: error.operation, error_class: error.error_class, exit_code: error.exit_code, classification: "exhausted", error_count: 12, error_limit: 12, expected_remote_sha: SHA_A, candidate_head_sha: SHA_B, next_retry_at: null };
    } else if (variant === "panel-attribution-unsafe") {
      reason = "post-pr-panel-attribution-unsafe";
      fact = { schema_version: 1, kind: "panel-attribution-unsafe", observed_at: NOW, attempt: 1, candidate_head_sha: SHA_B, panel: "combined", category: "mixed-owner", affected_paths_hash: "a".repeat(64) };
    } else throw new TypeError(`unknown post-PR terminal fact ${variant}`);
  }
  const evidenceRefs = remediation ? [{ ref: remediation.failure_evidence_ref, hash: remediation.failure_evidence_hash }] : [];
  const postPr = postPrRoot({ phase: "needs-human", attempt: remediation ? 1 : 0, observation, remediation, evidenceRefs, terminalFact: fact });
  return postPrRun(postPr, { status: "needs-human", reason, terminal: true, githubAccount: "acme" });
}

function postPrRun(postPr, { status = "running", reason = null, terminal = false, maxRetries = 3, githubAccount = "acme" } = {}) {
  const hasPr = postPr.phase !== "disabled" && postPr.phase !== "awaiting-pr";
  return { schema_version: 1, run_id: "catalog-run", status, max_retries: maxRetries, gates: hasPr ? { pre_pr: { status: "approved", answer: "approve", answered_at: NOW } } : {}, pr_url: hasPr ? "https://github.com/acme/repo/pull/7" : null, github_account: githubAccount, post_pr: postPr, terminal_result: terminal ? { status, run_id: "catalog-run", pr_url: "https://github.com/acme/repo/pull/7", reason, summary: reason, artifacts: {} } : null };
}

function postPrExternalSourcesFor(source, id) {
  const matches = {};
  const definitions = id.match(/^post-pr-(canonical|validator|security)-job-bound$/u)
    ? [[`${id.match(/^post-pr-(canonical|validator|security)/u)[1]}-result`, POST_PR_EXTERNAL[id.match(/^post-pr-(canonical|validator|security)/u)[1]]]]
    : id === "post-pr-evidence-sidecar" ? [["sidecar", POST_PR_EXTERNAL.failure]]
      : id === "post-pr-continuation-review-bound" ? [["continuation-review", POST_PR_EXTERNAL.continuation]]
        : id === "post-pr-remediation-active" ? [["failure-evidence", POST_PR_EXTERNAL.failure], ["remediation", POST_PR_EXTERNAL.remediation]]
          : id === "post-pr-revalidation-bound" ? [["canonical", POST_PR_EXTERNAL.canonical], ["validator", POST_PR_EXTERNAL.validator], ["security", POST_PR_EXTERNAL.security]]
            : Object.entries(POST_PR_EXTERNAL);
  for (const [name, external] of definitions) if (containsScalar(source, external.ref)) matches[name] = structuredClone(external);
  return matches;
}

function containsScalar(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsScalar(item, expected));
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some((item) => containsScalar(item, expected));
}

function exactFacts(source) {
  const facts = [];
  const visit = (value, path) => {
    if (value === null || typeof value !== "object" || (Array.isArray(value) && value.length === 0) || (!Array.isArray(value) && Object.keys(value).length === 0)) {
      facts.push(fact(path, structuredClone(value))); return;
    }
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, [...path, index]));
    else for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
  };
  visit(source, []);
  return facts;
}

function buildAmendmentCatalogFixtures() {
  const ownerEvidence = externalJson("evidence/catalog-amendment-owner.json", { subject: "owner", attempt: 1, status: "pass", review_ready: true, head_sha: SHA_B });
  const ownerReview = externalJson("reviews/catalog-amendment-owner.json", { subject: "owner", attempt: 1, verdict: "APPROVE", reviewed_commit: SHA_B, late_discovery_strike: false, required_fixes: [] });
  const ownerAttemptReview = {
    attempt: 1, evidence_ref: ownerEvidence.ref, evidence_hash: hashBytes(ownerEvidence.bytes), review_ref: ownerReview.ref,
    review_hash: hashBytes(ownerReview.bytes), reviewed_commit: SHA_B, diff_base_commit: SHA_A, ratified_paths: [], verdict: "APPROVE",
    convergence: "converging", late_discovery_strike: false, remaining_fix_count: 0,
  };
  const admission = {
    baseline_ref: "refs/heads/catalog-feature", baseline_commit: SHA_A, baseline_tree: SHA_B, worktree: "/tmp/catalog-feature",
    probe: { schema_version: 1, kind: "integration-amendment-probe", delivery_unit_id: "consumer-unit", consumer_slice_id: "consumer", verification_artifact_id: "consumer-tests", test_plan_index: 0, test_plan_entry: "node --test test/consumer.test.js", program: "node", args: ["--test", "test/consumer.test.js"], substrate: "feature-baseline" },
    owner: { id: "owner", stack: "backend", depends_on: [], declared_paths: ["src/owner/**"], effective_paths: ["src/owner/**"], status: "merged", attempts: 1, attempt_reviews: [ownerAttemptReview], evidence_ref: ownerEvidence.ref, evidence_hash: ownerAttemptReview.evidence_hash, review_ref: ownerReview.ref, review_hash: ownerAttemptReview.review_hash, reviewed_commit: SHA_B, merge_commit: SHA_A },
    consumer: { id: "consumer", stack: "backend", depends_on: ["owner"], declared_paths: ["src/consumer/**"], effective_paths: ["src/consumer/**"], status: "pending", attempts: 0 },
  };
  const identity = { schema_version: 1, kind: "integration-amendment-identity", run_id: "catalog-run", defect_path: "src/owner/api.js", admission };
  const amendmentId = createHash("sha256").update(canonicalJson(identity), "utf8").digest("base64url");
  const receipts = Object.fromEntries(AMENDMENT_RECEIPT_VARIANTS.map(([, phase, outcome]) => [`${phase}:${outcome}`, amendmentExecutionReceipt(phase, outcome, amendmentId, admission.probe)]));
  const reportReceipt = receipts["report:nonzero-exit"];
  const reportReceiptExternal = externalJson(`evidence/integration-amendment-${amendmentId}.report.receipt.json`, reportReceipt);
  const reportClaim = amendmentExecutionClaim("report", "completed", "fail", amendmentId, identity, admission.probe, reportReceiptExternal);
  const reportClaimExternal = externalJson("evidence/integration-amendment.report.claim.json", reportClaim);
  const verificationReceipt = receipts["verify:pass"];
  const verificationReceiptExternal = externalJson(`evidence/integration-amendment-${amendmentId}.verify.receipt.json`, verificationReceipt);
  const verificationClaim = amendmentExecutionClaim("verify", "completed", "pass", amendmentId, identity, admission.probe, verificationReceiptExternal, { head_sha: SHA_C, tree_sha: SHA_C, cwd: `/tmp/catalog-feature/.opencode/worktrees/catalog-feature--amend-${amendmentId}-staged` });
  const verificationClaimExternal = externalJson(`evidence/integration-amendment-${amendmentId}.verify.claim.json`, verificationClaim);
  const commonExternal = { "owner-evidence": ownerEvidence, "owner-review": ownerReview, "report-claim": reportClaimExternal, "report-receipt": reportReceiptExternal };
  const base = {
    schema_version: 1, kind: "integration-amendment", amendment_id: amendmentId, status: "reported", owner_slice_id: "owner", consumer_slice_id: "consumer",
    defect_path: "src/owner/api.js", verification_artifact_id: "consumer-tests", admission,
    failure_execution: { claim_ref: reportClaimExternal.ref, claim_hash: hashBytes(reportClaimExternal.bytes), receipt_ref: reportReceiptExternal.ref, receipt_hash: hashBytes(reportReceiptExternal.bytes) },
    max_attempts: 2, attempts: [], created_at: NOW, updated_at: NOW,
  };
  const attempts = {
    building1: amendmentBuildingAttempt(amendmentId, 1, SHA_A),
  };
  const reviewed1Approve = amendmentReviewedAttempt(amendmentId, 1, SHA_A, "APPROVE");
  const reviewed1Reject = amendmentReviewedAttempt(amendmentId, 1, SHA_A, "REJECT");
  attempts.building2 = amendmentBuildingAttempt(amendmentId, 2, reviewed1Reject.attempt.reviewed_commit);
  const reviewed2Approve = amendmentReviewedAttempt(amendmentId, 2, reviewed1Reject.attempt.reviewed_commit, "APPROVE");
  const reviewed2Reject = amendmentReviewedAttempt(amendmentId, 2, reviewed1Reject.attempt.reviewed_commit, "REJECT");
  const integrated = { ref: `refs/opencode/integration-amendments/${amendmentId}/staged`, worktree: `/tmp/catalog-feature/.opencode/worktrees/catalog-feature--amend-${amendmentId}-staged`, commit: SHA_C, tree: reviewed1Approve.attempt.reviewed_tree };
  const verification = { claim_ref: verificationClaimExternal.ref, claim_hash: hashBytes(verificationClaimExternal.bytes), receipt_ref: verificationReceiptExternal.ref, receipt_hash: hashBytes(verificationReceiptExternal.bytes) };
  const blocked = (source, origin) => ({ ...source, status: "blocked", blocked: { origin, reason: "catalog amendment stopped", blocked_at: NOW } });
  const reviewedSource = (reviewed) => ({ ...base, status: "reviewed", attempts: reviewed.attempts || [reviewed.attempt] });
  const manifestVariants = {
    reported: base,
    "building-1": { ...base, status: "building", attempts: [attempts.building1] },
    "building-2": { ...base, status: "building", attempts: [reviewed1Reject.attempt, attempts.building2] },
    "reviewed-approve-1": reviewedSource(reviewed1Approve),
    "reviewed-reject-1": reviewedSource(reviewed1Reject),
    "reviewed-approve-2": reviewedSource({ attempts: [reviewed1Reject.attempt, reviewed2Approve.attempt] }),
    "reviewed-reject-2": reviewedSource({ attempts: [reviewed1Reject.attempt, reviewed2Reject.attempt] }),
    integrated: { ...reviewedSource(reviewed1Approve), status: "integrated", integration: integrated },
    verified: { ...reviewedSource(reviewed1Approve), status: "verified", integration: integrated, verification },
    merged: { ...reviewedSource(reviewed1Approve), status: "merged", integration: integrated, verification, publication: { branch_ref: admission.baseline_ref, previous_commit: admission.baseline_commit, commit: integrated.commit, published_at: NOW } },
  };
  manifestVariants["blocked-reported"] = blocked(base, "reported");
  manifestVariants["blocked-building"] = blocked(manifestVariants["building-1"], "building");
  manifestVariants["blocked-reviewed-approve"] = blocked(manifestVariants["reviewed-approve-1"], "reviewed-approve");
  manifestVariants["blocked-reviewed-reject"] = blocked(manifestVariants["reviewed-reject-1"], "reviewed-reject");
  manifestVariants["blocked-integrated"] = blocked(manifestVariants.integrated, "integrated");
  manifestVariants["blocked-verified"] = blocked(manifestVariants.verified, "verified");

  const externalForVariant = (variant) => {
    if (["building-2", "reviewed-reject-1", "blocked-reviewed-reject"].includes(variant)) return reviewed1Reject.external;
    if (["reviewed-approve-2"].includes(variant)) return { ...reviewed1Reject.external, ...reviewed2Approve.external };
    if (["reviewed-reject-2"].includes(variant)) return { ...reviewed1Reject.external, ...reviewed2Reject.external };
    if (["reviewed-approve-1", "integrated", "verified", "merged", "blocked-reviewed-approve", "blocked-integrated", "blocked-verified"].includes(variant)) return reviewed1Approve.external;
    return {};
  };
  const manifests = Object.fromEntries(AMENDMENT_MANIFEST_VARIANTS.map(([id, variant]) => [id, {
    source: structuredClone(manifestVariants[variant]),
    externalSources: structuredClone({ ...commonExternal, ...externalForVariant(variant), ...(variant === "verified" || variant === "merged" || variant === "blocked-verified" ? { "verify-claim": verificationClaimExternal, "verify-receipt": verificationReceiptExternal } : {}) }),
  }]));
  const claims = Object.fromEntries(AMENDMENT_CLAIM_VARIANTS.map(([id, phase, state, outcome]) => {
    const receiptOutcome = outcome === "pass" ? "pass" : "nonzero-exit";
    const receipt = receipts[`${phase}:${receiptOutcome}`];
    const receiptExternal = externalJson(`evidence/integration-amendment-${amendmentId}.${phase}.receipt.json`, receipt);
    return [id, { source: amendmentExecutionClaim(phase, state, outcome, amendmentId, identity, admission.probe, receiptExternal), externalSources: state === "completed" ? { receipt: receiptExternal } : {} }];
  }));
  const receiptRows = Object.fromEntries(AMENDMENT_RECEIPT_VARIANTS.map(([id, phase, outcome]) => [id, { source: receipts[`${phase}:${outcome}`], externalSources: {} }]));
  const reviews = Object.fromEntries([["amendment-review-approve", amendmentReview(amendmentId, 1, "APPROVE")], ["amendment-review-reject", amendmentReview(amendmentId, 1, "REJECT")]]);
  const dispatch = amendmentBuilderDispatch(amendmentId, 1);
  return { amendmentId, identity, admission, manifests, claims, receipts: receiptRows, reviews, dispatch };
}

function amendmentExecutionReceipt(phase, outcome, amendmentId, probe) {
  const values = {
    pass: { outcome: "exited", status: "pass", exit_code: 0, signal: null, error_code: null },
    "nonzero-exit": { outcome: "exited", status: "fail", exit_code: 1, signal: null, error_code: null },
    signal: { outcome: "signaled", status: "fail", exit_code: null, signal: "SIGTERM", error_code: null },
    "launch-error": { outcome: "launch-error", status: "fail", exit_code: null, signal: null, error_code: "spawn-failed" },
    timeout: { outcome: "timeout", status: "fail", exit_code: null, signal: "SIGKILL", error_code: null },
    "output-limit": { outcome: "output-limit", status: "fail", exit_code: null, signal: "SIGKILL", error_code: null },
  }[outcome];
  const head = phase === "report" ? SHA_A : SHA_C;
  const cwd = phase === "report" ? "/tmp/catalog-feature" : `/tmp/catalog-feature/.opencode/worktrees/catalog-feature--amend-${amendmentId}-staged`;
  const stdout = emptyCommandStream();
  if (outcome === "output-limit") Object.assign(stdout, { captured_bytes: 1, sha256: hashBytes("x"), truncated: true });
  return {
    schema_version: 1, kind: "integration-amendment-execution-receipt", phase, subject: `integration-amendment:${amendmentId}:${phase}`, run_id: "catalog-run", amendment_id: amendmentId,
    claim_nonce: `${phase}-catalog-nonce`, probe: structuredClone(probe), head_sha: head, tree_sha: phase === "report" ? SHA_B : SHA_C, cwd,
    started_at: NOW, completed_at: NOW, duration_ms: 1, status: values.status, review_ready: phase === "report" ? outcome === "nonzero-exit" : outcome === "pass",
    commands: [{ index: 0, program: probe.program, args: structuredClone(probe.args), ...values, duration_ms: 1, stdout, stderr: emptyCommandStream() }],
  };
}

function amendmentExecutionClaim(phase, state, outcome, amendmentId, identity, probe, receiptExternal, overrides = {}) {
  const source = {
    schema_version: 1, kind: "integration-amendment-execution-claim", phase, subject: `integration-amendment:${amendmentId}:${phase}`, state,
    nonce: `${phase}-catalog-nonce`, amendment_id: amendmentId, identity: structuredClone(identity), run_id: "catalog-run", probe: structuredClone(probe),
    head_sha: phase === "report" ? SHA_A : SHA_C, tree_sha: phase === "report" ? SHA_B : SHA_C,
    cwd: phase === "report" ? "/tmp/catalog-feature" : `/tmp/catalog-feature/.opencode/worktrees/catalog-feature--amend-${amendmentId}-staged`,
    receipt_ref: receiptExternal.ref, claimed_at: NOW, ...overrides,
  };
  if (state === "completed") Object.assign(source, { completed_at: NOW, status: outcome, receipt_hash: hashBytes(receiptExternal.bytes) });
  if (state === "unknown") Object.assign(source, { failed_at: NOW, reason: outcome, receipt_status: null, receipt_hash: null });
  return source;
}

function amendmentBuildingAttempt(amendmentId, attempt, base) {
  return { attempt, state: "building", build_base_commit: base, branch_ref: `refs/heads/catalog-feature--amend-${amendmentId}-a${attempt}`, worktree: `/tmp/catalog-feature/.opencode/worktrees/catalog-feature--amend-${amendmentId}-a${attempt}` };
}

function amendmentReviewedAttempt(amendmentId, attempt, base, verdict) {
  const building = amendmentBuildingAttempt(amendmentId, attempt, base);
  const dispatch = amendmentBuilderDispatch(amendmentId, attempt);
  const review = amendmentReview(amendmentId, attempt, verdict);
  const reviewExternal = externalJson(`reviews/integration-amendment-${amendmentId}.attempt-${attempt}.json`, review);
  return {
    attempt: { ...building, state: "reviewed", dispatch_claim_ref: dispatch.claimExternal.ref, dispatch_claim_hash: hashBytes(dispatch.claimExternal.bytes), dispatch_closure_ref: dispatch.closureExternal.ref, dispatch_closure_hash: hashBytes(dispatch.closureExternal.bytes), candidate_commit: SHA_C, candidate_tree: SHA_C, changed_paths: ["src/owner/api.js"], review_ref: reviewExternal.ref, review_hash: hashBytes(reviewExternal.bytes), reviewed_commit: SHA_C, reviewed_tree: SHA_C },
    external: { [`dispatch-claim-${attempt}-${verdict.toLowerCase()}`]: dispatch.claimExternal, [`dispatch-closure-${attempt}-${verdict.toLowerCase()}`]: dispatch.closureExternal, [`review-${attempt}-${verdict.toLowerCase()}`]: reviewExternal },
  };
}

function amendmentReview(amendmentId, attempt, verdict) {
  return { schema_version: 1, kind: "integration-amendment-review", subject: `integration-amendment:${amendmentId}`, amendment_id: amendmentId, attempt, build_base_commit: attempt === 1 ? SHA_A : SHA_C, reviewed_commit: SHA_C, reviewed_tree: SHA_C, changed_paths: ["src/owner/api.js"], dispositions: Object.fromEntries(["accepted_contract", "public_contract", "persisted_contract", "product_scope", "security_boundary", "generated_ownership", "decomposition"].map((key) => [key, "preserved"])), verdict, required_fixes: verdict === "APPROVE" ? [] : ["correct the owner implementation"], reviewed_at: NOW };
}

function amendmentBuilderDispatch(amendmentId, attempt) {
  const instance = `${amendmentId}:attempt-${attempt}`;
  const claimRef = `dispatch/${String(attempt).repeat(64)}.special.json`;
  const closureRef = `${claimRef.slice(0, -5)}.closed.json`;
  const token = `catalog-amendment-builder-${attempt}`;
  const claim = { schema_version: 1, kind: "checked-special-builder-dispatch-claim", run_id: "catalog-run", route: "integration-amendment", instance, agent: "backend-builder", branch: `catalog-feature--amend-${amendmentId}-a${attempt}`, worktree: `/tmp/catalog-feature/.opencode/worktrees/catalog-feature--amend-${amendmentId}-a${attempt}`, head: attempt === 1 ? SHA_A : SHA_C, run_hash: HASH_A, context_hash: HASH_B, completion_token_hash: hashBytes(token), claimed_at: NOW, closure_ref: closureRef };
  const claimExternal = externalJson(claimRef, claim);
  const closure = { schema_version: 1, kind: "checked-special-builder-dispatch-closure", claim_ref: claimRef, claim_hash: hashBytes(claimExternal.bytes), run_id: claim.run_id, route: claim.route, instance, agent: claim.agent, branch: claim.branch, worktree: claim.worktree, head: claim.head, completion_head: SHA_C, run_hash: claim.run_hash, context_hash: claim.context_hash, completion_token: token, returned_at: NOW };
  const closureExternal = externalJson(closureRef, closure);
  return { claim, closure, claimExternal, closureExternal, activeBinding: { schema_version: 1, route: "integration-amendment", instance, agent: "backend-builder", claim_ref: claimRef, claim_hash: hashBytes(claimExternal.bytes) }, closedBinding: { schema_version: 1, route: "integration-amendment", instance, agent: "backend-builder", claim_ref: claimRef, claim_hash: hashBytes(claimExternal.bytes), closure_ref: closureRef, closure_hash: hashBytes(closureExternal.bytes), completion_head: SHA_C } };
}

function externalJson(ref, value) {
  return { ref, bytes: `${JSON.stringify(value, null, 2)}\n` };
}

function emptyCommandStream() {
  return { captured_bytes: 0, sha256: hashBytes(""), truncated: false };
}

function amendmentManifestEntry(id, variant) {
  const fixture = AMENDMENT_CATALOG.manifests[id];
  const source = structuredClone(fixture.source);
  const externalSources = structuredClone(fixture.externalSources);
  const sidecars = [
    amendmentNamedSidecar(externalSources, "owner-evidence", ["admission", "owner", "evidence_ref"], ["admission", "owner", "evidence_hash"]),
    amendmentNamedSidecar(externalSources, "owner-review", ["admission", "owner", "review_ref"], ["admission", "owner", "review_hash"]),
    amendmentNamedSidecar(externalSources, "report-claim", ["failure_execution", "claim_ref"], ["failure_execution", "claim_hash"]),
    amendmentNamedSidecar(externalSources, "report-receipt", ["failure_execution", "receipt_ref"], ["failure_execution", "receipt_hash"]),
  ];
  for (const [index, attempt] of source.attempts.entries()) {
    if (attempt.state !== "reviewed") continue;
    sidecars.push(
      amendmentRefSidecar(externalSources, `attempt-${index + 1}-dispatch-claim`, ["attempts", index, "dispatch_claim_ref"], ["attempts", index, "dispatch_claim_hash"], attempt.dispatch_claim_ref),
      amendmentRefSidecar(externalSources, `attempt-${index + 1}-dispatch-closure`, ["attempts", index, "dispatch_closure_ref"], ["attempts", index, "dispatch_closure_hash"], attempt.dispatch_closure_ref),
      amendmentRefSidecar(externalSources, `attempt-${index + 1}-review`, ["attempts", index, "review_ref"], ["attempts", index, "review_hash"], attempt.review_ref),
    );
  }
  if (source.verification) sidecars.push(
    amendmentNamedSidecar(externalSources, "verify-claim", ["verification", "claim_ref"], ["verification", "claim_hash"]),
    amendmentNamedSidecar(externalSources, "verify-receipt", ["verification", "receipt_ref"], ["verification", "receipt_hash"]),
  );
  return recordEntry({
    authorityClassId: "pr79-merged-slice-repair", id, record: "run.json.integration_amendment", variant,
    writer: `transitionIntegrationAmendment ${variant} checked transition`,
    readers: ["validateIntegrationAmendment", "inspectIntegrationAmendmentInventory", "assertIntegrationAmendmentConsistency", "successor transition and merged downstream writer guard"],
    tests: [`test/durable-record-mutations.test.js: ${id} production mutation matrix`, "test/integration-amendment.test.js: closed manifest variants and lifecycle"],
    source, canonicalPath: ["integration_amendment"], externalSources, facts: exactFacts(source), sidecars,
    requiredPath: ["status"], typePath: ["attempts"],
    targets: [schema(["schema_version"]), kind(["kind"], "other-amendment"), time(["updated_at"]), ...sidecars.flatMap((binding) => externalSidecarTargets(binding.name, binding.refPath, binding.hashPath)), drift([], "failure_execution", "report_execution"), stale(["admission", "baseline_commit"], SHA_C), cross(["consumer_slice_id"], "owner")],
  });
}

function amendmentExecutionClaimEntry(id, phase, state, outcome) {
  const fixture = AMENDMENT_CATALOG.claims[id];
  const source = structuredClone(fixture.source);
  const externalSources = structuredClone(fixture.externalSources);
  const sidecars = state === "completed" ? [externalSidecar("receipt", ["receipt_ref"], ["receipt_hash"])] : [];
  return recordEntry({
    authorityClassId: "pr79-merged-slice-repair", id, record: phase === "report" ? "evidence/integration-amendment.report.claim.json" : "evidence/integration-amendment-<A>.verify.claim.json", variant: `${phase}:${state}${outcome ? `:${outcome}` : ""}`,
    writer: `executeIntegrationAmendment ${phase} create-only claim and terminal claim transition`,
    readers: ["validateIntegrationAmendmentExecutionClaim", "inspectIntegrationAmendmentInventory", "executeIntegrationAmendment exact replay", "transitionIntegrationAmendment execution consumer"],
    tests: [`test/durable-record-mutations.test.js: ${id} production mutation matrix`, "test/integration-amendment.test.js: execution claim lifecycle"],
    source, canonicalPath: ["evidence", id], externalSources, facts: exactFacts(source), sidecars,
    requiredPath: ["state"], typePath: ["nonce"],
    targets: [schema(["schema_version"]), kind(["kind"], "other-claim"), time([state === "completed" ? "completed_at" : state === "unknown" ? "failed_at" : "claimed_at"]), ...(sidecars.length ? sidecars.flatMap((binding) => externalSidecarTargets(binding.name, binding.refPath, binding.hashPath)) : [ref(["receipt_ref"]), ...(state === "unknown" ? [hash(["receipt_hash"])] : [])]), drift([], "phase", "execution_phase"), stale(["head_sha"], phase === "report" ? SHA_C : SHA_A), cross(["run_id"], "other-run")],
  });
}

function amendmentExecutionReceiptEntry(id, phase, outcome) {
  const source = structuredClone(AMENDMENT_CATALOG.receipts[id].source);
  return recordEntry({
    authorityClassId: "pr79-merged-slice-repair", id, record: `evidence/integration-amendment-<A>.${phase}.receipt.json`, variant: `${phase}:${outcome}`,
    writer: `executeIntegrationAmendment ${phase} create-only execution receipt publication`,
    readers: ["validateIntegrationAmendmentExecutionReceipt", "inspectIntegrationAmendmentInventory claim/receipt pairing", "executeIntegrationAmendment exact replay", "assertIntegrationAmendmentConsistency"],
    tests: [`test/durable-record-mutations.test.js: ${id} production mutation matrix`, "test/integration-amendment.test.js: execution receipt outcomes"],
    source, canonicalPath: ["evidence", id], facts: exactFacts(source), requiredPath: ["status"], typePath: ["duration_ms"],
    targets: [schema(["schema_version"]), kind(["kind"], "other-receipt"), time(["completed_at"]), drift([], "commands", "results"), stale(["head_sha"], SHA_B), cross(["run_id"], "other-run")],
  });
}

function amendmentReviewEntry(id, verdict) {
  const source = structuredClone(AMENDMENT_CATALOG.reviews[id]);
  return recordEntry({
    authorityClassId: "pr79-merged-slice-repair", id, record: "reviews/integration-amendment-<A>.attempt-<N>.json", variant: verdict,
    writer: "completeIntegrationAmendmentReviewTaskDispatch create-only checked review publication",
    readers: ["validateIntegrationAmendmentReview", "inspectIntegrationAmendmentInventory", "transitionIntegrationAmendment review and retry consumers", "assertIntegrationAmendmentConsistency"],
    tests: [`test/durable-record-mutations.test.js: ${id} production mutation matrix`, "test/integration-amendment.test.js: checked review publication"],
    source, canonicalPath: ["reviews", id], facts: exactFacts(source), requiredPath: ["verdict"], typePath: ["attempt"],
    targets: [schema(["schema_version"]), kind(["kind"], "other-review"), time(["reviewed_at"]), drift([], "required_fixes", "fixes"), stale(["build_base_commit"], SHA_C), cross(["amendment_id"], "B".repeat(43))],
  });
}

function amendmentBuilderDispatchEntry(id, variant) {
  const dispatch = AMENDMENT_CATALOG.dispatch;
  const binding = variant === "binding-active" || variant === "binding-closed";
  const closed = variant === "binding-closed";
  const closure = variant === "closure";
  const source = structuredClone(binding ? (closed ? dispatch.closedBinding : dispatch.activeBinding) : closure ? dispatch.closure : dispatch.claim);
  const externalSources = binding
    ? { claim: structuredClone(dispatch.claimExternal), ...(closed ? { closure: structuredClone(dispatch.closureExternal) } : {}) }
    : closure ? { claim: structuredClone(dispatch.claimExternal) } : {};
  const sidecars = binding
    ? [externalSidecar("claim", ["claim_ref"], ["claim_hash"]), ...(closed ? [externalSidecar("closure", ["closure_ref"], ["closure_hash"])] : [])]
    : closure ? [externalSidecar("claim", ["claim_ref"], ["claim_hash"])] : [];
  return recordEntry({
    authorityClassId: "pr79-merged-slice-repair", id,
    record: binding ? "run.json.special_builder_dispatch" : closure ? "dispatch/<sha256>.special.closed.json" : "dispatch/<sha256>.special.json", variant,
    writer: binding ? (closed ? "completeSpecialBuilderTaskDispatch checked closure binding" : "prepareSpecialBuilderTaskDispatch checked active binding") : closure ? "completeSpecialBuilderTaskDispatch create-only closure publication" : "prepareSpecialBuilderTaskDispatch create-only claim publication",
    readers: binding ? ["validateSpecialBuilderDispatch through validateRun", "assertIntegrationAmendmentDispatchBinding", "unresolved special-dispatch writer fence", "transitionIntegrationAmendment review consumer"] : ["prepare/completeSpecialBuilderTaskDispatch", "assertIntegrationAmendmentDispatchBinding", "inspectIntegrationAmendmentInventory", "checked review transition"],
    tests: [`test/durable-record-mutations.test.js: ${id} production mutation matrix`, "test/integration-amendment.test.js: checked special builder dispatch"],
    source, canonicalPath: binding ? ["special_builder_dispatch"] : ["dispatch", id], externalSources, facts: exactFacts(source), sidecars,
    requiredPath: [binding ? "route" : "kind"], typePath: [binding ? "instance" : "schema_version"],
    targets: [schema(["schema_version"]), kind([binding ? "route" : "kind"], "other-dispatch"), ...(binding ? [] : [time([closure ? "returned_at" : "claimed_at"])]), ...(binding || closure ? sidecars.flatMap((sidecar) => externalSidecarTargets(sidecar.name, sidecar.refPath, sidecar.hashPath)) : [ref(["closure_ref"]), hash(["completion_token_hash"])]), drift([], "instance", "dispatch_instance"), stale([binding ? "agent" : "head"], binding ? "frontend-builder" : SHA_C), cross([binding ? "instance" : "run_id"], binding ? `${AMENDMENT_CATALOG.amendmentId}:attempt-2` : "other-run")],
  });
}

function amendmentNamedSidecar(externalSources, name, refPath, hashPath) {
  if (!externalSources[name]) throw new TypeError(`missing amendment catalog sidecar ${name}`);
  return externalSidecar(name, refPath, hashPath);
}

function amendmentRefSidecar(externalSources, name, refPath, hashPath, ref) {
  const sourceName = Object.keys(externalSources).find((key) => externalSources[key].ref === ref);
  if (!sourceName) throw new TypeError(`missing amendment catalog sidecar ${ref}`);
  externalSources[name] = externalSources[sourceName];
  if (sourceName !== name) delete externalSources[sourceName];
  return externalSidecar(name, refPath, hashPath);
}

function amendmentReviewProvenanceEntry(id, variant) {
  const claim = variant === "claim";
  const source = structuredClone(claim ? AMENDMENT_REVIEW_CLAIM : AMENDMENT_REVIEW_CLOSURE);
  const targets = claim
    ? [
        schema(["schema_version"]), kind(["kind"]), time(["claimed_at"]), ref(["review_ref"]), hash(["context_hash"]),
        drift([], "review_ref", "review_path"), stale(["candidate_commit"], SHA_C), cross(["run_id"], "other-run"),
      ]
    : [
        schema(["schema_version"]), kind(["kind"]), time(["returned_at"]), ref(["claim_ref"]), hash(["claim_hash"]),
        bytes(["completion_token"], "completion capability"), drift([], "review_ref", "review_path"),
        stale(["context_hash"], HASH_B), cross(["run_id"], "other-run"),
      ];
  return recordEntry({
    authorityClassId: "pr79-merged-slice-repair",
    id,
    record: claim ? "dispatch/<sha256>.amendment-review.json" : "dispatch/<sha256>.amendment-review.closed.json",
    variant,
    writer: claim ? "prepareIntegrationAmendmentReviewTaskDispatch create-only claim publication" : "completeIntegrationAmendmentReviewTaskDispatch create-only closure publication",
    readers: claim
      ? ["validateIntegrationAmendmentReviewDispatchClaim", "inspectIntegrationAmendmentInventory reviewer-effect classifier", "completeIntegrationAmendmentReviewTaskDispatch", "transitionIntegrationAmendment review consumer"]
      : ["validateIntegrationAmendmentReviewDispatchClosure", "inspectIntegrationAmendmentInventory reviewer-effect classifier", "completeIntegrationAmendmentReviewTaskDispatch replay", "transitionIntegrationAmendment review consumer", "assertIntegrationAmendmentConsistency downstream revalidation"],
    tests: [`test/durable-record-mutations.test.js: ${id} mutation matrix`, "test/durable-record-mutations.test.js: amendment reviewer provenance production mutation matrix", "test/integration-amendment.test.js: reviewer effect lifecycle and replay"],
    source,
    canonicalPath: ["dispatch", claim ? "amendment-review-claim" : "amendment-review-closure"],
    requiredPath: [claim ? "closure_ref" : "review_hash"],
    typePath: ["attempt"],
    facts: exactFacts(source),
    observations: [
      reobservation("reviewer-effect-states", ["absent", "active-claim-only", "review-published-without-closure", "closed-unconsumed", "consumed", "orphan-or-cross-bound"], "inspectIntegrationAmendmentInventory"),
      reobservation("compatibility", "immutable create-only sidecar; no run schema bump and no overwrite/backfill", "completeIntegrationAmendmentReviewTaskDispatch and downstream consistency"),
    ],
    targets,
  });
}

function reobservation(name, expected, consumer) {
  return { name, source: "re-observed", expected, consumer };
}

function recordEntry({ authorityClassId, id, record, variant, writer, readers, tests, source, canonicalPath, externalSources = {}, requiredPath, unknownPath = [], typePath, targets = [], sidecars = [], facts = [], observations }) {
  const commonTargets = [
    target("missing-key", requiredPath, "required field"),
    target("unknown-key", unknownPath, unknownPath.length === 0 ? "record root" : `record ${renderPath(unknownPath)}`, { key: "unexpected_authority_key", value: true }),
    target("wrong-type", typePath, "typed field"),
  ];
  return {
    authorityClassId,
    id,
    record,
    variant,
    writer,
    readers,
    tests: tests ?? [`test/durable-record-mutations.test.js: ${id} mutation matrix`],
    sidecars,
    facts,
    ...(observations === undefined ? {} : { observations }),
    ...(canonicalPath ? { canonicalPath } : {}),
    ...(Object.keys(externalSources).length > 0 ? { externalSources } : {}),
    source,
    descriptor: completeDescriptor(id, [...commonTargets, ...targets], explicitExclusionsFor(id)),
  };
}

function completeDescriptor(record, targets, exclusions = {}) {
  const targeted = new Set(targets.map(({ family }) => family));
  for (const family of DURABLE_MUTATION_FAMILIES) {
    const excluded = Object.hasOwn(exclusions, family);
    if (targeted.has(family) === excluded) throw new TypeError(`${record}.${family} must have exactly one explicitly authored target or exclusion`);
  }
  return { record, targets, exclusions: { ...exclusions } };
}

function explicitExclusionsFor(record) {
  const codes = EXPLICIT_EXCLUDED_FAMILY_CODES[record];
  if (typeof codes !== "string") throw new TypeError(`${record} must have an explicitly authored family disposition`);
  const exclusions = {};
  for (const code of codes) {
    const family = FAMILY_BY_CODE[code];
    if (!family || Object.hasOwn(exclusions, family)) throw new TypeError(`${record} has an invalid explicit family disposition code`);
    exclusions[family] = `${record}: ${family} is explicitly inapplicable because this record variant has no corresponding authoritative field or bound sidecar.`;
  }
  return exclusions;
}

function metadataHash(record) {
  const exactMetadata = {
    writer: record.writer,
    readers: record.readers,
    tests: record.tests,
    facts: record.facts,
    sidecars: record.sidecars,
    ...(record.observations === undefined ? {} : { observations: record.observations }),
  };
  return createHash("sha256").update(JSON.stringify(exactMetadata)).digest("hex");
}

function validateCanonicalCoreRecord(record, path) {
  if (!Array.isArray(record.canonicalPath)) throw new TypeError(`${path}.canonicalPath must identify the exact persisted source location`);
  if (record.canonicalPath.length === 0 && !["run-envelope-running", "run-envelope-terminal"].includes(record.id)) throw new TypeError(`${path}.canonicalPath may be the run.json root only for a run-envelope row`);
  if (!Array.isArray(record.facts) || record.facts.length === 0) throw new TypeError(`${path}.facts must contain path and expected-value declarations`);
  for (const [index, declaration] of record.facts.entries()) {
    requireRecord(declaration, `${path}.facts[${index}]`);
    requirePath(declaration.path, `${path}.facts[${index}].path`);
    if (!Object.hasOwn(declaration, "expected")) throw new TypeError(`${path}.facts[${index}].expected is required`);
    const actual = valueAt(record.source, declaration.path, `${path}.facts[${index}]`);
    if (canonicalJson(actual) !== canonicalJson(declaration.expected)) throw new TypeError(`${path}.facts[${index}] contradicts the canonical source value`);
  }
  const externalSources = record.externalSources ?? {};
  requireRecord(externalSources, `${path}.externalSources`);
  for (const [name, external] of Object.entries(externalSources)) {
    requireRecord(external, `${path}.externalSources.${name}`);
    requireText(external.ref, `${path}.externalSources.${name}.ref`);
    if (external.bytes !== null && typeof external.bytes !== "string") throw new TypeError(`${path}.externalSources.${name}.bytes must be exact string bytes or null`);
  }
  if (record.observations !== undefined) {
    if (!Array.isArray(record.observations) || record.observations.length === 0) throw new TypeError(`${path}.observations must be a non-empty array`);
    for (const [index, observation] of record.observations.entries()) {
      requireRecord(observation, `${path}.observations[${index}]`);
      requireText(observation.name, `${path}.observations[${index}].name`);
      requireText(observation.source, `${path}.observations[${index}].source`);
      requireText(observation.consumer, `${path}.observations[${index}].consumer`);
      if (!Object.hasOwn(observation, "expected")) throw new TypeError(`${path}.observations[${index}].expected is required`);
      if (observation.source !== "re-observed") {
        requirePath(observation.path, `${path}.observations[${index}].path`);
        const external = externalSources[observation.source];
        if (!external || typeof external.bytes !== "string") throw new TypeError(`${path}.observations[${index}] must name bound external source bytes`);
        const actual = valueAt(JSON.parse(external.bytes), observation.path, `${path}.observations[${index}]`);
        if (canonicalJson(actual) !== canonicalJson(observation.expected)) throw new TypeError(`${path}.observations[${index}] contradicts the bound external source`);
      }
    }
  }
  rejectSyntheticCanonicalKeys(record, path);
  const expectedHash = DURABLE_AUTHORITY_CANONICAL_SOURCE_BY_ID.get(record.id);
  if (canonicalSourceHash(record) !== expectedHash) throw new TypeError(`${path} class, id, record, variant, canonical path/source, facts, and external bytes must exactly match the independent canonical source manifest`);
}

function rejectSyntheticCanonicalKeys(record, path) {
  const forbidden = new Set(["sidecar_bytes"]);
  if (record.authorityClassId === "post-pr-nested-records") forbidden.add("run_status");
  if (record.authorityClassId === "slices-review-evidence-bindings") {
    forbidden.add("review_binding");
  }
  if (["validator-verdict-binding", "security-verdict-binding"].includes(record.id)) {
    for (const key of ["subject", "attempt", "report_ref", "reviewed_commit"]) forbidden.add(key);
  }
  if (record.authorityClassId === "gates-snapshot-handoff" && Object.hasOwn(record.source, "gate")) {
    throw new TypeError(`${path}.source.gate is synthetic; gate identity belongs to the gates map key`);
  }
  if (record.authorityClassId === "post-pr-nested-records" && containsKeyBelow(record.source, "push", "action_token")) {
    throw new TypeError(`${path}.source contains synthetic post-PR push action_token`);
  }
  for (const key of forbidden) if (containsOwnKey(record.source, key)) throw new TypeError(`${path}.source contains synthetic key ${key}`);
}

function containsKeyBelow(value, ancestorKey, targetKey, belowAncestor = false) {
  if (Array.isArray(value)) return value.some((item) => containsKeyBelow(item, ancestorKey, targetKey, belowAncestor));
  if (value === null || typeof value !== "object") return false;
  if (belowAncestor && Object.hasOwn(value, targetKey)) return true;
  return Object.entries(value).some(([key, item]) => containsKeyBelow(item, ancestorKey, targetKey, belowAncestor || key === ancestorKey));
}

function containsOwnKey(value, targetKey) {
  if (Array.isArray(value)) return value.some((item) => containsOwnKey(item, targetKey));
  if (value === null || typeof value !== "object") return false;
  if (Object.hasOwn(value, targetKey)) return true;
  return Object.values(value).some((item) => containsOwnKey(item, targetKey));
}

function canonicalSourceHash(record) {
  return createHash("sha256").update(canonicalJson({
    authorityClassId: record.authorityClassId,
    id: record.id,
    record: record.record,
    variant: record.variant,
    canonicalPath: record.canonicalPath,
    source: record.source,
    facts: record.facts,
    externalSources: record.externalSources ?? {},
    ...(record.observations === undefined ? {} : { observations: record.observations }),
  })).digest("hex");
}

function validateExpectedDescriptorDispositions(record, path) {
  const expectedExcludedFamilies = new Set([...EXPLICIT_EXCLUDED_FAMILY_CODES[record.id]].map((code) => FAMILY_BY_CODE[code]));
  for (const family of DURABLE_MUTATION_FAMILIES) {
    const targetCount = record.descriptor.targets.filter((mutationTarget) => mutationTarget.family === family).length;
    const hasExclusion = Object.hasOwn(record.descriptor.exclusions, family);
    const expectedExclusion = expectedExcludedFamilies.has(family);
    if (expectedExclusion ? targetCount !== 0 || !hasExclusion : targetCount === 0 || hasExclusion) {
      throw new TypeError(`${path}.${family} target-or-exclusion disposition must exactly match the independent family disposition registry`);
    }
  }
}

function descriptorHash(descriptor) {
  return createHash("sha256")
    .update(canonicalJson({ targets: descriptor.targets, exclusions: descriptor.exclusions }))
    .digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashCanonical(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function checkpointCatalogPlan(plan) {
  const slice = plan.slices[0];
  const unit = plan.delivery_envelope.delivery_units[0];
  const acceptanceInventory = slice.acceptance.map((text, index) => ({
    id: `acceptance-${String(index + 1).padStart(6, "0")}`,
    source_slice_id: slice.id,
    source_index: index,
    text,
  }));
  const checkpoints = unit.invariant_families.map((family, index) => {
    const obligations = unit.obligations.filter((obligation) => obligation.invariant_family_id === family.id);
    const artifactIds = new Set(obligations.map((obligation) => obligation.verification_artifact_id));
    const artifacts = unit.verification_artifacts.filter((artifact) => artifactIds.has(artifact.id));
    const acceptance = [acceptanceInventory[index].text];
    return {
      id: `checkpoint-${String(index + 1).padStart(3, "0")}`,
      ordinal: index + 1,
      prerequisite_checkpoint_id: index === 0 ? null : `checkpoint-${String(index).padStart(3, "0")}`,
      acceptance_ids: [acceptanceInventory[index].id],
      brief_scope: {
        title: `Deliver ${family.description}`,
        source_delivery_unit_id: unit.id,
        source_slice_id: slice.id,
        source_slice_dependencies: structuredClone(slice.depends_on),
        stack: slice.stack,
        paths: structuredClone(slice.paths),
        acceptance,
        invariant_family: structuredClone(family),
        obligations: structuredClone(obligations),
        verification_artifacts: structuredClone(artifacts),
      },
      child_plan: {
        integration_gate: structuredClone(plan.integration_gate),
        slices: [{ id: slice.id, stack: slice.stack, paths: structuredClone(slice.paths), depends_on: [], acceptance, test_plan: artifacts.map((artifact) => artifact.test_plan_entry) }],
        delivery_envelope: {
          schema_version: 1,
          delivery_units: [{
            id: unit.id,
            slice_id: slice.id,
            invariant_families: [structuredClone(family)],
            obligations: structuredClone(obligations),
            verification_artifacts: artifacts.map((artifact, artifactIndex) => ({ ...structuredClone(artifact), test_plan_index: artifactIndex })),
          }],
        },
      },
    };
  });
  const acceptanceMappings = acceptanceInventory.map((row, index) => {
    const checkpoint = checkpoints[index];
    return {
      acceptance_id: row.id,
      policy: "single-owner",
      checkpoint_ids: [checkpoint.id],
      assignments: [{
        checkpoint_id: checkpoint.id,
        invariant_family_id: checkpoint.brief_scope.invariant_family.id,
        obligation_ids: checkpoint.brief_scope.obligations.map((obligation) => obligation.id),
        verification_artifact_ids: checkpoint.brief_scope.verification_artifacts.map((artifact) => artifact.id),
        test_plan_entries: checkpoint.brief_scope.verification_artifacts.map((artifact) => artifact.test_plan_entry),
      }],
    };
  });
  return { schema_version: 1, kind: "delivery-checkpoint-plan", acceptance_inventory: acceptanceInventory, acceptance_mappings: acceptanceMappings, checkpoints };
}

function checkpointAcceptanceProjection(checkpointPlan, checkpoint) {
  const inventory = new Map(checkpointPlan.acceptance_inventory.map((row) => [row.id, row]));
  const mappings = new Map(checkpointPlan.acceptance_mappings.map((row) => [row.acceptance_id, row]));
  return {
    acceptance_ids: structuredClone(checkpoint.acceptance_ids),
    acceptance_inventory: checkpoint.acceptance_ids.map((id) => structuredClone(inventory.get(id))),
    acceptance_mappings: checkpoint.acceptance_ids.map((id) => structuredClone(mappings.get(id))),
  };
}

function checkpointCatalogReview() {
  const planHash = hashBytes(`${JSON.stringify(CHECKPOINT_PLAN)}\n`);
  const identityFields = {
    schema_version: 1,
    subject: "work-decomposer",
    attempt: 1,
    plan_ref: "plan/slices.json",
    plan_hash: planHash,
    review_ref: "reviews/work-decomposer.json",
  };
  const reviewIdentity = { ...identityFields, identity_hash: checkpointCanonicalHash(identityFields) };
  const checkpointPlan = CHECKPOINT_PLAN.delivery_envelope.checkpoint_plan;
  const summaries = checkpointPlan.checkpoints.map((checkpoint) => ({
    checkpoint_id: checkpoint.id,
    ordinal: checkpoint.ordinal,
    brief_scope_hash: checkpointCanonicalHash(checkpoint.brief_scope),
    child_plan_hash: checkpointCanonicalHash(checkpoint.child_plan),
    acceptance_mapping_hash: checkpointCanonicalHash(checkpointAcceptanceProjection(checkpointPlan, checkpoint)),
  }));
  const admissionProbe = {
    schema_version: 1,
    kind: "delivery-plan-admission-probe",
    status: "valid",
    decision: "checkpoint",
    plan_ref: "plan/slices.json",
    plan_hash: planHash,
    reasons: structuredClone(CHECKPOINT_ADMISSION.reasons),
    checkpoint_plan_hash: checkpointCanonicalHash(checkpointPlan),
    checkpoints: structuredClone(summaries),
  };
  return {
    schema_version: 1,
    subject: "work-decomposer",
    attempt: 1,
    verdict: "APPROVE-CHECKPOINT",
    required_fixes: [],
    admission_probe: admissionProbe,
    review_identity: reviewIdentity,
    checkpoint_dispositions: summaries.map((summary) => ({
      schema_version: 1,
      kind: "checkpoint-child-decomposition-review",
      subject: "work-decomposer",
      attempt: 1,
      verdict: "APPROVE",
      required_fixes: [],
      checkpoint_id: summary.checkpoint_id,
      checkpoint_ordinal: summary.ordinal,
      reviewed_plan_ref: "plan/slices.json",
      reviewed_plan_hash: summary.child_plan_hash,
      child_plan_hash: summary.child_plan_hash,
      brief_scope_hash: summary.brief_scope_hash,
      acceptance_mapping_hash: summary.acceptance_mapping_hash,
      parent_review_identity: structuredClone(reviewIdentity),
    })),
  };
}

function checkpointCatalogManifest() {
  const checkpointPlan = CHECKPOINT_PLAN.delivery_envelope.checkpoint_plan;
  const checkpoints = checkpointPlan.checkpoints.map((checkpoint, index) => ({
    id: checkpoint.id,
    ordinal: checkpoint.ordinal,
    prerequisite_checkpoint_id: checkpoint.prerequisite_checkpoint_id,
    acceptance_projection: checkpointAcceptanceProjection(checkpointPlan, checkpoint),
    acceptance_mapping_hash: checkpointCanonicalHash(checkpointAcceptanceProjection(checkpointPlan, checkpoint)),
    brief_scope: structuredClone(checkpoint.brief_scope),
    brief_scope_hash: checkpointCanonicalHash(checkpoint.brief_scope),
    child_plan: structuredClone(checkpoint.child_plan),
    child_plan_hash: checkpointCanonicalHash(checkpoint.child_plan),
    child_disposition: structuredClone(CHECKPOINT_REVIEW.checkpoint_dispositions[index]),
    request: {
      run_kind: "normal-feature-run",
      execution_boundary: { base_branch: "main", scope: "this-checkpoint-whole-story" },
      integration_test_verifier: { required: true, scope: "this-checkpoint-whole-story", required_commands: structuredClone(checkpoint.child_plan.integration_gate.required_commands) },
      whole_story_panels: [
        { agent: "implementation-validator", required: true, scope: "this-checkpoint-whole-story" },
        { agent: "security-reviewer", required: true, scope: "this-checkpoint-whole-story" },
      ],
      gate_3: { name: "pre_pr", required: true, scope: "this-checkpoint-whole-story" },
      pull_request: { required: true, count: 1, scope: "this-checkpoint-whole-story" },
    },
  }));
  return {
    schema_version: 1,
    kind: "delivery-checkpoint-routing-manifest",
    source: {
      plan_ref: CHECKPOINT_EXTERNAL.plan.ref,
      plan_hash: hashBytes(CHECKPOINT_EXTERNAL.plan.bytes),
      checkpoint_plan_hash: checkpointCanonicalHash(checkpointPlan),
      decomposition_review_ref: CHECKPOINT_EXTERNAL.review.ref,
      decomposition_review_hash: hashBytes(CHECKPOINT_EXTERNAL.review.bytes),
      decomposition_attempt: 1,
      review_identity: structuredClone(CHECKPOINT_REVIEW.review_identity),
      admission_probe: structuredClone(CHECKPOINT_REVIEW.admission_probe),
      admission_result: structuredClone(CHECKPOINT_ADMISSION),
    },
    sequencing: { mode: "strictly-sequential", base_branch: "main", next_checkpoint_rule: "Checkpoint N+1 may start only from main containing merged PR N." },
    checkpoints,
  };
}

function checkpointCanonicalHash(value) {
  return hashBytes(`${JSON.stringify(canonicalCheckpointValue(value), null, 2)}\n`);
}

function canonicalCheckpointValue(value) {
  if (Array.isArray(value)) return value.map(canonicalCheckpointValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalCheckpointValue(value[key])]));
}

function fact(path, expected) {
  return { path, expected };
}

function validateRecordSidecars(record, path) {
  if (!Array.isArray(record.sidecars)) throw new TypeError(`${path}.sidecars must be an array`);
  for (const binding of record.sidecars) {
    requireText(binding.name, `${path}.sidecars.name`);
    requireTextArray(binding.requiredFamilies, `${path}.sidecars.${binding.name}.requiredFamilies`);
    for (const family of binding.requiredFamilies) {
      if (!record.descriptor.targets.some((mutationTarget) => mutationTarget.family === family && mutationTarget.sidecar === binding.name)) {
        throw new TypeError(`${path} sidecar ${binding.name} must target ${family} independently`);
      }
    }
  }
}

function sidecar(name, refPath, hashPath, bytesPath) {
  return {
    name,
    refPath,
    hashPath,
    bytesPath,
    requiredFamilies: [refPath === null ? null : "wrong-ref", hashPath === null ? null : "wrong-hash", "wrong-bytes"].filter(Boolean),
  };
}

function sidecarTargets(name, refPath, hashPath, bytesPath) {
  return [
    ...(refPath === null ? [] : [ref(refPath, name)]),
    ...(hashPath === null ? [] : [hash(hashPath, name)]),
    bytes(bytesPath, name),
  ];
}

function externalSidecar(name, refPath, hashPath) {
  return sidecar(name, refPath, hashPath, ["$external", name, "bytes"]);
}

function externalSidecarTargets(name, refPath, hashPath) {
  return sidecarTargets(name, refPath, hashPath, ["$external", name, "bytes"]);
}

function target(family, path, label, options = {}) {
  return { family, path, ...(label === undefined ? {} : { label }), ...options };
}

function schema(path) { return target("wrong-schema", path, "schema version", { value: 2 }); }
function kind(path, value = "unknown-kind", label = "kind") { return target("wrong-kind", path, label, { value }); }
function time(path, value = "not-an-iso-time") { return target("wrong-time", path, `timestamp ${renderPath(path)}`, { value }); }
function ref(path, sidecarName, label = `ref ${renderPath(path)}`) { return target("wrong-ref", path, sidecarName ? `${sidecarName} ref` : label, { value: "../outside.json", ...(sidecarName ? { sidecar: sidecarName } : {}) }); }
function hash(path, sidecarName) { return target("wrong-hash", path, sidecarName ? `${sidecarName} hash` : `hash ${renderPath(path)}`, { value: WRONG_HASH_A, ...(sidecarName ? { sidecar: sidecarName } : {}) }); }
function bytes(path, sidecarName) { return target("wrong-bytes", path, `${sidecarName} sidecar bytes`, { value: "tampered-sidecar-bytes", sidecar: sidecarName }); }
function drift(path, from, to) { return target("descriptor-key-shape-drift", path, `${from} renamed`, { from, to }); }
function stale(path, value) { return target("stale-identity", path, `stale ${renderPath(path)}`, { value }); }
function cross(path, value, label = `cross-bound ${renderPath(path)}`) { return target("cross-bound-identity", path, label, { value }); }

function applyMutation(record, family, mutationTarget) {
  if (family === "unknown-key") {
    const container = valueAt(record, mutationTarget.path, family);
    requireRecord(container, `${family} target`);
    const key = requireText(mutationTarget.key, `${family}.key`);
    if (Object.hasOwn(container, key)) throw new TypeError(`${family}.key must be absent from the source`);
    container[key] = cloneTargetValue(mutationTarget, true);
    return;
  }

  if (family === "descriptor-key-shape-drift") {
    const container = valueAt(record, mutationTarget.path, family);
    requireRecord(container, `${family} target`);
    const from = requireText(mutationTarget.from, `${family}.from`);
    const to = requireText(mutationTarget.to, `${family}.to`);
    if (!Object.hasOwn(container, from) || Object.hasOwn(container, to)) throw new TypeError(`${family} requires an existing from key and absent to key`);
    container[to] = container[from];
    delete container[from];
    return;
  }

  const { container, key } = parentAt(record, mutationTarget.path, family);
  if (family === "missing-key") {
    delete container[key];
    return;
  }

  const current = container[key];
  const replacement = Object.hasOwn(mutationTarget, "value")
    ? structuredClone(mutationTarget.value)
    : defaultReplacement(family, current);
  if (Object.is(current, replacement)) throw new TypeError(`${family} replacement must differ from the source value`);
  container[key] = replacement;
}

function cloneTargetValue(mutationTarget, fallback) {
  return structuredClone(Object.hasOwn(mutationTarget, "value") ? mutationTarget.value : fallback);
}

function defaultReplacement(family, current) {
  if (family === "wrong-schema") return current === 1 ? 2 : 1;
  if (family === "wrong-kind") return "unknown-kind";
  if (family === "wrong-time") return "not-an-iso-time";
  if (family === "wrong-ref") return "../outside.json";
  if (family === "wrong-hash") return current === WRONG_HASH_A ? WRONG_HASH_B : WRONG_HASH_A;
  if (family === "wrong-bytes") return typeof current === "string" ? `${current}-tampered` : "tampered-bytes";
  if (family === "stale-identity") return typeof current === "number" ? current - 1 : `stale-${String(current)}`;
  if (family === "cross-bound-identity") return typeof current === "number" ? current + 1 : "other-boundary";
  if (family === "wrong-type") {
    if (Array.isArray(current)) return {};
    if (current !== null && typeof current === "object") return [];
    if (typeof current === "string") return 1;
    if (typeof current === "number") return "not-a-number";
    if (typeof current === "boolean") return "not-a-boolean";
    if (current === null) return {};
    return null;
  }
  throw new TypeError(`no mutation implementation for ${family}`);
}

function parentAt(root, path, label) {
  if (path.length === 0) throw new TypeError(`${label} requires a non-root value path`);
  const container = valueAt(root, path.slice(0, -1), label);
  const key = path.at(-1);
  if ((container === null || typeof container !== "object") || !Object.hasOwn(container, key)) {
    throw new TypeError(`${label} path ${renderPath(path)} does not resolve to an own property`);
  }
  return { container, key };
}

function valueAt(root, path, label) {
  let value = root;
  for (const key of path) {
    if ((value === null || typeof value !== "object") || !Object.hasOwn(value, key)) {
      throw new TypeError(`${label} path ${renderPath(path)} does not resolve`);
    }
    value = value[key];
  }
  return value;
}

function requirePath(path, label) {
  if (!Array.isArray(path)) throw new TypeError(`${label} must be an array`);
  for (const segment of path) {
    if (!(typeof segment === "string" && segment.length > 0) && !(Number.isInteger(segment) && segment >= 0)) {
      throw new TypeError(`${label} contains an invalid segment`);
    }
  }
}

function requireTextArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  for (const [index, item] of value.entries()) requireText(item, `${label}[${index}]`);
}

function renderPath(path) {
  return path.length === 0 ? "<root>" : path.map(String).join(".");
}

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a record`);
  return value;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function sameList(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
