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
import { hashValue } from "../src/refs.js";
import { createSliceAttemptReview, createSliceReviewRecord } from "./helpers/review-record-fixture.js";
import { validateRun } from "../src/validate.js";
import { passingInvariantFamilyLedger, writeVerificationArtifactReceipt } from "./helpers/delivery-envelope-fixture.js";

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
        observePredecessorPrOperation: async () => canonicalMergedObservation(fixture, { binding: first.binding, mergeCommit }),
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

  it("rejects a shape-valid completed predecessor that skipped the normal pipeline", async () => {
    const fixture = createFixture("checkpoint-parent-incomplete");
    try {
      const first = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-child-incomplete", checkpointLaunchFn: (value) => value,
      });
      git(fixture.repo, ["checkout", "-b", "checkpoint-child-incomplete"]);
      writeFileSync(join(fixture.repo, "incomplete.txt"), "incomplete\n");
      git(fixture.repo, ["add", "incomplete.txt"]);
      git(fixture.repo, ["commit", "-m", "incomplete checkpoint child"]);
      const childHead = git(fixture.repo, ["rev-parse", "HEAD"]);
      git(fixture.repo, ["checkout", "main"]);
      git(fixture.repo, ["merge", "--no-ff", "checkpoint-child-incomplete", "-m", "merge incomplete child"]);
      const mergeCommit = git(fixture.repo, ["rev-parse", "HEAD"]);
      publishCompletedChild(fixture, first.binding, childHead, { completePipeline: false });

      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        cwd: fixture.repo, runId: "checkpoint-child-two", predecessorMergeCommit: mergeCommit,
        checkpointLaunchFn: (value) => value,
      }), /full normal pipeline|merged slices|test-verifier|Gate 3/u);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("recovers an exact reservation after a crash before launch without duplicating launch", async () => {
    const fixture = createFixture("checkpoint-parent-reservation-recovery");
    let launches = 0;
    try {
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo,
        runId: "checkpoint-recovery-child",
        beforeCheckpointLaunch: () => { throw new Error("injected pre-launch crash"); },
        checkpointLaunchFn: (value) => { launches += 1; return value; },
      }), /injected pre-launch crash/u);
      const recovered = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo,
        runId: "checkpoint-recovery-child",
        checkpointLaunchFn: (value) => { launches += 1; return value; },
      });
      assert.equal(recovered.binding.child_run_id, "checkpoint-recovery-child");
      assert.equal(launches, 1);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("admits only one launch when exact reservation contenders race after observation", async () => {
    const fixture = createFixture("checkpoint-parent-reservation-race");
    let releaseFirst;
    let firstReserved;
    let launches = 0;
    const reserved = new Promise((resolve) => { firstReserved = resolve; });
    const release = new Promise((resolve) => { releaseFirst = resolve; });
    try {
      const first = startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-race-child",
        beforeCheckpointLaunch: async () => { firstReserved(); await release; },
        checkpointLaunchFn: (value) => { launches += 1; return value; },
      });
      await reserved;
      const second = startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-race-child",
        checkpointLaunchFn: (value) => { launches += 1; return value; },
      });
      await second;
      releaseFirst();
      await assert.rejects(first, /changed concurrently|state transition/u);
      assert.equal(launches, 1);
    } finally {
      releaseFirst?.();
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("adopts an exact completed child without launching it again", async () => {
    const fixture = createFixture("checkpoint-parent-child-adoption");
    let launches = 0;
    try {
      const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-adopted-child", checkpointLaunchFn: (value) => { launches += 1; return value; },
      });
      git(fixture.repo, ["branch", "checkpoint-adopted-child"]);
      publishCompletedChild(fixture, started.binding, fixture.baseCommit, { completePipeline: false });
      const adopted = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
        cwd: fixture.repo, runId: "checkpoint-adopted-child", checkpointLaunchFn: (value) => { launches += 1; return value; },
      });
      assert.equal(adopted.replayed, true);
      assert.equal(adopted.adopted, true);
      assert.equal(launches, 1);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects a local-only predecessor merge when canonical GitHub observation is absent", async () => {
    const fixture = createFixture("checkpoint-parent-local-only");
    try {
      const predecessor = await createCompletedPredecessor(fixture, "checkpoint-child-local-only");
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        cwd: fixture.repo, runId: "checkpoint-child-two", predecessorMergeCommit: predecessor.mergeCommit,
        observePredecessorPrOperation: async () => ({ disposition: "absent", reason: null, pull_request: null }),
        checkpointLaunchFn: (value) => value,
      }), /canonical.*pull request|GitHub.*merged|remote.*merge/u);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("rejects canonical remote merge divergence from the exact predecessor merge commit", async () => {
    const fixture = createFixture("checkpoint-parent-remote-divergence");
    try {
      const predecessor = await createCompletedPredecessor(fixture, "checkpoint-child-divergent");
      await assert.rejects(startFactoryCheckpoint(fixture.parentRunId, "checkpoint-002", {
        cwd: fixture.repo, runId: "checkpoint-child-two", predecessorMergeCommit: predecessor.mergeCommit,
        observePredecessorPrOperation: async () => canonicalMergedObservation(fixture, predecessor, "f".repeat(40)),
        checkpointLaunchFn: (value) => value,
      }), /canonical.*merge commit|remote.*diverg/u);
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

function publishCompletedChild(fixture, binding, headSha, { completePipeline = true } = {}) {
  const runDir = join(fixture.repo, ".opencode", "factory", binding.child_run_id);
  mkdirSync(runDir, { recursive: true });
  if (completePipeline) {
    const worktree = join(fixture.repo, ".opencode", "worktrees", binding.child_run_id);
    mkdirSync(join(fixture.repo, ".opencode", "worktrees"), { recursive: true });
    git(fixture.repo, ["worktree", "add", worktree, binding.child_run_id]);
    for (const directory of ["plan", "reviews", "evidence", "artifacts"]) mkdirSync(join(runDir, directory), { recursive: true });
    const plan = {
      slices: [{ id: "backend", stack: "backend", paths: ["src/**"], depends_on: [], acceptance: ["works"], test_plan: ["node --version"] }],
      integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
      delivery_envelope: { schema_version: 1, delivery_units: [{ id: "backend-unit", slice_id: "backend", invariant_families: [{ id: "behavior", description: "Behavior" }], obligations: [{ id: "behavior-check", description: "Check behavior", invariant_family_id: "behavior", verification_artifact_id: "backend-tests" }], verification_artifacts: [{ id: "backend-tests", test_plan_index: 0, test_plan_entry: "node --version" }] }] },
    };
    writeJson(join(runDir, "plan", "slices.json"), plan);
    writeJson(join(runDir, "reviews", "work-decomposer.json"), { subject: "work-decomposer", attempt: 1, verdict: "APPROVE", required_fixes: [] });
    writeJson(join(runDir, "evidence", "backend.json"), { subject: "backend", attempt: 1, status: "pass", review_ready: true, head_sha: headSha });
    const familyEvidence = writeVerificationArtifactReceipt({
      runDir, runId: binding.child_run_id, plan, sliceId: "backend", attempt: 1, reviewedCommit: headSha,
      artifactId: "backend-tests", evidenceRef: "evidence/backend-family.json",
      result: { type: "verification-result", outcome: "pass", summary: "Behavior passed" },
    });
    const sliceReview = createSliceReviewRecord({ subject: "backend", attempt: 1, reviewedCommit: headSha });
    sliceReview.invariant_family_ledger = passingInvariantFamilyLedger({ plan, sliceId: "backend", reviewedCommit: headSha, evidenceRef: familyEvidence.ref, evidenceHash: familyEvidence.hash });
    writeJson(join(runDir, "reviews", "backend.json"), sliceReview);
    writeFileSync(join(runDir, "artifacts", "test-report.md"), "# Test report\n\nPASS\n");
    const receiptRef = "evidence/test-verifier.attempt-1.json";
    const claim = {
      schema_version: 1, kind: "checked-test-execution-claim", state: "active", nonce: "123e4567-e89b-42d3-a456-426614174000",
      run_id: binding.child_run_id, attempt: 1, plan_ref: "plan/slices.json", plan_hash: hashFile(join(runDir, "plan", "slices.json")),
      head_sha: headSha, receipt_ref: receiptRef, claimed_at: "2026-07-19T10:00:00.000Z",
    };
    const stream = { captured_bytes: 0, sha256: `sha256:${createHash("sha256").digest("hex")}`, truncated: false };
    const receipt = {
      schema_version: 1, kind: "checked-test-execution-receipt", subject: "test-verifier", run_id: binding.child_run_id,
      attempt: 1, claim_nonce: claim.nonce, plan_ref: claim.plan_ref, plan_hash: claim.plan_hash, head_sha: headSha,
      started_at: "2026-07-19T10:00:00.000Z", completed_at: "2026-07-19T10:00:01.000Z", duration_ms: 1000,
      status: "pass", review_ready: true,
      commands: [{ index: 0, program: "npm", args: ["run", "check"], outcome: "exited", status: "pass", exit_code: 0, signal: null, error_code: null, duration_ms: 1000, stdout: stream, stderr: stream }],
    };
    writeJson(join(runDir, receiptRef), receipt);
    const completedClaim = { ...claim, state: "completed", completed_at: receipt.completed_at, status: "pass", receipt_hash: hashFile(join(runDir, receiptRef)) };
    writeJson(join(runDir, "reviews", "test-verifier.json"), { subject: "test-verifier", attempt: 1, verdict: "APPROVE", reviewed_head_sha: headSha });
    writeFileSync(join(runDir, "artifacts", "validation-report.md"), "GO\n");
    writeJson(join(runDir, "reviews", "implementation-validator.json"), { subject: binding.child_run_id, attempt: 1, verdict: "GO", reviewed_head_sha: headSha });
    writeJson(join(runDir, "reviews", "security-reviewer.json"), { subject: binding.child_run_id, attempt: 1, verdict: "PASS", reviewed_head_sha: headSha });
    const evidenceRef = "evidence/backend.json"; const reviewRef = "reviews/backend.json";
    const testReviewRef = "reviews/test-verifier.json"; const testArtifactRef = "artifacts/test-report.md";
    const attemptReview = createSliceAttemptReview({ evidenceRef, evidenceHash: hashFile(join(runDir, evidenceRef)), reviewRef, reviewHash: hashFile(join(runDir, reviewRef)), reviewedCommit: headSha });
    const run = {
      schema_version: 1, run_id: binding.child_run_id, status: "completed", base_ref: binding.base_ref, base_commit: binding.base_commit,
      branch: binding.child_run_id, worktree, gates: { pre_pr: { status: "approved" } }, checkpoint: binding,
      slices: [{ id: "backend", stack: "backend", depends_on: [], declared_paths: ["src/**"], effective_paths: ["src/**"], status: "merged", attempts: 1, attempt_reviews: [attemptReview], evidence_ref: evidenceRef, evidence_hash: hashFile(join(runDir, evidenceRef)), review_ref: reviewRef, review_hash: hashFile(join(runDir, reviewRef)), reviewed_commit: headSha, merge_commit: headSha }],
      steps: [
        { agent: "work-decomposer", status: "accepted", attempts: 1, artifact_ref: "plan/slices.json", review_ref: "reviews/work-decomposer.json", acceptance: { artifact_ref: "plan/slices.json", artifact_hash: claim.plan_hash, review_ref: "reviews/work-decomposer.json", review_hash: hashFile(join(runDir, "reviews", "work-decomposer.json")) } },
        { agent: "test-verifier", status: "accepted", attempts: 1, artifact_ref: testArtifactRef, evidence_ref: receiptRef, review_ref: testReviewRef, execution_claim: completedClaim, execution_claim_hash: hashValue(completedClaim), acceptance: { artifact_ref: testArtifactRef, artifact_hash: hashFile(join(runDir, testArtifactRef)), evidence_ref: receiptRef, evidence_hash: hashFile(join(runDir, receiptRef)), review_ref: testReviewRef, review_hash: hashFile(join(runDir, testReviewRef)), reviewed_head_sha: headSha } },
      ],
      validator: { verdict: "GO", report: "artifacts/validation-report.md", report_hash: hashFile(join(runDir, "artifacts", "validation-report.md")), review_ref: "reviews/implementation-validator.json", review_hash: hashFile(join(runDir, "reviews", "implementation-validator.json")), reviewed_head_sha: headSha },
      security_review: { verdict: "PASS", review_ref: "reviews/security-reviewer.json", review_hash: hashFile(join(runDir, "reviews", "security-reviewer.json")), reviewed_head_sha: headSha },
      pr_url: "https://github.com/acme/repo/pull/1",
      terminal_result: { status: "completed", run_id: binding.child_run_id, reason: null, summary: "PR created.", artifacts: {}, pr_url: "https://github.com/acme/repo/pull/1", pr_number: 1, pr_node_id: "PR_checkpoint_1", repository: "acme/repo", operation_id: `ffpr-v1-${"d".repeat(64)}`, head_ref: binding.child_run_id, head_sha: headSha, base_ref: "main", base_sha: binding.base_commit, draft: false },
    };
    validateRun(run);
    writeJson(join(runDir, "run.json"), run);
    return;
  }
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

async function createCompletedPredecessor(fixture, childRunId) {
  const started = await startFactoryCheckpoint(fixture.parentRunId, "checkpoint-001", {
    cwd: fixture.repo, runId: childRunId, checkpointLaunchFn: (value) => value,
  });
  git(fixture.repo, ["checkout", "-b", childRunId]);
  writeFileSync(join(fixture.repo, `${childRunId}.txt`), "child\n");
  git(fixture.repo, ["add", `${childRunId}.txt`]);
  git(fixture.repo, ["commit", "-m", `checkpoint child ${childRunId}`]);
  const childHead = git(fixture.repo, ["rev-parse", "HEAD"]);
  git(fixture.repo, ["checkout", "main"]);
  git(fixture.repo, ["merge", "--no-ff", childRunId, "-m", `merge ${childRunId}`]);
  const mergeCommit = git(fixture.repo, ["rev-parse", "HEAD"]);
  publishCompletedChild(fixture, started.binding, childHead);
  return { binding: started.binding, childHead, mergeCommit };
}

function canonicalMergedObservation(fixture, predecessor, mergeCommitSha = predecessor.mergeCommit) {
  const terminal = JSON.parse(readFileSync(join(fixture.repo, ".opencode", "factory", predecessor.binding.child_run_id, "run.json"), "utf8")).terminal_result;
  return {
    disposition: "merged", reason: null,
    pull_request: {
      pr_url: terminal.pr_url, pr_number: terminal.pr_number, pr_node_id: terminal.pr_node_id,
      repository: terminal.repository, draft: terminal.draft, state: "merged", merged_at: "2026-07-19T12:00:00Z",
      head_ref: terminal.head_ref, head_sha: terminal.head_sha, head_repository: terminal.repository,
      base_ref: terminal.base_ref, base_sha: terminal.base_sha, base_repository: terminal.repository,
      merge_commit_sha: mergeCommitSha,
    },
  };
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
