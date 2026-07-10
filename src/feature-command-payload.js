const PREFIX = "ffpayload-v1:";
const DRIVER_MODES = new Set(["interactive", "headless", "autonomous"]);
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

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

  const hasResume = payload.resume !== undefined;
  const hasSteering = payload.steering !== undefined;
  const hasContinuation = payload.continuation !== undefined;
  if (hasResume !== hasSteering) return { ok: false, reason: "incomplete-resume-route" };
  if (hasResume && hasContinuation) return { ok: false, reason: "ambiguous-route" };
  if (driver.run_id !== undefined && driver.run_id !== null && (hasResume || hasContinuation)) return { ok: false, reason: "invalid-driver-run-id-route" };
  if (hasContinuation && !plainObject(payload.continuation)) return { ok: false, reason: "invalid-continuation" };

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
    continuation: hasContinuation ? payload.continuation : null,
  };

  if (hasResume) {
    if (!plainObject(payload.resume) || payload.resume.schema_version !== 1 || payload.resume.kind !== "existing-run-resume" || !nonEmptyString(payload.resume.run_id)) {
      return { ok: false, reason: "invalid-resume" };
    }
    const runId = payload.resume.run_id.trim();
    if (normalized.operator_request !== `resume ${runId}`) return { ok: false, reason: "resume-request-mismatch" };
    normalized.resume = { schema_version: 1, kind: "existing-run-resume", run_id: runId };

    if (!plainObject(payload.steering) || payload.steering.schema_version !== 1 || payload.steering.kind !== "operator-steering-pointer" || !nonEmptyString(payload.steering.run_id) || payload.steering.raw_message_included !== false) {
      return { ok: false, reason: "invalid-steering" };
    }
    if (runId !== payload.steering.run_id.trim()) return { ok: false, reason: "run-id-mismatch" };
    if (!(payload.steering.pending === null || plainObject(payload.steering.pending))) return { ok: false, reason: "invalid-steering-pending" };
    if (!(payload.steering.consume === null || plainObject(payload.steering.consume))) return { ok: false, reason: "invalid-steering-consume" };
    normalized.steering = {
      schema_version: 1,
      kind: "operator-steering-pointer",
      run_id: runId,
      pending: payload.steering.pending,
      consume: payload.steering.consume,
      raw_message_included: false,
    };
  }

  return { ok: true, payload: normalized };
}

export function safePayloadValue(value) {
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
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
