import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  assertCheckpointCleanupEligible,
  buildCheckpointFinalClosure,
  buildCheckpointMergedCompletion,
  resolveCheckpointCompletionLineage,
} from "../src/checkpoint-completion.js";
import { hashValue } from "../src/refs.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const MERGED_AT = "2026-07-19T12:03:00.000Z";
const OBSERVED_AT = "2026-07-19T12:04:00.000Z";

describe("standalone B4.3 checkpoint completion", () => {
  it("resolves and completes a root child from fresh GitHub and remote-main observations", async () => {
    const fixture = completionFixture();
    const lineage = await resolveCheckpointCompletionLineage({ runs: [fixture.root] });
    assert.equal(lineage.completed_child_run_id, fixture.root.run_id);
    assert.deepEqual(lineage.lineage, [{
      run_id: fixture.root.run_id,
      run_hash: hashValue(fixture.root),
      parent_run_id: null,
      continuation_claim_ref: null,
      continuation_claim_oid: null,
    }]);

    const result = await buildCheckpointMergedCompletion({
      entry: fixture.launched,
      runs: [fixture.root],
      ...observers(),
    });
    assert.equal(result.updated, true);
    assert.equal(result.entry.state, "merged");
    assert.equal(result.entry.completed_child_run_hash, hashValue(fixture.root));
    assert.equal(result.entry.pull_request.merge_commit, SHA_C);
    assert.deepEqual(result.entry.remote_main, { ref: "refs/heads/main", commit: SHA_C, observed_at: OBSERVED_AT });

    const replay = await buildCheckpointMergedCompletion({ entry: result.entry, runs: [fixture.root], ...observers() });
    assert.equal(replay.updated, false);
    assert.deepEqual(replay.entry, result.entry);
    await assert.rejects(
      buildCheckpointMergedCompletion({ entry: result.entry, runs: [fixture.root], ...observers({ ancestor: false }) }),
      /not an ancestor|does not contain/u,
    );
  });

  it("resolves one exact B1 leaf and binds its continuation claim edge and hashes", async () => {
    const fixture = completionFixture({ withLeaf: true });
    const seen = [];
    const resolved = await resolveCheckpointCompletionLineage({
      runs: [fixture.root, fixture.leaf],
      observeContinuationClaim: (expected) => {
        seen.push(expected);
        return { ...expected, oid: SHA_C };
      },
    });

    assert.equal(resolved.completed_child_run_id, fixture.leaf.run_id);
    assert.equal(resolved.lineage.length, 2);
    assert.deepEqual(resolved.lineage[1], {
      run_id: fixture.leaf.run_id,
      run_hash: hashValue(fixture.leaf),
      parent_run_id: fixture.root.run_id,
      continuation_claim_ref: targetRef(fixture.leaf.run_id),
      continuation_claim_oid: SHA_C,
    });
    assert.equal(seen[0].parent_run_hash, hashValue(fixture.root));
    assert.equal(seen[0].continuation_hash, hashValue(fixture.leaf.continuation));

    const result = await buildCheckpointMergedCompletion({
      entry: fixture.launched,
      runs: [fixture.root, fixture.leaf],
      observeContinuationClaim: (expected) => ({ ...expected, oid: SHA_C }),
      ...observers({ headRef: fixture.leaf.run_id }),
    });
    assert.equal(result.entry.completed_child_run_id, fixture.leaf.run_id);
    assert.equal(result.entry.pull_request.head_ref, fixture.leaf.run_id);
  });

  it("rejects missing, multiple, cyclic, cross-checkpoint, and claim-conflicting descendants", async () => {
    const base = completionFixture({ withLeaf: true });
    const sibling = childRun(base.root, "checkpoint-sibling");
    for (const [label, runs, expected] of [
      ["missing", [base.leaf], /root.*missing|root child/u],
      ["multiple", [base.root, base.leaf, sibling], /multiple conflicting descendants/u],
      ["cross checkpoint", [base.root, { ...base.leaf, checkpoint_source: { ...base.leaf.checkpoint_source, checkpoint_id: "checkpoint-002", checkpoint_ordinal: 2 } }], /cross-checkpoint|drifted checkpoint_source/u],
    ]) {
      await assert.rejects(resolveCheckpointCompletionLineage({
        runs,
        rootRunId: base.root.run_id,
        observeContinuationClaim: (claim) => ({ ...claim, oid: SHA_C }),
      }), expected, label);
    }

    const cycleA = childRun(base.root, "cycle-a");
    const cycleB = childRun(cycleA, "cycle-b");
    cycleA.continuation.parent.run_id = cycleB.run_id;
    cycleA.continuation.parent.run_hash = hashValue(cycleB);
    await assert.rejects(resolveCheckpointCompletionLineage({
      runs: [base.root, cycleA, cycleB], rootRunId: base.root.run_id,
      observeContinuationClaim: (claim) => ({ ...claim, oid: SHA_C }),
    }), /cyclic|missing, cyclic/u);

    await assert.rejects(resolveCheckpointCompletionLineage({
      runs: [base.root, base.leaf],
      observeContinuationClaim: (claim) => ({ ...claim, continuation_hash: HASH_A, oid: SHA_C }),
    }), /continuation_hash.*exact lineage edge/u);
    for (const claims of [[], [{ oid: SHA_A }, { oid: SHA_B }]]) {
      await assert.rejects(resolveCheckpointCompletionLineage({
        runs: [base.root, base.leaf],
        observeContinuationClaim: () => claims,
      }), /exactly one continuation claim observation/u);
    }
  });

  it("rejects checkpoint source and every stored configuration drift including review_tier presence", async () => {
    const fixture = completionFixture({ withLeaf: true });
    const sourceDrift = structuredClone(fixture.leaf);
    sourceDrift.checkpoint_source.acceptance_mapping_hash = HASH_A;
    await assert.rejects(resolveCheckpointCompletionLineage({ runs: [fixture.root, sourceDrift] }), /checkpoint_source bytes/u);

    for (const mutate of [
      (run) => { run.mode = "headless"; },
      (run) => { run.post_pr.policy.wait_ms += 1; },
      (run) => { run.review_tier = "strict"; },
      (run) => { delete run.review_tier; },
    ]) {
      const leaf = structuredClone(fixture.leaf);
      mutate(leaf);
      await assert.rejects(resolveCheckpointCompletionLineage({ runs: [fixture.root, leaf] }), /configuration|review_tier/u);
    }
  });

  it("rejects stale GitHub disposition and remote main that does not contain the merge", async () => {
    const fixture = completionFixture();
    await assert.rejects(buildCheckpointMergedCompletion({
      entry: fixture.launched,
      runs: [fixture.root],
      ...observers({ disposition: "open" }),
    }), /freshly checked GitHub merged disposition/u);

    await assert.rejects(buildCheckpointMergedCompletion({
      entry: fixture.launched,
      runs: [fixture.root],
      ...observers({ ancestor: false }),
    }), /not an ancestor/u);

    await assert.rejects(buildCheckpointMergedCompletion({
      entry: fixture.launched,
      runs: [fixture.root],
      ...observers({ observedAt: "2026-07-19T12:02:00.000Z" }),
    }), /predates the GitHub merge/u);
  });

  it("allows cleanup only after the matching run identity is durable in parent merged progress", async () => {
    const fixture = completionFixture();
    const parent = parentRun(fixture, fixture.launched);
    assert.throws(
      () => assertCheckpointCleanupEligible(parent, { run_id: fixture.root.run_id, run_hash: hashValue(fixture.root) }),
      /exactly one matching parent durable merged entry/u,
    );

    const merged = (await buildCheckpointMergedCompletion({ entry: fixture.launched, runs: [fixture.root], ...observers() })).entry;
    parent.checkpoint_progress.entries[0] = merged;
    const eligibility = assertCheckpointCleanupEligible(parent, { run_id: fixture.root.run_id, run_hash: hashValue(fixture.root) });
    assert.equal(eligibility.eligible, true);
    assert.equal(eligibility.checkpoint_id, "checkpoint-001");
    assert.throws(
      () => assertCheckpointCleanupEligible(parent, { run_id: fixture.root.run_id, run_hash: HASH_A }),
      /exactly one matching/u,
    );
  });

  it("builds and replays a reservation-free closure from parent records after child deletion", async () => {
    const fixture = completionFixture();
    const merged = (await buildCheckpointMergedCompletion({ entry: fixture.launched, runs: [fixture.root], ...observers() })).entry;
    const manifest = routingManifest(fixture);
    const parent = parentRun(fixture, merged);
    const result = await buildCheckpointFinalClosure({ parent, manifest, ...observers() });

    assert.equal(result.updated, true);
    assert.equal(Object.hasOwn(result.closure, "reservation_oid"), false);
    assert.equal(result.closure.checkpoints[0].completed_child_run_id, fixture.root.run_id);
    assert.equal(result.closure.parent_run_hash, hashValue(parent));

    // No child snapshot or child-directory callback participates in closure.
    const replay = await buildCheckpointFinalClosure({
      parent,
      manifest,
      existingClosure: result.closure,
      ...observers({ mainCommit: "d".repeat(40), ancestor: true, observedAt: "2026-07-19T12:05:00.000Z" }),
    });
    assert.equal(replay.updated, false);
    assert.deepEqual(replay.closure, result.closure);
  });
});

function completionFixture({ withLeaf = false } = {}) {
  const source = checkpointSource();
  const root = completedRun("checkpoint-root", source);
  const leaf = withLeaf ? childRun(root, "checkpoint-leaf") : null;
  const terminal = withLeaf ? leaf : root;
  terminal.status = "completed";
  terminal.pr_url = `https://github.com/acme/repo/pull/7`;
  terminal.terminal_result = terminalResult(terminal.run_id);
  if (withLeaf) {
    root.status = "blocked";
    delete root.pr_url;
    root.terminal_result = { status: "blocked", run_id: root.run_id, pr_url: null, reason: "repair-required", summary: "Continue.", artifacts: {} };
    leaf.continuation.parent.run_hash = hashValue(root);
  }
  return { source, root, leaf, launched: launchedEntry(source) };
}

function completedRun(runId, source) {
  const configuration = checkpointConfiguration();
  return {
    schema_version: 1,
    run_id: runId,
    status: "completed",
    mode: configuration.mode,
    github_account: configuration.github_account,
    pr_mode: configuration.pr_mode,
    max_parallel_slices: configuration.max_parallel_slices,
    max_retries: configuration.max_retries,
    review_tier: configuration.review_tier,
    post_pr: { schema_version: 1, policy: structuredClone(configuration.post_pr_policy) },
    checkpoint_source: structuredClone(source),
    pr_url: "https://github.com/acme/repo/pull/7",
    terminal_result: terminalResult(runId),
  };
}

function childRun(parent, runId) {
  const child = completedRun(runId, parent.checkpoint_source);
  child.continuation = {
    schema_version: 2,
    kind: "blocked-run-continuation",
    parent: { run_id: parent.run_id, run_hash: hashValue(parent) },
    target: { run_id: runId },
    configuration: checkpointConfiguration(),
  };
  return child;
}

function terminalResult(runId) {
  return {
    status: "completed",
    run_id: runId,
    reason: null,
    summary: "PR created.",
    artifacts: {},
    pr_url: "https://github.com/acme/repo/pull/7",
    pr_number: 7,
    pr_node_id: "PR_checkpoint_7",
    repository: "acme/repo",
    operation_id: `ffpr-v1-${"d".repeat(64)}`,
    head_ref: runId,
    head_sha: SHA_B,
    base_ref: "main",
    base_sha: SHA_A,
    draft: false,
  };
}

function observers(overrides = {}) {
  return {
    observePullRequest: (terminal) => ({
      disposition: overrides.disposition ?? "merged",
      pull_request: {
        ...terminal,
        head_ref: overrides.headRef ?? terminal.head_ref,
        merge_commit_sha: SHA_C,
        merged_at: MERGED_AT,
      },
    }),
    observeRemoteMain: ({ ref }) => ({ ref, commit: overrides.mainCommit ?? SHA_C, observed_at: overrides.observedAt ?? OBSERVED_AT }),
    isAncestor: () => overrides.ancestor ?? true,
  };
}

function checkpointConfiguration() {
  return {
    mode: "interactive",
    github_account: null,
    pr_mode: "ready",
    max_parallel_slices: 3,
    max_retries: 3,
    post_pr_policy: {
      enabled: false,
      wait_ms: 3_600_000,
      initial_poll_ms: 30_000,
      max_poll_ms: 120_000,
      check_start_grace_ms: 300_000,
      max_transient_errors: 12,
      review: { required: false, reviewer_login: null, source: "none" },
    },
    review_tier: null,
  };
}

function checkpointSource() {
  const manifestHash = HASH_A;
  return {
    schema_version: 1,
    kind: "delivery-checkpoint-source",
    parent_run_id: "checkpoint-parent",
    manifest_ref: `artifacts/checkpoint-routing-${manifestHash.slice("sha256:".length)}.json`,
    manifest_hash: manifestHash,
    checkpoint_id: "checkpoint-001",
    checkpoint_ordinal: 1,
    root_child_run_id: "checkpoint-root",
    source_plan_ref: "plan/slices.json",
    source_plan_hash: HASH_B,
    source_review_ref: "reviews/work-decomposer.json",
    source_review_hash: HASH_B,
    source_review_attempt: 1,
    parent_review_identity_hash: HASH_B,
    child_disposition_hash: HASH_B,
    admission_probe_hash: HASH_B,
    brief_scope_hash: HASH_B,
    child_plan_hash: HASH_B,
    acceptance_mapping_hash: HASH_B,
    initial_base_ref: "refs/remotes/origin/main",
    initial_base_commit: SHA_A,
  };
}

function launchedEntry(source) {
  return {
    state: "launched",
    checkpoint_id: source.checkpoint_id,
    ordinal: source.checkpoint_ordinal,
    root_child_run_id: source.root_child_run_id,
    branch: source.root_child_run_id,
    worktree: "/tmp/checkpoint-root",
    base_ref: "refs/remotes/origin/main",
    base_commit: SHA_A,
    predecessor_checkpoint_id: null,
    predecessor_completed_run_id: null,
    predecessor_merge_commit: null,
    configuration: checkpointConfiguration(),
    publication_claim_ref: `refs/opencode/checkpoint-publications/${createHash("sha256").update(source.root_child_run_id).digest("hex")}`,
    publication_claim_oid: SHA_A,
    reserved_at: "2026-07-19T12:00:00.000Z",
    child_run_hash: HASH_B,
    child_plan_hash: source.child_plan_hash,
    brief_scope_hash: source.brief_scope_hash,
    published_at: "2026-07-19T12:01:00.000Z",
    launched_at: "2026-07-19T12:02:00.000Z",
  };
}

function parentRun(fixture, entry) {
  return {
    schema_version: 1,
    run_id: fixture.source.parent_run_id,
    status: "blocked",
    checkpoint_progress: {
      schema_version: 1,
      kind: "delivery-checkpoint-progress",
      manifest_ref: fixture.source.manifest_ref,
      manifest_hash: fixture.source.manifest_hash,
      status: "active",
      entries: [structuredClone(entry)],
      final_closure: null,
    },
  };
}

function routingManifest(fixture) {
  const manifest = {
    schema_version: 1,
    kind: "delivery-checkpoint-routing-manifest",
    source: {
      plan_ref: fixture.source.source_plan_ref,
      plan_hash: fixture.source.source_plan_hash,
      decomposition_review_ref: fixture.source.source_review_ref,
      decomposition_review_hash: fixture.source.source_review_hash,
      decomposition_attempt: fixture.source.source_review_attempt,
      review_identity: { identity_hash: fixture.source.parent_review_identity_hash },
      admission_probe: { decision: "checkpoint" },
    },
    checkpoints: [{
      id: fixture.source.checkpoint_id,
      ordinal: fixture.source.checkpoint_ordinal,
      child_plan_hash: fixture.source.child_plan_hash,
      brief_scope_hash: fixture.source.brief_scope_hash,
    }],
  };
  const hash = hashValue(manifest);
  fixture.source.manifest_hash = hash;
  fixture.source.manifest_ref = `artifacts/checkpoint-routing-${hash.slice("sha256:".length)}.json`;
  return manifest;
}

function targetRef(runId) {
  return `refs/opencode/continuation-targets/${createHash("sha256").update(runId).digest("hex")}`;
}
