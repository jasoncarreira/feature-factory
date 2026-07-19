import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateDeliveryEnvelopeAdmission } from "../src/delivery-envelope/admission-extension.js";
import { evaluateInvariantFamilyReview } from "../src/delivery-envelope/review-extension.js";
import {
  DeliveryContractValidationError,
  validateAdmissionExtensionResult,
  validateDeliveryEnvelope,
  validateInvariantFamilyLedger,
  validateReviewExtensionResult,
} from "../src/delivery-envelope/extensions.js";

const HASH = `sha256:${"a".repeat(64)}`;
const COMMIT = "b".repeat(40);

describe("B4 delivery-contract extension seams", () => {
  it("validates one closed delivery unit per slice and exact obligation/artifact mappings", () => {
    const plan = deliveryPlan();
    assert.equal(validateDeliveryEnvelope(plan.delivery_envelope, plan.slices), plan.delivery_envelope);
    assert.equal(plan.delivery_envelope.delivery_units[0].verification_artifacts[0].test_plan_entry, "node --test test/api.test.js");

    const unknownArtifact = structuredClone(plan.delivery_envelope);
    unknownArtifact.delivery_units[0].obligations[0].verification_artifact_id = "missing-artifact";
    assert.throws(
      () => validateDeliveryEnvelope(unknownArtifact, plan.slices),
      (error) => error instanceof DeliveryContractValidationError
        && error.message.includes("must reference exactly one known verification artifact"),
    );

    const duplicateFamily = structuredClone(plan.delivery_envelope);
    duplicateFamily.delivery_units[0].invariant_families.push({ ...duplicateFamily.delivery_units[0].invariant_families[0] });
    assert.throws(() => validateDeliveryEnvelope(duplicateFamily, plan.slices), /invariant family id must be globally unique/u);

    const wrongCommand = structuredClone(plan.delivery_envelope);
    wrongCommand.delivery_units[0].verification_artifacts[0].test_plan_entry = "node --test test/other.test.js";
    assert.throws(() => validateDeliveryEnvelope(wrongCommand, plan.slices), /must exactly equal the referenced slice test_plan entry/u);
  });

  it("validates closed ledger references without applying pass policy", () => {
    const plan = deliveryPlan();
    const ledger = invariantFamilyLedger();
    assert.equal(validateInvariantFamilyLedger(ledger, {
      deliveryEnvelope: plan.delivery_envelope,
      slices: plan.slices,
      sliceId: "api",
      reviewedCommit: COMMIT,
    }), ledger);
    assert.equal(ledger.dispositions[0].result.outcome, "fail", "B4.1 shape validation must not impose B4.4 pass policy");
    assert.deepEqual(ledger.dispositions[0].unresolved_findings, ["Known failure remains"]);

    const crossBound = structuredClone(ledger);
    crossBound.dispositions[0].verification_artifact_id = "api-contract-tests";
    crossBound.dispositions[0].probe.verification_artifact_id = "api-contract-tests";
    assert.throws(() => validateInvariantFamilyLedger(crossBound, {
      deliveryEnvelope: plan.delivery_envelope,
      slices: plan.slices,
      sliceId: "api",
      reviewedCommit: COMMIT,
    }), /must reference a verification artifact in the ledger delivery unit/u);

    const unknownKey = structuredClone(ledger);
    unknownKey.dispositions[0].authority = true;
    assert.throws(() => validateInvariantFamilyLedger(unknownKey), /authority: is not allowed/u);
  });

  it("keeps legacy admission inactive while applying active checked review policy", () => {
    const plan = deliveryPlan();
    const review = { subject: "api", attempt: 1, verdict: "REJECT", reviewed_commit: COMMIT, invariant_family_ledger: invariantFamilyLedger() };
    let observedRef = null;
    const admission = evaluateDeliveryEnvelopeAdmission({ plan });
    const reviewResult = evaluateInvariantFamilyReview({
      plan,
      sliceId: "api",
      review,
      observeEvidence(ref) {
        observedRef = ref;
        const receipt = failedVerificationReceipt();
        return { ref, hash: HASH, receipt, claim: completedVerificationClaim(ref, receipt) };
      },
    });

    assert.deepEqual(validateAdmissionExtensionResult(admission), {
      schema_version: 1,
      extension: "delivery-envelope-admission",
      status: "inactive",
      grants_b4_authority: false,
      reason: "b4-admission-policy-inactive",
    });
    assert.deepEqual(validateReviewExtensionResult(reviewResult), {
      schema_version: 1,
      extension: "invariant-family-review",
      status: "active",
      grants_b4_authority: false,
      decision: "reject",
      reasons: [
        "review-verdict-reject",
        "invariant-family-result-not-pass:api-behavior",
        "invariant-family-unresolved-findings:api-behavior",
      ],
    });
    assert.equal(observedRef, "evidence/api-family.json");

    assert.deepEqual(validateAdmissionExtensionResult({
      schema_version: 1,
      extension: "delivery-envelope-admission",
      status: "active",
      grants_b4_authority: false,
      decision: "checkpoint",
      reasons: ["mixed-authority-width"],
    }).decision, "checkpoint");
    assert.deepEqual(validateReviewExtensionResult({
      schema_version: 1,
      extension: "invariant-family-review",
      status: "active",
      grants_b4_authority: true,
      decision: "approve",
      reasons: ["all-families-current"],
    }).decision, "approve");
  });

  it("preserves omission compatibility while rejecting any supplied malformed reservation", () => {
    assert.deepEqual(evaluateDeliveryEnvelopeAdmission({ plan: { slices: [] } }), {
      schema_version: 1,
      extension: "delivery-envelope-admission",
      status: "inactive",
      grants_b4_authority: false,
      reason: "b4-admission-policy-inactive",
    });
    assert.deepEqual(evaluateInvariantFamilyReview({ plan: { slices: [] }, sliceId: "legacy", review: {} }), {
      schema_version: 1,
      extension: "invariant-family-review",
      status: "inactive",
      grants_b4_authority: false,
      reason: "b4-review-policy-inactive",
    });
    assert.throws(
      () => evaluateDeliveryEnvelopeAdmission({ plan: { slices: [], delivery_envelope: { schema_version: 1, delivery_units: [], active: true } } }),
      /delivery_envelope\.active: is not allowed/u,
    );
  });
});

function deliveryPlan() {
  return {
    slices: [
      { id: "api", stack: "backend", paths: ["src/api/**"], depends_on: [], acceptance: ["AC1"], test_plan: ["node --test test/api.test.js"] },
      { id: "contract", stack: "backend", paths: ["test/contract/**"], depends_on: ["api"], acceptance: ["AC2"], test_plan: ["node --test test/contract.test.js"] },
    ],
    delivery_envelope: {
      schema_version: 1,
      delivery_units: [
        {
          id: "api-unit",
          slice_id: "api",
          invariant_families: [{ id: "api-behavior", description: "API behavior remains stable" }],
          obligations: [{ id: "api-response-obligation", description: "Return the specified API response", invariant_family_id: "api-behavior", verification_artifact_id: "api-tests" }],
          verification_artifacts: [{ id: "api-tests", test_plan_index: 0, test_plan_entry: "node --test test/api.test.js" }],
        },
        {
          id: "contract-unit",
          slice_id: "contract",
          invariant_families: [{ id: "contract-behavior", description: "Contract remains stable" }],
          obligations: [{ id: "contract-obligation", description: "Exercise the public contract", invariant_family_id: "contract-behavior", verification_artifact_id: "api-contract-tests" }],
          verification_artifacts: [{ id: "api-contract-tests", test_plan_index: 0, test_plan_entry: "node --test test/contract.test.js" }],
        },
      ],
    },
  };
}

function invariantFamilyLedger() {
  return {
    schema_version: 1,
    delivery_unit_id: "api-unit",
    dispositions: [{
      invariant_family_id: "api-behavior",
      verification_artifact_id: "api-tests",
      evidence_ref: "evidence/api-family.json",
      evidence_hash: HASH,
      probe: { type: "verification-artifact", verification_artifact_id: "api-tests" },
      result: { type: "verification-result", outcome: "fail", summary: "The probe exposed a known failure" },
      reviewed_commit: COMMIT,
      unresolved_findings: ["Known failure remains"],
    }],
  };
}

function failedVerificationReceipt() {
  const stream = { captured_bytes: 0, sha256: `sha256:${"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}`, truncated: false };
  return {
    schema_version: 1,
    kind: "checked-verification-artifact-execution-receipt",
    subject: "api",
    run_id: "delivery-seam-run",
    slice_id: "api",
    attempt: 1,
    claim_nonce: "123e4567-e89b-42d3-a456-426614174000",
    plan_ref: "plan/slices.json",
    plan_hash: `sha256:${"d".repeat(64)}`,
    head_sha: COMMIT,
    verification_artifact_id: "api-tests",
    probe: {
      type: "verification-artifact",
      verification_artifact_id: "api-tests",
      test_plan_index: 0,
      test_plan_entry: "node --test test/api.test.js",
      program: "node",
      args: ["--test", "test/api.test.js"],
    },
    started_at: "2026-07-19T10:00:00.000Z",
    completed_at: "2026-07-19T10:00:01.000Z",
    duration_ms: 1000,
    status: "fail",
    review_ready: false,
    commands: [{
      index: 0, program: "node", args: ["--test", "test/api.test.js"], outcome: "exited", status: "fail",
      exit_code: 1, signal: null, error_code: null, duration_ms: 1000, stdout: stream, stderr: stream,
    }],
    result: { type: "verification-result", outcome: "fail", summary: "The probe exposed a known failure" },
  };
}

function completedVerificationClaim(receiptRef, receipt) {
  return {
    schema_version: 1, kind: "checked-verification-artifact-execution-claim", state: "completed",
    nonce: receipt.claim_nonce, run_id: receipt.run_id, slice_id: receipt.slice_id, attempt: receipt.attempt,
    plan_ref: receipt.plan_ref, plan_hash: receipt.plan_hash, head_sha: receipt.head_sha,
    verification_artifact_id: receipt.verification_artifact_id, probe: receipt.probe, receipt_ref: receiptRef,
    claimed_at: "2026-07-19T09:59:59.000Z", completed_at: receipt.completed_at, status: receipt.status, receipt_hash: HASH,
  };
}
