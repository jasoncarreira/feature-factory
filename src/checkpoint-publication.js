import { spawnSync as defaultSpawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createTwoRefsAtomicallyNoReplace, git } from "./git.js";
import { withRunJsonLock } from "./run-state.js";
import {
  parseSlicesPlanBytes,
  validateCheckpointChildPublication,
  validateCheckpointConfiguration,
  validateCheckpointSource,
  validateRun,
  validateRunDir,
} from "./validate.js";
import { checkWorktreeIdentity, createOrRecoverWorktree } from "./worktrees.js";

const FULL_OID = /^[0-9a-f]{40}$/u;
const REMOTE_MAIN_REF = "refs/heads/main";
const REMOTE_TRACKING_MAIN_REF = "refs/remotes/origin/main";
const PLAN_REF = "plan/slices.json";
const REVIEW_REF = "reviews/work-decomposer.json";
const EXPECTED_CHILD_FILES = Object.freeze([PLAN_REF, REVIEW_REF, "run.json"]);

/**
 * Reconcile the create-only publication of one normal checkpoint child.
 * Launch and parent progress transitions deliberately remain outside this module.
 */
export async function reconcileCheckpointPublication(input, options = {}) {
  const context = normalizeContext(input);
  const claim = readAndValidateClaim(context.repository, context.reservedEntry.publication_claim_oid, options);
  assertPublicationBindings(context, claim);

  const planBytes = canonicalJsonBytes(context.manifestCheckpoint.child_plan);
  const dispositionBytes = canonicalJsonBytes(context.manifestCheckpoint.child_disposition);
  const plan = parseSlicesPlanBytes(planBytes, { label: PLAN_REF, requireIntegrationGate: true });
  assertReviewedBytes(context, planBytes, dispositionBytes);
  const checkpointSource = buildCheckpointSource(context, claim, dispositionBytes);
  const childRun = buildChildRun(context, checkpointSource, plan, planBytes, dispositionBytes);
  const expected = expectedPublicationBytes(childRun, planBytes, dispositionBytes);

  const refs = inspectPublicationRefs(context.repository, context.reservedEntry, claim);
  if (refs.state === "missing") assertNoPreexistingTargets(context);
  if (refs.state === "partial") throw new Error("checkpoint publication has partial claim/branch refs");

  const remoteMain = observeCanonicalRemoteMain(context.repository, options);
  let createdRefs = false;
  if (refs.state === "missing") {
    if (remoteMain.oid !== claim.base_commit) {
      throw new Error("checkpoint publication base_commit is not freshly observed canonical remote main");
    }
    const hook = options.beforeRefTransaction;
    if (typeof hook === "function") hook({ ...remoteMain, claim: clone(claim), reservedEntry: clone(context.reservedEntry) });
    assertRemoteStillAdvertises(context.repository, remoteMain, options);
    const transaction = createTwoRefsAtomicallyNoReplace(
      context.repository,
      { ref: remoteMain.localRef, oid: remoteMain.oid },
      { ref: context.reservedEntry.publication_claim_ref, oid: context.reservedEntry.publication_claim_oid },
      { ref: claim.branch_ref, oid: claim.base_commit },
      gitOptions(options),
    );
    if (!transaction.ok) throw new Error(`checkpoint publication ref transaction failed without replacement: ${gitFailure(transaction)}`);
    createdRefs = true;
  }

  assertExactPublicationRefs(context.repository, context.reservedEntry, claim, options);
  const worktree = reconcileWorktree(context, claim, options);
  const targetExists = existsSync(context.childRunDir);
  if (targetExists) {
    assertExactPublishedChild(context.childRunDir, expected);
    assertPublicationRuntimeIdentity(context, claim, childRun, options);
    return publicationResult(context, claim, childRun, checkpointSource, expected, {
      createdRefs,
      replayed: true,
      worktreeRecovered: worktree.recovered,
    });
  }

  const stageContainer = resolve(dirname(context.factoryRoot), `.checkpoint-publication-stage-${basename(context.childRunDir)}-${randomUUID()}`);
  const stagingRoot = resolve(stageContainer, basename(context.childRunDir));
  const publicationLockRoot = resolve(dirname(context.factoryRoot), `.checkpoint-publication-${createHash("sha256").update(context.reservedEntry.root_child_run_id).digest("hex")}`);
  let replayedDuringPublish = false;
  try {
    mkdirSync(stageContainer, { mode: 0o700 });
    mkdirSync(stagingRoot, { mode: 0o700 });
    writePublicationFiles(stagingRoot, expected);
    assertValidStagedChild(stagingRoot, expected);
    if (typeof options.beforeChildPublish === "function") {
      options.beforeChildPublish({ stagingRoot, targetRunDir: context.childRunDir, claim: clone(claim), run: clone(childRun) });
    }
    mkdirSync(publicationLockRoot, { recursive: true, mode: 0o700 });
    assertRealDirectory(publicationLockRoot, "checkpoint publication lock root");
    await withRunJsonLock(publicationLockRoot, async () => {
      assertExactPublicationRefs(context.repository, context.reservedEntry, claim, options);
      assertExactCleanWorktree(context, claim, options);
      assertValidStagedChild(stagingRoot, expected);
      if (existsSync(context.childRunDir)) {
        assertExactPublishedChild(context.childRunDir, expected);
        replayedDuringPublish = true;
        return;
      }
      if (typeof options.afterChildTargetObservation === "function") {
        options.afterChildTargetObservation({ stagingRoot, targetRunDir: context.childRunDir, claim: clone(claim), run: clone(childRun) });
      }
      assertExactPublicationRefs(context.repository, context.reservedEntry, claim, options);
      assertExactCleanWorktree(context, claim, options);
      assertValidStagedChild(stagingRoot, expected);
      if (existsSync(context.childRunDir)) {
        assertExactPublishedChild(context.childRunDir, expected);
        replayedDuringPublish = true;
        return;
      }
      // The child-specific lock serializes compliant publishers. This move is
      // not a filesystem-global exclusion mechanism against hostile processes.
      moveDirectoryUnderPublicationLock(stagingRoot, context.childRunDir, options);
    }, options.publicationLockOptions || {});
  } finally {
    if (existsSync(stageContainer)) rmSync(stageContainer, { recursive: true, force: true });
  }

  assertExactPublishedChild(context.childRunDir, expected);
  assertPublicationRuntimeIdentity(context, claim, childRun, options);
  return publicationResult(context, claim, childRun, checkpointSource, expected, {
    createdRefs,
    replayed: replayedDuringPublish,
    worktreeRecovered: worktree.recovered,
  });
}

function normalizeContext(input) {
  if (!isRecord(input)) throw new Error("checkpoint publication input must be an object");
  const repository = requireAbsolute(input.repository, "repository");
  const parentRunDir = requireAbsolute(input.parentRunDir, "parentRunDir");
  const childRunDir = requireAbsolute(input.childRunDir, "childRunDir");
  const factoryRoot = resolve(repository, ".opencode", "factory");
  if (dirname(parentRunDir) !== factoryRoot || dirname(childRunDir) !== factoryRoot || parentRunDir === childRunDir) {
    throw new Error("checkpoint publication parent and child run paths must be distinct direct factory children");
  }
  assertRealDirectory(repository, "repository");
  assertRealDirectory(factoryRoot, "factory root");
  assertRealDirectory(parentRunDir, "parent run directory");
  if (existsSync(childRunDir)) assertRealDirectory(childRunDir, "child run directory");

  const reservedEntry = clone(input.reservedEntry);
  if (!isRecord(reservedEntry) || reservedEntry.state !== "reserved") throw new Error("checkpoint publication requires a checked reserved progress entry");
  validateCheckpointConfiguration(reservedEntry.configuration);
  const manifest = clone(input.manifest);
  const manifestCheckpoint = clone(input.manifestCheckpoint);
  if (!isRecord(manifest) || manifest.kind !== "delivery-checkpoint-routing-manifest" || !isRecord(manifest.source)) {
    throw new Error("checkpoint publication requires a reviewed routing manifest");
  }
  if (!isRecord(manifestCheckpoint) || manifestCheckpoint.id !== reservedEntry.checkpoint_id
    || manifestCheckpoint.ordinal !== reservedEntry.ordinal
    || !Array.isArray(manifest.checkpoints)
    || !sameJson(manifest.checkpoints[reservedEntry.ordinal - 1], manifestCheckpoint)) {
    throw new Error("checkpoint publication manifest checkpoint is missing, reordered, or cross-bound");
  }
  if (basename(childRunDir) !== reservedEntry.root_child_run_id || basename(parentRunDir) === reservedEntry.root_child_run_id) {
    throw new Error("checkpoint publication child run path does not match the reserved child id");
  }
  return { repository, parentRunDir, childRunDir, factoryRoot, reservedEntry, manifest, manifestCheckpoint };
}

function readAndValidateClaim(repository, oid, options) {
  if (!FULL_OID.test(oid ?? "")) throw new Error("checkpoint publication claim oid must be a full object id");
  const object = git(repository, ["cat-file", "blob", oid], gitOptions(options));
  if (!object.ok) throw new Error("checkpoint publication claim blob is missing or unreadable");
  const claim = parseJsonBytes(Buffer.from(object.stdout, "utf8"), "checkpoint publication claim");
  validateCheckpointChildPublication(claim);
  if (object.stdout !== canonicalJsonBytes(claim).toString("utf8")) {
    throw new Error("checkpoint publication claim blob is not canonical immutable bytes");
  }
  const computed = git(repository, ["hash-object", "--stdin"], { ...gitOptions(options), input: object.stdout });
  if (!computed.ok || computed.stdout.trim() !== oid) throw new Error("checkpoint publication claim oid does not match its serialized bytes");
  return claim;
}

function assertPublicationBindings(context, claim) {
  const entry = context.reservedEntry;
  const checkpoint = context.manifestCheckpoint;
  const digest = createHash("sha256").update(entry.root_child_run_id, "utf8").digest("hex");
  if (entry.publication_claim_ref !== `refs/opencode/checkpoint-publications/${digest}`) {
    throw new Error("checkpoint publication claim ref is not the exact child-id digest");
  }
  const expected = {
    checkpoint_id: entry.checkpoint_id,
    checkpoint_ordinal: entry.ordinal,
    child_run_id: entry.root_child_run_id,
    branch_ref: `refs/heads/${entry.branch}`,
    worktree: resolve(entry.worktree),
    base_commit: entry.base_commit,
    predecessor_checkpoint_id: entry.predecessor_checkpoint_id,
    predecessor_completed_run_id: entry.predecessor_completed_run_id,
    predecessor_merge_commit: entry.predecessor_merge_commit,
    reserved_at: entry.reserved_at,
  };
  for (const [key, value] of Object.entries(expected)) {
    const observed = key === "worktree" ? resolve(claim[key]) : claim[key];
    if (!sameJson(observed, value)) throw new Error(`checkpoint publication claim ${key} is cross-bound`);
  }
  if (claim.remote_main_ref !== REMOTE_MAIN_REF || entry.base_ref !== REMOTE_TRACKING_MAIN_REF
    || checkpoint.child_plan_hash !== entry.child_plan_hash && entry.child_plan_hash !== undefined
    || checkpoint.brief_scope_hash !== entry.brief_scope_hash && entry.brief_scope_hash !== undefined) {
    throw new Error("checkpoint publication remote-main or reviewed checkpoint binding is invalid");
  }
  const manifestPath = containedPath(context.parentRunDir, claim.manifest_ref, "routing manifest");
  const bytes = readRegularFile(manifestPath, "routing manifest");
  if (hashBytes(bytes) !== claim.manifest_hash || !sameJson(parseJsonBytes(bytes, "routing manifest"), context.manifest)) {
    throw new Error("checkpoint publication routing manifest bytes are stale");
  }
  if (claim.parent_run_id !== basename(context.parentRunDir)) throw new Error("checkpoint publication claim parent_run_id is cross-bound");
}

function assertReviewedBytes(context, planBytes, dispositionBytes) {
  const checkpoint = context.manifestCheckpoint;
  const disposition = checkpoint.child_disposition;
  if (!isRecord(disposition) || disposition.kind !== "checkpoint-child-decomposition-review"
    || disposition.verdict !== "APPROVE" || !Array.isArray(disposition.required_fixes) || disposition.required_fixes.length !== 0
    || disposition.checkpoint_id !== checkpoint.id || disposition.checkpoint_ordinal !== checkpoint.ordinal
    || disposition.child_plan_hash !== checkpoint.child_plan_hash
    || disposition.brief_scope_hash !== checkpoint.brief_scope_hash
    || disposition.acceptance_mapping_hash !== checkpoint.acceptance_mapping_hash
    || disposition.reviewed_plan_hash !== checkpoint.child_plan_hash) {
    throw new Error("checkpoint publication requires the exact approving child disposition");
  }
  if (hashBytes(planBytes) !== checkpoint.child_plan_hash) throw new Error("checkpoint publication child plan bytes do not match the reviewed hash");
  if (!sameJson(disposition.parent_review_identity, context.manifest.source.review_identity)) {
    throw new Error("checkpoint publication child disposition is cross-bound to another parent review");
  }
  const { identity_hash: identityHash, ...identityFields } = disposition.parent_review_identity;
  if (hashBytes(canonicalJsonBytes(identityFields)) !== identityHash) throw new Error("checkpoint publication parent review identity hash is stale");
  if (dispositionBytes.length === 0) throw new Error("checkpoint publication child disposition bytes are empty");
}

function buildCheckpointSource(context, claim, dispositionBytes) {
  const checkpoint = context.manifestCheckpoint;
  const source = context.manifest.source;
  return validateCheckpointSource({
    schema_version: 1,
    kind: "delivery-checkpoint-source",
    parent_run_id: claim.parent_run_id,
    manifest_ref: claim.manifest_ref,
    manifest_hash: claim.manifest_hash,
    checkpoint_id: checkpoint.id,
    checkpoint_ordinal: checkpoint.ordinal,
    root_child_run_id: claim.child_run_id,
    source_plan_ref: source.plan_ref,
    source_plan_hash: source.plan_hash,
    source_review_ref: source.decomposition_review_ref,
    source_review_hash: source.decomposition_review_hash,
    source_review_attempt: source.decomposition_attempt,
    parent_review_identity_hash: source.review_identity.identity_hash,
    child_disposition_hash: hashBytes(dispositionBytes),
    admission_probe_hash: hashBytes(canonicalJsonBytes(source.admission_probe)),
    brief_scope_hash: checkpoint.brief_scope_hash,
    child_plan_hash: checkpoint.child_plan_hash,
    acceptance_mapping_hash: checkpoint.acceptance_mapping_hash,
    initial_base_ref: REMOTE_TRACKING_MAIN_REF,
    initial_base_commit: claim.base_commit,
  });
}

function buildChildRun(context, checkpointSource, plan, planBytes, dispositionBytes) {
  const entry = context.reservedEntry;
  const configuration = entry.configuration;
  const postPrPolicy = clone(configuration.post_pr_policy);
  const run = {
    schema_version: 1,
    run_id: entry.root_child_run_id,
    mode: configuration.mode,
    status: "running",
    created_at: entry.reserved_at,
    updated_at: entry.reserved_at,
    heartbeat_at: null,
    base_ref: entry.base_ref,
    base_commit: entry.base_commit,
    branch: entry.branch,
    worktree: resolve(entry.worktree),
    github_account: configuration.github_account,
    pr_mode: configuration.pr_mode,
    pr_url: null,
    max_parallel_slices: configuration.max_parallel_slices,
    max_retries: configuration.max_retries,
    ...(configuration.review_tier === null ? {} : { review_tier: configuration.review_tier }),
    checkpoint_source: clone(checkpointSource),
    steering: {
      schema_version: 1,
      generation: 0,
      pending: null,
      uncheckpointed: null,
      boundary: null,
      action_claim: null,
      last_action: null,
      pr_fence: null,
      history: [],
    },
    post_pr: {
      schema_version: 1,
      policy: postPrPolicy,
      phase: postPrPolicy.enabled ? "awaiting-pr" : "disabled",
      attempt: 0,
      observation: null,
      remediation: null,
      evidence_refs: [],
      continuation_review: null,
      terminal_fact: null,
      pr_operation: null,
    },
    gates: {},
    slices: plan.slices.map((slice) => ({
      id: slice.id,
      stack: slice.stack,
      depends_on: clone(slice.depends_on),
      declared_paths: clone(slice.paths),
      effective_paths: clone(slice.paths),
      status: "pending",
      attempts: 0,
    })),
    steps: [{
      agent: "work-decomposer",
      status: "accepted",
      attempts: context.manifestCheckpoint.child_disposition.attempt,
      artifact_ref: PLAN_REF,
      review_ref: REVIEW_REF,
      acceptance: {
        artifact_ref: PLAN_REF,
        artifact_hash: hashBytes(planBytes),
        review_ref: REVIEW_REF,
        review_hash: hashBytes(dispositionBytes),
      },
    }, {
      agent: "test-verifier",
      status: "blocked",
      attempts: 0,
    }],
    validator: null,
    security_review: null,
    terminal_result: null,
  };
  return validateRun(run);
}

function observeCanonicalRemoteMain(repository, options) {
  const localRef = REMOTE_TRACKING_MAIN_REF;
  const fetched = git(repository, [
    "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--refmap=", "--force",
    "origin", `+${REMOTE_MAIN_REF}:${localRef}`,
  ], gitOptions(options));
  if (!fetched.ok) throw new Error(`checkpoint publication could not fetch canonical remote main: ${gitFailure(fetched)}`);
  const local = resolveRef(repository, localRef, "canonical remote main", options);
  const advertised = exactAdvertisedRef(repository, REMOTE_MAIN_REF, options);
  if (advertised !== local) throw new Error("checkpoint publication canonical remote main changed during fresh observation");
  return { ref: REMOTE_MAIN_REF, localRef, oid: local };
}

function assertRemoteStillAdvertises(repository, observed, options) {
  const advertised = exactAdvertisedRef(repository, observed.ref, options);
  if (advertised !== observed.oid) throw new Error("checkpoint publication canonical remote main moved before ref transaction");
}

function exactAdvertisedRef(repository, ref, options) {
  const result = git(repository, ["ls-remote", "--exit-code", "--refs", "origin", ref], gitOptions(options));
  const lines = result.ok ? result.stdout.trimEnd().split("\n").filter(Boolean) : [];
  const match = lines.length === 1 ? /^([0-9a-f]{40})\t([^\t\r\n]+)$/u.exec(lines[0]) : null;
  if (!match || match[2] !== ref) throw new Error("checkpoint publication canonical remote main advertisement is ambiguous");
  return match[1];
}

function inspectPublicationRefs(repository, entry, claim) {
  const claimRef = tryResolveRef(repository, entry.publication_claim_ref);
  const branchRef = tryResolveRef(repository, claim.branch_ref, true);
  if (claimRef === null && branchRef === null) return { state: "missing" };
  if (claimRef === null || branchRef === null) return { state: "partial" };
  if (claimRef !== entry.publication_claim_oid) throw new Error("checkpoint publication claim ref contains a mismatched claim");
  if (branchRef !== claim.base_commit) throw new Error("checkpoint publication child branch is not the exact reserved base");
  return { state: "exact" };
}

function assertExactPublicationRefs(repository, entry, claim, options) {
  const claimOid = resolveRef(repository, entry.publication_claim_ref, "publication claim ref", options);
  const branchOid = resolveRef(repository, claim.branch_ref, "publication child branch", options, true);
  if (claimOid !== entry.publication_claim_oid) throw new Error("checkpoint publication claim ref changed or is mismatched");
  if (branchOid !== claim.base_commit) throw new Error("checkpoint publication child branch changed or is mismatched");
}

function reconcileWorktree(context, claim, options) {
  if (resolve(claim.worktree) !== resolve(context.reservedEntry.worktree)) throw new Error("checkpoint publication worktree is cross-bound");
  const prepared = createOrRecoverWorktree(context.repository, claim.worktree, {
    branch: context.reservedEntry.branch,
    head: claim.base_commit,
    claim: context.reservedEntry.publication_claim_oid,
  }, worktreeOptions(options));
  assertExactCleanWorktree(context, claim, options);
  return prepared;
}

function assertExactCleanWorktree(context, claim, options) {
  const identity = checkWorktreeIdentity(context.repository, claim.worktree, {
    branch: context.reservedEntry.branch,
    head: claim.base_commit,
  }, gitOptions(options));
  if (!identity.ok) throw new Error(`checkpoint publication worktree is wrong: ${identity.reason}`);
  const head = resolveRef(claim.worktree, "HEAD", "publication worktree HEAD", options, true);
  if (head !== claim.base_commit) throw new Error("checkpoint publication worktree HEAD is not the exact reserved base");
  const status = git(claim.worktree, ["status", "--porcelain=v1", "--untracked-files=all"], gitOptions(options));
  if (!status.ok || status.stdout !== "") throw new Error("checkpoint publication worktree must be clean");
}

function assertNoPreexistingTargets(context) {
  if (existsSync(context.childRunDir)) throw new Error("checkpoint publication child exists without its creation claim");
  if (existsSync(context.reservedEntry.worktree)) throw new Error("checkpoint publication worktree exists without its creation claim");
}

function expectedPublicationBytes(run, planBytes, dispositionBytes) {
  return new Map([
    ["run.json", canonicalJsonBytes(run)],
    [PLAN_REF, Buffer.from(planBytes)],
    [REVIEW_REF, Buffer.from(dispositionBytes)],
  ]);
}

function writePublicationFiles(root, expected) {
  for (const [ref, bytes] of expected) {
    const destination = containedPath(root, ref, "staged child file");
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  }
}

function assertValidStagedChild(root, expected) {
  assertExactPublishedChild(root, expected);
  const validation = validateRunDir(root);
  if (!validation.ok) {
    const failures = validation.checks.filter((check) => !check.ok).map((check) => `${check.name || check.path || "check"}: ${check.error || "failed"}`);
    throw new Error(`staged checkpoint child is invalid: ${failures.join("; ")}`);
  }
}

function assertExactPublishedChild(root, expected) {
  assertRealDirectory(root, "published checkpoint child");
  const observed = listRegularFiles(root);
  if (!sameJson(observed, EXPECTED_CHILD_FILES)) throw new Error("checkpoint publication child is partial or contains mismatched files");
  for (const [ref, bytes] of expected) {
    const observedBytes = readRegularFile(containedPath(root, ref, "published child file"), `published child '${ref}'`);
    if (!observedBytes.equals(bytes)) throw new Error(`checkpoint publication child file is mismatched: ${ref}`);
  }
  const validation = validateRunDir(root);
  if (!validation.ok) throw new Error("checkpoint publication child directory is not a valid complete run");
}

function assertPublicationRuntimeIdentity(context, claim, childRun, options) {
  assertExactPublicationRefs(context.repository, context.reservedEntry, claim, options);
  assertExactCleanWorktree(context, claim, options);
  const observed = parseJsonBytes(readRegularFile(resolve(context.childRunDir, "run.json"), "published run.json"), "published run.json");
  if (!sameJson(observed, childRun) || observed.checkpoint !== undefined || observed.continuation !== undefined) {
    throw new Error("checkpoint publication child is not the exact ordinary normal run");
  }
}

function moveDirectoryUnderPublicationLock(stagingRoot, targetRunDir, options) {
  if (basename(stagingRoot) !== basename(targetRunDir)) throw new Error("checkpoint publication staging identity differs from target");
  const spawn = typeof options.publicationMoveSpawnSync === "function" ? options.publicationMoveSpawnSync : defaultSpawnSync;
  const result = spawn("mv", ["-n", "--", stagingRoot, dirname(targetRunDir)], { encoding: "utf8", shell: false });
  if (result?.error || result?.status !== 0 || existsSync(stagingRoot) || !existsSync(targetRunDir)) {
    throw new Error("checkpoint child serialized no-overwrite directory publication failed");
  }
}

function publicationResult(context, claim, run, checkpointSource, expected, state) {
  return {
    published: true,
    replayed: state.replayed,
    created_refs: state.createdRefs,
    worktree_recovered: state.worktreeRecovered,
    claim_ref: context.reservedEntry.publication_claim_ref,
    claim_oid: context.reservedEntry.publication_claim_oid,
    branch_ref: claim.branch_ref,
    base_commit: claim.base_commit,
    worktree: resolve(claim.worktree),
    run_dir: context.childRunDir,
    run: clone(run),
    checkpoint_source: clone(checkpointSource),
    child_run_hash: hashBytes(expected.get("run.json")),
    child_plan_hash: hashBytes(expected.get(PLAN_REF)),
    brief_scope_hash: context.manifestCheckpoint.brief_scope_hash,
    acceptance_mapping_hash: context.manifestCheckpoint.acceptance_mapping_hash,
  };
}

function listRegularFiles(root, current = root, result = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = resolve(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error("checkpoint publication child contains a symlink");
    if (entry.isDirectory()) listRegularFiles(root, path, result);
    else if (entry.isFile()) result.push(relative(root, path).split("\\").join("/"));
    else throw new Error("checkpoint publication child contains a non-regular entry");
  }
  return result.sort();
}

function readRegularFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing`);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`${label} must be a regular file`);
  return readFileSync(path);
}

function assertRealDirectory(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${label} must be a real directory: ${path}`);
}

function containedPath(root, ref, label) {
  if (typeof ref !== "string" || ref === "" || isAbsolute(ref)) throw new Error(`${label} ref must be relative`);
  const path = resolve(root, ref);
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes its run directory`);
  }
  return path;
}

function resolveRef(repository, ref, label, options, commit = false) {
  const value = tryResolveRef(repository, ref, commit, options);
  if (value === null) throw new Error(`${label} is missing`);
  return value;
}

function tryResolveRef(repository, ref, commit = false, options = {}) {
  const suffix = commit ? "^{commit}" : "";
  const result = git(repository, ["rev-parse", "--verify", `${ref}${suffix}`], gitOptions(options));
  const oid = result.stdout.trim();
  return result.ok && FULL_OID.test(oid) ? oid : null;
}

function worktreeOptions(options) {
  return {
    ...gitOptions(options),
    ...(typeof options.beforeWorktreeAdd === "function" ? { beforeAdd: options.beforeWorktreeAdd } : {}),
  };
}

function gitOptions(options) {
  return isRecord(options.gitOptions) ? options.gitOptions : {};
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalClone(value), null, 2)}\n`, "utf8");
}

function canonicalClone(value) {
  if (Array.isArray(value)) return value.map(canonicalClone);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalClone(value[key])]));
}

function hashBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sameJson(left, right) {
  return JSON.stringify(canonicalClone(left)) === JSON.stringify(canonicalClone(right));
}

function clone(value) {
  return structuredClone(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return resolve(value);
}

function gitFailure(result) {
  return String(result?.stderr || result?.stdout || "unknown git error").trim();
}
