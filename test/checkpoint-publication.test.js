import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { reconcileCheckpointPublication } from "../src/checkpoint-publication.js";
import { validateRunDir } from "../src/validate.js";
import { execFileSync } from "./helpers/git-fixture.js";
import { withDeliveryEnvelope } from "./helpers/delivery-envelope-fixture.js";

describe("B4.3 normal checkpoint child publication", () => {
  it("creates the no-replace claim and ordinary branch transaction, then publishes a complete normal child", async () => {
    const fixture = createFixture("normal-child", { prMode: "draft", reviewTier: "strict", postPrEnabled: true });
    let observedStaging = false;
    let observedRename = false;
    try {
      const result = await publish(fixture, {
        beforeChildPublish({ stagingRoot, targetRunDir }) {
          observedStaging = true;
          assert.equal(existsSync(targetRunDir), false, "an incomplete child must remain invisible");
          assert.equal(validateRunDir(stagingRoot).ok, true);
        },
        publicationRenameSync(source, target) {
          observedRename = true;
          assert.equal(target, fixture.childRunDir);
          renameSync(source, target);
        },
      });

      assert.equal(observedStaging, true);
      assert.equal(observedRename, true);
      assert.equal(result.published, true);
      assert.equal(result.replayed, false);
      assert.equal(result.created_refs, true);
      assert.equal(git(fixture.repo, "rev-parse", fixture.entry.publication_claim_ref), fixture.entry.publication_claim_oid);
      assert.equal(git(fixture.repo, "rev-parse", fixture.claim.branch_ref), fixture.baseCommit);
      assert.equal(git(fixture.worktree, "rev-parse", "HEAD"), fixture.baseCommit);
      assert.equal(git(fixture.worktree, "status", "--porcelain=v1", "--untracked-files=all"), "");

      const run = readJson(join(fixture.childRunDir, "run.json"));
      assert.equal(run.run_id, fixture.childRunId);
      assert.equal(run.mode, "headless");
      assert.equal(run.pr_mode, "draft");
      assert.equal(run.review_tier, "strict");
      assert.equal(run.post_pr.phase, "awaiting-pr");
      assert.deepEqual(run.post_pr.policy, fixture.entry.configuration.post_pr_policy);
      assert.equal(run.steps[0].agent, "work-decomposer");
      assert.equal(run.steps[0].status, "accepted");
      assert.equal(run.steps[1].agent, "test-verifier");
      assert.equal(run.steps[1].status, "blocked");
      assert.equal(run.steps.some((step) => step.agent === "spec-writer"), false);
      assert.equal(existsSync(join(fixture.childRunDir, "artifacts", "technical-brief.md")), false);
      assert.equal(existsSync(join(fixture.childRunDir, "reviews", "spec-writer.json")), false);
      assert.deepEqual(run.gates, {});
      assert.equal(run.slices[0].status, "pending");
      assert.equal(run.checkpoint, undefined, "publication must not recreate special checkpoint authority");
      assert.equal(run.continuation, undefined);
      assert.equal(run.checkpoint_source.root_child_run_id, fixture.childRunId);
      assert.equal(run.checkpoint_source.source_plan_ref, fixture.manifest.source.plan_ref);
      assert.equal(run.checkpoint_source.source_plan_hash, fixture.manifest.source.plan_hash);
      assert.equal(run.checkpoint_source.source_review_ref, fixture.manifest.source.decomposition_review_ref);
      assert.equal(run.checkpoint_source.source_review_hash, fixture.manifest.source.decomposition_review_hash);
      assert.equal(run.checkpoint_source.source_review_attempt, fixture.manifest.source.decomposition_attempt);
      assert.notEqual(run.checkpoint_source.source_plan_hash, fixture.checkpoint.child_plan_hash);
      assert.notEqual(run.checkpoint_source.source_review_hash, run.checkpoint_source.child_disposition_hash);
      assert.equal(run.steps[0].acceptance.artifact_hash, fixture.checkpoint.child_plan_hash);
      assert.equal(run.steps[0].acceptance.review_hash, run.checkpoint_source.child_disposition_hash);
      assert.equal(run.steps[0].attempts, fixture.checkpoint.child_disposition.attempt);
      assert.equal(result.acceptance_mapping_hash, fixture.checkpoint.acceptance_mapping_hash);
      assert.equal(validateRunDir(fixture.childRunDir).ok, true);
    } finally {
      fixture.cleanup();
    }
  });

  it("detects canonical main movement at the deterministic pre-transaction race hook without creating refs", async () => {
    const fixture = createFixture("main-race");
    try {
      await assert.rejects(publish(fixture, {
        beforeRefTransaction() {
          advanceRemoteMain(fixture, "raced-main.txt");
        },
      }), /remote main moved before ref transaction/u);
      assert.equal(refExists(fixture.repo, fixture.entry.publication_claim_ref), false);
      assert.equal(refExists(fixture.repo, fixture.claim.branch_ref), false);
      assert.equal(existsSync(fixture.childRunDir), false);
      assert.equal(existsSync(fixture.worktree), false);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects partial publication refs and never fills in the missing branch", async () => {
    const fixture = createFixture("partial-refs");
    try {
      git(fixture.repo, "update-ref", fixture.entry.publication_claim_ref, fixture.entry.publication_claim_oid);
      await assert.rejects(publish(fixture), /partial claim\/branch refs/u);
      assert.equal(refExists(fixture.repo, fixture.claim.branch_ref), false);
      assert.equal(existsSync(fixture.worktree), false);
      assert.equal(existsSync(fixture.childRunDir), false);
    } finally {
      fixture.cleanup();
    }
  });

  it("recovers exact interrupted refs and replays an exact complete child without replacement", async () => {
    const fixture = createFixture("exact-replay");
    try {
      createPublicationRefs(fixture);
      const recovered = await publish(fixture);
      const runBefore = readFileSync(join(fixture.childRunDir, "run.json"));
      const replay = await publish(fixture, {
        beforeWorktreeAdd: () => assert.fail("exact replay must not recreate the worktree"),
      });

      assert.equal(recovered.created_refs, false);
      assert.equal(recovered.replayed, false);
      assert.equal(replay.replayed, true);
      assert.equal(replay.created_refs, false);
      assert.deepEqual(readFileSync(join(fixture.childRunDir, "run.json")), runBefore);
      assert.equal(git(fixture.repo, "rev-parse", fixture.entry.publication_claim_ref), fixture.entry.publication_claim_oid);
      assert.equal(git(fixture.repo, "rev-parse", fixture.claim.branch_ref), fixture.baseCommit);
    } finally {
      fixture.cleanup();
    }
  });

  it("serializes a racing compliant publication and reconciles the loser as an exact replay", async () => {
    const fixture = createFixture("serialized-race");
    let secondPublication;
    let secondObservedStaging = false;
    try {
      const firstPublication = publish(fixture, {
        afterChildTargetObservation({ targetRunDir }) {
          assert.equal(existsSync(targetRunDir), false);
          secondPublication = publish(fixture, {
            beforeChildPublish({ stagingRoot, targetRunDir: secondTarget }) {
              secondObservedStaging = true;
              assert.equal(existsSync(secondTarget), false, "the lock holder must not expose a partial child");
              assert.equal(validateRunDir(stagingRoot).ok, true);
            },
          });
        },
      });
      const first = await firstPublication;
      const second = await secondPublication;

      assert.equal(first.replayed, false);
      assert.equal(second.replayed, true);
      assert.equal(secondObservedStaging, true);
      assert.equal(existsSync(join(fixture.childRunDir, fixture.childRunId)), false, "publication must not nest the staged child");
      assert.equal(validateRunDir(fixture.childRunDir).ok, true);
      assert.deepEqual(readFileSync(join(fixture.childRunDir, "run.json")), canonicalBytes(first.run));
      assert.deepEqual(second.run, first.run);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects dirty and wrong registered worktrees instead of adopting them", async () => {
    for (const variant of ["dirty", "wrong-branch"]) {
      const fixture = createFixture(`worktree-${variant}`);
      try {
        createPublicationRefs(fixture);
        if (variant === "dirty") {
          git(fixture.repo, "worktree", "add", fixture.worktree, fixture.childRunId);
          writeFileSync(join(fixture.worktree, "dirty.txt"), "dirty\n");
        } else {
          git(fixture.repo, "branch", "foreign-child", fixture.baseCommit);
          git(fixture.repo, "worktree", "add", fixture.worktree, "foreign-child");
        }
        await assert.rejects(publish(fixture), variant === "dirty" ? /worktree must be clean/u : /worktree.*(?:conflicts|wrong|branch-mismatch)/u, variant);
        assert.equal(existsSync(fixture.childRunDir), false, variant);
      } finally {
        fixture.cleanup();
      }
    }
  });

  it("rejects a pre-existing incomplete child and leaves its bytes untouched", async () => {
    const fixture = createFixture("partial-child");
    try {
      createPublicationRefs(fixture);
      git(fixture.repo, "worktree", "add", fixture.worktree, fixture.childRunId);
      mkdirSync(fixture.childRunDir);
      writeFileSync(join(fixture.childRunDir, "run.json"), "{\"partial\":true}\n");
      const before = readFileSync(join(fixture.childRunDir, "run.json"));

      await assert.rejects(publish(fixture), /partial or contains mismatched files/u);
      assert.deepEqual(readFileSync(join(fixture.childRunDir, "run.json")), before);
      assert.equal(existsSync(join(fixture.childRunDir, "plan", "slices.json")), false);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when the native directory publication operation fails", async () => {
    const fixture = createFixture("rename-failure");
    try {
      await assert.rejects(publish(fixture, {
        publicationRenameSync() {
          const error = new Error("host path detail must not escape");
          error.code = "EIO";
          throw error;
        },
      }), /serialized no-overwrite directory publication failed/u);
      assert.equal(existsSync(fixture.childRunDir), false);
    } finally {
      fixture.cleanup();
    }
  });

  it("copies the exact canonical reviewer-produced child disposition bytes", async () => {
    const fixture = createFixture("exact-disposition");
    try {
      await publish(fixture);
      const copied = readFileSync(join(fixture.childRunDir, "reviews", "work-decomposer.json"));
      assert.deepEqual(copied, canonicalBytes(fixture.checkpoint.child_disposition));
      assert.equal(hashBytes(copied), readJson(join(fixture.childRunDir, "run.json")).checkpoint_source.child_disposition_hash);
      assert.notDeepEqual(copied, canonicalBytes({ ...fixture.checkpoint.child_disposition, verdict: "REJECT" }));
    } finally {
      fixture.cleanup();
    }
  });

  it("preserves ready PR mode and root omission for null review-tier configuration", async () => {
    const fixture = createFixture("null-review-tier", { prMode: "ready", reviewTier: null, postPrEnabled: false });
    try {
      await publish(fixture);
      const run = readJson(join(fixture.childRunDir, "run.json"));
      assert.equal(run.pr_mode, "ready");
      assert.equal(fixture.entry.configuration.review_tier, null);
      assert.equal(Object.hasOwn(run, "review_tier"), false);
      assert.equal(run.post_pr.phase, "disabled");
      assert.equal(run.max_parallel_slices, 3);
      assert.equal(run.max_retries, 3);
      assert.equal(run.github_account, null);
      assert.equal(run.base_ref, "refs/remotes/origin/main");
      assert.equal(run.checkpoint_source.initial_base_ref, "refs/remotes/origin/main");
      assert.equal(run.checkpoint_source.initial_base_commit, fixture.baseCommit);
      assert.equal(validateRunDir(fixture.childRunDir).ok, true);
    } finally {
      fixture.cleanup();
    }
  });
});

function createFixture(name, { prMode = "ready", reviewTier = null, postPrEnabled = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), `checkpoint-publication-${name}-`));
  const remote = join(root, "origin.git");
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(root, "init", "--bare", "-b", "main", remote);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Checkpoint Fixture");
  git(repo, "config", "user.email", "checkpoint@example.com");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  const baseCommit = git(repo, "rev-parse", "HEAD");

  const parentRunId = `parent-${name}`;
  const childRunId = `child-${name}`;
  const parentRunDir = join(repo, ".opencode", "factory", parentRunId);
  const childRunDir = join(repo, ".opencode", "factory", childRunId);
  const worktree = join(repo, ".opencode", "worktrees", childRunId);
  mkdirSync(join(parentRunDir, "artifacts"), { recursive: true });

  const childPlan = withDeliveryEnvelope({
    integration_gate: { required_commands: [{ program: "npm", args: ["run", "check"] }] },
    slices: [{
      id: "normal-slice",
      stack: "backend",
      paths: ["src/normal.js"],
      depends_on: [],
      acceptance: ["Publishes a normal child"],
      test_plan: ["node --test"],
    }],
  });
  const childPlanHash = hashBytes(canonicalBytes(childPlan));
  const briefScope = { title: "Publish normal child" };
  const briefScopeHash = hashBytes(canonicalBytes(briefScope));
  const acceptanceMappingHash = hashBytes(canonicalBytes({ acceptance_ids: ["acceptance-000001"] }));
  const identityFields = {
    schema_version: 1,
    subject: "work-decomposer",
    attempt: 4,
    plan_ref: "plan/slices.json",
    plan_hash: hashBytes("parent plan\n"),
    review_ref: "reviews/work-decomposer.json",
  };
  const reviewIdentity = { ...identityFields, identity_hash: hashBytes(canonicalBytes(identityFields)) };
  const disposition = {
    schema_version: 1,
    kind: "checkpoint-child-decomposition-review",
    subject: "work-decomposer",
    attempt: 1,
    verdict: "APPROVE",
    required_fixes: [],
    checkpoint_id: "checkpoint-001",
    checkpoint_ordinal: 1,
    reviewed_plan_ref: "plan/slices.json",
    reviewed_plan_hash: childPlanHash,
    child_plan_hash: childPlanHash,
    brief_scope_hash: briefScopeHash,
    acceptance_mapping_hash: acceptanceMappingHash,
    parent_review_identity: reviewIdentity,
  };
  const checkpoint = {
    id: "checkpoint-001",
    ordinal: 1,
    prerequisite_checkpoint_id: null,
    acceptance_projection: { acceptance_ids: ["acceptance-000001"] },
    acceptance_mapping_hash: acceptanceMappingHash,
    brief_scope: briefScope,
    brief_scope_hash: briefScopeHash,
    child_plan: childPlan,
    child_plan_hash: childPlanHash,
    child_disposition: disposition,
    request: { run_kind: "normal-feature-run" },
  };
  const manifest = {
    schema_version: 1,
    kind: "delivery-checkpoint-routing-manifest",
    source: {
      plan_ref: "plan/slices.json",
      plan_hash: identityFields.plan_hash,
      checkpoint_plan_hash: hashBytes("checkpoint plan\n"),
      decomposition_review_ref: "reviews/work-decomposer.json",
      decomposition_review_hash: hashBytes("parent review\n"),
      decomposition_attempt: 4,
      review_identity: reviewIdentity,
      admission_probe: { schema_version: 1, kind: "delivery-plan-admission-probe", decision: "checkpoint" },
      admission_result: { decision: "checkpoint" },
    },
    sequencing: { mode: "strictly-sequential", base_branch: "main" },
    checkpoints: [checkpoint],
  };
  const manifestBytes = canonicalBytes(manifest);
  const manifestHash = hashBytes(manifestBytes);
  const manifestRef = `artifacts/checkpoint-routing-${manifestHash.slice("sha256:".length)}.json`;
  writeFileSync(join(parentRunDir, manifestRef), manifestBytes);

  const claimRef = `refs/opencode/checkpoint-publications/${createHash("sha256").update(childRunId).digest("hex")}`;
  const claim = {
    schema_version: 1,
    kind: "delivery-checkpoint-child-publication",
    parent_run_id: parentRunId,
    manifest_ref: manifestRef,
    manifest_hash: manifestHash,
    checkpoint_id: checkpoint.id,
    checkpoint_ordinal: checkpoint.ordinal,
    child_run_id: childRunId,
    branch_ref: `refs/heads/${childRunId}`,
    worktree,
    remote_main_ref: "refs/heads/main",
    base_commit: baseCommit,
    predecessor_checkpoint_id: null,
    predecessor_completed_run_id: null,
    predecessor_merge_commit: null,
    reserved_at: "2026-07-19T12:00:00.000Z",
  };
  const claimOid = gitInput(repo, canonicalBytes(claim), "hash-object", "-w", "--stdin");
  const entry = {
    state: "reserved",
    checkpoint_id: checkpoint.id,
    ordinal: checkpoint.ordinal,
    root_child_run_id: childRunId,
    branch: childRunId,
    worktree,
    base_ref: "refs/remotes/origin/main",
    base_commit: baseCommit,
    predecessor_checkpoint_id: null,
    predecessor_completed_run_id: null,
    predecessor_merge_commit: null,
    configuration: checkpointConfiguration({ prMode, reviewTier, postPrEnabled }),
    publication_claim_ref: claimRef,
    publication_claim_oid: claimOid,
    reserved_at: claim.reserved_at,
  };
  return {
    root,
    remote,
    repo,
    parentRunId,
    childRunId,
    parentRunDir,
    childRunDir,
    worktree,
    baseCommit,
    manifest,
    checkpoint,
    claim,
    entry,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function checkpointConfiguration({ prMode, reviewTier, postPrEnabled }) {
  return {
    mode: "headless",
    github_account: null,
    pr_mode: prMode,
    max_parallel_slices: 3,
    max_retries: 3,
    post_pr_policy: {
      enabled: postPrEnabled,
      wait_ms: 3_600_000,
      initial_poll_ms: 30_000,
      max_poll_ms: 120_000,
      check_start_grace_ms: 300_000,
      max_transient_errors: 12,
      review: postPrEnabled
        ? { required: true, reviewer_login: "mimirbot", source: "driver" }
        : { required: false, reviewer_login: null, source: "none" },
    },
    review_tier: reviewTier,
  };
}

function publish(fixture, options = {}) {
  return reconcileCheckpointPublication({
    repository: fixture.repo,
    parentRunDir: fixture.parentRunDir,
    childRunDir: fixture.childRunDir,
    reservedEntry: fixture.entry,
    manifest: fixture.manifest,
    manifestCheckpoint: fixture.checkpoint,
  }, options);
}

function createPublicationRefs(fixture) {
  git(fixture.repo, "update-ref", fixture.entry.publication_claim_ref, fixture.entry.publication_claim_oid);
  git(fixture.repo, "update-ref", fixture.claim.branch_ref, fixture.baseCommit);
}

function advanceRemoteMain(fixture, name) {
  writeFileSync(join(fixture.repo, name), "advance\n");
  git(fixture.repo, "add", name);
  git(fixture.repo, "commit", "-m", `advance ${name}`);
  git(fixture.repo, "push", "origin", "main");
  return git(fixture.repo, "rev-parse", "HEAD");
}

function refExists(repo, ref) {
  try {
    execFileSync("git", ["-c", "commit.gpgsign=false", "rev-parse", "--verify", ref], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

function gitInput(cwd, input, ...args) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", input }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function hashBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
