import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateDeliveryEnvelopeAdmission } from "../src/delivery-envelope/admission-extension.js";
import {
  ADMISSION_MAX_ACCEPTANCE_ROWS_PER_SLICE,
  ADMISSION_MAX_DECLARED_PATHS_PER_SLICE,
  ADMISSION_MAX_DEPENDENCY_WAVES,
  MIXED_FAMILY_CHECKPOINT_OBLIGATIONS,
} from "../src/delivery-envelope/admission-policy.js";
import { evaluateInvariantFamilyReview } from "../src/delivery-envelope/review-extension.js";
import { DeliveryContractValidationError } from "../src/delivery-envelope/extensions.js";
import { ValidationError, validateSlicesPlan } from "../src/validate.js";

describe("B4 delivery-envelope admission", () => {
  it("rejects missing current gates and delivery envelopes outright", () => {
    assert.throws(
      () => evaluateDeliveryEnvelopeAdmission({ plan: { slices: [slice("missing-gate")] } }),
      (error) => error instanceof DeliveryContractValidationError
        && error.message === "plan.integration_gate: is required",
    );
    assert.throws(
      () => evaluateDeliveryEnvelopeAdmission({ plan: { integration_gate: integrationGate(), slices: [slice("new-slice")] } }),
      (error) => error instanceof DeliveryContractValidationError
        && error.message === "plan.delivery_envelope: is required",
    );
  });

  it("admits only below both deterministic checkpoint thresholds", () => {
    assert.equal(MIXED_FAMILY_CHECKPOINT_OBLIGATIONS, 6);
    assert.equal(ADMISSION_MAX_DEPENDENCY_WAVES, 4);
    const cases = [
      { name: "one family at six obligations", families: 1, obligations: 6, decision: "admit", grants: true },
      { name: "two families below six obligations", families: 2, obligations: 5, decision: "admit", grants: true },
      { name: "two families at six obligations", families: 2, obligations: 6, decision: "checkpoint", grants: false },
      { name: "three families above six obligations", families: 3, obligations: 7, decision: "checkpoint", grants: false },
    ];

    for (const entry of cases) {
      const plan = planWithUnits([unitSpec("api", entry.families, entry.obligations)]);
      const result = evaluateDeliveryEnvelopeAdmission({ plan });
      assert.equal(result.decision, entry.decision, entry.name);
      assert.equal(result.grants_b4_authority, entry.grants, entry.name);
      assert.deepEqual(result.reasons, entry.decision === "admit"
        ? ["admit:delivery-envelope-within-bounds"]
        : [`checkpoint:mixed-invariant-families:unit=api-unit:families=${entry.families}:obligations=${entry.obligations}`], entry.name);
    }
  });

  it("checkpoints per-slice mass that exceeds acceptance-row or declared-path budgets", () => {
    assert.equal(ADMISSION_MAX_ACCEPTANCE_ROWS_PER_SLICE, 3);
    assert.equal(ADMISSION_MAX_DECLARED_PATHS_PER_SLICE, 6);
    const cases = [
      { name: "both metrics at budget", acceptanceRows: 3, declaredPaths: 6, reasons: [] },
      { name: "acceptance rows over budget", acceptanceRows: 4, declaredPaths: 6, reasons: [
        "checkpoint:slice-width:slice=api:metric=acceptance-rows:observed=4:budget=3",
      ] },
      { name: "declared paths over budget", acceptanceRows: 3, declaredPaths: 7, reasons: [
        "checkpoint:slice-width:slice=api:metric=declared-paths:observed=7:budget=6",
      ] },
      { name: "packed incident shape", acceptanceRows: 8, declaredPaths: 16, reasons: [
        "checkpoint:slice-width:slice=api:metric=acceptance-rows:observed=8:budget=3",
        "checkpoint:slice-width:slice=api:metric=declared-paths:observed=16:budget=6",
      ] },
    ];

    for (const entry of cases) {
      const plan = planWithUnits([unitSpec("api", 1, 1)]);
      setSliceWidth(plan.slices[0], entry);
      const result = evaluateDeliveryEnvelopeAdmission({ plan });
      const decision = entry.reasons.length === 0 ? "admit" : "checkpoint";
      assert.deepEqual(result, activeAdmission(decision, entry.reasons.length === 0
        ? ["admit:delivery-envelope-within-bounds"]
        : entry.reasons), entry.name);
    }
  });

  it("fails closed with structured errors for malformed width inputs", () => {
    const cases = [
      {
        name: "missing acceptance array",
        mutate(plan) { delete plan.slices[0].acceptance; },
        path: "plan.slices[0].acceptance",
        message: "must be an array",
      },
      {
        name: "null paths array",
        mutate(plan) { plan.slices[0].paths = null; },
        path: "plan.slices[0].paths",
        message: "must be an array",
      },
      {
        name: "lone-surrogate slice id",
        mutate(plan) {
          plan.slices[0].id = "api\ud800";
          plan.delivery_envelope.delivery_units[0].slice_id = "api\ud800";
        },
        path: "plan.slices[0].id",
        message: "must be valid Unicode text",
      },
    ];
    const entries = [
      ["direct admission", DeliveryContractValidationError, (plan) => evaluateDeliveryEnvelopeAdmission({ plan })],
      ["plan validation", ValidationError, (plan) => validateSlicesPlan(plan, { requireIntegrationGate: true })],
    ];

    for (const entry of cases) {
      for (const [pathName, ErrorType, validate] of entries) {
        const plan = planWithUnits([unitSpec("api")]);
        entry.mutate(plan);
        assert.throws(
          () => validate(plan),
          (error) => error instanceof ErrorType
            && error.errors.some(({ path, message }) => path === entry.path && message === entry.message),
          `${entry.name} through ${pathName}`,
        );
      }
    }
  });

  it("routes dependency depth after four waves and reports every affected path in stable order", () => {
    const fourWaves = chainPlan(4);
    assert.deepEqual(evaluateDeliveryEnvelopeAdmission({ plan: fourWaves }), activeAdmission("admit", [
      "admit:delivery-envelope-within-bounds",
    ]));

    const fiveWaves = chainPlan(5);
    assert.equal(validateSlicesPlan(fiveWaves, { enforceDependencyDepth: false, requireIntegrationGate: true }), fiveWaves);
    assert.deepEqual(evaluateDeliveryEnvelopeAdmission({ plan: fiveWaves }), activeAdmission("checkpoint", [
      "checkpoint:dependency-depth:waves=5:path=wave-1>wave-2>wave-3>wave-4>wave-5",
    ]));

    assert.deepEqual(evaluateDeliveryEnvelopeAdmission({ plan: chainPlan(6) }), activeAdmission("checkpoint", [
      "checkpoint:dependency-depth:waves=5:path=wave-1>wave-2>wave-3>wave-4>wave-5",
      "checkpoint:dependency-depth:waves=6:path=wave-1>wave-2>wave-3>wave-4>wave-5>wave-6",
    ]));
  });

  it("orders mixed-family unit reasons before dependency-depth reasons", () => {
    const plan = chainPlan(5);
    replaceUnitShape(plan, 0, 2, 6);
    replaceUnitShape(plan, 2, 2, 6);

    assert.deepEqual(evaluateDeliveryEnvelopeAdmission({ plan }).reasons, [
      "checkpoint:mixed-invariant-families:unit=wave-1-unit:families=2:obligations=6",
      "checkpoint:mixed-invariant-families:unit=wave-3-unit:families=2:obligations=6",
      "checkpoint:dependency-depth:waves=5:path=wave-1>wave-2>wave-3>wave-4>wave-5",
    ]);
  });

  it("fails closed for missing, duplicate, unknown, orphaned, and duplicate mappings", () => {
    const mutations = [
      ["missing family mapping", (plan) => { delete plan.delivery_envelope.delivery_units[0].obligations[0].invariant_family_id; }, /obligations\[0\]\.invariant_family_id/u],
      ["duplicate family id", (plan) => { plan.delivery_envelope.delivery_units[0].invariant_families.push({ ...plan.delivery_envelope.delivery_units[0].invariant_families[0] }); }, /invariant family id must be globally unique/u],
      ["duplicate artifact id", (plan) => { plan.delivery_envelope.delivery_units[0].verification_artifacts.push({ ...plan.delivery_envelope.delivery_units[0].verification_artifacts[0], test_plan_index: 1, test_plan_entry: "test api artifact 2" }); }, /verification artifact id must be globally unique/u],
      ["duplicate obligation id", (plan) => { plan.delivery_envelope.delivery_units[0].obligations[1].id = plan.delivery_envelope.delivery_units[0].obligations[0].id; }, /obligation id must be globally unique/u],
      ["unknown family", (plan) => { plan.delivery_envelope.delivery_units[0].obligations[0].invariant_family_id = "unknown-family"; }, /must reference exactly one invariant family/u],
      ["unknown artifact", (plan) => { plan.delivery_envelope.delivery_units[0].obligations[0].verification_artifact_id = "unknown-artifact"; }, /must reference exactly one known verification artifact/u],
      ["orphan family", (plan) => { plan.delivery_envelope.delivery_units[0].invariant_families.push({ id: "orphan-family", description: "Unmapped family" }); }, /invariant_families\[1\]\.id: must be mapped by at least one obligation/u],
      ["orphan artifact", (plan) => { plan.slices[0].test_plan.push("test api orphan"); plan.delivery_envelope.delivery_units[0].verification_artifacts.push({ id: "orphan-artifact", test_plan_index: 2, test_plan_entry: "test api orphan" }); }, /verification_artifacts\[2\]\.id: must be mapped by at least one obligation/u],
      ["duplicate pair", (plan) => { plan.delivery_envelope.delivery_units[0].obligations[1].invariant_family_id = "api-family-1"; plan.delivery_envelope.delivery_units[0].obligations[1].verification_artifact_id = "api-artifact-1"; }, /obligations\[1\]: must not duplicate the family\/artifact mapping from obligations\[0\]/u],
    ];

    for (const [name, mutate, expected] of mutations) {
      const plan = planWithUnits([unitSpec("api", 1, 2)]);
      mutate(plan);
      assert.throws(() => evaluateDeliveryEnvelopeAdmission({ plan }), expected, name);
    }
  });

  it("does not use file overlap or the inactive review extension as admission authority", () => {
    const disjoint = planWithUnits([unitSpec("api"), unitSpec("worker")]);
    const overlap = structuredClone(disjoint);
    overlap.slices[1].paths = [...overlap.slices[0].paths];
    assert.deepEqual(evaluateDeliveryEnvelopeAdmission({ plan: overlap }), evaluateDeliveryEnvelopeAdmission({ plan: disjoint }));

    const reviewExtension = evaluateInvariantFamilyReview({ plan: overlap, sliceId: "api", review: {} });
    assert.deepEqual(reviewExtension, {
      schema_version: 1,
      extension: "invariant-family-review",
      status: "inactive",
      grants_b4_authority: false,
      reason: "b4-review-policy-inactive",
    });
    assert.deepEqual(
      evaluateDeliveryEnvelopeAdmission({ plan: overlap, reviewExtension }),
      evaluateDeliveryEnvelopeAdmission({ plan: overlap }),
    );
  });
});

function planWithUnits(specs) {
  const slices = specs.map((spec) => slice(spec.id, spec.dependsOn, spec.obligations));
  const plan = {
    slices,
    delivery_envelope: {
      schema_version: 1,
      delivery_units: specs.map((spec, index) => deliveryUnit(spec, slices[index])),
    },
  };
  plan.integration_gate = integrationGate();
  return plan;
}

function chainPlan(waves) {
  return planWithUnits(Array.from({ length: waves }, (_, index) => unitSpec(
    `wave-${index + 1}`,
    1,
    1,
    index === 0 ? [] : [`wave-${index}`],
  )));
}

function unitSpec(id, families = 1, obligations = 1, dependsOn = []) {
  return { id, families, obligations, dependsOn };
}

function slice(id, dependsOn = [], testCount = 1) {
  return {
    id,
    stack: "backend",
    paths: [`src/${id}.js`],
    depends_on: [...dependsOn],
    acceptance: [`accept ${id}`],
    test_plan: Array.from({ length: testCount }, (_, index) => `test ${id} artifact ${index + 1}`),
  };
}

function deliveryUnit(spec, plannedSlice) {
  return {
    id: `${spec.id}-unit`,
    slice_id: spec.id,
    invariant_families: Array.from({ length: spec.families }, (_, index) => ({
      id: `${spec.id}-family-${index + 1}`,
      description: `${spec.id} invariant family ${index + 1}`,
    })),
    obligations: Array.from({ length: spec.obligations }, (_, index) => ({
      id: `${spec.id}-obligation-${index + 1}`,
      description: `${spec.id} obligation ${index + 1}`,
      invariant_family_id: `${spec.id}-family-${(index % spec.families) + 1}`,
      verification_artifact_id: `${spec.id}-artifact-${index + 1}`,
    })),
    verification_artifacts: plannedSlice.test_plan.map((entry, index) => ({
      id: `${spec.id}-artifact-${index + 1}`,
      test_plan_index: index,
      test_plan_entry: entry,
      timeout_ms: 600_000,
    })),
  };
}

function replaceUnitShape(plan, index, families, obligations) {
  const id = plan.slices[index].id;
  plan.slices[index] = slice(id, plan.slices[index].depends_on, obligations);
  plan.delivery_envelope.delivery_units[index] = deliveryUnit(unitSpec(id, families, obligations), plan.slices[index]);
}

function setSliceWidth(plannedSlice, { acceptanceRows, declaredPaths }) {
  plannedSlice.acceptance = Array.from({ length: acceptanceRows }, (_, index) => `accept behavior ${index + 1}`);
  plannedSlice.paths = Array.from({ length: declaredPaths }, (_, index) => `src/path-${index + 1}.js`);
}

function integrationGate() {
  return { required_commands: [{ program: "npm", args: ["run", "check"] }], timeout_ms: 600_000 };
}

function activeAdmission(decision, reasons) {
  return {
    schema_version: 1,
    extension: "delivery-envelope-admission",
    status: "active",
    grants_b4_authority: decision === "admit",
    decision,
    reasons,
  };
}
