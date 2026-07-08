import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { SAFE_GIT_POLICY } from "../src/safe-git.js";
import {
  AUTHORITY_MODEL,
  checkWorktreeIdentity,
  createAttestationIndex,
  createDirectReviewedCommitAttestation,
  createGateDecisionAttestation,
  createMergeChainAttestation,
  createPrCreatedAttestation,
  createReviewApprovalAttestation,
  createRunBaseAttestation,
  createSliceObservationAttestation,
  hashFile,
  hashValue,
  resolveDurableRoots,
  resolveEvidenceRef,
  resolveReviewRef,
  validateAttestationGraph,
  validateGateDecisionAttestation,
  validateProvenanceAuthority,
  validatePrCreatedAttestation,
  validateReviewApprovalAttestation,
  withAttestationHash,
} from "../src/provenance-authority.js";

describe("provenance authority", () => {
  it("detects attestation tampering and prev_hash gaps in the attestation graph", () => {
    const root = mkdtempSync(join(tmpdir(), "prov-auth-graph-"));

    try {
      const runDir = createBareRunDir(root, "hash-run");
      writeFixture(runDir, "artifacts/story.md", "artifact\n");
      writeFixture(runDir, "gates/story.question.md", "question\n");
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
          approval_source: "autonomous",
          question_ref: "gates/story.question.md",
          question_hash: hashFile(join(runDir, "gates/story.question.md")),
          artifact_ref: "artifacts/story.md",
          artifact_hash: hashFile(join(runDir, "artifacts/story.md")),
          answer_text_hash: hashValue("yes"),
        },
      });

      const gateValidation = validateGateDecisionAttestation(gateDecision, { runDir });
      assert.equal(gateValidation.ok, true);

      writeAttestation(runDir, "attestations/run-base.json", runBase);
      writeAttestation(runDir, "attestations/gates/story.json", gateDecision);
      writeJson(join(runDir, "attestations", "index.json"), createAttestationIndex([
        { ref: "attestations/run-base.json", attestation: runBase },
        { ref: "attestations/gates/story.json", attestation: gateDecision },
      ]));

      const valid = validateAttestationGraph(runDir);
      assert.equal(valid.ok, true);
      assert.deepEqual(valid.orderedRefs, [
        "attestations/run-base.json",
        "attestations/gates/story.json",
      ]);

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

  it("fails closed when attestations/index.json is empty even if gate attestations exist on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "prov-auth-empty-index-"));

    try {
      const runDir = createBareRunDir(root, "empty-index");
      writeFixture(runDir, "artifacts/story.md", "story artifact\n");
      writeFixture(runDir, "gates/story.question.md", "story question\n");
      const runBase = createRunBaseAttestation({
        run_id: "empty-index",
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
        run_id: "empty-index",
        sequence: 2,
        prev_hash: runBase.attestation_hash,
        created_at: isoAt(2),
        bindings: {
          gate: "story",
          decision: "approved",
          approval_source: "autonomous",
          question_ref: "gates/story.question.md",
          question_hash: hashFile(join(runDir, "gates/story.question.md")),
          artifact_ref: "artifacts/story.md",
          artifact_hash: hashFile(join(runDir, "artifacts/story.md")),
          answer_text_hash: hashValue("yes"),
        },
      });

      const gateValidation = validateGateDecisionAttestation(gateDecision, { runDir });
      assert.equal(gateValidation.ok, true);

      writeAttestation(runDir, "attestations/run-base.json", runBase);
      writeAttestation(runDir, "attestations/gates/story.json", gateDecision);
      writeJson(join(runDir, "attestations", "index.json"), createAttestationIndex([]));

      const graph = validateAttestationGraph(runDir);
      assert.equal(graph.ok, false);
      assert.deepEqual(graph.orderedRefs, []);
      assert.deepEqual(Object.keys(graph.acceptedAttestations), []);
      assert.match(joinErrors(graph), /attestations\/index\.json\.entries: must be a non-empty array/u);

      const authority = validateProvenanceAuthority(runDir);
      assert.equal(authority.ok, false);
      assert.deepEqual(authority.orderedRefs, []);
      assert.deepEqual(Object.keys(authority.acceptedAttestations), []);
      assert.match(joinErrors(authority), /attestations\/index\.json\.entries: must be a non-empty array/u);
    } finally {
      cleanup(root);
    }
  });

  it("rejects attestation graphs that place gate decisions before run-base", () => {
    const root = mkdtempSync(join(tmpdir(), "prov-auth-gate-order-"));

    try {
      const runDir = createBareRunDir(root, "gate-order");
      writeFixture(runDir, "artifacts/story.md", "story artifact\n");
      writeFixture(runDir, "gates/story.question.md", "story question\n");

      const gateDecision = createGateDecisionAttestation({
        run_id: "gate-order",
        sequence: 1,
        prev_hash: null,
        created_at: isoAt(1),
        bindings: {
          gate: "story",
          decision: "approved",
          approval_source: "autonomous",
          question_ref: "gates/story.question.md",
          question_hash: hashFile(join(runDir, "gates/story.question.md")),
          artifact_ref: "artifacts/story.md",
          artifact_hash: hashFile(join(runDir, "artifacts/story.md")),
          answer_text_hash: hashValue("yes"),
        },
      });
      const runBase = createRunBaseAttestation({
        run_id: "gate-order",
        sequence: 2,
        prev_hash: gateDecision.attestation_hash,
        created_at: isoAt(2),
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

      const gateValidation = validateGateDecisionAttestation(gateDecision, { runDir });
      assert.equal(gateValidation.ok, true);

      writeAttestation(runDir, "attestations/gates/story.json", gateDecision);
      writeAttestation(runDir, "attestations/run-base.json", runBase);
      writeJson(join(runDir, "attestations", "index.json"), createAttestationIndex([
        { ref: "attestations/gates/story.json", attestation: gateDecision },
        { ref: "attestations/run-base.json", attestation: runBase },
      ]));

      const result = validateAttestationGraph(runDir);
      assert.equal(result.ok, false);
      assert.deepEqual(result.orderedRefs, [
        "attestations/gates/story.json",
        "attestations/run-base.json",
      ]);
      assert.match(joinErrors(result), /attestations\/gates\/story\.json: the first attestation in the graph must be run-base/u);
    } finally {
      cleanup(root);
    }
  });

  it("accepts gates/ question and answer refs for approved gate decisions and rejects artifact-rooted refs", () => {
    const root = mkdtempSync(join(tmpdir(), "prov-auth-gate-refs-"));

    try {
      const runDir = createBareRunDir(root, "gate-refs");
      writeFixture(runDir, "artifacts/story.md", "story artifact\n");
      writeFixture(runDir, "gates/story.question.md", "story question\n");
      writeFixture(runDir, "gates/story.answer", "approve\n");
      writeFixture(runDir, "artifacts/story-question.md", "artifact question\n");
      writeFixture(runDir, "artifacts/story.answer", "approve\n");

      const valid = createGateDecisionAttestation({
        run_id: "gate-refs",
        sequence: 1,
        prev_hash: null,
        created_at: isoAt(1),
        bindings: {
          gate: "story",
          decision: "approved",
          approval_source: "human",
          question_ref: "gates/story.question.md",
          question_hash: hashFile(join(runDir, "gates/story.question.md")),
          artifact_ref: "artifacts/story.md",
          artifact_hash: hashFile(join(runDir, "artifacts/story.md")),
          answer_ref: "gates/story.answer",
          answer_hash: hashFile(join(runDir, "gates/story.answer")),
        },
      });

      const validResult = validateGateDecisionAttestation(valid, { runDir });
      assert.equal(validResult.ok, true);

      const artifactRooted = createGateDecisionAttestation({
        run_id: "gate-refs",
        sequence: 2,
        prev_hash: valid.attestation_hash,
        created_at: isoAt(2),
        bindings: {
          gate: "story",
          decision: "approved",
          approval_source: "human",
          question_ref: "artifacts/story-question.md",
          question_hash: hashFile(join(runDir, "artifacts/story-question.md")),
          artifact_ref: "artifacts/story.md",
          artifact_hash: hashFile(join(runDir, "artifacts/story.md")),
          answer_ref: "artifacts/story.answer",
          answer_hash: hashFile(join(runDir, "artifacts/story.answer")),
        },
      });

      const artifactRootedResult = validateGateDecisionAttestation(artifactRooted, { runDir });
      assert.equal(artifactRootedResult.ok, false);
      assert.match(joinErrors(artifactRootedResult), /artifacts\/story-question\.md must be rooted under gates\//u);
      assert.match(joinErrors(artifactRootedResult), /artifacts\/story\.answer must be rooted under gates\//u);
    } finally {
      cleanup(root);
    }
  });

  it("keeps escape and symlink protections for gate question and answer refs", () => {
    const root = mkdtempSync(join(tmpdir(), "prov-auth-gate-protections-"));

    try {
      const runDir = createBareRunDir(root, "gate-protections");
      writeFixture(runDir, "artifacts/story.md", "story artifact\n");
      writeFixture(runDir, "gates/story.question.md", "story question\n");
      writeFixture(runDir, "gates/story.answer", "approve\n");

      const escaped = createGateDecisionAttestation({
        run_id: "gate-protections",
        sequence: 1,
        prev_hash: null,
        created_at: isoAt(1),
        bindings: {
          gate: "story",
          decision: "approved",
          approval_source: "human",
          question_ref: "gates/../story.question.md",
          question_hash: hashFile(join(runDir, "gates/story.question.md")),
          artifact_ref: "artifacts/story.md",
          artifact_hash: hashFile(join(runDir, "artifacts/story.md")),
          answer_ref: "gates/story.answer",
          answer_hash: hashFile(join(runDir, "gates/story.answer")),
        },
      });

      const escapedResult = validateGateDecisionAttestation(escaped, { runDir });
      assert.equal(escapedResult.ok, false);
      assert.match(joinErrors(escapedResult), /must not contain empty, '\.' or '\.\.' segments/u);

      cleanup(join(runDir, "gates", "story.answer"));
      writeFixture(root, "outside-answer.txt", "approve\n");
      symlinkSync(join(root, "outside-answer.txt"), join(runDir, "gates", "story.answer"));

      const symlinked = createGateDecisionAttestation({
        run_id: "gate-protections",
        sequence: 2,
        prev_hash: null,
        created_at: isoAt(2),
        bindings: {
          gate: "story",
          decision: "approved",
          approval_source: "human",
          question_ref: "gates/story.question.md",
          question_hash: hashFile(join(runDir, "gates/story.question.md")),
          artifact_ref: "artifacts/story.md",
          artifact_hash: hashFile(join(runDir, "artifacts/story.md")),
          answer_ref: "gates/story.answer",
          answer_hash: hashFile(join(root, "outside-answer.txt")),
        },
      });

      const symlinkedResult = validateGateDecisionAttestation(symlinked, { runDir });
      assert.equal(symlinkedResult.ok, false);
      assert.match(joinErrors(symlinkedResult), /must not traverse symlinks/u);
    } finally {
      cleanup(root);
    }
  });

  it("rejects symlinked durable roots", () => {
    const scenarios = ["evidence", "artifacts", "reviews", "attestations"];

    for (const rootName of scenarios) {
      const root = mkdtempSync(join(tmpdir(), `prov-auth-symlink-${rootName}-`));
      const outsideRoot = mkdtempSync(join(tmpdir(), `prov-auth-outside-${rootName}-`));

      try {
        const runDir = createBareRunDir(root, `symlink-run-${rootName}`);
        cleanup(join(runDir, rootName));
        symlinkSync(outsideRoot, join(runDir, rootName));

        assert.throws(() => resolveDurableRoots(runDir), /symlink|directory/u, rootName);
      } finally {
        cleanup(root);
        cleanup(outsideRoot);
      }
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

  it("rejects merge-chain references to attestations that exist on disk but were never accepted into the graph", () => {
    const fixture = createHistoryFixture();

    try {
      const run = buildAuthorityRun(fixture, "unindexed-reference", {
        unindexedAttestationRefs: ["attestations/reviews/slice-1.approval.json"],
      });
      const result = validateProvenanceAuthority(run.runDir);

      assert.equal(result.ok, false);
      assert.match(joinErrors(result), /accepted attestation not found/u);
    } finally {
      cleanup(fixture.repoRoot);
    }
  });

  it("rejects merge-chain base attestation refs that are unindexed or mismatched even when the hash matches the real run-base", () => {
    const scenarios = [
      {
        name: "unindexed",
        mutate(run) {
          writeAttestation(run.runDir, "attestations/run-base-copy.json", run.runBase);
          rewriteMergeChainBaseAttestationRef(run.runDir, "attestations/run-base-copy.json");
        },
        error: /accepted attestation not found/u,
      },
      {
        name: "mismatched",
        mutate(run) {
          rewriteMergeChainBaseAttestationRef(run.runDir, run.slices[0].sliceAttestationRef);
        },
        error: /must match attestation|must match .*slice-1/u,
      },
    ];

    for (const scenario of scenarios) {
      const fixture = createHistoryFixture();
      try {
        const run = buildAuthorityRun(fixture, `base-attestation-ref-${scenario.name}`);
        scenario.mutate(run);

        const result = validateProvenanceAuthority(run.runDir);
        assert.equal(result.ok, false, `expected ${scenario.name} base attestation ref to fail`);
        assert.match(joinErrors(result), scenario.error);
      } finally {
        cleanup(fixture.repoRoot);
      }
    }
  });

  it("rejects non-approving and mismatched review approvals", () => {
    const fixture = createHistoryFixture();

    try {
      const run = buildAuthorityRun(fixture, "review-approval-failures");
      const firstSlice = run.slices[0];
      const reviewPath = join(run.runDir, ...firstSlice.reviewRef.split("/"));
      const context = {
        runDir: run.runDir,
        expectedWorktree: firstSlice.sliceWorktree,
        subjectCommit: firstSlice.sliceCommit,
        subjectTree: firstSlice.sliceTree,
        evidenceRef: firstSlice.evidenceRef,
        evidenceHash: firstSlice.evidenceHash,
      };

      const nonApproving = withAttestationHash({
        ...firstSlice.reviewAttestation,
        bindings: {
          ...firstSlice.reviewAttestation.bindings,
          verdict: "REJECT",
        },
      });
      const nonApprovingResult = validateReviewApprovalAttestation(nonApproving, context);
      assert.equal(nonApprovingResult.ok, false);
      assert.match(joinErrors(nonApprovingResult), /APPROVE/u);

      writeJson(reviewPath, {
        subject: `${firstSlice.sliceBranch}-other`,
        reviewer: "work-reviewer",
        verdict: "APPROVE",
      });
      const subjectMismatch = withAttestationHash({
        ...firstSlice.reviewAttestation,
        bindings: {
          ...firstSlice.reviewAttestation.bindings,
          review_hash: hashFile(reviewPath),
        },
      });
      const subjectMismatchResult = validateReviewApprovalAttestation(subjectMismatch, context);
      assert.equal(subjectMismatchResult.ok, false);
      assert.match(joinErrors(subjectMismatchResult), /review subject/u);

      writeJson(reviewPath, {
        subject: firstSlice.sliceBranch,
        reviewer: "security-reviewer",
        verdict: "PASS",
      });
      const reviewerMismatch = withAttestationHash({
        ...firstSlice.reviewAttestation,
        bindings: {
          ...firstSlice.reviewAttestation.bindings,
          review_hash: hashFile(reviewPath),
        },
      });
      const reviewerMismatchResult = validateReviewApprovalAttestation(reviewerMismatch, context);
      assert.equal(reviewerMismatchResult.ok, false);
      assert.match(joinErrors(reviewerMismatchResult), /review reviewer/u);

      writeJson(reviewPath, {
        subject: firstSlice.sliceBranch,
        reviewer: "work-reviewer",
        verdict: "REJECT",
      });
      const verdictMismatch = withAttestationHash({
        ...firstSlice.reviewAttestation,
        bindings: {
          ...firstSlice.reviewAttestation.bindings,
          review_hash: hashFile(reviewPath),
        },
      });
      const verdictMismatchResult = validateReviewApprovalAttestation(verdictMismatch, context);
      assert.equal(verdictMismatchResult.ok, false);
      assert.match(joinErrors(verdictMismatchResult), /review verdict/u);
    } finally {
      cleanup(fixture.repoRoot);
    }
  });

  it("re-observes guard cleanliness and rejects dirty or hidden-index worktrees", () => {
    const scenarios = [
      {
        name: "dirty",
        mutate(run) {
          writeFixture(run.slices[0].sliceWorktree, "slice-one.txt", "changed after review\n");
        },
        error: /guard re-observation is dirty/u,
      },
      {
        name: "hidden-index",
        mutate(run) {
          git(run.slices[0].sliceWorktree, ["update-index", "--assume-unchanged", "slice-one.txt"]);
        },
        error: /guard re-observation is dirty/u,
      },
    ];

    for (const scenario of scenarios) {
      const fixture = createHistoryFixture();
      try {
        const run = buildAuthorityRun(fixture, `guard-${scenario.name}`);
        scenario.mutate(run);
        const result = validateProvenanceAuthority(run.runDir);

        assert.equal(result.ok, false, `expected ${scenario.name} guard scenario to fail`);
        assert.match(joinErrors(result), scenario.error);
      } finally {
        cleanup(fixture.repoRoot);
      }
    }
  });

  it("checks review guard worktree containment before re-observing guard cleanliness", () => {
    const fixture = createHistoryFixture();

    try {
      const run = buildAuthorityRun(fixture, "guard-containment-before-observation");
      const firstSlice = run.slices[0];
      git(fixture.repoRoot, ["config", "filter.evil.clean", "sh -c pwn"]);
      const forgedGuard = {
        ...firstSlice.reviewAttestation.bindings.guard,
        worktree: fixture.repoRoot,
      };
      const forgedReviewApproval = withAttestationHash({
        ...firstSlice.reviewAttestation,
        bindings: {
          ...firstSlice.reviewAttestation.bindings,
          guard: forgedGuard,
          guard_result_hash: hashValue(forgedGuard),
        },
      });

      const result = validateReviewApprovalAttestation(forgedReviewApproval, {
        runDir: run.runDir,
        runBase: run.runBase,
      });

      assert.equal(result.ok, false);
      assert.match(joinErrors(result), /guard worktree must be physically contained/u);
      assert.doesNotMatch(joinErrors(result), /unsafe git config/u);
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

  it("accepts a valid direct_reviewed_commit merge-chain proof", () => {
    const fixture = createHistoryFixture({ directAfter: true });

    try {
      const run = buildAuthorityRun(fixture, "valid-direct-reviewed-commit", { includeDirectProofs: true });
      const result = validateProvenanceAuthority(run.runDir);

      assert.equal(result.ok, true);
      assert.equal(run.directs.length, 1);
      assert.equal(result.acceptedAttestations[run.directs[0].directAttestationRef].attestation.type, "direct-reviewed-commit");
    } finally {
      cleanup(fixture.repoRoot);
    }
  });

  it("rejects laundered direct_reviewed_commit proofs that omit review and guard bindings", () => {
    const fixture = createHistoryFixture({ directAfter: true });

    try {
      const run = buildAuthorityRun(fixture, "laundered-direct-reviewed-commit", {
        includeDirectProofs: true,
        launderDirectProofs: true,
      });
      const result = validateProvenanceAuthority(run.runDir);

      assert.equal(result.ok, false);
      assert.match(joinErrors(result), /review_hash|guard_result_hash/u);
    } finally {
      cleanup(fixture.repoRoot);
    }
  });

  it("fails closed on conflict-resolved slice merges without executing repo-local merge drivers during validation", () => {
    const fixture = createConflictingSliceMergeFixture();

    try {
      const run = buildAuthorityRun(fixture, "merge-driver-conflict");
      assert.equal(existsSync(fixture.mergeDriverSentinelPath), true, "fixture merge should exercise the custom merge driver");
      cleanup(fixture.mergeDriverSentinelPath);

      const result = validateProvenanceAuthority(run.runDir);

      assert.equal(result.ok, false);
      assert.match(joinErrors(result), /driver-free validation cannot prove conflict resolution is safe/u);
      assert.equal(existsSync(fixture.mergeDriverSentinelPath), false, "validation must not re-run repo-local merge drivers");
    } finally {
      cleanup(fixture.repoRoot);
    }
  });

  it("rejects reviewed-looking merge commits that include extra direct tree edits", () => {
    const fixture = createHistoryFixture({ extraMergeEdit: true });

    try {
      const run = buildAuthorityRun(fixture, "extra-merge-edit");
      const result = validateProvenanceAuthority(run.runDir);

      assert.equal(result.ok, false);
      assert.match(joinErrors(result), /merge-only tree edits|driver-free validation cannot prove merge-only edits are reviewed/u);
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

  it("accepts a PR-created attestation bound to remote observation, durable refs, and local head", () => {
    const fixture = createHistoryFixture();

    try {
      const run = buildAuthorityRun(fixture, "valid-pr-created");
      const pr = appendPrCreatedAttestation(run, fixture, "valid-pr-created", { includePrePrGate: true });

      const directResult = validatePrCreatedAttestation(pr.prCreated, {
        runDir: run.runDir,
        runBase: run.runBase,
        acceptedAttestations: acceptedAttestationsForRun(run.runDir),
      });
      assert.equal(directResult.ok, true);

      const authority = validateProvenanceAuthority(run.runDir);
      assert.equal(authority.ok, true);
      assert.equal(authority.acceptedAttestations[pr.prCreatedRef].attestation.type, "pr-created");
      assert.equal(authority.acceptedAttestations[pr.prCreatedRef].attestation.bindings.pr_url, "https://github.com/example/repo/pull/123");
    } finally {
      cleanup(fixture.repoRoot);
    }
  });

  it("rejects PR-created attestations with credential-bearing, non-canonical, or token-shaped GitHub PR URLs", () => {
    const scenarios = [
      {
        name: "userinfo",
        prUrl: "https://octocat:ghp_abcdefghijklmnopqrstuvwxyz123456@github.com/example/repo/pull/123",
        error: /username or password credentials|sensitive or token-shaped/u,
      },
      {
        name: "query",
        prUrl: "https://github.com/example/repo/pull/123?token=ghp_abcdefghijklmnopqrstuvwxyz123456",
        error: /query string|sensitive or token-shaped/u,
      },
      {
        name: "fragment",
        prUrl: "https://github.com/example/repo/pull/123#access_token=ghp_abcdefghijklmnopqrstuvwxyz123456",
        error: /fragment|sensitive or token-shaped/u,
      },
      {
        name: "port",
        prUrl: "https://github.com:8443/example/repo/pull/123",
        error: /port or non-canonical host/u,
      },
      {
        name: "token-shaped-owner",
        prUrl: "https://github.com/ghp_abcdefghijklmnopqrstuvwxyz123456/repo/pull/123",
        repository: "ghp_abcdefghijklmnopqrstuvwxyz123456/repo",
        error: /sensitive or token-shaped/u,
      },
      {
        name: "bad-owner-syntax",
        prUrl: "https://github.com/bad_owner/repo/pull/123",
        repository: "bad_owner/repo",
        error: /owner must match GitHub owner syntax/u,
      },
      {
        name: "bad-repo-syntax",
        prUrl: "https://github.com/example/bad~repo/pull/123",
        repository: "example/bad~repo",
        error: /repo must match GitHub repository syntax/u,
      },
    ];

    for (const scenario of scenarios) {
      const fixture = createHistoryFixture();
      try {
        const run = buildAuthorityRun(fixture, `pr-created-url-${scenario.name}`);
        appendPrCreatedAttestation(run, fixture, `pr-created-url-${scenario.name}`, {
          includePrePrGate: true,
          mutateBindings(bindings) {
            return withRemoteObservation({
              ...bindings,
              pr_url: scenario.prUrl,
              repository: scenario.repository ?? bindings.repository,
            });
          },
        });

        const result = validateProvenanceAuthority(run.runDir);
        assert.equal(result.ok, false, `expected ${scenario.name} URL to fail`);
        assert.match(joinErrors(result), scenario.error, scenario.name);
      } finally {
        cleanup(fixture.repoRoot);
      }
    }
  });

  it("rejects PR-created attestations without a normalized remote observation", () => {
    const fixture = createHistoryFixture();

    try {
      const run = buildAuthorityRun(fixture, "pr-created-missing-remote");
      appendPrCreatedAttestation(run, fixture, "pr-created-missing-remote", {
        includePrePrGate: true,
        mutateBindings(bindings) {
          const mutated = { ...bindings };
          delete mutated.remote_observation;
          return mutated;
        },
      });

      const result = validateProvenanceAuthority(run.runDir);
      assert.equal(result.ok, false);
      assert.match(joinErrors(result), /remote_observation/u);
    } finally {
      cleanup(fixture.repoRoot);
    }
  });

  it("rejects PR-created attestations missing merge-chain or pre_pr gate attestation refs", () => {
    const scenarios = [
      {
        name: "missing-merge-chain",
        mutateBindings(bindings) {
          const mutated = { ...bindings };
          delete mutated.merge_chain_attestation_ref;
          delete mutated.merge_chain_attestation_hash;
          return mutated;
        },
        error: /merge_chain_attestation_ref|merge_chain_attestation_hash/u,
      },
      {
        name: "missing-pre-pr-gate",
        mutateBindings(bindings) {
          const mutated = { ...bindings };
          delete mutated.pre_pr_gate_attestation_ref;
          delete mutated.pre_pr_gate_attestation_hash;
          return mutated;
        },
        error: /pre_pr_gate_attestation_ref|pre_pr_gate_attestation_hash/u,
      },
    ];

    for (const scenario of scenarios) {
      const fixture = createHistoryFixture();
      try {
        const run = buildAuthorityRun(fixture, `pr-created-${scenario.name}`);
        appendPrCreatedAttestation(run, fixture, `pr-created-${scenario.name}`, {
          includePrePrGate: true,
          mutateBindings: scenario.mutateBindings,
        });

        const result = validateProvenanceAuthority(run.runDir);
        assert.equal(result.ok, false, `expected ${scenario.name} to fail`);
        assert.match(joinErrors(result), scenario.error);
      } finally {
        cleanup(fixture.repoRoot);
      }
    }
  });

  it("rejects PR-created attestations bound to non-approved pre_pr gate decisions", () => {
    const fixture = createHistoryFixture();

    try {
      const run = buildAuthorityRun(fixture, "pr-created-non-approved-pre-pr");
      appendPrCreatedAttestation(run, fixture, "pr-created-non-approved-pre-pr", {
        includePrePrGate: true,
        prePrDecision: "rejected",
      });

      const result = validateProvenanceAuthority(run.runDir);
      assert.equal(result.ok, false);
      assert.match(joinErrors(result), /pre_pr gate decision is rejected, expected approved/u);
    } finally {
      cleanup(fixture.repoRoot);
    }
  });

  it("rejects PR-created attestations with mismatched URL, head/base observations, account metadata, draft flag, or PR body hash", () => {
    const scenarios = [
      {
        name: "url",
        mutateBindings(bindings) {
          return { ...bindings, pr_url: "https://github.com/example/repo/pull/456", pr_number: 456 };
        },
        error: /remote_observation\.pr_url|remote_observation\.pr_number/u,
      },
      {
        name: "provider",
        mutateBindings(bindings) {
          return withRemoteObservation({ ...bindings, provider: "gitlab" });
        },
        error: /unsupported PR provider/u,
      },
      {
        name: "repository",
        mutateBindings(bindings) {
          return withRemoteObservation({ ...bindings, repository: "evil/repo" });
        },
        error: /PR URL repository/u,
      },
      {
        name: "remote",
        mutateBindings(bindings) {
          return { ...bindings, remote: "upstream" };
        },
        error: /remote_observation\.remote/u,
      },
      {
        name: "account",
        mutateBindings(bindings) {
          return { ...bindings, github_account: "mallory" };
        },
        error: /remote_observation\.github_account/u,
      },
      {
        name: "head-branch",
        mutateBindings(bindings) {
          return { ...bindings, head_branch: "other-feature" };
        },
        error: /remote_observation\.head_branch|feature worktree branch/u,
      },
      {
        name: "head-commit",
        mutateBindings(bindings, fixture) {
          return { ...bindings, head_commit: fixture.baseCommit };
        },
        error: /remote_observation\.head_commit|feature worktree head commit/u,
      },
      {
        name: "head-tree",
        mutateBindings(bindings, fixture) {
          return { ...bindings, head_tree: fixture.baseTree };
        },
        error: /remote_observation\.head_tree|feature worktree head tree/u,
      },
      {
        name: "base-ref",
        mutateBindings(bindings) {
          return { ...bindings, base_ref: "refs/heads/release" };
        },
        error: /remote_observation\.base_ref|base ref/u,
      },
      {
        name: "base-commit",
        mutateBindings(bindings, fixture) {
          return { ...bindings, base_commit: fixture.headCommit };
        },
        error: /remote_observation\.base_commit|base commit/u,
      },
      {
        name: "base-tree",
        mutateBindings(bindings, fixture) {
          return { ...bindings, base_tree: fixture.headTree };
        },
        error: /remote_observation\.base_tree|base tree|PR base tree/u,
      },
      {
        name: "draft",
        mutateBindings(bindings) {
          return { ...bindings, draft: true };
        },
        error: /remote_observation\.draft/u,
      },
      {
        name: "body-hash",
        mutateBindings(bindings) {
          return { ...bindings, pr_body_hash: hashValue("forged-body") };
        },
        error: /PR body hash/u,
      },
    ];

    for (const scenario of scenarios) {
      const fixture = createHistoryFixture();
      try {
        const run = buildAuthorityRun(fixture, `pr-created-mismatch-${scenario.name}`);
        appendPrCreatedAttestation(run, fixture, `pr-created-mismatch-${scenario.name}`, {
          includePrePrGate: true,
          mutateBindings: scenario.mutateBindings,
        });

        const result = validateProvenanceAuthority(run.runDir);
        assert.equal(result.ok, false, `expected ${scenario.name} mismatch to fail`);
        assert.match(joinErrors(result), scenario.error);
      } finally {
        cleanup(fixture.repoRoot);
      }
    }
  });

  it("rejects PR-created attestations with escaped attestation refs or escaped/symlinked PR body refs", () => {
    const escapedAttestationFixture = createHistoryFixture();
    try {
      const run = buildAuthorityRun(escapedAttestationFixture, "pr-created-escaped-attestation");
      appendPrCreatedAttestation(run, escapedAttestationFixture, "pr-created-escaped-attestation", {
        includePrePrGate: true,
        mutateBindings(bindings) {
          return { ...bindings, run_base_attestation_ref: "attestations/../run-base.json" };
        },
      });

      const result = validateProvenanceAuthority(run.runDir);
      assert.equal(result.ok, false);
      assert.match(joinErrors(result), /must not contain empty, '\.' or '\.\.' segments/u);
    } finally {
      cleanup(escapedAttestationFixture.repoRoot);
    }

    const escapedFixture = createHistoryFixture();
    try {
      const run = buildAuthorityRun(escapedFixture, "pr-created-escaped-body");
      appendPrCreatedAttestation(run, escapedFixture, "pr-created-escaped-body", {
        includePrePrGate: true,
        mutateBindings(bindings) {
          return { ...bindings, pr_body_ref: "artifacts/../pr-body.md" };
        },
      });

      const result = validateProvenanceAuthority(run.runDir);
      assert.equal(result.ok, false);
      assert.match(joinErrors(result), /must not contain empty, '\.' or '\.\.' segments/u);
    } finally {
      cleanup(escapedFixture.repoRoot);
    }

    const symlinkFixture = createHistoryFixture();
    try {
      const run = buildAuthorityRun(symlinkFixture, "pr-created-symlink-body");
      const outsideBody = join(symlinkFixture.repoRoot, "outside-pr-body.md");
      writeFileSync(outsideBody, "external body\n", "utf8");
      appendPrCreatedAttestation(run, symlinkFixture, "pr-created-symlink-body", {
        includePrePrGate: true,
        afterBodyWritten({ bodyPath }) {
          cleanup(bodyPath);
          symlinkSync(outsideBody, bodyPath);
        },
        mutateBindings(bindings) {
          return { ...bindings, pr_body_hash: hashFile(outsideBody) };
        },
      });

      const result = validateProvenanceAuthority(run.runDir);
      assert.equal(result.ok, false);
      assert.match(joinErrors(result), /must not traverse symlinks/u);
    } finally {
      cleanup(symlinkFixture.repoRoot);
    }
  });
});

function buildAuthorityRun(fixture, runId, options = {}) {
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

  const indexRecords = [{ ref: "attestations/run-base.json", attestation: runBase }];
  const writtenAttestations = [{ ref: "attestations/run-base.json", attestation: runBase }];
  const slices = [];
  const directs = [];
  const mergeEntries = [];
  const includeDirectProofs = options.includeDirectProofs === true;
  const launderDirectProofs = options.launderDirectProofs === true;
  const unindexedAttestationRefs = new Set(options.unindexedAttestationRefs || []);
  let sequence = 2;
  let prevHash = runBase.attestation_hash;

  for (const event of fixture.events) {
    if (event.kind === "slice_merge") {
      const evidenceRef = `evidence/${event.sliceBranch}.json`;
      const evidencePath = join(runDir, ...evidenceRef.split("/"));
      writeJson(evidencePath, {
        slice_id: event.sliceBranch,
        observed_commit: event.sliceCommit,
        base_commit: event.sliceBaseCommit,
      });

      const reviewRef = `reviews/${event.sliceBranch}.json`;
      const reviewPath = join(runDir, ...reviewRef.split("/"));
      writeJson(reviewPath, {
        subject: event.sliceBranch,
        reviewer: "work-reviewer",
        verdict: "APPROVE",
      });

      const evidenceHash = hashFile(evidencePath);
      const reviewHash = hashFile(reviewPath);
      const guard = {
        status: "clean",
        safe_git_policy: SAFE_GIT_POLICY,
        worktree: event.sliceWorktree,
        head_commit: event.sliceCommit,
        head_tree: event.sliceTree,
        dirty_paths: [],
        hidden_index_paths: [],
      };

      const sliceAttestationRef = `attestations/slices/${event.sliceBranch}.observation.json`;
      const sliceAttestation = createSliceObservationAttestation({
        run_id: runId,
        sequence,
        prev_hash: prevHash,
        created_at: isoAt(sequence),
        bindings: {
          slice_id: event.sliceBranch,
          attempt: 1,
          branch: event.sliceBranch,
          worktree: event.sliceWorktree,
          base_commit: event.sliceBaseCommit,
          slice_commit: event.sliceCommit,
          slice_tree: event.sliceTree,
          evidence_ref: evidenceRef,
          evidence_hash: evidenceHash,
        },
      });
      writtenAttestations.push({ ref: sliceAttestationRef, attestation: sliceAttestation });
      indexRecords.push({ ref: sliceAttestationRef, attestation: sliceAttestation });
      sequence += 1;
      prevHash = sliceAttestation.attestation_hash;

      const reviewAttestationRef = `attestations/reviews/${event.sliceBranch}.approval.json`;
      const reviewAttestation = createReviewApprovalAttestation({
        run_id: runId,
        sequence,
        prev_hash: prevHash,
        created_at: isoAt(sequence),
        bindings: {
          subject_type: "slice",
          subject: event.sliceBranch,
          reviewer: "work-reviewer",
          verdict: "APPROVE",
          review_ref: reviewRef,
          review_hash: reviewHash,
          evidence_ref: evidenceRef,
          evidence_hash: evidenceHash,
          subject_commit: event.sliceCommit,
          subject_tree: event.sliceTree,
          guard_result_hash: hashValue(guard),
          guard,
        },
      });
      writtenAttestations.push({ ref: reviewAttestationRef, attestation: reviewAttestation });
      if (!unindexedAttestationRefs.has(reviewAttestationRef)) {
        indexRecords.push({ ref: reviewAttestationRef, attestation: reviewAttestation });
        sequence += 1;
        prevHash = reviewAttestation.attestation_hash;
      }

      mergeEntries.push({
        type: "slice_merge",
        commit: event.mergeCommit,
        slice_commit: event.sliceCommit,
        slice_attestation_ref: sliceAttestationRef,
        slice_attestation_hash: sliceAttestation.attestation_hash,
        review_attestation_ref: reviewAttestationRef,
        review_attestation_hash: reviewAttestation.attestation_hash,
      });
      slices.push({
        sliceBranch: event.sliceBranch,
        sliceWorktree: event.sliceWorktree,
        sliceCommit: event.sliceCommit,
        sliceTree: event.sliceTree,
        evidenceRef,
        evidenceHash,
        reviewRef,
        reviewHash,
        guard,
        sliceAttestationRef,
        sliceAttestation,
        reviewAttestationRef,
        reviewAttestation,
        mergeCommit: event.mergeCommit,
      });
      continue;
    }

    if (event.kind === "direct_commit") {
      if (!includeDirectProofs) continue;

      const evidenceRef = `evidence/${event.entryId}.json`;
      const evidencePath = join(runDir, ...evidenceRef.split("/"));
      writeJson(evidencePath, {
        entry_id: event.entryId,
        commit: event.commit,
        parent_commit: event.parentCommit,
      });

      const reviewRef = `reviews/${event.entryId}.json`;
      const reviewPath = join(runDir, ...reviewRef.split("/"));
      writeJson(reviewPath, {
        subject: event.entryId,
        reviewer: "work-reviewer",
        verdict: "APPROVE",
      });

      const evidenceHash = hashFile(evidencePath);
      const reviewHash = hashFile(reviewPath);
      const guard = {
        status: "clean",
        safe_git_policy: SAFE_GIT_POLICY,
        worktree: fixture.featureWorktree,
        head_commit: event.commit,
        head_tree: event.tree,
        dirty_paths: [],
        hidden_index_paths: [],
      };

      const directAttestationRef = `attestations/direct-commits/${event.entryId}.observation.json`;
      const directBindings = {
        entry_id: event.entryId,
        purpose: event.purpose,
        commit: event.commit,
        parent_commit: event.parentCommit,
        tree: event.tree,
        diff_hash: hashDiff(fixture.featureWorktree, event.parentCommit, event.commit),
        evidence_ref: evidenceRef,
        evidence_hash: evidenceHash,
        producing_role: "feature-factory",
      };
      if (!launderDirectProofs) {
        directBindings.review_hash = reviewHash;
        directBindings.guard_result_hash = hashValue(guard);
      }
      const directAttestation = createDirectReviewedCommitAttestation({
        run_id: runId,
        sequence,
        prev_hash: prevHash,
        created_at: isoAt(sequence),
        bindings: directBindings,
      });
      writtenAttestations.push({ ref: directAttestationRef, attestation: directAttestation });
      indexRecords.push({ ref: directAttestationRef, attestation: directAttestation });
      sequence += 1;
      prevHash = directAttestation.attestation_hash;

      const reviewAttestationRef = `attestations/reviews/${event.entryId}.approval.json`;
      const reviewAttestation = createReviewApprovalAttestation({
        run_id: runId,
        sequence,
        prev_hash: prevHash,
        created_at: isoAt(sequence),
        bindings: {
          subject_type: "direct_commit",
          subject: event.entryId,
          reviewer: "work-reviewer",
          verdict: "APPROVE",
          review_ref: reviewRef,
          review_hash: reviewHash,
          evidence_ref: evidenceRef,
          evidence_hash: evidenceHash,
          subject_commit: event.commit,
          subject_tree: event.tree,
          guard_result_hash: hashValue(guard),
          guard,
        },
      });
      writtenAttestations.push({ ref: reviewAttestationRef, attestation: reviewAttestation });
      indexRecords.push({ ref: reviewAttestationRef, attestation: reviewAttestation });
      sequence += 1;
      prevHash = reviewAttestation.attestation_hash;

      mergeEntries.push({
        type: "direct_reviewed_commit",
        commit: event.commit,
        direct_commit_attestation_ref: directAttestationRef,
        direct_commit_attestation_hash: directAttestation.attestation_hash,
        review_attestation_ref: reviewAttestationRef,
        review_attestation_hash: reviewAttestation.attestation_hash,
      });
      directs.push({
        entryId: event.entryId,
        commit: event.commit,
        parentCommit: event.parentCommit,
        tree: event.tree,
        evidenceRef,
        reviewRef,
        guard,
        directAttestationRef,
        directAttestation,
        reviewAttestationRef,
        reviewAttestation,
      });
    }
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
      entries: mergeEntries,
    },
  });
  writtenAttestations.push({ ref: "attestations/merge-chain.json", attestation: mergeChain });
  indexRecords.push({ ref: "attestations/merge-chain.json", attestation: mergeChain });

  for (const record of writtenAttestations) writeAttestation(runDir, record.ref, record.attestation);
  writeJson(join(runDir, "attestations", "index.json"), createAttestationIndex(indexRecords));

  return {
    runDir,
    runBase,
    mergeChain,
    slices,
    directs,
  };
}

function appendPrCreatedAttestation(run, fixture, runId, options = {}) {
  const prBodyRef = "artifacts/pr-body.md";
  const prBodyPath = join(run.runDir, ...prBodyRef.split("/"));
  writeFixture(run.runDir, prBodyRef, "PR body\n\n- provenance checked\n");
  if (typeof options.afterBodyWritten === "function") options.afterBodyWritten({ bodyPath: prBodyPath });

  let sequence = run.mergeChain.sequence + 1;
  let prevHash = run.mergeChain.attestation_hash;
  const newRecords = [];
  let prePrGate = null;
  let prePrGateRef = null;

  if (options.includePrePrGate) {
    writeFixture(run.runDir, "artifacts/pre_pr.md", "pre-pr artifact\n");
    writeFixture(run.runDir, "gates/pre_pr.question.md", "approve pre-pr?\n");
    writeFixture(run.runDir, "gates/pre_pr.answer", "approve\n");
    prePrGateRef = "attestations/gates/pre_pr.json";
    prePrGate = createGateDecisionAttestation({
      run_id: runId,
      sequence,
      prev_hash: prevHash,
      created_at: isoAt(sequence),
      bindings: {
        gate: "pre_pr",
        decision: options.prePrDecision ?? "approved",
        approval_source: "autonomous",
        question_ref: "gates/pre_pr.question.md",
        question_hash: hashFile(join(run.runDir, "gates", "pre_pr.question.md")),
        artifact_ref: "artifacts/pre_pr.md",
        artifact_hash: hashFile(join(run.runDir, "artifacts", "pre_pr.md")),
        answer_ref: "gates/pre_pr.answer",
        answer_hash: hashFile(join(run.runDir, "gates", "pre_pr.answer")),
      },
    });
    newRecords.push({ ref: prePrGateRef, attestation: prePrGate });
    sequence += 1;
    prevHash = prePrGate.attestation_hash;
  }

  const baseBindings = createPrCreatedBindings(run, fixture, {
    prBodyRef,
    prBodyHash: hashFile(prBodyPath),
    prePrGateRef,
    prePrGateHash: prePrGate?.attestation_hash,
  });
  const bindings = typeof options.mutateBindings === "function"
    ? options.mutateBindings(baseBindings, fixture, run)
    : baseBindings;
  const prCreated = createPrCreatedAttestation({
    run_id: runId,
    sequence,
    prev_hash: prevHash,
    created_at: isoAt(sequence),
    bindings,
  });
  const prCreatedRef = "attestations/pr-created.json";
  newRecords.push({ ref: prCreatedRef, attestation: prCreated });

  for (const record of newRecords) writeAttestation(run.runDir, record.ref, record.attestation);
  appendAttestationsToIndex(run.runDir, newRecords);

  return { prCreated, prCreatedRef, prePrGate, prePrGateRef };
}

function createPrCreatedBindings(run, fixture, { prBodyRef, prBodyHash, prePrGateRef, prePrGateHash }) {
  const remoteObservation = {
    provider: "github",
    repository: "example/repo",
    remote: "origin",
    github_account: "octocat",
    pr_url: "https://github.com/example/repo/pull/123",
    pr_number: 123,
    head_branch: fixture.featureBranch,
    head_commit: fixture.headCommit,
    head_tree: fixture.headTree,
    base_ref: "refs/heads/main",
    base_commit: fixture.baseCommit,
    base_tree: fixture.baseTree,
    draft: false,
  };
  return {
    provider: remoteObservation.provider,
    repository: remoteObservation.repository,
    remote: remoteObservation.remote,
    github_account: remoteObservation.github_account,
    pr_url: remoteObservation.pr_url,
    pr_number: remoteObservation.pr_number,
    head_branch: remoteObservation.head_branch,
    head_commit: remoteObservation.head_commit,
    head_tree: remoteObservation.head_tree,
    base_ref: remoteObservation.base_ref,
    base_commit: remoteObservation.base_commit,
    base_tree: remoteObservation.base_tree,
    draft: remoteObservation.draft,
    pr_body_ref: prBodyRef,
    pr_body_hash: prBodyHash,
    run_base_attestation_ref: "attestations/run-base.json",
    run_base_attestation_hash: run.runBase.attestation_hash,
    merge_chain_attestation_ref: "attestations/merge-chain.json",
    merge_chain_attestation_hash: run.mergeChain.attestation_hash,
    ...(prePrGateRef
      ? {
          pre_pr_gate_attestation_ref: prePrGateRef,
          pre_pr_gate_attestation_hash: prePrGateHash,
        }
      : {}),
    remote_observation: remoteObservation,
  };
}

function withRemoteObservation(bindings) {
  return {
    ...bindings,
    remote_observation: {
      ...bindings.remote_observation,
      provider: bindings.provider,
      repository: bindings.repository,
      remote: bindings.remote,
      github_account: bindings.github_account,
      pr_url: bindings.pr_url,
      pr_number: bindings.pr_number,
      head_branch: bindings.head_branch,
      head_commit: bindings.head_commit,
      head_tree: bindings.head_tree,
      base_ref: bindings.base_ref,
      base_commit: bindings.base_commit,
      base_tree: bindings.base_tree,
      draft: bindings.draft,
    },
  };
}

function appendAttestationsToIndex(runDir, newRecords) {
  const indexPath = join(runDir, "attestations", "index.json");
  const index = readJson(indexPath);
  const existingRecords = index.entries.map((entry) => ({
    ref: entry.ref,
    attestation: readJson(join(runDir, ...entry.ref.split("/"))),
  }));
  writeJson(indexPath, createAttestationIndex([...existingRecords, ...newRecords]));
}

function acceptedAttestationsForRun(runDir) {
  const graph = validateAttestationGraph(runDir);
  assert.equal(graph.ok, true);
  return graph.acceptedAttestations;
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

  const events = [];
  const merges = [];
  const directs = [];

  if (options.directBefore) {
    const directBefore = createDirectFeatureCommit(featureWorktree, "direct-before", "feature-before.txt", "before\n", "feature before merge");
    directs.push(directBefore);
    events.push(directBefore);
  }

  const sliceOne = createSliceWorktree(repoRoot, featureWorktree, "slice-1", "slice-one.txt", "slice one\n", "slice one");
  mergeSlice(featureWorktree, sliceOne.sliceBranch, { extraMergeEdit: Boolean(options.extraMergeEdit) });
  const mergeOne = {
    kind: "slice_merge",
    ...sliceOne,
    mergeCommit: head(featureWorktree),
    mergeTree: tree(featureWorktree, "HEAD"),
  };
  merges.push(mergeOne);
  events.push(mergeOne);

  if (options.directBetween) {
    const directBetween = createDirectFeatureCommit(featureWorktree, "direct-between", "feature-between.txt", "between\n", "feature between merges");
    directs.push(directBetween);
    events.push(directBetween);
  }

  if (options.secondSlice) {
    const sliceTwo = createSliceWorktree(repoRoot, featureWorktree, "slice-2", "slice-two.txt", "slice two\n", "slice two");
    mergeSlice(featureWorktree, sliceTwo.sliceBranch);
    const mergeTwo = {
      kind: "slice_merge",
      ...sliceTwo,
      mergeCommit: head(featureWorktree),
      mergeTree: tree(featureWorktree, "HEAD"),
    };
    merges.push(mergeTwo);
    events.push(mergeTwo);
  }

  if (options.directAfter) {
    const directAfter = createDirectFeatureCommit(featureWorktree, "direct-after", "feature-after.txt", "after\n", "feature after merge");
    directs.push(directAfter);
    events.push(directAfter);
  }

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
    directs,
    events,
  };
}

function createConflictingSliceMergeFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), "prov-auth-merge-driver-"));
  mkdirSync(join(repoRoot, ".opencode", "worktrees"), { recursive: true });
  mkdirSync(join(repoRoot, ".opencode", "factory"), { recursive: true });

  git(repoRoot, ["init", "-b", "main"]);
  git(repoRoot, ["config", "user.name", "Provenance Authority Test"]);
  git(repoRoot, ["config", "user.email", "provenance-authority@example.com"]);

  const mergeDriverScriptPath = join(repoRoot, "trap-merge-driver.sh");
  const mergeDriverSentinelPath = join(repoRoot, "trap-merge-driver-sentinel.txt");
  writeFileSync(mergeDriverScriptPath, [
    "#!/bin/sh",
    "set -eu",
    'printf "merge-driver-invoked\\n" >> "$1"',
    'cat "$4" > "$3"',
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o755 });

  writeFixture(repoRoot, ".gitattributes", "tracked.txt merge=trap\n");
  writeFixture(repoRoot, "tracked.txt", "base\n");
  git(repoRoot, ["add", ".gitattributes", "tracked.txt"]);
  git(repoRoot, ["commit", "-m", "base"]);

  const featureBranch = "feature-branch";
  const featureWorktree = join(repoRoot, ".opencode", "worktrees", featureBranch);
  git(repoRoot, ["worktree", "add", "-b", featureBranch, featureWorktree, "HEAD"]);
  git(repoRoot, ["config", "merge.trap.name", "trap merge driver"]);
  git(repoRoot, ["config", "merge.trap.driver", `${mergeDriverScriptPath} ${mergeDriverSentinelPath} %O %A %B %P`]);

  const sliceOne = createSliceWorktree(repoRoot, featureWorktree, "slice-1", "tracked.txt", "slice one\n", "slice one");
  const sliceTwo = createSliceWorktree(repoRoot, featureWorktree, "slice-2", "tracked.txt", "slice two\n", "slice two");

  mergeSlice(featureWorktree, sliceOne.sliceBranch);
  const mergeOne = {
    kind: "slice_merge",
    ...sliceOne,
    mergeCommit: head(featureWorktree),
    mergeTree: tree(featureWorktree, "HEAD"),
  };

  mergeSlice(featureWorktree, sliceTwo.sliceBranch);
  const mergeTwo = {
    kind: "slice_merge",
    ...sliceTwo,
    mergeCommit: head(featureWorktree),
    mergeTree: tree(featureWorktree, "HEAD"),
  };

  return {
    repoRoot: realpathSync.native(repoRoot),
    featureBranch,
    featureWorktree: realpathSync.native(featureWorktree),
    gitCommonDir: realpathSync.native(resolve(featureWorktree, gitStdout(featureWorktree, ["rev-parse", "--git-common-dir"]).trim())),
    baseCommit: head(repoRoot),
    baseTree: tree(repoRoot, head(repoRoot)),
    headCommit: head(featureWorktree),
    headTree: tree(featureWorktree, "HEAD"),
    merges: [mergeOne, mergeTwo],
    directs: [],
    events: [mergeOne, mergeTwo],
    mergeDriverScriptPath,
    mergeDriverSentinelPath,
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

function createDirectFeatureCommit(featureWorktree, entryId, relativePath, content, commitMessage) {
  const parentCommit = head(featureWorktree);
  commitFile(featureWorktree, relativePath, content, commitMessage);

  return {
    kind: "direct_commit",
    entryId,
    purpose: "remediation",
    parentCommit,
    commit: head(featureWorktree),
    tree: tree(featureWorktree, "HEAD"),
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
  for (const directory of [runDir, join(runDir, "evidence"), join(runDir, "artifacts"), join(runDir, "reviews"), join(runDir, "attestations"), join(runDir, "gates")]) {
    mkdirSync(directory, { recursive: true });
  }
  return runDir;
}

function writeAttestation(runDir, ref, value) {
  writeJson(join(runDir, ...ref.split("/")), value);
}

function rewriteMergeChainBaseAttestationRef(runDir, baseAttestationRef) {
  const mergeChainPath = join(runDir, "attestations", "merge-chain.json");
  const indexPath = join(runDir, "attestations", "index.json");
  const mergeChain = JSON.parse(readFileSync(mergeChainPath, "utf8"));
  const rewrittenMergeChain = withAttestationHash({
    ...mergeChain,
    bindings: {
      ...mergeChain.bindings,
      base_attestation_ref: baseAttestationRef,
    },
  });
  writeJson(mergeChainPath, rewrittenMergeChain);

  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const mergeChainEntry = index.entries.find((entry) => entry.ref === "attestations/merge-chain.json");
  assert.ok(mergeChainEntry, "merge-chain index entry must exist");
  mergeChainEntry.attestation_hash = rewrittenMergeChain.attestation_hash;
  writeJson(indexPath, index);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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

function hashDiff(cwd, parentCommit, commit) {
  return `sha256:${createHash("sha256").update(gitStdout(cwd, ["diff-tree", "-r", "--full-index", parentCommit, commit]), "utf8").digest("hex")}`;
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
