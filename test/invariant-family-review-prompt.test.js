import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PROMPT = readFileSync(new URL("../assets/agent/work-reviewer.md", import.meta.url), "utf8");

describe("B4.4 work-reviewer prompt", () => {
  it("requires a fresh complete current ledger in the existing review round", () => {
    for (const contract of [
      /emit `invariant_family_ledger` in the same slice review on every attempt/iu,
      /independently from the current accepted plan and current observed evidence/iu,
      /exactly one disposition for every invariant family.*no other family/isu,
      /never copy a prior ledger as a delta, omit an unchanged family, or rely on prior pass results/iu,
      /never request an extra reviewer round/iu,
    ]) assert.match(PROMPT, contract);
  });

  it("binds every closed disposition field to current evidence, artifact, result, and commit", () => {
    for (const contract of [
      /verification artifact linked to that family by a current obligation/iu,
      /executes that artifact's exact current `test_plan_entry`/iu,
      /exact observed `evidence_ref` and SHA-256 `evidence_hash`/iu,
      /probe `\{type:"verification-artifact",verification_artifact_id\}` for that same artifact/iu,
      /typed result `\{type:"verification-result",outcome,summary\}`/iu,
      /repeats the enclosing review's exact `reviewed_commit`/iu,
      /complete current `unresolved_findings` list/iu,
    ]) assert.match(PROMPT, contract);
  });

  it("states exact APPROVE and REJECT authority policy without admission or checkpoint policy", () => {
    assert.match(PROMPT, /APPROVE requires every current family disposition to have `outcome:"pass"` and zero unresolved findings/iu);
    assert.match(PROMPT, /REJECT ledger remains complete.*REJECT never grants review authority/isu);
    assert.match(PROMPT, /Missing, duplicate, stale, unknown, wrong-artifact, or extra family dispositions are invalid/iu);
    assert.match(PROMPT, /do not make admission or checkpoint decisions/iu);
  });

  it("emits a closed machine-readable slice review with the complete ledger schema", () => {
    const blocks = [...PROMPT.matchAll(/```json\n([\s\S]*?)\n```/gu)];
    assert.equal(blocks.length, 1);
    const output = JSON.parse(blocks[0][1]);
    assert.deepEqual(Object.keys(output), [
      "subject",
      "attempt",
      "reviewed_commit",
      "verdict",
      "convergence",
      "remaining_fix_count",
      "required_fixes",
      "ownership_ratification",
      "remediation_context",
      "invariant_family_ledger",
    ]);
    assert.deepEqual(Object.keys(output.invariant_family_ledger), ["schema_version", "delivery_unit_id", "dispositions"]);
    assert.deepEqual(Object.keys(output.invariant_family_ledger.dispositions[0]), [
      "invariant_family_id",
      "verification_artifact_id",
      "evidence_ref",
      "evidence_hash",
      "probe",
      "result",
      "reviewed_commit",
      "unresolved_findings",
    ]);
    assert.deepEqual(Object.keys(output.invariant_family_ledger.dispositions[0].probe), ["type", "verification_artifact_id"]);
    assert.deepEqual(Object.keys(output.invariant_family_ledger.dispositions[0].result), ["type", "outcome", "summary"]);
    assert.equal(output.invariant_family_ledger.dispositions[0].result.outcome, "pass");
    assert.deepEqual(output.invariant_family_ledger.dispositions[0].unresolved_findings, []);
    assert.match(PROMPT, /object is closed to the keys shown below/iu);
    assert.match(PROMPT, /Every nested ledger object is also closed to the displayed keys/iu);
  });
});
