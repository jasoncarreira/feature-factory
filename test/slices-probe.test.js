import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCliCommand } from "../src/cli.js";
import { probeFactorySlices, seedFactorySlices } from "../src/factory.js";
import { transitionRunStep } from "../src/run-state.js";
import { execFileSync } from "./helpers/git-fixture.js";

describe("factory slices-probe", () => {
  it("returns a typed active decision without mutating the run or plan tree", () => {
    for (const decision of ["admit", "checkpoint"]) {
      const fixture = createProbeFixture(`probe-${decision}`, decision);
      try {
        const before = snapshot(fixture.runDir);
        const result = probeFactorySlices(fixture.runId, { cwd: fixture.repo, from: "plan/slices.json" });
        assert.deepEqual(Object.keys(result), ["decision", "reasons", "plan_hash"]);
        assert.equal(result.decision, decision);
        assert.equal(result.plan_hash, hashFile(fixture.planPath));
        assert.ok(result.reasons.length > 0);
        assert.deepEqual(snapshot(fixture.runDir), before);
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    }
  });

  it("exposes the same non-mutating decision through the strict CLI", async () => {
    const fixture = createProbeFixture("probe-cli", "checkpoint");
    const output = [];
    const originalLog = console.log;
    try {
      const before = snapshot(fixture.runDir);
      console.log = (value) => output.push(String(value));
      await runCliCommand(["factory", "slices-probe", fixture.runId, "--from", "plan/slices.json", "--repo", fixture.repo, "--json"]);
      const result = JSON.parse(output.at(-1));
      assert.equal(result.decision, "checkpoint");
      assert.equal(result.plan_hash, hashFile(fixture.planPath));
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

  it("rejects invalid plans and checkpoint routing after probed accepted bytes drift", async () => {
    const invalid = createProbeFixture("probe-invalid", "admit");
    try {
      writeFileSync(invalid.planPath, "{not-json\n");
      const beforeRun = readFileSync(join(invalid.runDir, "run.json"));
      assert.throws(() => probeFactorySlices(invalid.runId, { cwd: invalid.repo, from: "plan/slices.json" }), /valid JSON/u);
      assert.deepEqual(readFileSync(join(invalid.runDir, "run.json")), beforeRun);
    } finally {
      rmSync(invalid.repo, { recursive: true, force: true });
    }

    const drift = createProbeFixture("probe-drift", "checkpoint");
    try {
      const probed = probeFactorySlices(drift.runId, { cwd: drift.repo, from: "plan/slices.json" });
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
        /accepted decomposition|plan ref\/hash|binding|stale|exact requested plan bytes/u,
      );
      assert.deepEqual(readFileSync(join(drift.runDir, "run.json")), acceptedRun);
      assert.equal(readdirSync(join(drift.runDir, "artifacts")).length, 0);
    } finally {
      rmSync(drift.repo, { recursive: true, force: true });
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
  writeJson(planPath, decision === "checkpoint" ? checkpointPlan() : admitPlan());
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
  return { repo, runId, runDir, planPath };
}

function admitPlan() {
  return planWithFamilies(1, 1);
}

function checkpointPlan() {
  return planWithFamilies(2, 6);
}

function planWithFamilies(familyCount, obligationCount) {
  const families = Array.from({ length: familyCount }, (_, index) => ({ id: `family-${index + 1}`, description: `Family ${index + 1}` }));
  const artifacts = Array.from({ length: obligationCount }, (_, index) => ({ id: `tests-${index + 1}`, test_plan_index: index, test_plan_entry: `node --version ${index + 1}` }));
  const obligations = Array.from({ length: obligationCount }, (_, index) => ({
    id: `obligation-${index + 1}`,
    description: `Obligation ${index + 1}`,
    invariant_family_id: families[index % families.length].id,
    verification_artifact_id: artifacts[index].id,
  }));
  return {
    slices: [{
      id: "slice",
      stack: "backend",
      paths: ["README.md"],
      depends_on: [],
      acceptance: ["works"],
      test_plan: artifacts.map((artifact) => artifact.test_plan_entry),
    }],
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    delivery_envelope: {
      schema_version: 1,
      delivery_units: [{ id: "slice-unit", slice_id: "slice", invariant_families: families, obligations, verification_artifacts: artifacts }],
    },
  };
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
