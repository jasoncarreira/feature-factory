import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DeliveryContractValidationError } from "../src/delivery-envelope/extensions.js";
import { evaluateInvariantFamilyReview } from "../src/delivery-envelope/review-extension.js";

const COMMIT = "b".repeat(40);
const HASHES = Object.freeze({
  "evidence/api-behavior.json": `sha256:${"a".repeat(64)}`,
  "evidence/api-security.json": `sha256:${"c".repeat(64)}`,
});

describe("B4.4 invariant-family review authority", () => {
  it("grants active review authority only for one current passing disposition per family", () => {
    const result = evaluateInvariantFamilyReview({
      plan: deliveryPlan(),
      sliceId: "api",
      review: sliceReview(),
      observeEvidence: currentEvidence,
    });

    assert.deepEqual(result, {
      schema_version: 1,
      extension: "invariant-family-review",
      status: "active",
      grants_b4_authority: true,
      decision: "approve",
      reasons: ["all-invariant-families-current"],
    });
  });

  it("fails closed for an absent ledger or an unobserved evidence boundary", () => {
    const plan = deliveryPlan();
    const absent = sliceReview();
    delete absent.invariant_family_ledger;

    assert.deepEqual(evaluateInvariantFamilyReview({ plan, sliceId: "api", review: absent, observeEvidence: currentEvidence }), {
      schema_version: 1,
      extension: "invariant-family-review",
      status: "active",
      grants_b4_authority: false,
      decision: "reject",
      reasons: ["invariant-family-ledger-required"],
    });
    assert.deepEqual(evaluateInvariantFamilyReview({ plan, sliceId: "api", review: sliceReview() }), {
      schema_version: 1,
      extension: "invariant-family-review",
      status: "active",
      grants_b4_authority: false,
      decision: "reject",
      reasons: ["current-evidence-observer-required"],
    });
  });

  it("rejects incomplete current coverage and exposes every missing family deterministically", () => {
    const review = sliceReview();
    review.invariant_family_ledger.dispositions = review.invariant_family_ledger.dispositions.slice(0, 1);

    assert.deepEqual(evaluateInvariantFamilyReview({
      plan: deliveryPlan(),
      sliceId: "api",
      review,
      observeEvidence: currentEvidence,
    }), {
      schema_version: 1,
      extension: "invariant-family-review",
      status: "active",
      grants_b4_authority: false,
      decision: "reject",
      reasons: ["invariant-family-disposition-missing:api-security"],
    });
  });

  it("requires pass and zero unresolved findings for APPROVE", () => {
    const review = sliceReview();
    review.invariant_family_ledger.dispositions[0].result = {
      type: "verification-result",
      outcome: "fail",
      summary: "API behavior regressed",
    };
    review.invariant_family_ledger.dispositions[0].unresolved_findings = ["Response contract differs"];

    assert.deepEqual(evaluateInvariantFamilyReview({
      plan: deliveryPlan(),
      sliceId: "api",
      review,
      observeEvidence: currentEvidence,
    }).reasons, [
      "invariant-family-result-not-pass:api-behavior",
      "invariant-family-unresolved-findings:api-behavior",
    ]);
  });

  it("allows REJECT to retain explicit failures but never grant review authority", () => {
    const review = sliceReview();
    review.verdict = "REJECT";
    review.invariant_family_ledger.dispositions[1].result = {
      type: "verification-result",
      outcome: "skipped",
      summary: "Security probe could not complete",
    };
    review.invariant_family_ledger.dispositions[1].unresolved_findings = ["Security probe remains unresolved"];

    assert.deepEqual(evaluateInvariantFamilyReview({
      plan: deliveryPlan(),
      sliceId: "api",
      review,
      observeEvidence: currentEvidence,
    }), {
      schema_version: 1,
      extension: "invariant-family-review",
      status: "active",
      grants_b4_authority: false,
      decision: "reject",
      reasons: [
        "review-verdict-reject",
        "invariant-family-result-not-pass:api-security",
        "invariant-family-unresolved-findings:api-security",
      ],
    });
  });

  it("rejects duplicate, unknown/extra, and wrong-artifact family dispositions", () => {
    for (const [name, mutate, expected] of [
      ["duplicate", (review) => review.invariant_family_ledger.dispositions.push(structuredClone(review.invariant_family_ledger.dispositions[0])), /at most one disposition per invariant family/u],
      ["unknown/extra", (review) => { review.invariant_family_ledger.dispositions[0].invariant_family_id = "unknown-family"; }, /must reference an invariant family in the ledger delivery unit/u],
      ["wrong artifact", (review) => {
        review.invariant_family_ledger.dispositions[0].verification_artifact_id = "api-security-tests";
        review.invariant_family_ledger.dispositions[0].probe.verification_artifact_id = "api-security-tests";
      }, /family and artifact must be linked by an obligation/u],
    ]) {
      const review = sliceReview();
      mutate(review);
      assert.throws(
        () => evaluateInvariantFamilyReview({ plan: deliveryPlan(), sliceId: "api", review, observeEvidence: currentEvidence }),
        (error) => error instanceof DeliveryContractValidationError && expected.test(error.message),
        name,
      );
    }
  });

  it("rejects stale hashes and mismatched observed evidence refs", () => {
    const stale = sliceReview();
    assert.throws(
      () => evaluateInvariantFamilyReview({
        plan: deliveryPlan(),
        sliceId: "api",
        review: stale,
        observeEvidence: (ref) => ({ ref, hash: `sha256:${"f".repeat(64)}` }),
      }),
      /evidence hash is stale for 'evidence\/api-behavior\.json'/u,
    );
    assert.throws(
      () => evaluateInvariantFamilyReview({
        plan: deliveryPlan(),
        sliceId: "api",
        review: sliceReview(),
        observeEvidence: (ref) => ({ ref: `evidence/not-${ref.slice("evidence/".length)}`, hash: HASHES[ref] }),
      }),
      /evidence ref is not current for 'evidence\/api-behavior\.json'/u,
    );
  });

  it("binds exact artifact probes, typed results, and the enclosing reviewed commit", () => {
    for (const [name, mutate, expected] of [
      ["probe artifact", (review) => { review.invariant_family_ledger.dispositions[0].probe.verification_artifact_id = "api-security-tests"; }, /probe\.verification_artifact_id.*must equal the disposition/u],
      ["probe type", (review) => { review.invariant_family_ledger.dispositions[0].probe.type = "command"; }, /probe\.type.*must equal verification-artifact/u],
      ["result type", (review) => { review.invariant_family_ledger.dispositions[0].result.type = "boolean"; }, /result\.type.*must equal verification-result/u],
      ["reviewed commit", (review) => { review.invariant_family_ledger.dispositions[0].reviewed_commit = "d".repeat(40); }, /reviewed_commit.*must equal the enclosing review reviewed_commit/u],
    ]) {
      const review = sliceReview();
      mutate(review);
      assert.throws(
        () => evaluateInvariantFamilyReview({ plan: deliveryPlan(), sliceId: "api", review, observeEvidence: currentEvidence }),
        expected,
        name,
      );
    }
  });

  it("requires every later review to restate the complete current ledger", () => {
    const nextPlan = deliveryPlan();
    nextPlan.slices[0].test_plan.push("node --test test/api-compatibility.test.js");
    nextPlan.delivery_envelope.delivery_units[0].invariant_families.push({ id: "api-compatibility", description: "Compatibility remains stable" });
    nextPlan.delivery_envelope.delivery_units[0].verification_artifacts.push({
      id: "api-compatibility-tests",
      test_plan_index: 2,
      test_plan_entry: "node --test test/api-compatibility.test.js",
    });
    nextPlan.delivery_envelope.delivery_units[0].obligations.push({
      id: "api-compatibility-obligation",
      description: "Verify compatibility",
      invariant_family_id: "api-compatibility",
      verification_artifact_id: "api-compatibility-tests",
    });

    assert.deepEqual(evaluateInvariantFamilyReview({
      plan: nextPlan,
      sliceId: "api",
      review: sliceReview(),
      observeEvidence: currentEvidence,
    }).reasons, ["invariant-family-disposition-missing:api-compatibility"]);
  });
});

function currentEvidence(ref) {
  return { ref, hash: HASHES[ref] };
}

function deliveryPlan() {
  return {
    slices: [{
      id: "api",
      stack: "backend",
      paths: ["src/api/**"],
      depends_on: [],
      acceptance: ["API behavior and security remain correct"],
      test_plan: ["node --test test/api.test.js", "node --test test/api-security.test.js"],
    }],
    delivery_envelope: {
      schema_version: 1,
      delivery_units: [{
        id: "api-unit",
        slice_id: "api",
        invariant_families: [
          { id: "api-behavior", description: "API behavior remains stable" },
          { id: "api-security", description: "API security remains stable" },
        ],
        obligations: [
          { id: "api-behavior-obligation", description: "Verify API behavior", invariant_family_id: "api-behavior", verification_artifact_id: "api-tests" },
          { id: "api-security-obligation", description: "Verify API security", invariant_family_id: "api-security", verification_artifact_id: "api-security-tests" },
        ],
        verification_artifacts: [
          { id: "api-tests", test_plan_index: 0, test_plan_entry: "node --test test/api.test.js" },
          { id: "api-security-tests", test_plan_index: 1, test_plan_entry: "node --test test/api-security.test.js" },
        ],
      }],
    },
  };
}

function sliceReview() {
  return {
    subject: "api",
    attempt: 1,
    reviewed_commit: COMMIT,
    verdict: "APPROVE",
    invariant_family_ledger: {
      schema_version: 1,
      delivery_unit_id: "api-unit",
      dispositions: [
        disposition("api-behavior", "api-tests", "evidence/api-behavior.json", "API behavior tests passed"),
        disposition("api-security", "api-security-tests", "evidence/api-security.json", "API security tests passed"),
      ],
    },
  };
}

function disposition(familyId, artifactId, evidenceRef, summary) {
  return {
    invariant_family_id: familyId,
    verification_artifact_id: artifactId,
    evidence_ref: evidenceRef,
    evidence_hash: HASHES[evidenceRef],
    probe: { type: "verification-artifact", verification_artifact_id: artifactId },
    result: { type: "verification-result", outcome: "pass", summary },
    reviewed_commit: COMMIT,
    unresolved_findings: [],
  };
}
