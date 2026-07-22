import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const DESIGN = read("../CONTINUATION-SCOPE-DESIGN.md");
const LEDGER = read("../DURABLE-AUTHORITY-LEDGER.md");
const SPEC = read("../SPEC.md");
const SCHEMA = read("../assets/skills/feature/SCHEMA.md");
const CONTRACT = extractContract(DESIGN);

const MANIFEST_VARIANTS = [
  { id: "amendment-reported", status: "reported", attempt_shape: "empty", extra_keys: [] },
  { id: "amendment-building-attempt-1", status: "building", attempt_shape: "building-1", extra_keys: [] },
  { id: "amendment-building-attempt-2", status: "building", attempt_shape: "reject-1-building-2", extra_keys: [] },
  { id: "amendment-reviewed-approve-attempt-1", status: "reviewed", attempt_shape: "approve-1", extra_keys: [] },
  { id: "amendment-reviewed-reject-attempt-1", status: "reviewed", attempt_shape: "reject-1", extra_keys: [] },
  { id: "amendment-reviewed-approve-attempt-2", status: "reviewed", attempt_shape: "reject-1-approve-2", extra_keys: [] },
  { id: "amendment-reviewed-reject-attempt-2", status: "reviewed", attempt_shape: "reject-1-reject-2", extra_keys: [] },
  { id: "amendment-integrated", status: "integrated", attempt_shape: "last-approve", extra_keys: ["integration"] },
  { id: "amendment-verified", status: "verified", attempt_shape: "last-approve", extra_keys: ["integration", "verification"] },
  { id: "amendment-merged", status: "merged", attempt_shape: "last-approve", extra_keys: ["integration", "verification", "publication"] },
  { id: "amendment-blocked-from-reported", status: "blocked", attempt_shape: "empty", extra_keys: ["blocked"], origin: "reported" },
  { id: "amendment-blocked-from-building", status: "blocked", attempt_shape: "last-building", extra_keys: ["blocked"], origin: "building" },
  { id: "amendment-blocked-from-reviewed-approve", status: "blocked", attempt_shape: "last-approve", extra_keys: ["blocked"], origin: "reviewed-approve" },
  { id: "amendment-blocked-from-reviewed-reject", status: "blocked", attempt_shape: "last-reject", extra_keys: ["blocked"], origin: "reviewed-reject" },
  { id: "amendment-blocked-from-integrated", status: "blocked", attempt_shape: "last-approve", extra_keys: ["integration", "blocked"], origin: "integrated" },
  { id: "amendment-blocked-from-verified", status: "blocked", attempt_shape: "last-approve", extra_keys: ["integration", "verification", "blocked"], origin: "verified" },
];

const CLAIM_VARIANTS = [
  { id: "amendment-report-claim-active", phase: "report", state: "active", status: null, reason: null },
  { id: "amendment-report-claim-completed-pass", phase: "report", state: "completed", status: "pass", reason: null },
  { id: "amendment-report-claim-completed-fail", phase: "report", state: "completed", status: "fail", reason: null },
  { id: "amendment-report-claim-unknown-process-outcome-indeterminate", phase: "report", state: "unknown", status: null, reason: "process-outcome-indeterminate" },
  { id: "amendment-report-claim-unknown-authority-changed", phase: "report", state: "unknown", status: null, reason: "authority-changed" },
  { id: "amendment-report-claim-unknown-receipt-publication-indeterminate", phase: "report", state: "unknown", status: null, reason: "receipt-publication-indeterminate" },
  { id: "amendment-verify-claim-active", phase: "verify", state: "active", status: null, reason: null },
  { id: "amendment-verify-claim-completed-pass", phase: "verify", state: "completed", status: "pass", reason: null },
  { id: "amendment-verify-claim-completed-fail", phase: "verify", state: "completed", status: "fail", reason: null },
  { id: "amendment-verify-claim-unknown-process-outcome-indeterminate", phase: "verify", state: "unknown", status: null, reason: "process-outcome-indeterminate" },
  { id: "amendment-verify-claim-unknown-authority-changed", phase: "verify", state: "unknown", status: null, reason: "authority-changed" },
  { id: "amendment-verify-claim-unknown-receipt-publication-indeterminate", phase: "verify", state: "unknown", status: null, reason: "receipt-publication-indeterminate" },
];
const RECEIPT_OUTCOMES = ["pass", "nonzero-exit", "signal", "launch-error", "timeout", "output-limit"];

const FIELD_SETS = {
  admission: ["baseline_ref", "baseline_commit", "baseline_tree", "worktree", "probe", "owner", "consumer"],
  owner: ["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts", "attempt_reviews", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "merge_commit"],
  consumer: ["id", "stack", "depends_on", "declared_paths", "effective_paths", "status", "attempts"],
  probe: ["schema_version", "kind", "delivery_unit_id", "consumer_slice_id", "verification_artifact_id", "test_plan_index", "test_plan_entry", "program", "args", "substrate"],
  execution_binding: ["claim_ref", "claim_hash", "receipt_ref", "receipt_hash"],
  attempt_building: ["attempt", "state", "build_base_commit", "branch_ref", "worktree"],
  attempt_reviewed: ["attempt", "state", "build_base_commit", "branch_ref", "worktree", "dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash", "candidate_commit", "candidate_tree", "changed_paths", "review_ref", "review_hash", "reviewed_commit", "reviewed_tree"],
  integration: ["ref", "worktree", "commit", "tree"],
  publication: ["branch_ref", "previous_commit", "commit", "published_at"],
  blocked: ["origin", "reason", "blocked_at"],
  review: ["schema_version", "kind", "subject", "amendment_id", "attempt", "build_base_commit", "reviewed_commit", "reviewed_tree", "changed_paths", "dispositions", "verdict", "required_fixes", "reviewed_at"],
  claim_active: ["schema_version", "kind", "phase", "subject", "state", "nonce", "amendment_id", "identity", "run_id", "probe", "head_sha", "tree_sha", "cwd", "receipt_ref", "claimed_at"],
  claim_completed: ["schema_version", "kind", "phase", "subject", "state", "nonce", "amendment_id", "identity", "run_id", "probe", "head_sha", "tree_sha", "cwd", "receipt_ref", "claimed_at", "completed_at", "status", "receipt_hash"],
  claim_unknown: ["schema_version", "kind", "phase", "subject", "state", "nonce", "amendment_id", "identity", "run_id", "probe", "head_sha", "tree_sha", "cwd", "receipt_ref", "claimed_at", "failed_at", "reason", "receipt_status", "receipt_hash"],
  receipt: ["schema_version", "kind", "phase", "subject", "run_id", "amendment_id", "claim_nonce", "probe", "head_sha", "tree_sha", "cwd", "started_at", "completed_at", "duration_ms", "status", "review_ready", "commands"],
  review_dispatch_claim: ["schema_version", "kind", "run_id", "amendment_id", "attempt", "agent", "baseline_commit", "candidate_commit", "candidate_tree", "review_ref", "context_hash", "completion_token_hash", "claimed_at", "closure_ref"],
  review_dispatch_closure: ["schema_version", "kind", "claim_ref", "claim_hash", "run_id", "amendment_id", "attempt", "agent", "context_hash", "review_ref", "review_hash", "completion_token", "returned_at"],
};

const CATALOG_POLICY = {
  manifest_variants: { writer: "factory amendment checked transition", readers: ["validateRun", "checkRunConsistency", "successor amendment transition", "merged amendment downstream guard"], tests: ["integration-amendment-contract", "integration-amendment-runtime", "durable-record-mutations"] },
  claim_variants: { writer: "factory amendment report/verify executor", readers: ["validateRun", "checkRunConsistency", "execution replay", "successor amendment transition"], tests: ["integration-amendment-contract", "integration-amendment-runtime", "durable-record-mutations"] },
  receipt_variants: { writer: "factory amendment report/verify executor", readers: ["validateRun", "checkRunConsistency", "execution replay", "successor amendment transition"], tests: ["integration-amendment-contract", "integration-amendment-runtime", "durable-record-mutations"] },
  review_variants: { writer: "factory amendment review transition", readers: ["validateRun", "checkRunConsistency", "integrate transition", "retry transition"], tests: ["integration-amendment-contract", "integration-amendment-runtime", "durable-record-mutations"] },
  dispatch_variants: { writer: "integration-amendment special-dispatch prepare/complete hook", readers: ["validateRun", "checkRunConsistency", "review transition", "unresolved-dispatch guard"], tests: ["integration-amendment-contract", "factory-integration-amendment", "durable-record-mutations"] },
  review_dispatch_variants: { writer: "src/plugin.js checked work-reviewer before/after callback through prepare/complete integration-amendment review dispatch", readers: ["validateIntegrationAmendmentReviewDispatchClaim", "validateIntegrationAmendmentReviewDispatchClosure", "inspectIntegrationAmendmentInventory reviewer-effect classifier", "callback replay", "review transition", "downstream amendment consistency"], tests: ["integration-amendment-contract", "integration-amendment-runtime", "plugin", "durable-record-mutations"] },
};

const PARITY = [
  [1, "report eligibility", "checked failure execution and report admission"],
  [2, "ratified ownership and overlap", "current effective-owner observation"],
  [3, "quiescence and attempt ceiling", "build transition"],
  [4, "special dispatch derivation", "generic prepare/complete route"],
  [5, "heartbeat dispatch fence", "heartbeat pre-mutation check"],
  [6, "abbreviated commit", "full-SHA review binding"],
  [7, "changed paths and write-once review", "Git path observation/create-only review"],
  [8, "resulting feature head", "staged verify then feature CAS"],
  [9, "unresolved resume fence", "resume projection"],
  [10, "blocked terminalization", "checked block then terminal boundary"],
  [11, "exact-file lanes", "effective ownership matcher"],
  [12, "exact reviewed commit", "dispatch closure/review binding"],
  [13, "divergent merge tree", "reviewed/integration tree proof"],
  [14, "stale verdict or attempt", "external review consumer"],
  [15, "rename source", "no-renames two-endpoint path set"],
  [16, "frozen owner authority", "plan/owner reobservation"],
  [17, "original evidence drift", "failure claim/receipt rehash"],
  [18, "canonical lane text", "path normalization"],
  [19, "unsupported globs", "accepted plan/lane validator"],
  [20, "slice quiescence", "slice start/merge fences"],
  [21, "step fence", "step/test-verifier fences"],
  [22, "gate fence", "gate boundary/decision fences"],
  [23, "post-PR exclusion", "canonical actual-authority predicate"],
  [24, "pre-integration admission", "test/panel/gate/fence/PR absence"],
  [25, "heartbeat work", "building/review wait classification"],
  [26, "consistency drift", "sidecar/Git consistency consumers"],
  [27, "generic mutation denial", "scoped run-writer guard"],
  [28, "sidecar/Git publication races", "deterministic pre/post effect hooks"],
].map(([id, category, sink]) => ({ id, category, sink }));

describe("B5.1 integration amendment contract", () => {
  it("justifies the checked reviewer callback as the smallest architectural addition", () => {
    assert.match(DESIGN, /\| Checked integration-amendment reviewer callback protocol \| B5\.3 fresh exact-commit independent review \| Ordinary semantic review provenance and existing plugin Task hook \| Semantic provenance is fenced during amendment and prewritten review is forgeable \| One checked fresh `work-reviewer` plugin route plus the two cataloged immutable reviewer claim\/closure sidecars and create-only review \|/u);
  });

  it("fixes canonical identity, refs, exact schemas, and the pending baseline substrate", () => {
    assert.deepEqual(CONTRACT.identity.keys, ["schema_version", "kind", "run_id", "defect_path", "admission"]);
    const canonical = "{\"admission\":{\"baseline_ref\":\"refs/heads/f\"},\"defect_path\":\"src/a.js\",\"kind\":\"integration-amendment-identity\",\"run_id\":\"r\",\"schema_version\":1}";
    assert.equal(CONTRACT.identity.fixture_canonical_json, canonical);
    assert.equal(createHash("sha256").update(canonical, "utf8").digest("base64url"), "GLwRWjMLO_9ciKDTgfdfvqAOkPOVy_Y_4nunddvBoWY");
    assert.equal(CONTRACT.identity.fixture_id, "GLwRWjMLO_9ciKDTgfdfvqAOkPOVy_Y_4nunddvBoWY");
    assert.deepEqual(CONTRACT.eligibility, {
      consumer_status: "pending",
      consumer_attempts: 0,
      consumer_forbidden_keys: ["branch", "worktree", "blocked_reason", "attempt_reviews", "dispatch_required", "dispatch_claim_ref", "dispatch_claim_hash", "dispatch_closure_ref", "dispatch_closure_hash", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "merge_commit"],
      substrate: "feature-baseline",
      consumer_after_merge: "byte-identical-pristine-pending",
      excluded_consumer_classes: ["blocked", "previously-attempted", "branch-only"],
    });
    assert.deepEqual(CONTRACT.refs, {
      report_claim: "evidence/integration-amendment.report.claim.json",
      report_receipt: "evidence/integration-amendment-<A>.report.receipt.json",
      verify_claim: "evidence/integration-amendment-<A>.verify.claim.json",
      verify_receipt: "evidence/integration-amendment-<A>.verify.receipt.json",
      review: "reviews/integration-amendment-<A>.attempt-<N>.json",
      review_dispatch_claim: "dispatch/<sha256(run-id NUL integration-amendment-review NUL A NUL N)>.amendment-review.json",
      review_dispatch_closure: "dispatch/<same-sha256>.amendment-review.closed.json",
      build_branch: "refs/heads/<run.branch>--amend-<A>-a<N>",
      build_worktree: "<repo>/.opencode/worktrees/<run.branch>--amend-<A>-a<N>",
      staging_ref: "refs/opencode/integration-amendments/<A>/staged",
      staging_worktree: "<repo>/.opencode/worktrees/<run.branch>--amend-<A>-staged",
      dispatch_instance: "<A>:attempt-<N>",
    });
    assert.deepEqual(CONTRACT.field_sets, FIELD_SETS);
  });

  it("enumerates every closed manifest, claim, receipt, review, and dispatch row", () => {
    assert.deepEqual(CONTRACT.manifest_variants, MANIFEST_VARIANTS);
    assert.deepEqual(CONTRACT.claim_variants, CLAIM_VARIANTS);
    assert.deepEqual(CONTRACT.receipt_variants, ["report", "verify"].flatMap((phase) => RECEIPT_OUTCOMES.map((outcome) => ({ id: `amendment-${phase}-receipt-${outcome}`, phase, outcome }))));
    assert.deepEqual(CONTRACT.review_variants, ["amendment-review-approve", "amendment-review-reject"]);
    assert.deepEqual(CONTRACT.dispatch_variants, ["amendment-dispatch-binding-active", "amendment-dispatch-binding-closed", "amendment-dispatch-claim", "amendment-dispatch-closure"]);
    assert.deepEqual(CONTRACT.review_dispatch_variants, ["amendment-review-dispatch-claim", "amendment-review-dispatch-closure"]);
    assert.deepEqual(CONTRACT.blocked_origins, ["reported", "building", "reviewed-approve", "reviewed-reject", "integrated", "verified"]);
    const rows = [CONTRACT.manifest_variants, CONTRACT.claim_variants, CONTRACT.receipt_variants].flat().map(({ id }) => id).concat(CONTRACT.review_variants, CONTRACT.dispatch_variants, CONTRACT.review_dispatch_variants);
    assert.equal(rows.length, 48);
    assert.equal(new Set(rows).size, 48);
    assert.equal(rows.some((id) => id.includes("*")), false);
    assert.deepEqual(CONTRACT.catalog_policy, CATALOG_POLICY);
  });

  it("pins execution and review discriminators, nullability, and command result reuse", () => {
    assert.deepEqual(CONTRACT.dispositions, ["accepted_contract", "public_contract", "persisted_contract", "product_scope", "security_boundary", "generated_ownership", "decomposition"]);
    assert.deepEqual(CONTRACT.discriminator_rules, {
      kinds: { identity: "integration-amendment-identity", probe: "integration-amendment-probe", claim: "integration-amendment-execution-claim", receipt: "integration-amendment-execution-receipt", review: "integration-amendment-review", review_dispatch_claim: "checked-integration-amendment-review-dispatch-claim", review_dispatch_closure: "checked-integration-amendment-review-dispatch-closure" },
      subjects: { execution: "integration-amendment:<A>:<phase>", review: "integration-amendment:<A>" },
      claim: {
        phases: ["report", "verify"],
        states: ["active", "completed", "unknown"],
        completed_statuses: ["pass", "fail"],
        unknown_reasons: ["process-outcome-indeterminate", "authority-changed", "receipt-publication-indeterminate"],
        unknown_no_receipt: { receipt_status: null, receipt_hash: null },
        unknown_receipt_binding: "both-known-outcome-and-exact-hash-or-both-null",
      },
      receipt: { statuses: ["pass", "fail"], command_count: 1, review_ready: ["report:nonzero-exit", "verify:pass"] },
      review: { verdicts: ["APPROVE", "REJECT"], disposition_values: ["preserved", "changed"], approve: "all-preserved-and-empty-required-fixes", retry: "reject-all-preserved-and-nonempty-required-fixes", block: "any-changed-disposition-or-second-reject" },
      command_result_contract: {
        source: "assets/skills/feature/SCHEMA.md#evidence-and-review-files",
        keys: ["index", "program", "args", "outcome", "status", "exit_code", "signal", "error_code", "duration_ms", "stdout", "stderr"],
        stream_keys: ["captured_bytes", "sha256", "truncated"],
        outcomes: ["exited", "signaled", "timeout", "output-limit", "launch-error"],
        nullability: "existing-closed-command-result-nullability",
      },
    });
    assert.deepEqual(CONTRACT.review_dispatch_observations, ["absent", "active-claim-only", "review-published-without-closure", "closed-unconsumed", "consumed", "orphan-or-cross-bound"]);
    assert.deepEqual(CONTRACT.review_dispatch_compatibility, {
      run_schema_bump: false,
      "pre-dispatch_legacy": "absent-compatible",
      reviewed_attempt: "claim-and-closure-required",
      publication: "create-only-exact-replay-no-overwrite",
      unresolved: "semantic-fence-and-operator-reconciliation-no-redispatch",
      consumed: "immutable-downstream-revalidation",
    });
  });

  it("pins state edges, outcomes, singleton observations, CAS recovery, and every writer fence", () => {
    assert.deepEqual(CONTRACT.transitions, ["reported->building-1", "building-1->reviewed-approve-1", "building-1->reviewed-reject-1", "reviewed-reject-1->building-2", "building-2->reviewed-approve-2", "building-2->reviewed-reject-2", "reviewed-approve-1->integrated", "reviewed-approve-2->integrated", "integrated->verified", "verified->merged"]);
    assert.deepEqual(CONTRACT.report_outcomes.map(({ outcome, decision }) => `${outcome}:${decision}`), ["pass:settled-no-manifest", "nonzero-exit:reported-on-exact-consumption", "signal:settled-diagnostic-no-manifest", "launch-error:settled-diagnostic-no-manifest", "timeout:settled-diagnostic-no-manifest", "output-limit:settled-diagnostic-no-manifest", "indeterminate:unknown-operator-reconciliation"]);
    assert.deepEqual(CONTRACT.verification_outcomes.map(({ outcome, decision }) => `${outcome}:${decision}`), ["pass:verified", "nonzero-exit:blocked-from-integrated", "signal:blocked-from-integrated", "launch-error:blocked-from-integrated", "timeout:blocked-from-integrated", "output-limit:blocked-from-integrated", "indeterminate:remain-integrated-and-fence"]);
    assert.deepEqual(CONTRACT.report_claim_observations, ["all-absent", "active-claim-only", "unknown-claim-optional-bound-receipt", "completed-pass-receipt-no-manifest", "completed-diagnostic-receipt-no-manifest", "completed-nonzero-receipt-no-manifest", "completed-nonzero-receipt-matching-manifest", "receipt-without-claim", "cross-bound-or-orphan-sidecar"]);
    assert.deepEqual(CONTRACT.publication_cases, ["ref-and-clean-worktree-at-baseline", "ref-and-clean-worktree-at-integration", "ref-at-integration-worktree-at-exact-clean-pre-cas-baseline"]);
    assert.deepEqual(CONTRACT.writer_fences, ["amendment-transitions", "generic-run-writers", "slice-writers", "step-writers", "gate-writers", "panel-writers", "pre-pr-and-pr-writers", "post-pr-writers", "heartbeat-writers", "resume-and-recovery", "terminalization", "cleanup", "continuation", "legacy-report-admission", "validateRun", "checkRunConsistency"]);
  });

  it("pins continuation, migration, and all 28 legacy parity decisions", () => {
    assert.deepEqual(CONTRACT.continuation_boundaries, ["construction", "target-reservation", "allocation", "publication", "adoption", "payload-replay", "local-authority-check", "resume"]);
    assert.deepEqual(CONTRACT.migration, ["persisted-legacy-progresses-unchanged", "generic-and-legacy-never-coexist", "generic-tombstone-forbids-legacy-fallback", "generic-retires-legacy-only-for-pristine-pending-baseline-substrate", "blocked-previously-attempted-and-branch-only-remain-narrowed-legacy-recovery", "all-28-adversarial-guarantees-port-before-cutover"]);
    assert.deepEqual(CONTRACT.parity, PARITY);
  });

  it("keeps every public summary aligned with design-only class-9 authority", () => {
    assert.equal(CONTRACT.runtime_authority, false);
    assert.match(LEDGER, /fixed per-run report claim is the pre-manifest singleton tombstone/u);
    assert.match(LEDGER, /exactly 48 planned rows/u);
    assert.match(SPEC, /pristine pending direct consumer/u);
    assert.match(SPEC, /B5\.1 is design-only; these bullets grant no runtime authority/u);
    assert.match(SCHEMA, /planned B5 successor within class 9/u);
    assert.match(SCHEMA, /exactly 48 planned rows/u);
    for (const summary of [LEDGER, SPEC, SCHEMA]) {
      assert.match(summary, /blocked, previously attempted, and branch-only/iu);
    }
  });
});

function extractContract(markdown) {
  const match = markdown.match(/<!-- integration-amendment-contract:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- integration-amendment-contract:end -->/u);
  assert.ok(match, "canonical integration amendment contract block");
  return JSON.parse(match[1]);
}

function read(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}
