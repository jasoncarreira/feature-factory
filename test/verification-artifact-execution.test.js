import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { execFileSync, spawn } from "./helpers/git-fixture.js";
import { claimCheckedVerificationArtifactExecution, completeCheckedVerificationArtifactExecution } from "../src/run-state.js";
import { executeCheckedVerificationArtifact } from "../src/test-execution.js";

describe("checked verification artifact execution", () => {
  it("executes the exact current artifact command and publishes a current closed receipt", async () => {
    const repo = mkdtempSync(join(tmpdir(), "verification-artifact-"));
    try {
      git(repo, ["init", "-b", "slice-branch"]);
      git(repo, ["config", "user.email", "test@example.com"]);
      git(repo, ["config", "user.name", "Test"]);
      writeFileSync(join(repo, "README.md"), "fixture\n");
      git(repo, ["add", "README.md"]);
      git(repo, ["commit", "-m", "fixture"]);
      const head = git(repo, ["rev-parse", "HEAD"]);
      const runDir = join(repo, ".opencode", "factory", "artifact-run");
      for (const directory of ["plan", "reviews", "evidence"]) mkdirSync(join(runDir, directory), { recursive: true });
      const plan = {
        slices: [{ id: "slice", stack: "backend", paths: ["README.md"], depends_on: [], acceptance: ["works"], test_plan: ["node --version"] }],
        integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
        delivery_envelope: {
          schema_version: 1,
          delivery_units: [{
            id: "slice-unit", slice_id: "slice",
            invariant_families: [{ id: "slice-family", description: "Slice behavior" }],
            obligations: [{ id: "slice-obligation", description: "Verify behavior", invariant_family_id: "slice-family", verification_artifact_id: "slice-tests" }],
            verification_artifacts: [{ id: "slice-tests", test_plan_index: 0, test_plan_entry: "node --version" }],
          }],
        },
      };
      writeJson(join(runDir, "plan", "slices.json"), plan);
      const review = { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] };
      writeJson(join(runDir, "reviews", "work-decomposer.json"), review);
      writeJson(join(runDir, "run.json"), {
        schema_version: 1, run_id: "artifact-run", status: "running", branch: "slice-branch", worktree: repo, gates: {},
        slices: [{ id: "slice", stack: "backend", depends_on: [], declared_paths: ["README.md"], effective_paths: ["README.md"], status: "running", attempts: 1, branch: "slice-branch", worktree: repo }],
        steps: [{
          agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json",
          acceptance: {
            artifact_ref: "plan/slices.json", artifact_hash: hashFile(join(runDir, "plan", "slices.json")),
            review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(runDir, "reviews", "work-decomposer.json")),
          },
        }],
      });

      const result = await executeCheckedVerificationArtifact(runDir, "slice", "slice-tests", { env: process.env });
      assert.equal(result.receipt.subject, "slice");
      assert.equal(result.receipt.attempt, 1);
      assert.equal(result.receipt.head_sha, head);
      assert.equal(result.receipt.verification_artifact_id, "slice-tests");
      assert.deepEqual(result.receipt.probe, {
        type: "verification-artifact", verification_artifact_id: "slice-tests", test_plan_index: 0,
        test_plan_entry: "node --version", program: "node", args: ["--version"],
      });
      assert.equal(result.receipt.status, "pass");
      assert.deepEqual(result.receipt.result, { type: "verification-result", outcome: "pass", summary: "Verification artifact command passed" });
      assert.equal(hashFile(join(runDir, result.authority.receipt_ref)), result.receipt_hash);

      const replay = await executeCheckedVerificationArtifact(runDir, "slice", "slice-tests", { env: process.env });
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.receipt, result.receipt);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("publishes a durable claim before spawn and rejects concurrent duplicate execution", async () => {
    const fixture = createArtifactFixture("artifact-concurrent");
    let spawns = 0;
    try {
      const options = { env: process.env, spawnFn(...args) { spawns += 1; return spawn(...args); } };
      const results = await Promise.allSettled([
        executeCheckedVerificationArtifact(fixture.runDir, "slice", "slice-tests", options),
        executeCheckedVerificationArtifact(fixture.runDir, "slice", "slice-tests", options),
      ]);
      assert.equal(spawns, 1);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("fails closed after a durable claim crash before spawn", async () => {
    const fixture = createArtifactFixture("artifact-pre-spawn-crash");
    try {
      await assert.rejects(executeCheckedVerificationArtifact(fixture.runDir, "slice", "slice-tests", {
        env: process.env,
        afterArtifactClaim: () => { throw new Error("injected after-claim crash"); },
      }), /injected after-claim crash/u);
      await assert.rejects(
        executeCheckedVerificationArtifact(fixture.runDir, "slice", "slice-tests", { env: process.env }),
        /active|reconciliation/u,
      );
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects a pre-created valid-looking receipt that has no durable claim", async () => {
    const fixture = createArtifactFixture("artifact-forged-receipt");
    try {
      const authority = artifactAuthority(fixture);
      writeJson(join(fixture.runDir, authority.receipt_ref), artifactReceipt(authority, "123e4567-e89b-42d3-a456-426614174000"));
      await assert.rejects(
        executeCheckedVerificationArtifact(fixture.runDir, "slice", "slice-tests", { env: process.env }),
        /without a claim|unclaimed receipt/u,
      );
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects a receipt whose nonce does not match the exact active claim", async () => {
    const fixture = createArtifactFixture("artifact-wrong-nonce");
    try {
      const claimed = await claimCheckedVerificationArtifactExecution(fixture.runDir, "slice", "slice-tests");
      assert.equal(claimed.claim.state, "active");
      const receipt = artifactReceipt(claimed.authority, "123e4567-e89b-42d3-a456-426614174000");
      assert.notEqual(receipt.claim_nonce, claimed.claim.nonce);
      await assert.rejects(
        completeCheckedVerificationArtifactExecution(fixture.runDir, claimed.claim, claimed.authority, receipt),
        /nonce|active claim/u,
      );
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("marks the claim unknown when execution crashes after the process was spawned", async () => {
    const fixture = createArtifactFixture("artifact-post-spawn-crash");
    try {
      await assert.rejects(executeCheckedVerificationArtifact(fixture.runDir, "slice", "slice-tests", {
        env: process.env,
        afterArtifactProcess: () => { throw new Error("injected post-spawn crash"); },
      }), /operator.*reconciliation|post-spawn crash/u);
      await assert.rejects(
        executeCheckedVerificationArtifact(fixture.runDir, "slice", "slice-tests", { env: process.env }),
        /unknown|reconciliation/u,
      );
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("retains fail-closed receipt authority when completion crashes after receipt publication", async () => {
    const fixture = createArtifactFixture("artifact-post-receipt-crash");
    try {
      await assert.rejects(executeCheckedVerificationArtifact(fixture.runDir, "slice", "slice-tests", {
        env: process.env,
        afterArtifactReceiptPublication: () => { throw new Error("injected post-receipt crash"); },
      }), /operator.*reconciliation|post-receipt crash/u);
      await assert.rejects(
        executeCheckedVerificationArtifact(fixture.runDir, "slice", "slice-tests", { env: process.env }),
        /unknown|reconciliation/u,
      );
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });
});

function createArtifactFixture(runId) {
  const repo = mkdtempSync(join(tmpdir(), "verification-artifact-fixture-"));
  git(repo, ["init", "-b", "slice-branch"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "fixture"]);
  const runDir = join(repo, ".opencode", "factory", runId);
  for (const directory of ["plan", "reviews", "evidence"]) mkdirSync(join(runDir, directory), { recursive: true });
  const plan = {
    slices: [{ id: "slice", stack: "backend", paths: ["README.md"], depends_on: [], acceptance: ["works"], test_plan: ["node --version"] }],
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    delivery_envelope: { schema_version: 1, delivery_units: [{
      id: "slice-unit", slice_id: "slice", invariant_families: [{ id: "slice-family", description: "Slice behavior" }],
      obligations: [{ id: "slice-obligation", description: "Verify behavior", invariant_family_id: "slice-family", verification_artifact_id: "slice-tests" }],
      verification_artifacts: [{ id: "slice-tests", test_plan_index: 0, test_plan_entry: "node --version" }],
    }] },
  };
  writeJson(join(runDir, "plan", "slices.json"), plan);
  writeJson(join(runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] });
  writeJson(join(runDir, "run.json"), {
    schema_version: 1, run_id: runId, status: "running", branch: "slice-branch", worktree: repo, gates: {},
    slices: [{ id: "slice", stack: "backend", depends_on: [], declared_paths: ["README.md"], effective_paths: ["README.md"], status: "running", attempts: 1, branch: "slice-branch", worktree: repo }],
    steps: [{ agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json", acceptance: {
      artifact_ref: "plan/slices.json", artifact_hash: hashFile(join(runDir, "plan", "slices.json")),
      review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(runDir, "reviews", "work-decomposer.json")),
    } }],
  });
  return { repo, runDir, runId, head: git(repo, ["rev-parse", "HEAD"]), planHash: hashFile(join(runDir, "plan", "slices.json")) };
}

function artifactAuthority(fixture) {
  return {
    run_id: fixture.runId, slice_id: "slice", attempt: 1, plan_ref: "plan/slices.json", plan_hash: fixture.planHash,
    head_sha: fixture.head, verification_artifact_id: "slice-tests",
    probe: { type: "verification-artifact", verification_artifact_id: "slice-tests", test_plan_index: 0, test_plan_entry: "node --version", program: "node", args: ["--version"] },
    worktree: fixture.repo, receipt_ref: "evidence/slice.artifact-slice-tests.attempt-1.json",
  };
}

function artifactReceipt(authority, nonce) {
  const stream = { captured_bytes: 0, sha256: `sha256:${createHash("sha256").digest("hex")}`, truncated: false };
  return {
    schema_version: 1, kind: "checked-verification-artifact-execution-receipt", subject: authority.slice_id,
    run_id: authority.run_id, slice_id: authority.slice_id, attempt: authority.attempt, claim_nonce: nonce,
    plan_ref: authority.plan_ref, plan_hash: authority.plan_hash, head_sha: authority.head_sha,
    verification_artifact_id: authority.verification_artifact_id, probe: authority.probe,
    started_at: "2026-07-19T12:00:00.000Z", completed_at: "2026-07-19T12:00:00.001Z", duration_ms: 1,
    status: "pass", review_ready: true,
    commands: [{ index: 0, program: "node", args: ["--version"], outcome: "exited", status: "pass", exit_code: 0, signal: null, error_code: null, duration_ms: 1, stdout: stream, stderr: stream }],
    result: { type: "verification-result", outcome: "pass", summary: "Verification artifact command passed" },
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
