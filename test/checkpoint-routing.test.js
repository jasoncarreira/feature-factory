import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildCheckpointRoutingManifest,
  checkpointRoutingArtifact,
  validateCheckpointRoutingManifest,
} from "../src/delivery-envelope/checkpoint-routing.js";
import { evaluateDeliveryEnvelopeAdmission } from "../src/delivery-envelope/admission-extension.js";
import { transitionSlicesSeed, transitionSteeringBoundaryOpened } from "../src/run-state.js";

describe("B4.3 reviewed checkpoint routing contract", () => {
  it("initializes manifest-bound active parent progress when routing terminalizes", async () => {
    const fixture = routingRunFixture("checkpoint-progress-initialization");
    try {
      const boundary = await transitionSteeringBoundaryOpened(fixture.runDir, "terminal", {
        token: "checkpoint-progress-terminal-boundary",
        now: "2026-07-19T11:59:00.000Z",
      });
      const routed = await transitionSlicesSeed(fixture.runDir, pendingProjection(fixture.plan), {
        from: "plan/slices.json",
        boundaryToken: boundary.boundary.token,
        now: "2026-07-19T12:00:00.000Z",
      });
      const persisted = readJson(join(fixture.runDir, "run.json"));
      assert.equal(routed.route, "checkpoint");
      assert.deepEqual(persisted.checkpoint_progress, {
        schema_version: 1,
        kind: "delivery-checkpoint-progress",
        manifest_ref: routed.checkpoint_routing.ref,
        manifest_hash: routed.checkpoint_routing.hash,
        status: "active",
        entries: [],
        final_closure: null,
      });
      assert.deepEqual(Object.keys(persisted.checkpoint_progress), [
        "schema_version", "kind", "manifest_ref", "manifest_hash", "status", "entries", "final_closure",
      ]);

      const beforeReplay = readFileSync(join(fixture.runDir, "run.json"), "utf8");
      const replay = await transitionSlicesSeed(fixture.runDir, pendingProjection(fixture.plan), { from: "plan/slices.json" });
      assert.equal(replay.updated, false);
      assert.equal(readFileSync(join(fixture.runDir, "run.json"), "utf8"), beforeReplay);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("copies exact reviewed scope, child plans, acceptance projections, hashes, and child dispositions", () => {
    const fixture = routingFixture();
    const manifest = buildCheckpointRoutingManifest(fixture);

    assert.equal(manifest.source.checkpoint_plan_hash, canonicalHash(fixture.plan.delivery_envelope.checkpoint_plan));
    assert.deepEqual(manifest.source.review_identity, fixture.decompositionAuthority.review.review_identity);
    assert.deepEqual(manifest.source.admission_probe, fixture.decompositionAuthority.review.admission_probe);
    assert.deepEqual(manifest.checkpoints.map((checkpoint) => checkpoint.id), ["checkpoint-001", "checkpoint-002"]);
    assert.deepEqual(manifest.checkpoints.map((checkpoint) => checkpoint.prerequisite_checkpoint_id), [null, "checkpoint-001"]);

    for (const [index, checkpoint] of manifest.checkpoints.entries()) {
      const reviewed = fixture.plan.delivery_envelope.checkpoint_plan.checkpoints[index];
      const disposition = fixture.decompositionAuthority.review.checkpoint_dispositions[index];
      const projection = acceptanceProjection(fixture.plan.delivery_envelope.checkpoint_plan, reviewed);
      assert.deepEqual(checkpoint.brief_scope, reviewed.brief_scope);
      assert.deepEqual(checkpoint.child_plan, reviewed.child_plan);
      assert.deepEqual(checkpoint.acceptance_projection, projection);
      assert.equal(checkpoint.brief_scope_hash, canonicalHash(reviewed.brief_scope));
      assert.equal(checkpoint.child_plan_hash, canonicalHash(reviewed.child_plan));
      assert.equal(checkpoint.acceptance_mapping_hash, canonicalHash(projection));
      assert.deepEqual(checkpoint.child_disposition, disposition);
      assert.equal(checkpoint.request.run_kind, "normal-feature-run");
      assert.deepEqual(checkpoint.request.integration_test_verifier.required_commands, reviewed.child_plan.integration_gate.required_commands);
      assert.deepEqual(checkpoint.request.whole_story_panels.map(({ agent }) => agent), ["implementation-validator", "security-reviewer"]);
      assert.deepEqual(checkpoint.request.gate_3, { name: "pre_pr", required: true, scope: "this-checkpoint-whole-story" });
      assert.deepEqual(checkpoint.request.pull_request, { required: true, count: 1, scope: "this-checkpoint-whole-story" });
    }

    fixture.plan.delivery_envelope.checkpoint_plan.checkpoints[0].brief_scope.title = "mutated after routing";
    fixture.decompositionAuthority.review.checkpoint_dispositions[0].checkpoint_id = "mutated-after-routing";
    assert.equal(manifest.checkpoints[0].brief_scope.title, "Deliver API family 1");
    assert.equal(manifest.checkpoints[0].child_disposition.checkpoint_id, "checkpoint-001");
  });

  it("produces stable canonical manifest bytes and validates only the exact projection", () => {
    const fixture = routingFixture();
    const first = buildCheckpointRoutingManifest(fixture);
    const second = buildCheckpointRoutingManifest(structuredClone(fixture));
    const artifact = checkpointRoutingArtifact(first);

    assert.deepEqual(second, first);
    assert.equal(artifact.bytes, canonicalBytes(first));
    assert.equal(artifact.hash, hashBytes(artifact.bytes));
    assert.match(artifact.ref, /^artifacts\/checkpoint-routing-[0-9a-f]{64}\.json$/u);
    assert.deepEqual(validateCheckpointRoutingManifest(structuredClone(first), fixture), first);

    const changed = structuredClone(first);
    changed.checkpoints[0].brief_scope.title = "runtime reinterpretation";
    assert.throws(() => validateCheckpointRoutingManifest(changed, fixture), /does not match exact reviewed plan authority/u);
  });

  for (const [name, mutate] of [
    ["missing", (review) => { review.checkpoint_dispositions.pop(); }],
    ["duplicate", (review) => { review.checkpoint_dispositions[1] = structuredClone(review.checkpoint_dispositions[0]); }],
    ["reordered", (review) => { review.checkpoint_dispositions.reverse(); }],
    ["cross-bound", (review) => { review.checkpoint_dispositions[1].checkpoint_id = "checkpoint-001"; }],
    ["stale child-plan hash", (review) => { review.checkpoint_dispositions[0].child_plan_hash = `sha256:${"f".repeat(64)}`; }],
    ["stale scope hash", (review) => { review.checkpoint_dispositions[0].brief_scope_hash = `sha256:${"e".repeat(64)}`; }],
    ["stale acceptance hash", (review) => { review.checkpoint_dispositions[0].acceptance_mapping_hash = `sha256:${"d".repeat(64)}`; }],
    ["rejecting", (review) => {
      review.checkpoint_dispositions[0].verdict = "REJECT";
      review.checkpoint_dispositions[0].required_fixes = ["not approved"];
    }],
  ]) {
    it(`rejects ${name} reviewer-produced child dispositions`, () => {
      const fixture = routingFixture();
      mutate(fixture.decompositionAuthority.review);
      assert.throws(
        () => buildCheckpointRoutingManifest(fixture),
        /exactly one ordered child disposition|missing, stale, reordered, or cross-bound/u,
      );
    });
  }

  it("rejects plain APPROVE and plans without the new closed checkpoint contract", () => {
    const fixture = routingFixture();
    fixture.decompositionAuthority.review.verdict = "APPROVE";
    assert.throws(() => buildCheckpointRoutingManifest(fixture), /APPROVE-CHECKPOINT/u);

    const oldSchema = routingFixture();
    delete oldSchema.plan.delivery_envelope.checkpoint_plan;
    assert.throws(() => buildCheckpointRoutingManifest(oldSchema), /delivery checkpoint plan must be a closed object/u);
  });

  it("rejects acceptance projection drift instead of rebuilding reviewed scope", () => {
    const fixture = routingFixture();
    fixture.plan.delivery_envelope.checkpoint_plan.acceptance_mappings[0].assignments[0].test_plan_entries = ["test api 3"];
    assert.throws(() => buildCheckpointRoutingManifest(fixture), /unbound artifact|exactly cover reviewed scope/u);
  });

  it("rejects single-owner acceptance mapped to multiple checkpoints", () => {
    const fixture = routingFixture();
    const mapping = fixture.plan.delivery_envelope.checkpoint_plan.acceptance_mappings[0];
    mapping.checkpoint_ids = ["checkpoint-001", "checkpoint-002"];
    mapping.assignments.push({
      ...structuredClone(mapping.assignments[0]),
      checkpoint_id: "checkpoint-002",
    });
    assert.throws(
      () => buildCheckpointRoutingManifest(fixture),
      /invalid ownership policy or checkpoint order/u,
    );
  });
});

function routingFixture() {
  const plan = parentPlan();
  plan.delivery_envelope.checkpoint_plan = checkpointPlan(plan);
  const planHash = hashBytes(`${JSON.stringify(plan, null, 2)}\n`);
  const admissionResult = evaluateDeliveryEnvelopeAdmission({ plan });
  const reviewRef = "reviews/work-decomposer.json";
  const identityFields = {
    schema_version: 1,
    subject: "work-decomposer",
    attempt: 1,
    plan_ref: "plan/slices.json",
    plan_hash: planHash,
    review_ref: reviewRef,
  };
  const reviewIdentity = { ...identityFields, identity_hash: canonicalHash(identityFields) };
  const checkpointPlanHash = canonicalHash(plan.delivery_envelope.checkpoint_plan);
  const summaries = plan.delivery_envelope.checkpoint_plan.checkpoints.map((checkpoint) => {
    const projection = acceptanceProjection(plan.delivery_envelope.checkpoint_plan, checkpoint);
    return {
      checkpoint_id: checkpoint.id,
      ordinal: checkpoint.ordinal,
      brief_scope_hash: canonicalHash(checkpoint.brief_scope),
      child_plan_hash: canonicalHash(checkpoint.child_plan),
      acceptance_mapping_hash: canonicalHash(projection),
    };
  });
  const admissionProbe = {
    schema_version: 1,
    kind: "delivery-plan-admission-probe",
    status: "valid",
    decision: "checkpoint",
    plan_ref: "plan/slices.json",
    plan_hash: planHash,
    reasons: [...admissionResult.reasons],
    checkpoint_plan_hash: checkpointPlanHash,
    checkpoints: summaries,
  };
  const checkpointDispositions = summaries.map((summary) => ({
    schema_version: 1,
    kind: "checkpoint-child-decomposition-review",
    subject: "work-decomposer",
    attempt: 1,
    verdict: "APPROVE",
    required_fixes: [],
    checkpoint_id: summary.checkpoint_id,
    checkpoint_ordinal: summary.ordinal,
    reviewed_plan_ref: "plan/slices.json",
    reviewed_plan_hash: summary.child_plan_hash,
    child_plan_hash: summary.child_plan_hash,
    brief_scope_hash: summary.brief_scope_hash,
    acceptance_mapping_hash: summary.acceptance_mapping_hash,
    parent_review_identity: structuredClone(reviewIdentity),
  }));
  const review = {
    schema_version: 1,
    subject: "work-decomposer",
    attempt: 1,
    verdict: "APPROVE-CHECKPOINT",
    required_fixes: [],
    admission_probe: admissionProbe,
    review_identity: reviewIdentity,
    checkpoint_dispositions: checkpointDispositions,
  };
  return {
    plan,
    planHash,
    admissionResult,
    decompositionAuthority: {
      plan_ref: "plan/slices.json",
      plan_hash: planHash,
      review_ref: reviewRef,
      review_hash: hashBytes(`${JSON.stringify(review, null, 2)}\n`),
      attempt: 1,
      review,
    },
  };
}

function routingRunFixture(runId) {
  const authority = routingFixture();
  const repo = mkdtempSync(join(tmpdir(), "checkpoint-routing-progress-"));
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "plan"), { recursive: true });
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  writeJson(join(runDir, "plan", "slices.json"), authority.plan);
  writeJson(join(runDir, "reviews", "work-decomposer.json"), authority.decompositionAuthority.review);
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    status: "running",
    gates: {},
    slices: [],
    steps: [{
      agent: "work-decomposer",
      status: "accepted",
      attempts: 1,
      artifact_ref: "plan/slices.json",
      review_ref: "reviews/work-decomposer.json",
      acceptance: {
        artifact_ref: "plan/slices.json",
        artifact_hash: authority.planHash,
        review_ref: "reviews/work-decomposer.json",
        review_hash: authority.decompositionAuthority.review_hash,
      },
    }, { agent: "test-verifier", status: "blocked", attempts: 0 }],
    terminal_result: null,
  });
  return { ...authority, repo, runDir, runId };
}

function parentPlan() {
  const testPlan = Array.from({ length: 6 }, (_, index) => `test api ${index + 1}`);
  return {
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: [{
      id: "api",
      stack: "backend",
      paths: ["src/api.js"],
      depends_on: [],
      acceptance: ["AC1", "AC2"],
      test_plan: testPlan,
    }],
    delivery_envelope: {
      schema_version: 1,
      delivery_units: [{
        id: "api-unit",
        slice_id: "api",
        invariant_families: [
          { id: "api-family-1", description: "API family 1" },
          { id: "api-family-2", description: "API family 2" },
        ],
        obligations: testPlan.map((entry, index) => ({
          id: `api-obligation-${index + 1}`,
          description: `API obligation ${index + 1}`,
          invariant_family_id: `api-family-${(index % 2) + 1}`,
          verification_artifact_id: `api-artifact-${index + 1}`,
        })),
        verification_artifacts: testPlan.map((entry, index) => ({
          id: `api-artifact-${index + 1}`,
          test_plan_index: index,
          test_plan_entry: entry,
        })),
      }],
    },
  };
}

function checkpointPlan(plan) {
  const slice = plan.slices[0];
  const unit = plan.delivery_envelope.delivery_units[0];
  const acceptanceInventory = slice.acceptance.map((text, index) => ({
    id: `acceptance-${String(index + 1).padStart(6, "0")}`,
    source_slice_id: slice.id,
    source_index: index,
    text,
  }));
  const checkpoints = unit.invariant_families.map((family, index) => {
    const id = `checkpoint-${String(index + 1).padStart(3, "0")}`;
    const obligations = unit.obligations.filter((obligation) => obligation.invariant_family_id === family.id);
    const artifactIds = new Set(obligations.map((obligation) => obligation.verification_artifact_id));
    const artifacts = unit.verification_artifacts.filter((artifact) => artifactIds.has(artifact.id));
    const acceptance = [acceptanceInventory[index].text];
    return {
      id,
      ordinal: index + 1,
      prerequisite_checkpoint_id: index === 0 ? null : `checkpoint-${String(index).padStart(3, "0")}`,
      acceptance_ids: [acceptanceInventory[index].id],
      brief_scope: {
        title: `Deliver API family ${index + 1}`,
        source_delivery_unit_id: unit.id,
        source_slice_id: slice.id,
        source_slice_dependencies: [...slice.depends_on],
        stack: slice.stack,
        paths: [...slice.paths],
        acceptance,
        invariant_family: structuredClone(family),
        obligations: structuredClone(obligations),
        verification_artifacts: structuredClone(artifacts),
      },
      child_plan: {
        integration_gate: structuredClone(plan.integration_gate),
        slices: [{
          id: slice.id,
          stack: slice.stack,
          paths: [...slice.paths],
          depends_on: [],
          acceptance,
          test_plan: artifacts.map((artifact) => artifact.test_plan_entry),
        }],
        delivery_envelope: {
          schema_version: 1,
          delivery_units: [{
            id: unit.id,
            slice_id: slice.id,
            invariant_families: [structuredClone(family)],
            obligations: structuredClone(obligations),
            verification_artifacts: artifacts.map((artifact, artifactIndex) => ({ ...structuredClone(artifact), test_plan_index: artifactIndex })),
          }],
        },
      },
    };
  });
  const acceptanceMappings = acceptanceInventory.map((row, index) => {
    const checkpoint = checkpoints[index];
    const family = checkpoint.brief_scope.invariant_family;
    const obligations = checkpoint.brief_scope.obligations;
    const artifacts = checkpoint.brief_scope.verification_artifacts;
    return {
      acceptance_id: row.id,
      policy: "single-owner",
      checkpoint_ids: [checkpoint.id],
      assignments: [{
        checkpoint_id: checkpoint.id,
        invariant_family_id: family.id,
        obligation_ids: obligations.map((obligation) => obligation.id),
        verification_artifact_ids: artifacts.map((artifact) => artifact.id),
        test_plan_entries: artifacts.map((artifact) => artifact.test_plan_entry),
      }],
    };
  });
  return {
    schema_version: 1,
    kind: "delivery-checkpoint-plan",
    acceptance_inventory: acceptanceInventory,
    acceptance_mappings: acceptanceMappings,
    checkpoints,
  };
}

function acceptanceProjection(checkpointPlanValue, checkpoint) {
  const inventoryById = new Map(checkpointPlanValue.acceptance_inventory.map((row) => [row.id, row]));
  const mappingById = new Map(checkpointPlanValue.acceptance_mappings.map((mapping) => [mapping.acceptance_id, mapping]));
  return {
    acceptance_ids: structuredClone(checkpoint.acceptance_ids),
    acceptance_inventory: checkpoint.acceptance_ids.map((id) => structuredClone(inventoryById.get(id))),
    acceptance_mappings: checkpoint.acceptance_ids.map((id) => structuredClone(mappingById.get(id))),
  };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalBytes(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function canonicalHash(value) {
  return hashBytes(canonicalBytes(value));
}

function hashBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function pendingProjection(plan) {
  return plan.slices.map((slice) => ({
    id: slice.id,
    stack: slice.stack,
    depends_on: [...slice.depends_on],
    status: "pending",
    attempts: 0,
  }));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
