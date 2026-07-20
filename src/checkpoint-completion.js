import { createHash } from "node:crypto";
import { githubPrUrlParts, hashValue } from "./refs.js";
import {
  validateCheckpointConfiguration,
  validateCheckpointProgress,
  validateCheckpointSource,
  validateDeliveryCheckpointFinalClosure,
} from "./validate.js";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const OPERATION_ID = /^ffpr-v1-[0-9a-f]{64}$/u;

/**
 * Resolve all supplied snapshots into the one same-checkpoint B1 chain. The
 * observer is responsible for reading Git refs; normalized observations are
 * checked here against the exact parent, child, and continuation hashes.
 */
export async function resolveCheckpointCompletionLineage(input) {
  const snapshots = normalizeRunSnapshots(input?.runs);
  if (snapshots.length === 0) throw new Error("checkpoint lineage requires at least one run snapshot");

  const byId = new Map();
  for (const snapshot of snapshots) {
    const runId = requiredString(snapshot.run?.run_id, "checkpoint lineage run_id");
    if (byId.has(runId)) throw new Error(`checkpoint lineage has multiple snapshots for run '${runId}'`);
    byId.set(runId, snapshot);
  }

  const rootRunId = input?.rootRunId ?? uniqueRootRunId(snapshots);
  const root = byId.get(requiredString(rootRunId, "checkpoint lineage rootRunId"));
  if (!root) throw new Error(`checkpoint lineage root '${rootRunId}' is missing`);
  const source = clone(validateCheckpointSource(root.run.checkpoint_source));
  if (source.root_child_run_id !== rootRunId) throw new Error("checkpoint lineage root does not match checkpoint_source.root_child_run_id");
  if (root.run.continuation != null) throw new Error("checkpoint lineage root cannot itself be a B1 continuation");

  const configuration = clone(input?.configuration ?? configurationFromRun(root.run));
  validateCheckpointConfiguration(configuration);
  const sourceBytes = canonicalBytes(source);
  const configurationBytes = canonicalBytes(configuration);
  const children = new Map();

  // Detect graph corruption before checking edge hashes so a cycle cannot be
  // disguised as an ordinary stale-parent failure.
  assertAcyclic(byId, rootRunId);

  for (const snapshot of snapshots) {
    const run = snapshot.run;
    const runSource = validateCheckpointSource(run.checkpoint_source);
    if (!canonicalBytes(runSource).equals(sourceBytes)) {
      throw new Error(`checkpoint lineage run '${run.run_id}' has cross-checkpoint or drifted checkpoint_source bytes`);
    }
    const inheritedReviewTier = run.continuation?.configuration !== undefined
      && !Object.hasOwn(run.continuation.configuration, "review_tier") ? configuration.review_tier : undefined;
    const storedConfiguration = configurationFromRun(run, inheritedReviewTier);
    validateCheckpointConfiguration(storedConfiguration);
    if (!canonicalBytes(storedConfiguration).equals(configurationBytes)) {
      throw new Error(`checkpoint lineage run '${run.run_id}' has drifted checkpoint configuration`);
    }
    if (run.continuation?.configuration !== undefined
      && Object.hasOwn(run.continuation.configuration, "review_tier") !== Object.hasOwn(run, "review_tier")) {
      throw new Error(`checkpoint lineage run '${run.run_id}' has conflicting continuation review_tier presence`);
    }
    const continuationConfiguration = run.continuation?.configuration === undefined
      ? undefined
      : { ...clone(run.continuation.configuration), review_tier: Object.hasOwn(run, "review_tier") ? run.review_tier : inheritedReviewTier ?? null };
    if (continuationConfiguration !== undefined
      && !canonicalBytes(continuationConfiguration).equals(configurationBytes)) {
      throw new Error(`checkpoint lineage run '${run.run_id}' has conflicting continuation configuration`);
    }
    if (run.run_id === rootRunId) continue;
    const continuation = run.continuation;
    if (continuation?.schema_version !== 2 || continuation.kind !== "blocked-run-continuation") {
      throw new Error(`checkpoint lineage descendant '${run.run_id}' is not a B1 continuation`);
    }
    if (continuation.target?.run_id !== run.run_id) throw new Error(`checkpoint lineage descendant '${run.run_id}' has a conflicting continuation target`);
    const parentId = requiredString(continuation.parent?.run_id, `checkpoint lineage parent for '${run.run_id}'`);
    const parent = byId.get(parentId);
    if (!parent) throw new Error(`checkpoint lineage parent '${parentId}' for '${run.run_id}' is missing`);
    if (continuation.parent.run_hash !== parent.hash) throw new Error(`checkpoint lineage edge '${parentId}' -> '${run.run_id}' has a stale parent run hash`);
    const existing = children.get(parentId) ?? [];
    existing.push(snapshot);
    children.set(parentId, existing);
  }

  for (const [parentId, descendants] of children) {
    if (descendants.length !== 1) throw new Error(`checkpoint lineage parent '${parentId}' has multiple conflicting descendants`);
  }

  const ordered = [];
  const visited = new Set();
  let current = root;
  while (current) {
    if (visited.has(current.run.run_id)) throw new Error("checkpoint lineage is cyclic");
    visited.add(current.run.run_id);
    ordered.push(current);
    current = children.get(current.run.run_id)?.[0] ?? null;
  }
  if (visited.size !== snapshots.length) throw new Error("checkpoint lineage contains a missing, cyclic, or conflicting descendant chain");

  const lineage = [];
  for (const [index, snapshot] of ordered.entries()) {
    if (index === 0) {
      lineage.push({ run_id: snapshot.run.run_id, run_hash: snapshot.hash, parent_run_id: null, continuation_claim_ref: null, continuation_claim_oid: null });
      continue;
    }
    const parent = ordered[index - 1];
    const observation = await observeContinuationClaim(input?.observeContinuationClaim, parent, snapshot);
    lineage.push({
      run_id: snapshot.run.run_id,
      run_hash: snapshot.hash,
      parent_run_id: parent.run.run_id,
      continuation_claim_ref: observation.ref,
      continuation_claim_oid: observation.oid,
    });
  }

  return {
    root_child_run_id: rootRunId,
    completed_child_run_id: ordered.at(-1).run.run_id,
    completed_child_run_hash: ordered.at(-1).hash,
    completed_run: clone(ordered.at(-1).run),
    checkpoint_source: source,
    checkpoint_source_hash: hashValue(source),
    configuration,
    configuration_hash: hashValue(configuration),
    lineage,
  };
}

export async function buildCheckpointMergedCompletion(input) {
  const prior = clone(input?.entry);
  if (!isRecord(prior) || !["launched", "merged"].includes(prior.state)) {
    throw new Error("checkpoint merged completion requires a launched or merged progress entry");
  }
  const resolved = await resolveCheckpointCompletionLineage({
    runs: input.runs,
    rootRunId: prior.root_child_run_id,
    configuration: prior.configuration,
    observeContinuationClaim: input.observeContinuationClaim,
  });
  assertLineageMatchesEntry(prior, resolved);

  const terminal = canonicalCompletedTerminal(resolved.completed_run, resolved.completed_child_run_id);
  const github = await observePullRequest(input?.observePullRequest, terminal);
  const pullRequest = checkedMergedPullRequest(github, terminal);
  const remoteMain = await observeRemoteMain(input?.observeRemoteMain, pullRequest.repository);
  assertObservationOrder(pullRequest.merged_at, remoteMain.observed_at, "remote main observation predates the GitHub merge");
  await assertAncestor(input?.isAncestor, pullRequest.repository, pullRequest.head_sha, pullRequest.merge_commit, "exact completed child head is not an ancestor of the merged pull request commit");
  await assertAncestor(input?.isAncestor, pullRequest.repository, pullRequest.merge_commit, remoteMain.commit, "merged pull request is not an ancestor of freshly observed remote main");

  const completion = {
    completed_child_run_id: resolved.completed_child_run_id,
    completed_child_run_hash: resolved.completed_child_run_hash,
    checkpoint_source_hash: resolved.checkpoint_source_hash,
    configuration_hash: resolved.configuration_hash,
    lineage: resolved.lineage,
    pull_request: withoutMergedAt(pullRequest),
    remote_main: remoteMain,
    merged_at: remoteMain.observed_at,
  };

  if (prior.state === "merged") {
    await assertRecordedCompletion(prior, completion, pullRequest.merged_at, input?.isAncestor, pullRequest.repository);
    return { updated: false, entry: prior };
  }
  assertObservationOrder(prior.launched_at, remoteMain.observed_at, "remote main observation predates checkpoint launch");
  return { updated: true, entry: { ...prior, state: "merged", ...completion } };
}

export async function verifyRecordedCheckpointMerges(input) {
  const entries = Array.isArray(input?.entries) ? input.entries.map(clone) : [];
  if (entries.length === 0) throw new Error("recorded checkpoint merge verification requires at least one merged entry");
  const repository = requiredString(entries[0]?.pull_request?.repository, "recorded checkpoint repository");
  if (entries.some((entry) => entry?.state !== "merged" || entry.pull_request?.repository !== repository)) {
    throw new Error("recorded checkpoint merge verification requires same-repository merged entries");
  }

  const freshPullRequests = [];
  for (const entry of entries) {
    const recorded = requiredRecord(entry.pull_request, `checkpoint '${entry.checkpoint_id}' recorded pull request`);
    const observation = await observePullRequest(input?.observePullRequest, recorded, entry);
    const fresh = checkedMergedPullRequest(observation, recorded);
    if (fresh.merge_commit !== recorded.merge_commit) {
      throw new Error(`checkpoint '${entry.checkpoint_id}' recorded merge commit conflicts with fresh GitHub`);
    }
    freshPullRequests.push({ entry, pull_request: fresh });
  }

  const remoteMain = await observeRemoteMain(input?.observeRemoteMain, repository);
  for (const { entry, pull_request: pullRequest } of freshPullRequests) {
    assertObservationOrder(pullRequest.merged_at, remoteMain.observed_at, `checkpoint '${entry.checkpoint_id}' remote main observation predates the GitHub merge`);
    await assertAncestor(input?.isAncestor, repository, pullRequest.head_sha, pullRequest.merge_commit, `checkpoint '${entry.checkpoint_id}' exact head is not an ancestor of its freshly observed merge commit`);
    await assertAncestor(input?.isAncestor, repository, pullRequest.merge_commit, remoteMain.commit, `checkpoint '${entry.checkpoint_id}' merge is not an ancestor of freshly observed remote main`);
  }
  return { repository, remote_main: remoteMain, pull_requests: freshPullRequests.map(({ pull_request }) => withoutMergedAt(pull_request)) };
}

export async function assertCheckpointRemoteMainAdvanced(input) {
  const repository = requiredString(input?.repository, "checkpoint remote main repository");
  const prior = checkedRemoteMainSnapshot(input?.prior, "built checkpoint remote main");
  const fresh = checkedRemoteMainSnapshot(input?.fresh, "fresh checkpoint remote main");
  if (prior.commit === fresh.commit) return;
  await assertAncestor(
    input?.isAncestor,
    repository,
    prior.commit,
    fresh.commit,
    "fresh checkpoint remote main diverges from the snapshot used to build the publication",
  );
}

export function assertCheckpointCleanupEligible(parentRun, childIdentity) {
  const run = clone(parentRun);
  const progress = validateCheckpointProgress(run?.checkpoint_progress);
  const runId = requiredString(childIdentity?.run_id ?? childIdentity?.runId, "checkpoint cleanup run_id");
  const runHash = requiredHash(childIdentity?.run_hash ?? childIdentity?.runHash, "checkpoint cleanup run_hash");
  const matches = [];
  for (const entry of progress.entries) {
    if (entry.state !== "merged") continue;
    for (const row of entry.lineage) {
      if (row.run_id === runId && row.run_hash === runHash) matches.push({ entry, row });
    }
  }
  if (matches.length !== 1) throw new Error("checkpoint cleanup requires exactly one matching parent durable merged entry");
  const [{ entry }] = matches;
  return {
    eligible: true,
    parent_run_id: requiredString(run.run_id, "checkpoint cleanup parent run_id"),
    checkpoint_id: entry.checkpoint_id,
    checkpoint_ordinal: entry.ordinal,
    run_id: runId,
    run_hash: runHash,
    completed_child_run_id: entry.completed_child_run_id,
    merge_commit: entry.pull_request.merge_commit,
  };
}

export async function buildCheckpointFinalClosure(input) {
  const parent = normalizeRunSnapshot(input?.parent, "checkpoint closure parent");
  const progress = validateCheckpointProgress(parent.run?.checkpoint_progress);
  if (progress.entries.length === 0 || progress.entries.some((entry) => entry.state !== "merged")) {
    throw new Error("checkpoint final closure requires nonempty entirely merged parent progress");
  }
  const manifest = normalizeManifestSnapshot(input?.manifest);
  if (manifest.hash !== progress.manifest_hash || manifest.ref !== progress.manifest_ref) {
    throw new Error("checkpoint final closure manifest snapshot does not match parent progress");
  }
  assertManifestMatchesProgress(manifest.value, progress);

  const verified = await verifyRecordedCheckpointMerges({
    entries: progress.entries,
    observePullRequest: input?.observePullRequest,
    observeRemoteMain: input?.observeRemoteMain,
    isAncestor: input?.isAncestor,
  });
  const repository = verified.repository;
  const remoteMain = verified.remote_main;

  const source = manifest.value.source;
  const closure = {
    schema_version: 1,
    kind: "delivery-checkpoint-final-closure",
    parent_run_id: requiredString(parent.run.run_id, "checkpoint closure parent_run_id"),
    parent_run_hash: parent.hash,
    manifest_ref: manifest.ref,
    manifest_hash: manifest.hash,
    source_plan_ref: requiredString(source?.plan_ref, "checkpoint closure source plan_ref"),
    source_plan_hash: requiredHash(source?.plan_hash, "checkpoint closure source plan_hash"),
    source_review_ref: requiredString(source?.decomposition_review_ref, "checkpoint closure source review_ref"),
    source_review_hash: requiredHash(source?.decomposition_review_hash, "checkpoint closure source review_hash"),
    source_review_attempt: requiredPositiveInteger(source?.decomposition_attempt, "checkpoint closure source review attempt"),
    parent_review_identity_hash: requiredHash(source?.review_identity?.identity_hash, "checkpoint closure parent review identity hash"),
    admission_probe_hash: hashValue(requiredRecord(source?.admission_probe, "checkpoint closure admission probe")),
    checkpoints: progress.entries.map(closureCheckpoint),
    remote_main: remoteMain,
    closed_at: remoteMain.observed_at,
  };
  validateDeliveryCheckpointFinalClosure(closure);

  if (input.existingClosure !== undefined && input.existingClosure !== null) {
    const existing = clone(validateDeliveryCheckpointFinalClosure(input.existingClosure));
    assertExistingClosure(existing, closure, parent.run, remoteMain);
    await assertAncestor(input?.isAncestor, repository, existing.remote_main.commit, remoteMain.commit, "recorded closure main is not an ancestor of freshly observed remote main");
    return { updated: false, closure: existing };
  }
  if (progress.status !== "active" || progress.final_closure !== null) throw new Error("checkpoint final closure construction conflicts with already closed parent progress");
  return { updated: true, closure };
}

// Explicit names make the construction products clear to factory.js callers.
export const buildCheckpointMergedProgressEntry = buildCheckpointMergedCompletion;
export const resolveCheckpointLineage = resolveCheckpointCompletionLineage;

function normalizeRunSnapshots(values) {
  if (!Array.isArray(values)) throw new TypeError("checkpoint lineage runs must be an array");
  return values.map((value, index) => normalizeRunSnapshot(value, `checkpoint lineage runs[${index}]`));
}

function normalizeRunSnapshot(value, label = "run snapshot") {
  if (Buffer.isBuffer(value) || typeof value === "string") {
    const bytes = Buffer.from(value);
    return { run: parseJson(bytes, label), hash: hashBytes(bytes) };
  }
  if (isRecord(value) && Object.hasOwn(value, "run")) {
    const run = clone(requiredRecord(value.run, `${label}.run`));
    if (value.bytes === undefined) return { run, hash: hashValue(run) };
    const bytes = Buffer.from(value.bytes);
    if (!sameJson(parseJson(bytes, `${label}.bytes`), run)) throw new Error(`${label} bytes do not contain the supplied run`);
    return { run, hash: hashBytes(bytes) };
  }
  const run = clone(requiredRecord(value, label));
  return { run, hash: hashValue(run) };
}

function normalizeManifestSnapshot(value) {
  let manifest;
  let bytes;
  if (Buffer.isBuffer(value) || typeof value === "string") {
    bytes = Buffer.from(value);
    manifest = parseJson(bytes, "checkpoint closure manifest");
  } else if (isRecord(value) && Object.hasOwn(value, "manifest")) {
    manifest = clone(requiredRecord(value.manifest, "checkpoint closure manifest"));
    bytes = value.bytes === undefined ? canonicalBytes(manifest) : Buffer.from(value.bytes);
    if (!sameJson(parseJson(bytes, "checkpoint closure manifest bytes"), manifest)) throw new Error("checkpoint closure manifest bytes do not contain the supplied manifest");
  } else {
    manifest = clone(requiredRecord(value, "checkpoint closure manifest"));
    bytes = canonicalBytes(manifest);
  }
  const hash = hashBytes(bytes);
  return { value: manifest, hash, ref: `artifacts/checkpoint-routing-${hash.slice("sha256:".length)}.json` };
}

function uniqueRootRunId(snapshots) {
  const roots = new Set(snapshots.map((snapshot) => snapshot.run?.checkpoint_source?.root_child_run_id).filter(Boolean));
  if (roots.size !== 1) throw new Error("checkpoint lineage cannot resolve a unique root child run");
  return [...roots][0];
}

function configurationFromRun(run, inheritedReviewTier) {
  for (const key of ["mode", "github_account", "pr_mode", "max_parallel_slices", "max_retries"]) {
    if (!Object.hasOwn(run, key)) throw new Error(`checkpoint lineage run '${run.run_id ?? "<unknown>"}' is missing stored configuration field '${key}'`);
  }
  if (!isRecord(run.post_pr) || !Object.hasOwn(run.post_pr, "policy")) {
    throw new Error(`checkpoint lineage run '${run.run_id ?? "<unknown>"}' is missing stored post_pr policy`);
  }
  return {
    mode: run.mode,
    github_account: run.github_account,
    pr_mode: run.pr_mode,
    max_parallel_slices: run.max_parallel_slices,
    max_retries: run.max_retries,
    post_pr_policy: clone(run.post_pr.policy),
    review_tier: Object.hasOwn(run, "review_tier") ? run.review_tier : inheritedReviewTier ?? null,
  };
}

function assertAcyclic(byId, rootRunId) {
  for (const snapshot of byId.values()) {
    const seen = new Set();
    let current = snapshot.run;
    while (current.run_id !== rootRunId) {
      if (seen.has(current.run_id)) throw new Error("checkpoint lineage is cyclic");
      seen.add(current.run_id);
      const parentId = current.continuation?.parent?.run_id;
      if (!parentId) break;
      const parent = byId.get(parentId);
      if (!parent) break;
      current = parent.run;
    }
  }
}

async function observeContinuationClaim(observer, parent, child) {
  if (typeof observer !== "function") throw new Error("B1 checkpoint lineage requires a continuation claim observer");
  const expected = {
    ref: continuationTargetRef(child.run.run_id),
    parent_run_id: parent.run.run_id,
    parent_run_hash: parent.hash,
    child_run_id: child.run.run_id,
    child_run_hash: child.hash,
    continuation_hash: hashValue(child.run.continuation),
  };
  const result = await observer(clone(expected));
  const observations = Array.isArray(result) ? result : [result];
  if (observations.length !== 1 || !isRecord(observations[0])) throw new Error("checkpoint lineage requires exactly one continuation claim observation");
  const observed = observations[0];
  for (const [key, value] of Object.entries(expected)) {
    if (observed[key] !== value) throw new Error(`checkpoint continuation claim ${key} does not match the exact lineage edge`);
  }
  requiredFullSha(observed.oid, "checkpoint continuation claim oid");
  return { ref: observed.ref, oid: observed.oid };
}

function canonicalCompletedTerminal(run, completedRunId) {
  if (run?.status !== "completed" || run.terminal_result?.status !== "completed" || run.terminal_result.run_id !== completedRunId) {
    throw new Error("checkpoint completion requires the leaf's canonical completed terminal PR state");
  }
  const terminal = run.terminal_result;
  const tuple = {};
  for (const key of ["pr_url", "pr_number", "pr_node_id", "repository", "operation_id", "head_ref", "head_sha", "base_ref", "base_sha", "draft"]) {
    if (!Object.hasOwn(terminal, key)) throw new Error(`checkpoint completion terminal PR is missing '${key}'`);
    tuple[key] = terminal[key];
  }
  requiredString(tuple.pr_url, "checkpoint completion pr_url");
  requiredPositiveInteger(tuple.pr_number, "checkpoint completion pr_number");
  requiredString(tuple.pr_node_id, "checkpoint completion pr_node_id");
  requiredString(tuple.repository, "checkpoint completion repository");
  if (!OPERATION_ID.test(tuple.operation_id ?? "")) throw new Error("checkpoint completion operation_id is invalid");
  if (tuple.head_ref !== completedRunId) throw new Error("checkpoint completion terminal PR head_ref does not match the leaf run");
  requiredFullSha(tuple.head_sha, "checkpoint completion terminal head_sha");
  if (tuple.base_ref !== "main") throw new Error("checkpoint completion terminal PR base_ref must equal main");
  requiredFullSha(tuple.base_sha, "checkpoint completion terminal base_sha");
  if (typeof tuple.draft !== "boolean") throw new Error("checkpoint completion terminal draft must be a boolean");
  if (run.pr_url !== tuple.pr_url || terminal.reason !== null) throw new Error("checkpoint completion terminal PR state is not canonical");
  let url;
  try { url = githubPrUrlParts(tuple.pr_url); }
  catch { throw new Error("checkpoint completion terminal pr_url is not canonical"); }
  if (url.number !== tuple.pr_number || url.repository !== tuple.repository) throw new Error("checkpoint completion terminal PR URL tuple conflicts with its stored identity");
  return tuple;
}

async function observePullRequest(observer, terminal, entry) {
  if (typeof observer !== "function") throw new Error("checkpoint completion requires a GitHub pull request observer");
  return observer(clone(terminal), clone(entry));
}

function checkedMergedPullRequest(observation, terminal) {
  if (!isRecord(observation) || observation.disposition !== "merged" || !isRecord(observation.pull_request)) {
    throw new Error("checkpoint completion requires a freshly checked GitHub merged disposition");
  }
  const pull = observation.pull_request;
  for (const key of ["pr_url", "pr_number", "pr_node_id", "repository", "head_ref", "head_sha", "base_ref", "base_sha", "draft"]) {
    if (pull[key] !== terminal[key]) throw new Error(`checkpoint completion GitHub ${key} is stale or conflicts with the terminal PR tuple`);
  }
  const mergeCommit = requiredFullSha(pull.merge_commit_sha ?? pull.merge_commit, "checkpoint completion GitHub merge commit");
  const mergedAt = requiredTimestamp(pull.merged_at, "checkpoint completion GitHub merged_at");
  return { ...terminal, merge_commit: mergeCommit, merged_at: mergedAt };
}

async function observeRemoteMain(observer, repository) {
  if (typeof observer !== "function") throw new Error("checkpoint completion requires a remote main observer");
  const observed = await observer({ repository, ref: "refs/heads/main" });
  if (!isRecord(observed) || observed.ref !== "refs/heads/main") throw new Error("remote main observer did not return refs/heads/main");
  return {
    ref: observed.ref,
    commit: requiredFullSha(observed.commit, "fresh remote main commit"),
    observed_at: requiredTimestamp(observed.observed_at, "fresh remote main observed_at"),
  };
}

function checkedRemoteMainSnapshot(value, label) {
  if (!isRecord(value) || value.ref !== "refs/heads/main") throw new Error(`${label} must identify refs/heads/main`);
  return {
    ref: value.ref,
    commit: requiredFullSha(value.commit, `${label} commit`),
    observed_at: requiredTimestamp(value.observed_at, `${label} observed_at`),
  };
}

async function assertAncestor(observer, repository, ancestor, descendant, message) {
  if (typeof observer !== "function") throw new Error("checkpoint completion requires a Git ancestry observer");
  const result = await observer({ repository, ancestor, descendant });
  if (result !== true && result?.ok !== true) throw new Error(message);
}

function assertLineageMatchesEntry(entry, resolved) {
  const source = resolved.checkpoint_source;
  if (entry.root_child_run_id !== resolved.root_child_run_id || entry.checkpoint_id !== source.checkpoint_id || entry.ordinal !== source.checkpoint_ordinal) {
    throw new Error("checkpoint completion lineage does not match the durable progress entry");
  }
  if (entry.child_plan_hash !== source.child_plan_hash || entry.brief_scope_hash !== source.brief_scope_hash) {
    throw new Error("checkpoint completion source plan facts do not match the durable progress entry");
  }
}

async function assertRecordedCompletion(recorded, fresh, githubMergedAt, ancestryObserver, repository) {
  for (const key of ["completed_child_run_id", "completed_child_run_hash", "checkpoint_source_hash", "configuration_hash", "lineage", "pull_request"]) {
    if (!sameJson(recorded[key], fresh[key])) throw new Error(`recorded checkpoint merged ${key} conflicts with fresh completion facts`);
  }
  if (recorded.remote_main?.ref !== "refs/heads/main") throw new Error("recorded checkpoint merged remote main ref is stale");
  requiredFullSha(recorded.remote_main.commit, "recorded checkpoint remote main commit");
  requiredTimestamp(recorded.remote_main.observed_at, "recorded checkpoint remote main observed_at");
  assertObservationOrder(githubMergedAt, recorded.remote_main.observed_at, "recorded checkpoint main observation predates the GitHub merge");
  if (recorded.pull_request.merge_commit !== fresh.pull_request.merge_commit) throw new Error("recorded checkpoint merge commit conflicts with GitHub");
  await assertAncestor(ancestryObserver, repository, recorded.pull_request.merge_commit, recorded.remote_main.commit, "recorded checkpoint remote main does not contain its merge commit");
  await assertAncestor(ancestryObserver, repository, recorded.remote_main.commit, fresh.remote_main.commit, "recorded checkpoint remote main is not an ancestor of freshly observed remote main");
}

function assertManifestMatchesProgress(manifest, progress) {
  if (manifest?.kind !== "delivery-checkpoint-routing-manifest" || !Array.isArray(manifest.checkpoints)) {
    throw new Error("checkpoint final closure requires a routing manifest snapshot");
  }
  if (manifest.checkpoints.length !== progress.entries.length) throw new Error("checkpoint final closure manifest and progress checkpoint counts differ");
  for (const [index, entry] of progress.entries.entries()) {
    const checkpoint = manifest.checkpoints[index];
    if (checkpoint?.id !== entry.checkpoint_id || checkpoint.ordinal !== entry.ordinal
      || checkpoint.child_plan_hash !== entry.child_plan_hash || checkpoint.brief_scope_hash !== entry.brief_scope_hash) {
      throw new Error(`checkpoint final closure manifest conflicts with merged entry '${entry.checkpoint_id}'`);
    }
  }
}

function closureCheckpoint(entry) {
  return clone({
    checkpoint_id: entry.checkpoint_id,
    ordinal: entry.ordinal,
    root_child_run_id: entry.root_child_run_id,
    child_plan_hash: entry.child_plan_hash,
    brief_scope_hash: entry.brief_scope_hash,
    completed_child_run_id: entry.completed_child_run_id,
    completed_child_run_hash: entry.completed_child_run_hash,
    checkpoint_source_hash: entry.checkpoint_source_hash,
    configuration: entry.configuration,
    configuration_hash: entry.configuration_hash,
    lineage: entry.lineage,
    pull_request: entry.pull_request,
    merged_at: entry.merged_at,
  });
}

function assertExistingClosure(existing, fresh, parent, remoteMain) {
  for (const key of ["schema_version", "kind", "parent_run_id", "manifest_ref", "manifest_hash", "source_plan_ref", "source_plan_hash", "source_review_ref", "source_review_hash", "source_review_attempt", "parent_review_identity_hash", "admission_probe_hash", "checkpoints"]) {
    if (!sameJson(existing[key], fresh[key])) throw new Error(`existing checkpoint closure ${key} conflicts with durable parent records`);
  }
  if (parent.checkpoint_progress.status === "active" && existing.parent_run_hash !== fresh.parent_run_hash) {
    throw new Error("existing checkpoint closure parent hash conflicts with the active parent snapshot");
  }
  if (Date.parse(existing.closed_at) < Date.parse(existing.remote_main.observed_at)
    || Date.parse(remoteMain.observed_at) < Date.parse(existing.remote_main.observed_at)) {
    throw new Error("existing checkpoint closure has stale or future main observations");
  }
}

function withoutMergedAt(value) {
  const result = clone(value);
  delete result.merged_at;
  return result;
}

function continuationTargetRef(runId) {
  const digest = createHash("sha256").update(runId, "utf8").digest("hex");
  return `refs/opencode/continuation-targets/${digest}`;
}

function assertObservationOrder(earlier, later, message) {
  if (Date.parse(requiredTimestamp(later, "observation timestamp")) < Date.parse(requiredTimestamp(earlier, "prior timestamp"))) throw new Error(message);
}

function hashBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalBytes(value) {
  const canonical = (input) => Array.isArray(input)
    ? input.map(canonical)
    : isRecord(input)
      ? Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])]))
      : input;
  return Buffer.from(JSON.stringify(canonical(value)), "utf8");
}

function parseJson(bytes, label) {
  try { return requiredRecord(JSON.parse(bytes.toString("utf8")), label); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
}

function requiredRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) throw new Error(`${label} must be a non-empty NUL-free string`);
  return value;
}

function requiredHash(value, label) {
  if (!HASH.test(value ?? "")) throw new Error(`${label} must be a sha256 hash`);
  return value;
}

function requiredFullSha(value, label) {
  if (!FULL_SHA.test(value ?? "")) throw new Error(`${label} must be a full lowercase Git SHA`);
  return value;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function requiredTimestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a canonical ISO UTC timestamp`);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
