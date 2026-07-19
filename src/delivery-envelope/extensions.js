const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

const DELIVERY_ENVELOPE_KEYS = new Set(["schema_version", "delivery_units"]);
const DELIVERY_UNIT_KEYS = new Set(["id", "slice_id", "invariant_families", "obligations", "verification_artifacts"]);
const INVARIANT_FAMILY_KEYS = new Set(["id", "description"]);
const OBLIGATION_KEYS = new Set(["id", "description", "invariant_family_id", "verification_artifact_id"]);
const VERIFICATION_ARTIFACT_KEYS = new Set(["id", "test_plan_index", "test_plan_entry"]);
const INVARIANT_FAMILY_LEDGER_KEYS = new Set(["schema_version", "delivery_unit_id", "dispositions"]);
const DISPOSITION_KEYS = new Set(["invariant_family_id", "verification_artifact_id", "evidence_ref", "evidence_hash", "probe", "result", "reviewed_commit", "unresolved_findings"]);
const PROBE_KEYS = new Set(["type", "verification_artifact_id"]);
const RESULT_KEYS = new Set(["type", "outcome", "summary"]);
const REVIEW_OUTCOMES = new Set(["pass", "fail", "skipped"]);

const ADMISSION_RESULT_KEYS = new Set(["schema_version", "extension", "status", "grants_b4_authority", "reason"]);
const REVIEW_RESULT_KEYS = new Set(["schema_version", "extension", "status", "grants_b4_authority", "reason"]);
const ACTIVE_RESULT_KEYS = new Set(["schema_version", "extension", "status", "grants_b4_authority", "decision", "reasons"]);

export class DeliveryContractValidationError extends Error {
  constructor(errors) {
    super(errors.map(({ path, message }) => `${path}: ${message}`).join("; "));
    this.name = "DeliveryContractValidationError";
    this.errors = errors;
  }
}

export function validateDeliveryEnvelope(deliveryEnvelope, slices, { path = "plan.delivery_envelope", required = false } = {}) {
  if (deliveryEnvelope === undefined || deliveryEnvelope === null) {
    if (required) throwValidation([{ path, message: "is required" }]);
    return null;
  }
  const errors = [];
  if (!isRecord(deliveryEnvelope)) throwValidation([{ path, message: "must be an object" }]);
  allowedKeys(errors, deliveryEnvelope, DELIVERY_ENVELOPE_KEYS, path);
  exactSchemaVersion(errors, deliveryEnvelope.schema_version, `${path}.schema_version`);
  if (!Array.isArray(slices)) errors.push({ path: "plan.slices", message: "must be an array before delivery_envelope can be validated" });
  if (!Array.isArray(deliveryEnvelope.delivery_units)) {
    errors.push({ path: `${path}.delivery_units`, message: "must be an array" });
  } else {
    const plannedSlices = Array.isArray(slices) ? slices : [];
    if (deliveryEnvelope.delivery_units.length !== plannedSlices.length) {
      errors.push({ path: `${path}.delivery_units`, message: "must contain exactly one delivery unit per plan slice" });
    }
    const unitIds = new Set();
    const familyIds = new Set();
    const obligationIds = new Set();
    const artifactIds = new Set();
    for (const [index, unit] of deliveryEnvelope.delivery_units.entries()) {
      const unitPath = `${path}.delivery_units[${index}]`;
      validateDeliveryUnit(errors, unit, unitPath, plannedSlices[index], { unitIds, familyIds, obligationIds, artifactIds });
    }
  }
  if (errors.length) throwValidation(errors);
  return deliveryEnvelope;
}

export function validateInvariantFamilyLedger(ledger, {
  deliveryEnvelope,
  slices,
  sliceId,
  reviewedCommit,
  path = "review.invariant_family_ledger",
  required = false,
  requireDeliveryEnvelope = false,
} = {}) {
  if (ledger === undefined || ledger === null) {
    if (required) throwValidation([{ path, message: "is required" }]);
    return null;
  }
  const errors = [];
  if (!isRecord(ledger)) throwValidation([{ path, message: "must be an object" }]);
  allowedKeys(errors, ledger, INVARIANT_FAMILY_LEDGER_KEYS, path);
  exactSchemaVersion(errors, ledger.schema_version, `${path}.schema_version`);
  canonicalIdentifier(errors, ledger.delivery_unit_id, `${path}.delivery_unit_id`);
  let deliveryUnit = null;
  if (requireDeliveryEnvelope && (deliveryEnvelope === undefined || deliveryEnvelope === null)) {
    errors.push({ path: `${path}.delivery_unit_id`, message: "requires a delivery_envelope on the current plan" });
  }
  if (deliveryEnvelope !== undefined && deliveryEnvelope !== null) {
    try {
      validateDeliveryEnvelope(deliveryEnvelope, slices);
      deliveryUnit = deliveryEnvelope.delivery_units.find((unit) => unit.id === ledger.delivery_unit_id) ?? null;
      if (!deliveryUnit) errors.push({ path: `${path}.delivery_unit_id`, message: "must reference a delivery unit in the current envelope" });
      else if (sliceId !== undefined && deliveryUnit.slice_id !== sliceId) errors.push({ path: `${path}.delivery_unit_id`, message: `must reference the delivery unit for slice '${safeText(sliceId)}'` });
    } catch (error) {
      if (error instanceof DeliveryContractValidationError) errors.push(...error.errors);
      else throw error;
    }
  }
  if (!Array.isArray(ledger.dispositions)) {
    errors.push({ path: `${path}.dispositions`, message: "must be an array" });
  } else {
    const seenFamilies = new Set();
    for (const [index, disposition] of ledger.dispositions.entries()) {
      validateDisposition(errors, disposition, `${path}.dispositions[${index}]`, { deliveryUnit, reviewedCommit, seenFamilies });
    }
  }
  if (errors.length) throwValidation(errors);
  return ledger;
}

export function validateAdmissionExtensionResult(result) {
  return validateExtensionResult(result, {
    keys: ADMISSION_RESULT_KEYS,
    extension: "delivery-envelope-admission",
    reason: "b4-admission-policy-inactive",
    path: "admission_extension",
    decisions: new Set(["admit", "checkpoint"]),
    grantingDecision: "admit",
  });
}

export function validateReviewExtensionResult(result) {
  return validateExtensionResult(result, {
    keys: REVIEW_RESULT_KEYS,
    extension: "invariant-family-review",
    reason: "b4-review-policy-inactive",
    path: "review_extension",
    decisions: new Set(["approve", "reject"]),
    grantingDecision: "approve",
  });
}

function validateDeliveryUnit(errors, unit, path, plannedSlice, registries) {
  if (!isRecord(unit)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  allowedKeys(errors, unit, DELIVERY_UNIT_KEYS, path);
  uniqueIdentifier(errors, unit.id, `${path}.id`, registries.unitIds, "delivery unit");
  if (!canonicalText(unit.slice_id)) errors.push({ path: `${path}.slice_id`, message: "must be non-empty trimmed NFC-normalized text without control characters" });
  if (plannedSlice && unit.slice_id !== plannedSlice.id) errors.push({ path: `${path}.slice_id`, message: "must match the plan slice at the same position" });

  const families = validateNonEmptyRecordArray(errors, unit.invariant_families, `${path}.invariant_families`);
  const localFamilyIds = new Set();
  for (const [index, family] of families.entries()) {
    if (!family) continue;
    const familyPath = `${path}.invariant_families[${index}]`;
    allowedKeys(errors, family, INVARIANT_FAMILY_KEYS, familyPath);
    uniqueIdentifier(errors, family.id, `${familyPath}.id`, registries.familyIds, "invariant family");
    if (canonicalIdentifierValue(family.id)) {
      if (localFamilyIds.has(family.id)) errors.push({ path: `${familyPath}.id`, message: "must be unique within its delivery unit" });
      localFamilyIds.add(family.id);
    }
    requiredCanonicalText(errors, family.description, `${familyPath}.description`);
  }

  const artifacts = validateNonEmptyRecordArray(errors, unit.verification_artifacts, `${path}.verification_artifacts`);
  const localArtifactIds = new Set();
  const testPlanIndexes = new Set();
  for (const [index, artifact] of artifacts.entries()) {
    if (!artifact) continue;
    const artifactPath = `${path}.verification_artifacts[${index}]`;
    allowedKeys(errors, artifact, VERIFICATION_ARTIFACT_KEYS, artifactPath);
    uniqueIdentifier(errors, artifact.id, `${artifactPath}.id`, registries.artifactIds, "verification artifact");
    if (canonicalIdentifierValue(artifact.id)) {
      if (localArtifactIds.has(artifact.id)) errors.push({ path: `${artifactPath}.id`, message: "must be unique within its delivery unit" });
      localArtifactIds.add(artifact.id);
    }
    if (!Number.isInteger(artifact.test_plan_index) || artifact.test_plan_index < 0) {
      errors.push({ path: `${artifactPath}.test_plan_index`, message: "must be a non-negative integer" });
    } else {
      if (testPlanIndexes.has(artifact.test_plan_index)) errors.push({ path: `${artifactPath}.test_plan_index`, message: "must bind a distinct slice test_plan entry" });
      testPlanIndexes.add(artifact.test_plan_index);
      if (!plannedSlice || !Array.isArray(plannedSlice.test_plan) || artifact.test_plan_index >= plannedSlice.test_plan.length) {
        errors.push({ path: `${artifactPath}.test_plan_index`, message: "must reference an existing test_plan entry on the delivery unit slice" });
      } else if (artifact.test_plan_entry !== plannedSlice.test_plan[artifact.test_plan_index]) {
        errors.push({ path: `${artifactPath}.test_plan_entry`, message: "must exactly equal the referenced slice test_plan entry" });
      }
    }
    requiredCanonicalText(errors, artifact.test_plan_entry, `${artifactPath}.test_plan_entry`);
  }

  const obligations = validateNonEmptyRecordArray(errors, unit.obligations, `${path}.obligations`);
  for (const [index, obligation] of obligations.entries()) {
    if (!obligation) continue;
    const obligationPath = `${path}.obligations[${index}]`;
    allowedKeys(errors, obligation, OBLIGATION_KEYS, obligationPath);
    uniqueIdentifier(errors, obligation.id, `${obligationPath}.id`, registries.obligationIds, "obligation");
    requiredCanonicalText(errors, obligation.description, `${obligationPath}.description`);
    canonicalIdentifier(errors, obligation.invariant_family_id, `${obligationPath}.invariant_family_id`);
    canonicalIdentifier(errors, obligation.verification_artifact_id, `${obligationPath}.verification_artifact_id`);
    if (canonicalIdentifierValue(obligation.invariant_family_id) && !localFamilyIds.has(obligation.invariant_family_id)) {
      errors.push({ path: `${obligationPath}.invariant_family_id`, message: "must reference exactly one invariant family in the same delivery unit" });
    }
    if (canonicalIdentifierValue(obligation.verification_artifact_id) && !localArtifactIds.has(obligation.verification_artifact_id)) {
      errors.push({ path: `${obligationPath}.verification_artifact_id`, message: "must reference exactly one known verification artifact in the same delivery unit" });
    }
  }
}

function validateDisposition(errors, disposition, path, { deliveryUnit, reviewedCommit, seenFamilies }) {
  if (!isRecord(disposition)) {
    errors.push({ path, message: "must be an object" });
    return;
  }
  allowedKeys(errors, disposition, DISPOSITION_KEYS, path);
  canonicalIdentifier(errors, disposition.invariant_family_id, `${path}.invariant_family_id`);
  canonicalIdentifier(errors, disposition.verification_artifact_id, `${path}.verification_artifact_id`);
  if (canonicalIdentifierValue(disposition.invariant_family_id)) {
    if (seenFamilies.has(disposition.invariant_family_id)) errors.push({ path: `${path}.invariant_family_id`, message: "must have at most one disposition per invariant family" });
    seenFamilies.add(disposition.invariant_family_id);
  }
  if (!canonicalEvidenceRef(disposition.evidence_ref)) errors.push({ path: `${path}.evidence_ref`, message: "must be a canonical ref under evidence/" });
  if (!HASH_PATTERN.test(disposition.evidence_hash ?? "")) errors.push({ path: `${path}.evidence_hash`, message: "must be a sha256 hash" });
  if (!FULL_GIT_SHA_PATTERN.test(disposition.reviewed_commit ?? "")) errors.push({ path: `${path}.reviewed_commit`, message: "must be a full 40-character lowercase git SHA" });
  if (reviewedCommit !== undefined && disposition.reviewed_commit !== reviewedCommit) errors.push({ path: `${path}.reviewed_commit`, message: "must equal the enclosing review reviewed_commit" });

  if (!isRecord(disposition.probe)) errors.push({ path: `${path}.probe`, message: "must be an object" });
  else {
    allowedKeys(errors, disposition.probe, PROBE_KEYS, `${path}.probe`);
    if (disposition.probe.type !== "verification-artifact") errors.push({ path: `${path}.probe.type`, message: "must equal verification-artifact" });
    canonicalIdentifier(errors, disposition.probe.verification_artifact_id, `${path}.probe.verification_artifact_id`);
    if (disposition.probe.verification_artifact_id !== disposition.verification_artifact_id) errors.push({ path: `${path}.probe.verification_artifact_id`, message: "must equal the disposition verification_artifact_id" });
  }

  if (!isRecord(disposition.result)) errors.push({ path: `${path}.result`, message: "must be an object" });
  else {
    allowedKeys(errors, disposition.result, RESULT_KEYS, `${path}.result`);
    if (disposition.result.type !== "verification-result") errors.push({ path: `${path}.result.type`, message: "must equal verification-result" });
    if (!REVIEW_OUTCOMES.has(disposition.result.outcome)) errors.push({ path: `${path}.result.outcome`, message: "must be one of pass, fail, skipped" });
    requiredCanonicalText(errors, disposition.result.summary, `${path}.result.summary`);
  }

  validateCanonicalTextArray(errors, disposition.unresolved_findings, `${path}.unresolved_findings`);
  if (deliveryUnit) {
    const knownFamily = deliveryUnit.invariant_families.some((family) => family.id === disposition.invariant_family_id);
    const knownArtifact = deliveryUnit.verification_artifacts.some((artifact) => artifact.id === disposition.verification_artifact_id);
    if (!knownFamily) errors.push({ path: `${path}.invariant_family_id`, message: "must reference an invariant family in the ledger delivery unit" });
    if (!knownArtifact) errors.push({ path: `${path}.verification_artifact_id`, message: "must reference a verification artifact in the ledger delivery unit" });
    const mapped = deliveryUnit.obligations.some((obligation) => obligation.invariant_family_id === disposition.invariant_family_id
      && obligation.verification_artifact_id === disposition.verification_artifact_id);
    if (knownFamily && knownArtifact && !mapped) errors.push({ path, message: "family and artifact must be linked by an obligation in the ledger delivery unit" });
  }
}

function validateExtensionResult(result, { keys, extension, reason, path, decisions, grantingDecision }) {
  const errors = [];
  if (!isRecord(result)) throwValidation([{ path, message: "must be an object" }]);
  const active = result.status === "active";
  allowedKeys(errors, result, active ? ACTIVE_RESULT_KEYS : keys, path);
  exactSchemaVersion(errors, result.schema_version, `${path}.schema_version`);
  if (result.extension !== extension) errors.push({ path: `${path}.extension`, message: `must equal ${extension}` });
  if (active) {
    if (!decisions.has(result.decision)) errors.push({ path: `${path}.decision`, message: `must be one of ${[...decisions].join(", ")}` });
    validateCanonicalTextArray(errors, result.reasons, `${path}.reasons`);
    if (!Array.isArray(result.reasons) || result.reasons.length === 0) errors.push({ path: `${path}.reasons`, message: "must not be empty for an active result" });
    if (typeof result.grants_b4_authority !== "boolean") errors.push({ path: `${path}.grants_b4_authority`, message: "must be a boolean" });
    else if (decisions.has(result.decision) && result.grants_b4_authority !== (result.decision === grantingDecision)) {
      errors.push({ path: `${path}.grants_b4_authority`, message: `must be true exactly for ${grantingDecision}` });
    }
  } else {
    if (result.status !== "inactive") errors.push({ path: `${path}.status`, message: "must equal inactive or active" });
    if (result.grants_b4_authority !== false) errors.push({ path: `${path}.grants_b4_authority`, message: "must equal false while inactive" });
    if (result.reason !== reason) errors.push({ path: `${path}.reason`, message: `must equal ${reason}` });
  }
  if (errors.length) throwValidation(errors);
  return result;
}

function validateNonEmptyRecordArray(errors, value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path, message: "must be a non-empty array" });
    return [];
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      errors.push({ path: `${path}[${index}]`, message: "must be an object" });
      return null;
    }
    return entry;
  });
}

function allowedKeys(errors, value, allowed, path) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push({ path: `${path}.${key}`, message: "is not allowed" });
}

function exactSchemaVersion(errors, value, path) {
  if (value !== 1) errors.push({ path, message: "must equal 1" });
}

function uniqueIdentifier(errors, value, path, registry, label) {
  canonicalIdentifier(errors, value, path);
  if (!canonicalIdentifierValue(value)) return;
  if (registry.has(value)) errors.push({ path, message: `${label} id must be globally unique` });
  registry.add(value);
}

function canonicalIdentifier(errors, value, path) {
  if (!canonicalIdentifierValue(value)) errors.push({ path, message: "must be a lowercase kebab-case canonical id of at most 64 characters" });
}

function canonicalIdentifierValue(value) {
  return typeof value === "string" && value.length <= 64 && IDENTIFIER_PATTERN.test(value) && value === value.normalize("NFC");
}

function requiredCanonicalText(errors, value, path) {
  if (!canonicalText(value)) errors.push({ path, message: "must be non-empty trimmed NFC-normalized text without control characters" });
}

function canonicalText(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim() && value === value.normalize("NFC") && !CONTROL_PATTERN.test(value);
}

function validateCanonicalTextArray(errors, value, path) {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  const seen = new Set();
  for (const [index, entry] of value.entries()) {
    if (!canonicalText(entry)) errors.push({ path: `${path}[${index}]`, message: "must be non-empty trimmed NFC-normalized text without control characters" });
    else if (seen.has(entry)) errors.push({ path: `${path}[${index}]`, message: "must be unique" });
    else seen.add(entry);
  }
}

function canonicalEvidenceRef(value) {
  return canonicalText(value) && value.startsWith("evidence/") && !value.includes("\\")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?");
}

function throwValidation(errors) {
  throw new DeliveryContractValidationError(errors);
}
