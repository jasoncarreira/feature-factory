import { createHash } from "node:crypto";

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
  "run-envelope-running",
  "run-envelope-terminal",
  "terminal-result-completed",
  "terminal-result-blocked",
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
  "continuation-envelope",
  "continuation-parent-binding",
  "continuation-selected-review",
  "continuation-target-binding",
  "continuation-parent-artifact-sidecar",
  "continuation-parent-evidence-sidecar",
  "continuation-parent-review-sidecar",
  "continuation-planning-reuse-ineligible",
  "continuation-planning-reuse-eligible",
  "continuation-draft-reuse",
  "continuation-post-pr-binding",
  "slice-pending",
  "slice-running",
  "slice-review",
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
  "repair-reported",
  "repair-repairing",
  "repair-review-approve",
  "repair-review-reject",
  "repair-merged",
  "repair-blocked-from-reported",
  "repair-blocked-from-repairing",
  "repair-blocked-from-review",
]);

const AUTHORITY_CLASSES = Object.freeze([
  ["plan-slices-graph", "Plan and slices graph"],
  ["run-envelope-terminal-result", "Run envelope and terminal result"],
  ["gates-snapshot-handoff", "Gates, pending snapshot, and handoff receipt"],
  ["steps-acceptance-inheritance", "Steps and acceptance inheritance"],
  ["slices-review-evidence-bindings", "Slices and review/evidence bindings"],
  ["validator-security-pr-result", "Validator, security, and PR-created result"],
  ["continuation-planning-draft-reuse", "Continuation and planning/draft reuse"],
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
  plan: { ref: "plan/slices.json", bytes: "{\"slices\":[{\"id\":\"B0.2\",\"stack\":\"backend\",\"paths\":[\"src/**\"],\"depends_on\":[],\"acceptance\":[\"AC2\"],\"test_plan\":[\"node --test\"]},{\"id\":\"B0.3\",\"stack\":\"backend\",\"paths\":[\"test/**\"],\"depends_on\":[\"B0.2\"],\"acceptance\":[\"AC3\"],\"test_plan\":[\"node --test\"]}]}\n" },
});
const PLAN_V2_EXTERNAL = Object.freeze({
  plan: { ref: "plan/slices.json", bytes: "{\"slices\":[{\"id\":\"B1C\",\"stack\":\"backend\",\"paths\":[\"src/**\"],\"depends_on\":[],\"acceptance\":[\"AC1\"],\"test_plan\":[\"node --test test/acceptance.test.js\"]}],\"integration_gate\":{\"required_commands\":[{\"program\":\"node\",\"args\":[\"--test\",\"test/acceptance.test.js\"]},{\"program\":\"npm\",\"args\":[\"run\",\"check\"]}]}}\n" },
});
const DECOMPOSITION_EXTERNAL = Object.freeze({
  plan: PLAN_V2_EXTERNAL.plan,
  review: { ref: "reviews/work-decomposer.json", bytes: "{\"subject\":\"work-decomposer\",\"attempt\":1,\"verdict\":\"APPROVE\",\"required_fixes\":[]}\n" },
});
const TEST_EXECUTION_NONCE = "123e4567-e89b-42d3-a456-426614174000";
const EMPTY_STREAM = Object.freeze({ captured_bytes: 0, sha256: `sha256:${createHash("sha256").digest("hex")}`, truncated: false });
const TRUNCATED_STREAM = Object.freeze({ captured_bytes: 1048576, sha256: `sha256:${"9".repeat(64)}`, truncated: true });
const CONTINUATION_EXTERNAL = Object.freeze({
  parentRun: { ref: ".opencode/factory/parent-run/run.json", bytes: "{\"schema_version\":1,\"run_id\":\"parent-run\",\"status\":\"blocked\",\"gates\":{},\"terminal_result\":{\"status\":\"blocked\",\"run_id\":\"parent-run\",\"reason\":\"review blocked\"}}\n" },
  selectedReview: { ref: "reviews/remediation-review.json", bytes: "{\"kind\":\"validator\",\"subject\":\"parent\",\"verdict\":\"APPROVE\",\"required_fixes\":[\"fix\"]}\n" },
  artifact: { ref: "artifacts/story.md", bytes: "Approved parent story.\n" },
  evidence: { ref: "evidence/test-verifier.json", bytes: "{\"subject\":\"test-verifier\",\"status\":\"pass\"}\n" },
  review: { ref: "reviews/implementation-validator.json", bytes: "{\"subject\":\"implementation\",\"verdict\":\"GO\"}\n" },
  acceptedReview: { ref: "reviews/spec-writer.json", bytes: "{\"subject\":\"spec-writer\",\"verdict\":\"APPROVE\"}\n" },
  acceptedArtifact: { ref: "artifacts/technical-brief.md", bytes: "Accepted technical brief.\n" },
  draft: { ref: "artifacts/technical-brief.md", bytes: "Unaccepted technical brief draft.\n" },
  postPrEvidence: { ref: "evidence/post-pr.json", bytes: "{\"kind\":\"post-pr-ci\",\"verdict\":\"red\"}\n" },
  postPrReview: { ref: "reviews/post-pr.json", bytes: "{\"kind\":\"post-pr-continuation\",\"verdict\":\"BLOCKED\"}\n" },
});
const SLICE_EXTERNAL = Object.freeze({
  evidence: { ref: "evidence/backend.json", bytes: `{"subject":"backend","attempt":1,"status":"pass","review_ready":true,"head_sha":"${SHA_B}"}\n` },
  review: { ref: "reviews/backend.json", bytes: `{"subject":"backend","attempt":1,"verdict":"APPROVE","convergence":"converging","remaining_fix_count":0,"required_fixes":[],"remediation_context":{"schema_version":2,"fixes":[]},"reviewed_commit":"${SHA_B}"}\n` },
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
  review: { ref: "reviews/backend.json", bytes: `{"subject":"backend","attempt":1,"verdict":"REJECT","convergence":"nonconvergent","remaining_fix_count":1,"required_fixes":["replace missed category"],"remediation_context":{"schema_version":2,"fixes":[{"required_fix_index":0,"classification":"nonconvergent","scope_effect":"in-lane","likely_paths":["src/backend.js"],"fix_owner":"backend"}]},"reviewed_commit":"${SHA_B}"}\n` },
  ...SLICE_DISPATCH_EXTERNAL,
});
const SLICE_BLOCKED_EXTERNAL = Object.freeze({
  evidence: SLICE_EXTERNAL.evidence,
  review: { ref: "reviews/backend.json", bytes: `{"subject":"backend","attempt":1,"verdict":"REJECT","convergence":"converging","remaining_fix_count":1,"required_fixes":["apply narrow correction"],"remediation_context":{"schema_version":2,"fixes":[{"required_fix_index":0,"classification":"narrow-correction","scope_effect":"in-lane","likely_paths":["src/backend.js"],"fix_owner":"backend"}]},"reviewed_commit":"${SHA_B}"}\n` },
  ...SLICE_DISPATCH_EXTERNAL,
});
const PANEL_EXTERNAL = Object.freeze({
  report: { ref: "artifacts/validation-report.md", bytes: "GO\n" },
  validator: { ref: "reviews/implementation-validator.json", bytes: `{"subject":"feature--catalog","attempt":1,"verdict":"GO","reviewed_head_sha":"${SHA_B}"}\n` },
  security: { ref: "reviews/security-reviewer.json", bytes: `{"subject":"feature--catalog","attempt":1,"verdict":"PASS","reviewed_head_sha":"${SHA_B}"}\n` },
});
const REPAIR_PLAN_BYTES = `${JSON.stringify({
  slices: [
    { id: "owner", stack: "backend", paths: ["src/owner/**"], depends_on: [], acceptance: ["AC1"], test_plan: ["unit"] },
    { id: "consumer", stack: "backend", paths: ["src/consumer/**"], depends_on: ["owner"], acceptance: ["AC2"], test_plan: ["unit"] },
  ],
}, null, 2)}\n`;
const REPAIR_EXTERNAL = Object.freeze({
  plan: { ref: "plan/slices.json", bytes: REPAIR_PLAN_BYTES },
  originalEvidence: { ref: "evidence/consumer-failure.json", bytes: `{"subject":"consumer","status":"fail","command":"node --test test/consumer.test.js","head":"${SHA_A}"}\n` },
  repairEvidence: { ref: "evidence/repair-attempt-1.json", bytes: "{\"subject\":\"repair:owner\",\"changed_paths\":[\"src/owner/records.js\"]}\n" },
  reviewApprove: { ref: "reviews/repair-attempt-1-approve.json", bytes: `{"subject":"repair:owner","verdict":"APPROVE","required_fixes":[],"attempt":1,"commit":"${SHA_B}"}\n` },
  reviewReject: { ref: "reviews/repair-attempt-1-reject.json", bytes: `{"subject":"repair:owner","verdict":"REJECT","required_fixes":["correct owner record"],"attempt":1,"commit":"${SHA_B}"}\n` },
  verification: { ref: "evidence/repair-verification.json", bytes: `{"subject":"consumer","status":"pass","command":"node --test test/consumer.test.js","head":"${SHA_C}"}\n` },
});

export const DURABLE_AUTHORITY_REQUIRED_RECORD_IDS = deepFreeze({
  "plan-slices-graph": [
    "plan-slices-json",
    "plan-v2-integration-gate",
    "final-plan-descriptor",
  ],
  "run-envelope-terminal-result": [
    "run-envelope-running",
    "run-envelope-terminal",
    "terminal-result-completed",
    "terminal-result-blocked",
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
  "continuation-planning-draft-reuse": [
    "continuation-envelope",
    "continuation-parent-binding",
    "continuation-selected-review",
    "continuation-target-binding",
    "continuation-parent-artifact-sidecar",
    "continuation-parent-evidence-sidecar",
    "continuation-parent-review-sidecar",
    "continuation-planning-reuse-ineligible",
    "continuation-planning-reuse-eligible",
    "continuation-draft-reuse",
    "continuation-post-pr-binding",
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
    "repair-reported",
    "repair-repairing",
    "repair-review-approve",
    "repair-review-reject",
    "repair-merged",
    "repair-blocked-from-reported",
    "repair-blocked-from-repairing",
    "repair-blocked-from-review",
  ],
});

const FAMILY_BY_CODE = Object.freeze({ m: "missing-key", u: "unknown-key", s: "wrong-schema", k: "wrong-kind", t: "wrong-time", y: "wrong-type", r: "wrong-ref", h: "wrong-hash", b: "wrong-bytes", d: "descriptor-key-shape-drift", i: "stale-identity", c: "cross-bound-identity" });

// This closed source-boundary registry is deliberately independent from RECORDS. Each value
// explicitly classifies the families excluded by that entry; every other family must be targeted.
const EXPLICIT_EXCLUDED_FAMILY_CODES = deepFreeze({
  "plan-slices-json": "sktrhb",
  "plan-v2-integration-gate": "sktrhb",
  "final-plan-descriptor": "",
  "run-envelope-running": "khbd",
  "run-envelope-terminal": "krhbd",
  "terminal-result-completed": "skthbd",
  "terminal-result-blocked": "sktrhbd",
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
  "continuation-envelope": "rhbd",
  "continuation-parent-binding": "sktd",
  "continuation-selected-review": "std",
  "continuation-target-binding": "skthbd",
  "continuation-parent-artifact-sidecar": "std",
  "continuation-parent-evidence-sidecar": "std",
  "continuation-parent-review-sidecar": "std",
  "continuation-planning-reuse-ineligible": "sktrhbd",
  "continuation-planning-reuse-eligible": "sktd",
  "continuation-draft-reuse": "sktd",
  "continuation-post-pr-binding": "sktd",
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
  "repair-reported": "k",
  "repair-repairing": "k",
  "repair-review-approve": "k",
  "repair-review-reject": "k",
  "repair-merged": "k",
  "repair-blocked-from-reported": "k",
  "repair-blocked-from-repairing": "k",
  "repair-blocked-from-review": "k",
});

// Hashes are independent, immutable exact-value snapshots over writer, all readers, named tests,
// authority facts, and complete sidecar descriptors, in that order. They are not derived from RECORDS.
export const DURABLE_AUTHORITY_METADATA_MANIFEST = deepFreeze([
  ["plan-slices-json", "989039b0b23d8bef1c9c50b80f4f80da94bb3c982834804154e688ae72e2790a"],
  ["plan-v2-integration-gate", "4e3972913ea1304af33b23a9beb234878e1aa4be6e1a7929440098dab8829538"],
  ["final-plan-descriptor", "28d0d6753da27ed172de3e89d5257c2bac238ed4f93f9a124411e6c1f80d7943"],
  ["run-envelope-running", "707c057f31eeb1213ea82cf16229bb1de2097c2961956eee0a6d0c32bccc6b3d"],
  ["run-envelope-terminal", "d0199700f70c4f08427631780dae93cf197fd46ab3e0ed78d001020b7c7ee1f4"],
  ["terminal-result-completed", "624dd6c0050e64037c95aca7904c9841656bd09684c3d8548b05e15601ba094c"],
  ["terminal-result-blocked", "681845bd946f1cb11d6f2d0a528946365756a79f2ce284179856360e3d9b631e"],
  ["terminal-result-blocked-nonconvergence", "e6a9286a1c4fcdd541621649bfd49378d36ed51d45c84400098e1511c5767687"],
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
  ["step-work-decomposer-accepted-plan", "46f6d0bf7382613418da268823e0ef0a13649ab5ff7b33eee306f4b0c6ecab8a"],
  ["step-inherited-acceptance", "c995fe9943a2898b6f9405e2a427f3de3b61d198f6d7b9d2edf46f177ff4f0f9"],
  ["test-execution-claim-active", "c46fb9721a54c68a7f7106e28d167c2d2d5f4742ab3a86dd2a2d0c295d855148"],
  ["test-execution-claim-completed-pass", "77d5df2e1a78d7919cdc550c2e7548089937432667622d8000d7e35a8acc3628"],
  ["test-execution-claim-completed-fail", "901ce70597b4b00a16bb33ca8a4f7e9b3a470b137f3f285c317dfdb4ecb38d10"],
  ["test-execution-claim-unknown-process-outcome-indeterminate", "b03decd53b81a41e4a1e37551c75ea5f795190ebe6160625672256bc430f37c1"],
  ["test-execution-claim-unknown-authority-changed", "e00811f4e2fa8c9d8f070948b50d8f40281e52b1e6fca7fe2c99ca92c319e606"],
  ["test-execution-claim-unknown-receipt-publication-indeterminate", "68ec6266a0135bcf5fb6e72e0546c31df5e08f729cdc44864c90506f931f5c02"],
  ["test-execution-receipt-pass", "bc3ff7d82ff7af8c1943ab4005f70b3d58e1e7d249f1d6d819d94862da0de9d5"],
  ["test-execution-receipt-failed-nonzero-exit", "cec982375db591d524859a0b68a0b621b583511cd447c61139e8a5343c4f13a4"],
  ["test-execution-receipt-failed-signal", "098ab671186126021d108bd738029c75748e5daa6e74838f7ddf4df79498d0cc"],
  ["test-execution-receipt-failed-launch-error", "11fe1658bc1b0c4c29758109d41f7289ea50ab137ade91fba13a04e7c4760418"],
  ["test-execution-receipt-failed-timeout", "aba412c7a4df3bcc573775c40a8bed3da7c94cf794f656e935da0d197d35d409"],
  ["test-execution-receipt-failed-output-limit", "d0f033038f69b998693a6511b192ee39530c36d94a6854646d13f0180e3a664d"],
  ["slice-pending", "27d978f06a5d77e19f3293902f5ef98a674bd920b35b39a0a56519f48b40b586"],
  ["slice-running", "4643d7feda2aec0a65367792c879fd11ac8ff385317356990e866967595b5aee"],
  ["slice-review", "9d4974e8bf94101a2b8a5befced5b9ba57c8a6e0a7026be2986d303e66ef0210"],
  ["slice-merged", "dcbc32b1065038e3d0dfae63efc9958f449bfb3058b45956e9c812ddc6925fe7"],
  ["slice-blocked-ordinary", "c4c20b33229cbee9c092ed6222b769ff57562cebc79bff0868b5eff8fafa71a0"],
  ["slice-blocked", "92c67de66396ab30c7e8a71bdb3a3a278fcef954a7b37182ffd7c19525bd1335"],
  ["validator-verdict-binding", "ce1205fb84feece303f45e9841916d68fe26431d3117636aecc4b0cdccc79e14"],
  ["security-verdict-binding", "81cbb46158b44646aabf50e0152b80d5ed6dc423826337bf45fe6be7c24e5995"],
  ["steering-boundary", "efff0777e2943f002136ce1a38aad484c5d7ab7143e07eb5b93e2475c497ca55"],
  ["steering-action-claim", "9a94c1f05fec7cad1d2930995c464530088b99175c8430f336fe4f00a76d7384"],
  ["steering-last-action", "986caa05859db8fa98077f1d3e0b08340be3922854cb5cd33a95415fd5b250b4"],
  ["steering-pr-fence", "372be755ffb890bc4fdc9ae5913adad802c809e3d35c0e8c4746917c82e59b8a"],
  ["pr-created-result", "3b863980fbc4b34d584f7ef02b57e5a16ca37858f2c8dc347addcdb02c8446a3"],
  ["continuation-envelope", "81191ae4a3a84c496f99bad916dc229a68a107eff211ac9d4739783531208fcb"],
  ["continuation-parent-binding", "be6e6abe6f58d7194d61d9527c40ce6424cf748cd0c38f2e446ac56066bb1380"],
  ["continuation-selected-review", "9e9a6c756313a6ab1f7e363bcef864def294b4247df06c6135514f6138ae52f8"],
  ["continuation-target-binding", "a68b7b138b6877761e903a7bef61fcb150b95d651a1937ea8c20dfc511a3c01a"],
  ["continuation-parent-artifact-sidecar", "293b04332c448519c7ef645dbc219898296120b849fb9b038fab18fd0aabbb9c"],
  ["continuation-parent-evidence-sidecar", "823bdb94a43dd3f5b64ac8f9027b1a74a64b12ff474d8927a6bb39bf7e9f5c21"],
  ["continuation-parent-review-sidecar", "bb9f6cd0a5d12b9e7a1678b177655f80d89f3dd22f776dcf5215eb31579c4f45"],
  ["continuation-planning-reuse-ineligible", "2652266c8d5c51fe8c0b7e1189d28a37b5780f270eedc5754ab715f092dcdf7f"],
  ["continuation-planning-reuse-eligible", "e8f1a81bc20a815a8733f56c03825196d96c4d4e546f4462f1e929595f17a7d9"],
  ["continuation-draft-reuse", "b45f3caea3722f916cf9a12bcb6c5d001178dad255905d7c0e0d78cc8c13834e"],
  ["continuation-post-pr-binding", "6d2fb331a7bb49440c8b1a9acbd0ed0f4b6f0e1019f0bd1128da41b6738ff26a"],
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
  ["repair-reported", "75d46924435748c84f87621dd9fe75a9a5e935d601ae13e58f573b3783610788"],
  ["repair-repairing", "6bf5572c19410569567cf77691ca05e783159f48ac526b05893945fef5ec168b"],
  ["repair-review-approve", "ce8747ee55810ba484c922025e130b26d8c7dbde2e9970d70f40b81611b07084"],
  ["repair-review-reject", "0365bc5638a629fa31a03fd1570bc3a034c93ef938ff439cb714fa1be0029103"],
  ["repair-merged", "c41a78a4add7261f75669a5cfba1f5dabf2839f9ab0f967ed7891fb89d64c561"],
  ["repair-blocked-from-reported", "b1e49fae077e3e1bee835e9a5d4ff54e7bd9043709bb21f664743154b31fc64f"],
  ["repair-blocked-from-repairing", "d48498b89f41b36ea13d860498363524d6a699c6594926e58515d46acd710a87"],
  ["repair-blocked-from-review", "f6e0a9dc4a891ca6b77cc2ec6d76a4feaa0bae72739a01d84ff608e70ee56c93"],
]);
const DURABLE_AUTHORITY_METADATA_BY_ID = new Map(DURABLE_AUTHORITY_METADATA_MANIFEST);

// Independently authored exact-value snapshots over each descriptor's complete targets and
// exclusions. The hash input is canonical JSON for { targets, exclusions }; it binds target
// order and every family, path, value, from, to, key, sidecar, and label without reading RECORDS.
export const DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST = deepFreeze([
  ["plan-slices-json", "3c923442fe75f188546037455e61dca6f3172bb766399c4df4289de2f1c6f726"],
  ["plan-v2-integration-gate", "135d4108dcdb1889bfff58b1da09163093be21b85c52d1a43f9a92c59fa17ec7"],
  ["final-plan-descriptor", "b8ef8dbfe1f1e54cae98fb0960aa315fe4479e33533b63d0a9e0b88f0df959da"],
  ["run-envelope-running", "0dfdf9c52ba1ee909070da85617630bbb0cac990f109bdc3c7f25c4f686276dd"],
  ["run-envelope-terminal", "7e1272e9374eb193833d700f54b15b5453e92a8475a8f942c72f6f64ca5645cd"],
  ["terminal-result-completed", "8156685012bdcf0072fc38331dd34c2ee2f0ac59c94d14418a0cadc3f92b84be"],
  ["terminal-result-blocked", "9e2aac2293e6a2aa0ff69725ec484565d1ba598e4f921be01c44267eaab6d231"],
  ["terminal-result-blocked-nonconvergence", "484c993240b44861d7d71c96e40fcf4008241b506d9b8f08105352beec069b1b"],
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
  ["test-execution-claim-active", "b6d6567744c4bd97eeb465ad8e952666fa30fa9d6286b254e5a939d753aa092c"],
  ["test-execution-claim-completed-pass", "9fc16b9dd1aab571972cdda772597bac746c0616afed92f3ea07a94ccd07d8ac"],
  ["test-execution-claim-completed-fail", "4734b1677957cd938100fbd864e3a10c5e6749006cf9b820d1bd7ccb054f9096"],
  ["test-execution-claim-unknown-process-outcome-indeterminate", "f258ceb956f246c510c1c2f980f9d7aedf48584db4054c4aafb3eee6137eb0cf"],
  ["test-execution-claim-unknown-authority-changed", "5207c2d7203c285bc73c6835bb83561c5668a1b7e8e3f64165118d51fb511f73"],
  ["test-execution-claim-unknown-receipt-publication-indeterminate", "38757e7ff6ec3c1db8ee22cb20e6f5433aefd2f212dabd3895dcd9dd7fe5fe66"],
  ["test-execution-receipt-pass", "a8d12876a6459f798537d3afd2b5cf5561637fc7bba5271b4a61412fba233472"],
  ["test-execution-receipt-failed-nonzero-exit", "7f2f98e92e13ffa75a3286e3094c344e58e498b97b8cfb69cdb976e2f97cc378"],
  ["test-execution-receipt-failed-signal", "3ceff488cc59be6210291029b62a23ab62efb02ce934fe4526c6b38967e93f6b"],
  ["test-execution-receipt-failed-launch-error", "535eda5b023fcbe5a0add7ce7e158f9ee6b71bc4aab4d118427a76360b31aecb"],
  ["test-execution-receipt-failed-timeout", "145e09cc8ddf2cc6ad438bfd10eb060732ea5d2818e32f1f2d85bf747b80e755"],
  ["test-execution-receipt-failed-output-limit", "5d67fdbbcb0e50d8597c747e30d41c3217b13c5f18f511e43d0914b05cfc2895"],
  ["slice-pending", "63b63efe898da669ae80a855536c52a7f00a0009a0465a2ec6cee66477b11f50"],
  ["slice-running", "beab1f224a3723cf005fb260d8d79a7f53b5083458b165cc5bcc98ffc40c5645"],
  ["slice-review", "f3032a106a15dda6324ea24d196196f8629cd57d1fc53a5e1e9f1f8c528d6b51"],
  ["slice-merged", "a36bfb5c4e168c8015eae87263ca562eba651051261c41d03441a1b87bf23e3e"],
  ["slice-blocked-ordinary", "bc27e546fad0fae0b3d3408199d29e0d1e492fdcc074f42d6707cde54f3cd0c3"],
  ["slice-blocked", "c566d2365a70e36e1616952e990317196ab85647c672afb731af20e402d1ceba"],
  ["validator-verdict-binding", "d5663f22b888f878625141430a2602863730f8ab122a815359dd545d876b49cb"],
  ["security-verdict-binding", "88c89ebb14e5f14121dc022da8f0c73dc1e5e9639d570337edcfb09cef5c17d7"],
  ["steering-boundary", "7842e29ee7d10b4465db99127739e4b602479aff47b848a5c7bb9d2e30ecf732"],
  ["steering-action-claim", "0acedda0cd1d2cf887d58482c179d90183e43650546d3e919b5f5cee92627b4f"],
  ["steering-last-action", "8d42d520ec811dad436e84cdc48b7ae6d2f13a442fdef2ba6397b13bdea16e67"],
  ["steering-pr-fence", "aae0a3986f100717159038cc2b06cfd835b1313305e22fc7beeea4929db3d662"],
  ["pr-created-result", "6b510aefac2fe46ad7ea3679ab0b023eda0ad0702139fdcfe62176b0404272bc"],
  ["continuation-envelope", "6bf3fb70f927af981715950d3e2d264bd72902599c95e07f82b01897fc4e05c9"],
  ["continuation-parent-binding", "8ae2a68c7eb75a5a179f6aee86a9e9cd85dfff2ee660073af2538bc59aaf1396"],
  ["continuation-selected-review", "c7cf99ee147100b49fab3bb71bf8457ec6eb0453d1e6810f98eb64968e3c4a14"],
  ["continuation-target-binding", "8a93c4d661ea231228107766a88c0455c78133c01cd302dfe7ee357a4b58cd78"],
  ["continuation-parent-artifact-sidecar", "49fa4ef22a921d623571722a2474807a5c421b8bca6b54a492ad316edc6548ad"],
  ["continuation-parent-evidence-sidecar", "c4359206e53fcaa6ce2fdb71a259b683b20c1462022e75c347502c5450dd05d6"],
  ["continuation-parent-review-sidecar", "a794e98cca26b7265e07f33edef3271de785044f9edd66140d36a00fa30dbc0f"],
  ["continuation-planning-reuse-ineligible", "299b7ff7f60229ffe0b23917aa491d84f23bbc7e71677a7b88049ebbade3b130"],
  ["continuation-planning-reuse-eligible", "9d5170a36602547f044d1a2f68d3d711886447c96682da41d3318e0587bc7e08"],
  ["continuation-draft-reuse", "1608dc8d7b077cb09ce453ec0c1273566bfc21cc5d2aebc18f40a85f240a8a08"],
  ["continuation-post-pr-binding", "154913668a919fd892d6a12e8355a5aaac9ac7310ee791e3318d503b4c193514"],
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
  ["repair-reported", "729c932f001d44a8f896fbafea9b1daa1db6458b061c5111bec748abcdbfc33e"],
  ["repair-repairing", "944bfd281e98e55853cc0062af34ebd255ec72d272721ee7b371bc23a863107d"],
  ["repair-review-approve", "34d5bfaf3f1e27307bc05974b2e7ffbf0c0aeadc997c64f79190c5425068ab84"],
  ["repair-review-reject", "1a220612b19cde72dbd20a39fbea5d53a5a3994de4bf2a13a3facb401a8cc7a7"],
  ["repair-merged", "902b94618560fc3b8c3ec73af14cbd572205673ec09142ba88ff3ab050fefae1"],
  ["repair-blocked-from-reported", "05835c182adf9d4372c39f6d0cc82cdac19b21017c928ded54047e7ea9eceea0"],
  ["repair-blocked-from-repairing", "79ff873a4b30a77b303fc29658b2ec1dc1cd86ad35bed9092f087c6b572e44ee"],
  ["repair-blocked-from-review", "ffacf779eacdf96ec9e9deaf94f350f386b02946f910a321ee7ce82eccad117b"],
]);
const DURABLE_AUTHORITY_DESCRIPTOR_BY_ID = new Map(DURABLE_AUTHORITY_DESCRIPTOR_MANIFEST);

const CANONICAL_SOURCE_RECORD_IDS = Object.freeze(Object.values(DURABLE_AUTHORITY_REQUIRED_RECORD_IDS).flat());
const CANONICAL_SOURCE_RECORD_ID_SET = new Set(CANONICAL_SOURCE_RECORD_IDS);

// Independently authored exact-value commitments over class/id placement, persisted
// record/variant labels, canonical run path, exact persisted source shape, authority
// fact declarations, and separately modeled external source bytes. These digests are
// literals rather than values derived from RECORDS or DURABLE_AUTHORITY_CATALOG.
export const DURABLE_AUTHORITY_CANONICAL_SOURCE_MANIFEST = deepFreeze([
  ["plan-slices-json", "dd6fabc7def0955d82f37d30a53fc19e4e8cc8fa69fa445badbc3c051d4dd7b9"],
  ["plan-v2-integration-gate", "b940206e8a4add6cee008305f694091dfadfb2fcddb12e8ffde34cae44ddcfe4"],
  ["final-plan-descriptor", "13b61642b831dd2fba59dd83bf897de443216d567b56ee8a952080d9f81a7568"],
  ["run-envelope-running", "f98a34215fdd5d0b2c4861bab4c6e6be104439e358a8e737095618955f227594"],
  ["run-envelope-terminal", "0e8365b1d3e99b2db1038cf9a2939fc6f4c421f199236307a1e1f4c300260e04"],
  ["terminal-result-completed", "67cc3ac4f4bc522a7e48be30ea4b1cdfcba2016a309ba99224197641cfcb059e"],
  ["terminal-result-blocked", "2e50300aa3e14e8fd6c935f3dae3fa44dd388c6ff386091ecbc28109f82ad855"],
  ["terminal-result-blocked-nonconvergence", "14f393a215fcdd7410b6030e6fc3a2448e9e4c6635b5bf830ae6a4f9d843cbfb"],
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
  ["step-work-decomposer-accepted-plan", "013523cc9576c74c21c46d3a59c8e9df1bda254971423d0519923f14dc1fe71e"],
  ["step-inherited-acceptance", "ba9a7a06a122aa68917e10675cf6b2ec97eab054ab7f40353904ef16ef226657"],
  ["test-execution-claim-active", "4a28465ee4bf8ae2aa775e59e6be0c399926cf34e6a485ef2d99c03d43abec87"],
  ["test-execution-claim-completed-pass", "a8976d1047f4915d9ef47f7367ce40b89bc381504987eccad0988d78f1719f07"],
  ["test-execution-claim-completed-fail", "232b87ab924b9b4a27c38165c4be79370a4fff2fe8bc1192476fa93b9c8c3040"],
  ["test-execution-claim-unknown-process-outcome-indeterminate", "86eb7ef4a735925cb12b2e4685c3cdeb2d2b51cfb62a499704582f96e04e4127"],
  ["test-execution-claim-unknown-authority-changed", "e1561c254d7767202c70d9d07ca056014ee2168918370303f2997ea0c6ab18d6"],
  ["test-execution-claim-unknown-receipt-publication-indeterminate", "c95c353de36a9719b74d9711f5dc92f19b432a2284ad2902b7cf1580f801d033"],
  ["test-execution-receipt-pass", "51a2006fc63ead36b0728846d574ee8ad86f806555bebc89c60ba3d06f3eca15"],
  ["test-execution-receipt-failed-nonzero-exit", "56bb07696d55efdfcd054c84b1914ea7b8d674afc360c0318ae5c90054c046f6"],
  ["test-execution-receipt-failed-signal", "3caa57455fd8f7210f479d6004705dbdb6b47ce064a58b7834f8be5ec9e624ee"],
  ["test-execution-receipt-failed-launch-error", "1320ebcb723f155eb795d8f91caf528d7fed2fb3e93f02d91a815c89f6f63008"],
  ["test-execution-receipt-failed-timeout", "5d77cdf0868afcf860e9fd1ec0cd985d0b4d4c2a9603e1efeb55c94e37f24bf4"],
  ["test-execution-receipt-failed-output-limit", "9f258d14925eb587cbe96ddfb9c0a1c7f6144c9bca3d7f8a73a07fa638fa328c"],
  ["slice-pending", "ae8061ad556cf202f28c06dad1d8dfaf84168512be57e8dae034984926ad766b"],
  ["slice-running", "ab8b06098386b7d5ca8ffb67fea577d4174fa961a945fa9f7179cbd448171a0a"],
  ["slice-review", "5bf07b76dffccf27da6e1cc3b92e40d79b7a2134a6ffe83d5c13a63f0bed78c6"],
  ["slice-merged", "55cc1727a80c4ab964a896ef20a6b6bf34985f8ec4779bc816b41c453f0c2167"],
  ["slice-blocked-ordinary", "9b89f67cdd763124470cbe20931dbe4cbeec61f1159d54387bb19c190af3da8a"],
  ["slice-blocked", "7a5f4c71dab812dd69e3c810ca632e55274770e020afd1ba8e221d5dace36d83"],
  ["validator-verdict-binding", "22c22e8e118609a58e29101a6f6a89dacc8ddfddcc92974c810fe4b51cc5fdc9"],
  ["security-verdict-binding", "56e34d4427dc76cb46caee5a002856e4e97ef2dc870543fc489a750e384e6d99"],
  ["steering-boundary", "b3477a6967254d04f869b97b8d15d00ddb952673f00807ebec41f05afdbdacfc"],
  ["steering-action-claim", "00866d18d439d808d2829e6d0967675629175bf8c1f00bec2130fa2728b30a21"],
  ["steering-last-action", "4fc3088a51000b12aed4ca3216c8e60b74c5206d8d9e75e4dea319cb31c62820"],
  ["steering-pr-fence", "16fa47900dbcbd6618a6ebd0eed5cb705910a2ccfc8478bd1f554c7f8ebef406"],
  ["pr-created-result", "619a77468645eec8923dec7f7e3c8b0d1aa11064aac4494e039b7aa282e6f9ea"],
  ["continuation-envelope", "5e10d284d461eb4758d11241f6b8ba67acb7eef34144eee4655080a8e620e2fe"],
  ["continuation-parent-binding", "ee8dabc5be43ce00230c86a075b90c23e978e3ee8a3cde8f3cb187676b0f0db5"],
  ["continuation-selected-review", "e2469d19e003e6f3b357f62d89f112fed91f40602db79a587a925bb1f071d26a"],
  ["continuation-target-binding", "579b338baade49828c938569cf4b4bc76e1125bda4ca04423865753f0a0a4e87"],
  ["continuation-parent-artifact-sidecar", "089baa634d9bb1bb2699b047988fefd2cdf95e0dc6eef46ffc072c13e2c8a584"],
  ["continuation-parent-evidence-sidecar", "f7f70a1daf94d5becccbd59f61df5a61ced521ed31d208b860a7ccc0f8625e79"],
  ["continuation-parent-review-sidecar", "bf8e04a769d72ccdc6124cb03189d3e6d64109fba295634af5a4749a61b12f22"],
  ["continuation-planning-reuse-ineligible", "185c450470908bdc215c6e82ed542ed8fc7284fa26a084e096e18b5d303ece08"],
  ["continuation-planning-reuse-eligible", "38ded4bf546d577abf750b54b8a8363e2c988881e5035e70a22a55d9b5ef65fb"],
  ["continuation-draft-reuse", "78b465df08ca5d06333f8b7fceeca2b92ff3bda67289f26e41e3ff0eeb83e669"],
  ["continuation-post-pr-binding", "d060eae5fbb7c63c0adc70bdf71585dd16e2ded8f49ca2bd74eda42b02f2f3f7"],
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
  ["repair-reported", "2ed03b55eaf8375148a6b2e0373481b9a7a5880b4d81f6a01b346c709d06635b"],
  ["repair-repairing", "7242ff535da8057dcbd5b4c64e046f7b4cac02690d9aa05cf492c6c78083f7b4"],
  ["repair-review-approve", "b0a2473d6870943222c3723ea4a3f487a35d3b7b03ebe50e6140d46bc9f65d53"],
  ["repair-review-reject", "4d2ec74d7585d8701cd9b2d5b1de36e1b5bfaf097443f6a34f4c41bf545cfda4"],
  ["repair-merged", "7088b60cbbe1f683f987e365af633b09ba64c528590bfb2b24000967d473c45f"],
  ["repair-blocked-from-reported", "9f706c75ff6e2cbd90a898406aa9be9c8258ee0e533adaea3c5675e9a9faf6ca"],
  ["repair-blocked-from-repairing", "fc79c812079bd9acf7b60aacb304ef47e0dd12b4f531e801191dead4ccefe66a"],
  ["repair-blocked-from-review", "3caeb87996031485b92a1b6a0b0167608ece7fe0f0f62760cbfa7ba055e121a0"],
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
    readers: ["validateSlicesPlan", "factory slices-seed", "transitionRunSlice and transitionSliceMerged", "transitionMergedSliceRepair owner-lane checks"],
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
    requiredPath: ["integration_gate", "required_commands"], unknownPath: ["integration_gate"], typePath: ["integration_gate", "required_commands"],
    targets: [drift(["integration_gate", "required_commands", 0], "program", "command"), stale(["integration_gate", "required_commands", 1, "args", 1], "test"), cross(["integration_gate", "required_commands", 1, "program"], "pnpm")],
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

  continuationEnvelopeEntry(),
  continuationParentEntry(),
  continuationReviewEntry(),
  continuationTargetEntry(),
  continuationContextEntry("continuation-parent-artifact-sidecar", "parent_artifacts[]", "artifact", "artifacts/story.md"),
  continuationContextEntry("continuation-parent-evidence-sidecar", "parent_evidence[]", "evidence", "evidence/test-verifier.json"),
  continuationContextEntry("continuation-parent-review-sidecar", "parent_reviews[]", "review", "reviews/implementation-validator.json"),
  recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-planning-reuse-ineligible", record: "continuation.planning_reuse", variant: "eligible false",
    writer: "factory continue planning reuse assessment",
    readers: ["validateContinuationPlanningReuse", "feature command payload normalization", "adoptContinuationPlanning refusal path"],
    ...continuationRecordSource("continuation-planning-reuse-ineligible"), requiredPath: ["eligible"], typePath: ["eligible"], targets: [stale(["eligible"], true), cross(["eligible"], "parent-accepted")],
  }),
  recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-planning-reuse-eligible", record: "continuation.planning_reuse", variant: "eligible true with accepted bytes",
    writer: "factory continue planning reuse assessment",
    readers: ["validateContinuationPlanningReuse", "feature command payload normalization", "adoptContinuationPlanning checked adoption"],
    ...continuationRecordSource("continuation-planning-reuse-eligible"),
    requiredPath: ["eligible"], typePath: ["spec_review_hash"], sidecars: [externalSidecar("review", ["spec_review_ref"], ["spec_review_hash"]), externalSidecar("artifact", ["spec_artifact_ref"], ["spec_artifact_hash"])],
    targets: [...externalSidecarTargets("review", ["spec_review_ref"], ["spec_review_hash"]), ...externalSidecarTargets("artifact", ["spec_artifact_ref"], ["spec_artifact_hash"]), stale(["eligible"], false), cross(["spec_review_ref"], "reviews/other-run.json")],
  }),
  recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-draft-reuse", record: "continuation.draft_spec_reuse", variant: "unaccepted draft with remaining retry budget",
    writer: "factory continue draft reuse admission",
    readers: ["validateContinuationDraftSpecReuse", "feature command payload normalization", "spec-writer attempt/budget initialization"],
    ...continuationRecordSource("continuation-draft-reuse"),
    requiredPath: ["artifact_ref"], typePath: ["remaining_attempts"], sidecars: [externalSidecar("draft", ["artifact_ref"], ["artifact_hash"])],
    targets: [...externalSidecarTargets("draft", ["artifact_ref"], ["artifact_hash"]), stale(["parent_step_attempts"], 0), cross(["remaining_attempts"], 3)] ,
  }),
  recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-post-pr-binding", record: "continuation.post_pr", variant: "blocked post-PR continuation context",
    writer: "factory continue post-PR continuation admission",
    readers: ["validateContinuationPostPr", "feature command payload normalization", "post-PR continuation workflow routing"],
    ...continuationRecordSource("continuation-post-pr-binding"),
    requiredPath: ["pr_url"], typePath: ["pr_number"], sidecars: [externalSidecar("evidence", ["evidence_ref"], ["evidence_hash"]), externalSidecar("review", ["continuation_review_ref"], ["continuation_review_hash"])],
    targets: [...externalSidecarTargets("evidence", ["evidence_ref"], ["evidence_hash"]), ...externalSidecarTargets("review", ["continuation_review_ref"], ["continuation_review_hash"]), ref(["pr_url"]), hash(["post_pr_hash"]), stale(["head_sha"], SHA_B), cross(["repository"], "other/repo")],
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

  repairEntry("repair-reported", "reported", 0, {
    facts: [fact(["status"], "reported"), fact(["attempts"], 0), fact(["defect_path"], "src/owner/records.js"), fact(["owner_slice_id"], "owner"), fact(["consumer_slice_id"], "consumer")],
    observations: [repairObservation("owner-lane", "plan", ["slices", 0, "paths"], ["src/owner/**"], "transitionMergedSliceRepair reported lane admission")],
    record: {}, sidecars: ["plan", "original-evidence"],
  }),
  repairEntry("repair-repairing", "repairing", 1, {
    facts: [fact(["status"], "repairing"), fact(["attempts"], 1), fact(["baseline_commit"], SHA_A), fact(["branch"], "repair-owner"), fact(["worktree"], "/tmp/repair-owner")],
    observations: [repairReobservation("quiescence", true, "transitionMergedSliceRepair repairing quiescence check")],
    record: { baseline_commit: SHA_A, branch: "repair-owner", worktree: "/tmp/repair-owner" }, sidecars: ["plan", "original-evidence"],
  }),
  repairEntry("repair-review-approve", "review:APPROVE", 1, {
    facts: [fact(["status"], "review"), fact(["attempts"], 1), fact(["baseline_commit"], SHA_A), fact(["reviewed_commit"], SHA_B), fact(["review_ref"], REPAIR_EXTERNAL.reviewApprove.ref), fact(["repair_evidence_ref"], REPAIR_EXTERNAL.repairEvidence.ref)],
    observations: [repairObservation("review-verdict", "review", ["verdict"], "APPROVE", "transitionMergedSliceRepair merged review consumer"), repairReobservation("owner-lane", true, "transitionMergedSliceRepair review Git diff lane check")],
    record: repairReviewFields(REPAIR_EXTERNAL.reviewApprove), sidecars: ["plan", "original-evidence", "repair-evidence", "review"], reviewExternal: REPAIR_EXTERNAL.reviewApprove,
  }),
  repairEntry("repair-review-reject", "review:REJECT", 1, {
    facts: [fact(["status"], "review"), fact(["attempts"], 1), fact(["baseline_commit"], SHA_A), fact(["reviewed_commit"], SHA_B), fact(["review_ref"], REPAIR_EXTERNAL.reviewReject.ref), fact(["repair_evidence_ref"], REPAIR_EXTERNAL.repairEvidence.ref)],
    observations: [repairObservation("review-verdict", "review", ["verdict"], "REJECT", "transitionMergedSliceRepair repairing retry consumer"), repairReobservation("owner-lane", true, "transitionMergedSliceRepair review Git diff lane check")],
    record: repairReviewFields(REPAIR_EXTERNAL.reviewReject), sidecars: ["plan", "original-evidence", "repair-evidence", "review"], reviewExternal: REPAIR_EXTERNAL.reviewReject,
  }),
  repairEntry("repair-merged", "merged", 1, {
    facts: [fact(["status"], "merged"), fact(["attempts"], 1), fact(["baseline_commit"], SHA_A), fact(["reviewed_commit"], SHA_B), fact(["merge_commit"], SHA_C), fact(["verification_ref"], REPAIR_EXTERNAL.verification.ref)],
    observations: [repairObservation("review-verdict", "review", ["verdict"], "APPROVE", "transitionMergedSliceRepair merged review consumer"), repairReobservation("reviewed-merge-tree-equality", true, "transitionMergedSliceRepair merged Git tree re-observation"), repairReobservation("quiescence", true, "transitionMergedSliceRepair merged quiescence check")],
    record: { ...repairReviewFields(REPAIR_EXTERNAL.reviewApprove), verification_ref: REPAIR_EXTERNAL.verification.ref, verification_hash: hashBytes(REPAIR_EXTERNAL.verification.bytes), merge_commit: SHA_C }, sidecars: ["plan", "original-evidence", "repair-evidence", "review", "verification"], reviewExternal: REPAIR_EXTERNAL.reviewApprove,
  }),
  repairEntry("repair-blocked-from-reported", "blocked-from-reported", 0, {
    facts: [fact(["status"], "blocked"), fact(["attempts"], 0), fact(["reason"], "repair rejected")],
    observations: [repairReobservation("blocked-origin", "reported", "transitionMergedSliceRepair blocked retention from reported")],
    record: { reason: "repair rejected" }, sidecars: ["plan", "original-evidence"],
  }),
  repairEntry("repair-blocked-from-repairing", "blocked-from-repairing", 1, {
    facts: [fact(["status"], "blocked"), fact(["attempts"], 1), fact(["baseline_commit"], SHA_A), fact(["reason"], "repair failed")],
    observations: [repairReobservation("blocked-origin", "repairing", "transitionMergedSliceRepair blocked retention from repairing")],
    record: { baseline_commit: SHA_A, branch: "repair-owner", worktree: "/tmp/repair-owner", reason: "repair failed" }, sidecars: ["plan", "original-evidence"],
  }),
  repairEntry("repair-blocked-from-review", "blocked-from-review", 1, {
    facts: [fact(["status"], "blocked"), fact(["attempts"], 1), fact(["baseline_commit"], SHA_A), fact(["reviewed_commit"], SHA_B), fact(["reason"], "review rejected")],
    observations: [repairObservation("review-verdict", "review", ["verdict"], "REJECT", "transitionMergedSliceRepair blocked retention from review"), repairReobservation("blocked-origin", "review", "transitionMergedSliceRepair blocked retention from review")],
    record: { ...repairReviewFields(REPAIR_EXTERNAL.reviewReject), reason: "review rejected" }, sidecars: ["plan", "original-evidence", "repair-evidence", "review"], reviewExternal: REPAIR_EXTERNAL.reviewReject,
  }),
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
    verdict: "REJECT",
    convergence: "nonconvergent",
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
    head_sha: SHA_B, receipt_ref: "evidence/test-verifier.attempt-1.json", claimed_at: NOW,
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
    requiredPath: ["execution_claim", "state"], unknownPath: ["execution_claim"], typePath: ["execution_claim", "attempt"],
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
    requiredPath: ["kind"], typePath: ["attempt"],
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
    started_at: NOW, completed_at: NOW, duration_ms: 1, status: passing ? "pass" : "fail", review_ready: passing, commands: [result],
  };
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
  const source = { id: "backend", stack: "backend", depends_on: [], status, attempts: variant === "pending" ? 0 : 1 };
  const targets = [stale(["attempts"], variant === "pending" ? 1 : 0), cross(["id"], "frontend")];
  let externalSources = {};
  const sidecars = [];
  const observations = [];
  if (variant !== "pending") {
    source.branch = "feature--backend";
    source.worktree = "/tmp/backend";
    source.dispatch_required = true;
    source.dispatch_claim_ref = SLICE_DISPATCH_EXTERNAL.claim.ref;
    source.dispatch_claim_hash = hashBytes(SLICE_DISPATCH_EXTERNAL.claim.bytes);
    externalSources = { claim: SLICE_DISPATCH_EXTERNAL.claim };
    sidecars.push(externalSidecar("claim", ["dispatch_claim_ref"], ["dispatch_claim_hash"]));
    targets.push(...externalSidecarTargets("claim", ["dispatch_claim_ref"], ["dispatch_claim_hash"]));
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
      verdict: blocked ? "REJECT" : "APPROVE",
      convergence: variant === "blocked" ? "nonconvergent" : "converging",
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
    readers: ["validateSteering successor fence validation", "transitionPrCreated and transitionPrePrFenceCleared checked GitHub reconciliation", "resume/recover legacy fence terminalization"],
    canonicalPath: ["steering", "pr_fence"], source, facts: exactFacts(source),
    requiredPath: ["operation_id"], typePath: ["draft"],
    targets: [time(["created_at"]), ref(["repository"]), hash(["state_hash"]), drift([], "operation_id", "operation"), stale(["head_sha"], SHA_A), cross(["operation_id"], `ffpr-v1-${"e".repeat(64)}`)],
  });
}

function continuationEnvelopeEntry() {
  const fixture = continuationCatalogFixture("continuation-envelope");
  return recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-envelope", record: "run.json.continuation", variant: "blocked-run continuation",
    writer: "factory continue checked child-run admission",
    readers: ["validateContinuation", "feature command payload normalization", "continuation workflow routing", "adoptContinuationPlanning"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, externalSources: fixture.externalSources, facts: exactFacts(fixture.source),
    requiredPath: ["kind"], typePath: ["operator_summary"], targets: [schema(["schema_version"]), kind(["kind"], "resume"), time(["created_at"]), stale(["kind"], "existing-run-resume"), cross(["operator_summary"], "other run")],
  });
}

function continuationParentEntry() {
  const fixture = continuationCatalogFixture("continuation-parent-binding");
  return recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-parent-binding", record: "continuation.parent", variant: "blocked parent",
    writer: "factory continue checked parent admission",
    readers: ["validateContinuationParent", "factory continue source revalidation", "adoptContinuationPlanning"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, externalSources: fixture.externalSources, facts: exactFacts(fixture.source),
    requiredPath: ["run_id"], typePath: ["status"], sidecars: [externalSidecar("parent-run", ["run_ref"], ["run_hash"])],
    targets: [...externalSidecarTargets("parent-run", ["run_ref"], ["run_hash"]), stale(["commit"], SHA_B), cross(["run_id"], "child-run")],
  });
}

function continuationReviewEntry() {
  const fixture = continuationCatalogFixture("continuation-selected-review");
  return recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-selected-review", record: "continuation.review", variant: "approved blocking review",
    writer: "factory continue selected-review admission",
    readers: ["validateContinuationReview", "validateContinuationSelectedReview", "continuation remediation decomposition"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, externalSources: fixture.externalSources, facts: exactFacts(fixture.source),
    requiredPath: ["kind"], typePath: ["required_fixes"], sidecars: [externalSidecar("selected-review", ["ref"], ["hash"])],
    targets: [kind(["kind"], "unknown-review"), ...externalSidecarTargets("selected-review", ["ref"], ["hash"]), stale(["verdict"], "REJECT"), cross(["subject"], "other-branch")],
  });
}

function continuationTargetEntry() {
  const fixture = continuationCatalogFixture("continuation-target-binding");
  return recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id: "continuation-target-binding", record: "continuation.target", variant: "fresh child target",
    writer: "factory continue checked child target allocation",
    readers: ["validateContinuationTarget", "feature command payload normalization", "child bootstrap and Git/worktree creation"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, facts: exactFacts(fixture.source),
    requiredPath: ["run_id"], typePath: ["base_commit"], targets: [ref(["worktree"]), stale(["base_commit"], SHA_A), cross(["run_id"], "parent-run")],
  });
}

function continuationContextEntry(id, record, kindValue, refValue) {
  const fixture = continuationCatalogFixture(id);
  return recordEntry({
    authorityClassId: "continuation-planning-draft-reuse", id, record: `continuation.${record}`, variant: `${kindValue} context binding`,
    writer: "factory continue parent context inventory",
    readers: ["validateContinuationRefHashArray", "feature command payload normalization", "continuation planning/remediation context loader"],
    canonicalPath: fixture.canonicalPath, source: fixture.source, externalSources: fixture.externalSources, facts: exactFacts(fixture.source),
    requiredPath: ["kind"], typePath: ["kind"], sidecars: [externalSidecar(kindValue, ["ref"], ["hash"])],
    targets: [kind(["kind"], "other-kind"), ...externalSidecarTargets(kindValue, ["ref"], ["hash"]), stale(["hash"], HASH_B), cross(["ref"], `reviews/other-${kindValue}.json`)],
  });
}

function continuationRecordSource(id) {
  const fixture = continuationCatalogFixture(id);
  return {
    canonicalPath: fixture.canonicalPath,
    source: fixture.source,
    externalSources: fixture.externalSources,
    facts: exactFacts(fixture.source),
  };
}

function continuationCatalogFixture(id) {
  const parent = {
    run_id: "parent-run",
    status: "blocked",
    run_ref: CONTINUATION_EXTERNAL.parentRun.ref,
    run_hash: hashBytes(CONTINUATION_EXTERNAL.parentRun.bytes),
    branch: "parent",
    commit: SHA_A,
    worktree: ".opencode/worktrees/parent",
  };
  const review = {
    kind: "validator",
    ref: CONTINUATION_EXTERNAL.selectedReview.ref,
    hash: hashBytes(CONTINUATION_EXTERNAL.selectedReview.bytes),
    subject: "parent",
    verdict: "APPROVE",
    source: "run.validator.review_ref",
    required_fixes: ["fix"],
  };
  const targetBinding = { run_id: "child-run", branch: "child", worktree: ".opencode/worktrees/child", base_ref: "main", base_commit: SHA_B };
  const artifact = { kind: "artifact", ref: CONTINUATION_EXTERNAL.artifact.ref, hash: hashBytes(CONTINUATION_EXTERNAL.artifact.bytes) };
  const evidence = { kind: "evidence", ref: CONTINUATION_EXTERNAL.evidence.ref, hash: hashBytes(CONTINUATION_EXTERNAL.evidence.bytes) };
  const parentReview = { kind: "review", ref: CONTINUATION_EXTERNAL.review.ref, hash: hashBytes(CONTINUATION_EXTERNAL.review.bytes) };
  const selectedParentReview = { kind: "review", ref: review.ref, hash: review.hash };
  const continuation = {
    schema_version: 1,
    kind: "blocked-run-continuation",
    created_at: NOW,
    operator_summary: "Continue blocked run.",
    parent,
    review,
    target: targetBinding,
    parent_artifacts: [artifact],
    parent_evidence: [evidence],
    parent_reviews: [parentReview, selectedParentReview],
    planning_reuse: { eligible: false },
  };
  let canonicalPath;
  let externalSources = {};
  if (id === "continuation-envelope") {
    canonicalPath = ["continuation"];
    externalSources = {
      "parent-run": CONTINUATION_EXTERNAL.parentRun,
      "selected-review": CONTINUATION_EXTERNAL.selectedReview,
      artifact: CONTINUATION_EXTERNAL.artifact,
      evidence: CONTINUATION_EXTERNAL.evidence,
      review: CONTINUATION_EXTERNAL.review,
    };
  } else if (id === "continuation-parent-binding") {
    canonicalPath = ["continuation", "parent"];
    externalSources = { "parent-run": CONTINUATION_EXTERNAL.parentRun };
  } else if (id === "continuation-selected-review") {
    canonicalPath = ["continuation", "review"];
    externalSources = { "selected-review": CONTINUATION_EXTERNAL.selectedReview };
  } else if (id === "continuation-target-binding") {
    canonicalPath = ["continuation", "target"];
  } else if (id === "continuation-parent-artifact-sidecar") {
    canonicalPath = ["continuation", "parent_artifacts", 0];
    externalSources = { artifact: CONTINUATION_EXTERNAL.artifact };
  } else if (id === "continuation-parent-evidence-sidecar") {
    canonicalPath = ["continuation", "parent_evidence", 0];
    externalSources = { evidence: CONTINUATION_EXTERNAL.evidence };
  } else if (id === "continuation-parent-review-sidecar") {
    canonicalPath = ["continuation", "parent_reviews", 0];
    externalSources = { review: CONTINUATION_EXTERNAL.review };
  } else if (id === "continuation-planning-reuse-ineligible") {
    canonicalPath = ["continuation", "planning_reuse"];
  } else if (id === "continuation-planning-reuse-eligible") {
    continuation.planning_reuse = {
      eligible: true,
      spec_review_ref: CONTINUATION_EXTERNAL.acceptedReview.ref,
      spec_review_hash: hashBytes(CONTINUATION_EXTERNAL.acceptedReview.bytes),
      spec_artifact_ref: CONTINUATION_EXTERNAL.acceptedArtifact.ref,
      spec_artifact_hash: hashBytes(CONTINUATION_EXTERNAL.acceptedArtifact.bytes),
    };
    canonicalPath = ["continuation", "planning_reuse"];
    externalSources = { review: CONTINUATION_EXTERNAL.acceptedReview, artifact: CONTINUATION_EXTERNAL.acceptedArtifact };
  } else if (id === "continuation-draft-reuse") {
    continuation.draft_spec_reuse = {
      artifact_ref: CONTINUATION_EXTERNAL.draft.ref,
      artifact_hash: hashBytes(CONTINUATION_EXTERNAL.draft.bytes),
      parent_step_status: "rejected",
      parent_step_attempts: 1,
      max_retries: 3,
      remaining_attempts: 2,
    };
    canonicalPath = ["continuation", "draft_spec_reuse"];
    externalSources = { draft: CONTINUATION_EXTERNAL.draft };
  } else if (id === "continuation-post-pr-binding") {
    continuation.post_pr = {
      pr_url: "https://github.com/acme/repo/pull/7",
      repository: "acme/repo",
      pr_number: 7,
      head_sha: SHA_A,
      disposition: "leave-unchanged",
      policy: postPrPolicy(true),
      post_pr_hash: HASH_A,
      evidence_ref: CONTINUATION_EXTERNAL.postPrEvidence.ref,
      evidence_hash: hashBytes(CONTINUATION_EXTERNAL.postPrEvidence.bytes),
      continuation_review_ref: CONTINUATION_EXTERNAL.postPrReview.ref,
      continuation_review_hash: hashBytes(CONTINUATION_EXTERNAL.postPrReview.bytes),
    };
    canonicalPath = ["continuation", "post_pr"];
    externalSources = { evidence: CONTINUATION_EXTERNAL.postPrEvidence, review: CONTINUATION_EXTERNAL.postPrReview };
  } else {
    throw new TypeError(`missing canonical continuation fixture for ${id}`);
  }
  return {
    run: { schema_version: 1, run_id: "child-run", status: "running", branch: "child", worktree: ".opencode/worktrees/child", max_retries: id === "continuation-draft-reuse" ? 3 : 2, gates: {}, continuation },
    canonicalPath,
    source: structuredClone(valueAt({ continuation }, canonicalPath, id)),
    externalSources: structuredClone(externalSources),
  };
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
    return { consumer: "validateRun/checkRunConsistency", ...createRepairCatalogBaseline(record) };
  }
  if (record.authorityClassId === "continuation-planning-draft-reuse") {
    const fixture = continuationCatalogFixture(record.id);
    if (canonicalJson(record.source) !== canonicalJson(fixture.source) || canonicalJson(record.canonicalPath) !== canonicalJson(fixture.canonicalPath)) throw new TypeError(`${record.id} does not match its canonical continuation baseline fixture`);
    return structuredClone({ consumer: "validateRun", run: fixture.run, externalSources: fixture.externalSources });
  }
  return structuredClone({ consumer: "validateRun", run: canonicalRunFixture(record), externalSources: record.externalSources ?? {} });
}

export function createRepairCatalogBaseline(record) {
  if (record?.authorityClassId !== "pr79-merged-slice-repair") throw new TypeError("repair fixture requires a registered PR79 repair record");
  if (canonicalJson(record.canonicalPath) !== canonicalJson(["merged_slice_repair"])) throw new TypeError(`${record.id} must bind run.json.merged_slice_repair`);
  const ownerEvidence = { ref: "evidence/owner.json", bytes: `{"subject":"owner","attempt":1,"status":"pass","review_ready":true,"head_sha":"${SHA_A}"}\n` };
  const ownerReview = { ref: "reviews/owner.json", bytes: `{"subject":"owner","attempt":1,"verdict":"APPROVE","convergence":"converging","remaining_fix_count":0,"required_fixes":[],"remediation_context":{"schema_version":2,"fixes":[]},"reviewed_commit":"${SHA_A}"}\n` };
  const ownerEvidenceHash = hashBytes(ownerEvidence.bytes);
  const ownerReviewHash = hashBytes(ownerReview.bytes);
  const ownerAttemptReview = { attempt: 1, evidence_ref: ownerEvidence.ref, evidence_hash: ownerEvidenceHash, review_ref: ownerReview.ref, review_hash: ownerReviewHash, reviewed_commit: SHA_A, verdict: "APPROVE", convergence: "converging", remaining_fix_count: 0 };
  const run = {
    schema_version: 1,
    run_id: "repair-catalog-run",
    branch: "repair-feature",
    status: "running",
    gates: {},
    steps: [],
    slices: [
      { id: "owner", stack: "backend", depends_on: [], status: "merged", attempts: 1, branch: "repair-feature--owner", worktree: "/tmp/repair-feature--owner", evidence_ref: ownerEvidence.ref, evidence_hash: ownerEvidenceHash, review_ref: ownerReview.ref, review_hash: ownerReviewHash, reviewed_commit: SHA_A, attempt_reviews: [ownerAttemptReview], merge_commit: SHA_A, updated_at: NOW },
      { id: "consumer", stack: "backend", depends_on: ["owner"], status: "blocked", attempts: 1, blocked_reason: "owner defect" },
    ],
    merged_slice_repair: structuredClone(record.source),
  };
  return structuredClone({
    run,
    externalSources: record.externalSources,
    supportSources: {
      ownerEvidence,
      ownerReview,
    },
  });
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
    const continuation = structuredClone(continuationCatalogFixture("continuation-planning-reuse-eligible").run.continuation);
    run.branch = "catalog-child";
    run.worktree = "/tmp/catalog-child";
    continuation.target = { ...continuation.target, run_id: run.run_id, branch: run.branch, worktree: run.worktree };
    continuation.planning_reuse = {
      eligible: true,
      spec_review_ref: record.source.inherited_acceptance.parent_spec_review_ref,
      spec_review_hash: record.source.inherited_acceptance.review_hash,
      spec_artifact_ref: record.source.acceptance.artifact_ref,
      spec_artifact_hash: record.source.inherited_acceptance.artifact_hash,
      child_spec_review_ref: record.source.review_ref,
    };
    run.continuation = continuation;
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

function repairEntry(id, status, attempts, options) {
  const source = {
    schema_version: 1,
    plan_hash: hashBytes(REPAIR_EXTERNAL.plan.bytes),
    owner_slice_id: "owner",
    consumer_slice_id: "consumer",
    defect_path: "src/owner/records.js",
    evidence_ref: REPAIR_EXTERNAL.originalEvidence.ref,
    evidence_hash: hashBytes(REPAIR_EXTERNAL.originalEvidence.bytes),
    status: status.startsWith("review:") ? "review" : status.startsWith("blocked-from-") ? "blocked" : status,
    attempts,
    max_attempts: 2,
    created_at: NOW,
    updated_at: NOW,
    ...options.record,
  };
  const externalSources = {
    plan: structuredClone(REPAIR_EXTERNAL.plan),
    "original-evidence": structuredClone(REPAIR_EXTERNAL.originalEvidence),
    ...(options.sidecars.includes("repair-evidence") ? { "repair-evidence": structuredClone(REPAIR_EXTERNAL.repairEvidence) } : {}),
    ...(options.sidecars.includes("review") ? { review: structuredClone(options.reviewExternal) } : {}),
    ...(options.sidecars.includes("verification") ? { verification: structuredClone(REPAIR_EXTERNAL.verification) } : {}),
  };
  const definitions = {
    plan: sidecar("plan", ["$external", "plan", "ref"], ["plan_hash"], ["$external", "plan", "bytes"]),
    "original-evidence": externalSidecar("original-evidence", ["evidence_ref"], ["evidence_hash"]),
    "repair-evidence": externalSidecar("repair-evidence", ["repair_evidence_ref"], ["repair_evidence_hash"]),
    review: externalSidecar("review", ["review_ref"], ["review_hash"]),
    verification: externalSidecar("verification", ["verification_ref"], ["verification_hash"]),
  };
  const sidecars = options.sidecars.map((name) => definitions[name]);
  const targets = sidecars.flatMap((binding) => sidecarTargets(binding.name, binding.refPath, binding.hashPath, binding.bytesPath));
  targets.push(schema(["schema_version"]), time(["updated_at"]), stale(["attempts"], attempts === 0 ? 1 : attempts - 1), cross(["consumer_slice_id"], "owner"), drift([], "evidence_ref", "reproduction_ref"));
  if (source.baseline_commit) targets.push(stale(["baseline_commit"], SHA_C));
  if (source.reviewed_commit) targets.push(cross(["reviewed_commit"], SHA_C));
  if (source.merge_commit) targets.push(stale(["merge_commit"], SHA_B));
  return recordEntry({
    authorityClassId: "pr79-merged-slice-repair", id, record: "run.json.merged_slice_repair", variant: status,
    writer: `transitionMergedSliceRepair ${status} transition`,
    readers: ["validateMergedSliceRepair", "transitionMergedSliceRepair next-state checks", "mergedSliceRepairFence and resume eligibility", "slice/step/panel/gate/PR lifecycle fences"],
    source, canonicalPath: ["merged_slice_repair"], externalSources, requiredPath: ["status"], typePath: ["attempts"], sidecars, facts: options.facts, observations: options.observations, targets,
  });
}

function repairReviewFields(reviewExternal) {
  return {
    baseline_commit: SHA_A,
    reviewed_commit: SHA_B,
    review_ref: reviewExternal.ref,
    review_hash: hashBytes(reviewExternal.bytes),
    repair_evidence_ref: REPAIR_EXTERNAL.repairEvidence.ref,
    repair_evidence_hash: hashBytes(REPAIR_EXTERNAL.repairEvidence.bytes),
  };
}

function repairObservation(name, source, path, expected, consumer) {
  return { name, source, path, expected, consumer };
}

function repairReobservation(name, expected, consumer) {
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
  if (record.authorityClassId === "pr79-merged-slice-repair") {
    for (const key of ["plan_ref", "owner_snapshot", "quiescent", "review_verdict", "reviewed_tree", "merge_tree", "sidecar_bytes", "blocked_from"]) forbidden.add(key);
  }
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
