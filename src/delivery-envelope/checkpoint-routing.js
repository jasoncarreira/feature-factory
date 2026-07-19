import { createHash } from "node:crypto";

export const CHECKPOINT_ROUTING_KIND = "delivery-checkpoint-routing-manifest";
export const CHECKPOINT_ROUTING_PLAN_REF = "plan/slices.json";
export const CHECKPOINT_ROUTING_TERMINAL_REASON = "oversized-plan-checkpoint-routing-required";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function buildCheckpointRoutingManifest({ plan, planHash, admissionResult, decompositionAuthority } = {}) {
  assertCheckpointAdmission(admissionResult);
  if (!HASH_PATTERN.test(planHash ?? "")) throw new Error("checkpoint routing requires the hash of exact plan bytes");
  assertApprovingDecompositionAuthority(decompositionAuthority, planHash);
  if (!plan || !Array.isArray(plan.slices) || !Array.isArray(plan.delivery_envelope?.delivery_units)) {
    throw new Error("checkpoint routing requires a validated delivery-envelope plan");
  }

  const slicesById = new Map(plan.slices.map((slice) => [slice.id, slice]));
  const unitsBySlice = new Map(plan.delivery_envelope.delivery_units.map((unit) => [unit.slice_id, unit]));
  const orderedSlices = stableTopologicalSlices(plan.slices);
  const checkpoints = [];

  for (const slice of orderedSlices) {
    const unit = unitsBySlice.get(slice.id);
    if (!unit) throw new Error(`checkpoint routing delivery unit is missing for slice '${slice.id}'`);
    for (const family of unit.invariant_families) {
      const obligations = unit.obligations.filter((obligation) => obligation.invariant_family_id === family.id);
      const artifactIds = new Set(obligations.map((obligation) => obligation.verification_artifact_id));
      const artifacts = unit.verification_artifacts.filter((artifact) => artifactIds.has(artifact.id));
      if (obligations.length === 0 || artifacts.length === 0) {
        throw new Error(`checkpoint routing family '${family.id}' has no complete obligation/artifact boundary`);
      }

      const ordinal = checkpoints.length + 1;
      const prerequisite = checkpoints.at(-1)?.id ?? null;
      checkpoints.push({
        id: `checkpoint-${String(ordinal).padStart(3, "0")}`,
        ordinal,
        prerequisite_checkpoint_id: prerequisite,
        request: {
          run_kind: "fresh-normal-feature-run",
          title: `Deliver ${family.description}`,
          acceptance_boundary: {
            delivery_unit_id: unit.id,
            slice_id: slice.id,
            source_slice_dependencies: clone(slice.depends_on),
            paths: clone(slice.paths),
            slice_acceptance: clone(slice.acceptance),
            invariant_family: clone(family),
            obligations: clone(obligations),
            verification_artifacts: clone(artifacts),
          },
          execution_boundary: {
            base_branch: "main",
            requires_merged_pr_from_checkpoint_id: prerequisite,
            scope: "this-checkpoint-whole-story",
          },
          integration_test_verifier: {
            required: true,
            scope: "this-checkpoint-whole-story",
            required_commands: clone(plan.integration_gate.required_commands),
          },
          whole_story_panels: [
            { agent: "implementation-validator", required: true, scope: "this-checkpoint-whole-story" },
            { agent: "security-reviewer", required: true, scope: "this-checkpoint-whole-story" },
          ],
          gate_3: { name: "pre_pr", required: true, scope: "this-checkpoint-whole-story" },
          pull_request: { required: true, count: 1, scope: "this-checkpoint-whole-story" },
        },
      });
    }
  }

  if (checkpoints.length === 0 || checkpoints.some((checkpoint) => !slicesById.has(checkpoint.request.acceptance_boundary.slice_id))) {
    throw new Error("checkpoint routing could not produce a complete checkpoint sequence");
  }

  return {
    schema_version: 1,
    kind: CHECKPOINT_ROUTING_KIND,
    source: {
      plan_ref: decompositionAuthority.plan_ref,
      plan_hash: planHash,
      decomposition_review_ref: decompositionAuthority.review_ref,
      decomposition_review_hash: decompositionAuthority.review_hash,
      decomposition_attempt: decompositionAuthority.attempt,
      admission_result: clone(admissionResult),
    },
    sequencing: {
      mode: "strictly-sequential",
      base_branch: "main",
      next_checkpoint_rule: "Checkpoint N+1 may start only from main containing merged PR N.",
    },
    checkpoints,
  };
}

function assertApprovingDecompositionAuthority(authority, planHash) {
  if (!authority || authority.plan_ref !== CHECKPOINT_ROUTING_PLAN_REF || authority.plan_hash !== planHash
    || !HASH_PATTERN.test(authority.review_hash ?? "") || typeof authority.review_ref !== "string"
    || !authority.review_ref.startsWith("reviews/") || !Number.isInteger(authority.attempt) || authority.attempt < 1
    || authority.review?.subject !== "work-decomposer" || authority.review?.attempt !== authority.attempt
    || authority.review?.verdict !== "APPROVE") {
    throw new Error("checkpoint routing requires exact approving decomposition review authority bound to the plan bytes");
  }
}

export function checkpointRoutingArtifact(manifest) {
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return {
    bytes,
    hash,
    ref: `artifacts/checkpoint-routing-${hash.slice("sha256:".length)}.json`,
  };
}

export function validateCheckpointRoutingManifest(manifest, { plan, planHash, admissionResult, decompositionAuthority } = {}) {
  const expected = buildCheckpointRoutingManifest({ plan, planHash, admissionResult, decompositionAuthority });
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw new Error("checkpoint routing manifest does not match exact reviewed plan authority");
  }
  return manifest;
}

function assertCheckpointAdmission(result) {
  const keys = result && typeof result === "object" && !Array.isArray(result) ? Object.keys(result).sort() : [];
  const expectedKeys = ["decision", "extension", "grants_b4_authority", "reasons", "schema_version", "status"];
  if (!result || JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || result.schema_version !== 1 || result.extension !== "delivery-envelope-admission"
    || result.status !== "active" || result.grants_b4_authority !== false || result.decision !== "checkpoint"
    || !Array.isArray(result.reasons) || result.reasons.length === 0) {
    throw new Error("checkpoint routing requires the exact active checkpoint admission result");
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
