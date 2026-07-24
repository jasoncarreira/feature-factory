import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { execFileSync, spawn } from "./helpers/git-fixture.js";
import { claimCheckedVerificationArtifactExecution, completeCheckedVerificationArtifactExecution } from "../src/run-state.js";
import { executeCheckedVerificationArtifact } from "../src/test-execution.js";
import { evaluateInvariantFamilyReview } from "../src/delivery-envelope/review-extension.js";
import { verificationArtifactExecutionClaimRef, verificationArtifactExecutionReceiptRef } from "../src/verification-artifact-refs.js";
import { validateVerificationArtifactExecutionReceipt } from "../src/validate.js";

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
            verification_artifacts: [{ id: "slice-tests", test_plan_index: 0, test_plan_entry: "node --version", timeout_ms: 420_000 }],
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
      assert.equal(result.authority.timeout_ms, 420_000);
      assert.equal(result.claim.timeout_ms, 420_000);
      assert.equal(result.receipt.timeout_ms, 420_000);
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
    let releaseFirst;
    let firstExecution;
    const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });
    try {
      const options = { env: process.env, spawnFn(...args) { spawns += 1; return spawn(...args); } };
      let markFirstClaimed;
      const claimPublished = new Promise((resolve) => { markFirstClaimed = resolve; });
      firstExecution = executeCheckedVerificationArtifact(fixture.runDir, "slice", "slice-tests", {
        ...options,
        afterArtifactClaim: async () => {
          markFirstClaimed();
          await holdFirst;
        },
      });
      await claimPublished;
      const duplicate = await Promise.allSettled([
        executeCheckedVerificationArtifact(fixture.runDir, "slice", "slice-tests", options),
      ]);
      assert.equal(duplicate[0].status, "rejected");
      releaseFirst();
      await firstExecution;
      assert.equal(spawns, 1);
    } finally {
      releaseFirst?.();
      await firstExecution?.catch(() => undefined);
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

  it("binds command results to the exact probe during validation, completion, and replay", async () => {
    for (const [name, mutate] of [
      ["program", (command) => { command.program = "npm"; }],
      ["args", (command) => { command.args = ["--test"]; }],
    ]) {
      const completionFixture = createArtifactFixture(`artifact-command-completion-${name}`);
      try {
        const claimed = await claimCheckedVerificationArtifactExecution(completionFixture.runDir, "slice", "slice-tests");
        const receipt = artifactReceipt(claimed.authority, claimed.claim.nonce);
        mutate(receipt.commands[0]);
        assert.throws(() => validateVerificationArtifactExecutionReceipt(receipt), /must equal receipt\.probe/u, name);
        await assert.rejects(
          completeCheckedVerificationArtifactExecution(completionFixture.runDir, claimed.claim, claimed.authority, receipt),
          /must equal receipt\.probe|authoritative probe/u,
          name,
        );
        const claimRef = verificationArtifactExecutionClaimRef(claimed.authority.receipt_ref);
        assert.equal(JSON.parse(readFileSync(join(completionFixture.runDir, claimRef), "utf8")).state, "active", name);
      } finally {
        rmSync(completionFixture.repo, { recursive: true, force: true });
      }

      const replayFixture = createArtifactFixture(`artifact-command-replay-${name}`);
      try {
        const authority = artifactAuthority(replayFixture);
        const nonce = "123e4567-e89b-42d3-a456-426614174000";
        const receipt = artifactReceipt(authority, nonce);
        mutate(receipt.commands[0]);
        writeJson(join(replayFixture.runDir, authority.receipt_ref), receipt);
        writeJson(join(replayFixture.runDir, verificationArtifactExecutionClaimRef(authority.receipt_ref)), {
          schema_version: 1,
          kind: "checked-verification-artifact-execution-claim",
          state: "completed",
          nonce,
          run_id: authority.run_id,
          slice_id: authority.slice_id,
          attempt: authority.attempt,
          plan_ref: authority.plan_ref,
          plan_hash: authority.plan_hash,
          head_sha: authority.head_sha,
          verification_artifact_id: authority.verification_artifact_id,
          probe: authority.probe,
          receipt_ref: authority.receipt_ref,
          claimed_at: "2026-07-19T11:59:59.000Z",
          completed_at: receipt.completed_at,
          status: receipt.status,
          receipt_hash: hashFile(join(replayFixture.runDir, authority.receipt_ref)),
        });
        await assert.rejects(
          executeCheckedVerificationArtifact(replayFixture.runDir, "slice", "slice-tests", { env: process.env }),
          /must equal receipt\.probe|authoritative probe/u,
          name,
        );
      } finally {
        rmSync(replayFixture.repo, { recursive: true, force: true });
      }
    }
  });

  it("rejects replay when a claim and receipt are rebound to a different timeout", async () => {
    const fixture = createArtifactFixture("artifact-timeout-replay");
    try {
      const result = await executeCheckedVerificationArtifact(fixture.runDir, "slice", "slice-tests", { env: process.env });
      const receiptPath = join(fixture.runDir, result.authority.receipt_ref);
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      receipt.timeout_ms = 600_000;
      writeJson(receiptPath, receipt);
      const claimPath = join(fixture.runDir, result.claim_ref);
      const claim = JSON.parse(readFileSync(claimPath, "utf8"));
      claim.timeout_ms = 600_000;
      claim.receipt_hash = hashFile(receiptPath);
      writeJson(claimPath, claim);

      await assert.rejects(
        executeCheckedVerificationArtifact(fixture.runDir, "slice", "slice-tests", { env: process.env }),
        /timeout_ms.*stale/u,
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

  it("encodes arbitrary valid UTF-8 slice ids into safe deterministic refs consumed by the review ledger", async () => {
    for (const [index, sliceId] of ["slice with spaces", "スライス", "feature/api", ".."].entries()) {
      const fixture = createArtifactFixture(`artifact-utf8-${index}`, { sliceId });
      try {
        const result = await executeCheckedVerificationArtifact(fixture.runDir, sliceId, "slice-tests", { env: process.env });
        const receiptRef = result.authority.receipt_ref;
        const claimRef = verificationArtifactExecutionClaimRef(receiptRef);
        assert.match(receiptRef, /^evidence\/verification-artifact-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.attempt-1\.json$/u, sliceId);
        assert.equal(receiptRef.includes(sliceId), false, sliceId);
        assert.equal(receiptRef.includes(".."), false, sliceId);
        assert.equal(receiptRef.slice("evidence/".length).includes("/"), false, sliceId);
        assert.equal(result.receipt.subject, sliceId);
        assert.equal(result.receipt.slice_id, sliceId);
        const claim = JSON.parse(readFileSync(join(fixture.runDir, claimRef), "utf8"));
        const review = {
          subject: sliceId,
          attempt: 1,
          verdict: "APPROVE",
          reviewed_commit: fixture.head,
          invariant_family_ledger: {
            schema_version: 1,
            delivery_unit_id: "slice-unit",
            dispositions: [{
              invariant_family_id: "slice-family",
              verification_artifact_id: "slice-tests",
              evidence_ref: receiptRef,
              evidence_hash: result.receipt_hash,
              reviewed_commit: fixture.head,
              probe: { type: "verification-artifact", verification_artifact_id: "slice-tests" },
              result: result.receipt.result,
              unresolved_findings: [],
            }],
          },
        };
        const decision = evaluateInvariantFamilyReview({
          plan: fixture.plan,
          sliceId,
          review,
          observeEvidence: () => ({ ref: receiptRef, hash: result.receipt_hash, claim, receipt: result.receipt }),
        });
        assert.equal(decision.decision, "approve", sliceId);
        assert.equal(decision.grants_b4_authority, true, sliceId);
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    }
  });

  it("uses collision-resistant fixed-width refs without path traversal", () => {
    const ids = ["a/b", "a..b", "a b", "a_b", "é", "e\u0301"];
    const refs = ids.map((id) => verificationArtifactExecutionReceiptRef(id, "slice-tests", 1));
    assert.equal(new Set(refs).size, ids.length);
    assert.equal(
      verificationArtifactExecutionReceiptRef("slice with spaces", "slice-tests", 1),
      "evidence/verification-artifact-qW_xvjINZNuc7EGr2NFcVkot_-YkPHmxbNHJJtGD0vo-mw4JNZac6NmXnN-QNcr-JAB_BVSYDp4k_tkGlc390pA.attempt-1.json",
    );
    assert.equal(
      verificationArtifactExecutionReceiptRef("slice", "../artifact", 2),
      "evidence/verification-artifact-A_2wZdlW8_uczYXaGxU5jwCplYtxUUXr-Rbdkf17Y2E-YBARmcUO_28Qt5wQKxX5cP4bJCJ09U3amrj-5t_vK-0.attempt-2.json",
    );
    assert.equal(
      verificationArtifactExecutionClaimRef("evidence/api.artifact-api-tests.attempt-1.json"),
      "evidence/api.artifact-api-tests.attempt-1.claim.json",
    );
    for (const ref of refs) {
      assert.match(ref, /^evidence\/verification-artifact-[A-Za-z0-9_-]{43}-[A-Za-z0-9_-]{43}\.attempt-1\.json$/u);
      assert.equal(ref.includes(".."), false);
      assert.equal(ref.slice("evidence/".length).includes("/"), false);
    }
  });
});

function createArtifactFixture(runId, { sliceId = "slice" } = {}) {
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
    slices: [{ id: sliceId, stack: "backend", paths: ["README.md"], depends_on: [], acceptance: ["works"], test_plan: ["node --version"] }],
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    delivery_envelope: { schema_version: 1, delivery_units: [{
      id: "slice-unit", slice_id: sliceId, invariant_families: [{ id: "slice-family", description: "Slice behavior" }],
      obligations: [{ id: "slice-obligation", description: "Verify behavior", invariant_family_id: "slice-family", verification_artifact_id: "slice-tests" }],
      verification_artifacts: [{ id: "slice-tests", test_plan_index: 0, test_plan_entry: "node --version" }],
    }] },
  };
  writeJson(join(runDir, "plan", "slices.json"), plan);
  writeJson(join(runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] });
  writeJson(join(runDir, "run.json"), {
    schema_version: 1, run_id: runId, status: "running", branch: "slice-branch", worktree: repo, gates: {},
    slices: [{ id: sliceId, stack: "backend", depends_on: [], declared_paths: ["README.md"], effective_paths: ["README.md"], status: "running", attempts: 1, branch: "slice-branch", worktree: repo }],
    steps: [{ agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json", acceptance: {
      artifact_ref: "plan/slices.json", artifact_hash: hashFile(join(runDir, "plan", "slices.json")),
      review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(runDir, "reviews", "work-decomposer.json")),
    } }],
  });
  return { repo, runDir, runId, head: git(repo, ["rev-parse", "HEAD"]), plan, planHash: hashFile(join(runDir, "plan", "slices.json")) };
}

function artifactAuthority(fixture) {
  return {
    run_id: fixture.runId, slice_id: "slice", attempt: 1, plan_ref: "plan/slices.json", plan_hash: fixture.planHash,
    head_sha: fixture.head, verification_artifact_id: "slice-tests",
    probe: { type: "verification-artifact", verification_artifact_id: "slice-tests", test_plan_index: 0, test_plan_entry: "node --version", program: "node", args: ["--version"] },
    worktree: fixture.repo, receipt_ref: verificationArtifactExecutionReceiptRef("slice", "slice-tests", 1),
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
