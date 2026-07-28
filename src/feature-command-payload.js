import { basename, resolve } from "node:path";
import { validateRun } from "./validate.js";
import { normalizePostPrCiDriverOverride } from "./config.js";
import { assertContinuationReservationAuthority, assertOrdinaryResumeRunById, assertPublishedCarryForwardRun, assertPublishedCarryForwardRunById } from "./run-state.js";

const PREFIX = "ffpayload-v1:";
const DRIVER_MODES = new Set(["interactive", "headless", "autonomous"]);
const DRIVER_KEYS = new Set(["mode", "ready", "pr_mode", "reviewer", "github_account", "run_id", "post_pr_ci"]);
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const CONTINUATION_KEYS = new Set(["kind", "schema_version", "created_at", "operator_summary", "parent", "review", "target", "parent_artifacts", "parent_evidence", "parent_reviews", "planning_reuse", "configuration", "carry_forward", "checkpoint_source_hash", "configuration_hash"]);
const CONTINUATION_PLANNING_REUSE_KEYS = new Set(["eligible", "spec_review_ref", "spec_review_hash", "spec_artifact_ref", "spec_artifact_hash", "child_spec_review_ref"]);
const CHECKPOINT_CONTINUATION_PLANNING_REUSE_KEYS = new Set(["eligible", "plan_ref", "plan_hash", "review_ref", "review_hash"]);
const CONTINUATION_CHILD_SPEC_REVIEW_REF = "reviews/spec-writer.json";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/iu;
const CONTINUATION_PARENT_KEYS = new Set(["run_id", "status", "run_ref", "run_hash", "branch", "commit", "worktree"]);
const CONTINUATION_REVIEW_KEYS = new Set(["kind", "ref", "hash", "subject", "summary", "required_fixes", "source", "verdict"]);
const CONTINUATION_TARGET_KEYS = new Set(["run_id", "branch", "worktree", "base_ref", "base_commit"]);
const CONTINUATION_REF_KEYS = new Set(["kind", "ref", "hash"]);
const STEERING_KEYS = new Set(["schema_version", "kind", "run_id", "pending", "uncheckpointed", "consume", "raw_message_included"]);
const STEERING_PENDING_KEYS = new Set(["id", "ref", "hash", "message_chars", "created_at"]);
const STEERING_UNCHECKPOINTED_KEYS = new Set(["id", "ref", "hash", "message_chars", "created_at", "consumed_at"]);
const STEERING_CONSUME_KEYS = new Set(["command", "args"]);
const CONTINUATION_REVIEW_KINDS = new Set(["validator", "security_review", "step", "slice"]);
const CONTINUATION_ARTIFACT_KINDS = new Map([
  ["artifacts/story.md", "story"],
  ["artifacts/research-map.md", "research_map"],
  ["artifacts/design-brief.md", "design_brief"],
  ["artifacts/technical-brief.md", "technical_brief"],
  ["artifacts/test-report.md", "test_report"],
  ["artifacts/validation-report.md", "validation_report"],
  ["artifacts/pr-body.md", "pr_body"],
]);
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const CARRY_FORWARD_KEYS = new Set(["scope", "plan_ref", "plan_hash", "start_commit", "accepted_slices", "remaining_slice_ids"]);
const CARRY_FORWARD_ACCEPTED_KEYS = new Set(["id", "declared_paths", "effective_paths", "attempts", "attempt_reviews", "evidence_ref", "evidence_hash", "review_ref", "review_hash", "reviewed_commit", "merge_commit"]);
const CARRY_FORWARD_ACCEPTED_OPTIONAL_KEYS = new Set(["integration_conflict"]);
const SIBLING_EXTENSION_OWNER_BINDINGS = Object.freeze([
  ["owner_slice_id", "id"],
  ["owner_attempt", "attempts"],
  ["owner_evidence_ref", "evidence_ref"],
  ["owner_evidence_hash", "evidence_hash"],
  ["owner_review_ref", "review_ref"],
  ["owner_review_hash", "review_hash"],
  ["owner_reviewed_commit", "reviewed_commit"],
]);
const SIBLING_EXTENSION_ATTEMPT_BINDINGS = Object.freeze([
  ["owner_dispatch_claim_ref", "dispatch_claim_ref"],
  ["owner_dispatch_claim_hash", "dispatch_claim_hash"],
  ["owner_dispatch_closure_ref", "dispatch_closure_ref"],
  ["owner_dispatch_closure_hash", "dispatch_closure_hash"],
  ["owner_diff_base_commit", "diff_base_commit"],
]);

export function encodeFeatureCommandPayload(payload) {
  return `${PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

export function decodeFeatureCommandPayload(argumentsText, options = {}) {
  const text = String(argumentsText || "").trim();
  if (!text.startsWith(PREFIX)) return { ok: false, reason: "unencoded" };
  const encoded = text.slice(PREFIX.length);
  if (!BASE64URL_PATTERN.test(encoded)) return { ok: false, reason: "invalid-encoding" };

  let json;
  try {
    json = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return { ok: false, reason: "invalid-encoding" };
  }
  if (Buffer.from(json, "utf8").toString("base64url") !== encoded) return { ok: false, reason: "non-canonical-encoding" };

  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  if (!plainObject(payload) || !nonEmptyString(payload.operator_request)) return { ok: false, reason: "invalid-envelope" };

  const driver = payload.driver === undefined ? {} : payload.driver;
  if (!plainObject(driver)) return { ok: false, reason: "invalid-driver" };
  if (!hasOnlyKeys(driver, DRIVER_KEYS)) return { ok: false, reason: "invalid-driver" };
  const mode = driver.mode === undefined ? "interactive" : driver.mode;
  if (!DRIVER_MODES.has(mode)) return { ok: false, reason: "invalid-driver-mode" };
  if (driver.pr_mode !== undefined && driver.pr_mode !== null && !["draft", "ready"].includes(driver.pr_mode)) return { ok: false, reason: "invalid-pr-mode" };
  if (driver.ready !== undefined && typeof driver.ready !== "boolean") return { ok: false, reason: "invalid-ready" };
  for (const field of ["reviewer", "github_account", "run_id"]) {
    if (driver[field] !== undefined && driver[field] !== null && !nonEmptyString(driver[field])) return { ok: false, reason: `invalid-driver-${field}` };
  }
  let postPrCi = null;
  try {
    postPrCi = normalizePostPrCiDriverOverride(driver.post_pr_ci);
  } catch {
    return { ok: false, reason: "invalid-driver-post-pr-ci" };
  }
  if (driver.run_id !== undefined && driver.run_id !== null && !safeRunId(driver.run_id)) return { ok: false, reason: "invalid-driver-run_id" };

  const hasResume = payload.resume !== undefined && payload.resume !== null;
  const hasSteering = payload.steering !== undefined && payload.steering !== null;
  const hasContinuation = payload.continuation !== undefined && payload.continuation !== null;
  if (["checkpoint", "checkpoint_reservation", "checkpoint_request"].some((key) => Object.hasOwn(payload, key))) {
    return { ok: false, reason: "unsupported-checkpoint-route" };
  }
  if (hasResume !== hasSteering) return { ok: false, reason: "incomplete-resume-route" };
  if (hasResume && hasContinuation) return { ok: false, reason: "ambiguous-route" };
  if (driver.run_id !== undefined && driver.run_id !== null && (hasResume || hasContinuation)) return { ok: false, reason: "invalid-driver-run-id-route" };
  if (hasContinuation && payload.continuation?.schema_version !== 2) return { ok: false, reason: "invalid-continuation-schema" };
  if (hasResume && payload.resume?.schema_version !== 2 && postPrCi !== null) return { ok: false, reason: "resume-post-pr-policy-override" };

  let continuation = null;
  if (hasContinuation) {
    const result = normalizeContinuation(payload.continuation, payload.operator_request.trim(), options.repo, driver);
    if (!result.ok) return result;
    continuation = result.value;
  }

  const normalized = {
    operator_request: payload.operator_request.trim(),
    driver: {
      mode,
      ready: driver.ready === true,
      pr_mode: driver.pr_mode ?? null,
      reviewer: stringOrNull(driver.reviewer),
      github_account: stringOrNull(driver.github_account),
      ...(continuation || payload.resume?.schema_version === 2 ? {} : { run_id: stringOrNull(driver.run_id) }),
      post_pr_ci: postPrCi,
    },
    resume: null,
    steering: null,
    continuation,
  };

  if (hasResume) {
    if (!plainObject(payload.resume) || !hasOnlyKeys(payload.resume, new Set(["schema_version", "kind", "run_id", "post_pr_policy"])) || ![1, 2].includes(payload.resume.schema_version) || payload.resume.kind !== "existing-run-resume" || !nonEmptyString(payload.resume.run_id)) {
      return { ok: false, reason: "invalid-resume" };
    }
    const runId = payload.resume.run_id.trim();
    if (!safeRunId(runId)) return { ok: false, reason: "invalid-resume-run-id" };
    if (normalized.operator_request !== `resume ${runId}`) return { ok: false, reason: "resume-request-mismatch" };
    let postPrPolicy = null;
    if (payload.resume.post_pr_policy !== undefined && payload.resume.post_pr_policy !== null) {
      try {
        validateRun({ schema_version: 1, run_id: runId, status: "running", max_retries: 3, gates: {}, post_pr: { schema_version: 1, policy: payload.resume.post_pr_policy, phase: payload.resume.post_pr_policy.enabled === true ? "awaiting-pr" : "disabled", attempt: 0, observation: null, remediation: null, evidence_refs: [], continuation_review: null, terminal_fact: null } });
        postPrPolicy = cloneJson(payload.resume.post_pr_policy);
      } catch {
        return { ok: false, reason: "invalid-resume-post-pr-policy" };
      }
    }
    normalized.resume = { schema_version: payload.resume.schema_version, kind: "existing-run-resume", run_id: runId, ...(postPrPolicy === null ? {} : { post_pr_policy: postPrPolicy }) };

    const steering = normalizeSteering(payload.steering, runId);
    if (!steering.ok) return steering;
    normalized.steering = steering.value;
  }

  if (normalized.continuation) {
    try {
      assertPublishedCarryForwardRun(options.repo, normalized.continuation, { driver: normalized.driver });
    } catch {
      return { ok: false, reason: "unpublished-or-mismatched-carry-forward" };
    }
  }
  if (normalized.resume?.schema_version === 2) {
    try {
      assertPublishedCarryForwardRunById(options.repo, normalized.resume.run_id, { driver: normalized.driver, postPrPolicy: normalized.resume.post_pr_policy });
    } catch {
      return { ok: false, reason: "unpublished-or-mismatched-carry-forward-resume" };
    }
  } else if (normalized.resume) {
    try {
      assertOrdinaryResumeRunById(options.repo, normalized.resume.run_id);
    } catch (error) {
      return { ok: false, reason: error?.code === "integration-amendment-continuation-unsupported" ? error.code : "resume-schema-route-mismatch" };
    }
  }

  return { ok: true, payload: normalized };
}

export function safePayloadValue(value) {
  return (JSON.stringify(value) ?? "null")
    .replaceAll("\u0085", "\\u0085")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function normalizeSteering(steering, runId) {
  if (!plainObject(steering) || !hasOnlyKeys(steering, STEERING_KEYS) || !Object.hasOwn(steering, "pending") || !Object.hasOwn(steering, "consume") || steering.schema_version !== 1 || steering.kind !== "operator-steering-pointer" || !nonEmptyString(steering.run_id) || steering.raw_message_included !== false) {
    return { ok: false, reason: "invalid-steering" };
  }
  if (runId !== steering.run_id.trim()) return { ok: false, reason: "run-id-mismatch" };

  const pending = steering.pending ?? null;
  const uncheckpointed = steering.uncheckpointed ?? null;
  const consume = steering.consume ?? null;
  if (pending !== null && uncheckpointed !== null) return { ok: false, reason: "ambiguous-steering-pointer" };
  const pointer = pending || uncheckpointed;
  if (pointer === null || consume === null) {
    if (pointer !== null || consume !== null) return { ok: false, reason: "incomplete-steering-pointer" };
    return { ok: true, value: { schema_version: 1, kind: "operator-steering-pointer", run_id: runId, pending: null, uncheckpointed: null, consume: null, raw_message_included: false } };
  }
  const pointerKeys = pending ? STEERING_PENDING_KEYS : STEERING_UNCHECKPOINTED_KEYS;
  if (!plainObject(pointer) || !hasOnlyKeys(pointer, pointerKeys) || !plainObject(consume) || !hasOnlyKeys(consume, STEERING_CONSUME_KEYS)) {
    return { ok: false, reason: "invalid-steering-pointer" };
  }

  try {
    validateRun({ schema_version: 1, run_id: runId, status: "running", gates: {}, steering: { schema_version: 1, pending, uncheckpointed, history: [] } });
  } catch {
    return { ok: false, reason: "invalid-steering-pending" };
  }
  if (!(pending ? safePendingRef(pointer.ref) : safeConsumedRef(pointer.ref)) || consume.command !== "feature-factory" || !Array.isArray(consume.args)) {
    return { ok: false, reason: "invalid-steering-consume" };
  }
  const expectedArgs = ["factory", "steer-consume", runId, "--ref", pointer.ref, "--hash", pointer.hash, "--json"];
  if (consume.args.length !== expectedArgs.length || consume.args.some((item, index) => item !== expectedArgs[index])) {
    return { ok: false, reason: "invalid-steering-consume" };
  }

  return {
    ok: true,
    value: {
      schema_version: 1,
      kind: "operator-steering-pointer",
      run_id: runId,
      pending: pending ? { id: pending.id, ref: pending.ref, hash: pending.hash, message_chars: pending.message_chars, created_at: pending.created_at } : null,
      uncheckpointed: uncheckpointed ? { id: uncheckpointed.id, ref: uncheckpointed.ref, hash: uncheckpointed.hash, message_chars: uncheckpointed.message_chars, created_at: uncheckpointed.created_at, consumed_at: uncheckpointed.consumed_at } : null,
      consume: { command: "feature-factory", args: expectedArgs },
      raw_message_included: false,
    },
  };
}

function normalizeContinuation(continuation, operatorRequest, repo, driver) {
  if (!plainObject(continuation) || continuation.schema_version !== 2 || !hasOnlyKeys(continuation, CONTINUATION_KEYS)) return { ok: false, reason: "invalid-continuation" };
  const { parent, review, target } = continuation;
  if (!plainObject(parent) || !hasOnlyKeys(parent, CONTINUATION_PARENT_KEYS)
    || !plainObject(review) || !hasOnlyKeys(review, CONTINUATION_REVIEW_KEYS)
    || !plainObject(target) || !hasOnlyKeys(target, CONTINUATION_TARGET_KEYS)) {
    return { ok: false, reason: "invalid-continuation" };
  }
  for (const items of [continuation.parent_artifacts, continuation.parent_evidence, continuation.parent_reviews]) {
    if (!Array.isArray(items) || items.some((item) => !plainObject(item) || !hasOnlyKeys(item, CONTINUATION_REF_KEYS))) return { ok: false, reason: "invalid-continuation-refs" };
  }

  const planningReuse = continuation.planning_reuse;
  if (planningReuse !== undefined) {
    const checkpointVariant = Object.hasOwn(continuation, "checkpoint_source_hash") && planningReuse?.eligible === true;
    const allowedPlanningKeys = checkpointVariant ? CHECKPOINT_CONTINUATION_PLANNING_REUSE_KEYS : CONTINUATION_PLANNING_REUSE_KEYS;
    if (!plainObject(planningReuse) || !hasOnlyKeys(planningReuse, allowedPlanningKeys) || planningReuse.eligible !== true) {
      return { ok: false, reason: "invalid-continuation-planning-reuse" };
    }
    if (checkpointVariant
      && (planningReuse.plan_ref !== "plan/slices.json"
        || planningReuse.plan_hash !== continuation.carry_forward?.plan_hash
        || planningReuse.review_ref !== "reviews/work-decomposer.json"
        || !SHA256_PATTERN.test(planningReuse.plan_hash || "")
        || !SHA256_PATTERN.test(planningReuse.review_hash || ""))) {
      return { ok: false, reason: "invalid-continuation-planning-reuse" };
    }
    if (!checkpointVariant && planningReuse.eligible
      && (!canonicalJsonRef(planningReuse.spec_review_ref, "reviews/")
        || planningReuse.child_spec_review_ref !== CONTINUATION_CHILD_SPEC_REVIEW_REF
        || planningReuse.spec_artifact_ref !== "artifacts/technical-brief.md"
        || !SHA256_PATTERN.test(planningReuse.spec_review_hash || "")
        || !SHA256_PATTERN.test(planningReuse.spec_artifact_hash || ""))) {
      return { ok: false, reason: "invalid-continuation-planning-reuse" };
    }
  }
  const carryForward = normalizeCarryForward(continuation);
  if (!carryForward.ok) return carryForward;

  try {
    const policy = { ...driver.post_pr_ci, review: driver.reviewer ? { required: true, reviewer_login: driver.reviewer, source: "driver" } : { required: false, reviewer_login: null, source: "none" } };
    validateRun({
      schema_version: 1,
      run_id: target.run_id,
      branch: target.branch,
      worktree: target.worktree,
      status: "running",
      mode: driver.mode, github_account: driver.github_account ?? null, pr_mode: driver.pr_mode, max_parallel_slices: 3, max_retries: 3,
      ...(continuation.configuration?.review_tier === null || continuation.configuration?.review_tier === undefined ? {} : { review_tier: continuation.configuration.review_tier }),
      post_pr: { schema_version: 1, policy, phase: policy.enabled ? "awaiting-pr" : "disabled", attempt: 0, observation: null, remediation: null, evidence_refs: [], continuation_review: null, terminal_fact: null, pr_operation: null },
      gates: {},
      continuation,
    });
  } catch {
    return { ok: false, reason: "invalid-continuation-schema" };
  }

  if (!safeRunId(parent.run_id) || !safeRunId(target.run_id) || target.branch !== target.run_id || parent.run_id === target.run_id) return { ok: false, reason: "invalid-continuation-route" };
  const targetWorktree = continuationTargetWorktree(repo, target.run_id);
  if (!targetWorktree) return { ok: false, reason: "invalid-continuation-context" };
  if (!CONTINUATION_REVIEW_KINDS.has(review.kind) || !validContinuationReviewSource(review.kind, review.source)) return { ok: false, reason: "invalid-continuation-review" };
  if (parent.run_ref !== `.opencode/factory/${parent.run_id}/run.json`
    || !canonicalJsonRef(review.ref, "reviews/")
    || target.worktree !== targetWorktree
    || !COMMIT_PATTERN.test(parent.commit)
    || !COMMIT_PATTERN.test(target.base_commit)
    || continuation.parent_artifacts.some((item) => CONTINUATION_ARTIFACT_KINDS.get(item.ref) !== item.kind)
    || continuation.parent_evidence.some((item) => item.kind !== "evidence" || !canonicalJsonRef(item.ref, "evidence/"))
    || continuation.parent_reviews.some((item) => item.kind !== "review" || !canonicalJsonRef(item.ref, "reviews/"))) {
    return { ok: false, reason: "invalid-continuation-refs" };
  }
  const expectedRequest = `Continue blocked feature-factory run '${parent.run_id}' as '${target.run_id}' using review '${review.ref}'.`;
  if (operatorRequest !== expectedRequest || continuation.operator_summary !== `Continue blocked run '${parent.run_id}' from ${review.ref}.`) {
    return { ok: false, reason: "continuation-request-mismatch" };
  }
  try {
    assertContinuationReservationAuthority(repo, continuation);
  } catch {
    return { ok: false, reason: "continuation-schema-route-mismatch" };
  }
  return {
    ok: true,
    value: {
      kind: "blocked-run-continuation",
      schema_version: continuation.schema_version,
      created_at: continuation.created_at,
      operator_summary: continuation.operator_summary,
      parent: {
        run_id: parent.run_id,
        status: "blocked",
        run_ref: parent.run_ref,
        run_hash: parent.run_hash,
        branch: parent.branch,
        commit: parent.commit,
        worktree: parent.worktree,
      },
      review: {
        kind: review.kind,
        ref: review.ref,
        hash: review.hash,
        subject: review.subject,
        summary: review.summary ?? null,
        required_fixes: Array.isArray(review.required_fixes) ? [...review.required_fixes] : [],
        ...(review.verdict === undefined ? {} : { verdict: review.verdict }),
        ...(review.source === undefined ? {} : { source: review.source }),
      },
      target: {
        run_id: target.run_id,
        branch: target.branch,
        worktree: targetWorktree,
        base_ref: target.base_ref,
        base_commit: target.base_commit,
      },
      parent_artifacts: continuation.parent_artifacts.map(normalizedRefHash),
      parent_evidence: continuation.parent_evidence.map(normalizedRefHash),
      parent_reviews: continuation.parent_reviews.map(normalizedRefHash),
      ...(planningReuse === undefined ? {} : { planning_reuse: normalizedPlanningReuse(planningReuse) }),
      configuration: cloneJson(continuation.configuration),
      ...(continuation.checkpoint_source_hash === undefined ? {} : { checkpoint_source_hash: continuation.checkpoint_source_hash }),
      ...(continuation.configuration_hash === undefined ? {} : { configuration_hash: continuation.configuration_hash }),
      carry_forward: carryForward.value,
    },
  };
}

function normalizeCarryForward(continuation) {
  const value = continuation.carry_forward;
  if (!plainObject(value) || !hasOnlyKeys(value, CARRY_FORWARD_KEYS)
    || value.scope !== "full-remaining-plan" || value.plan_ref !== "plan/slices.json" || !SHA256_PATTERN.test(value.plan_hash || "")
    || !COMMIT_PATTERN.test(value.start_commit || "") || value.start_commit !== continuation.parent?.commit
    || !Array.isArray(value.accepted_slices) || !Array.isArray(value.remaining_slice_ids) || value.remaining_slice_ids.length === 0
    || continuation.planning_reuse?.eligible !== true) {
    return { ok: false, reason: "invalid-continuation-carry-forward" };
  }
  const accepted = new Set();
  for (const row of value.accepted_slices) {
    if (!plainObject(row) || !hasRequiredAndOptionalKeys(row, CARRY_FORWARD_ACCEPTED_KEYS, CARRY_FORWARD_ACCEPTED_OPTIONAL_KEYS) || !nonEmptyString(row.id) || accepted.has(row.id)
      || !validOwnershipPaths(row.declared_paths) || !validOwnershipPaths(row.effective_paths)
      || !Number.isInteger(row.attempts) || row.attempts < 1 || !canonicalJsonRef(row.evidence_ref, "evidence/") || !canonicalJsonRef(row.review_ref, "reviews/")
      || !SHA256_PATTERN.test(row.evidence_hash || "") || !SHA256_PATTERN.test(row.review_hash || "") || !COMMIT_PATTERN.test(row.reviewed_commit || "") || !COMMIT_PATTERN.test(row.merge_commit || "")
      || !validAcceptedAttemptHistory(row)) {
      return { ok: false, reason: "invalid-continuation-carry-forward" };
    }
    accepted.add(row.id);
  }
  const remaining = new Set();
  for (const id of value.remaining_slice_ids) {
    if (!nonEmptyString(id) || accepted.has(id) || remaining.has(id)) return { ok: false, reason: "invalid-continuation-carry-forward" };
    remaining.add(id);
  }
  try {
    assertCarryForwardSiblingOwnerPairs(value);
  } catch {
    return { ok: false, reason: "invalid-continuation-carry-forward" };
  }
  return { ok: true, value: cloneJson(value) };
}

export function assertCarryForwardSiblingOwnerPairs(carryForward) {
  if (!plainObject(carryForward) || !Array.isArray(carryForward.accepted_slices)) {
    throw new Error("carry-forward sibling authority requires accepted_slices");
  }
  const accepted = new Map();
  for (const row of carryForward.accepted_slices) {
    if (!plainObject(row) || !nonEmptyString(row.id) || accepted.has(row.id)) {
      throw new Error("carry-forward accepted slice identities must be unique");
    }
    accepted.set(row.id, row);
  }
  for (const modifier of carryForward.accepted_slices) {
    for (const attempt of Array.isArray(modifier.attempt_reviews) ? modifier.attempt_reviews : []) {
      for (const extension of Array.isArray(attempt.modified_extensions) ? attempt.modified_extensions : []) {
        if (extension?.authority !== "non-conflicting-sibling") continue;
        const owner = accepted.get(extension.owner_slice_id);
        if (!owner || owner === modifier) {
          throw new Error(`carry-forward slice '${modifier.id}' requires same-binding merged sibling owner '${extension.owner_slice_id || "<missing>"}'`);
        }
        const ownerAttempt = Array.isArray(owner.attempt_reviews) ? owner.attempt_reviews.at(-1) : null;
        if (!ownerAttempt || ownerAttempt.attempt !== owner.attempts || ownerAttempt.verdict !== "APPROVE") {
          throw new Error(`carry-forward sibling owner '${owner.id}' lacks its current merged APPROVE binding`);
        }
        for (const [extensionKey, ownerKey] of SIBLING_EXTENSION_OWNER_BINDINGS) {
          if (extension[extensionKey] !== owner[ownerKey]) {
            throw new Error(`carry-forward sibling owner '${owner.id}' ${extensionKey} is stale or cross-bound`);
          }
        }
        for (const [extensionKey, ownerKey] of SIBLING_EXTENSION_ATTEMPT_BINDINGS) {
          if (extension[extensionKey] !== ownerAttempt[ownerKey]) {
            throw new Error(`carry-forward sibling owner '${owner.id}' ${extensionKey} is stale or cross-bound`);
          }
        }
        if (!Array.isArray(owner.declared_paths) || !owner.declared_paths.some((lane) => ownershipLaneContains(lane, extension.path))) {
          throw new Error(`carry-forward sibling owner '${owner.id}' does not own '${extension.path}' in its declared binding`);
        }
      }
    }
  }
  return carryForward;
}

function ownershipLaneContains(lane, path) {
  if (!nonEmptyString(lane) || !nonEmptyString(path)) return false;
  return lane.endsWith("/**") ? path.startsWith(`${lane.slice(0, -3)}/`) : path === lane;
}

function validOwnershipPaths(paths) {
  return Array.isArray(paths) && paths.length > 0 && paths.every((path) => nonEmptyString(path)) && new Set(paths).size === paths.length;
}

function hasRequiredAndOptionalKeys(value, required, optional) {
  const keys = Object.keys(value);
  return [...required].every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.has(key) || optional.has(key));
}

function validAcceptedAttemptHistory(row) {
  if (!Array.isArray(row.attempt_reviews) || row.attempt_reviews.length !== row.attempts) return false;
  const current = row.attempt_reviews.at(-1);
  return plainObject(current) && current.attempt === row.attempts
    && current.evidence_ref === row.evidence_ref && current.evidence_hash === row.evidence_hash
    && current.review_ref === row.review_ref && current.review_hash === row.review_hash
    && current.reviewed_commit === row.reviewed_commit;
}

function normalizedPlanningReuse(planningReuse) {
  if (Object.hasOwn(planningReuse, "plan_ref")) {
    return {
      eligible: true,
      plan_ref: planningReuse.plan_ref,
      plan_hash: planningReuse.plan_hash,
      review_ref: planningReuse.review_ref,
      review_hash: planningReuse.review_hash,
    };
  }
  return {
    eligible: true,
    spec_review_ref: planningReuse.spec_review_ref,
    spec_review_hash: planningReuse.spec_review_hash,
    spec_artifact_ref: planningReuse.spec_artifact_ref,
    spec_artifact_hash: planningReuse.spec_artifact_hash,
    child_spec_review_ref: planningReuse.child_spec_review_ref,
  };
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeRunId(value) {
  return nonEmptyString(value) && SAFE_RUN_ID_PATTERN.test(value) && !value.includes("..") && !value.endsWith(".lock");
}

function safeRelativeRef(value, prefix) {
  return nonEmptyString(value) && value.startsWith(prefix) && !value.includes("\\") && !value.split("/").includes("..");
}

function canonicalJsonRef(value, prefix) {
  return canonicalFileRef(value, prefix) && value.endsWith(".json");
}

function canonicalFileRef(value, prefix) {
  if (!safeRelativeRef(value, prefix) || value !== value.trim()) return false;
  const segments = value.split("/");
  return segments.length >= 2 && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") && basename(value).includes(".") && !basename(value).endsWith(".");
}

function continuationTargetWorktree(repo, runId) {
  if (!nonEmptyString(repo)) return null;
  return resolve(repo, ".opencode", "worktrees", runId);
}

function normalizedRefHash(item) {
  return { kind: item.kind, ref: item.ref, hash: item.hash };
}

function safePendingRef(value) {
  return safeRelativeRef(value, "steering/") && /^steering\/pending-[^/]+\.json$/u.test(value);
}

function safeConsumedRef(value) {
  return safeRelativeRef(value, "steering/") && /^steering\/consumed-[^/]+\.json$/u.test(value);
}

function validContinuationReviewSource(kind, source) {
  if (!nonEmptyString(source)) return false;
  if (kind === "validator") return source === "run.validator.review_ref";
  if (kind === "security_review") return source === "run.security_review.review_ref";
  if (kind === "step") return source.startsWith("run.steps.") && source.endsWith(".review_ref") && source.length > "run.steps..review_ref".length;
  if (kind === "slice") return source === "run.terminal_result.nonconvergence.source_review.review_ref"
    || source.startsWith("run.slices.") && source.endsWith(".review_ref") && source.length > "run.slices..review_ref".length;
  return false;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringOrNull(value) {
  return nonEmptyString(value) ? value.trim() : null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
