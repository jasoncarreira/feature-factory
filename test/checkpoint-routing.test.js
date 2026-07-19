import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildCheckpointRoutingManifest, CHECKPOINT_ROUTING_TERMINAL_REASON } from "../src/delivery-envelope/checkpoint-routing.js";
import { evaluateDeliveryEnvelopeAdmission } from "../src/delivery-envelope/admission-extension.js";
import { transitionRunStep, transitionSlicesSeed, transitionSteeringBoundaryCrossed, transitionSteeringBoundaryOpened, transitionSteeringConsumed, transitionSteeringQueued } from "../src/run-state.js";
import { hashValue } from "../src/refs.js";

describe("B4.3 checkpoint routing", () => {
  it("builds a deterministic strict sequence in dependency then family order with whole-story gates", () => {
    const plan = planWithSpecs([
      unitSpec("final", 1, 1, ["middle"]),
      unitSpec("root", 2, 6),
      unitSpec("middle", 1, 1, ["root"]),
    ]);
    const admission = evaluateDeliveryEnvelopeAdmission({ plan });
    const planHash = hashBytes(`${JSON.stringify(plan)}\n`);
    const first = buildCheckpointRoutingManifest({ plan, planHash, admissionResult: admission, decompositionAuthority: decompositionAuthority(planHash) });
    const second = buildCheckpointRoutingManifest({ plan: structuredClone(plan), planHash, admissionResult: structuredClone(admission), decompositionAuthority: decompositionAuthority(planHash) });

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

  it("accepts the exact reviewed checkpoint plan before seeding without inventing slice authority", async () => {
    const fixture = createRoutingFixture("checkpoint-acceptance", planWithSpecs([unitSpec("api", 2, 6)]));
    try {
      const run = readJson(join(fixture.runDir, "run.json"));
      run.steps[0] = { agent: "work-decomposer", status: "running", attempts: 1 };
      writeJson(join(fixture.runDir, "run.json"), run);

      const accepted = await transitionRunStep(fixture.runDir, "work-decomposer", {
        status: "accepted",
        attempts: 1,
        artifact_ref: "plan/slices.json",
        review_ref: "reviews/work-decomposer.json",
      }, { mustExist: true });

      assert.equal(accepted.step.status, "accepted");
      assert.equal(accepted.step.acceptance.artifact_hash, hashBytes(readFileSync(join(fixture.runDir, "plan", "slices.json"))));
      assert.equal(accepted.step.acceptance.review_hash, hashBytes(readFileSync(join(fixture.runDir, "reviews", "work-decomposer.json"))));
      assert.deepEqual(accepted.run.slices, []);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("terminalizes an oversized parent after accepted reviewed decomposition and before runnable slices, then replays idempotently", async () => {
    const fixture = createRoutingFixture("checkpoint-replay", planWithSpecs([unitSpec("api", 2, 6)]));
    try {
      const projection = pendingProjection(fixture.plan);
      const boundary = await openTerminalBoundary(fixture);
      const first = await transitionSlicesSeed(fixture.runDir, projection, {
        from: "plan/slices.json",
        boundaryToken: boundary.token,
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
      assert.equal(persisted.steps[0].status, "accepted");
      assert.equal(persisted.steps[0].acceptance.artifact_hash, manifest.source.plan_hash);
      assert.equal(persisted.steps[0].acceptance.review_hash, manifest.source.decomposition_review_hash);
      assert.equal(persisted.steering.boundary, null);
      assert.equal(persisted.steering.pending, null);
      assert.equal(persisted.steering.uncheckpointed, null);
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

  it("rejects missing and stale terminal boundary observations without publishing route state", async () => {
    for (const state of ["missing", "stale"]) {
      const fixture = createRoutingFixture(`checkpoint-boundary-${state}`, planWithSpecs([unitSpec("api", 2, 6)]));
      try {
        let boundaryToken;
        if (state === "stale") {
          const boundary = await openTerminalBoundary(fixture);
          boundaryToken = boundary.token;
          const run = readJson(join(fixture.runDir, "run.json"));
          run.updated_at = "2026-07-19T12:00:01.000Z";
          writeJson(join(fixture.runDir, "run.json"), run);
        }
        const before = snapshotRouteState(fixture);
        await assert.rejects(
          transitionSlicesSeed(fixture.runDir, pendingProjection(fixture.plan), { from: "plan/slices.json", boundaryToken }),
          state === "missing" ? /lock-protected boundary observation/u : /boundary observation is stale/u,
        );
        assertRouteStateUnchanged(fixture, before);
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    }
  });

  it("rejects pending and uncheckpointed steering without preserving it in a blocked parent", async () => {
    for (const state of ["pending", "uncheckpointed"]) {
      const fixture = createRoutingFixture(`checkpoint-steering-${state}`, planWithSpecs([unitSpec("api", 2, 6)]));
      try {
        const queued = await transitionSteeringQueued(fixture.runDir, "change routing", { now: "2026-07-19T11:00:00.000Z", id: `${state}-steering` });
        if (state === "uncheckpointed") {
          await transitionSteeringConsumed(fixture.runDir, queued.steering, { now: "2026-07-19T11:00:01.000Z" });
        }
        const before = snapshotRouteState(fixture);
        await assert.rejects(
          transitionSlicesSeed(fixture.runDir, pendingProjection(fixture.plan), { from: "plan/slices.json" }),
          state === "pending" ? /pending steering/u : /acknowledgement is pending/u,
        );
        assertRouteStateUnchanged(fixture, before);
        assert.equal(readJson(join(fixture.runDir, "run.json")).status, "running");
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    }
  });

  it("rejects a fresh heartbeat after terminal observation without publishing route state", async () => {
    const fixture = createRoutingFixture("checkpoint-heartbeat", planWithSpecs([unitSpec("api", 2, 6)]));
    try {
      const boundary = await openTerminalBoundary(fixture);
      writeJson(join(fixture.runDir, "heartbeat.json"), heartbeat(fixture.runId));
      const before = snapshotRouteState(fixture);
      await assert.rejects(
        transitionSlicesSeed(fixture.runDir, pendingProjection(fixture.plan), {
          from: "plan/slices.json",
          boundaryToken: boundary.token,
          now: "2026-07-19T12:00:00.000Z",
          processAliveFn: () => true,
        }),
        /active-heartbeat/u,
      );
      assertRouteStateUnchanged(fixture, before);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects incompatible open boundary, action claim, and pre-PR fence authority", async () => {
    const cases = [
      ["boundary", async (fixture) => (await transitionSteeringBoundaryOpened(fixture.runDir, "gate", { token: "checkpoint-gate" })).boundary.token, /terminal boundary token mismatch/u],
      ["action", async (fixture) => {
        const opened = await transitionSteeringBoundaryOpened(fixture.runDir, "dispatch", { token: "checkpoint-dispatch" });
        await transitionSteeringBoundaryCrossed(fixture.runDir, "dispatch", opened.boundary.token, { token: "checkpoint-action" });
        return undefined;
      }, /action start acknowledgement is pending/u],
      ["fence", async (fixture) => {
        const run = readJson(join(fixture.runDir, "run.json"));
        run.steering = {
          schema_version: 1,
          generation: 0,
          pending: null,
          uncheckpointed: null,
          boundary: null,
          action_claim: null,
          last_action: null,
          pr_fence: { token: "checkpoint-fence", generation: 0, state_hash: `sha256:${"a".repeat(64)}`, created_at: "2026-07-19T11:00:00.000Z" },
          history: [],
        };
        writeJson(join(fixture.runDir, "run.json"), run);
        return undefined;
      }, /active pre-PR fence/u],
    ];
    for (const [name, arrange, expected] of cases) {
      const fixture = createRoutingFixture(`checkpoint-incompatible-${name}`, planWithSpecs([unitSpec("api", 2, 6)]));
      try {
        const boundaryToken = await arrange(fixture);
        const before = snapshotRouteState(fixture);
        await assert.rejects(
          transitionSlicesSeed(fixture.runDir, pendingProjection(fixture.plan), { from: "plan/slices.json", boundaryToken }),
          expected,
        );
        assertRouteStateUnchanged(fixture, before);
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    }
  });

  it("rejects Gate 2 and non-placeholder test-verifier state before artifact publication", async () => {
    const cases = [
      ["brief", (run) => { run.gates.brief = { status: "pending" }; }, /before Gate 2 brief state/u],
      ["test-running", (run) => { run.steps[1] = { agent: "test-verifier", status: "running", attempts: 1 }; }, /zero-attempt blocked test-verifier placeholder/u],
      ["test-positive-blocked", (run) => { run.steps[1] = { agent: "test-verifier", status: "blocked", attempts: 1 }; }, /zero-attempt blocked test-verifier placeholder/u],
      ["test-accepted", (run) => { run.steps[1] = { agent: "test-verifier", status: "accepted", attempts: 0 }; }, /zero-attempt blocked test-verifier placeholder/u],
      ["test-rejected", (run) => { run.steps[1] = { agent: "test-verifier", status: "rejected", attempts: 0 }; }, /zero-attempt blocked test-verifier placeholder/u],
      ["test-claim", (run, fixture) => {
        const claim = activeExecutionClaim(run.run_id, hashBytes(readFileSync(join(fixture.runDir, "plan", "slices.json"))));
        run.steps[1] = { agent: "test-verifier", status: "running", attempts: 1, execution_claim: claim, execution_claim_hash: hashValue(claim) };
      }, /zero-attempt blocked test-verifier placeholder/u],
    ];
    for (const [name, mutate, expected] of cases) {
      const fixture = createRoutingFixture(`checkpoint-preimplementation-${name}`, planWithSpecs([unitSpec("api", 2, 6)]));
      try {
        const run = readJson(join(fixture.runDir, "run.json"));
        mutate(run, fixture);
        writeJson(join(fixture.runDir, "run.json"), run);
        const boundary = await openTerminalBoundary(fixture);
        const before = snapshotRouteState(fixture);
        await assert.rejects(
          transitionSlicesSeed(fixture.runDir, pendingProjection(fixture.plan), { from: "plan/slices.json", boundaryToken: boundary.token }),
          expected,
        );
        assertRouteStateUnchanged(fixture, before);
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    }
  });

  it("rejects exact-plan drift inside the observation/publication interval without routing or seeding", async () => {
    const original = planWithSpecs([unitSpec("api", 2, 6)]);
    const fixture = createRoutingFixture("checkpoint-race", original);
    try {
      const raced = structuredClone(original);
      raced.delivery_envelope.delivery_units[0].invariant_families[0].description = "Raced family description";
      const boundary = await openTerminalBoundary(fixture);
      await assert.rejects(
        transitionSlicesSeed(fixture.runDir, pendingProjection(original), {
          from: "plan/slices.json",
          boundaryToken: boundary.token,
          checkpointRoutingHooks: { beforeArtifactCommit: () => writeJson(join(fixture.runDir, "plan", "slices.json"), raced) },
        }),
        (error) => error?.message === "protected file commit failed"
          && /accepted work-decomposer plan ref\/hash does not match exact plan bytes|checkpoint routing plan authority changed before publication/u.test(error.cause?.message),
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

  it("retains a deterministic artifact on plan drift before run replacement and recovers idempotently", async () => {
    const original = planWithSpecs([unitSpec("api", 2, 6)]);
    const fixture = createRoutingFixture("checkpoint-run-publication-race", original);
    try {
      const boundary = await openTerminalBoundary(fixture);
      const raced = structuredClone(original);
      raced.delivery_envelope.delivery_units[0].invariant_families[0].description = "Post-artifact raced description";
      await assert.rejects(
        transitionSlicesSeed(fixture.runDir, pendingProjection(original), {
          from: "plan/slices.json",
          boundaryToken: boundary.token,
          atomicWriteHooks: { beforeCommit: () => writeJson(join(fixture.runDir, "plan", "slices.json"), raced) },
        }),
        (error) => error?.message === "protected file commit failed"
          && /accepted work-decomposer plan ref\/hash does not match exact plan bytes|checkpoint routing plan authority changed before publication/u.test(error.cause?.message),
      );
      const artifactNames = readdirSync(join(fixture.runDir, "artifacts"));
      assert.equal(artifactNames.length, 1);
      const runAfterRace = readJson(join(fixture.runDir, "run.json"));
      assert.equal(runAfterRace.status, "running");
      assert.deepEqual(runAfterRace.slices, []);
      assert.equal(runAfterRace.terminal_result, null);

      writeJson(join(fixture.runDir, "plan", "slices.json"), original);
      const recovered = await transitionSlicesSeed(fixture.runDir, pendingProjection(original), {
        from: "plan/slices.json",
        boundaryToken: boundary.token,
      });
      assert.equal(recovered.route, "checkpoint");
      assert.equal(recovered.updated, true);
      assert.deepEqual(readdirSync(join(fixture.runDir, "artifacts")), artifactNames);
      const replay = await transitionSlicesSeed(fixture.runDir, pendingProjection(original), { from: "plan/slices.json" });
      assert.equal(replay.updated, false);
      assert.deepEqual(replay.checkpoint_routing, recovered.checkpoint_routing);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("routes an integrated five-wave slices plan into topological merged-main checkpoints", async () => {
    const plan = planWithSpecs([
      unitSpec("wave-5", 1, 1, ["wave-4"]),
      unitSpec("wave-1"),
      unitSpec("wave-3", 1, 1, ["wave-2"]),
      unitSpec("wave-2", 1, 1, ["wave-1"]),
      unitSpec("wave-4", 1, 1, ["wave-3"]),
    ]);
    const fixture = createRoutingFixture("checkpoint-five-wave", plan);
    try {
      const boundary = await openTerminalBoundary(fixture);
      const result = await transitionSlicesSeed(fixture.runDir, pendingProjection(plan), { from: "plan/slices.json", boundaryToken: boundary.token });
      const run = readJson(join(fixture.runDir, "run.json"));
      const manifest = readJson(join(fixture.runDir, result.checkpoint_routing.ref));
      assert.equal(result.route, "checkpoint");
      assert.equal(run.status, "blocked");
      assert.deepEqual(run.slices, []);
      assert.deepEqual(manifest.checkpoints.map((checkpoint) => checkpoint.request.acceptance_boundary.slice_id), [
        "wave-1", "wave-2", "wave-3", "wave-4", "wave-5",
      ]);
      assert.deepEqual(manifest.checkpoints.map((checkpoint) => checkpoint.prerequisite_checkpoint_id), [
        null, "checkpoint-001", "checkpoint-002", "checkpoint-003", "checkpoint-004",
      ]);
      assert.equal(manifest.sequencing.next_checkpoint_rule, "Checkpoint N+1 may start only from main containing merged PR N.");
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
  mkdirSync(join(runDir, "reviews"), { recursive: true });
  mkdirSync(join(runDir, "steering"), { recursive: true });
  writeJson(join(runDir, "plan", "slices.json"), plan);
  const planHash = hashBytes(readFileSync(join(runDir, "plan", "slices.json")));
  const review = { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] };
  writeJson(join(runDir, "reviews", "work-decomposer.json"), review);
  const reviewHash = hashBytes(readFileSync(join(runDir, "reviews", "work-decomposer.json")));
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    status: "running",
    gates: {},
    slices: [],
    steps: [
      {
        agent: "work-decomposer", status: "accepted", attempts: 1,
        artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
        acceptance: {
          artifact_ref: "plan/slices.json", artifact_hash: planHash,
          review_ref: "reviews/work-decomposer.json", review_hash: reviewHash,
        },
      },
      { agent: "test-verifier", status: "blocked", attempts: 0 },
    ],
    terminal_result: null,
  });
  return { repo, runDir, runId, plan };
}

function decompositionAuthority(planHash) {
  const review = { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] };
  return {
    plan_ref: "plan/slices.json",
    plan_hash: planHash,
    review_ref: "reviews/work-decomposer.json",
    review_hash: hashBytes(`${JSON.stringify(review)}\n`),
    attempt: 1,
    review,
  };
}

async function openTerminalBoundary(fixture) {
  const result = await transitionSteeringBoundaryOpened(fixture.runDir, "terminal", {
    now: "2026-07-19T11:30:00.000Z",
    token: `terminal-${fixture.runId}`.slice(0, 128),
  });
  return result.boundary;
}

function snapshotRouteState(fixture) {
  return {
    run: readFileSync(join(fixture.runDir, "run.json")),
    artifacts: readdirSync(join(fixture.runDir, "artifacts")),
  };
}

function assertRouteStateUnchanged(fixture, before) {
  assert.deepEqual(readFileSync(join(fixture.runDir, "run.json")), before.run);
  assert.deepEqual(readdirSync(join(fixture.runDir, "artifacts")), before.artifacts);
}

function heartbeat(runId) {
  return {
    schema_version: 1,
    run_id: runId,
    phase: "decomposition-review",
    pid: process.pid,
    last_tick_at: "2026-07-19T11:59:30.000Z",
    interval_ms: 30000,
  };
}

function activeExecutionClaim(runId, planHash) {
  return {
    schema_version: 1,
    kind: "checked-test-execution-claim",
    state: "active",
    nonce: "123e4567-e89b-42d3-a456-426614174000",
    run_id: runId,
    attempt: 1,
    plan_ref: "plan/slices.json",
    plan_hash: planHash,
    head_sha: "a".repeat(40),
    receipt_ref: "evidence/test-verifier.attempt-1.json",
    claimed_at: "2026-07-19T11:00:00.000Z",
  };
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
