import { DeliveryContractValidationError, validateDeliveryEnvelope } from "./extensions.js";

export const MIXED_FAMILY_CHECKPOINT_OBLIGATIONS = 6;
export const ADMISSION_MAX_DEPENDENCY_WAVES = 4;
// Dogfood evidence: the blocked slice carried 8 acceptance rows / 16 paths,
// while its healthy sibling carried 3 / 6.
export const ADMISSION_MAX_ACCEPTANCE_ROWS_PER_SLICE = 3;
export const ADMISSION_MAX_DECLARED_PATHS_PER_SLICE = 6;

export function evaluateDeliveryEnvelopeAdmissionPolicy({ plan } = {}) {
  const slices = plan?.slices;
  const deliveryEnvelope = plan?.delivery_envelope;
  validateDeliveryEnvelope(deliveryEnvelope, slices, { required: true });
  validateCompleteMappings(deliveryEnvelope);

  const reasons = [
    ...mixedFamilyReasons(deliveryEnvelope),
    ...sliceWidthReasons(slices),
    ...dependencyDepthReasons(slices),
  ];

  return reasons.length === 0
    ? { decision: "admit", reasons: ["admit:delivery-envelope-within-bounds"] }
    : { decision: "checkpoint", reasons };
}

function validateCompleteMappings(deliveryEnvelope) {
  const errors = [];
  for (const [unitIndex, unit] of deliveryEnvelope.delivery_units.entries()) {
    const unitPath = `plan.delivery_envelope.delivery_units[${unitIndex}]`;
    const mappedFamilies = new Set();
    const mappedArtifacts = new Set();
    const mappedPairs = new Map();

    for (const [obligationIndex, obligation] of unit.obligations.entries()) {
      mappedFamilies.add(obligation.invariant_family_id);
      mappedArtifacts.add(obligation.verification_artifact_id);
      const pair = `${obligation.invariant_family_id}\u0000${obligation.verification_artifact_id}`;
      const previousIndex = mappedPairs.get(pair);
      if (previousIndex !== undefined) {
        errors.push({
          path: `${unitPath}.obligations[${obligationIndex}]`,
          message: `must not duplicate the family/artifact mapping from obligations[${previousIndex}]`,
        });
      } else {
        mappedPairs.set(pair, obligationIndex);
      }
    }

    for (const [familyIndex, family] of unit.invariant_families.entries()) {
      if (!mappedFamilies.has(family.id)) {
        errors.push({
          path: `${unitPath}.invariant_families[${familyIndex}].id`,
          message: "must be mapped by at least one obligation",
        });
      }
    }
    for (const [artifactIndex, artifact] of unit.verification_artifacts.entries()) {
      if (!mappedArtifacts.has(artifact.id)) {
        errors.push({
          path: `${unitPath}.verification_artifacts[${artifactIndex}].id`,
          message: "must be mapped by at least one obligation",
        });
      }
    }
  }
  if (errors.length > 0) throw new DeliveryContractValidationError(errors);
}

function mixedFamilyReasons(deliveryEnvelope) {
  const reasons = [];
  for (const unit of deliveryEnvelope.delivery_units) {
    const familyCount = unit.invariant_families.length;
    const obligationCount = unit.obligations.length;
    if (familyCount > 1 && obligationCount >= MIXED_FAMILY_CHECKPOINT_OBLIGATIONS) {
      reasons.push(`checkpoint:mixed-invariant-families:unit=${unit.id}:families=${familyCount}:obligations=${obligationCount}`);
    }
  }
  return reasons;
}

function sliceWidthReasons(slices) {
  const errors = [];
  const reasons = [];
  for (const [sliceIndex, slice] of slices.entries()) {
    const slicePath = `plan.slices[${sliceIndex}]`;
    if (slice === null || typeof slice !== "object" || Array.isArray(slice)) {
      errors.push({ path: slicePath, message: "must be an object" });
      continue;
    }

    let sliceId = null;
    if (typeof slice.id !== "string") {
      errors.push({ path: `${slicePath}.id`, message: "must be a string" });
    } else {
      try {
        sliceId = encodeURIComponent(slice.id);
      } catch {
        errors.push({ path: `${slicePath}.id`, message: "must be valid Unicode text" });
      }
    }

    const metrics = [
      ["acceptance-rows", "acceptance", ADMISSION_MAX_ACCEPTANCE_ROWS_PER_SLICE],
      ["declared-paths", "paths", ADMISSION_MAX_DECLARED_PATHS_PER_SLICE],
    ];
    for (const [metric, field, budget] of metrics) {
      if (!Array.isArray(slice[field])) {
        errors.push({ path: `${slicePath}.${field}`, message: "must be an array" });
      } else if (sliceId !== null && slice[field].length > budget) {
        reasons.push(`checkpoint:slice-width:slice=${sliceId}:metric=${metric}:observed=${slice[field].length}:budget=${budget}`);
      }
    }
  }
  if (errors.length > 0) throw new DeliveryContractValidationError(errors);
  return reasons;
}

function dependencyDepthReasons(slices) {
  const byId = new Map(slices.map((slice) => [slice.id, slice]));
  const memo = new Map();
  const visiting = new Set();

  const longestPath = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return null;
    visiting.add(id);
    const current = byId.get(id);
    if (!current || !Array.isArray(current.depends_on)) {
      visiting.delete(id);
      return null;
    }
    let result = { depth: 1, ids: [id] };
    for (const dependency of current.depends_on) {
      const parent = byId.has(dependency) ? longestPath(dependency) : null;
      if (parent === null) {
        visiting.delete(id);
        return null;
      }
      if (parent.depth + 1 > result.depth) result = { depth: parent.depth + 1, ids: [...parent.ids, id] };
    }
    visiting.delete(id);
    memo.set(id, result);
    return result;
  };

  const reasons = [];
  for (const slice of slices) {
    const result = longestPath(slice.id);
    if (result?.depth > ADMISSION_MAX_DEPENDENCY_WAVES) {
      reasons.push(`checkpoint:dependency-depth:waves=${result.depth}:path=${result.ids.map(encodeURIComponent).join(">")}`);
    }
  }
  return reasons;
}
