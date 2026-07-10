import { validateRun } from "./validate.js";

const PREFIX = "ffpayload-v1:";
const DRIVER_MODES = new Set(["interactive", "headless", "autonomous"]);
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const CONTINUATION_KEYS = new Set(["kind", "schema_version", "created_at", "operator_summary", "parent", "review", "target", "parent_artifacts", "parent_evidence", "parent_reviews"]);
const CONTINUATION_PARENT_KEYS = new Set(["run_id", "status", "run_ref", "run_hash", "branch", "commit", "worktree"]);
const CONTINUATION_REVIEW_KEYS = new Set(["kind", "ref", "hash", "subject", "summary", "required_fixes", "source", "verdict"]);
const CONTINUATION_TARGET_KEYS = new Set(["run_id", "branch", "worktree", "base_ref", "base_commit"]);
const CONTINUATION_REF_KEYS = new Set(["kind", "ref", "hash"]);
const STEERING_KEYS = new Set(["schema_version", "kind", "run_id", "pending", "consume", "raw_message_included"]);
const STEERING_PENDING_KEYS = new Set(["id", "ref", "hash", "message_chars", "created_at"]);
const STEERING_CONSUME_KEYS = new Set(["command", "args"]);
const CONTINUATION_REVIEW_KINDS = new Set(["validator", "security_review", "step", "slice"]);

export function encodeFeatureCommandPayload(payload) {
  return `${PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

export function decodeFeatureCommandPayload(argumentsText) {
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
  const mode = driver.mode === undefined ? "interactive" : driver.mode;
  if (!DRIVER_MODES.has(mode)) return { ok: false, reason: "invalid-driver-mode" };
  if (driver.pr_mode !== undefined && driver.pr_mode !== null && !["draft", "ready"].includes(driver.pr_mode)) return { ok: false, reason: "invalid-pr-mode" };
  if (driver.ready !== undefined && typeof driver.ready !== "boolean") return { ok: false, reason: "invalid-ready" };
  for (const field of ["reviewer", "github_account", "run_id"]) {
    if (driver[field] !== undefined && driver[field] !== null && !nonEmptyString(driver[field])) return { ok: false, reason: `invalid-driver-${field}` };
  }
  if (driver.run_id !== undefined && driver.run_id !== null && !safeRunId(driver.run_id)) return { ok: false, reason: "invalid-driver-run_id" };

  const hasResume = payload.resume !== undefined && payload.resume !== null;
  const hasSteering = payload.steering !== undefined && payload.steering !== null;
  const hasContinuation = payload.continuation !== undefined && payload.continuation !== null;
  if (hasResume !== hasSteering) return { ok: false, reason: "incomplete-resume-route" };
  if (hasResume && hasContinuation) return { ok: false, reason: "ambiguous-route" };
  if (driver.run_id !== undefined && driver.run_id !== null && (hasResume || hasContinuation)) return { ok: false, reason: "invalid-driver-run-id-route" };

  let continuation = null;
  if (hasContinuation) {
    const result = normalizeContinuation(payload.continuation, payload.operator_request.trim());
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
    },
    resume: null,
    steering: null,
    continuation,
  };

  if (hasResume) {
    if (!plainObject(payload.resume) || payload.resume.schema_version !== 1 || payload.resume.kind !== "existing-run-resume" || !nonEmptyString(payload.resume.run_id)) {
      return { ok: false, reason: "invalid-resume" };
    }
    const runId = payload.resume.run_id.trim();
    if (!safeRunId(runId)) return { ok: false, reason: "invalid-resume-run-id" };
    if (normalized.operator_request !== `resume ${runId}`) return { ok: false, reason: "resume-request-mismatch" };
    normalized.resume = { schema_version: 1, kind: "existing-run-resume", run_id: runId };

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
  const consume = steering.consume ?? null;
  if (pending === null || consume === null) {
    if (pending !== null || consume !== null) return { ok: false, reason: "incomplete-steering-pointer" };
    return { ok: true, value: { schema_version: 1, kind: "operator-steering-pointer", run_id: runId, pending: null, consume: null, raw_message_included: false } };
  }
  if (!plainObject(pending) || !hasOnlyKeys(pending, STEERING_PENDING_KEYS) || !plainObject(consume) || !hasOnlyKeys(consume, STEERING_CONSUME_KEYS)) {
    return { ok: false, reason: "invalid-steering-pointer" };
  }

  try {
    validateRun({ schema_version: 1, run_id: runId, status: "running", gates: {}, steering: { schema_version: 1, pending, history: [] } });
  } catch {
    return { ok: false, reason: "invalid-steering-pending" };
  }
  if (!safePendingRef(pending.ref) || consume.command !== "feature-factory" || !Array.isArray(consume.args)) {
    return { ok: false, reason: "invalid-steering-consume" };
  }
  const expectedArgs = ["factory", "steer-consume", runId, "--ref", pending.ref, "--hash", pending.hash, "--json"];
  if (consume.args.length !== expectedArgs.length || consume.args.some((item, index) => item !== expectedArgs[index])) {
    return { ok: false, reason: "invalid-steering-consume" };
  }

  return {
    ok: true,
    value: {
      schema_version: 1,
      kind: "operator-steering-pointer",
      run_id: runId,
      pending: { id: pending.id, ref: pending.ref, hash: pending.hash, message_chars: pending.message_chars, created_at: pending.created_at },
      consume: { command: "feature-factory", args: expectedArgs },
      raw_message_included: false,
    },
  };
}

function normalizeContinuation(continuation, operatorRequest) {
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

  try {
    validateRun({
      schema_version: 1,
      run_id: target.run_id,
      branch: target.branch,
      worktree: target.worktree,
      status: "running",
      gates: {},
      continuation,
    });
  } catch {
    return { ok: false, reason: "invalid-continuation-schema" };
  }

  if (!safeRunId(parent.run_id) || !safeRunId(target.run_id) || target.branch !== target.run_id || parent.run_id === target.run_id) return { ok: false, reason: "invalid-continuation-route" };
  if (!CONTINUATION_REVIEW_KINDS.has(review.kind) || !validContinuationReviewSource(review.kind, review.source)) return { ok: false, reason: "invalid-continuation-review" };
  if (parent.run_ref !== `.opencode/factory/${parent.run_id}/run.json`
    || !safeRelativeRef(review.ref, "reviews/")
    || continuation.parent_artifacts.some((item) => !safeRelativeRef(item.ref, "artifacts/"))
    || continuation.parent_evidence.some((item) => !safeRelativeRef(item.ref, "evidence/"))
    || continuation.parent_reviews.some((item) => !safeRelativeRef(item.ref, "reviews/"))) {
    return { ok: false, reason: "invalid-continuation-refs" };
  }
  const expectedRequest = `Continue blocked feature-factory run '${parent.run_id}' as '${target.run_id}' using review '${review.ref}'.`;
  if (operatorRequest !== expectedRequest || continuation.operator_summary !== `Continue blocked run '${parent.run_id}' from ${review.ref}.`) {
    return { ok: false, reason: "continuation-request-mismatch" };
  }
  return { ok: true, value: continuation };
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

function safePendingRef(value) {
  return safeRelativeRef(value, "steering/") && /^steering\/pending-[^/]+\.json$/u.test(value);
}

function validContinuationReviewSource(kind, source) {
  if (!nonEmptyString(source)) return false;
  if (kind === "validator") return source === "run.validator.review_ref";
  if (kind === "security_review") return source === "run.security_review.review_ref";
  if (kind === "step") return source.startsWith("run.steps.") && source.endsWith(".review_ref") && source.length > "run.steps..review_ref".length;
  if (kind === "slice") return source.startsWith("run.slices.") && source.endsWith(".review_ref") && source.length > "run.slices..review_ref".length;
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
