import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildCheckpointRoutingManifest, CHECKPOINT_ROUTING_TERMINAL_REASON } from "../src/delivery-envelope/checkpoint-routing.js";
import { evaluateDeliveryEnvelopeAdmission } from "../src/delivery-envelope/admission-extension.js";
import { transitionSlicesSeed } from "../src/run-state.js";

describe("B4.3 checkpoint routing", () => {
  it("builds a deterministic strict sequence in dependency then family order with whole-story gates", () => {
    const plan = planWithSpecs([
      unitSpec("final", 1, 1, ["middle"]),
      unitSpec("root", 2, 6),
      unitSpec("middle", 1, 1, ["root"]),
    ]);
    const admission = evaluateDeliveryEnvelopeAdmission({ plan });
    const planHash = hashBytes(`${JSON.stringify(plan)}\n`);
    const first = buildCheckpointRoutingManifest({ plan, planHash, admissionResult: admission });
    const second = buildCheckpointRoutingManifest({ plan: structuredClone(plan), planHash, admissionResult: structuredClone(admission) });

    assert.deepEqual(second, first);
    assert.deepEqual(first.checkpoints.map((checkpoint) => checkpoint.request.acceptance_boundary.invariant_family.id), [
      "root-family-1", "root-family-2", "middle-family-1", "final-family-1",
    ]);
    assert.deepEqual(first.checkpoints.map((checkpoint) => checkpoint.prerequisite_checkpoint_id), [
      null, "checkpoint-001", "checkpoint-002", "checkpoint-003",
    ]);
    assert.equal(first.sequencing.mode, "strictly-sequential");
    assert.equal(first.sequencing.base_branch, "main");
    assert.equal(first.sequencing.next_checkpoint_rule, "Checkpoint N+1 may start only from main containing merged PR N.");

    for (const [index, checkpoint] of first.checkpoints.entries()) {
      assert.equal(checkpoint.ordinal, index + 1);
      assert.equal(checkpoint.request.run_kind, "fresh-normal-feature-run");
      assert.equal(checkpoint.request.execution_boundary.base_branch, "main");
      assert.equal(checkpoint.request.integration_test_verifier.required, true);
      assert.deepEqual(checkpoint.request.integration_test_verifier.required_commands, plan.integration_gate.required_commands);
      assert.deepEqual(checkpoint.request.whole_story_panels.map((panel) => [panel.agent, panel.required]), [
        ["implementation-validator", true], ["security-reviewer", true],
      ]);
      assert.deepEqual(checkpoint.request.gate_3, { name: "pre_pr", required: true, scope: "this-checkpoint-whole-story" });
      assert.deepEqual(checkpoint.request.pull_request, { required: true, count: 1, scope: "this-checkpoint-whole-story" });
      assert.ok(checkpoint.request.acceptance_boundary.slice_acceptance.length > 0);
      assert.ok(checkpoint.request.acceptance_boundary.obligations.length > 0);
      assert.ok(checkpoint.request.acceptance_boundary.verification_artifacts.length > 0);
    }

    const serialized = JSON.stringify(first);
    for (const forbidden of ["carry_forward", "carry-forward", "retained_merged_rows", "partial_pr", "merge_train", "join", "shared_final_panel"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });

  it("terminalizes an oversized parent before runnable slices or accepted decomposition and replays idempotently", async () => {
    const fixture = createRoutingFixture("checkpoint-replay", planWithSpecs([unitSpec("api", 2, 6)]));
    try {
      const projection = pendingProjection(fixture.plan);
      const first = await transitionSlicesSeed(fixture.runDir, projection, {
        from: "plan/slices.json",
        now: "2026-07-19T12:00:00.000Z",
      });
      const persisted = readJson(join(fixture.runDir, "run.json"));
      const manifest = readJson(join(fixture.runDir, first.checkpoint_routing.ref));

      assert.equal(first.updated, true);
      assert.equal(first.route, "checkpoint");
      assert.equal(first.status, "blocked");
      assert.equal(first.checkpoint_routing.checkpoint_count, 2);
      assert.match(first.checkpoint_routing.ref, /^artifacts\/checkpoint-routing-[0-9a-f]{64}\.json$/u);
      assert.equal(hashBytes(readFileSync(join(fixture.runDir, first.checkpoint_routing.ref))), first.checkpoint_routing.hash);
      assert.deepEqual(persisted.slices, []);
      assert.equal(persisted.steps[0].status, "running");
      assert.equal(persisted.steps[0].acceptance, undefined);
      assert.equal(persisted.status, "blocked");
      assert.equal(persisted.terminal_result.reason, CHECKPOINT_ROUTING_TERMINAL_REASON);
      assert.deepEqual(persisted.terminal_result.artifacts, { checkpoint_routing: first.checkpoint_routing.ref });
      assert.equal(manifest.source.plan_hash, hashBytes(readFileSync(join(fixture.runDir, "plan", "slices.json"))));

      const before = readFileSync(join(fixture.runDir, "run.json"));
      const replay = await transitionSlicesSeed(fixture.runDir, projection, { from: "plan/slices.json" });
      assert.equal(replay.updated, false);
      assert.equal(replay.route, "checkpoint");
      assert.deepEqual(replay.checkpoint_routing, first.checkpoint_routing);
      assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), before);
      assert.deepEqual(readdirSync(join(fixture.runDir, "artifacts")), [first.checkpoint_routing.ref.split("/").at(-1)]);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects exact-plan drift inside the observation/publication interval without routing or seeding", async () => {
    const original = planWithSpecs([unitSpec("api", 2, 6)]);
    const fixture = createRoutingFixture("checkpoint-race", original);
    try {
      const raced = structuredClone(original);
      raced.delivery_envelope.delivery_units[0].invariant_families[0].description = "Raced family description";
      await assert.rejects(
        transitionSlicesSeed(fixture.runDir, pendingProjection(original), {
          from: "plan/slices.json",
          checkpointRoutingHooks: { beforeArtifactCommit: () => writeJson(join(fixture.runDir, "plan", "slices.json"), raced) },
        }),
        (error) => error?.message === "protected file commit failed"
          && error.cause?.message === "checkpoint routing plan authority changed before publication",
      );

      const run = readJson(join(fixture.runDir, "run.json"));
      assert.equal(run.status, "running");
      assert.equal(run.terminal_result, null);
      assert.deepEqual(run.slices, []);
      assert.deepEqual(readdirSync(join(fixture.runDir, "artifacts")), []);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("fails closed for a missing envelope instead of manufacturing a checkpoint route", async () => {
    const invalid = planWithSpecs([unitSpec("api")]);
    delete invalid.delivery_envelope;
    const fixture = createRoutingFixture("checkpoint-missing-envelope", invalid);
    try {
      await assert.rejects(
        transitionSlicesSeed(fixture.runDir, pendingProjection(invalid), { from: "plan/slices.json" }),
        /plan\.delivery_envelope: is required/u,
      );
      const run = readJson(join(fixture.runDir, "run.json"));
      assert.equal(run.status, "running");
      assert.equal(run.terminal_result, null);
      assert.deepEqual(run.slices, []);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("keeps the admit path on ordinary slices-seed behavior", async () => {
    const plan = planWithSpecs([unitSpec("api")]);
    const fixture = createRoutingFixture("checkpoint-admit", plan);
    try {
      const result = await transitionSlicesSeed(fixture.runDir, pendingProjection(plan), { from: "plan/slices.json" });
      const run = readJson(join(fixture.runDir, "run.json"));
      assert.equal(result.route, undefined);
      assert.equal(run.status, "running");
      assert.equal(run.terminal_result, null);
      assert.deepEqual(run.slices, [{
        id: "api", stack: "backend", depends_on: [], status: "pending", attempts: 0,
        declared_paths: ["src/api.js"], effective_paths: ["src/api.js"],
      }]);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });
});

function createRoutingFixture(runId, plan) {
  const repo = mkdtempSync(join(tmpdir(), "checkpoint-routing-"));
  const runDir = join(repo, ".opencode", "factory", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  mkdirSync(join(runDir, "plan"), { recursive: true });
  writeJson(join(runDir, "plan", "slices.json"), plan);
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    status: "running",
    gates: {},
    slices: [],
    steps: [{ agent: "work-decomposer", status: "running", attempts: 1 }],
    terminal_result: null,
  });
  return { repo, runDir, plan };
}

function planWithSpecs(specs) {
  const slices = specs.map((spec) => ({
    id: spec.id,
    stack: "backend",
    paths: [`src/${spec.id}.js`],
    depends_on: [...spec.dependsOn],
    acceptance: [`accept ${spec.id}`],
    test_plan: Array.from({ length: spec.obligations }, (_, index) => `test ${spec.id} ${index + 1}`),
  }));
  return {
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices,
    delivery_envelope: { schema_version: 1, delivery_units: specs.map((spec, index) => deliveryUnit(spec, slices[index])) },
  };
}

function unitSpec(id, families = 1, obligations = 1, dependsOn = []) {
  return { id, families, obligations, dependsOn };
}

function deliveryUnit(spec, slice) {
  return {
    id: `${spec.id}-unit`,
    slice_id: spec.id,
    invariant_families: Array.from({ length: spec.families }, (_, index) => ({ id: `${spec.id}-family-${index + 1}`, description: `${spec.id} family ${index + 1}` })),
    obligations: Array.from({ length: spec.obligations }, (_, index) => ({
      id: `${spec.id}-obligation-${index + 1}`,
      description: `${spec.id} obligation ${index + 1}`,
      invariant_family_id: `${spec.id}-family-${(index % spec.families) + 1}`,
      verification_artifact_id: `${spec.id}-artifact-${index + 1}`,
    })),
    verification_artifacts: slice.test_plan.map((entry, index) => ({ id: `${spec.id}-artifact-${index + 1}`, test_plan_index: index, test_plan_entry: entry })),
  };
}

function pendingProjection(plan) {
  return plan.slices.map((slice) => ({ id: slice.id, stack: slice.stack, depends_on: [...slice.depends_on], status: "pending", attempts: 0 }));
}

function hashBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
