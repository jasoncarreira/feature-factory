import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCliCommand } from "../src/cli.js";
import { probeFactorySlices, seedFactorySlices } from "../src/factory.js";
import { transitionRunStep, transitionSteeringBoundaryOpened } from "../src/run-state.js";
import { execFileSync } from "./helpers/git-fixture.js";

describe("factory slices-probe", () => {
  it("returns the closed valid admit and checkpoint records without mutating the run or plan tree", () => {
    for (const decision of ["admit", "checkpoint"]) {
      const fixture = createProbeFixture(`probe-${decision}`, decision);
      try {
        const before = snapshot(fixture.runDir);
        const result = probeFactorySlices(fixture.runId, { cwd: fixture.repo, from: "plan/slices.json" });
        assert.deepEqual(Object.keys(result), [
          "schema_version", "kind", "status", "decision", "plan_ref", "plan_hash", "reasons", "checkpoint_plan_hash", "checkpoints",
        ]);
        assert.equal(result.schema_version, 1);
        assert.equal(result.kind, "delivery-plan-admission-probe");
        assert.equal(result.status, "valid");
        assert.equal(result.decision, decision);
        assert.equal(result.plan_ref, "plan/slices.json");
        assert.equal(result.plan_hash, hashFile(fixture.planPath));
        assert.ok(result.reasons.length > 0);
        if (decision === "admit") {
          assert.equal(result.checkpoint_plan_hash, null);
          assert.deepEqual(result.checkpoints, []);
        } else {
          const checkpointPlanValue = fixture.plan.delivery_envelope.checkpoint_plan;
          assert.equal(result.checkpoint_plan_hash, canonicalHash(checkpointPlanValue));
          assert.deepEqual(result.checkpoints, expectedCheckpointSummaries(checkpointPlanValue));
        }
        assert.deepEqual(snapshot(fixture.runDir), before);
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    }
  });

  it("exposes the same non-mutating valid record through the strict CLI", async () => {
    const fixture = createProbeFixture("probe-cli", "checkpoint");
    const output = [];
    const originalLog = console.log;
    try {
      const before = snapshot(fixture.runDir);
      console.log = (value) => output.push(String(value));
      await runCliCommand(["factory", "slices-probe", fixture.runId, "--from", "plan/slices.json", "--repo", fixture.repo, "--json"]);
      const result = JSON.parse(output.at(-1));
      assert.equal(result.status, "valid");
      assert.equal(result.decision, "checkpoint");
      assert.equal(result.plan_hash, hashFile(fixture.planPath));
      assert.deepEqual(result.checkpoints, expectedCheckpointSummaries(fixture.plan.delivery_envelope.checkpoint_plan));
      assert.deepEqual(snapshot(fixture.runDir), before);
      await assert.rejects(
        runCliCommand(["factory", "slices-probe", fixture.runId, "--from", "other.json", "--repo", fixture.repo, "--json"]),
        /must be exactly plan\/slices\.json/u,
      );
    } finally {
      console.log = originalLog;
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("returns deterministic invalid JSON and schema records without any mutation", () => {
    for (const [name, invalidate] of [
      ["json", (fixture) => writeFileSync(fixture.planPath, "{not-json\n")],
      ["schema", (fixture) => {
        const plan = admitPlan();
        delete plan.slices[0].stack;
        plan.unexpected = true;
        writeJson(fixture.planPath, plan);
      }],
    ]) {
      const fixture = createProbeFixture(`probe-invalid-${name}`, "admit");
      try {
        invalidate(fixture);
        const before = snapshot(fixture.runDir);
        const first = probeFactorySlices(fixture.runId, { cwd: fixture.repo, from: "plan/slices.json" });
        const second = probeFactorySlices(fixture.runId, { cwd: fixture.repo, from: "plan/slices.json" });
        assert.deepEqual(first, second);
        assert.deepEqual(Object.keys(first), [
          "schema_version", "kind", "status", "decision", "plan_ref", "plan_hash", "reasons", "checkpoint_plan_hash", "checkpoints", "errors",
        ]);
        assert.equal(first.schema_version, 1);
        assert.equal(first.kind, "delivery-plan-admission-probe");
        assert.equal(first.status, "invalid");
        assert.equal(first.decision, null);
        assert.equal(first.plan_ref, "plan/slices.json");
        assert.equal(first.plan_hash, hashFile(fixture.planPath));
        assert.deepEqual(first.reasons, []);
        assert.equal(first.checkpoint_plan_hash, null);
        assert.deepEqual(first.checkpoints, []);
        assert.ok(first.errors.length > 0);
        assert.ok(first.errors.every((error) => Object.keys(error).join(",") === "path,message" && error.path && error.message));
        assert.deepEqual(snapshot(fixture.runDir), before);
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    }
  });

  it("prints invalid JSON through the CLI and sets a nonzero exit code", async () => {
    const fixture = createProbeFixture("probe-cli-invalid", "admit");
    const output = [];
    const originalLog = console.log;
    const originalExitCode = process.exitCode;
    try {
      writeFileSync(fixture.planPath, "{not-json\n");
      const before = snapshot(fixture.runDir);
      console.log = (value) => output.push(String(value));
      process.exitCode = undefined;
      const result = await runCliCommand(["factory", "slices-probe", fixture.runId, "--from", "plan/slices.json", "--repo", fixture.repo, "--json"]);
      assert.equal(result.status, "invalid");
      assert.deepEqual(JSON.parse(output.at(-1)), result);
      assert.notEqual(process.exitCode ?? 0, 0);
      assert.deepEqual(snapshot(fixture.runDir), before);
    } finally {
      process.exitCode = originalExitCode;
      console.log = originalLog;
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects checkpoint routing after probed accepted bytes drift", async () => {

    const drift = createProbeFixture("probe-drift", "checkpoint");
    try {
      const probed = probeFactorySlices(drift.runId, { cwd: drift.repo, from: "plan/slices.json" });
      writeCheckpointReview(drift, probed);
      await transitionRunStep(drift.runDir, "work-decomposer", {
        status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
      });
      const acceptedRun = readFileSync(join(drift.runDir, "run.json"));
      const changed = checkpointPlan();
      changed.slices[0].acceptance = ["changed after probe and acceptance"];
      writeJson(drift.planPath, changed);
      assert.notEqual(hashFile(drift.planPath), probed.plan_hash);
      await assert.rejects(
        seedFactorySlices(drift.runId, { cwd: drift.repo, from: "plan/slices.json" }),
        /accepted decomposition|plan ref\/hash|binding|stale|exact requested plan bytes|acceptance_inventory/u,
      );
      assert.deepEqual(readFileSync(join(drift.runDir, "run.json")), acceptedRun);
      assert.equal(readdirSync(join(drift.runDir, "artifacts")).length, 0);
    } finally {
      rmSync(drift.repo, { recursive: true, force: true });
    }
  });

  it("rejects routing when reviewed probe authority drifts from the observed probe", async () => {
    const fixture = createProbeFixture("probe-authority-drift", "checkpoint");
    try {
      const probe = probeFactorySlices(fixture.runId, { cwd: fixture.repo, from: "plan/slices.json" });
      const staleProbe = structuredClone(probe);
      staleProbe.reasons = [...staleProbe.reasons, "stale-review-only-reason"];
      writeCheckpointReview(fixture, staleProbe);
      await transitionRunStep(fixture.runDir, "work-decomposer", {
        status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
      });
      const boundary = await transitionSteeringBoundaryOpened(fixture.runDir, "terminal", { token: "probe-authority-drift-boundary" });
      const before = snapshot(fixture.runDir);
      await assert.rejects(
        seedFactorySlices(fixture.runId, {
          cwd: fixture.repo,
          from: "plan/slices.json",
          boundaryToken: boundary.boundary.token,
        }),
        /admission probe/u,
      );
      assert.deepEqual(snapshot(fixture.runDir), before);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });
});

function createProbeFixture(runId, decision) {
  const repo = mkdtempSync(join(tmpdir(), "slices-probe-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "fixture"]);
  const runDir = join(repo, ".opencode", "factory", runId);
  for (const directory of ["plan", "reviews", "artifacts"]) mkdirSync(join(runDir, directory), { recursive: true });
  const planPath = join(runDir, "plan", "slices.json");
  const plan = decision === "checkpoint" ? checkpointPlan() : admitPlan();
  writeJson(planPath, plan);
  writeJson(join(runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] });
  writeJson(join(runDir, "run.json"), {
    schema_version: 1,
    run_id: runId,
    status: "running",
    branch: "main",
    worktree: repo,
    gates: {},
    slices: [],
    steps: [{ agent: "work-decomposer", status: "running", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json" }],
  });
  return { repo, runId, runDir, planPath, plan };
}

function admitPlan() {
  return planWithFamilies(1, 1);
}

function checkpointPlan() {
  return planWithFamilies(2, 6);
}

function planWithFamilies(familyCount, obligationCount) {
  const families = Array.from({ length: familyCount }, (_, index) => ({ id: `family-${index + 1}`, description: `Family ${index + 1}` }));
  const artifacts = Array.from({ length: obligationCount }, (_, index) => ({ id: `tests-${index + 1}`, test_plan_index: index, test_plan_entry: `node --version ${index + 1}`, timeout_ms: 600_000 }));
  const obligations = Array.from({ length: obligationCount }, (_, index) => ({
    id: `obligation-${index + 1}`,
    description: `Obligation ${index + 1}`,
    invariant_family_id: families[index % families.length].id,
    verification_artifact_id: artifacts[index].id,
  }));
  const plan = {
    slices: [{
      id: "slice",
      stack: "backend",
      paths: ["README.md"],
      depends_on: [],
      acceptance: Array.from({ length: familyCount }, (_, index) => `works ${index + 1}`),
      test_plan: artifacts.map((artifact) => artifact.test_plan_entry),
    }],
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }], timeout_ms: 600_000 },
    delivery_envelope: {
      schema_version: 1,
      delivery_units: [{ id: "slice-unit", slice_id: "slice", invariant_families: families, obligations, verification_artifacts: artifacts }],
    },
  };
  if (familyCount > 1) plan.delivery_envelope.checkpoint_plan = reviewedCheckpointPlan(plan);
  return plan;
}

function reviewedCheckpointPlan(plan) {
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
        title: `Deliver family ${index + 1}`,
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
            verification_artifacts: artifacts.map((artifact, artifactIndex) => ({
              ...structuredClone(artifact),
              test_plan_index: artifactIndex,
            })),
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

function expectedCheckpointSummaries(checkpointPlanValue) {
  const inventoryById = new Map(checkpointPlanValue.acceptance_inventory.map((row) => [row.id, row]));
  const mappingById = new Map(checkpointPlanValue.acceptance_mappings.map((mapping) => [mapping.acceptance_id, mapping]));
  return checkpointPlanValue.checkpoints.map((checkpoint) => ({
    checkpoint_id: checkpoint.id,
    ordinal: checkpoint.ordinal,
    brief_scope_hash: canonicalHash(checkpoint.brief_scope),
    child_plan_hash: canonicalHash(checkpoint.child_plan),
    acceptance_mapping_hash: canonicalHash({
      acceptance_ids: checkpoint.acceptance_ids,
      acceptance_inventory: checkpoint.acceptance_ids.map((id) => inventoryById.get(id)),
      acceptance_mappings: checkpoint.acceptance_ids.map((id) => mappingById.get(id)),
    }),
  }));
}

function writeCheckpointReview(fixture, admissionProbe) {
  const reviewRef = "reviews/work-decomposer.json";
  const identityFields = {
    schema_version: 1,
    subject: "work-decomposer",
    attempt: 1,
    plan_ref: "plan/slices.json",
    plan_hash: hashFile(fixture.planPath),
    review_ref: reviewRef,
  };
  const reviewIdentity = { ...identityFields, identity_hash: canonicalHash(identityFields) };
  writeJson(join(fixture.runDir, reviewRef), {
    schema_version: 1,
    subject: "work-decomposer",
    attempt: 1,
    verdict: "APPROVE-CHECKPOINT",
    required_fixes: [],
    admission_probe: admissionProbe,
    review_identity: reviewIdentity,
    checkpoint_dispositions: admissionProbe.checkpoints.map((checkpoint) => ({
      schema_version: 1,
      kind: "checkpoint-child-decomposition-review",
      subject: "work-decomposer",
      attempt: 1,
      verdict: "APPROVE",
      required_fixes: [],
      checkpoint_id: checkpoint.checkpoint_id,
      checkpoint_ordinal: checkpoint.ordinal,
      reviewed_plan_ref: "plan/slices.json",
      reviewed_plan_hash: checkpoint.child_plan_hash,
      child_plan_hash: checkpoint.child_plan_hash,
      brief_scope_hash: checkpoint.brief_scope_hash,
      acceptance_mapping_hash: checkpoint.acceptance_mapping_hash,
      parent_review_identity: structuredClone(reviewIdentity),
    })),
  });
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalHash(value) {
  return `sha256:${createHash("sha256").update(`${JSON.stringify(canonicalValue(value), null, 2)}\n`).digest("hex")}`;
}

function snapshot(root) {
  const result = {};
  const visit = (directory, prefix = "") => {
    for (const name of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${name.name}` : name.name;
      const path = join(directory, name.name);
      if (name.isDirectory()) visit(path, relative);
      else result[relative] = readFileSync(path).toString("base64");
    }
  };
  visit(root);
  return result;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hashFile(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
