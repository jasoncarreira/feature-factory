import { basename, resolve } from "node:path";
import { validateRun } from "./validate.js";
import { normalizePostPrCiDriverOverride } from "./config.js";

const PREFIX = "ffpayload-v1:";
const DRIVER_MODES = new Set(["interactive", "headless", "autonomous"]);
const DRIVER_KEYS = new Set(["mode", "ready", "pr_mode", "reviewer", "github_account", "run_id", "post_pr_ci"]);
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const CONTINUATION_KEYS = new Set(["kind", "schema_version", "created_at", "operator_summary", "parent", "review", "target", "parent_artifacts", "parent_evidence", "parent_reviews", "planning_reuse", "draft_spec_reuse", "post_pr"]);
const CONTINUATION_PLANNING_REUSE_KEYS = new Set(["eligible", "reason", "spec_review_ref", "spec_review_hash", "spec_artifact_ref", "spec_artifact_hash", "child_spec_review_ref"]);
const CONTINUATION_DRAFT_SPEC_REUSE_KEYS = new Set(["artifact_ref", "artifact_hash", "parent_step_status", "parent_step_attempts", "max_retries", "remaining_attempts"]);
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
const CONTINUATION_REVIEW_KINDS = new Set(["validator", "security_review", "step", "slice", "post_pr"]);
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
  if (hasResume !== hasSteering) return { ok: false, reason: "incomplete-resume-route" };
  if (hasResume && hasContinuation) return { ok: false, reason: "ambiguous-route" };
  if (driver.run_id !== undefined && driver.run_id !== null && (hasResume || hasContinuation)) return { ok: false, reason: "invalid-driver-run-id-route" };
  if (hasResume && postPrCi !== null) return { ok: false, reason: "resume-post-pr-policy-override" };

  let continuation = null;
  if (hasContinuation) {
    const result = normalizeContinuation(payload.continuation, payload.operator_request.trim(), options.repo);
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
      run_id: stringOrNull(driver.run_id),
      post_pr_ci: postPrCi,
    },
    resume: null,
    steering: null,
    continuation,
  };

  if (hasResume) {
    if (!plainObject(payload.resume) || !hasOnlyKeys(payload.resume, new Set(["schema_version", "kind", "run_id", "post_pr_policy"])) || payload.resume.schema_version !== 1 || payload.resume.kind !== "existing-run-resume" || !nonEmptyString(payload.resume.run_id)) {
      return { ok: false, reason: "invalid-resume" };
    }
    const runId = payload.resume.run_id.trim();
    if (!safeRunId(runId)) return { ok: false, reason: "invalid-resume-run-id" };
    if (normalized.operator_request !== `resume ${runId}`) return { ok: false, reason: "resume-request-mismatch" };
    let postPrPolicy = null;
    if (payload.resume.post_pr_policy !== undefined && payload.resume.post_pr_policy !== null) {
      try {
        validateRun({ schema_version: 1, run_id: runId, status: "running", max_retries: 3, gates: {}, post_pr: { schema_version: 1, policy: payload.resume.post_pr_policy, phase: payload.resume.post_pr_policy.enabled === true ? "awaiting-pr" : "disabled", attempt: 0, observation: null, remediation: null, evidence_refs: [], continuation_review: null } });
        postPrPolicy = cloneJson(payload.resume.post_pr_policy);
      } catch {
        return { ok: false, reason: "invalid-resume-post-pr-policy" };
      }
    }
    normalized.resume = { schema_version: 1, kind: "existing-run-resume", run_id: runId, ...(postPrPolicy === null ? {} : { post_pr_policy: postPrPolicy }) };

    const steering = normalizeSteering(payload.steering, runId);
    if (!steering.ok) return steering;
    normalized.steering = steering.value;
  }

  return { ok: true, payload: normalized };
}

export function safePayloadValue(value) {
  return JSON.stringify(value)
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

function normalizeContinuation(continuation, operatorRequest, repo) {
  if (!plainObject(continuation) || !hasOnlyKeys(continuation, CONTINUATION_KEYS)) return { ok: false, reason: "invalid-continuation" };
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
    if (!plainObject(planningReuse) || !hasOnlyKeys(planningReuse, CONTINUATION_PLANNING_REUSE_KEYS) || typeof planningReuse.eligible !== "boolean") {
      return { ok: false, reason: "invalid-continuation-planning-reuse" };
    }
    if (planningReuse.eligible
      && (!canonicalJsonRef(planningReuse.spec_review_ref, "reviews/")
        || planningReuse.child_spec_review_ref !== CONTINUATION_CHILD_SPEC_REVIEW_REF
        || planningReuse.spec_artifact_ref !== "artifacts/technical-brief.md"
        || !SHA256_PATTERN.test(planningReuse.spec_review_hash || "")
        || !SHA256_PATTERN.test(planningReuse.spec_artifact_hash || ""))) {
      return { ok: false, reason: "invalid-continuation-planning-reuse" };
    }
  }
  const draftSpecReuse = continuation.draft_spec_reuse;
  if (draftSpecReuse !== undefined) {
    if (!plainObject(draftSpecReuse)
      || !hasOnlyKeys(draftSpecReuse, CONTINUATION_DRAFT_SPEC_REUSE_KEYS)
      || draftSpecReuse.artifact_ref !== "artifacts/technical-brief.md"
      || !SHA256_PATTERN.test(draftSpecReuse.artifact_hash || "")
      || !["rejected", "blocked"].includes(draftSpecReuse.parent_step_status)
      || !Number.isInteger(draftSpecReuse.parent_step_attempts)
      || draftSpecReuse.parent_step_attempts < 0
      || !Number.isInteger(draftSpecReuse.max_retries)
      || draftSpecReuse.max_retries < 1
      || !Number.isInteger(draftSpecReuse.remaining_attempts)
      || draftSpecReuse.remaining_attempts !== draftSpecReuse.max_retries - draftSpecReuse.parent_step_attempts
      || draftSpecReuse.remaining_attempts < 1
      || planningReuse?.eligible === true) {
      return { ok: false, reason: "invalid-continuation-draft-spec-reuse" };
    }
  }

  try {
    validateRun({
      schema_version: 1,
      run_id: target.run_id,
      branch: target.branch,
      worktree: target.worktree,
      status: "running",
      ...(draftSpecReuse === undefined ? {} : { max_retries: draftSpecReuse.max_retries }),
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
  if (review.kind === "post_pr") {
    const postPr = continuation.post_pr;
    const evidence = continuation.parent_evidence.find((item) => item.ref === postPr?.evidence_ref);
    if (!plainObject(postPr)
      || review.source !== "run.post_pr.continuation_review.ref"
      || review.ref !== postPr.continuation_review_ref
      || review.hash !== postPr.continuation_review_hash
      || !evidence
      || evidence.hash !== postPr.evidence_hash
      || postPr.disposition !== "leave-unchanged") return { ok: false, reason: "invalid-continuation-post-pr-binding" };
  } else if (continuation.post_pr !== undefined) return { ok: false, reason: "invalid-continuation-post-pr-binding" };
  const expectedRequest = `Continue blocked feature-factory run '${parent.run_id}' as '${target.run_id}' using review '${review.ref}'.`;
  if (operatorRequest !== expectedRequest || continuation.operator_summary !== `Continue blocked run '${parent.run_id}' from ${review.ref}.`) {
    return { ok: false, reason: "continuation-request-mismatch" };
  }
  return {
    ok: true,
    value: {
      kind: "blocked-run-continuation",
      schema_version: 1,
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
        ...(review.source === undefined ? {} : { source: review.source }),
        ...(review.verdict === undefined ? {} : { verdict: review.verdict }),
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
      ...(draftSpecReuse === undefined ? {} : { draft_spec_reuse: cloneJson(draftSpecReuse) }),
      ...(continuation.post_pr === undefined ? {} : { post_pr: cloneJson(continuation.post_pr) }),
    },
  };
}

function normalizedPlanningReuse(planningReuse) {
  if (!planningReuse.eligible) {
    return { eligible: false, ...(nonEmptyString(planningReuse.reason) ? { reason: planningReuse.reason } : {}) };
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
  if (kind === "slice") return source.startsWith("run.slices.") && source.endsWith(".review_ref") && source.length > "run.slices..review_ref".length;
  if (kind === "post_pr") return source === "run.post_pr.continuation_review.ref";
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
