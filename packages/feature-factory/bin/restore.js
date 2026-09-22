// False-green enforcement throughout: restore publishes preserved approvals and merged claims only after
// the snapshot, pushed ref, Git bindings, copy, destination, and final manifest commit are re-observed.
// Active work without those proofs is reset and reported instead of being presented as recovered.
import { constants, chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative as relativePath, resolve, sep } from "node:path";
import { CONTROL_PLANE, validateRun } from "../state/schema.js";
import { git, observeWorktree, privilegedPaths, proveInitContainment, unownedPaths } from "../observe/index.js";
import { isApproving, observeMergeProof, readEvidence, readReview } from "../observe/review.js";
import { capturePushTarget, enforceEffectivePushTarget } from "../core/effective-push.js";
import { writeProtectedJsonAtomic } from "../core/atomic-write.js";

const ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const SHA = /^[0-9a-f]{40}$/u;
const RESTORE_REF = "restore.json";
const REVIEWED_STEPS = new Set(["spec-writer", "work-decomposer"]);
const SKIPPED_ENTRIES = new Set(["factory.lock", "run.json", "evidence/test-verifier.json", "reviews/test-verifier.json"]);

class RestoreError extends Error { constructor(message, options) { super(message, options); this.name = "RestoreError"; } }

function exactDirectory(path, description) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { throw new RestoreError(`${description} '${path}' is not observable`, { cause: error }); }
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(path) !== path) throw new RestoreError(`${description} '${path}' is not an exact canonical directory`);
}

export function entryState(path) { try { return lstatSync(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }

export function inventoryEntries(root, skipped = new Set()) {
  const entries = [];
  const visit = (relative, full) => {
    if (skipped.has(relative)) return;
    const stat = lstatSync(full), mode = (stat.mode & 0o7777).toString(8);
    if (stat.isSymbolicLink()) entries.push(`${relative} l ${mode} ${readlinkSync(full)}`);
    else if (stat.isDirectory()) {
      entries.push(`${relative} d ${mode}`);
      for (const name of readdirSync(full)) visit(relative === "." ? name : `${relative}/${name}`, join(full, name));
    } else if (stat.isFile()) entries.push(`${relative} f ${mode} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    else throw new RestoreError(`park snapshot contains unsupported entry type at '${full}'`);
  };
  visit(".", root);
  return entries.sort();
}
export const inventory = (root, skipped = new Set()) => JSON.stringify(inventoryEntries(root, skipped));

export function copySnapshot(source, target, skipped = SKIPPED_ENTRIES) {
  const copy = (relative, from, to) => {
    if (skipped.has(relative)) return;
    const stat = lstatSync(from), mode = stat.mode & 0o7777, present = entryState(to);
    if (stat.isDirectory()) {
      if (present && (present.isSymbolicLink() || !present.isDirectory())) throw new RestoreError(`restore target '${to}' has an unsafe type`);
      if (!present) mkdirSync(to);
      for (const name of readdirSync(from)) copy(relative === "." ? name : `${relative}/${name}`, join(from, name), join(to, name));
      chmodSync(to, mode);
    } else if (present) throw new RestoreError(`restore target '${to}' already exists`);
    else if (stat.isSymbolicLink()) {
      const link = readlinkSync(from), lexical = relativePath(source, resolve(dirname(from), link));
      let referent;
      try { referent = relativePath(source, realpathSync(from)); } catch { throw new RestoreError(`park snapshot symlink '${from}' has an unprovable referent`); }
      if (isAbsolute(link) || [lexical, referent].some((path) => path === ".." || path.startsWith(`..${sep}`) || path.startsWith(sep))) throw new RestoreError(`park snapshot symlink '${from}' escapes the control plane`);
      symlinkSync(link, to);
    } else if (stat.isFile()) { copyFileSync(from, to, constants.COPYFILE_EXCL); chmodSync(to, mode); }
    else throw new RestoreError(`park snapshot contains unsupported entry type at '${from}'`);
  };
  copy(".", source, target);
}

function exactOid(repository, ref) {
  const result = git(repository, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  return result.status === 0 && /^[0-9a-f]{40}\n$/u.test(result.stdout) ? result.stdout.slice(0, -1) : null;
}

function assertCommit(repository, sha, description, head) {
  if (!SHA.test(String(sha)) || exactOid(repository, sha) !== sha) throw new RestoreError(`${description} '${sha}' does not resolve in the restored repository`);
  const ancestry = git(repository, ["merge-base", "--is-ancestor", sha, head]);
  if (ancestry.status !== 0) throw new RestoreError(`${description} '${sha}' is not an ancestor of restored feature head '${head}'`);
}

function assertRegularRecord(runDir, ref, description) {
  const path = resolve(runDir, ref), rel = relativePath(runDir, path), stat = entryState(path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)
    || !stat?.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new RestoreError(`${description} '${ref}' must be a contained regular file in the park snapshot`);
  }
}

function jsonAt(runDir, ref, description) {
  assertRegularRecord(runDir, ref, description);
  try { return JSON.parse(readFileSync(join(runDir, ref), "utf8")); } catch (error) { throw new RestoreError(`${description} '${ref}' could not be read`, { cause: error }); }
}

function safeReview(runDir, ref) { assertRegularRecord(runDir, ref, "review"); return readReview(runDir, ref); }
function safeEvidence(runDir, ref, runId) { assertRegularRecord(runDir, ref, "evidence"); return readEvidence(runDir, ref, { runId }); }

function transformRun(source, at, head, worktree, sourceRunDir) {
  const resetSlices = [];
  const slices = source.slices.map((slice) => {
    if (["merged", "blocked"].includes(slice.status)) return slice.status === "merged" ? { ...slice, worktree: null } : { ...slice, worktree: null, branch: null, evidence_ref: null, review_ref: null, merge_commit: null };
    if (slice.status !== "pending" || [slice.worktree, slice.branch, slice.base_ref, slice.evidence_ref, slice.review_ref, slice.merge_commit].some((value) => value !== null)) resetSlices.push(slice.id);
    return { ...slice, status: "pending", worktree: null, branch: null, base_ref: null, evidence_ref: null, review_ref: null, merge_commit: null };
  });
  const invalidated = [];
  const verifierState = source.steps.some((step) => step.agent === "test-verifier" && (step.status === "accepted" || step.review_ref || step.evidence_ref))
    || ["evidence/test-verifier.json", "reviews/test-verifier.json"].some((ref) => entryState(join(sourceRunDir, ref)));
  const gates = structuredClone(source.gates);
  if (gates.pre_pr?.status === "approved") {
    gates.pre_pr = { ...gates.pre_pr, status: "pending", at: null, reviewed_head: null };
    invalidated.push("gate:pre_pr");
  }
  let validator = source.validator;
  if (validator && validator.reviewed_head !== head) { validator = null; invalidated.push("validator"); }
  if (verifierState) invalidated.push("step:test-verifier");
  const steps = source.steps.map((step) => step.agent !== "test-verifier" ? step : {
    ...step, status: step.status === "accepted" ? "running" : step.status, review_ref: null, evidence_ref: null,
  });
  return { run: validateRun({ ...source, worktree, updated_at: at, slices, gates, steps, validator }), resetSlices, invalidated };
}

function assertPlanBinding(runDir, run) {
  if (run.slices.length === 0 && !run.plan_digest) return; assertRegularRecord(runDir, "plan/slices.json", "ratified slice plan");
  const bytes = readFileSync(join(runDir, "plan/slices.json")), plan = JSON.parse(bytes);
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== run.plan_digest) throw new RestoreError("restored slice plan does not match the Brief-approved digest"); if (run.slices.length === 0) return;
  const project = (slice) => ({ id: slice.id, stack: slice.stack, depends_on: slice.depends_on ?? [], paths: slice.paths, test_plan: slice.test_plan });
  const ratified = Array.isArray(plan.slices) && plan.slices.length === run.slices.length && plan.slices.map((slice, index) => project({ ...slice, paths: [...slice.paths, ...(run.slices[index].path_amendments ?? []).flatMap((item) => item.added_paths)] }));
  if (!ratified || JSON.stringify(ratified) !== JSON.stringify(run.slices.map(project))) throw new RestoreError("restored slices do not match the Brief-ratified plan and amendments");
}

function assertPreservedBindings(sourceRunDir, run, repository, head) {
  for (const slice of run.slices.filter((entry) => entry.status === "merged")) {
    assertCommit(repository, slice.base_ref, `slice '${slice.id}' base_ref`, head);
    assertCommit(repository, slice.merge_commit, `slice '${slice.id}' merge_commit`, head);
    const review = safeReview(sourceRunDir, slice.review_ref);
    const evidence = safeEvidence(sourceRunDir, slice.evidence_ref, run.run_id);
    if (review.subject !== slice.id || review.attempt !== slice.attempts || !isApproving(review.verdict)) throw new RestoreError(`slice '${slice.id}' review does not approve its restored attempt`);
    if (evidence.subject !== slice.id || evidence.attempt !== slice.attempts || evidence.review_ready !== true
      || evidence.base_ref !== slice.base_ref || evidence.commit !== review.reviewed_commit) {
      throw new RestoreError(`slice '${slice.id}' evidence does not bind its restored base, attempt, and approved commit`);
    }
    for (const [name, sha] of [["reviewed_commit", review.reviewed_commit], ["evidence base_ref", evidence.base_ref], ["evidence commit", evidence.commit]]) assertCommit(repository, sha, `slice '${slice.id}' ${name}`, head);
    if (git(repository, ["merge-base", "--is-ancestor", slice.base_ref, review.reviewed_commit]).status !== 0) throw new RestoreError(`slice '${slice.id}' base is not an ancestor of its reviewed commit`);
    const observed = observeWorktree(repository, slice.base_ref, { ref: review.reviewed_commit }), files = [...observed.files_changed].sort();
    if (!observed.diff_observed || files.length === 0 || JSON.stringify(files) !== JSON.stringify([...evidence.files_changed].sort()) || unownedPaths(files, slice.paths).length || privilegedPaths(files).length) throw new RestoreError(`slice '${slice.id}' restored diff violates its evidence or ratified path ownership`);
    const tests = evidence.tests, skip = `test_plan for '${slice.id}' was approved empty at slices-seed`;
    if (slice.test_plan.length ? !(tests?.observed === true && tests.exit === 0 && slice.test_plan.includes(tests.cmd))
      : !(tests?.observed === false && tests.exit === null && tests.skipped_reason === skip)) throw new RestoreError(`slice '${slice.id}' evidence does not satisfy its ratified test_plan`);
    const proof = observeMergeProof(repository, { baseRef: slice.base_ref, reviewedCommit: review.reviewed_commit, mergeCommit: slice.merge_commit });
    if (!proof.proven) throw new RestoreError(`slice '${slice.id}' merge proof failed after restore: ${proof.reason}`);
  }
  for (const step of run.steps.filter((entry) => entry.status === "accepted" && REVIEWED_STEPS.has(entry.agent))) {
    if (!step.review_ref) throw new RestoreError(`accepted step '${step.agent}' has no review binding`);
    const review = safeReview(sourceRunDir, step.review_ref);
    if (review.subject !== step.agent || review.attempt !== step.attempts || !isApproving(review.verdict)) throw new RestoreError(`step '${step.agent}' review does not approve its restored attempt`);
  }
  for (const [name, gate] of Object.entries(run.gates)) if (gate.reviewed_head) assertCommit(repository, gate.reviewed_head, `gate '${name}' reviewed_head`, head);
  if (run.validator) {
    assertCommit(repository, run.validator.reviewed_head, "validator reviewed_head", head);
    const review = safeReview(sourceRunDir, "reviews/implementation-validator.json");
    if (review.subject !== "implementation-validator" || review.reviewed_commit !== head || review.verdict !== run.validator.verdict) throw new RestoreError("validator review does not bind the restored verdict and feature head");
  }
}

function restoredWorktree(recorded, runId) {
  if (!isAbsolute(recorded)) return recorded;
  const marker = `${sep}.factory-sandboxes${sep}${runId}`, at = resolve(recorded).lastIndexOf(marker);
  if (at < 0) throw new RestoreError(`snapshot integration worktree '${recorded}' does not identify run '${runId}'`);
  const suffix = resolve(recorded).slice(at + marker.length);
  if (suffix !== "" && !suffix.startsWith(sep)) throw new RestoreError(`snapshot integration worktree '${recorded}' cannot be rebound`);
  return suffix === "" ? "." : suffix.slice(1);
}

function qualifySource(operatorRoot, runId) {
  const factory = join(operatorRoot, CONTROL_PLANE), parked = join(factory, ".parked"), source = join(parked, runId);
  for (const [path, description] of [[factory, "operator control plane"], [parked, "park snapshot container"], [source, "park snapshot"]]) exactDirectory(path, description);
  const manifest = join(source, "run.json"), stat = entryState(manifest);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new RestoreError(`park snapshot manifest '${manifest}' is not a regular file`);
  const bytes = readFileSync(manifest), run = validateRun(JSON.parse(bytes.toString("utf8")));
  if (run.run_id !== runId) throw new RestoreError(`park snapshot run_id '${run.run_id}' does not match requested '${runId}'`);
  if (run.status !== "needs-human") throw new RestoreError(`factory restore requires a needs-human snapshot; found '${run.status}'`);
  const entries = inventoryEntries(source), skipped = [...SKIPPED_ENTRIES];
  return { source, bytes, run, inventory: JSON.stringify(entries),
    copied: JSON.stringify(entries.filter((entry) => !skipped.some((name) => entry.startsWith(`${name} `) || entry.startsWith(`${name}/`)))) };
}

function validateFeatureRef(repository, ref, branch) {
  const listed = git(repository, ["remote"]);
  const remotes = listed.status === 0 ? listed.stdout.split("\n").filter((name) => ref === `refs/remotes/${name}/${branch}`) : [];
  const remote = remotes.length === 1 ? remotes[0] : null;
  if (!remote) throw new RestoreError(`--from must name exact branch '${branch}' under one configured remote`);
  const state = git(repository, ["show-ref", "--verify", "--quiet", ref]);
  if (state.status !== 0) throw new RestoreError(`restore feature ref '${ref}' is absent or unobservable in operator repository '${repository}'`);
  const head = exactOid(repository, ref);
  if (!head) throw new RestoreError(`restore feature ref '${ref}' does not peel to one commit`);
  const sourcePush = capturePushTarget(repository, remote), effectivePush = capturePushTarget(repository);
  if (!sourcePush || !effectivePush || !sourcePush.equals(effectivePush) || !Buffer.from(sourcePush.toString("utf8"), "utf8").equals(sourcePush)) throw new RestoreError(`restore remote '${remote}' is not the operator's effective push endpoint`);
  const endpoint = sourcePush.toString("utf8");
  const remoteRef = `refs/heads/${branch}`, advertised = git(repository, ["ls-remote", "--exit-code", "--refs", endpoint, remoteRef]);
  if (advertised.status !== 0 || advertised.stdout !== `${head}\t${remoteRef}\n`) throw new RestoreError(`restore feature ref '${ref}' does not match branch '${branch}' as advertised by remote '${remote}'`);
  return head;
}

// False-green enforcement: local excludes do not survive the clone, so only the tracked root policy may
// prove that restored control-plane state stays outside the repository diff and cleanliness checks.
function assertIgnored(repository, runId, probes = [`.factory-sandboxes/${runId}/.factory/${runId}/run.json`, `${CONTROL_PLANE}/${runId}/run.json`]) {
  const rootIgnore = join(repository, ".gitignore");
  const tracked = git(repository, ["ls-files", "--error-unmatch", "--", ".gitignore"]);
  for (const probe of probes) {
    const observed = git(repository, ["check-ignore", "-v", "--no-index", "--", probe]);
    const match = /^(.+):([1-9][0-9]*):(.+)\t(.+)\n$/u.exec(observed.status === 0 ? observed.stdout : "");
    if (tracked.status !== 0 || tracked.stdout !== ".gitignore\n" || match?.[3].startsWith("!") || match?.[4] !== probe || resolve(repository, match?.[1] ?? "") !== rootIgnore) {
      throw new RestoreError(`factory restore requires '${probe}' to be ignored by tracked root '.gitignore'`);
    }
  }
}

function assertRestoreBinding({ operatorRoot, sandbox, runId, branch, worktree, featureRef, head, source }) {
  for (const [path, description] of [[join(operatorRoot, CONTROL_PLANE), "operator control plane"], [join(operatorRoot, CONTROL_PLANE, ".parked"), "park snapshot container"], [source, "park snapshot"], [join(operatorRoot, ".factory-sandboxes"), "sandbox container"], [sandbox, "restore sandbox"]]) exactDirectory(path, description);
  if (validateFeatureRef(operatorRoot, featureRef, branch) !== head) throw new RestoreError(`restore feature ref '${featureRef}' moved while restore was running`);
  const symbolic = git(sandbox, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (symbolic.status !== 0 || symbolic.stdout !== `${branch}\n` || exactOid(sandbox, "HEAD") !== head) throw new RestoreError(`restored feature branch '${branch}' moved while restore was running`);
  const cleanliness = git(sandbox, ["status", "--porcelain", "--untracked-files=normal"]);
  if (cleanliness.status !== 0 || cleanliness.stdout !== "") throw new RestoreError("restored feature worktree changed while restore was running");
  enforceEffectivePushTarget(["check", operatorRoot, sandbox]);
  assertIgnored(operatorRoot, runId);
  assertIgnored(sandbox, runId, [`${CONTROL_PLANE}/${runId}/run.json`]);
  proveInitContainment({ operatorRoot, sandboxPath: sandbox, runId, worktree });
}

export async function dispatchRestore(positional, flags, operations = {}) {
  if (positional.length !== 1 || !ID.test(positional[0])) throw new RestoreError("factory restore requires exactly one valid <run-id>");
  if (flags.repo !== undefined && (typeof flags.repo !== "string" || !flags.repo.trim())) throw new RestoreError("--repo must be a non-empty string");
  if (!flags.from) throw new RestoreError("factory restore requires --from <full-remote-tracking-ref>");
  const runId = positional[0], operatorInput = resolve(flags.repo ?? process.cwd()), operatorRoot = realpathSync(operatorInput);
  exactDirectory(operatorRoot, "operator repository");
  const top = git(operatorRoot, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || resolve(operatorRoot, top.stdout.trim()) !== operatorRoot) throw new RestoreError("--repo must name the canonical operator repository root");
  const qualified = qualifySource(operatorRoot, runId);
  const worktree = restoredWorktree(qualified.run.worktree, runId);
  const atMs = flags.now === undefined ? Date.now() : Date.parse(flags.now), at = Number.isFinite(atMs) ? new Date(atMs).toISOString() : null;
  if (!at) throw new RestoreError("--now must be an ISO timestamp");
  if (atMs <= Date.parse(qualified.run.updated_at)) throw new RestoreError("restore must move updated_at forwards");
  if (git(operatorRoot, ["check-ref-format", "--branch", qualified.run.branch]).status !== 0) throw new RestoreError(`snapshot branch '${qualified.run.branch}' is not a valid branch name`);
  const head = validateFeatureRef(operatorRoot, flags.from, qualified.run.branch);
  assertIgnored(operatorRoot, runId);
  const legacyManifest = join(operatorRoot, CONTROL_PLANE, runId, "run.json");
  if (entryState(legacyManifest)) throw new RestoreError(`live run manifest already exists at '${legacyManifest}'`);
  const container = join(operatorRoot, ".factory-sandboxes"), sandbox = join(container, runId);
  const containerState = entryState(container);
  if (containerState) exactDirectory(container, "sandbox container"); else mkdirSync(container);
  if (entryState(sandbox)) throw new RestoreError(`restore sandbox destination '${sandbox}' already exists`);
  mkdirSync(sandbox);
  const cloned = git(operatorRoot, ["clone", "--local", "--no-checkout", "--", operatorRoot, sandbox]);
  if (!cloned.ok) throw new RestoreError(`git clone failed for restore sandbox '${sandbox}'; sandbox was retained; run.json is absent`);
  const switched = git(sandbox, ["switch", "--no-track", "-C", qualified.run.branch, head]);
  if (!switched.ok) throw new RestoreError(`could not restore feature branch '${qualified.run.branch}' at '${head}'; sandbox was retained; run.json is absent`);
  enforceEffectivePushTarget(["bootstrap", operatorRoot, sandbox]);
  proveInitContainment({ operatorRoot, sandboxPath: sandbox, runId, worktree });
  const runDir = join(sandbox, CONTROL_PLANE, runId), transformed = transformRun(qualified.run, at, head, worktree, qualified.source);
  copySnapshot(qualified.source, runDir);
  const copiedInventory = inventory(runDir);
  if (copiedInventory !== qualified.copied) throw new RestoreError(`restored control-plane copy does not match the qualified snapshot; sandbox was retained; run.json is absent`);
  assertPlanBinding(runDir, transformed.run);
  assertPreservedBindings(runDir, transformed.run, sandbox, head);
  const previousRestore = entryState(join(runDir, RESTORE_REF)) ? readRestoreRecord(runDir, qualified.run) : null;
  const record = { version: 1, run_id: runId, restored_at: at, source_snapshot: qualified.source, source_inventory: `sha256:${createHash("sha256").update(qualified.inventory).digest("hex")}`, feature_ref: flags.from, feature_commit: head, reset_slices: transformed.resetSlices, invalidated: transformed.invalidated, previous_restore: previousRestore };
  await writeProtectedJsonAtomic(runDir, RESTORE_REF, record);
  const preparedInventory = inventory(runDir);
  // Test seam only: production supplies no hook. The final guard below must catch any intervening writer.
  if (operations.beforeManifest) await operations.beforeManifest({ runDir, sandbox });
  const finalGuard = () => {
    if (!readFileSync(join(qualified.source, "run.json")).equals(qualified.bytes) || inventory(qualified.source) !== qualified.inventory) throw new RestoreError("park snapshot changed while restore was running; run.json was not published");
    if (inventory(runDir) !== preparedInventory) throw new RestoreError("restored control plane changed before manifest publication; run.json was not published");
    if (entryState(legacyManifest)) throw new RestoreError(`live run manifest appeared at '${legacyManifest}' while restore was running`);
    assertRestoreBinding({ operatorRoot, sandbox, runId, branch: qualified.run.branch, worktree, featureRef: flags.from, head, source: qualified.source });
  };
  await writeProtectedJsonAtomic(runDir, "run.json", transformed.run, { createOnly: true, hooks: { beforeCommit: finalGuard } });
  const payload = { run_id: runId, status: transformed.run.status, sandbox_path: sandbox, run_dir: runDir, source_snapshot: qualified.source, feature_ref: flags.from, feature_commit: head, reset_slices: transformed.resetSlices, invalidated: transformed.invalidated, restore_record: join(runDir, RESTORE_REF) };
  if (flags.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`); else for (const [key, value] of Object.entries(payload)) process.stdout.write(`${key}: ${typeof value === "object" ? JSON.stringify(value) : value}\n`);
  return payload;
}

const RESTORE_KEYS = ["version", "run_id", "restored_at", "source_snapshot", "source_inventory", "feature_ref", "feature_commit", "reset_slices", "invalidated", "previous_restore"];
const INVALIDATIONS = new Set(["gate:pre_pr", "validator", "step:test-verifier"]);
function validRestoreRecord(record, runId, slices) {
  const timestamp = typeof record?.restored_at === "string" ? Date.parse(record.restored_at) : NaN;
  return record && !Array.isArray(record) && JSON.stringify(Object.keys(record).sort()) === JSON.stringify([...RESTORE_KEYS].sort())
    && record.version === 1 && record.run_id === runId && ID.test(runId) && Number.isFinite(timestamp) && new Date(timestamp).toISOString() === record.restored_at
    && typeof record.source_snapshot === "string" && isAbsolute(record.source_snapshot) && /^sha256:[0-9a-f]{64}$/u.test(record.source_inventory)
    && /^refs\/remotes\/.+\/.+$/u.test(record.feature_ref) && SHA.test(record.feature_commit)
    && Array.isArray(record.reset_slices) && new Set(record.reset_slices).size === record.reset_slices.length && record.reset_slices.every((id) => ID.test(id) && (!slices || slices.has(id)))
    && Array.isArray(record.invalidated) && new Set(record.invalidated).size === record.invalidated.length && record.invalidated.every((item) => INVALIDATIONS.has(item))
    && (record.previous_restore === null || validRestoreRecord(record.previous_restore, runId, slices));
}

export function readRestoreRecord(runDir, run = null) {
  const path = join(runDir, RESTORE_REF), stat = entryState(path);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new RestoreError(`restore record '${path}' is not a regular file`);
  const record = jsonAt(runDir, RESTORE_REF, "restore record");
  if (!validRestoreRecord(record, basename(runDir), run && new Set(run.slices.map((slice) => slice.id)))) throw new RestoreError(`restore record '${path}' is malformed`);
  return record;
}
