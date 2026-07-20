import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ValidationError,
  validateCheckpointChildPublication,
  validateCheckpointConfiguration,
  validateCheckpointProgress,
  validateCheckpointSource,
  validateDeliveryCheckpointFinalClosure,
  validateRun,
} from "../src/validate.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const NOW = "2026-07-19T12:00:00.000Z";
const MANIFEST_REF = `artifacts/checkpoint-routing-${"a".repeat(64)}.json`;

describe("B4.3 normal-child checkpoint schemas", () => {
  it("validates the closed source, configuration, publication claim, progress variants, and closure", () => {
    const source = checkpointSource();
    const configuration = checkpointConfiguration();
    const publication = checkpointPublication();
    const variants = ["reserved", "child-published", "launched", "merged"].map((state) => progressEntry(state));
    const closure = checkpointClosure();

    assert.equal(validateCheckpointSource(source), source);
    assert.equal(validateCheckpointConfiguration(configuration), configuration);
    assert.equal(validateCheckpointChildPublication(publication), publication);
    for (const entry of variants) {
      const progress = checkpointProgress(entry);
      assert.equal(validateCheckpointProgress(progress), progress, entry.state);
    }
    assert.equal(validateDeliveryCheckpointFinalClosure(closure), closure);
    assert.equal(Object.hasOwn(closure, "reservation_oid"), false);
  });

  it("requires complete resolved configuration and explicit review_tier null semantics", () => {
    assert.equal(validateCheckpointConfiguration(checkpointConfiguration()).review_tier, null);
    assert.equal(validateCheckpointConfiguration(checkpointConfiguration({ review_tier: "strict" })).review_tier, "strict");
    for (const [label, mutate, expected] of [
      ["missing review tier", (value) => { delete value.review_tier; }, /review_tier: must be a non-empty string or null/u],
      ["missing account", (value) => { delete value.github_account; }, /github_account: must be a non-empty string or null/u],
      ["wrong parallelism", (value) => { value.max_parallel_slices = 2; }, /must be an integer from 3 to 3/u],
      ["unknown key", (value) => { value.model = "runtime-only"; }, /model: is not allowed/u],
    ]) {
      const value = checkpointConfiguration();
      mutate(value);
      assert.throws(() => validateCheckpointConfiguration(value), expected, label);
    }
  });

  it("rejects unknown keys on every new record and nested completion fact", () => {
    for (const [label, value, validate, mutate] of [
      ["source", checkpointSource(), validateCheckpointSource, (record) => { record.legacy = true; }],
      ["publication", checkpointPublication(), validateCheckpointChildPublication, (record) => { record.state = "reserved"; }],
      ["progress", checkpointProgress(progressEntry("reserved")), validateCheckpointProgress, (record) => { record.authority = true; }],
      ["entry", checkpointProgress(progressEntry("launched")), validateCheckpointProgress, (record) => { record.entries[0].pid = 7; }],
      ["lineage", checkpointProgress(progressEntry("merged")), validateCheckpointProgress, (record) => { record.entries[0].lineage[0].branch = "child-1"; }],
      ["pull request", checkpointProgress(progressEntry("merged")), validateCheckpointProgress, (record) => { record.entries[0].pull_request.disposition = "merged"; }],
      ["remote main", checkpointProgress(progressEntry("merged")), validateCheckpointProgress, (record) => { record.entries[0].remote_main.source = "local"; }],
      ["closure", checkpointClosure(), validateDeliveryCheckpointFinalClosure, (record) => { record.reservation_oid = SHA_A; }],
    ]) {
      mutate(value);
      assert.throws(() => validate(value), /is not allowed/u, label);
    }
  });

  it("accepts only contiguous reserved, child-published, launched, and merged entry shapes", () => {
    for (const [label, mutate, expected] of [
      ["bad state", (value) => { value.entries[0].state = "launching"; }, /must be one of reserved, child-published, launched, merged/u],
      ["wrong ordinal", (value) => { value.entries[0].ordinal = 2; }, /must be contiguous/u],
      ["wrong checkpoint id", (value) => { value.entries[0].checkpoint_id = "checkpoint-002"; }, /must match its checkpoint ordinal/u],
      ["reserved carrying publication", (value) => { value.entries[0].published_at = NOW; }, /published_at: is not allowed/u],
      ["active carrying closure", (value) => { value.final_closure = finalClosureBinding(); }, /must be null while status is active/u],
    ]) {
      const value = checkpointProgress(progressEntry("reserved"));
      mutate(value);
      assert.throws(() => validateCheckpointProgress(value), expected, label);
    }

    const noncontiguous = checkpointProgress(progressEntry("launched"));
    noncontiguous.entries.push(progressEntry("reserved", 2));
    assert.throws(() => validateCheckpointProgress(noncontiguous), /must be merged before a later checkpoint entry exists/u);

    const closed = checkpointProgress(progressEntry("merged"), { status: "closed", final_closure: finalClosureBinding() });
    assert.equal(validateCheckpointProgress(closed).status, "closed");
  });

  it("rejects cross-bound predecessor, lineage, PR, and timestamp facts", () => {
    const cases = [
      ["predecessor", () => {
        const value = checkpointProgress(progressEntry("merged"));
        value.entries.push(progressEntry("reserved", 2));
        value.entries[1].predecessor_completed_run_id = "other-run";
        return value;
      }, /must equal the prior merged completed_child_run_id/u],
      ["lineage root", () => {
        const value = checkpointProgress(progressEntry("merged"));
        value.entries[0].lineage[0].run_id = "other-run";
        return value;
      }, /must equal root_child_run_id/u],
      ["PR number", () => {
        const value = checkpointProgress(progressEntry("merged"));
        value.entries[0].pull_request.pr_number = 8;
        return value;
      }, /must match pr_url pull request number/u],
      ["PR head", () => {
        const value = checkpointProgress(progressEntry("merged"));
        value.entries[0].pull_request.head_ref = "other-run";
        return value;
      }, /must equal completed_child_run_id/u],
      ["time order", () => {
        const value = checkpointProgress(progressEntry("merged"));
        value.entries[0].merged_at = "2026-07-19T11:00:00.000Z";
        return value;
      }, /must not precede/u],
    ];
    for (const [label, make, expected] of cases) assert.throws(() => validateCheckpointProgress(make()), expected, label);
  });

  it("validates checkpoint source and progress through the closed run root", () => {
    const child = { schema_version: 1, run_id: "child-1", status: "running", gates: {}, checkpoint_source: checkpointSource() };
    const parent = {
      schema_version: 1,
      run_id: "parent",
      status: "blocked",
      gates: {},
      checkpoint_progress: checkpointProgress(progressEntry("reserved")),
      terminal_result: {
        status: "blocked",
        run_id: "parent",
        pr_url: null,
        reason: "oversized-plan-checkpoint-routing-required",
        summary: "Routed to checkpoints.",
        artifacts: { checkpoint_routing: MANIFEST_REF },
      },
    };
    assert.equal(validateRun(child), child);
    assert.equal(validateRun(parent), parent);
    assert.throws(
      () => validateRun({ ...child, checkpoint_progress: parent.checkpoint_progress }),
      (error) => error instanceof ValidationError && /mutually exclusive child and parent records/u.test(error.message),
    );
    assert.throws(
      () => validateRun({ ...parent, status: "running", terminal_result: null }),
      /allowed only on the blocked checkpoint-routing parent/u,
    );
    assert.throws(
      () => validateRun({ ...parent, checkpoint_progress: { ...parent.checkpoint_progress, manifest_ref: `artifacts/checkpoint-routing-${"b".repeat(64)}.json`, manifest_hash: HASH_B } }),
      /must match terminal_result\.artifacts\.checkpoint_routing/u,
    );
  });

  it("rejects the removed child binding schema and keeps legacy authority symbols out of production", () => {
    assert.throws(
      () => validateRun({ schema_version: 1, run_id: "legacy-child", status: "running", gates: {}, checkpoint: { schema_version: 1 } }),
      /run\.checkpoint: is not allowed/u,
    );

    const forbidden = /assertCheckpointLocalPublishedAuthority|CHECKPOINT_GENERIC_MUTATION_STATES|validateCheckpointChildBinding|validateCheckpointReservationClaim|["']delivery-checkpoint-child["']|delivery-checkpoint-child-reservation|refs\/opencode\/checkpoint-(?:targets|routes)|reservation_oid/u;
    for (const file of ["run-state.js", "validate.js", "factory.js", "feature-command-payload.js"]) {
      assert.doesNotMatch(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), forbidden, file);
    }
  });
});

function checkpointConfiguration(overrides = {}) {
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
    ...overrides,
  };
}

function checkpointSource() {
  return {
    schema_version: 1,
    kind: "delivery-checkpoint-source",
    parent_run_id: "parent",
    manifest_ref: MANIFEST_REF,
    manifest_hash: HASH_A,
    checkpoint_id: "checkpoint-001",
    checkpoint_ordinal: 1,
    root_child_run_id: "child-1",
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

function checkpointPublication(ordinal = 1) {
  return {
    schema_version: 1,
    kind: "delivery-checkpoint-child-publication",
    parent_run_id: "parent",
    manifest_ref: MANIFEST_REF,
    manifest_hash: HASH_A,
    checkpoint_id: checkpointId(ordinal),
    checkpoint_ordinal: ordinal,
    child_run_id: `child-${ordinal}`,
    branch_ref: `refs/heads/child-${ordinal}`,
    worktree: `/tmp/child-${ordinal}`,
    remote_main_ref: "refs/heads/main",
    base_commit: ordinal === 1 ? SHA_A : SHA_C,
    predecessor_checkpoint_id: ordinal === 1 ? null : checkpointId(ordinal - 1),
    predecessor_completed_run_id: ordinal === 1 ? null : `completed-${ordinal - 1}`,
    predecessor_merge_commit: ordinal === 1 ? null : SHA_C,
    reserved_at: NOW,
  };
}

function checkpointProgress(entry, overrides = {}) {
  return {
    schema_version: 1,
    kind: "delivery-checkpoint-progress",
    manifest_ref: MANIFEST_REF,
    manifest_hash: HASH_A,
    status: "active",
    entries: [entry],
    final_closure: null,
    ...overrides,
  };
}

function progressEntry(state, ordinal = 1) {
  const childRunId = `child-${ordinal}`;
  const common = {
    state,
    checkpoint_id: checkpointId(ordinal),
    ordinal,
    root_child_run_id: childRunId,
    branch: childRunId,
    worktree: `/tmp/${childRunId}`,
    base_ref: "refs/remotes/origin/main",
    base_commit: ordinal === 1 ? SHA_A : SHA_C,
    predecessor_checkpoint_id: ordinal === 1 ? null : checkpointId(ordinal - 1),
    predecessor_completed_run_id: ordinal === 1 ? null : `completed-${ordinal - 1}`,
    predecessor_merge_commit: ordinal === 1 ? null : SHA_C,
    configuration: checkpointConfiguration(),
    publication_claim_ref: `refs/opencode/checkpoint-publications/${createHash("sha256").update(childRunId).digest("hex")}`,
    publication_claim_oid: SHA_A,
    reserved_at: "2026-07-19T12:00:00.000Z",
  };
  if (state === "reserved") return common;
  Object.assign(common, {
    child_run_hash: HASH_B,
    child_plan_hash: HASH_B,
    brief_scope_hash: HASH_B,
    published_at: "2026-07-19T12:01:00.000Z",
  });
  if (state === "child-published") return common;
  common.launched_at = "2026-07-19T12:02:00.000Z";
  if (state === "launched") return common;
  return Object.assign(common, {
    completed_child_run_id: ordinal === 1 ? childRunId : `completed-${ordinal}`,
    completed_child_run_hash: HASH_B,
    checkpoint_source_hash: HASH_B,
    configuration_hash: HASH_B,
    lineage: [{ run_id: childRunId, run_hash: HASH_B, parent_run_id: null, continuation_claim_ref: null, continuation_claim_oid: null }],
    pull_request: pullRequest(childRunId),
    remote_main: remoteMain(),
    merged_at: "2026-07-19T12:04:00.000Z",
  });
}

function pullRequest(childRunId) {
  return {
    pr_url: "https://github.com/acme/repo/pull/7",
    pr_number: 7,
    pr_node_id: "PR_checkpoint_7",
    repository: "acme/repo",
    operation_id: `ffpr-v1-${"d".repeat(64)}`,
    head_ref: childRunId,
    head_sha: SHA_B,
    base_ref: "main",
    base_sha: SHA_A,
    draft: false,
    merge_commit: SHA_C,
  };
}

function remoteMain() {
  return { ref: "refs/heads/main", commit: SHA_C, observed_at: "2026-07-19T12:03:00.000Z" };
}

function finalClosureBinding() {
  return { ref: "artifacts/checkpoint-final-closure.json", hash: HASH_B, closed_at: "2026-07-19T12:05:00.000Z" };
}

function checkpointClosure() {
  const merged = progressEntry("merged");
  return {
    schema_version: 1,
    kind: "delivery-checkpoint-final-closure",
    parent_run_id: "parent",
    parent_run_hash: HASH_B,
    manifest_ref: MANIFEST_REF,
    manifest_hash: HASH_A,
    source_plan_ref: "plan/slices.json",
    source_plan_hash: HASH_B,
    source_review_ref: "reviews/work-decomposer.json",
    source_review_hash: HASH_B,
    source_review_attempt: 1,
    parent_review_identity_hash: HASH_B,
    admission_probe_hash: HASH_B,
    checkpoints: [{
      checkpoint_id: merged.checkpoint_id,
      ordinal: merged.ordinal,
      root_child_run_id: merged.root_child_run_id,
      child_plan_hash: merged.child_plan_hash,
      brief_scope_hash: merged.brief_scope_hash,
      completed_child_run_id: merged.completed_child_run_id,
      completed_child_run_hash: merged.completed_child_run_hash,
      checkpoint_source_hash: merged.checkpoint_source_hash,
      configuration: merged.configuration,
      configuration_hash: merged.configuration_hash,
      lineage: merged.lineage,
      pull_request: merged.pull_request,
      merged_at: merged.merged_at,
    }],
    remote_main: { ...remoteMain(), observed_at: "2026-07-19T12:05:00.000Z" },
    closed_at: "2026-07-19T12:06:00.000Z",
  };
}

function checkpointId(ordinal) {
  return `checkpoint-${String(ordinal).padStart(3, "0")}`;
}
