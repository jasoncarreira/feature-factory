import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { SAFE_GIT_POLICY } from "../src/safe-git.js";
import {
  AUTHORITY_MODEL,
  checkWorktreeIdentity,
  createAttestationIndex,
  createGateDecisionAttestation,
  createMergeChainAttestation,
  createReviewApprovalAttestation,
  createRunBaseAttestation,
  createSliceObservationAttestation,
  hashFile,
  hashValue,
  resolveDurableRoots,
  resolveEvidenceRef,
  resolveReviewRef,
  validateAttestationGraph,
  validateProvenanceAuthority,
  validateReviewApprovalAttestation,
  withAttestationHash,
} from "../src/provenance-authority.js";

describe("provenance authority", () => {
  it("detects attestation tampering and prev_hash gaps in the attestation graph", () => {
    const root = mkdtempSync(join(tmpdir(), "prov-auth-graph-"));

    try {
      const runDir = createBareRunDir(root, "hash-run");
      const runBase = createRunBaseAttestation({
        run_id: "hash-run",
        sequence: 1,
        prev_hash: null,
        created_at: isoAt(1),
        bindings: {
          repo_root: root,
          run_dir: runDir,
          git_common_dir: root,
          feature_branch: "feature-branch",
          feature_worktree: root,
          base_ref: "refs/heads/main",
          base_commit: "base-commit",
          base_tree: "base-tree",
        },
      });
      const gateDecision = createGateDecisionAttestation({
        run_id: "hash-run",
        sequence: 2,
        prev_hash: runBase.attestation_hash,
        created_at: isoAt(2),
        bindings: {
          gate: "story",
          decision: "approved",
          approval_source: "human",
          question_ref: "artifacts/story-question.md",
          question_hash: hashValue("question"),
          artifact_ref: "artifacts/story.md",
          artifact_hash: hashValue("artifact"),
          answer_text_hash: hashValue("yes"),
        },
      });

      writeAttestation(runDir, "attestations/run-base.json", runBase);
      writeAttestation(runDir, "attestations/gates/story.json", gateDecision);
      writeJson(join(runDir, "attestations", "index.json"), createAttestationIndex([
        { ref: "attestations/run-base.json", attestation: runBase },
        { ref: "attestations/gates/story.json", attestation: gateDecision },
      ]));

      const valid = validateAttestationGraph(runDir);
      assert.equal(valid.ok, true);

      const tamperedRunBase = { ...runBase, bindings: { ...runBase.bindings, base_commit: "tampered-base" } };
      writeAttestation(runDir, "attestations/run-base.json", tamperedRunBase);

      const tampered = validateAttestationGraph(runDir);
      assert.equal(tampered.ok, false);
      assert.match(joinErrors(tampered), /hash mismatch/u);

      writeAttestation(runDir, "attestations/run-base.json", runBase);
      const gapGateDecision = createGateDecisionAttestation({
        run_id: "hash-run",
        sequence: 2,
        prev_hash: hashValue("forged-prev-hash"),
        created_at: isoAt(3),
        bindings: gateDecision.bindings,
      });
      writeAttestation(runDir, "attestations/gates/story.json", gapGateDecision);
      writeJson(join(runDir, "attestations", "index.json"), createAttestationIndex([
        { ref: "attestations/run-base.json", attestation: runBase },
        { ref: "attestations/gates/story.json", attestation: gapGateDecision },
      ]));

      const gap = validateAttestationGraph(runDir);
      assert.equal(gap.ok, false);
      assert.match(joinErrors(gap), /previous attestation hash/u);
    } finally {
      cleanup(root);
    }
  });

  it("rejects symlinked durable roots", () => {
    const root = mkdtempSync(join(tmpdir(), "prov-auth-symlink-"));
    const outsideEvidence = mkdtempSync(join(tmpdir(), "prov-auth-evidence-outside-"));

    try {
      const runDir = createBareRunDir(root, "symlink-run");
      cleanup(join(runDir, "evidence"));
      symlinkSync(outsideEvidence, join(runDir, "evidence"));

      assert.throws(() => resolveDurableRoots(runDir), /symlink|directory/u);
    } finally {
      cleanup(root);
      cleanup(outsideEvidence);
    }
  });

  it("rejects outside refs, forged worktree paths, and stale or inaccessible same-branch worktree entries", () => {
    const fixture = createHistoryFixture();
    const outsideWorktree = mkdtempSync(join(tmpdir(), "prov-auth-forged-worktree-"));
    const missingWorktree = join(tmpdir(), `prov-auth-missing-${Date.now()}`);
    const inaccessibleWorktree = join(tmpdir(), `prov-auth-inaccessible-${Date.now()}`);

    try {
      const runDir = createBareRunDir(fixture.repoRoot, "worktree-run");

      assert.throws(() => resolveEvidenceRef(runDir, "/tmp/evil.json"), /relative path/u);
      assert.throws(() => resolveReviewRef(runDir, "reviews/../evil.json"), /must not contain/u);

      const forged = checkWorktreeIdentity(fixture.repoRoot, fixture.merges[0].sliceBranch, outsideWorktree);
      assert.equal(forged.ok, false);
      assert.match(joinErrors(forged), /expected branch path|physically contained/u);

      const conflict = checkWorktreeIdentity(fixture.repoRoot, fixture.merges[0].sliceBranch, fixture.merges[0].sliceWorktree, {
        safeGitFn(cwd, args) {
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
            return fakeGitResult(`${fixture.gitCommonDir}\n`);
          }
          if (args[0] === "symbolic-ref") {
            return fakeGitResult(`${fixture.merges[0].sliceBranch}\n`);
          }
          if (args[0] === "worktree") {
            return fakeGitResult([
              `worktree ${fixture.merges[0].sliceWorktree}`,
              `HEAD ${fixture.merges[0].sliceCommit}`,
              `branch refs/heads/${fixture.merges[0].sliceBranch}`,
              "",
              `worktree ${missingWorktree}`,
              "HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
              `branch refs/heads/${fixture.merges[0].sliceBranch}`,
              "",
              `worktree ${inaccessibleWorktree}`,
              "HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
              `branch refs/heads/${fixture.merges[0].sliceBranch}`,
              "",
            ].join("\n"));
          }
          throw new Error(`unexpected git observation: ${cwd} ${args.join(" ")}`);
        },
        realpathFn(pathValue) {
          const normalized = resolve(pathValue);
          if (normalized === resolve(missingWorktree)) {
            const error = new Error("missing");
            error.code = "ENOENT";
            throw error;
          }
          if (normalized === resolve(inaccessibleWorktree)) {
            const error = new Error("inaccessible");
            error.code = "EACCES";
            throw error;
          }
          return realpathSync.native(pathValue);
        },
      });
      assert.equal(conflict.ok, false);
      assert.match(joinErrors(conflict), /missing|inaccessible/u);
    } finally {
      cleanup(fixture.repoRoot);
      cleanup(outsideWorktree);
    }
  });

  it("rejects forged review approvals whose review, evidence, or guard bindings do not match", () => {
    const fixture = createHistoryFixture();

    try {
      const run = buildAuthorityRun(fixture, "forged-review-run");
      const firstSlice = run.slices[0];
      const context = {
        runDir: run.runDir,
        expectedWorktree: firstSlice.sliceWorktree,
        subjectCommit: firstSlice.sliceCommit,
        subjectTree: firstSlice.sliceTree,
        evidenceRef: firstSlice.evidenceRef,
        evidenceHash: firstSlice.evidenceHash,
      };

      const forgedReviewHash = withAttestationHash({
        ...firstSlice.reviewAttestation,
        bindings: {
          ...firstSlice.reviewAttestation.bindings,
          review_hash: hashValue("forged-review"),
        },
      });
      const forgedEvidenceHash = withAttestationHash({
        ...firstSlice.reviewAttestation,
        bindings: {
          ...firstSlice.reviewAttestation.bindings,
          evidence_hash: hashValue("forged-evidence"),
        },
      });
      const forgedGuardHash = withAttestationHash({
        ...firstSlice.reviewAttestation,
        bindings: {
          ...firstSlice.reviewAttestation.bindings,
          guard_result_hash: hashValue("forged-guard"),
        },
      });

      const reviewHashResult = validateReviewApprovalAttestation(forgedReviewHash, context);
      const evidenceHashResult = validateReviewApprovalAttestation(forgedEvidenceHash, context);
      const guardHashResult = validateReviewApprovalAttestation(forgedGuardHash, context);

      assert.equal(reviewHashResult.ok, false);
      assert.match(joinErrors(reviewHashResult), /review hash/u);

      assert.equal(evidenceHashResult.ok, false);
      assert.match(joinErrors(evidenceHashResult), /evidence hash/u);

      assert.equal(guardHashResult.ok, false);
      assert.match(joinErrors(guardHashResult), /guard hash/u);
    } finally {
      cleanup(fixture.repoRoot);
    }
  });

  it("rejects direct commits before, between, or after reviewed slice merges when no direct-reviewed-commit proof exists", () => {
    const scenarios = [
      { name: "before", options: { directBefore: true } },
      { name: "between", options: { directBetween: true, secondSlice: true } },
      { name: "after", options: { directAfter: true } },
    ];

    for (const scenario of scenarios) {
      const fixture = createHistoryFixture(scenario.options);
      try {
        const run = buildAuthorityRun(fixture, `missing-direct-${scenario.name}`);
        const result = validateProvenanceAuthority(run.runDir);

        assert.equal(result.ok, false, `expected ${scenario.name} scenario to fail`);
        assert.match(joinErrors(result), /one entry for every first-parent commit/u);
      } finally {
        cleanup(fixture.repoRoot);
      }
    }
  });

  it("rejects reviewed-looking merge commits that include extra direct tree edits", () => {
    const fixture = createHistoryFixture({ extraMergeEdit: true });

    try {
      const run = buildAuthorityRun(fixture, "extra-merge-edit");
      const result = validateProvenanceAuthority(run.runDir);

      assert.equal(result.ok, false);
      assert.match(joinErrors(result), /merge-tree result/u);
    } finally {
      cleanup(fixture.repoRoot);
    }
  });

  it("accepts a valid minimal attestation graph and reviewed merge chain", () => {
    const fixture = createHistoryFixture();

    try {
      const run = buildAuthorityRun(fixture, "valid-minimal");
      const result = validateProvenanceAuthority(run.runDir);

      assert.equal(result.ok, true);
      assert.equal(result.acceptedAttestations["attestations/run-base.json"].attestation.authority_model, AUTHORITY_MODEL);
      assert.equal(result.acceptedAttestations["attestations/merge-chain.json"].attestation.type, "merge-chain");
    } finally {
      cleanup(fixture.repoRoot);
    }
  });
});

function buildAuthorityRun(fixture, runId) {
  const runDir = createBareRunDir(fixture.repoRoot, runId);
  const runBase = createRunBaseAttestation({
    run_id: runId,
    sequence: 1,
    prev_hash: null,
    created_at: isoAt(1),
    bindings: {
      repo_root: fixture.repoRoot,
      run_dir: runDir,
      git_common_dir: fixture.gitCommonDir,
      feature_branch: fixture.featureBranch,
      feature_worktree: fixture.featureWorktree,
      base_ref: "refs/heads/main",
      base_commit: fixture.baseCommit,
      base_tree: fixture.baseTree,
    },
  });

  const records = [{ ref: "attestations/run-base.json", attestation: runBase }];
  const slices = [];
  let sequence = 2;
  let prevHash = runBase.attestation_hash;

  for (const merge of fixture.merges) {
    const evidenceRef = `evidence/${merge.sliceBranch}.json`;
    const evidencePath = join(runDir, ...evidenceRef.split("/"));
    writeJson(evidencePath, {
      slice_id: merge.sliceBranch,
      observed_commit: merge.sliceCommit,
      base_commit: merge.sliceBaseCommit,
    });
    const reviewRef = `reviews/${merge.sliceBranch}.json`;
    const reviewPath = join(runDir, ...reviewRef.split("/"));
    writeJson(reviewPath, {
      subject: merge.sliceBranch,
      verdict: "approved",
      reviewer: "work-reviewer",
    });

    const evidenceHash = hashFile(evidencePath);
    const reviewHash = hashFile(reviewPath);
    const guard = {
      status: "clean",
      safe_git_policy: SAFE_GIT_POLICY,
      worktree: merge.sliceWorktree,
      head_commit: merge.sliceCommit,
      head_tree: merge.sliceTree,
      dirty_paths: [],
      hidden_index_paths: [],
    };

    const sliceAttestationRef = `attestations/slices/${merge.sliceBranch}.observation.json`;
    const sliceAttestation = createSliceObservationAttestation({
      run_id: runId,
      sequence,
      prev_hash: prevHash,
      created_at: isoAt(sequence),
      bindings: {
        slice_id: merge.sliceBranch,
        attempt: 1,
        branch: merge.sliceBranch,
        worktree: merge.sliceWorktree,
        base_commit: merge.sliceBaseCommit,
        slice_commit: merge.sliceCommit,
        slice_tree: merge.sliceTree,
        evidence_ref: evidenceRef,
        evidence_hash: evidenceHash,
      },
    });
    sequence += 1;
    prevHash = sliceAttestation.attestation_hash;

    const reviewAttestationRef = `attestations/reviews/${merge.sliceBranch}.approval.json`;
    const reviewAttestation = createReviewApprovalAttestation({
      run_id: runId,
      sequence,
      prev_hash: prevHash,
      created_at: isoAt(sequence),
      bindings: {
        subject_type: "slice",
        subject: merge.sliceBranch,
        reviewer: "work-reviewer",
        verdict: "approved",
        review_ref: reviewRef,
        review_hash: reviewHash,
        evidence_ref: evidenceRef,
        evidence_hash: evidenceHash,
        subject_commit: merge.sliceCommit,
        subject_tree: merge.sliceTree,
        guard_result_hash: hashValue(guard),
        guard,
      },
    });
    sequence += 1;
    prevHash = reviewAttestation.attestation_hash;

    records.push({ ref: sliceAttestationRef, attestation: sliceAttestation });
    records.push({ ref: reviewAttestationRef, attestation: reviewAttestation });
    slices.push({
      sliceBranch: merge.sliceBranch,
      sliceWorktree: merge.sliceWorktree,
      sliceCommit: merge.sliceCommit,
      sliceTree: merge.sliceTree,
      evidenceRef,
      evidenceHash,
      reviewRef,
      reviewHash,
      guard,
      sliceAttestationRef,
      sliceAttestation,
      reviewAttestationRef,
      reviewAttestation,
      mergeCommit: merge.mergeCommit,
    });
  }

  const mergeChain = createMergeChainAttestation({
    run_id: runId,
    sequence,
    prev_hash: prevHash,
    created_at: isoAt(sequence),
    bindings: {
      feature_branch: fixture.featureBranch,
      base_attestation_ref: "attestations/run-base.json",
      base_attestation_hash: runBase.attestation_hash,
      base_commit: fixture.baseCommit,
      head_commit: fixture.headCommit,
      head_tree: fixture.headTree,
      entries: slices.map((slice) => ({
        type: "slice_merge",
        commit: slice.mergeCommit,
        slice_commit: slice.sliceCommit,
        slice_attestation_ref: slice.sliceAttestationRef,
        slice_attestation_hash: slice.sliceAttestation.attestation_hash,
        review_attestation_ref: slice.reviewAttestationRef,
        review_attestation_hash: slice.reviewAttestation.attestation_hash,
      })),
    },
  });
  records.push({ ref: "attestations/merge-chain.json", attestation: mergeChain });

  for (const record of records) writeAttestation(runDir, record.ref, record.attestation);
  writeJson(join(runDir, "attestations", "index.json"), createAttestationIndex(records));

  return {
    runDir,
    runBase,
    mergeChain,
    slices,
  };
}

function createHistoryFixture(options = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "prov-auth-repo-"));
  mkdirSync(join(repoRoot, ".opencode", "worktrees"), { recursive: true });
  mkdirSync(join(repoRoot, ".opencode", "factory"), { recursive: true });

  git(repoRoot, ["init", "-b", "main"]);
  git(repoRoot, ["config", "user.name", "Provenance Authority Test"]);
  git(repoRoot, ["config", "user.email", "provenance-authority@example.com"]);

  writeFixture(repoRoot, "tracked.txt", "base\n");
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "base"]);

  const featureBranch = "feature-branch";
  const featureWorktree = join(repoRoot, ".opencode", "worktrees", featureBranch);
  git(repoRoot, ["worktree", "add", "-b", featureBranch, featureWorktree, "HEAD"]);

  if (options.directBefore) commitFile(featureWorktree, "feature-before.txt", "before\n", "feature before merge");

  const merges = [];
  const sliceOne = createSliceWorktree(repoRoot, featureWorktree, "slice-1", "slice-one.txt", "slice one\n", "slice one");
  mergeSlice(featureWorktree, sliceOne.sliceBranch, { extraMergeEdit: Boolean(options.extraMergeEdit) });
  merges.push({
    ...sliceOne,
    mergeCommit: head(featureWorktree),
    mergeTree: tree(featureWorktree, "HEAD"),
  });

  if (options.directBetween) commitFile(featureWorktree, "feature-between.txt", "between\n", "feature between merges");

  if (options.secondSlice) {
    const sliceTwo = createSliceWorktree(repoRoot, featureWorktree, "slice-2", "slice-two.txt", "slice two\n", "slice two");
    mergeSlice(featureWorktree, sliceTwo.sliceBranch);
    merges.push({
      ...sliceTwo,
      mergeCommit: head(featureWorktree),
      mergeTree: tree(featureWorktree, "HEAD"),
    });
  }

  if (options.directAfter) commitFile(featureWorktree, "feature-after.txt", "after\n", "feature after merge");

  return {
    repoRoot: realpathSync.native(repoRoot),
    featureBranch,
    featureWorktree: realpathSync.native(featureWorktree),
    gitCommonDir: realpathSync.native(resolve(featureWorktree, gitStdout(featureWorktree, ["rev-parse", "--git-common-dir"]).trim())),
    baseCommit: head(repoRoot),
    baseTree: tree(repoRoot, head(repoRoot)),
    headCommit: head(featureWorktree),
    headTree: tree(featureWorktree, "HEAD"),
    merges,
  };
}

function createSliceWorktree(repoRoot, featureWorktree, sliceBranch, fileName, content, commitMessage) {
  const sliceBaseCommit = head(featureWorktree);
  const sliceWorktree = join(repoRoot, ".opencode", "worktrees", sliceBranch);
  git(repoRoot, ["worktree", "add", "-b", sliceBranch, sliceWorktree, "feature-branch"]);
  writeFixture(sliceWorktree, fileName, content);
  git(sliceWorktree, ["add", "."]);
  git(sliceWorktree, ["commit", "-m", commitMessage]);

  return {
    sliceBranch,
    sliceBaseCommit,
    sliceWorktree: realpathSync.native(sliceWorktree),
    sliceCommit: head(sliceWorktree),
    sliceTree: tree(sliceWorktree, "HEAD"),
  };
}

function mergeSlice(featureWorktree, sliceBranch, options = {}) {
  if (options.extraMergeEdit) {
    git(featureWorktree, ["merge", "--no-ff", "--no-commit", sliceBranch]);
    writeFixture(featureWorktree, "merge-extra.txt", "extra merge edit\n");
    git(featureWorktree, ["add", "."]);
    git(featureWorktree, ["commit", "-m", `merge ${sliceBranch} with extra edit`]);
    return;
  }

  git(featureWorktree, ["merge", "--no-ff", sliceBranch, "-m", `merge ${sliceBranch}`]);
}

function createBareRunDir(root, runId) {
  const runDir = join(root, ".opencode", "factory", runId);
  for (const directory of [runDir, join(runDir, "evidence"), join(runDir, "artifacts"), join(runDir, "reviews"), join(runDir, "attestations")]) {
    mkdirSync(directory, { recursive: true });
  }
  return runDir;
}

function writeAttestation(runDir, ref, value) {
  writeJson(join(runDir, ...ref.split("/")), value);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeFixture(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function commitFile(cwd, relativePath, content, message) {
  writeFixture(cwd, relativePath, content);
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", message]);
}

function head(cwd) {
  return gitStdout(cwd, ["rev-parse", "HEAD"]).trim();
}

function tree(cwd, rev) {
  return gitStdout(cwd, ["rev-parse", `${rev}^{tree}`]).trim();
}

function git(cwd, args) {
  const proc = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (proc.error) throw proc.error;
  assert.equal(proc.status, 0, `git ${args.join(" ")} failed:\n${proc.stderr || proc.stdout}`);
  return proc;
}

function gitStdout(cwd, args) {
  return git(cwd, args).stdout;
}

function fakeGitResult(stdout, status = 0, stderr = "") {
  return {
    ok: status === 0,
    status,
    stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
    stderr,
    command: { file: "git", cwd: null, args: [], shell: false, timeout: 0, maxBuffer: 0 },
    policy: SAFE_GIT_POLICY,
  };
}

function joinErrors(result) {
  const checks = Array.isArray(result?.checks) ? result.checks : [result];
  return checks
    .flatMap((check) => Array.isArray(check?.errors) ? check.errors : [])
    .map((error) => `${error.path}: ${error.message}`)
    .join("\n");
}

function isoAt(second) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}
