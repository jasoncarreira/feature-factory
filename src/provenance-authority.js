import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { SAFE_GIT_POLICY, safeGit } from "./safe-git.js";

export const AUTHORITY_MODEL = "feature-factory-provenance-v1";
export const AUTHORITY_NAME = "feature-factory";
export const AUTHORITY_SCHEMA_VERSION = 1;
export const DURABLE_ROOT_NAMES = Object.freeze(["evidence", "artifacts", "reviews", "attestations"]);
export const DIRECT_REVIEWED_COMMIT_PURPOSES = Object.freeze(["test", "remediation", "validation-fix"]);
export const ATTESTATION_TYPES = Object.freeze([
  "run-base",
  "slice-observation",
  "review-approval",
  "direct-reviewed-commit",
  "gate-decision",
  "merge-chain",
]);

const DIRECT_REVIEWED_COMMIT_PURPOSE_SET = new Set(DIRECT_REVIEWED_COMMIT_PURPOSES);
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const JSON_LEAF_ROOTS = new Set(["evidence", "reviews"]);
const GIT_REV_PARSE_HEAD_ARGS = Object.freeze(["rev-parse", "HEAD", "HEAD^{tree}"]);

export function canonicalJson(value) {
  return JSON.stringify(canonicalizeJsonValue(value));
}

export function hashValue(value) {
  return hashText(canonicalJson(value));
}

export function hashFile(filePath, options = {}) {
  const file = requireText(filePath, "filePath");
  const mode = normalizeHashMode(options.mode, file);
  const content = readFileSync(file);
  if (mode === "raw") return hashBuffer(content);
  return hashValue(JSON.parse(content.toString("utf8")));
}

export function withAttestationHash(attestation) {
  const normalized = cloneJsonValue(requireRecord(attestation, "attestation"));
  normalized.attestation_hash = hashValue(withoutAttestationHash(normalized));
  return normalized;
}

export function verifyAttestationHash(attestation) {
  const normalized = requireRecord(attestation, "attestation");
  const actual = typeof normalized.attestation_hash === "string" ? normalized.attestation_hash : null;
  const expected = hashValue(withoutAttestationHash(normalized));
  return {
    ok: actual === expected,
    actual,
    expected,
  };
}

export function createAttestationIndex(entries) {
  if (!Array.isArray(entries)) throw new Error("entries must be an array");

  const normalizedEntries = entries
    .map((entry, index) => normalizeAttestationIndexSource(entry, index))
    .sort((left, right) => left.attestation.sequence - right.attestation.sequence);

  return {
    schema_version: AUTHORITY_SCHEMA_VERSION,
    authority_model: AUTHORITY_MODEL,
    authority: AUTHORITY_NAME,
    entries: normalizedEntries.map(({ ref, attestation }) => ({
      ref,
      type: attestation.type,
      sequence: attestation.sequence,
      prev_hash: attestation.prev_hash ?? null,
      attestation_hash: attestation.attestation_hash,
    })),
  };
}

export function createRunBaseAttestation(input = {}) {
  return createAuthorityAttestation("run-base", {
    ...input,
    subject: input.subject ?? "run-base",
  });
}

export function createSliceObservationAttestation(input = {}) {
  return createAuthorityAttestation("slice-observation", {
    ...input,
    subject: input.subject ?? input.bindings?.slice_id ?? "slice-observation",
  });
}

export function createReviewApprovalAttestation(input = {}) {
  return createAuthorityAttestation("review-approval", {
    ...input,
    subject: input.subject ?? input.bindings?.subject ?? "review-approval",
  });
}

export function createDirectReviewedCommitAttestation(input = {}) {
  return createAuthorityAttestation("direct-reviewed-commit", {
    ...input,
    subject: input.subject ?? input.bindings?.entry_id ?? "direct-reviewed-commit",
  });
}

export function createGateDecisionAttestation(input = {}) {
  return createAuthorityAttestation("gate-decision", {
    ...input,
    subject: input.subject ?? input.bindings?.gate ?? "gate-decision",
  });
}

export function createMergeChainAttestation(input = {}) {
  return createAuthorityAttestation("merge-chain", {
    ...input,
    subject: input.subject ?? input.bindings?.feature_branch ?? "merge-chain",
  });
}

export function resolveDurableRoots(runDir, options = {}) {
  const runPath = resolve(requireText(runDir, "runDir"));
  const runRealPath = readRealPath(runPath, "runDir", options);
  const roots = { run_dir: runRealPath };

  for (const rootName of DURABLE_ROOT_NAMES) {
    const declaredPath = join(runPath, rootName);
    const realRoot = resolveDurableRoot(declaredPath, rootName, runRealPath, options);
    roots[rootName] = realRoot;
  }

  return roots;
}

export function resolveDurableRef(runDirOrRoots, ref, options = {}) {
  const roots = normalizeRoots(runDirOrRoots, options);
  const normalizedRef = requireText(ref, "ref");
  const kind = options.kind ?? detectDurableRefKind(normalizedRef);
  const { segments, rootName } = validateDurableRef(normalizedRef, kind);
  const rootPath = roots[rootName];
  const mustExist = options.mustExist !== false;
  const targetPath = walkDurableRef(rootPath, segments.slice(1), normalizedRef, { mustExist, options });
  return {
    ref: normalizedRef,
    root: rootName,
    path: targetPath.path,
    realpath: targetPath.realpath,
  };
}

export function resolveEvidenceRef(runDirOrRoots, ref, options = {}) {
  return resolveDurableRef(runDirOrRoots, ref, { ...options, kind: "evidence" });
}

export function resolveReviewRef(runDirOrRoots, ref, options = {}) {
  return resolveDurableRef(runDirOrRoots, ref, { ...options, kind: "reviews" });
}

export function resolveArtifactRef(runDirOrRoots, ref, options = {}) {
  return resolveDurableRef(runDirOrRoots, ref, { ...options, kind: "artifacts" });
}

export function resolveAttestationRef(runDirOrRoots, ref, options = {}) {
  return resolveDurableRef(runDirOrRoots, ref, { ...options, kind: "attestations" });
}

export function deriveExpectedWorktreePath(repoRoot, branch) {
  const repoRealPath = resolvePhysicalPath(repoRoot);
  return join(repoRealPath, ".opencode", "worktrees", ...normalizePathLikeSegments(branch, "branch"));
}

export function parseWorktreeListPorcelain(stdout) {
  const entries = [];
  let current = null;

  for (const rawLine of normalizeGitStdout(stdout).split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (line === "") {
      if (current) entries.push(finalizeWorktreeEntry(current));
      current = null;
      continue;
    }

    const separatorIndex = line.indexOf(" ");
    const key = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);

    if (key === "worktree") {
      if (current) entries.push(finalizeWorktreeEntry(current));
      current = { worktree: value };
      continue;
    }

    if (!current) current = {};
    current[key] = value === "" ? true : value;
  }

  if (current) entries.push(finalizeWorktreeEntry(current));
  return entries;
}

export function checkWorktreeIdentity(repoRoot, branch, worktree, options = {}) {
  const checks = [];
  const repoRealPath = readRealPath(resolve(requireText(repoRoot, "repoRoot")), "repoRoot", options);
  const worktreeRoot = join(repoRealPath, ".opencode", "worktrees");
  const expectedWorktreePath = deriveExpectedWorktreePath(repoRealPath, branch);
  const declaredWorktreePath = resolve(requireText(worktree, "worktree"));
  let actualWorktreeRealPath = null;

  const actualWorktreeCheck = runCheck("worktree.actual", () => {
    actualWorktreeRealPath = readRealPath(declaredWorktreePath, "worktree", options);
    if (!isContainedPath(worktreeRoot, actualWorktreeRealPath)) {
      throw new Error(`worktree must be physically contained under ${worktreeRoot}`);
    }
    return { path: actualWorktreeRealPath };
  });
  checks.push(actualWorktreeCheck);

  const expectedWorktreeCheck = runCheck("worktree.expected", () => {
    const expectedRealPath = readRealPath(expectedWorktreePath, "expectedWorktree", options);
    if (!actualWorktreeRealPath) throw new Error("actual worktree could not be resolved");
    if (expectedRealPath !== actualWorktreeRealPath) {
      throw new Error(`worktree does not match expected branch path ${expectedWorktreePath}`);
    }
    return { expected_worktree: expectedWorktreePath };
  });
  checks.push(expectedWorktreeCheck);

  const commonDirCheck = runCheck("worktree.repo-common-dir", () => {
    if (!actualWorktreeRealPath) throw new Error("actual worktree could not be resolved");
    const result = requireGitSuccess(actualWorktreeRealPath, ["rev-parse", "--git-common-dir"], options, "git rev-parse --git-common-dir");
    const commonDir = readRealPath(resolveGitPath(actualWorktreeRealPath, result.stdout.trim()), "worktree git common dir", options);
    const expectedCommonDir = readRealPath(join(repoRealPath, ".git"), "repo git common dir", options);
    if (commonDir !== expectedCommonDir) {
      throw new Error(`worktree git common dir is ${commonDir}, expected ${expectedCommonDir}`);
    }
    return { git_common_dir: commonDir };
  });
  checks.push(commonDirCheck);

  const branchCheck = runCheck("worktree.branch", () => {
    if (!actualWorktreeRealPath) throw new Error("actual worktree could not be resolved");
    const result = requireGitSuccess(actualWorktreeRealPath, ["symbolic-ref", "--short", "HEAD"], options, "git symbolic-ref --short HEAD");
    const currentBranch = result.stdout.trim();
    if (currentBranch !== branch) throw new Error(`worktree branch is ${currentBranch}, expected ${branch}`);
    return { branch: currentBranch };
  });
  checks.push(branchCheck);

  const worktreeListCheck = runCheck("worktree.same-branch-conflicts", () => {
    if (!actualWorktreeRealPath) throw new Error("actual worktree could not be resolved");
    const result = requireGitSuccess(repoRealPath, ["worktree", "list", "--porcelain"], options, "git worktree list --porcelain");
    const entries = parseWorktreeListPorcelain(result.stdout);
    const sameBranchEntries = entries.filter((entry) => entry.branch_short === branch);
    if (sameBranchEntries.length === 0) throw new Error(`no git worktree entry exists for branch ${branch}`);

    for (const entry of sameBranchEntries) {
      const recordedPath = resolve(requireText(entry.worktree, "git worktree entry"));
      const recordedRealPath = readRealPath(recordedPath, `git worktree entry for ${branch}`, options);
      if (!isContainedPath(worktreeRoot, recordedRealPath)) {
        throw new Error(`same-branch git worktree entry escapes ${worktreeRoot}: ${recordedPath}`);
      }
      if (recordedRealPath !== actualWorktreeRealPath) {
        throw new Error(`same-branch git worktree entry conflicts with attested worktree: ${recordedPath}`);
      }
    }

    return {
      branch,
      entries: sameBranchEntries.map((entry) => entry.worktree),
    };
  });
  checks.push(worktreeListCheck);

  return finalizeChecks(checks, {
    expected_worktree: expectedWorktreePath,
    worktree: declaredWorktreePath,
  });
}

export function readHeadObservation(worktree, options = {}) {
  const result = requireGitSuccess(worktree, GIT_REV_PARSE_HEAD_ARGS, options, "git rev-parse HEAD HEAD^{tree}");
  const lines = normalizeGitStdout(result.stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) throw new Error(`git rev-parse HEAD HEAD^{tree} returned malformed output for ${worktree}`);
  return {
    head_commit: lines[0],
    head_tree: lines[1],
  };
}

export function readCommitObservation(cwd, commit, options = {}) {
  const subject = requireText(commit, "commit");
  const result = requireGitSuccess(cwd, ["cat-file", "-p", subject], options, `git cat-file -p ${subject}`);
  const parents = [];
  let tree = null;

  for (const line of normalizeGitStdout(result.stdout).split(/\r?\n/u)) {
    if (line === "") break;
    if (line.startsWith("tree ")) tree = line.slice(5).trim();
    if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
  }

  if (!tree) throw new Error(`git cat-file -p ${subject} did not expose a commit tree`);
  return {
    commit: subject,
    tree,
    parents,
  };
}

export function gitDiffHash(cwd, parentCommit, commit, options = {}) {
  const parent = requireText(parentCommit, "parentCommit");
  const child = requireText(commit, "commit");
  const result = requireGitSuccess(
    cwd,
    ["diff-tree", "-r", "--full-index", parent, child],
    options,
    `git diff-tree -r --full-index ${parent} ${child}`,
  );
  return hashText(result.stdout);
}

export function computeMergeTree(cwd, previousCommit, sliceCommit, options = {}) {
  const base = requireText(previousCommit, "previousCommit");
  const slice = requireText(sliceCommit, "sliceCommit");
  const result = requireGitSuccess(
    cwd,
    ["merge-tree", "--write-tree", base, slice],
    options,
    `git merge-tree --write-tree ${base} ${slice}`,
  );
  const tree = normalizeGitStdout(result.stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!tree) throw new Error(`git merge-tree --write-tree ${base} ${slice} returned no tree id`);
  return { tree };
}

export function validateAttestationGraph(runDirOrRoots, options = {}) {
  const checks = [];
  let roots;
  let index = null;
  const acceptedAttestations = {};
  const orderedRefs = [];

  const rootsCheck = runCheck("attestation-graph.roots", () => {
    roots = normalizeRoots(runDirOrRoots, options);
    return { run_dir: roots.run_dir };
  });
  checks.push(rootsCheck);
  if (!rootsCheck.ok) return finalizeChecks(checks, { acceptedAttestations, orderedRefs, index });

  const indexCheck = runCheck("attestation-graph.index", () => {
    const indexPath = resolveAttestationRef(roots, "attestations/index.json", options).path;
    index = readJsonFile(indexPath, "attestations/index.json");
    const errors = [];
    if (!Number.isInteger(index.schema_version) || index.schema_version !== AUTHORITY_SCHEMA_VERSION) {
      errors.push({ path: "attestations/index.json.schema_version", message: `must equal ${AUTHORITY_SCHEMA_VERSION}` });
    }
    if (index.authority_model !== AUTHORITY_MODEL) {
      errors.push({ path: "attestations/index.json.authority_model", message: `must equal ${AUTHORITY_MODEL}` });
    }
    if (index.authority !== AUTHORITY_NAME) {
      errors.push({ path: "attestations/index.json.authority", message: `must equal ${AUTHORITY_NAME}` });
    }
    if (!Array.isArray(index.entries) || index.entries.length === 0) {
      errors.push({ path: "attestations/index.json.entries", message: "must be a non-empty array" });
    }
    if (errors.length > 0) throw new ValidationFailure(errors);
    return { entries: index.entries.length };
  });
  checks.push(indexCheck);
  if (!indexCheck.ok) return finalizeChecks(checks, { acceptedAttestations, orderedRefs, index });

  let previousHash = null;
  let previousSequence = 0;

  for (const [indexPosition, entry] of index.entries.entries()) {
    const entryPath = `attestations/index.json.entries[${indexPosition}]`;
    const entryCheck = runCheck(`attestation-graph.entry.${indexPosition + 1}`, () => {
      const errors = [];
      if (!isRecord(entry)) {
        throw new ValidationFailure([{ path: entryPath, message: "must be an object" }]);
      }

      if (!stringValue(entry.ref)) errors.push({ path: `${entryPath}.ref`, message: "must be a non-empty string" });
      if (!stringValue(entry.type)) errors.push({ path: `${entryPath}.type`, message: "must be a non-empty string" });
      if (!Number.isInteger(entry.sequence) || entry.sequence < 1) {
        errors.push({ path: `${entryPath}.sequence`, message: "must be a positive integer" });
      }
      if (!(entry.prev_hash === null || isHashString(entry.prev_hash))) {
        errors.push({ path: `${entryPath}.prev_hash`, message: "must be null or a sha256 hash" });
      }
      if (!isHashString(entry.attestation_hash)) {
        errors.push({ path: `${entryPath}.attestation_hash`, message: "must be a sha256 hash" });
      }
      if (errors.length > 0) throw new ValidationFailure(errors);

      if (entry.sequence !== previousSequence + 1) {
        throw new ValidationFailure([{ path: `${entryPath}.sequence`, message: `must continue the attestation sequence at ${previousSequence + 1}` }]);
      }

      const expectedPrevHash = previousSequence === 0 ? null : previousHash;
      if (entry.prev_hash !== expectedPrevHash) {
        throw new ValidationFailure([{ path: `${entryPath}.prev_hash`, message: "must equal the previous attestation hash" }]);
      }

      const attestationInfo = resolveAttestationRef(roots, entry.ref, options);
      const attestation = readJsonFile(attestationInfo.path, entry.ref);
      const hashCheck = verifyAttestationHash(attestation);
      if (!hashCheck.ok) {
        throw new ValidationFailure([{ path: `${entry.ref}.attestation_hash`, message: `hash mismatch: expected ${hashCheck.expected}, received ${hashCheck.actual}` }]);
      }
      if (attestation.attestation_hash !== entry.attestation_hash) {
        throw new ValidationFailure([{ path: `${entryPath}.attestation_hash`, message: `must match ${entry.ref}` }]);
      }
      if (attestation.sequence !== entry.sequence) {
        throw new ValidationFailure([{ path: `${entry.ref}.sequence`, message: `must match index sequence ${entry.sequence}` }]);
      }
      if ((attestation.prev_hash ?? null) !== entry.prev_hash) {
        throw new ValidationFailure([{ path: `${entry.ref}.prev_hash`, message: "must match index prev_hash" }]);
      }
      if (attestation.type !== entry.type) {
        throw new ValidationFailure([{ path: `${entry.ref}.type`, message: `must match index type ${entry.type}` }]);
      }

      previousHash = entry.attestation_hash;
      previousSequence = entry.sequence;
      orderedRefs.push(entry.ref);
      acceptedAttestations[entry.ref] = {
        ref: entry.ref,
        path: attestationInfo.path,
        attestation,
        attestation_hash: entry.attestation_hash,
      };

      return {
        ref: entry.ref,
        type: entry.type,
        sequence: entry.sequence,
      };
    });
    checks.push(entryCheck);
  }

  if (orderedRefs.length > 0) {
    const firstRef = orderedRefs[0];
    const firstAttestation = acceptedAttestations[firstRef]?.attestation;
    if (firstAttestation?.type !== "run-base") {
      checks.push(failCheck("attestation-graph.anchor", [
        { path: firstRef, message: "the first attestation in the graph must be run-base" },
      ]));
    } else {
      checks.push(okCheck("attestation-graph.anchor", { ref: firstRef }));
    }
  }

  return finalizeChecks(checks, { acceptedAttestations, orderedRefs, index });
}

export function validateRunBaseAttestation(attestation, context = {}) {
  const checks = [];
  const shapeErrors = [
    ...collectCommonAttestationErrors(attestation, "run-base", "run-base"),
    ...collectRunBaseBindingErrors(attestation?.bindings, "run-base.bindings"),
  ];
  checks.push(shapeErrors.length === 0 ? okCheck("run-base.shape") : failCheck("run-base.shape", shapeErrors));
  if (shapeErrors.length > 0) return finalizeChecks(checks);

  const bindings = attestation.bindings;
  const runDir = context.runDir ? readRealPath(resolve(context.runDir), "runDir", context) : null;
  const repoRoot = readRealPath(resolve(bindings.repo_root), "run-base.bindings.repo_root", context);
  const featureWorktree = readRealPath(resolve(bindings.feature_worktree), "run-base.bindings.feature_worktree", context);

  checks.push(runCheck("run-base.sequence", () => {
    if (attestation.sequence !== 1) throw new Error("run-base attestation sequence must equal 1");
    if (attestation.prev_hash !== null) throw new Error("run-base attestation prev_hash must be null");
    return { sequence: 1 };
  }));

  checks.push(runCheck("run-base.run-dir", () => {
    const boundRunDir = readRealPath(resolve(bindings.run_dir), "run-base.bindings.run_dir", context);
    if (runDir && boundRunDir !== runDir) throw new Error(`run-base attests ${boundRunDir}, expected ${runDir}`);
    return { run_dir: boundRunDir };
  }));

  checks.push(runCheck("run-base.feature-worktree", () => {
    const identity = checkWorktreeIdentity(repoRoot, bindings.feature_branch, featureWorktree, context);
    if (!identity.ok) throw new ValidationFailure(flattenCheckErrors(identity.checks));
    return { feature_worktree: featureWorktree };
  }));

  checks.push(runCheck("run-base.git-common-dir", () => {
    const result = requireGitSuccess(featureWorktree, ["rev-parse", "--git-common-dir"], context, "git rev-parse --git-common-dir");
    const observed = resolveGitPath(featureWorktree, result.stdout.trim());
    const observedRealPath = readRealPath(observed, "git common dir", context);
    const expectedRealPath = readRealPath(resolve(bindings.git_common_dir), "run-base.bindings.git_common_dir", context);
    if (observedRealPath !== expectedRealPath) {
      throw new Error(`git common dir is ${observedRealPath}, expected ${expectedRealPath}`);
    }
    return { git_common_dir: observedRealPath };
  }));

  checks.push(runCheck("run-base.base-tree", () => {
    const baseTree = revParseSingle(featureWorktree, `${bindings.base_commit}^{tree}`, context);
    if (baseTree !== bindings.base_tree) {
      throw new Error(`base tree is ${baseTree}, expected ${bindings.base_tree}`);
    }
    return { base_tree: baseTree };
  }));

  checks.push(runCheck("run-base.base-ancestor-of-head", () => {
    const { head_commit } = readHeadObservation(featureWorktree, context);
    if (!isAncestor(featureWorktree, bindings.base_commit, head_commit, context)) {
      throw new Error(`base commit ${bindings.base_commit} is not an ancestor of current head ${head_commit}`);
    }
    return { head_commit };
  }));

  checks.push(runCheck("run-base.base-ref-bounds", () => {
    const resolvedBaseRef = tryRevParse(featureWorktree, bindings.base_ref, context);
    if (!resolvedBaseRef) return { base_ref: bindings.base_ref, resolved: false };
    if (!isAncestor(featureWorktree, bindings.base_commit, resolvedBaseRef, context)) {
      throw new Error(`base commit ${bindings.base_commit} is not an ancestor of ${bindings.base_ref}`);
    }
    return { base_ref: bindings.base_ref, resolved: true };
  }));

  return finalizeChecks(checks);
}

export function validateSliceObservationAttestation(attestation, context = {}) {
  const checks = [];
  const shapeErrors = [
    ...collectCommonAttestationErrors(attestation, "slice-observation", "slice-observation"),
    ...collectSliceObservationBindingErrors(attestation?.bindings, "slice-observation.bindings"),
  ];
  checks.push(shapeErrors.length === 0 ? okCheck("slice-observation.shape") : failCheck("slice-observation.shape", shapeErrors));
  if (shapeErrors.length > 0) return finalizeChecks(checks);

  const bindings = attestation.bindings;
  const repoRoot = resolveRepoRootFromContext(context, "slice-observation requires repoRoot or runBase.bindings.repo_root");
  const worktree = readRealPath(resolve(bindings.worktree), "slice-observation.bindings.worktree", context);

  checks.push(runCheck("slice-observation.worktree-identity", () => {
    const identity = checkWorktreeIdentity(repoRoot, bindings.branch, worktree, context);
    if (!identity.ok) throw new ValidationFailure(flattenCheckErrors(identity.checks));
    return { branch: bindings.branch, worktree };
  }));

  checks.push(runCheck("slice-observation.evidence-hash", () => {
    const evidence = resolveEvidenceRef(resolveRootsForContext(context), bindings.evidence_ref, context);
    const observedHash = hashFile(evidence.path);
    if (observedHash !== bindings.evidence_hash) {
      throw new Error(`evidence hash is ${observedHash}, expected ${bindings.evidence_hash}`);
    }
    return { evidence_ref: bindings.evidence_ref };
  }));

  checks.push(runCheck("slice-observation.head", () => {
    const observation = readHeadObservation(worktree, context);
    if (observation.head_commit !== bindings.slice_commit) {
      throw new Error(`slice commit is ${observation.head_commit}, expected ${bindings.slice_commit}`);
    }
    if (observation.head_tree !== bindings.slice_tree) {
      throw new Error(`slice tree is ${observation.head_tree}, expected ${bindings.slice_tree}`);
    }
    return observation;
  }));

  checks.push(runCheck("slice-observation.base-ancestor", () => {
    if (!isAncestor(worktree, bindings.base_commit, bindings.slice_commit, context)) {
      throw new Error(`base commit ${bindings.base_commit} is not an ancestor of slice commit ${bindings.slice_commit}`);
    }
    return { base_commit: bindings.base_commit, slice_commit: bindings.slice_commit };
  }));

  checks.push(runCheck("slice-observation.slice-tree", () => {
    const observedTree = revParseSingle(worktree, `${bindings.slice_commit}^{tree}`, context);
    if (observedTree !== bindings.slice_tree) {
      throw new Error(`slice tree is ${observedTree}, expected ${bindings.slice_tree}`);
    }
    return { slice_tree: observedTree };
  }));

  return finalizeChecks(checks);
}

export function validateReviewApprovalAttestation(attestation, context = {}) {
  const checks = [];
  const shapeErrors = [
    ...collectCommonAttestationErrors(attestation, "review-approval", "review-approval"),
    ...collectReviewApprovalBindingErrors(attestation?.bindings, "review-approval.bindings"),
  ];
  checks.push(shapeErrors.length === 0 ? okCheck("review-approval.shape") : failCheck("review-approval.shape", shapeErrors));
  if (shapeErrors.length > 0) return finalizeChecks(checks);

  const bindings = attestation.bindings;

  checks.push(runCheck("review-approval.review-hash", () => {
    const review = resolveReviewRef(resolveRootsForContext(context), bindings.review_ref, context);
    const observedHash = hashFile(review.path);
    if (observedHash !== bindings.review_hash) {
      throw new Error(`review hash is ${observedHash}, expected ${bindings.review_hash}`);
    }
    return { review_ref: bindings.review_ref };
  }));

  checks.push(runCheck("review-approval.evidence-hash", () => {
    const evidence = resolveEvidenceRef(resolveRootsForContext(context), bindings.evidence_ref, context);
    const observedHash = hashFile(evidence.path);
    if (observedHash !== bindings.evidence_hash) {
      throw new Error(`evidence hash is ${observedHash}, expected ${bindings.evidence_hash}`);
    }
    return { evidence_ref: bindings.evidence_ref };
  }));

  checks.push(runCheck("review-approval.guard-hash", () => {
    const observedHash = hashValue(bindings.guard);
    if (observedHash !== bindings.guard_result_hash) {
      throw new Error(`guard hash is ${observedHash}, expected ${bindings.guard_result_hash}`);
    }
    return { guard_result_hash: observedHash };
  }));

  checks.push(runCheck("review-approval.guard-shape", () => {
    assertCleanGuard(bindings.guard, "review-approval.bindings.guard");
    return { worktree: bindings.guard.worktree };
  }));

  checks.push(runCheck("review-approval.guard-head", () => {
    const guardWorktree = readRealPath(resolve(bindings.guard.worktree), "review guard worktree", context);
    const observation = readHeadObservation(guardWorktree, context);
    if (observation.head_commit !== bindings.guard.head_commit) {
      throw new Error(`guard head commit is ${observation.head_commit}, expected ${bindings.guard.head_commit}`);
    }
    if (observation.head_tree !== bindings.guard.head_tree) {
      throw new Error(`guard head tree is ${observation.head_tree}, expected ${bindings.guard.head_tree}`);
    }
    if (bindings.subject_commit !== bindings.guard.head_commit) {
      throw new Error(`review subject_commit ${bindings.subject_commit} does not match guard head ${bindings.guard.head_commit}`);
    }
    if (bindings.subject_tree !== bindings.guard.head_tree) {
      throw new Error(`review subject_tree ${bindings.subject_tree} does not match guard head tree ${bindings.guard.head_tree}`);
    }
    if (context.expectedWorktree) {
      const expectedWorktree = readRealPath(resolve(context.expectedWorktree), "expectedWorktree", context);
      if (guardWorktree !== expectedWorktree) {
        throw new Error(`guard worktree is ${guardWorktree}, expected ${expectedWorktree}`);
      }
    }
    return observation;
  }));

  checks.push(runCheck("review-approval.subject-bindings", () => {
    if (context.subjectCommit && bindings.subject_commit !== context.subjectCommit) {
      throw new Error(`subject commit is ${bindings.subject_commit}, expected ${context.subjectCommit}`);
    }
    if (context.subjectTree && bindings.subject_tree !== context.subjectTree) {
      throw new Error(`subject tree is ${bindings.subject_tree}, expected ${context.subjectTree}`);
    }
    if (context.evidenceHash && bindings.evidence_hash !== context.evidenceHash) {
      throw new Error(`evidence hash is ${bindings.evidence_hash}, expected ${context.evidenceHash}`);
    }
    if (context.evidenceRef && bindings.evidence_ref !== context.evidenceRef) {
      throw new Error(`evidence ref is ${bindings.evidence_ref}, expected ${context.evidenceRef}`);
    }
    return { subject: bindings.subject };
  }));

  return finalizeChecks(checks);
}

export function validateDirectReviewedCommitAttestation(attestation, context = {}) {
  const checks = [];
  const shapeErrors = [
    ...collectCommonAttestationErrors(attestation, "direct-reviewed-commit", "direct-reviewed-commit"),
    ...collectDirectReviewedCommitBindingErrors(attestation?.bindings, "direct-reviewed-commit.bindings"),
  ];
  checks.push(shapeErrors.length === 0 ? okCheck("direct-reviewed-commit.shape") : failCheck("direct-reviewed-commit.shape", shapeErrors));
  if (shapeErrors.length > 0) return finalizeChecks(checks);

  const bindings = attestation.bindings;
  const gitCwd = resolveGitCwdFromContext(context);

  checks.push(runCheck("direct-reviewed-commit.evidence-hash", () => {
    const evidence = resolveEvidenceRef(resolveRootsForContext(context), bindings.evidence_ref, context);
    const observedHash = hashFile(evidence.path);
    if (observedHash !== bindings.evidence_hash) {
      throw new Error(`evidence hash is ${observedHash}, expected ${bindings.evidence_hash}`);
    }
    return { evidence_ref: bindings.evidence_ref };
  }));

  checks.push(runCheck("direct-reviewed-commit.commit-shape", () => {
    const observation = readCommitObservation(gitCwd, bindings.commit, context);
    if (observation.parents.length !== 1) {
      throw new Error(`direct reviewed commit ${bindings.commit} must have exactly one parent`);
    }
    if (observation.parents[0] !== bindings.parent_commit) {
      throw new Error(`direct reviewed commit parent is ${observation.parents[0]}, expected ${bindings.parent_commit}`);
    }
    if (observation.tree !== bindings.tree) {
      throw new Error(`direct reviewed commit tree is ${observation.tree}, expected ${bindings.tree}`);
    }
    return observation;
  }));

  checks.push(runCheck("direct-reviewed-commit.diff-hash", () => {
    const observedHash = gitDiffHash(gitCwd, bindings.parent_commit, bindings.commit, context);
    if (observedHash !== bindings.diff_hash) {
      throw new Error(`direct reviewed commit diff hash is ${observedHash}, expected ${bindings.diff_hash}`);
    }
    return { diff_hash: observedHash };
  }));

  return finalizeChecks(checks);
}

export function validateGateDecisionAttestation(attestation, context = {}) {
  const checks = [];
  const shapeErrors = [
    ...collectCommonAttestationErrors(attestation, "gate-decision", "gate-decision"),
    ...collectGateDecisionBindingErrors(attestation?.bindings, "gate-decision.bindings"),
  ];
  checks.push(shapeErrors.length === 0 ? okCheck("gate-decision.shape") : failCheck("gate-decision.shape", shapeErrors));
  if (shapeErrors.length > 0) return finalizeChecks(checks);

  const bindings = attestation.bindings;
  const roots = resolveRootsForContext(context);

  checks.push(runCheck("gate-decision.question-hash", () => {
    const question = resolveArtifactRef(roots, bindings.question_ref, context);
    const observedHash = hashFile(question.path, { mode: "raw" });
    if (observedHash !== bindings.question_hash) {
      throw new Error(`question hash is ${observedHash}, expected ${bindings.question_hash}`);
    }
    return { question_ref: bindings.question_ref };
  }));

  checks.push(runCheck("gate-decision.artifact-hash", () => {
    const artifact = resolveArtifactRef(roots, bindings.artifact_ref, context);
    const observedHash = hashFile(artifact.path, { mode: "raw" });
    if (observedHash !== bindings.artifact_hash) {
      throw new Error(`artifact hash is ${observedHash}, expected ${bindings.artifact_hash}`);
    }
    return { artifact_ref: bindings.artifact_ref };
  }));

  checks.push(runCheck("gate-decision.answer-binding", () => {
    if (stringValue(bindings.answer_ref)) {
      const answer = resolveArtifactRef(roots, bindings.answer_ref, context);
      const observedHash = hashFile(answer.path, { mode: "raw" });
      if (observedHash !== bindings.answer_hash) {
        throw new Error(`answer hash is ${observedHash}, expected ${bindings.answer_hash}`);
      }
      return { answer_ref: bindings.answer_ref };
    }
    if (!isHashString(bindings.answer_text_hash)) {
      throw new Error("gate decision must bind answer_ref/answer_hash or answer_text_hash");
    }
    return { answer_text_hash: bindings.answer_text_hash };
  }));

  return finalizeChecks(checks);
}

export function validateMergeChainAttestation(attestation, context = {}) {
  const checks = [];
  const shapeErrors = [
    ...collectCommonAttestationErrors(attestation, "merge-chain", "merge-chain"),
    ...collectMergeChainBindingErrors(attestation?.bindings, "merge-chain.bindings"),
  ];
  checks.push(shapeErrors.length === 0 ? okCheck("merge-chain.shape") : failCheck("merge-chain.shape", shapeErrors));
  if (shapeErrors.length > 0) return finalizeChecks(checks);

  const bindings = attestation.bindings;
  const runBaseResolution = resolveBaseAttestationForMergeChain(bindings, context);
  if (!runBaseResolution.ok) {
    checks.push(runBaseResolution.check);
    return finalizeChecks(checks);
  }

  const runBase = runBaseResolution.attestation;
  const repoRoot = runBase.bindings.repo_root;
  const featureWorktree = runBase.bindings.feature_worktree;
  const acceptedAttestations = context.acceptedAttestations || {};
  const firstParentCommits = [];
  let headObservation = null;

  checks.push(okCheck("merge-chain.base-attestation", { ref: bindings.base_attestation_ref }));

  checks.push(runCheck("merge-chain.feature-head", () => {
    headObservation = readHeadObservation(featureWorktree, context);
    if (headObservation.head_commit !== bindings.head_commit) {
      throw new Error(`feature head commit is ${headObservation.head_commit}, expected ${bindings.head_commit}`);
    }
    if (headObservation.head_tree !== bindings.head_tree) {
      throw new Error(`feature head tree is ${headObservation.head_tree}, expected ${bindings.head_tree}`);
    }
    return headObservation;
  }));

  checks.push(runCheck("merge-chain.base-commit", () => {
    if (bindings.base_commit !== runBase.bindings.base_commit) {
      throw new Error(`merge-chain base commit is ${bindings.base_commit}, expected ${runBase.bindings.base_commit}`);
    }
    if (bindings.feature_branch !== runBase.bindings.feature_branch) {
      throw new Error(`merge-chain feature branch is ${bindings.feature_branch}, expected ${runBase.bindings.feature_branch}`);
    }
    return { base_commit: bindings.base_commit, feature_branch: bindings.feature_branch };
  }));

  checks.push(runCheck("merge-chain.first-parent-order", () => {
    const result = requireGitSuccess(
      featureWorktree,
      ["rev-list", "--first-parent", "--reverse", `${bindings.base_commit}..${bindings.head_commit}`],
      context,
      `git rev-list --first-parent --reverse ${bindings.base_commit}..${bindings.head_commit}`,
    );
    firstParentCommits.push(
      ...normalizeGitStdout(result.stdout)
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    if (firstParentCommits.length !== bindings.entries.length) {
      throw new Error("merge-chain must include one entry for every first-parent commit in exact order");
    }
    return { commits: firstParentCommits };
  }));

  for (const [index, entry] of bindings.entries.entries()) {
    const previousCommit = index === 0 ? bindings.base_commit : firstParentCommits[index - 1];
    const actualCommit = firstParentCommits[index] ?? null;
    checks.push(runCheck(`merge-chain.entry.${index + 1}`, () => {
      if (!isRecord(entry)) throw new Error("merge-chain entry must be an object");
      if (entry.commit !== actualCommit) {
        throw new Error(`merge-chain entry commit is ${entry.commit}, expected ${actualCommit}`);
      }

      const commitObservation = readCommitObservation(featureWorktree, actualCommit, context);
      if (entry.type === "slice_merge") {
        validateSliceMergeEntry({
          entry,
          previousCommit,
          commitObservation,
          featureWorktree,
          repoRoot,
          acceptedAttestations,
          context,
        });
        return { type: entry.type, commit: actualCommit };
      }

      if (entry.type === "direct_reviewed_commit") {
        validateDirectReviewedCommitEntry({
          entry,
          previousCommit,
          commitObservation,
          featureWorktree,
          acceptedAttestations,
          context,
        });
        return { type: entry.type, commit: actualCommit };
      }

      throw new Error(`unknown merge-chain entry type ${entry.type}`);
    }));
  }

  return finalizeChecks(checks);
}

export function validateProvenanceAuthority(runDir, options = {}) {
  const checks = [];
  let roots;
  const rootsCheck = runCheck("provenance-authority.roots", () => {
    roots = resolveDurableRoots(runDir, options);
    return { run_dir: roots.run_dir };
  });
  checks.push(rootsCheck);
  if (!rootsCheck.ok) return finalizeChecks(checks, { acceptedAttestations: {}, orderedRefs: [] });

  const graph = validateAttestationGraph(roots, options);
  checks.push(...graph.checks);
  if (!graph.ok) return finalizeChecks(checks, { acceptedAttestations: graph.acceptedAttestations, orderedRefs: graph.orderedRefs });

  const orderedRefs = graph.orderedRefs;
  const acceptedAttestations = graph.acceptedAttestations;
  const runBaseRef = orderedRefs.find((ref) => acceptedAttestations[ref]?.attestation?.type === "run-base") ?? null;
  if (!runBaseRef) {
    checks.push(failCheck("provenance-authority.run-base", [
      { path: "attestations/index.json", message: "accepted attestation graph is missing run-base" },
    ]));
    return finalizeChecks(checks, { acceptedAttestations, orderedRefs });
  }

  const runBase = acceptedAttestations[runBaseRef].attestation;
  checks.push(...validateRunBaseAttestation(runBase, { ...options, runDir: roots.run_dir }).checks);

  const sharedContext = {
    ...options,
    runDir: roots.run_dir,
    roots,
    runBase,
    acceptedAttestations,
  };

  for (const ref of orderedRefs) {
    if (ref === runBaseRef) continue;
    const attestation = acceptedAttestations[ref].attestation;
    let result = null;

    if (attestation.type === "slice-observation") {
      result = validateSliceObservationAttestation(attestation, sharedContext);
    } else if (attestation.type === "review-approval") {
      result = validateReviewApprovalAttestation(attestation, sharedContext);
    } else if (attestation.type === "direct-reviewed-commit") {
      result = validateDirectReviewedCommitAttestation(attestation, sharedContext);
    } else if (attestation.type === "gate-decision") {
      result = validateGateDecisionAttestation(attestation, sharedContext);
    } else if (attestation.type === "merge-chain") {
      result = validateMergeChainAttestation(attestation, sharedContext);
    } else {
      result = finalizeChecks([
        failCheck(`provenance-authority.attestation.${ref}`, [
          { path: ref, message: `unknown attestation type ${attestation.type}` },
        ]),
      ]);
    }

    if (Array.isArray(result.checks)) checks.push(...result.checks);
  }

  return finalizeChecks(checks, { acceptedAttestations, orderedRefs });
}

function createAuthorityAttestation(type, input = {}) {
  if (!ATTESTATION_TYPES.includes(type)) throw new Error(`unsupported attestation type ${type}`);
  const attestation = {
    schema_version: AUTHORITY_SCHEMA_VERSION,
    authority_model: AUTHORITY_MODEL,
    authority: AUTHORITY_NAME,
    type,
    run_id: requireText(input.run_id, "run_id"),
    sequence: requirePositiveInteger(input.sequence, "sequence"),
    prev_hash: input.prev_hash ?? null,
    subject: requireText(input.subject, "subject"),
    created_at: typeof input.created_at === "string" && input.created_at.trim() !== ""
      ? input.created_at
      : new Date().toISOString(),
    observed_by: AUTHORITY_NAME,
    safe_git_policy: SAFE_GIT_POLICY,
    bindings: cloneJsonValue(requireRecord(input.bindings, "bindings")),
  };
  if (!(attestation.prev_hash === null || isHashString(attestation.prev_hash))) {
    throw new Error("prev_hash must be null or a sha256 hash");
  }
  return withAttestationHash(attestation);
}

function normalizeAttestationIndexSource(entry, index) {
  if (!isRecord(entry)) throw new Error(`entries[${index}] must be an object`);
  const ref = requireText(entry.ref, `entries[${index}].ref`);
  const attestation = withAttestationHash(entry.attestation ?? entry.value ?? entry);
  return {
    ref,
    attestation,
  };
}

function collectCommonAttestationErrors(attestation, expectedType, path) {
  const errors = [];
  if (!isRecord(attestation)) return [{ path, message: "must be an object" }];

  if (attestation.schema_version !== AUTHORITY_SCHEMA_VERSION) {
    errors.push({ path: `${path}.schema_version`, message: `must equal ${AUTHORITY_SCHEMA_VERSION}` });
  }
  if (attestation.authority_model !== AUTHORITY_MODEL) {
    errors.push({ path: `${path}.authority_model`, message: `must equal ${AUTHORITY_MODEL}` });
  }
  if (attestation.authority !== AUTHORITY_NAME) {
    errors.push({ path: `${path}.authority`, message: `must equal ${AUTHORITY_NAME}` });
  }
  if (attestation.type !== expectedType) {
    errors.push({ path: `${path}.type`, message: `must equal ${expectedType}` });
  }
  if (!stringValue(attestation.run_id)) errors.push({ path: `${path}.run_id`, message: "must be a non-empty string" });
  if (!Number.isInteger(attestation.sequence) || attestation.sequence < 1) {
    errors.push({ path: `${path}.sequence`, message: "must be a positive integer" });
  }
  if (!(attestation.prev_hash === null || isHashString(attestation.prev_hash))) {
    errors.push({ path: `${path}.prev_hash`, message: "must be null or a sha256 hash" });
  }
  if (!stringValue(attestation.subject)) errors.push({ path: `${path}.subject`, message: "must be a non-empty string" });
  if (!stringValue(attestation.created_at)) errors.push({ path: `${path}.created_at`, message: "must be a non-empty string" });
  if (attestation.observed_by !== AUTHORITY_NAME) {
    errors.push({ path: `${path}.observed_by`, message: `must equal ${AUTHORITY_NAME}` });
  }
  if (attestation.safe_git_policy !== SAFE_GIT_POLICY) {
    errors.push({ path: `${path}.safe_git_policy`, message: `must equal ${SAFE_GIT_POLICY}` });
  }
  if (!isRecord(attestation.bindings)) errors.push({ path: `${path}.bindings`, message: "must be an object" });
  if (!isHashString(attestation.attestation_hash)) {
    errors.push({ path: `${path}.attestation_hash`, message: "must be a sha256 hash" });
  }

  if (errors.length > 0) return errors;

  const hashCheck = verifyAttestationHash(attestation);
  if (!hashCheck.ok) {
    errors.push({ path: `${path}.attestation_hash`, message: `must match canonical content hash ${hashCheck.expected}` });
  }
  return errors;
}

function collectRunBaseBindingErrors(bindings, path) {
  const errors = [];
  if (!isRecord(bindings)) return [{ path, message: "must be an object" }];
  pushRequiredString(errors, bindings, "repo_root", `${path}.repo_root`);
  pushRequiredString(errors, bindings, "run_dir", `${path}.run_dir`);
  pushRequiredString(errors, bindings, "git_common_dir", `${path}.git_common_dir`);
  pushRequiredString(errors, bindings, "feature_branch", `${path}.feature_branch`);
  pushRequiredString(errors, bindings, "feature_worktree", `${path}.feature_worktree`);
  pushRequiredString(errors, bindings, "base_ref", `${path}.base_ref`);
  pushRequiredString(errors, bindings, "base_commit", `${path}.base_commit`);
  pushRequiredString(errors, bindings, "base_tree", `${path}.base_tree`);
  return errors;
}

function collectSliceObservationBindingErrors(bindings, path) {
  const errors = [];
  if (!isRecord(bindings)) return [{ path, message: "must be an object" }];
  pushRequiredString(errors, bindings, "slice_id", `${path}.slice_id`);
  if (!Number.isInteger(bindings.attempt) || bindings.attempt < 1) {
    errors.push({ path: `${path}.attempt`, message: "must be a positive integer" });
  }
  pushRequiredString(errors, bindings, "branch", `${path}.branch`);
  pushRequiredString(errors, bindings, "worktree", `${path}.worktree`);
  pushRequiredString(errors, bindings, "base_commit", `${path}.base_commit`);
  pushRequiredString(errors, bindings, "slice_commit", `${path}.slice_commit`);
  pushRequiredString(errors, bindings, "slice_tree", `${path}.slice_tree`);
  pushRequiredString(errors, bindings, "evidence_ref", `${path}.evidence_ref`);
  pushRequiredHash(errors, bindings, "evidence_hash", `${path}.evidence_hash`);
  return errors;
}

function collectReviewApprovalBindingErrors(bindings, path) {
  const errors = [];
  if (!isRecord(bindings)) return [{ path, message: "must be an object" }];
  pushRequiredString(errors, bindings, "subject_type", `${path}.subject_type`);
  pushRequiredString(errors, bindings, "subject", `${path}.subject`);
  pushRequiredString(errors, bindings, "reviewer", `${path}.reviewer`);
  pushRequiredString(errors, bindings, "verdict", `${path}.verdict`);
  pushRequiredString(errors, bindings, "review_ref", `${path}.review_ref`);
  pushRequiredHash(errors, bindings, "review_hash", `${path}.review_hash`);
  pushRequiredString(errors, bindings, "evidence_ref", `${path}.evidence_ref`);
  pushRequiredHash(errors, bindings, "evidence_hash", `${path}.evidence_hash`);
  pushRequiredString(errors, bindings, "subject_commit", `${path}.subject_commit`);
  pushRequiredString(errors, bindings, "subject_tree", `${path}.subject_tree`);
  pushRequiredHash(errors, bindings, "guard_result_hash", `${path}.guard_result_hash`);
  if (!isRecord(bindings.guard)) errors.push({ path: `${path}.guard`, message: "must be an object" });
  return errors;
}

function collectDirectReviewedCommitBindingErrors(bindings, path) {
  const errors = [];
  if (!isRecord(bindings)) return [{ path, message: "must be an object" }];
  pushRequiredString(errors, bindings, "entry_id", `${path}.entry_id`);
  if (!DIRECT_REVIEWED_COMMIT_PURPOSE_SET.has(bindings.purpose)) {
    errors.push({ path: `${path}.purpose`, message: `must be one of ${DIRECT_REVIEWED_COMMIT_PURPOSES.join(", ")}` });
  }
  pushRequiredString(errors, bindings, "commit", `${path}.commit`);
  pushRequiredString(errors, bindings, "parent_commit", `${path}.parent_commit`);
  pushRequiredString(errors, bindings, "tree", `${path}.tree`);
  pushRequiredHash(errors, bindings, "diff_hash", `${path}.diff_hash`);
  pushRequiredString(errors, bindings, "evidence_ref", `${path}.evidence_ref`);
  pushRequiredHash(errors, bindings, "evidence_hash", `${path}.evidence_hash`);
  pushRequiredString(errors, bindings, "producing_role", `${path}.producing_role`);
  if (bindings.review_hash !== undefined && !isHashString(bindings.review_hash)) {
    errors.push({ path: `${path}.review_hash`, message: "must be a sha256 hash when provided" });
  }
  if (bindings.guard_result_hash !== undefined && !isHashString(bindings.guard_result_hash)) {
    errors.push({ path: `${path}.guard_result_hash`, message: "must be a sha256 hash when provided" });
  }
  return errors;
}

function collectGateDecisionBindingErrors(bindings, path) {
  const errors = [];
  if (!isRecord(bindings)) return [{ path, message: "must be an object" }];
  pushRequiredString(errors, bindings, "gate", `${path}.gate`);
  pushRequiredString(errors, bindings, "decision", `${path}.decision`);
  pushRequiredString(errors, bindings, "approval_source", `${path}.approval_source`);
  pushRequiredString(errors, bindings, "question_ref", `${path}.question_ref`);
  pushRequiredHash(errors, bindings, "question_hash", `${path}.question_hash`);
  pushRequiredString(errors, bindings, "artifact_ref", `${path}.artifact_ref`);
  pushRequiredHash(errors, bindings, "artifact_hash", `${path}.artifact_hash`);
  if (stringValue(bindings.answer_ref)) {
    pushRequiredHash(errors, bindings, "answer_hash", `${path}.answer_hash`);
  } else if (!isHashString(bindings.answer_text_hash)) {
    errors.push({ path: `${path}.answer_text_hash`, message: "must be a sha256 hash when answer_ref is absent" });
  }
  return errors;
}

function collectMergeChainBindingErrors(bindings, path) {
  const errors = [];
  if (!isRecord(bindings)) return [{ path, message: "must be an object" }];
  pushRequiredString(errors, bindings, "feature_branch", `${path}.feature_branch`);
  pushRequiredString(errors, bindings, "base_attestation_ref", `${path}.base_attestation_ref`);
  pushRequiredHash(errors, bindings, "base_attestation_hash", `${path}.base_attestation_hash`);
  pushRequiredString(errors, bindings, "base_commit", `${path}.base_commit`);
  pushRequiredString(errors, bindings, "head_commit", `${path}.head_commit`);
  pushRequiredString(errors, bindings, "head_tree", `${path}.head_tree`);
  if (!Array.isArray(bindings.entries) || bindings.entries.length === 0) {
    errors.push({ path: `${path}.entries`, message: "must be a non-empty array" });
  }
  return errors;
}

function validateSliceMergeEntry({ entry, previousCommit, commitObservation, featureWorktree, repoRoot, acceptedAttestations, context }) {
  const required = ["slice_attestation_ref", "slice_attestation_hash", "review_attestation_ref", "review_attestation_hash", "slice_commit"];
  for (const key of required) {
    if (!stringValue(entry[key])) throw new Error(`slice_merge entry ${key} must be a non-empty string`);
  }
  if (!isHashString(entry.slice_attestation_hash)) throw new Error("slice_merge entry slice_attestation_hash must be a sha256 hash");
  if (!isHashString(entry.review_attestation_hash)) throw new Error("slice_merge entry review_attestation_hash must be a sha256 hash");
  if (commitObservation.parents.length !== 2) {
    throw new Error(`slice_merge commit ${entry.commit} must have exactly two parents`);
  }
  if (commitObservation.parents[0] !== previousCommit) {
    throw new Error(`slice_merge commit ${entry.commit} first parent is ${commitObservation.parents[0]}, expected ${previousCommit}`);
  }

  const sliceAttestationRecord = resolveAcceptedAttestation(entry.slice_attestation_ref, entry.slice_attestation_hash, acceptedAttestations, context, "slice-observation");
  const reviewAttestationRecord = resolveAcceptedAttestation(entry.review_attestation_ref, entry.review_attestation_hash, acceptedAttestations, context, "review-approval");
  const sliceAttestation = sliceAttestationRecord.attestation;
  const reviewAttestation = reviewAttestationRecord.attestation;
  const sliceBindings = sliceAttestation.bindings;
  const reviewBindings = reviewAttestation.bindings;

  const sliceValidation = validateSliceObservationAttestation(sliceAttestation, context);
  if (!sliceValidation.ok) throw new ValidationFailure(flattenCheckErrors(sliceValidation.checks));

  const reviewValidation = validateReviewApprovalAttestation(reviewAttestation, {
    ...context,
    expectedWorktree: sliceBindings.worktree,
    subjectCommit: sliceBindings.slice_commit,
    subjectTree: sliceBindings.slice_tree,
    evidenceRef: sliceBindings.evidence_ref,
    evidenceHash: sliceBindings.evidence_hash,
  });
  if (!reviewValidation.ok) throw new ValidationFailure(flattenCheckErrors(reviewValidation.checks));

  if (commitObservation.parents[1] !== sliceBindings.slice_commit) {
    throw new Error(`slice_merge commit ${entry.commit} second parent is ${commitObservation.parents[1]}, expected ${sliceBindings.slice_commit}`);
  }
  if (entry.slice_commit !== sliceBindings.slice_commit) {
    throw new Error(`slice_merge entry slice_commit is ${entry.slice_commit}, expected ${sliceBindings.slice_commit}`);
  }
  if (reviewBindings.subject_type !== "slice") {
    throw new Error(`review approval subject_type is ${reviewBindings.subject_type}, expected slice`);
  }
  if (reviewBindings.subject !== sliceBindings.slice_id) {
    throw new Error(`review approval subject is ${reviewBindings.subject}, expected ${sliceBindings.slice_id}`);
  }
  if (reviewBindings.subject_commit !== sliceBindings.slice_commit) {
    throw new Error(`review approval subject_commit is ${reviewBindings.subject_commit}, expected ${sliceBindings.slice_commit}`);
  }
  if (reviewBindings.subject_tree !== sliceBindings.slice_tree) {
    throw new Error(`review approval subject_tree is ${reviewBindings.subject_tree}, expected ${sliceBindings.slice_tree}`);
  }
  if (reviewBindings.evidence_hash !== sliceBindings.evidence_hash) {
    throw new Error(`review approval evidence_hash is ${reviewBindings.evidence_hash}, expected ${sliceBindings.evidence_hash}`);
  }
  if (reviewBindings.review_hash !== hashFile(resolveReviewRef(resolveRootsForContext(context), reviewBindings.review_ref, context).path)) {
    throw new Error("review approval review_hash no longer matches the current review file");
  }

  const mergeTree = computeMergeTree(featureWorktree, previousCommit, sliceBindings.slice_commit, context);
  if (mergeTree.tree !== commitObservation.tree) {
    throw new Error(`merge-tree result ${mergeTree.tree} does not match actual merge tree ${commitObservation.tree}`);
  }

  const sliceWorktree = readRealPath(resolve(sliceBindings.worktree), "slice worktree", context);
  if (!isContainedPath(join(resolvePhysicalPath(repoRoot), ".opencode", "worktrees"), sliceWorktree)) {
    throw new Error(`slice worktree ${sliceWorktree} escapes ${join(resolvePhysicalPath(repoRoot), ".opencode", "worktrees")}`);
  }
}

function validateDirectReviewedCommitEntry({ entry, previousCommit, commitObservation, featureWorktree, acceptedAttestations, context }) {
  const required = ["direct_commit_attestation_ref", "direct_commit_attestation_hash", "review_attestation_ref", "review_attestation_hash"];
  for (const key of required) {
    if (!stringValue(entry[key])) throw new Error(`direct_reviewed_commit entry ${key} must be a non-empty string`);
  }
  if (!isHashString(entry.direct_commit_attestation_hash)) {
    throw new Error("direct_reviewed_commit entry direct_commit_attestation_hash must be a sha256 hash");
  }
  if (!isHashString(entry.review_attestation_hash)) {
    throw new Error("direct_reviewed_commit entry review_attestation_hash must be a sha256 hash");
  }
  if (commitObservation.parents.length !== 1) {
    throw new Error(`direct reviewed commit ${entry.commit} must have exactly one parent`);
  }
  if (commitObservation.parents[0] !== previousCommit) {
    throw new Error(`direct reviewed commit parent is ${commitObservation.parents[0]}, expected ${previousCommit}`);
  }

  const directAttestationRecord = resolveAcceptedAttestation(
    entry.direct_commit_attestation_ref,
    entry.direct_commit_attestation_hash,
    acceptedAttestations,
    context,
    "direct-reviewed-commit",
  );
  const reviewAttestationRecord = resolveAcceptedAttestation(
    entry.review_attestation_ref,
    entry.review_attestation_hash,
    acceptedAttestations,
    context,
    "review-approval",
  );
  const directAttestation = directAttestationRecord.attestation;
  const reviewAttestation = reviewAttestationRecord.attestation;
  const directBindings = directAttestation.bindings;
  const reviewBindings = reviewAttestation.bindings;

  const directValidation = validateDirectReviewedCommitAttestation(directAttestation, context);
  if (!directValidation.ok) throw new ValidationFailure(flattenCheckErrors(directValidation.checks));

  const reviewValidation = validateReviewApprovalAttestation(reviewAttestation, {
    ...context,
    subjectCommit: directBindings.commit,
    subjectTree: directBindings.tree,
    evidenceRef: directBindings.evidence_ref,
    evidenceHash: directBindings.evidence_hash,
  });
  if (!reviewValidation.ok) throw new ValidationFailure(flattenCheckErrors(reviewValidation.checks));

  if (directBindings.commit !== entry.commit) {
    throw new Error(`direct reviewed commit attestation commit is ${directBindings.commit}, expected ${entry.commit}`);
  }
  if (directBindings.parent_commit !== previousCommit) {
    throw new Error(`direct reviewed commit parent is ${directBindings.parent_commit}, expected ${previousCommit}`);
  }
  if (commitObservation.tree !== directBindings.tree) {
    throw new Error(`direct reviewed commit tree is ${commitObservation.tree}, expected ${directBindings.tree}`);
  }
  const observedDiffHash = gitDiffHash(featureWorktree, previousCommit, entry.commit, context);
  if (observedDiffHash !== directBindings.diff_hash) {
    throw new Error(`direct reviewed commit diff hash is ${observedDiffHash}, expected ${directBindings.diff_hash}`);
  }
  if (reviewBindings.subject_commit !== directBindings.commit) {
    throw new Error(`review approval subject_commit is ${reviewBindings.subject_commit}, expected ${directBindings.commit}`);
  }
  if (reviewBindings.subject_tree !== directBindings.tree) {
    throw new Error(`review approval subject_tree is ${reviewBindings.subject_tree}, expected ${directBindings.tree}`);
  }
  if (reviewBindings.evidence_hash !== directBindings.evidence_hash) {
    throw new Error(`review approval evidence_hash is ${reviewBindings.evidence_hash}, expected ${directBindings.evidence_hash}`);
  }
  if (isHashString(directBindings.review_hash) && directBindings.review_hash !== reviewBindings.review_hash) {
    throw new Error(`direct reviewed commit review_hash is ${directBindings.review_hash}, expected ${reviewBindings.review_hash}`);
  }
  if (isHashString(directBindings.guard_result_hash) && directBindings.guard_result_hash !== reviewBindings.guard_result_hash) {
    throw new Error(`direct reviewed commit guard_result_hash is ${directBindings.guard_result_hash}, expected ${reviewBindings.guard_result_hash}`);
  }
}

function resolveBaseAttestationForMergeChain(bindings, context) {
  const acceptedAttestations = context.acceptedAttestations || {};
  if (context.runBase && context.runBase.attestation_hash === bindings.base_attestation_hash) {
    return { ok: true, attestation: context.runBase };
  }

  const record = acceptedAttestations[bindings.base_attestation_ref];
  if (!record) {
    return {
      ok: false,
      check: failCheck("merge-chain.base-attestation", [
        { path: "merge-chain.bindings.base_attestation_ref", message: `accepted attestation not found for ${bindings.base_attestation_ref}` },
      ]),
    };
  }
  if (record.attestation_hash !== bindings.base_attestation_hash) {
    return {
      ok: false,
      check: failCheck("merge-chain.base-attestation", [
        { path: "merge-chain.bindings.base_attestation_hash", message: `must match ${bindings.base_attestation_ref}` },
      ]),
    };
  }
  if (record.attestation.type !== "run-base") {
    return {
      ok: false,
      check: failCheck("merge-chain.base-attestation", [
        { path: bindings.base_attestation_ref, message: "must resolve to a run-base attestation" },
      ]),
    };
  }
  return { ok: true, attestation: record.attestation };
}

function resolveAcceptedAttestation(ref, expectedHash, acceptedAttestations, context, expectedType) {
  const record = acceptedAttestations?.[ref] ?? loadAcceptedAttestationFromRun(ref, context);
  if (!record) throw new Error(`accepted attestation not found for ${ref}`);
  if (record.attestation_hash !== expectedHash) {
    throw new Error(`attestation hash for ${ref} is ${record.attestation_hash}, expected ${expectedHash}`);
  }
  if (record.attestation.type !== expectedType) {
    throw new Error(`attestation ${ref} has type ${record.attestation.type}, expected ${expectedType}`);
  }
  return record;
}

function loadAcceptedAttestationFromRun(ref, context) {
  if (!context.runDir && !context.roots) return null;
  const info = resolveAttestationRef(resolveRootsForContext(context), ref, context);
  const attestation = readJsonFile(info.path, ref);
  return {
    ref,
    path: info.path,
    attestation,
    attestation_hash: attestation.attestation_hash,
  };
}

function resolveRootsForContext(context) {
  if (hasResolvedRoots(context.roots)) return context.roots;
  if (hasResolvedRoots(context)) return context;
  if (context.runDir) return resolveDurableRoots(context.runDir, context);
  throw new Error("context must provide runDir or resolved durable roots");
}

function resolveRepoRootFromContext(context, errorMessage) {
  const repoRoot = context.repoRoot ?? context.runBase?.bindings?.repo_root;
  if (!repoRoot) throw new Error(errorMessage);
  return readRealPath(resolve(repoRoot), "repoRoot", context);
}

function resolveGitCwdFromContext(context) {
  const gitCwd = context.gitCwd ?? context.featureWorktree ?? context.runBase?.bindings?.feature_worktree ?? context.repoRoot;
  if (!gitCwd) throw new Error("context must provide gitCwd, featureWorktree, repoRoot, or runBase.bindings.feature_worktree");
  return readRealPath(resolve(gitCwd), "gitCwd", context);
}

function normalizeRoots(runDirOrRoots, options) {
  if (hasResolvedRoots(runDirOrRoots)) return runDirOrRoots;
  return resolveDurableRoots(runDirOrRoots, options);
}

function hasResolvedRoots(value) {
  return isRecord(value)
    && stringValue(value.run_dir)
    && DURABLE_ROOT_NAMES.every((rootName) => stringValue(value[rootName]));
}

function resolveDurableRoot(declaredPath, rootName, runRealPath, options) {
  if (!existsSync(declaredPath)) throw new Error(`${rootName} root is missing: ${declaredPath}`);
  const stats = lstatSync(declaredPath);
  if (stats.isSymbolicLink()) throw new Error(`${rootName} root must not be a symlink: ${declaredPath}`);
  if (!stats.isDirectory()) throw new Error(`${rootName} root must be a directory: ${declaredPath}`);
  const realRoot = readRealPath(declaredPath, `${rootName} root`, options);
  if (!isContainedPath(runRealPath, realRoot)) {
    throw new Error(`${rootName} root must be physically contained under ${runRealPath}`);
  }
  return realRoot;
}

function walkDurableRef(rootPath, relativeSegments, ref, { mustExist, options }) {
  let currentPath = rootPath;
  for (const [index, segment] of relativeSegments.entries()) {
    currentPath = join(currentPath, segment);
    const isLeaf = index === relativeSegments.length - 1;
    if (!existsSync(currentPath)) {
      if (!mustExist && isLeaf) {
        return { path: currentPath, realpath: resolve(currentPath) };
      }
      throw new Error(`${ref} does not exist`);
    }
    const stats = lstatSync(currentPath);
    if (stats.isSymbolicLink()) throw new Error(`${ref} must not traverse symlinks`);
  }

  const realPath = readRealPath(currentPath, ref, options);
  if (!isContainedPath(rootPath, realPath)) throw new Error(`${ref} escapes durable root ${rootPath}`);
  return { path: currentPath, realpath: realPath };
}

function validateDurableRef(ref, kind) {
  if (isAbsolute(ref)) throw new Error(`${ref} must be a relative path`);
  const segments = normalizePathLikeSegments(ref, "ref");
  const rootName = segments[0];
  if (rootName !== kind) throw new Error(`${ref} must be rooted under ${kind}/`);

  if (JSON_LEAF_ROOTS.has(rootName)) {
    if (segments.length !== 2) throw new Error(`${ref} must match ${rootName}/<id>.json`);
    if (extname(segments[1]) !== ".json") throw new Error(`${ref} must end in .json`);
  }

  if (rootName === "attestations") {
    if (segments.length < 2) throw new Error(`${ref} must contain an attestation path`);
    if (extname(segments.at(-1)) !== ".json") throw new Error(`${ref} must end in .json`);
  }

  if (rootName === "artifacts" && segments.length < 2) {
    throw new Error(`${ref} must contain an artifact path`);
  }

  return { segments, rootName };
}

function detectDurableRefKind(ref) {
  const segments = normalizePathLikeSegments(ref, "ref");
  const rootName = segments[0];
  if (!DURABLE_ROOT_NAMES.includes(rootName)) throw new Error(`${ref} must begin with one of ${DURABLE_ROOT_NAMES.join(", ")}`);
  return rootName;
}

function normalizePathLikeSegments(value, name) {
  const text = requireText(value, name);
  if (text.includes("\\")) throw new Error(`${name} must use forward slashes`);
  const segments = text.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${name} must not contain empty, '.' or '..' segments`);
  }
  return segments;
}

function requireGitSuccess(cwd, args, options, label) {
  const result = callSafeGit(cwd, args, options);
  if (!result.ok) {
    const detail = [result.stderr, result.stdout].find((value) => typeof value === "string" && value.trim() !== "") ?? "git observation failed";
    throw new Error(`${label} failed: ${detail}`);
  }
  return result;
}

function callSafeGit(cwd, args, options = {}) {
  const safeGitFn = typeof options.safeGitFn === "function" ? options.safeGitFn : safeGit;
  const safeGitOptions = pickSafeGitOptions(options);
  return safeGitFn(cwd, args, safeGitOptions);
}

function pickSafeGitOptions(options) {
  return {
    env: options.env,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    spawnSync: options.spawnSync,
  };
}

function revParseSingle(cwd, rev, options = {}) {
  const result = requireGitSuccess(cwd, ["rev-parse", rev], options, `git rev-parse ${rev}`);
  const value = result.stdout.trim();
  if (!value) throw new Error(`git rev-parse ${rev} returned empty output`);
  return value;
}

function tryRevParse(cwd, rev, options = {}) {
  const result = callSafeGit(cwd, ["rev-parse", "--verify", rev], options);
  if (result.status === 0 && result.ok) return result.stdout.trim() || null;
  if (result.status === 1) return null;
  if (["unknown revision", "Needed a single revision", "not a valid object name"].some((needle) => String(result.stderr || "").includes(needle))) {
    return null;
  }
  const detail = [result.stderr, result.stdout].find((value) => typeof value === "string" && value.trim() !== "") ?? "git rev-parse failed";
  throw new Error(`git rev-parse --verify ${rev} failed: ${detail}`);
}

function isAncestor(cwd, ancestorCommit, descendantCommit, options = {}) {
  const result = callSafeGit(cwd, ["merge-base", "--is-ancestor", ancestorCommit, descendantCommit], options);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const detail = [result.stderr, result.stdout].find((value) => typeof value === "string" && value.trim() !== "") ?? "git merge-base failed";
  throw new Error(`git merge-base --is-ancestor ${ancestorCommit} ${descendantCommit} failed: ${detail}`);
}

function resolveGitPath(baseDir, gitPath) {
  return isAbsolute(gitPath) ? gitPath : resolve(baseDir, gitPath);
}

function finalizeWorktreeEntry(entry) {
  return {
    ...entry,
    branch_ref: typeof entry.branch === "string" ? entry.branch : null,
    branch_short: typeof entry.branch === "string" && entry.branch.startsWith("refs/heads/")
      ? entry.branch.slice("refs/heads/".length)
      : typeof entry.branch === "string"
        ? entry.branch
        : null,
  };
}

function assertCleanGuard(guard, path) {
  if (!isRecord(guard)) throw new Error(`${path} must be an object`);
  if (guard.status !== "clean") throw new Error(`${path}.status must equal clean`);
  if (guard.safe_git_policy !== SAFE_GIT_POLICY) {
    throw new Error(`${path}.safe_git_policy must equal ${SAFE_GIT_POLICY}`);
  }
  if (!stringValue(guard.worktree)) throw new Error(`${path}.worktree must be a non-empty string`);
  if (!stringValue(guard.head_commit)) throw new Error(`${path}.head_commit must be a non-empty string`);
  if (!stringValue(guard.head_tree)) throw new Error(`${path}.head_tree must be a non-empty string`);
  if (!Array.isArray(guard.dirty_paths) || guard.dirty_paths.length !== 0) {
    throw new Error(`${path}.dirty_paths must be an empty array`);
  }
  if (!Array.isArray(guard.hidden_index_paths) || guard.hidden_index_paths.length !== 0) {
    throw new Error(`${path}.hidden_index_paths must be an empty array`);
  }
}

function flattenCheckErrors(checks) {
  return checks.flatMap((check) => Array.isArray(check.errors) ? check.errors : []);
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`could not parse ${label}: ${error.message}`);
  }
}

function normalizeHashMode(mode, filePath) {
  if (mode === "raw" || mode === "json") return mode;
  if (mode === undefined || mode === null || mode === "auto") {
    return extname(filePath).toLowerCase() === ".json" ? "json" : "raw";
  }
  throw new Error(`unsupported hash mode ${mode}`);
}

function canonicalizeJsonValue(value) {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => canonicalizeJsonValue(normalizeJsonArrayValue(item)));

  if (typeof value === "object") {
    const materialized = typeof value.toJSON === "function" ? value.toJSON() : value;
    if (materialized === null || Array.isArray(materialized) || typeof materialized !== "object") {
      return canonicalizeJsonValue(materialized);
    }

    const normalized = {};
    for (const key of Object.keys(materialized).sort()) {
      const item = materialized[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      normalized[key] = canonicalizeJsonValue(item);
    }
    return normalized;
  }

  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

function normalizeJsonArrayValue(value) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return null;
  return value;
}

function withoutAttestationHash(attestation) {
  const normalized = cloneJsonValue(attestation);
  delete normalized.attestation_hash;
  return normalized;
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function hashBuffer(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function hashText(text) {
  return hashBuffer(Buffer.from(String(text), "utf8"));
}

function readRealPath(pathValue, label, options = {}) {
  const realpathFn = typeof options.realpathFn === "function" ? options.realpathFn : realpathSync.native;
  try {
    return realpathFn(pathValue);
  } catch (error) {
    const reason = classifyRealpathFailure(error);
    throw new Error(`${label} is ${reason}: ${pathValue}`);
  }
}

function classifyRealpathFailure(error) {
  if (error?.code === "ENOENT") return "missing";
  if (error?.code === "EACCES" || error?.code === "EPERM") return "inaccessible";
  return "unresolvable";
}

function resolvePhysicalPath(pathValue) {
  return existsSync(pathValue) ? realpathSync.native(pathValue) : resolve(pathValue);
}

function isContainedPath(parentPath, childPath) {
  const rel = relative(parentPath, childPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeGitStdout(stdout) {
  return typeof stdout === "string" ? stdout : String(stdout ?? "");
}

function runCheck(name, callback) {
  try {
    return okCheck(name, callback() || {});
  } catch (error) {
    return failCheck(name, error);
  }
}

function okCheck(name, details = {}) {
  return {
    name,
    ok: true,
    errors: [],
    details,
  };
}

function failCheck(name, error) {
  return {
    name,
    ok: false,
    errors: normalizeCheckErrors(error, name),
  };
}

function finalizeChecks(checks, extras = {}) {
  return {
    ok: checks.every((check) => check.ok),
    checks,
    ...extras,
  };
}

function normalizeCheckErrors(error, fallbackPath) {
  if (error instanceof ValidationFailure) return error.errors;
  if (Array.isArray(error)) return error.map((item) => normalizeErrorItem(item, fallbackPath));
  if (isRecord(error) && stringValue(error.path) && stringValue(error.message)) return [normalizeErrorItem(error, fallbackPath)];
  return [{ path: fallbackPath, message: error instanceof Error ? error.message : String(error) }];
}

function normalizeErrorItem(item, fallbackPath) {
  if (isRecord(item) && stringValue(item.path) && stringValue(item.message)) {
    return { path: item.path, message: item.message };
  }
  return { path: fallbackPath, message: String(item) };
}

function pushRequiredString(errors, record, key, path) {
  if (!stringValue(record[key])) errors.push({ path, message: "must be a non-empty string" });
}

function pushRequiredHash(errors, record, key, path) {
  if (!isHashString(record[key])) errors.push({ path, message: "must be a sha256 hash" });
}

function stringValue(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isHashString(value) {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireText(value, name) {
  if (!stringValue(value)) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requireRecord(value, name) {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

class ValidationFailure extends Error {
  constructor(errors) {
    super(errors.map((error) => `${error.path}: ${error.message}`).join("; "));
    this.name = "ValidationFailure";
    this.errors = errors;
  }
}
