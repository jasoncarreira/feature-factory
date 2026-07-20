import { createHash } from "node:crypto";

export const CHECKPOINT_ROUTING_KIND = "delivery-checkpoint-routing-manifest";
export const CHECKPOINT_ROUTING_PLAN_REF = "plan/slices.json";
export const CHECKPOINT_ROUTING_TERMINAL_REASON = "oversized-plan-checkpoint-routing-required";
export const DELIVERY_PLAN_ADMISSION_PROBE_KIND = "delivery-plan-admission-probe";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CHECKPOINT_PLAN_KEYS = ["acceptance_inventory", "acceptance_mappings", "checkpoints", "kind", "schema_version"];
const INVENTORY_KEYS = ["id", "source_index", "source_slice_id", "text"];
const MAPPING_KEYS = ["acceptance_id", "assignments", "checkpoint_ids", "policy"];
const ASSIGNMENT_KEYS = ["checkpoint_id", "invariant_family_id", "obligation_ids", "test_plan_entries", "verification_artifact_ids"];
const CHECKPOINT_KEYS = ["acceptance_ids", "brief_scope", "child_plan", "id", "ordinal", "prerequisite_checkpoint_id"];
const BRIEF_SCOPE_KEYS = ["acceptance", "invariant_family", "obligations", "paths", "source_delivery_unit_id", "source_slice_dependencies", "source_slice_id", "stack", "title", "verification_artifacts"];
const REVIEW_KEYS = ["admission_probe", "attempt", "checkpoint_dispositions", "required_fixes", "review_identity", "schema_version", "subject", "verdict"];
const REVIEW_IDENTITY_KEYS = ["attempt", "identity_hash", "plan_hash", "plan_ref", "review_ref", "schema_version", "subject"];
const DISPOSITION_KEYS = ["acceptance_mapping_hash", "attempt", "brief_scope_hash", "checkpoint_id", "checkpoint_ordinal", "child_plan_hash", "kind", "parent_review_identity", "required_fixes", "reviewed_plan_hash", "reviewed_plan_ref", "schema_version", "subject", "verdict"];

export function buildDeliveryPlanAdmissionProbe({ plan, planHash, admissionResult } = {}) {
  assertActiveAdmission(admissionResult);
  if (!HASH_PATTERN.test(planHash ?? "")) throw new Error("delivery plan admission probe requires the hash of exact plan bytes");
  const checkpointAuthority = admissionResult.decision === "checkpoint" ? reviewedCheckpointProbeAuthority(plan) : null;
  return validDeliveryPlanAdmissionProbe(planHash, admissionResult, checkpointAuthority);
}

function validDeliveryPlanAdmissionProbe(planHash, admissionResult, checkpointAuthority) {
  return {
    schema_version: 1,
    kind: DELIVERY_PLAN_ADMISSION_PROBE_KIND,
    status: "valid",
    decision: admissionResult.decision,
    plan_ref: CHECKPOINT_ROUTING_PLAN_REF,
    plan_hash: planHash,
    reasons: clone(admissionResult.reasons),
    checkpoint_plan_hash: checkpointAuthority?.checkpointPlanHash ?? null,
    checkpoints: clone(checkpointAuthority?.checkpointSummaries ?? []),
  };
}

export function buildInvalidDeliveryPlanAdmissionProbe({ planHash = null, errors } = {}) {
  if (planHash !== null && !HASH_PATTERN.test(planHash)) throw new Error("invalid delivery plan admission probe plan_hash must be null or exact");
  if (!Array.isArray(errors) || errors.length === 0
    || errors.some((error) => !isRecord(error) || Object.keys(error).length !== 2
      || typeof error.path !== "string" || error.path.length === 0
      || typeof error.message !== "string" || error.message.length === 0)) {
    throw new Error("invalid delivery plan admission probe requires nonempty path/message errors");
  }
  return {
    schema_version: 1,
    kind: DELIVERY_PLAN_ADMISSION_PROBE_KIND,
    status: "invalid",
    decision: null,
    plan_ref: CHECKPOINT_ROUTING_PLAN_REF,
    plan_hash: planHash,
    reasons: [],
    checkpoint_plan_hash: null,
    checkpoints: [],
    errors: clone(errors),
  };
}

export function buildCheckpointRoutingManifest({ plan, planHash, admissionResult, admissionProbe, decompositionAuthority } = {}) {
  assertCheckpointAdmission(admissionResult);
  if (!HASH_PATTERN.test(planHash ?? "")) throw new Error("checkpoint routing requires the hash of exact plan bytes");
  if (!isRecord(plan) || !Array.isArray(plan.slices) || !Array.isArray(plan.delivery_envelope?.delivery_units)) {
    throw new Error("checkpoint routing requires a validated delivery-envelope plan");
  }

  const reviewed = reviewedCheckpointProbeAuthority(plan);
  const checkpointPlanHash = reviewed.checkpointPlanHash;
  const expectedProbe = validDeliveryPlanAdmissionProbe(planHash, admissionResult, reviewed);
  const suppliedProbe = admissionProbe ?? decompositionAuthority?.review?.admission_probe;
  if (!sameJson(suppliedProbe, expectedProbe)) {
    throw new Error("checkpoint routing supplied admission probe does not match exact observed plan authority");
  }
  const review = assertApprovingDecompositionAuthority(decompositionAuthority, planHash, suppliedProbe, reviewed.checkpoints);

  const checkpoints = reviewed.checkpoints.map((checkpoint, index) => ({
    id: checkpoint.planEntry.id,
    ordinal: checkpoint.planEntry.ordinal,
    prerequisite_checkpoint_id: checkpoint.planEntry.prerequisite_checkpoint_id,
    acceptance_projection: clone(checkpoint.acceptanceProjection),
    acceptance_mapping_hash: checkpoint.acceptanceMappingHash,
    brief_scope: clone(checkpoint.planEntry.brief_scope),
    brief_scope_hash: checkpoint.briefScopeHash,
    child_plan: clone(checkpoint.planEntry.child_plan),
    child_plan_hash: checkpoint.childPlanHash,
    child_disposition: clone(review.checkpoint_dispositions[index]),
    request: {
      run_kind: "normal-feature-run",
      execution_boundary: {
        base_branch: "main",
        requires_merged_pr_from_checkpoint_id: checkpoint.prerequisite_checkpoint_id,
        scope: "this-checkpoint-whole-story",
      },
      integration_test_verifier: {
        required: true,
        scope: "this-checkpoint-whole-story",
        required_commands: clone(checkpoint.planEntry.child_plan.integration_gate.required_commands),
      },
      whole_story_panels: [
        { agent: "implementation-validator", required: true, scope: "this-checkpoint-whole-story" },
        { agent: "security-reviewer", required: true, scope: "this-checkpoint-whole-story" },
      ],
      gate_3: { name: "pre_pr", required: true, scope: "this-checkpoint-whole-story" },
      pull_request: { required: true, count: 1, scope: "this-checkpoint-whole-story" },
    },
  }));

  return canonicalClone({
    schema_version: 1,
    kind: CHECKPOINT_ROUTING_KIND,
    source: {
      plan_ref: decompositionAuthority.plan_ref,
      plan_hash: planHash,
      checkpoint_plan_hash: checkpointPlanHash,
      decomposition_review_ref: decompositionAuthority.review_ref,
      decomposition_review_hash: decompositionAuthority.review_hash,
      decomposition_attempt: decompositionAuthority.attempt,
      review_identity: clone(review.review_identity),
      admission_probe: clone(suppliedProbe),
      admission_result: clone(admissionResult),
    },
    sequencing: {
      mode: "strictly-sequential",
      base_branch: "main",
      next_checkpoint_rule: "Checkpoint N+1 may start only from main containing merged PR N.",
    },
    checkpoints,
  });
}

export function validateReviewedCheckpointPlan(plan) {
  const checkpointPlan = plan.delivery_envelope.checkpoint_plan;
  exactKeys(checkpointPlan, CHECKPOINT_PLAN_KEYS, "delivery checkpoint plan");
  if (checkpointPlan.schema_version !== 1 || checkpointPlan.kind !== "delivery-checkpoint-plan") {
    throw new Error("checkpoint routing requires a schema-v1 delivery-checkpoint-plan");
  }

  const expectedInventory = [];
  for (const slice of plan.slices) {
    if (!Array.isArray(slice.acceptance)) throw new Error(`checkpoint routing slice '${slice.id}' has no acceptance array`);
    for (const [sourceIndex, text] of slice.acceptance.entries()) {
      expectedInventory.push({
        id: `acceptance-${String(expectedInventory.length + 1).padStart(6, "0")}`,
        source_slice_id: slice.id,
        source_index: sourceIndex,
        text,
      });
    }
  }
  if (expectedInventory.length === 0 || !sameJson(checkpointPlan.acceptance_inventory, expectedInventory)) {
    throw new Error("checkpoint routing acceptance_inventory must exactly enumerate parent acceptance in plan order");
  }
  for (const row of checkpointPlan.acceptance_inventory) exactKeys(row, INVENTORY_KEYS, `acceptance inventory '${row?.id ?? "unknown"}'`);

  if (!Array.isArray(checkpointPlan.checkpoints) || checkpointPlan.checkpoints.length === 0) {
    throw new Error("checkpoint routing requires explicit reviewed checkpoints");
  }
  const expectedSources = [];
  const unitsBySlice = new Map(plan.delivery_envelope.delivery_units.map((unit) => [unit.slice_id, unit]));
  for (const slice of stableTopologicalSlices(plan.slices)) {
    const unit = unitsBySlice.get(slice.id);
    if (!unit) throw new Error(`checkpoint routing delivery unit is missing for slice '${slice.id}'`);
    for (const family of unit.invariant_families) expectedSources.push({ slice, unit, family });
  }
  if (checkpointPlan.checkpoints.length !== expectedSources.length) {
    throw new Error("checkpoint routing checkpoints must cover every invariant family exactly once");
  }

  const checkpointIds = checkpointPlan.checkpoints.map((checkpoint) => checkpoint?.id);
  const checkpointIndex = new Map(checkpointIds.map((id, index) => [id, index]));
  const inventoryById = new Map(expectedInventory.map((row) => [row.id, row]));
  validateAcceptanceMappings(checkpointPlan, inventoryById, checkpointIndex);

  const mappingsByAcceptance = new Map(checkpointPlan.acceptance_mappings.map((mapping) => [mapping.acceptance_id, mapping]));
  const reverseProjection = new Map(checkpointIds.map((id) => [id, []]));
  for (const mapping of checkpointPlan.acceptance_mappings) {
    for (const checkpointId of mapping.checkpoint_ids) reverseProjection.get(checkpointId).push(mapping.acceptance_id);
  }

  const checkpoints = checkpointPlan.checkpoints.map((planEntry, index) => {
    exactKeys(planEntry, CHECKPOINT_KEYS, `checkpoint '${planEntry?.id ?? "unknown"}'`);
    const expectedId = `checkpoint-${String(index + 1).padStart(3, "0")}`;
    const expectedPrerequisite = index === 0 ? null : `checkpoint-${String(index).padStart(3, "0")}`;
    if (planEntry.id !== expectedId || planEntry.ordinal !== index + 1 || planEntry.prerequisite_checkpoint_id !== expectedPrerequisite) {
      throw new Error("checkpoint routing requires stable contiguous checkpoint sequencing");
    }
    if (!nonEmptyUnique(planEntry.acceptance_ids)
      || !sameJson(planEntry.acceptance_ids, reverseProjection.get(planEntry.id))) {
      throw new Error(`checkpoint routing acceptance projection is incomplete or reordered for '${planEntry.id}'`);
    }

    const source = expectedSources[index];
    const inventory = planEntry.acceptance_ids.map((id) => inventoryById.get(id));
    const mappings = planEntry.acceptance_ids.map((id) => mappingsByAcceptance.get(id));
    const assignments = mappings.map((mapping) => mapping.assignments.find((assignment) => assignment.checkpoint_id === planEntry.id));
    validateCheckpointScope(plan, planEntry, source, inventory, assignments);
    const acceptanceProjection = {
      acceptance_ids: clone(planEntry.acceptance_ids),
      acceptance_inventory: clone(inventory),
      acceptance_mappings: clone(mappings),
    };
    return {
      planEntry,
      acceptanceProjection,
      acceptanceMappingHash: hashCanonical(acceptanceProjection),
      briefScopeHash: hashCanonical(planEntry.brief_scope),
      childPlanHash: hashCanonical(planEntry.child_plan),
    };
  });

  return { checkpointPlan, checkpoints };
}

function reviewedCheckpointProbeAuthority(plan) {
  const reviewed = validateReviewedCheckpointPlan(plan);
  return {
    ...reviewed,
    checkpointPlanHash: hashCanonical(reviewed.checkpointPlan),
    checkpointSummaries: reviewed.checkpoints.map((checkpoint) => ({
      checkpoint_id: checkpoint.planEntry.id,
      ordinal: checkpoint.planEntry.ordinal,
      brief_scope_hash: checkpoint.briefScopeHash,
      child_plan_hash: checkpoint.childPlanHash,
      acceptance_mapping_hash: checkpoint.acceptanceMappingHash,
    })),
  };
}

function validateAcceptanceMappings(checkpointPlan, inventoryById, checkpointIndex) {
  if (!Array.isArray(checkpointPlan.acceptance_mappings)
    || checkpointPlan.acceptance_mappings.length !== checkpointPlan.acceptance_inventory.length
    || !sameJson(checkpointPlan.acceptance_mappings.map((mapping) => mapping?.acceptance_id), [...inventoryById.keys()])) {
    throw new Error("checkpoint routing requires exactly one ordered mapping per acceptance inventory row");
  }
  for (const mapping of checkpointPlan.acceptance_mappings) {
    exactKeys(mapping, MAPPING_KEYS, `acceptance mapping '${mapping?.acceptance_id ?? "unknown"}'`);
    const validPolicySize = mapping.policy === "single-owner"
      ? mapping.checkpoint_ids?.length === 1
      : mapping.policy === "shared-repeat" && mapping.checkpoint_ids?.length >= 2;
    if (!nonEmptyUnique(mapping.checkpoint_ids) || !validPolicySize
      || mapping.checkpoint_ids.some((id) => !checkpointIndex.has(id))
      || !isStrictlyOrdered(mapping.checkpoint_ids, checkpointIndex)) {
      throw new Error(`checkpoint routing mapping '${mapping.acceptance_id}' has an invalid ownership policy or checkpoint order`);
    }
    if (!Array.isArray(mapping.assignments) || mapping.assignments.length !== mapping.checkpoint_ids.length
      || !sameJson(mapping.assignments.map((assignment) => assignment?.checkpoint_id), mapping.checkpoint_ids)) {
      throw new Error(`checkpoint routing mapping '${mapping.acceptance_id}' must have one ordered assignment per checkpoint`);
    }
    for (const assignment of mapping.assignments) {
      exactKeys(assignment, ASSIGNMENT_KEYS, `checkpoint assignment '${assignment?.checkpoint_id ?? "unknown"}'`);
      for (const key of ["obligation_ids", "verification_artifact_ids", "test_plan_entries"]) {
        if (!nonEmptyUnique(assignment[key])) throw new Error(`checkpoint routing assignment '${assignment.checkpoint_id}' requires nonempty unique ${key}`);
      }
    }
  }
}

function validateCheckpointScope(plan, checkpoint, { slice, unit, family }, inventory, assignments) {
  exactKeys(checkpoint.brief_scope, BRIEF_SCOPE_KEYS, `brief scope '${checkpoint.id}'`);
  if (typeof checkpoint.brief_scope.title !== "string" || checkpoint.brief_scope.title.trim() !== checkpoint.brief_scope.title || checkpoint.brief_scope.title.length === 0) {
    throw new Error(`checkpoint routing brief scope '${checkpoint.id}' requires a canonical title`);
  }
  const obligations = unit.obligations.filter((obligation) => obligation.invariant_family_id === family.id);
  const artifactIds = new Set(obligations.map((obligation) => obligation.verification_artifact_id));
  const artifacts = unit.verification_artifacts.filter((artifact) => artifactIds.has(artifact.id));
  const acceptance = inventory.map((row) => row.text);
  const expectedScope = {
    title: checkpoint.brief_scope.title,
    source_delivery_unit_id: unit.id,
    source_slice_id: slice.id,
    source_slice_dependencies: slice.depends_on,
    stack: slice.stack,
    paths: slice.paths,
    acceptance,
    invariant_family: family,
    obligations,
    verification_artifacts: artifacts,
  };
  if (!sameJson(checkpoint.brief_scope, expectedScope)) {
    throw new Error(`checkpoint routing brief scope '${checkpoint.id}' must exactly copy its reviewed parent boundary`);
  }

  const obligationById = new Map(obligations.map((obligation) => [obligation.id, obligation]));
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const assignedObligations = orderedUnion(assignments.map((assignment) => assignment.obligation_ids));
  const assignedArtifacts = orderedUnion(assignments.map((assignment) => assignment.verification_artifact_ids));
  const assignedTests = orderedUnion(assignments.map((assignment) => assignment.test_plan_entries));
  for (const assignment of assignments) {
    if (assignment.invariant_family_id !== family.id) throw new Error(`checkpoint routing assignment for '${checkpoint.id}' is cross-bound to another family`);
    for (const obligationId of assignment.obligation_ids) {
      const obligation = obligationById.get(obligationId);
      if (!obligation || !assignment.verification_artifact_ids.includes(obligation.verification_artifact_id)) {
        throw new Error(`checkpoint routing assignment for '${checkpoint.id}' contains an unbound obligation`);
      }
    }
    for (const artifactId of assignment.verification_artifact_ids) {
      const artifact = artifactById.get(artifactId);
      if (!artifact || !assignment.test_plan_entries.includes(artifact.test_plan_entry)) {
        throw new Error(`checkpoint routing assignment for '${checkpoint.id}' contains an unbound artifact`);
      }
    }
  }
  if (!sameJson(assignedObligations, obligations.map((obligation) => obligation.id))
    || !sameJson(assignedArtifacts, artifacts.map((artifact) => artifact.id))
    || !sameJson(assignedTests, artifacts.map((artifact) => artifact.test_plan_entry))) {
    throw new Error(`checkpoint routing assignments for '${checkpoint.id}' must exactly cover reviewed scope`);
  }

  const childArtifacts = artifacts.map((artifact, index) => ({ ...artifact, test_plan_index: index }));
  const expectedChildPlan = {
    integration_gate: clone(plan.integration_gate),
    slices: [{
      id: slice.id,
      stack: slice.stack,
      paths: clone(slice.paths),
      depends_on: [],
      acceptance,
      test_plan: artifacts.map((artifact) => artifact.test_plan_entry),
    }],
    delivery_envelope: {
      schema_version: 1,
      delivery_units: [{
        id: unit.id,
        slice_id: slice.id,
        invariant_families: [clone(family)],
        obligations: clone(obligations),
        verification_artifacts: childArtifacts,
      }],
    },
  };
  if (!sameJson(checkpoint.child_plan, expectedChildPlan)) {
    throw new Error(`checkpoint routing child plan '${checkpoint.id}' must be the exact reviewed one-slice plan`);
  }
}

function assertApprovingDecompositionAuthority(authority, planHash, probe, checkpoints) {
  if (!authority || authority.plan_ref !== CHECKPOINT_ROUTING_PLAN_REF || authority.plan_hash !== planHash
    || !HASH_PATTERN.test(authority.review_hash ?? "") || typeof authority.review_ref !== "string"
    || !authority.review_ref.startsWith("reviews/") || !Number.isInteger(authority.attempt) || authority.attempt < 1) {
    throw new Error("checkpoint routing requires exact decomposition review authority bound to the plan bytes");
  }
  const review = authority.review;
  exactKeys(review, REVIEW_KEYS, "checkpoint decomposition review");
  if (review.schema_version !== 1 || review.subject !== "work-decomposer" || review.attempt !== authority.attempt
    || review.verdict !== "APPROVE-CHECKPOINT" || !sameJson(review.required_fixes, []) || !sameJson(review.admission_probe, probe)) {
    throw new Error("checkpoint routing requires exact same-attempt APPROVE-CHECKPOINT review authority and admission probe");
  }
  exactKeys(review.review_identity, REVIEW_IDENTITY_KEYS, "checkpoint review identity");
  const identityFields = {
    schema_version: 1,
    subject: "work-decomposer",
    attempt: authority.attempt,
    plan_ref: CHECKPOINT_ROUTING_PLAN_REF,
    plan_hash: planHash,
    review_ref: authority.review_ref,
  };
  if (!sameJson(review.review_identity, { ...identityFields, identity_hash: hashCanonical(identityFields) })) {
    throw new Error("checkpoint routing review_identity is stale or self-dependent");
  }
  if (!Array.isArray(review.checkpoint_dispositions) || review.checkpoint_dispositions.length !== checkpoints.length) {
    throw new Error("checkpoint routing requires exactly one ordered child disposition per checkpoint");
  }
  for (const [index, disposition] of review.checkpoint_dispositions.entries()) {
    const checkpoint = checkpoints[index];
    exactKeys(disposition, DISPOSITION_KEYS, `checkpoint disposition ${index + 1}`);
    if (disposition.schema_version !== 1 || disposition.kind !== "checkpoint-child-decomposition-review"
      || disposition.subject !== "work-decomposer" || disposition.attempt !== 1 || disposition.verdict !== "APPROVE"
      || !sameJson(disposition.required_fixes, []) || disposition.checkpoint_id !== checkpoint.planEntry.id
      || disposition.checkpoint_ordinal !== checkpoint.planEntry.ordinal || disposition.reviewed_plan_ref !== CHECKPOINT_ROUTING_PLAN_REF
      || disposition.reviewed_plan_hash !== checkpoint.childPlanHash || disposition.child_plan_hash !== checkpoint.childPlanHash
      || disposition.brief_scope_hash !== checkpoint.briefScopeHash || disposition.acceptance_mapping_hash !== checkpoint.acceptanceMappingHash
      || !sameJson(disposition.parent_review_identity, review.review_identity)) {
      throw new Error(`checkpoint routing child disposition ${index + 1} is missing, stale, reordered, or cross-bound`);
    }
  }
  return review;
}

export function checkpointRoutingArtifact(manifest) {
  const bytes = canonicalBytes(manifest);
  const hash = hashBytes(bytes);
  return {
    bytes,
    hash,
    ref: `artifacts/checkpoint-routing-${hash.slice("sha256:".length)}.json`,
  };
}

export function validateCheckpointRoutingManifest(manifest, { plan, planHash, admissionResult, decompositionAuthority } = {}) {
  const expected = buildCheckpointRoutingManifest({ plan, planHash, admissionResult, decompositionAuthority });
  if (!sameJson(manifest, expected)) throw new Error("checkpoint routing manifest does not match exact reviewed plan authority");
  return manifest;
}

function assertCheckpointAdmission(result) {
  const keys = result && typeof result === "object" && !Array.isArray(result) ? Object.keys(result).sort() : [];
  const expectedKeys = ["decision", "extension", "grants_b4_authority", "reasons", "schema_version", "status"];
  if (!result || !sameJson(keys, expectedKeys)
    || result.schema_version !== 1 || result.extension !== "delivery-envelope-admission"
    || result.status !== "active" || result.grants_b4_authority !== false || result.decision !== "checkpoint"
    || !Array.isArray(result.reasons) || result.reasons.length === 0) {
    throw new Error("checkpoint routing requires the exact active checkpoint admission result");
  }
}

function assertActiveAdmission(result) {
  const keys = result && typeof result === "object" && !Array.isArray(result) ? Object.keys(result).sort() : [];
  const expectedKeys = ["decision", "extension", "grants_b4_authority", "reasons", "schema_version", "status"];
  if (!result || !sameJson(keys, expectedKeys)
    || result.schema_version !== 1 || result.extension !== "delivery-envelope-admission" || result.status !== "active"
    || !["admit", "checkpoint"].includes(result.decision) || result.grants_b4_authority !== (result.decision === "admit")
    || !Array.isArray(result.reasons) || result.reasons.length === 0
    || result.reasons.some((reason) => typeof reason !== "string" || reason.length === 0)) {
    throw new Error("delivery plan admission probe requires the exact active admission result");
  }
}

function stableTopologicalSlices(slices) {
  const indexById = new Map(slices.map((slice, index) => [slice.id, index]));
  const byId = new Map(slices.map((slice) => [slice.id, slice]));
  const indegree = new Map(slices.map((slice) => [slice.id, slice.depends_on.length]));
  const dependents = new Map(slices.map((slice) => [slice.id, []]));
  for (const slice of slices) {
    for (const dependency of slice.depends_on) {
      if (!byId.has(dependency)) throw new Error(`checkpoint routing found unknown dependency '${dependency}'`);
      dependents.get(dependency).push(slice.id);
    }
  }
  for (const ids of dependents.values()) ids.sort((left, right) => indexById.get(left) - indexById.get(right));
  const ready = slices.filter((slice) => indegree.get(slice.id) === 0).map((slice) => slice.id);
  ready.sort((left, right) => indexById.get(left) - indexById.get(right));
  const ordered = [];
  while (ready.length > 0) {
    const id = ready.shift();
    ordered.push(byId.get(id));
    for (const dependent of dependents.get(id)) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) {
        ready.push(dependent);
        ready.sort((left, right) => indexById.get(left) - indexById.get(right));
      }
    }
  }
  if (ordered.length !== slices.length) throw new Error("checkpoint routing requires an acyclic dependency graph");
  return ordered;
}

function exactKeys(value, keys, label) {
  if (!isRecord(value) || !sameJson(Object.keys(value).sort(), keys)) throw new Error(`${label} must be a closed object`);
}

function nonEmptyUnique(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0)
    && new Set(value).size === value.length;
}

function isStrictlyOrdered(ids, index) {
  return ids.every((id, position) => position === 0 || index.get(ids[position - 1]) < index.get(id));
}

function orderedUnion(groups) {
  const result = [];
  const seen = new Set();
  for (const group of groups) for (const value of group) if (!seen.has(value)) {
    seen.add(value);
    result.push(value);
  }
  return result;
}

function canonicalClone(value) {
  if (Array.isArray(value)) return value.map(canonicalClone);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalClone(value[key])]));
}

function canonicalBytes(value) {
  return `${JSON.stringify(canonicalClone(value), null, 2)}\n`;
}

function hashCanonical(value) {
  return hashBytes(canonicalBytes(value));
}

function hashBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sameJson(left, right) {
  return JSON.stringify(canonicalClone(left)) === JSON.stringify(canonicalClone(right));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
