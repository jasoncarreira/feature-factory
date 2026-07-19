export function withDeliveryEnvelope(plan) {
  const current = structuredClone(plan);
  current.delivery_envelope = deliveryEnvelopeForSlices(current.slices);
  return current;
}

export function deliveryEnvelopeForSlices(slices) {
  return {
    schema_version: 1,
    delivery_units: slices.map((slice, index) => {
      const ordinal = index + 1;
      const familyId = `fixture-family-${ordinal}`;
      const artifactId = `fixture-artifact-${ordinal}`;
      return {
        id: `fixture-unit-${ordinal}`,
        slice_id: slice.id,
        invariant_families: [{ id: familyId, description: `Verify ${slice.id} behavior` }],
        obligations: [{
          id: `fixture-obligation-${ordinal}`,
          description: `Prove ${slice.id} behavior`,
          invariant_family_id: familyId,
          verification_artifact_id: artifactId,
        }],
        verification_artifacts: [{
          id: artifactId,
          test_plan_index: 0,
          test_plan_entry: slice.test_plan[0],
        }],
      };
    }),
  };
}

export function passingInvariantFamilyLedger({ plan, sliceId, reviewedCommit, evidenceRef, evidenceHash }) {
  const unit = plan.delivery_envelope.delivery_units.find((candidate) => candidate.slice_id === sliceId);
  if (!unit) throw new Error(`delivery envelope fixture has no unit for slice '${sliceId}'`);
  return {
    schema_version: 1,
    delivery_unit_id: unit.id,
    dispositions: unit.invariant_families.map((family) => {
      const obligation = unit.obligations.find((candidate) => candidate.invariant_family_id === family.id);
      return {
        invariant_family_id: family.id,
        verification_artifact_id: obligation.verification_artifact_id,
        evidence_ref: evidenceRef,
        evidence_hash: evidenceHash,
        probe: { type: "verification-artifact", verification_artifact_id: obligation.verification_artifact_id },
        result: { type: "verification-result", outcome: "pass", summary: `${family.description} passed` },
        reviewed_commit: reviewedCommit,
        unresolved_findings: [],
      };
    }),
  };
}
