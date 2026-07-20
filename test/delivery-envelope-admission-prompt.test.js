import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateDeliveryEnvelopeAdmission } from "../src/delivery-envelope/admission-extension.js";
import { validateSlicesPlan } from "../src/validate.js";

const PROMPT = readFileSync(new URL("../assets/agent/work-decomposer.md", import.meta.url), "utf8");

describe("work-decomposer B4 admission prompt", () => {
  it("requires complete delivery-envelope mappings in every new plan", () => {
    for (const phrase of [
      /exactly one delivery unit in slice order for every slice/iu,
      /Every declared family and artifact must be mapped by at least one obligation/iu,
      /no two obligations may duplicate the same family\/artifact mapping/iu,
      /bind its exact `test_plan_index` and `test_plan_entry`/iu,
      /Never leave mappings for a later agent to infer/iu,
    ]) assert.match(PROMPT, phrase);

    const example = JSON.parse(PROMPT.match(/```json\n([\s\S]*?)\n```/u)[1]);
    assert.equal(validateSlicesPlan(example, { requireIntegrationGate: true }), example);
    assert.deepEqual(evaluateDeliveryEnvelopeAdmission({ plan: example }), {
      schema_version: 1,
      extension: "delivery-envelope-admission",
      status: "active",
      grants_b4_authority: true,
      decision: "admit",
      reasons: ["admit:delivery-envelope-within-bounds"],
    });

    assert.equal(example.delivery_envelope.delivery_units.length, example.slices.length);
    for (const [index, unit] of example.delivery_envelope.delivery_units.entries()) {
      assert.equal(unit.slice_id, example.slices[index].id);
      assert.deepEqual(new Set(unit.obligations.map((item) => item.invariant_family_id)), new Set(unit.invariant_families.map((item) => item.id)));
      assert.deepEqual(new Set(unit.obligations.map((item) => item.verification_artifact_id)), new Set(unit.verification_artifacts.map((item) => item.id)));
      for (const artifact of unit.verification_artifacts) {
        assert.equal(artifact.test_plan_entry, example.slices[index].test_plan[artifact.test_plan_index]);
      }
    }
  });

  it("states exact deterministic checkpoint boundaries without model-authored routing authority", () => {
    assert.match(PROMPT, /routes `checkpoint` when any slice combines more than one invariant family with at least six total obligations, or when the dependency graph exceeds four waves/iu);
    assert.match(PROMPT, /otherwise it routes `admit`/iu);
    assert.match(PROMPT, /deterministic machine decision, not model-authored redesign prose/iu);
    assert.match(PROMPT, /File overlap alone is never an admission reason and must not affect the route/iu);
    assert.match(PROMPT, /Do not emit freeform admission reasons, a `decision` field/iu);
    assert.doesNotMatch(PROMPT, /## Decomposition result: REDESIGN-REQUIRED/u);
  });
});
