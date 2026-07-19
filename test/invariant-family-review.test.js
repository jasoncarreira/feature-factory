import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DeliveryContractValidationError } from "../src/delivery-envelope/extensions.js";
import { evaluateInvariantFamilyReview } from "../src/delivery-envelope/review-extension.js";

const COMMIT = "b".repeat(40);
const HASHES = Object.freeze({
  "evidence/api.artifact-api-tests.attempt-1.json": `sha256:${"a".repeat(64)}`,
  "evidence/api.artifact-api-security-tests.attempt-1.json": `sha256:${"c".repeat(64)}`,
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
      outcome: "fail",
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
        observeEvidence: (ref, disposition) => ({ ...currentEvidence(ref, disposition), hash: `sha256:${"f".repeat(64)}` }),
      }),
      /evidence hash is stale for 'evidence\/api\.artifact-api-tests\.attempt-1\.json'/u,
    );
    assert.throws(
      () => evaluateInvariantFamilyReview({
        plan: deliveryPlan(),
        sliceId: "api",
        review: sliceReview(),
        observeEvidence: (ref, disposition) => ({ ...currentEvidence(ref, disposition), ref: `evidence/not-${ref.slice("evidence/".length)}` }),
      }),
      /evidence ref is not current for 'evidence\/api\.artifact-api-tests\.attempt-1\.json'/u,
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

  it("rejects arbitrary, stale, cross-bound, wrong-command, and claimed-pass receipt evidence", () => {
    const cases = [
      ["arbitrary bytes", (observed) => { delete observed.receipt; }, /completed checked execution claim and receipt/u],
      ["missing claim", (observed) => { delete observed.claim; }, /completed checked execution claim and receipt/u],
      ["active claim", (observed) => { observed.claim.state = "active"; delete observed.claim.completed_at; delete observed.claim.status; delete observed.claim.receipt_hash; }, /exact completed authority/u],
      ["wrong claim nonce", (observed) => { observed.claim.nonce = "123e4567-e89b-42d3-a456-426614174001"; }, /exact completed authority/u],
      ["wrong subject", (observed) => { observed.receipt.subject = observed.receipt.slice_id = "other"; }, /subject\/slice is stale/u],
      ["wrong attempt", (observed) => { observed.receipt.attempt = 2; }, /attempt is stale/u],
      ["wrong head", (observed) => { observed.receipt.head_sha = "d".repeat(40); }, /reviewed HEAD is stale/u],
      ["wrong artifact", (observed) => { observed.receipt.verification_artifact_id = observed.receipt.probe.verification_artifact_id = "api-security-tests"; }, /artifact id is stale|completed checked execution claim/u],
      ["wrong argv", (observed) => { observed.receipt.probe.args = ["--test", "test/other.test.js"]; }, /exact current verification artifact command/u],
      ["claimed pass", (observed) => {
        observed.receipt.status = "fail";
        observed.receipt.review_ready = false;
        observed.receipt.commands[0].status = "fail";
        observed.receipt.commands[0].exit_code = 1;
        observed.receipt.result = { type: "verification-result", outcome: "fail", summary: "Observed failure" };
      }, /claimed result does not match/u],
    ];
    for (const [name, mutate, expected] of cases) {
      assert.throws(() => evaluateInvariantFamilyReview({
        plan: deliveryPlan(),
        sliceId: "api",
        review: sliceReview(),
        observeEvidence(ref, disposition) {
          const observed = currentEvidence(ref, disposition);
          mutate(observed);
          return observed;
        },
      }), expected, name);
    }
  });
});

function currentEvidence(ref, disposition) {
  const artifact = deliveryPlan().delivery_envelope.delivery_units[0].verification_artifacts
    .find((candidate) => candidate.id === disposition.verification_artifact_id);
  const [program, ...args] = artifact.test_plan_entry.split(" ");
  const receipt = verificationReceipt({ disposition, artifact, program, args });
  return { ref, hash: HASHES[ref], receipt, claim: verificationClaim(ref, HASHES[ref], receipt) };
}

function verificationClaim(receiptRef, receiptHash, receipt) {
  return {
    schema_version: 1, kind: "checked-verification-artifact-execution-claim", state: "completed",
    nonce: receipt.claim_nonce, run_id: receipt.run_id, slice_id: receipt.slice_id, attempt: receipt.attempt,
    plan_ref: receipt.plan_ref, plan_hash: receipt.plan_hash, head_sha: receipt.head_sha,
    verification_artifact_id: receipt.verification_artifact_id, probe: receipt.probe, receipt_ref: receiptRef,
    claimed_at: "2026-07-16T11:59:59.000Z", completed_at: receipt.completed_at, status: receipt.status, receipt_hash: receiptHash,
  };
}

function verificationReceipt({ disposition, artifact, program, args }) {
  const outcome = disposition.result.outcome;
  return {
    schema_version: 1,
    kind: "checked-verification-artifact-execution-receipt",
    subject: "api",
    run_id: "review-run",
    slice_id: "api",
    attempt: 1,
    claim_nonce: "123e4567-e89b-42d3-a456-426614174000",
    plan_ref: "plan/slices.json",
    plan_hash: `sha256:${"e".repeat(64)}`,
    head_sha: COMMIT,
    verification_artifact_id: artifact.id,
    probe: {
      type: "verification-artifact",
      verification_artifact_id: artifact.id,
      test_plan_index: artifact.test_plan_index,
      test_plan_entry: artifact.test_plan_entry,
      program,
      args,
    },
    started_at: "2026-07-19T10:00:00.000Z",
    completed_at: "2026-07-19T10:00:01.000Z",
    duration_ms: 1000,
    status: outcome,
    review_ready: outcome === "pass",
    commands: outcome === "skipped" ? [] : [{
      index: 0, program, args, outcome: "exited", status: outcome, exit_code: outcome === "pass" ? 0 : 1, signal: null, error_code: null, duration_ms: 1000,
      stdout: emptyStream(), stderr: emptyStream(),
    }],
    result: structuredClone(disposition.result),
  };
}

function emptyStream() {
  return { captured_bytes: 0, sha256: `sha256:${"0".repeat(64)}`, truncated: false };
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
        disposition("api-behavior", "api-tests", "evidence/api.artifact-api-tests.attempt-1.json", "API behavior tests passed"),
        disposition("api-security", "api-security-tests", "evidence/api.artifact-api-security-tests.attempt-1.json", "API security tests passed"),
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
