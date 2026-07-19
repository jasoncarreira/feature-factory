import assert from "node:assert/strict";
import { execFileSync } from "./helpers/git-fixture.js";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildCheckpointRoutingManifest, checkpointRoutingArtifact } from "../src/delivery-envelope/checkpoint-routing.js";
import { evaluateDeliveryEnvelopeAdmission } from "../src/delivery-envelope/admission-extension.js";
import { startFactoryCheckpoint } from "../src/factory.js";
import { decodeFeatureCommandPayload } from "../src/feature-command-payload.js";

describe("checked checkpoint child start", () => {
  it("binds ordinal 1 to exact reviewed parent, manifest, request, and current main with no-replace reservations", async () => {
    const fixture = createFixture("checkpoint-parent-one");
    try {
      const launched = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo,
        runId: "checkpoint-child-one",
        checkpointLaunchFn: (value) => value,
      });
      assert.equal(launched.binding.parent_run_id, fixture.parentRunId);
      assert.equal(launched.binding.manifest_ref, fixture.artifact.ref);
      assert.equal(launched.binding.manifest_hash, fixture.artifact.hash);
      assert.equal(launched.binding.checkpoint_id, "checkpoint-001");
      assert.equal(launched.binding.checkpoint_ordinal, 1);
      assert.equal(launched.binding.child_run_id, "checkpoint-child-one");
      assert.equal(launched.binding.base_ref, "refs/heads/main");
      assert.equal(launched.binding.base_commit, fixture.baseCommit);
      assert.equal(launched.binding.predecessor_checkpoint_id, null);
      assert.deepEqual(launched.payload.checkpoint, launched.binding);
      assert.deepEqual(launched.payload.checkpoint_request, fixture.manifest.checkpoints[0].request);
      assert.match(launched.commandArgs.at(-1), /^ffpayload-v1:/u);
      const decoded = decodeFeatureCommandPayload(launched.commandArgs.at(-1), { repo: fixture.repo });
      assert.equal(decoded.ok, true);
      assert.deepEqual(decoded.payload.checkpoint, launched.binding);

      const routeRef = `refs/opencode/checkpoint-routes/${createHash("sha256").update(`${fixture.parentRunId}\0checkpoint-001`, "utf8").digest("hex")}`;
      git(fixture.repo, ["update-ref", "-d", routeRef]);
      assert.deepEqual(decodeFeatureCommandPayload(launched.commandArgs.at(-1), { repo: fixture.repo }), {
        ok: false,
        reason: "invalid-checkpoint-authority",
      });

      await assert.rejects(
        startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
          cwd: fixture.repo, runId: "checkpoint-child-one", checkpointLaunchFn: (value) => value,
        }),
        /already reserved|already has a child run/u,
      );
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("requires every predecessor completed normal PR and a verified merge commit on current main", async () => {
    const fixture = createFixture("checkpoint-parent-two");
    try {
      const first = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-child-one", checkpointLaunchFn: (value) => value,
      });
      git(fixture.repo, ["checkout", "-b", "checkpoint-child-one"]);
      writeFileSync(join(fixture.repo, "child.txt"), "child\n");
      git(fixture.repo, ["add", "child.txt"]);
      git(fixture.repo, ["commit", "-m", "checkpoint child"]);
      const childHead = git(fixture.repo, ["rev-parse", "HEAD"]);
      git(fixture.repo, ["checkout", "main"]);
      git(fixture.repo, ["merge", "--no-ff", "checkpoint-child-one", "-m", "merge checkpoint child"]);
      const mergeCommit = git(fixture.repo, ["rev-parse", "HEAD"]);
      publishCompletedChild(fixture, first.binding, childHead);

      await assert.rejects(
        startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
          cwd: fixture.repo, runId: "checkpoint-child-two", checkpointLaunchFn: (value) => value,
        }),
        /--predecessor-merge-commit/u,
      );
      const second = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        cwd: fixture.repo, runId: "checkpoint-child-two", predecessorMergeCommit: mergeCommit,
        checkpointLaunchFn: (value) => value,
      });
      assert.equal(second.binding.predecessor_checkpoint_id, "checkpoint-001");
      assert.equal(second.binding.predecessor_child_run_id, "checkpoint-child-one");
      assert.equal(second.binding.predecessor_merge_commit, mergeCommit);
      assert.equal(second.binding.base_commit, mergeCommit);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects reviewed source or manifest drift inside the reservation interval", async () => {
    const fixture = createFixture("checkpoint-parent-race");
    try {
      await assert.rejects(
        startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
          cwd: fixture.repo,
          runId: "checkpoint-raced-child",
          checkpointLaunchFn: (value) => value,
          beforeCheckpointReservation: () => writeFileSync(join(fixture.parentRunDir, fixture.artifact.ref), "{}\n"),
        }),
        /parent or manifest authority changed/u,
      );
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });
});

function createFixture(parentRunId) {
  const repo = mkdtempSync(join(tmpdir(), "checkpoint-start-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "fixture"]);
  const baseCommit = git(repo, ["rev-parse", "HEAD"]);
  const parentRunDir = join(repo, ".opencode", "factory", parentRunId);
  for (const directory of ["plan", "reviews", "artifacts"]) mkdirSync(join(parentRunDir, directory), { recursive: true });
  const plan = checkpointPlan();
  writeJson(join(parentRunDir, "plan", "slices.json"), plan);
  const review = { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] };
  writeJson(join(parentRunDir, "reviews", "work-decomposer.json"), review);
  const planHash = hashFile(join(parentRunDir, "plan", "slices.json"));
  const reviewHash = hashFile(join(parentRunDir, "reviews", "work-decomposer.json"));
  const admissionResult = evaluateDeliveryEnvelopeAdmission({ plan });
  const manifest = buildCheckpointRoutingManifest({
    plan, planHash, admissionResult,
    decompositionAuthority: {
      plan_ref: "plan/slices.json", plan_hash: planHash,
      review_ref: "reviews/work-decomposer.json", review_hash: reviewHash,
      attempt: 1, review,
    },
  });
  const artifact = checkpointRoutingArtifact(manifest);
  writeFileSync(join(parentRunDir, artifact.ref), artifact.bytes);
  writeJson(join(parentRunDir, "run.json"), {
    schema_version: 1, run_id: parentRunId, status: "blocked", base_ref: "refs/heads/main", base_commit: baseCommit,
    branch: "main", worktree: repo, gates: {}, slices: [],
    steps: [{
      agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
      acceptance: { artifact_ref: "plan/slices.json", artifact_hash: planHash, review_ref: "reviews/work-decomposer.json", review_hash: reviewHash },
    }, { agent: "test-verifier", status: "blocked", attempts: 0 }],
    terminal_result: {
      status: "blocked", run_id: parentRunId, pr_url: null, reason: "oversized-plan-checkpoint-routing-required",
      summary: "Oversized plan routed to 2 sequential independently shippable checkpoints.",
      artifacts: { checkpoint_routing: artifact.ref },
    },
  });
  return { repo, parentRunId, parentRunDir, baseCommit, plan, manifest, artifact };
}

function publishCompletedChild(fixture, binding, headSha) {
  const runDir = join(fixture.repo, ".opencode", "factory", binding.child_run_id);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, "run.json"), {
    schema_version: 1, run_id: binding.child_run_id, status: "completed", branch: binding.child_run_id,
    worktree: join(fixture.repo, ".opencode", "worktrees", binding.child_run_id), gates: {}, checkpoint: binding,
    pr_url: "https://github.com/acme/repo/pull/1",
    terminal_result: {
      status: "completed", run_id: binding.child_run_id, reason: null, summary: "PR created.", artifacts: {},
      pr_url: "https://github.com/acme/repo/pull/1", pr_number: 1, pr_node_id: "PR_checkpoint_1", repository: "acme/repo",
      operation_id: `ffpr-v1-${"d".repeat(64)}`, head_ref: binding.child_run_id, head_sha: headSha,
      base_ref: "main", base_sha: binding.base_commit, draft: false,
    },
  });
}

function checkpointPlan() {
  return {
    slices: [{ id: "backend", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["works"], test_plan: ["node --test", "node --version", "node -p 1", "node -p 2", "node -p 3", "node -p 4"] }],
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    delivery_envelope: {
      schema_version: 1,
      delivery_units: [{
        id: "backend-unit", slice_id: "backend",
        invariant_families: [{ id: "behavior", description: "Behavior" }, { id: "security", description: "Security" }],
        obligations: [
          ...[1, 2, 3].map((number) => ({ id: `behavior-${number}`, description: `Behavior ${number}`, invariant_family_id: "behavior", verification_artifact_id: `artifact-${number}` })),
          ...[1, 2, 3].map((number) => ({ id: `security-${number}`, description: `Security ${number}`, invariant_family_id: "security", verification_artifact_id: `artifact-${number + 3}` })),
        ],
        verification_artifacts: [
          { id: "artifact-1", test_plan_index: 0, test_plan_entry: "node --test" },
          { id: "artifact-2", test_plan_index: 1, test_plan_entry: "node --version" },
          { id: "artifact-3", test_plan_index: 2, test_plan_entry: "node -p 1" },
          { id: "artifact-4", test_plan_index: 3, test_plan_entry: "node -p 2" },
          { id: "artifact-5", test_plan_index: 4, test_plan_entry: "node -p 3" },
          { id: "artifact-6", test_plan_index: 5, test_plan_entry: "node -p 4" },
        ],
      }],
    },
  };
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hashFile(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}
