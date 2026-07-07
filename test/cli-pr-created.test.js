import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  createAttestationIndex,
  createDirectReviewedCommitAttestation,
  createGateDecisionAttestation,
  createMergeChainAttestation,
  createReviewApprovalAttestation,
  createRunBaseAttestation,
  gitDiffHash,
  hashFile,
  hashValue,
} from "../src/provenance-authority.js";
import { SAFE_GIT_POLICY } from "../src/safe-git.js";
import { validateRunDir } from "../src/validate.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const PR_URL = "https://github.com/example/repo/pull/123";

describe("cli pr-created routing", () => {
  it("routes successful PR creation through transitionPrCreated", () => {
    const fixture = createPrFixture("cli-pr-created-success", { includePrerequisites: true });

    try {
      const proc = spawnSync(process.execPath, [
        CLI,
        "factory",
        "pr-created",
        fixture.runId,
        "--pr-url",
        PR_URL,
        "--pr-number",
        "123",
        "--pr-body-ref",
        "artifacts/pr-body.md",
        "--provider",
        "github",
        "--repository",
        "example/repo",
        "--remote",
        "origin",
        "--github-account",
        "octocat",
        "--head-branch",
        fixture.context.branch,
        "--head-commit",
        fixture.context.headCommit,
        "--base-ref",
        "main",
        "--base-commit",
        fixture.context.baseCommit,
        "--draft",
        "--json",
      ], { cwd: fixture.repo, encoding: "utf8" });

      assert.equal(proc.status, 0, proc.stderr);
      const output = JSON.parse(proc.stdout);
      assert.equal(output.status, "completed");
      assert.equal(output.pr_url, PR_URL);
      assert.equal(output.attestation_ref, "attestations/pr-created.json");

      const run = readJson(join(fixture.runDir, "run.json"));
      const index = readJson(join(fixture.runDir, "attestations", "index.json"));
      const attestation = readJson(join(fixture.runDir, "attestations", "pr-created.json"));
      assert.equal(run.status, "completed");
      assert.equal(run.pr_url, PR_URL);
      assert.equal(run.terminal_result.pr_url, PR_URL);
      assert.equal(index.entries.at(-1).type, "pr-created");
      assert.equal(attestation.bindings.remote_observation.head_commit, fixture.context.headCommit);
      assert.equal(attestation.bindings.remote_observation.base_commit, fixture.context.baseCommit);
      assert.equal(validateRunDir(fixture.runDir, { repoRoot: fixture.repo }).ok, true);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when PR prerequisites are missing", () => {
    const fixture = createPrFixture("cli-pr-created-missing-authority", { includePrerequisites: false });
    const originalRun = readJson(join(fixture.runDir, "run.json"));

    try {
      const proc = runPrCreated(fixture);

      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /pr-created requires current accepted merge-chain, approved pre_pr gate-decision/u);
      assert.deepEqual(readJson(join(fixture.runDir, "run.json")), originalRun);
      assert.equal(existsSync(join(fixture.runDir, "attestations", "pr-created.json")), false);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when CLI authority arguments mismatch the accepted chain", () => {
    const fixture = createPrFixture("cli-pr-created-mismatched-head", { includePrerequisites: true });
    const originalRun = readJson(join(fixture.runDir, "run.json"));
    const originalIndex = readJson(join(fixture.runDir, "attestations", "index.json"));

    try {
      const proc = runPrCreated(fixture, { headCommit: fixture.context.baseCommit });

      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /remote_observation\.head_commit/u);
      assert.deepEqual(readJson(join(fixture.runDir, "run.json")), originalRun);
      assert.deepEqual(readJson(join(fixture.runDir, "attestations", "index.json")), originalIndex);
      assert.equal(existsSync(join(fixture.runDir, "attestations", "pr-created.json")), false);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when required PR authority options are omitted", () => {
    const fixture = createPrFixture("cli-pr-created-missing-option", { includePrerequisites: true });
    const originalRun = readJson(join(fixture.runDir, "run.json"));

    try {
      const proc = runPrCreated(fixture, { omitGithubAccount: true });

      assert.notEqual(proc.status, 0);
      assert.match(proc.stderr, /requires --github-account/u);
      assert.deepEqual(readJson(join(fixture.runDir, "run.json")), originalRun);
      assert.equal(existsSync(join(fixture.runDir, "attestations", "pr-created.json")), false);
    } finally {
      fixture.cleanup();
    }
  });
});

function runPrCreated(fixture, overrides = {}) {
  const args = [
    CLI,
    "factory",
    "pr-created",
    fixture.runId,
    "--pr-url",
    PR_URL,
    "--pr-number",
    "123",
    "--pr-body-ref",
    "artifacts/pr-body.md",
    "--provider",
    "github",
    "--repository",
    "example/repo",
    "--remote",
    "origin",
  ];
  if (!overrides.omitGithubAccount) args.push("--github-account", "octocat");
  args.push(
    "--head-branch",
    fixture.context.branch,
    "--head-commit",
    overrides.headCommit || fixture.context.headCommit,
    "--base-ref",
    "main",
    "--base-commit",
    fixture.context.baseCommit,
    "--draft",
    "--json",
  );
  return spawnSync(process.execPath, args, { cwd: fixture.repo, encoding: "utf8" });
}

function createPrFixture(runId, { includePrerequisites }) {
  const repo = mkdtempSync(join(tmpdir(), "feature-factory-cli-pr-"));
  try {
    initRepo(repo);
    const context = createFeatureWorktree(repo, runId);
    const runDir = join(repo, ".opencode", "factory", runId);
    for (const directory of ["artifacts", "attestations", "evidence", "gates", "reviews"]) {
      mkdirSync(join(runDir, directory), { recursive: true });
    }
    writeFixture(runDir, "artifacts/pr-body.md", "PR body\n");
    writeJson(join(runDir, "run.json"), baseRun(runId));
    if (includePrerequisites) {
      writePrPrerequisiteAuthority(runDir, runId, context);
    } else {
      writeRunBaseAuthority(runDir, runId, context);
    }
    return {
      repo,
      runId,
      runDir,
      context,
      cleanup() {
        cleanup(repo);
      },
    };
  } catch (error) {
    cleanup(repo);
    throw error;
  }
}

function initRepo(repo) {
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Feature Factory CLI Test"]);
  git(repo, ["config", "user.email", "factory-cli@example.com"]);
  writeFixture(repo, "tracked.txt", "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
}

function createFeatureWorktree(repo, runId) {
  const branch = `${runId}-branch`;
  const featureWorktree = join(repo, ".opencode", "worktrees", branch);
  mkdirSync(dirname(featureWorktree), { recursive: true });
  const baseCommit = gitStdout(repo, ["rev-parse", "HEAD"]);
  const baseTree = gitStdout(repo, ["rev-parse", "HEAD^{tree}"]);
  git(repo, ["worktree", "add", "-b", branch, featureWorktree, "HEAD"]);
  writeFixture(featureWorktree, "tracked.txt", "base\nfeature\n");
  git(featureWorktree, ["add", "."]);
  git(featureWorktree, ["commit", "-m", "feature"]);
  const headCommit = gitStdout(featureWorktree, ["rev-parse", "HEAD"]);
  const headTree = gitStdout(featureWorktree, ["rev-parse", "HEAD^{tree}"]);
  const gitCommonDir = gitStdout(featureWorktree, ["rev-parse", "--git-common-dir"]);
  const gitCommonDirPath = isAbsolute(gitCommonDir) ? gitCommonDir : join(featureWorktree, gitCommonDir);
  return {
    repoRoot: realpathSync.native(repo),
    branch,
    featureWorktree: realpathSync.native(featureWorktree),
    gitCommonDir: realpathSync.native(gitCommonDirPath),
    baseCommit,
    baseTree,
    headCommit,
    headTree,
  };
}

function writeRunBaseAuthority(runDir, runId, context) {
  const runBase = createRunBaseAttestation({
    run_id: runId,
    sequence: 1,
    prev_hash: null,
    created_at: "2026-07-07T00:00:00.000Z",
    bindings: {
      repo_root: context.repoRoot,
      run_dir: realpathSync.native(runDir),
      git_common_dir: context.gitCommonDir,
      feature_branch: context.branch,
      feature_worktree: context.featureWorktree,
      base_ref: "main",
      base_commit: context.baseCommit,
      base_tree: context.baseTree,
    },
  });
  writeAttestation(runDir, "attestations/run-base.json", runBase);
  writeJson(join(runDir, "attestations", "index.json"), createAttestationIndex([{ ref: "attestations/run-base.json", attestation: runBase }]));
  return runBase;
}

function writePrPrerequisiteAuthority(runDir, runId, context) {
  const runBase = writeRunBaseAuthority(runDir, runId, context);
  const directEvidenceRef = "evidence/direct-feature.json";
  const directReviewRef = "reviews/direct-feature.approval.json";
  writeJson(join(runDir, directEvidenceRef), { summary: "direct feature commit" });
  writeJson(join(runDir, directReviewRef), { subject: "feature-direct", reviewer: "work-reviewer", verdict: "APPROVE" });
  const guard = {
    status: "clean",
    safe_git_policy: SAFE_GIT_POLICY,
    worktree: context.featureWorktree,
    head_commit: context.headCommit,
    head_tree: context.headTree,
    dirty_paths: [],
    hidden_index_paths: [],
  };
  const directCommit = createDirectReviewedCommitAttestation({
    run_id: runId,
    sequence: 2,
    prev_hash: runBase.attestation_hash,
    bindings: {
      entry_id: "feature-direct",
      purpose: "validation-fix",
      commit: context.headCommit,
      parent_commit: context.baseCommit,
      tree: context.headTree,
      diff_hash: gitDiffHash(context.featureWorktree, context.baseCommit, context.headCommit),
      evidence_ref: directEvidenceRef,
      evidence_hash: hashFile(join(runDir, directEvidenceRef)),
      producing_role: "backend-builder",
      review_hash: hashFile(join(runDir, directReviewRef)),
      guard_result_hash: hashValue(guard),
    },
  });
  const reviewApproval = createReviewApprovalAttestation({
    run_id: runId,
    sequence: 3,
    prev_hash: directCommit.attestation_hash,
    bindings: {
      subject_type: "direct_commit",
      subject: "feature-direct",
      reviewer: "work-reviewer",
      verdict: "APPROVE",
      review_ref: directReviewRef,
      review_hash: hashFile(join(runDir, directReviewRef)),
      evidence_ref: directEvidenceRef,
      evidence_hash: hashFile(join(runDir, directEvidenceRef)),
      subject_commit: context.headCommit,
      subject_tree: context.headTree,
      guard_result_hash: hashValue(guard),
      guard,
    },
  });
  const mergeChain = createMergeChainAttestation({
    run_id: runId,
    sequence: 4,
    prev_hash: reviewApproval.attestation_hash,
    bindings: {
      feature_branch: context.branch,
      base_attestation_ref: "attestations/run-base.json",
      base_attestation_hash: runBase.attestation_hash,
      base_commit: context.baseCommit,
      head_commit: context.headCommit,
      head_tree: context.headTree,
      entries: [
        {
          type: "direct_reviewed_commit",
          commit: context.headCommit,
          direct_commit_attestation_ref: "attestations/direct-commits/feature-direct.json",
          direct_commit_attestation_hash: directCommit.attestation_hash,
          review_attestation_ref: "attestations/reviews/direct-feature.approval.json",
          review_attestation_hash: reviewApproval.attestation_hash,
        },
      ],
    },
  });
  writeFixture(runDir, "artifacts/pre_pr.md", "pre-pr artifact\n");
  writeFixture(runDir, "gates/pre_pr.question.md", "approve pre-pr?\n");
  writeFixture(runDir, "gates/pre_pr.answer", "approve\n");
  const prePrGate = createGateDecisionAttestation({
    run_id: runId,
    sequence: 5,
    prev_hash: mergeChain.attestation_hash,
    bindings: {
      gate: "pre_pr",
      decision: "approved",
      approval_source: "autonomous",
      question_ref: "gates/pre_pr.question.md",
      question_hash: hashFile(join(runDir, "gates", "pre_pr.question.md"), { mode: "raw" }),
      artifact_ref: "artifacts/pre_pr.md",
      artifact_hash: hashFile(join(runDir, "artifacts", "pre_pr.md"), { mode: "raw" }),
      answer_ref: "gates/pre_pr.answer",
      answer_hash: hashFile(join(runDir, "gates", "pre_pr.answer"), { mode: "raw" }),
    },
  });
  const records = [
    { ref: "attestations/run-base.json", attestation: runBase },
    { ref: "attestations/direct-commits/feature-direct.json", attestation: directCommit },
    { ref: "attestations/reviews/direct-feature.approval.json", attestation: reviewApproval },
    { ref: "attestations/merge-chain.json", attestation: mergeChain },
    { ref: "attestations/gates/pre_pr.json", attestation: prePrGate },
  ];
  for (const record of records.slice(1)) writeAttestation(runDir, record.ref, record.attestation);
  writeJson(join(runDir, "attestations", "index.json"), createAttestationIndex(records));
}

function baseRun(runId) {
  return {
    schema_version: 1,
    run_id: runId,
    mode: "headless",
    status: "running",
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
    gates: {},
    steps: [],
    slices: [],
    validator: null,
    security_review: null,
    pr_url: null,
    terminal_result: null,
  };
}

function writeAttestation(runDir, ref, attestation) {
  writeJson(join(runDir, ref), attestation);
}

function writeFixture(root, ref, contents) {
  const path = join(root, ref);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
  return path;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

function gitStdout(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function cleanup(path) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}
