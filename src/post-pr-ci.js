import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { types as utilTypes } from "node:util";

export const GITHUB_LIMITS = Object.freeze({
  switch: Object.freeze({ timeoutMs: 10_000, stdoutCap: 16 * 1024, stderrCap: 16 * 1024 }),
  verdict: Object.freeze({ timeoutMs: 30_000, stdoutCap: 1024 * 1024, stderrCap: 64 * 1024 }),
  reviewer: Object.freeze({ timeoutMs: 30_000, stdoutCap: 1024 * 1024, stderrCap: 64 * 1024 }),
  ownershipPage: Object.freeze({ timeoutMs: 20_000, stdoutCap: 512 * 1024, stderrCap: 64 * 1024 }),
});

const CHECK_PENDING = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"]);
const CHECK_PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const CHECK_RED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const HTTP_TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const TEST_PREFIXES = ["test/", ".github/workflows/"];
const UNSAFE_RUNTIME_PATHS = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  ".nvmrc", ".node-version", ".npmrc", ".yarnrc", ".yarnrc.yml", "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
]);
const STACK_ROUTES = Object.freeze({ backend: "backend-builder", frontend: "frontend-builder" });
const OWNERSHIP_REASONS = new Set(["review-changes-requested", "check-owner-ambiguous", "check-owner-conflict", "changed-files-incomplete",
  "unsafe-path-or-change", "check-file-conflict", "unknown-slice-stack", "path-owner-ambiguous", "integration-fallback", "check-slice-id", "changed-files"]);
const PANEL_VERDICTS = Object.freeze({ validator: new Set(["GO", "GO-WITH-NITS", "NO-GO"]), security: new Set(["PASS", "BLOCK"]) });
const AFFECTED_LIMITS = Object.freeze({ depth: 32, occurrences: 8_192, entries: 8_192, arrayLength: 4_096, stringBytes: 4_096, totalStringBytes: 1_048_576, emittedBytes: 1_048_576 });
export const EMPTY_AFFECTED_PATHS_HASH = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

export class PostPrCiError extends Error {
  constructor(errorClass, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "PostPrCiError";
    this.errorClass = errorClass;
    this.transient = Boolean(options.transient);
    this.rateLimited = Boolean(options.rateLimited);
    this.exitCode = Number.isInteger(options.exitCode) ? options.exitCode : null;
    this.retryAfterMs = Number.isInteger(options.retryAfterMs) && options.retryAfterMs >= 0 ? options.retryAfterMs : 0;
  }
}

/**
 * Inspect a successful panel transport without reading inherited properties or
 * invoking accessors/proxy traps. `absent` is intentionally distinct from a
 * present malformed value because only the former has an unknown dispatch
 * outcome.
 */
export function inspectPanelRunnerResult(outer, activity) {
  panelVocabulary(activity);
  if (!isReflectableRecord(outer)) return { disposition: "absent" };
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(outer, "result"); } catch { return { disposition: "absent" }; }
  if (descriptor === undefined) return { disposition: "absent" };
  if (!("value" in descriptor)) return { disposition: "malformed", issue: "non-object" };
  const classified = classifyPanelResult(descriptor.value, activity);
  return classified.ok ? { disposition: "valid", ...classified } : { disposition: "malformed", issue: classified.issue };
}

export function inspectPanelRunnerReturn(outer, activity) {
  panelVocabulary(activity);
  if (!isReflectableRecord(outer)) return { disposition: "transport-unknown" };
  try {
    const started = Object.getOwnPropertyDescriptor(outer, "started");
    const exitCode = Object.getOwnPropertyDescriptor(outer, "exit_code");
    const signal = Object.getOwnPropertyDescriptor(outer, "signal");
    if (!started || !("value" in started) || started.value !== true || !exitCode || !("value" in exitCode) || exitCode.value !== 0 || !signal || !("value" in signal) || signal.value !== null) return { disposition: "transport-unknown" };
  } catch { return { disposition: "transport-unknown" }; }
  return inspectPanelRunnerResult(outer, activity);
}

/** Side-effect-free own-descriptor classifier for validator/security results. */
export function classifyPanelResult(value, activity) {
  const vocabulary = panelVocabulary(activity);
  if (!isAdmissibleRecord(value)) return { ok: false, issue: "non-object" };
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { return { ok: false, issue: "non-object" }; }
  const hasVerdict = keys.some((key) => key === "verdict");
  if (!hasVerdict) return { ok: false, issue: "missing-verdict" };
  let verdictDescriptor;
  let affectedDescriptor;
  try {
    for (const key of keys) {
      if (typeof key === "symbol" || key !== "verdict" && key !== "affected_paths") return { ok: false, issue: "unexpected-result-keys" };
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return { ok: false, issue: "unexpected-result-keys" };
      if (key === "verdict") verdictDescriptor = descriptor;
      else affectedDescriptor = descriptor;
    }
  } catch { return { ok: false, issue: "unexpected-result-keys" }; }
  if (typeof verdictDescriptor?.value !== "string" || !vocabulary.has(verdictDescriptor.value)) return { ok: false, issue: "invalid-verdict" };
  return { ok: true, verdict: verdictDescriptor.value, affectedDescriptor: affectedDescriptor ?? null };
}

/**
 * Copy an untrusted affected_paths value into a bounded primitive graph. The
 * returned graph has no accessors, proxies, prototypes with behavior, or
 * callable JSON hooks and is therefore safe to serialize.
 */
export function snapshotPanelAffectedValue(descriptor) {
  if (descriptor === null || descriptor === undefined) return { ok: false, category: "missing-paths" };
  if (!("value" in descriptor)) return { ok: false, category: "missing-paths" };
  const counters = { occurrences: 0, entries: 0, stringBytes: 0 };
  try {
    const value = copyAffectedValue(descriptor.value, 0, new Set(), counters);
    const json = emitAffectedJson(value, { pretty: true, byteLimit: AFFECTED_LIMITS.emittedBytes });
    return { ok: true, value, json };
  } catch { return { ok: false, category: "missing-paths" }; }
}

/** Validate/canonicalize a snapshotted affected_paths value. */
export function canonicalizePanelAffectedPaths(value, worktree) {
  if (!Array.isArray(value)) return affectedClassification("invalid-paths", []);
  if (value.length === 0) return affectedClassification("empty-paths", []);
  const canonical = [];
  try {
    for (const item of value) {
      if (typeof item !== "string") throw new Error("non-string path");
      canonical.push(canonicalAffectedPath(item, worktree));
    }
  } catch { return affectedClassification("invalid-paths", []); }
  const paths = [...new Set(canonical)].sort(byteSort);
  return { ok: true, category: null, paths, hash: affectedPathsHash(paths) };
}

export function affectedPathsHash(paths) {
  const bytes = Buffer.from(emitAffectedJson(paths, { pretty: false, byteLimit: AFFECTED_LIMITS.emittedBytes }), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

export function emitAffectedJson(value, { pretty = true, byteLimit = AFFECTED_LIMITS.emittedBytes } = {}) {
  let output = ""; let bytes = 0;
  const append = (chunk) => { bytes += Buffer.byteLength(chunk, "utf8"); if (bytes > byteLimit) throw new Error("affected JSON limit"); output += chunk; };
  const write = (item, depth) => {
    if (item === null) return append("null");
    if (typeof item === "boolean") return append(item ? "true" : "false");
    if (typeof item === "number") { if (!Number.isFinite(item)) throw new Error("unsupported emitted number"); return append(Object.is(item, -0) ? "0" : String(item)); }
    if (typeof item === "string") return append(quotedJsonString(item));
    const indent = pretty ? "  ".repeat(depth) : ""; const childIndent = pretty ? "  ".repeat(depth + 1) : ""; const separator = pretty ? ",\n" : ",";
    if (Array.isArray(item)) {
      append("["); if (!item.length) return append("]"); if (pretty) append("\n");
      item.forEach((child, index) => { if (pretty) append(childIndent); write(child, depth + 1); if (index + 1 < item.length) append(separator); });
      if (pretty) append(`\n${indent}`); return append("]");
    }
    if (!item || typeof item !== "object") throw new Error("unsupported emitted value");
    const keys = Object.keys(item); append("{"); if (!keys.length) return append("}"); if (pretty) append("\n");
    keys.forEach((key, index) => { if (pretty) append(childIndent); append(quotedJsonString(key)); append(pretty ? ": " : ":"); write(item[key], depth + 1); if (index + 1 < keys.length) append(separator); });
    if (pretty) append(`\n${indent}`); append("}");
  };
  write(value, 0); return output;
}

function quotedJsonString(value) {
  let output = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index); const character = value[index];
    if (character === '"' || character === "\\") output += `\\${character}`;
    else if (character === "\b") output += "\\b";
    else if (character === "\f") output += "\\f";
    else if (character === "\n") output += "\\n";
    else if (character === "\r") output += "\\r";
    else if (character === "\t") output += "\\t";
    else if (code < 0x20) output += `\\u${code.toString(16).padStart(4, "0")}`;
    else output += character;
  }
  return `${output}"`;
}

function affectedClassification(category, paths) { return { ok: false, category, paths, hash: affectedPathsHash(paths) }; }
function byteSort(left, right) { return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")); }
function panelVocabulary(activity) { const value = PANEL_VERDICTS[activity]; if (!value) throw new Error("panel activity must be validator or security"); return value; }
function isReflectableRecord(value) { return value !== null && typeof value === "object" && !utilTypes.isProxy(value); }
function isAdmissibleRecord(value) {
  if (!isReflectableRecord(value) || Array.isArray(value)) return false;
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; } catch { return false; }
}
function hasWellFormedUnicode(value) { return !/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u.test(value); }
function copyString(value, counters) {
  if (!hasWellFormedUnicode(value)) throw new Error("malformed Unicode");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > AFFECTED_LIMITS.stringBytes || counters.stringBytes + bytes > AFFECTED_LIMITS.totalStringBytes) throw new Error("string limit");
  counters.stringBytes += bytes;
  return value;
}
function copyAffectedValue(value, depth, ancestors, counters) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return copyString(value, counters);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("non-finite"); return Object.is(value, -0) ? 0 : value; }
  if (typeof value !== "object" || utilTypes.isProxy(value)) throw new Error("unsupported value");
  if (depth >= AFFECTED_LIMITS.depth) throw new Error("depth limit");
  if (++counters.occurrences > AFFECTED_LIMITS.occurrences) throw new Error("occurrence limit");
  let prototype;
  let keys;
  try { prototype = Object.getPrototypeOf(value); keys = Reflect.ownKeys(value); } catch { throw new Error("reflection failed"); }
  const array = Array.isArray(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("unsupported prototype");
  if (ancestors.has(value)) throw new Error("cycle");
  ancestors.add(value);
  try {
    if (array) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor?.value;
      if (!Number.isInteger(length) || length < 0 || length > AFFECTED_LIMITS.arrayLength || keys.length !== length + 1) throw new Error("sparse or extra array key");
      const result = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        if (keys[index] !== key && !keys.includes(key)) throw new Error("sparse array");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true || ++counters.entries > AFFECTED_LIMITS.entries) throw new Error("invalid array descriptor");
        result[index] = copyAffectedValue(descriptor.value, depth + 1, ancestors, counters);
      }
      return result;
    }
    if (keys.some((key) => typeof key === "symbol")) throw new Error("symbol key");
    const names = keys.sort(byteSort);
    const result = Object.create(null);
    for (const key of names) {
      copyString(key, counters);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true || ++counters.entries > AFFECTED_LIMITS.entries) throw new Error("invalid record descriptor");
      result[key] = copyAffectedValue(descriptor.value, depth + 1, ancestors, counters);
    }
    return result;
  } finally { ancestors.delete(value); }
}
function canonicalAffectedPath(value, worktree) {
  if (!hasWellFormedUnicode(value)) throw new Error("malformed path Unicode");
  const normalized = value.normalize("NFC");
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 4_096 || /[\0-\x1f\x7f\\]/u.test(normalized) || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) throw new Error("invalid path");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..") || posix.normalize(normalized) !== normalized) throw new Error("invalid path segments");
  const root = resolve(worktree);
  const candidate = resolve(root, normalized);
  const contained = relative(root, candidate);
  if (!contained || contained.startsWith("..") || contained.startsWith("/") || contained.includes("\\")) throw new Error("path escapes worktree");
  return normalized;
}

export function normalizeCheck(entry) {
  if (!entry || typeof entry !== "object") return "indeterminate";
  const kind = upper(entry.__typename || entry.type);
  if (kind === "STATUSCONTEXT" || Object.hasOwn(entry, "state")) {
    const state = upper(entry.state);
    if (state === "SUCCESS") return "pass";
    if (state === "FAILURE" || state === "ERROR") return "red";
    if (state === "PENDING" || state === "EXPECTED") return "pending";
    return "indeterminate";
  }
  const status = upper(entry.status);
  const conclusion = upper(entry.conclusion);
  if (status && status !== "COMPLETED") return CHECK_PENDING.has(status) ? "pending" : "indeterminate";
  if (CHECK_PASS.has(conclusion)) return "pass";
  if (CHECK_RED.has(conclusion)) return "red";
  return "indeterminate";
}

export function normalizeChecks(entries, options = {}) {
  if (!Array.isArray(entries)) throw protocol("statusCheckRollup must be an array");
  if (entries.length > 200) throw protocol("statusCheckRollup exceeds 200 entries");
  const elapsedMs = nonNegativeInteger(options.elapsedMs ?? 0, "elapsedMs");
  const graceMs = nonNegativeInteger(options.graceMs ?? 300_000, "graceMs");
  const checks = entries.map((entry, index) => ({
    index,
    verdict: normalizeCheck(entry),
    name: encodeUntrustedMetadata(checkName(entry)),
  }));
  if (checks.length === 0) return { verdict: elapsedMs < graceMs ? "not_started" : "not_applicable", checks };
  const verdicts = new Set(checks.map((check) => check.verdict));
  const verdict = verdicts.has("red") ? "red"
    : verdicts.has("pending") ? "pending"
      : verdicts.has("indeterminate") ? "indeterminate" : "pass";
  return { verdict, checks };
}

export function normalizeReview(input = {}) {
  const reviews = input.reviews === undefined ? [] : input.reviews;
  if (!Array.isArray(reviews)) throw protocol("reviews must be an array");
  if (reviews.length > 200) throw protocol("reviews exceeds 200 entries");
  if (input.isDraft !== undefined && typeof input.isDraft !== "boolean") throw protocol("isDraft must be a boolean");
  const expectedHeadSha = fullSha(input.expectedHeadSha, "expectedHeadSha");
  const reviewerLogin = optionalLogin(input.reviewerLogin);
  const required = Boolean(input.required || reviewerLogin);
  const latest = latestApplicableReviews(reviews, expectedHeadSha);
  const changeRequest = [...latest.values()].filter((review) => review.state === "CHANGES_REQUESTED").sort(compareReviewLatest)[0];
  if (changeRequest) return { verdict: "red", review: safeReview(changeRequest) };
  if (input.isDraft) return { verdict: "not_required", review: null };
  if (reviewerLogin) {
    const configured = latest.get(reviewerLogin.toLowerCase());
    return configured?.state === "APPROVED"
      ? { verdict: "pass", review: safeReview(configured) }
      : { verdict: "pending", review: null };
  }
  const decision = upper(input.reviewDecision);
  if (input.reviewDecision != null && !["CHANGES_REQUESTED", "APPROVED", "REVIEW_REQUIRED"].includes(decision)) return { verdict: "indeterminate", review: null };
  if (!required) return { verdict: "not_required", review: null };
  if (decision === "CHANGES_REQUESTED") return { verdict: "red", review: null };
  if (decision === "APPROVED") return { verdict: "pass", review: null };
  if (decision === "REVIEW_REQUIRED" || input.reviewDecision == null) return { verdict: "pending", review: null };
  return { verdict: "indeterminate", review: null };
}

export function aggregateObservation(input) {
  const expected = fullSha(input.expectedHeadSha, "expectedHeadSha");
  const observed = fullSha(input.headRefOid, "headRefOid");
  const state = upper(input.state);
  if (state === "MERGED") return terminal("green", "external-merge");
  if (state === "CLOSED") return terminal("blocked", "external-state");
  if (observed !== expected) return terminal("needs-human", "head-mismatch");
  const checks = input.checkVerdict;
  const review = input.reviewVerdict;
  if (review === "red") return terminal("needs-human", "review-red", "review");
  if (checks === "red") return terminal("red", "check-red", "checks");
  if (["pending", "not_started", "indeterminate"].includes(checks)) return terminal("pending", "checks-pending");
  if (["pass", "not_applicable"].includes(checks) && ["pass", "not_required"].includes(review)) {
    return terminal("green", input.isDraft ? "draft-ci-green" : "ci-green");
  }
  return terminal("pending", "review-pending");
}

export function normalizePullRequestResponse(response, options) {
  if (!response || typeof response !== "object" || Array.isArray(response)) throw protocol("PR response must be an object");
  if (typeof response.isDraft !== "boolean") throw protocol("isDraft must be a boolean");
  const state = upper(response.state);
  if (!["OPEN", "CLOSED", "MERGED"].includes(state)) throw protocol("PR state is invalid");
  if (!(response.reviewDecision === null || ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(upper(response.reviewDecision)))) {
    throw protocol("reviewDecision is invalid");
  }
  const started = timeMs(options.startedAt, "startedAt");
  const now = timeMs(options.now, "now");
  const checks = normalizeChecks(response.statusCheckRollup, {
    elapsedMs: Math.max(0, now - started), graceMs: options.checkStartGraceMs,
  });
  const review = normalizeReview({
    reviews: response.reviews, reviewDecision: response.reviewDecision,
    reviewerLogin: options.reviewerLogin, required: options.reviewRequired,
    expectedHeadSha: options.expectedHeadSha, isDraft: response.isDraft,
  });
  return {
    head_sha: fullSha(response.headRefOid, "headRefOid"), state, is_draft: response.isDraft,
    checks, review,
    aggregate: aggregateObservation({ expectedHeadSha: options.expectedHeadSha, headRefOid: response.headRefOid,
      state, isDraft: response.isDraft, checkVerdict: checks.verdict, reviewVerdict: review.verdict }),
  };
}

export function decideObservationSchedule(input) {
  const now = timeMs(input.now, "now");
  const deadline = timeMs(input.deadlineAt, "deadlineAt");
  if (now >= deadline) return { action: "block", reason: "deadline", next_poll_at: null };
  if (input.changed) return { ...schedule(now, deadline, positiveInteger(input.initialPollMs, "initialPollMs"), 0), consecutive_transient_errors: 0, last_error: null };
  const previous = positiveInteger(input.currentIntervalMs, "currentIntervalMs");
  const maximum = positiveInteger(input.maxPollMs, "maxPollMs");
  const backedOff = Math.ceil((previous * 1.5) / 1000) * 1000;
  return { ...schedule(now, deadline, Math.min(maximum, backedOff), nonNegativeInteger(input.unchangedCount ?? 0, "unchangedCount") + 1), consecutive_transient_errors: 0, last_error: null };
}

export function decideTransientSchedule(input) {
  const now = timeMs(input.now, "now");
  const deadline = timeMs(input.deadlineAt, "deadlineAt");
  const count = positiveInteger(input.consecutiveErrors, "consecutiveErrors");
  const max = positiveInteger(input.maxTransientErrors, "maxTransientErrors");
  if (now >= deadline) return { action: "block", reason: "deadline", next_poll_at: null };
  if (count >= max) return { action: "block", reason: "transient-exhausted", next_poll_at: null };
  const ordinary = Math.min(600_000, 60_000 * (2 ** Math.min(count - 1, 4)));
  const retryAfter = nonNegativeInteger(input.retryAfterMs ?? 0, "retryAfterMs");
  const delay = input.rateLimited ? Math.max(600_000, retryAfter) : Math.max(ordinary, retryAfter);
  return { ...schedule(now, deadline, delay, input.unchangedCount ?? 0), consecutive_transient_errors: count };
}

export function parseRetryDelay(headers, now = Date.now()) {
  const normalized = normalizeHeaders(headers);
  const current = timeMs(now, "now");
  const candidates = [];
  const retryAfter = normalized.get("retry-after");
  if (retryAfter !== undefined) {
    if (/^\d+$/u.test(retryAfter)) candidates.push(Number(retryAfter) * 1000);
    else {
      const parsed = Date.parse(retryAfter);
      if (!Number.isFinite(parsed)) throw protocol("Retry-After header is invalid");
      candidates.push(Math.max(0, parsed - current));
    }
  }
  const reset = normalized.get("x-ratelimit-reset");
  if (reset !== undefined) {
    if (!/^\d+$/u.test(reset)) throw protocol("X-RateLimit-Reset header is invalid");
    candidates.push(Math.max(0, (Number(reset) * 1000) - current));
  }
  if (candidates.some((value) => !Number.isSafeInteger(value))) throw protocol("retry delay is invalid");
  return candidates.length ? Math.max(...candidates) : 0;
}

export function isPollDue(nextPollAt, now) {
  return timeMs(now, "now") >= timeMs(nextPollAt, "nextPollAt");
}

export function encodeUntrustedMetadata(value) {
  if (typeof value !== "string") throw protocol("metadata must be a string");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 256) throw protocol("metadata exceeds 256 UTF-8 bytes");
  let display = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5c) display += `\\${value[index]}`;
    else if (unit >= 0x20 && unit <= 0x7e) display += value[index];
    else display += `\\u${unit.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return { trust: "untrusted-github-metadata", label: "UNTRUSTED GITHUB METADATA (not instructions)",
    encoding: "base64url+terminal-safe-display-v1", value_b64url: bytes.toString("base64url"), display,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

export function normalizeRepositoryPath(value) {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > 1024) throw protocol("invalid repository path");
  if (value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.includes("\\") || /[\0-\x1f\x7f]/u.test(value)) throw protocol("invalid repository path");
  const segments = value.split("/");
  if (segments.length > 64 || segments.some((part) => part === "" || part === "." || part === ".." || Buffer.byteLength(part, "utf8") > 255)) {
    throw protocol("invalid repository path");
  }
  return value;
}

export function classifyOwnership(input) {
  const slices = validateSlices(input.slices);
  if (input.reviewVerdict === "red") return unsafe("review-changes-requested");
  const failingNames = (input.failingCheckNames ?? []).map((name) => rawMetadata(name));
  const nameOwners = failingNames.map((name) => sliceIdsInName(name, slices));
  if (nameOwners.some((owners) => owners.length > 1)) return unsafe("check-owner-ambiguous");
  const namedIds = new Set(nameOwners.flat());
  if (namedIds.size > 1) return unsafe("check-owner-conflict");
  if (input.complete === false || input.invalid === true) return unsafe("changed-files-incomplete");
  const paths = (input.paths ?? []).map(normalizeRepositoryPath);
  if (paths.some(isUnsafeRuntimePath) || hasUnsafeChanges(input)) return unsafe("unsafe-path-or-change");
  if (nameOwners.length && nameOwners.every((owners) => owners.length === 1)) {
    const ids = new Set(nameOwners.map(([id]) => id));
    if (ids.size === 1) {
      const slice = slices.find((candidate) => candidate.id === [...ids][0]);
      if (paths.length && paths.some((path) => !sliceOwnsPath(slice, path))) return unsafe("check-file-conflict");
      return routeSlice(slice, "check-slice-id", paths);
    }
    return unsafe("check-owner-conflict");
  }
  if (paths.length) {
    const owners = paths.map((path) => slices.filter((slice) => sliceOwnsPath(slice, path)).map((slice) => slice.id));
    if (owners.every((matches) => matches.length === 1) && new Set(owners.map(([id]) => id)).size === 1) {
      const slice = slices.find((candidate) => candidate.id === owners[0][0]);
      if (nameOwners.some((matches) => matches.length && !matches.includes(slice.id))) return unsafe("check-file-conflict");
      return routeSlice(slice, "changed-files", paths);
    }
    if (paths.every(isTestLanePath) && nameOwners.every((matches) => matches.length === 0)) return integration(paths);
    return unsafe("path-owner-ambiguous");
  }
  return nameOwners.every((matches) => matches.length === 0) ? integration(paths) : unsafe("check-owner-ambiguous");
}

export function validateLane(input) {
  const paths = (input.paths ?? []).map(normalizeRepositoryPath);
  const changes = input.changes ?? [];
  if (input.hasRename || input.hasDelete || input.hasGenerated || input.hasSymlink || changes.some((change) => !["modified", "added", "untracked", "deleted", "renamed", "copied"].includes(change?.status))) return { ok: false, reason: "unsafe-change-kind" };
  if (input.lane === "test") return paths.every(isTestLanePath) ? { ok: true } : { ok: false, reason: "path-outside-test-lane" };
  if (input.lane !== "slice" || !input.slice) return { ok: false, reason: "invalid-lane" };
  const slice = validateSlices([input.slice])[0];
  return paths.every((path) => sliceOwnsPath(slice, path)) ? { ok: true } : { ok: false, reason: "path-outside-slice-lane" };
}

export function buildFailureEvidenceInput(input) {
  const failing = (input.failingChecks ?? []).map((check) => {
    if (!check || check.verdict !== undefined && check.verdict !== "red") throw protocol("failing check verdict is invalid");
    return { name: canonicalMetadata(check?.name), verdict: "red" };
  }).sort((a, b) => compareBytes(a.name.value_b64url, b.name.value_b64url));
  const repository = validRepository(input.repository);
  const prNumber = positiveInteger(input.prNumber, "prNumber");
  const canonicalPrUrl = `https://github.com/${repository}/pull/${prNumber}`;
  if (input.prUrl !== canonicalPrUrl) throw new Error("prUrl must match canonical PR identity");
  const review = canonicalEvidenceReview(input.review);
  const ownership = canonicalEvidenceOwnership(input.ownership);
  if (!failing.length && review === null) throw protocol("failure evidence requires a red check or review");
  if (review !== null && ownership.disposition !== "needs-human") throw protocol("review-red evidence cannot have a remediation route");
  const evidence = {
    schema_version: 1, kind: "post-pr-ci-failure", run_id: String(input.runId), attempt: positiveInteger(input.attempt, "attempt"),
    source: "github", verdict: "red", observed_at: new Date(timeMs(input.observedAt, "observedAt")).toISOString(),
    pr: { url: canonicalPrUrl, number: prNumber, repository },
    expected_head_sha: fullSha(input.expectedHeadSha, "expectedHeadSha"), observed_head_sha: fullSha(input.observedHeadSha, "observedHeadSha"),
    failing_checks: failing, review, primary_failure: review !== null ? "review-red" : "check-red",
    ownership, command: { program: "gh", args: ["pr", "view", String(prNumber), "--repo", repository, "--json", "headRefOid,isDraft,reviewDecision,reviews,state,statusCheckRollup"], exit_code: nonNegativeInteger(input.exitCode ?? 0, "exitCode") },
  };
  return { ...evidence, failure_fingerprint: `sha256:${createHash("sha256").update(stableJson(evidence)).digest("hex")}` };
}

export async function runGitHubOperation(input) {
  const repositoryRoot = resolve(input.repositoryRoot);
  const account = optionalLogin(input.account);
  if (!account) throw new PostPrCiError("account-auth", "a persisted GitHub account is required");
  return withGitHubOperationLock(repositoryRoot, async () => {
    const execute = input.execute ?? runBoundedProcess;
    const common = { executable: input.executable ?? "gh", cwd: input.cwd ?? repositoryRoot, spawnImpl: input.spawnImpl };
    const switched = await execute({ ...common, args: ["auth", "switch", "-h", "github.com", "-u", account], ...GITHUB_LIMITS.switch });
    requireSuccessful(switched, "account-switch");
    const result = await execute({ ...common, args: [...input.args], ...(input.limits ?? GITHUB_LIMITS.verdict) });
    requireSuccessful(result, "operation");
    return { exitCode: result.exitCode, signal: result.signal ?? null, stdout: result.stdout ?? "" };
  }, input.lockOptions);
}

export async function queryPullRequest(input) {
  const identity = checkedIdentity(input.repository, input.prNumber);
  const args = ["pr", "view", String(identity.number), "--repo", identity.repository, "--json", "headRefOid,isDraft,reviewDecision,reviews,state,statusCheckRollup"];
  const result = await runGitHubOperation({ ...input, args, limits: GITHUB_LIMITS.verdict });
  return parseJsonObject(result.stdout);
}

export async function requestReviewer(input) {
  const identity = checkedIdentity(input.repository, input.prNumber);
  const login = optionalLogin(input.reviewerLogin);
  if (!login) throw protocol("reviewerLogin is required");
  return runGitHubOperation({ ...input, args: ["pr", "edit", String(identity.number), "--repo", identity.repository, "--add-reviewer", login], limits: GITHUB_LIMITS.reviewer });
}

export async function fetchChangedFiles(input) {
  const identity = checkedIdentity(input.repository, input.prNumber);
  const paths = []; const changes = [];
  for (let page = 1; page <= 3; page += 1) {
    const endpoint = `repos/${identity.repository}/pulls/${identity.number}/files?per_page=100&page=${page}`;
    const result = await runGitHubOperation({ ...input, args: ["api", "--include", endpoint], limits: GITHUB_LIMITS.ownershipPage });
    const included = parseIncludedArray(result.stdout);
    const body = included.body;
    if (body.length > 100) throw protocol("changed-file page exceeds 100 entries");
    for (const file of body) {
      if (!file || typeof file !== "object") throw protocol("changed-file entry must be an object");
      const path = normalizeRepositoryPath(file.filename);
      const previousPath = file.previous_filename === undefined ? null : normalizeRepositoryPath(file.previous_filename);
      const status = typeof file.status === "string" ? file.status.toLowerCase() : null;
      if (!["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"].includes(status)) throw protocol("changed-file status is invalid");
      paths.push(path);
      if (previousPath !== null) paths.push(previousPath);
      changes.push({ path, previous_path: previousPath, status });
    }
    if (!included.hasNext) return { paths, changes, complete: true, pages: page };
    if (page === 3) return { paths, changes, complete: false, pages: page };
  }
  return { paths, changes, complete: true, pages: 3 };
}

export async function runBoundedProcess(input) {
  const child = (input.spawnImpl ?? spawn)(input.executable, input.args, { cwd: input.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolvePromise, rejectPromise) => {
    const stdout = []; const stderr = []; let stdoutBytes = 0; let stderrBytes = 0; let settled = false; let timedOut = false; let overflow = null;
    const finishError = (error) => { if (!settled) { settled = true; clearTimeout(timer); rejectPromise(error); } };
    const kill = (reason) => { if (overflow || timedOut) return; if (reason === "timeout") timedOut = true; else overflow = reason; child.kill("SIGKILL"); };
    child.stdout.on("data", (chunk) => { stdoutBytes += chunk.length; if (stdoutBytes > input.stdoutCap) kill("stdout"); else stdout.push(chunk); });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; if (stderrBytes > input.stderrCap) kill("stderr"); else stderr.push(chunk); });
    child.on("error", (error) => finishError(classifyGitHubFailure({ error })));
    child.on("close", (code, signal) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (timedOut) return rejectPromise(new PostPrCiError("timeout", "GitHub command timed out", { transient: true }));
      if (overflow) return rejectPromise(new PostPrCiError("protocol", `GitHub command exceeded ${overflow} cap`));
      resolvePromise({ exitCode: Number.isInteger(code) ? code : null, signal: signal ?? null,
        stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    const timer = setTimeout(() => kill("timeout"), input.timeoutMs);
    timer.unref?.();
  });
}

export function classifyGitHubFailure(input = {}) {
  if (input.error instanceof PostPrCiError) return input.error;
  const text = `${input.message ?? ""} ${input.stderr ?? ""} ${input.error?.code ?? ""}`.toLowerCase();
  const exitCode = Number.isInteger(input.exitCode) ? input.exitCode : null;
  const embeddedStatus = text.match(/(?:http(?:\/\d(?:\.\d)?)?\s+|status[=: ]+)(401|403|404|408|429|500|502|503|504)\b/u)?.[1];
  const status = Number(input.httpStatus ?? embeddedStatus);
  let retryAfterMs = 0;
  try { retryAfterMs = parseRetryDelay(input.headers, input.now); } catch (error) { return error; }
  if (input.timedOut) return new PostPrCiError("timeout", "GitHub command timed out", { transient: true, exitCode, retryAfterMs });
  if (status === 429 || /\b(?:api )?rate limit exceeded\b|\bsecondary rate limit\b/u.test(text)) return new PostPrCiError("rate-limit", "GitHub rate limit", { transient: true, rateLimited: true, exitCode, retryAfterMs });
  if (HTTP_TRANSIENT.has(status)) return new PostPrCiError("http-transient", `GitHub HTTP ${status}`, { transient: true, exitCode, retryAfterMs });
  if (/\b(?:econnreset|enotfound|eai_again|etimedout)\b/u.test(text)) return new PostPrCiError("network", "GitHub network failure", { transient: true, exitCode, retryAfterMs });
  if (status === 401 || /bad credentials|authentication failed/u.test(text)) return new PostPrCiError("account-auth", "GitHub authentication failure", { exitCode });
  if (status === 403) return new PostPrCiError("permission", "GitHub permission failure", { exitCode });
  if (status === 404) return new PostPrCiError("not-found", "GitHub resource not found", { exitCode });
  return new PostPrCiError("command", "GitHub command failed", { exitCode });
}

async function withGitHubOperationLock(repositoryRoot, fn, options = {}) {
  const factoryDir = join(repositoryRoot, ".opencode", "factory");
  const lockFile = join(factoryDir, "github-operation.lock");
  await mkdir(factoryDir, { recursive: true });
  const now = options?.now ?? Date.now;
  const sleep = options?.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const deadline = now() + (options?.timeoutMs ?? 10_000);
  let owner;
  while (!owner) {
    const candidate = { pid: process.pid, hostname: hostname(), nonce: randomUUID() };
    const claimFile = join(factoryDir, `.github-operation.lock-claim-${candidate.nonce}.json`);
    try {
      await writeFile(claimFile, `${JSON.stringify(candidate)}\n`, { flag: "wx" });
      if (options?.onClaimPublished) await options.onClaimPublished({ claimFile, lockFile, owner: candidate });
      await link(claimFile, lockFile);
      await rm(claimFile, { force: true });
      owner = candidate;
    } catch (error) {
      await rm(claimFile, { force: true }).catch(() => {});
      if (error.code !== "EEXIST") throw error;
      if (await reclaimDeadLocalLock(lockFile, options)) continue;
      if (now() >= deadline) throw new PostPrCiError("lock-timeout", "GitHub operation lock timed out", { transient: true });
      await sleep(Math.min(25, Math.max(1, deadline - now())));
    }
  }
  try { return await fn(); } finally {
    try {
      const current = JSON.parse(await readFile(lockFile, "utf8"));
      if (current.nonce === owner.nonce) await rm(lockFile, { force: true });
    } catch { /* Never remove a lock whose ownership cannot be confirmed. */ }
  }
}

async function reclaimDeadLocalLock(lockFile, options = {}) {
  let owner;
  try { owner = JSON.parse(await readFile(lockFile, "utf8")); } catch { return false; }
  if (owner.hostname !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.nonce !== "string") return false;
  if (options.isProcessAlive) { if (await options.isProcessAlive(owner.pid)) return false; }
  else {
    try { process.kill(owner.pid, 0); return false; } catch (error) { if (error.code !== "ESRCH") return false; }
  }
  const quarantine = `${lockFile}.dead-${randomUUID()}`;
  try {
    await rename(lockFile, quarantine);
    const confirmed = JSON.parse(await readFile(quarantine, "utf8"));
    if (confirmed.nonce !== owner.nonce || confirmed.pid !== owner.pid || confirmed.hostname !== owner.hostname) {
      throw new PostPrCiError("lock-identity", "GitHub operation lock identity changed");
    }
    await rm(quarantine, { force: true });
    await rm(join(dirname(lockFile), `.github-operation.lock-claim-${owner.nonce}.json`), { force: true });
    return true;
  } catch (error) {
    if (error instanceof PostPrCiError) throw error;
    return false;
  }
}

function latestApplicableReviews(reviews, expectedHeadSha) {
  const result = new Map();
  reviews.forEach((review, index) => {
    if (!review || typeof review !== "object") throw protocol("review entry must be an object");
    const login = optionalLogin(review.author?.login);
    const state = upper(review.state);
    if (!login || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(state)) return;
    if (review.commit?.oid !== expectedHeadSha) return;
    const submitted = Date.parse(review.submittedAt);
    if (!Number.isFinite(submitted)) throw protocol("review submittedAt must be a timestamp");
    const key = login.toLowerCase(); const current = result.get(key);
    if (!current || submitted > current._submitted || (submitted === current._submitted && index > current._index)) {
      result.set(key, { login, state, submittedAt: new Date(submitted).toISOString(), commitId: expectedHeadSha, _submitted: submitted, _index: index });
    }
  });
  for (const [key, review] of result) if (review.state === "DISMISSED") result.delete(key);
  return result;
}

function safeReview(review) { return { author: encodeUntrustedMetadata(review.login), state: review.state, submitted_at: review.submittedAt, commit_id: review.commitId }; }
function compareReviewLatest(left, right) { return right._submitted - left._submitted || right._index - left._index; }
function checkName(entry) { const name = entry?.name ?? entry?.context; if (typeof name !== "string" || name === "") throw protocol("check name is required"); return name; }
function rawMetadata(value) { return typeof value === "string" ? value : decodeCanonicalMetadata(value); }
function sliceIdsInName(name, slices) { return slices.filter((slice) => new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegex(slice.id)}(?=$|[^A-Za-z0-9_-])`, "u").test(name)).map((slice) => slice.id); }
function validateSlices(slices) { if (!Array.isArray(slices)) throw new Error("slices must be an array"); return slices.map((slice) => { if (!slice || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(slice.id) || !Array.isArray(slice.paths)) throw new Error("invalid slice"); return { ...slice, paths: slice.paths.map(validatePlanPath) }; }); }
function validatePlanPath(path) { if (typeof path !== "string") return null; if (path.endsWith("/**") && !/[*?[\]{}]/u.test(path.slice(0, -3))) return `${normalizeRepositoryPath(path.slice(0, -3))}/**`; if (/[*?[\]{}]/u.test(path)) return null; return normalizeRepositoryPath(path); }
function sliceOwnsPath(slice, path) { return slice.paths.filter(Boolean).some((accepted) => accepted.endsWith("/**") ? path.startsWith(accepted.slice(0, -2)) : path === accepted); }
function routeSlice(slice, method, paths = []) { const route = STACK_ROUTES[slice.stack]; if (!route) return unsafe("unknown-slice-stack"); const selected = paths.length ? sortPaths(paths)[0] : null; return { disposition: "route", owner: { kind: "slice", slice_id: slice.id, stack: slice.stack, path_b64url: selected === null ? null : Buffer.from(selected).toString("base64url"), method }, route, lane: "slice", reason: method }; }
function integration(paths = []) { const selected = paths.length ? sortPaths(paths)[0] : null; return { disposition: "route", owner: { kind: "integration", slice_id: null, stack: "test", path_b64url: selected === null ? null : Buffer.from(selected).toString("base64url"), method: "integration" }, route: "test-verifier", lane: "test", reason: "integration-fallback" }; }
function unsafe(reason) { return { disposition: "needs-human", owner: null, route: null, lane: null, reason }; }
function isTestLanePath(path) { return TEST_PREFIXES.some((prefix) => path.startsWith(prefix)); }
function isUnsafeRuntimePath(path) { return UNSAFE_RUNTIME_PATHS.has(path) || path.startsWith(".yarn/") || path.startsWith("node_modules/")
  || (!path.includes("/") && (/^(?:tsconfig(?:\.[^.]+)?\.json|(?:eslint|prettier|babel|webpack|vite|vitest|jest)\.config\.[A-Za-z0-9]+)$/u.test(path) || /^\.env(?:\.|$)/u.test(path))); }
function hasUnsafeChanges(input) { return Boolean(input.hasRename || input.hasDelete || input.hasGenerated || input.hasSymlink || input.changes?.some((change) => change?.previous_path || ["renamed", "removed", "deleted"].includes(String(change?.status).toLowerCase()))); }
function requireSuccessful(result, phase) { if (!result || result.exitCode !== 0) { const classified = classifyGitHubFailure(result ?? {}); if (phase === "account-switch") throw new PostPrCiError("account-switch", "GitHub account switch failed", { exitCode: classified.exitCode }); throw classified; } }
function parseJsonObject(text) { try { const value = JSON.parse(text); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; } catch { throw protocol("malformed GitHub JSON response"); } }
function parseIncludedArray(text) {
  if (typeof text !== "string") throw protocol("malformed GitHub included response");
  const separator = text.match(/\r?\n\r?\n/u);
  if (!separator?.index) throw protocol("malformed GitHub included response");
  const headerText = text.slice(0, separator.index);
  const lines = headerText.split(/\r?\n/u);
  if (!/^HTTP\/\d(?:\.\d)?\s+\d{3}(?:\s|$)/u.test(lines.shift() ?? "")) throw protocol("malformed GitHub included response");
  const headers = normalizeHeaders(lines.map((line) => {
    const colon = line.indexOf(":");
    if (colon <= 0) throw protocol("malformed GitHub response header");
    return [line.slice(0, colon), line.slice(colon + 1).trim()];
  }));
  let body;
  try { body = JSON.parse(text.slice(separator.index + separator[0].length)); } catch { throw protocol("malformed GitHub included response"); }
  if (!Array.isArray(body)) throw protocol("malformed GitHub included response");
  const link = headers.get("link");
  if (link !== undefined && !/^<[^<>\r\n]+>;\s*rel="[a-z]+"(?:,\s*<[^<>\r\n]+>;\s*rel="[a-z]+")*$/u.test(link)) throw protocol("malformed Link header");
  return { body, hasNext: link?.split(",").some((part) => /;\s*rel="next"$/u.test(part.trim())) ?? false };
}
function canonicalMetadata(value) { return encodeUntrustedMetadata(typeof value === "string" ? value : decodeCanonicalMetadata(value)); }
function decodeCanonicalMetadata(value) {
  if (!value || typeof value !== "object" || value.encoding !== "base64url+terminal-safe-display-v1" || typeof value.value_b64url !== "string" || !/^[A-Za-z0-9_-]*$/u.test(value.value_b64url)) throw protocol("invalid encoded metadata");
  const bytes = Buffer.from(value.value_b64url, "base64url");
  if (bytes.toString("base64url") !== value.value_b64url) throw protocol("non-canonical encoded metadata");
  const raw = bytes.toString("utf8");
  if (!Buffer.from(raw).equals(bytes)) throw protocol("metadata is not valid UTF-8");
  return raw;
}
function canonicalEvidenceReview(review) {
  if (review == null) return null;
  if (!review || typeof review !== "object" || review.state !== "CHANGES_REQUESTED") throw protocol("evidence review is invalid");
  const submitted = new Date(timeMs(review.submitted_at, "review.submitted_at")).toISOString();
  return { author: canonicalMetadata(review.author), state: "CHANGES_REQUESTED", submitted_at: submitted, commit_id: fullSha(review.commit_id, "review.commit_id") };
}
function canonicalEvidenceOwnership(value) {
  if (!value || typeof value !== "object" || !["route", "needs-human"].includes(value.disposition)) throw protocol("evidence ownership is invalid");
  if (value.disposition === "needs-human") return { disposition: "needs-human", owner: null, route: null, lane: null, reason: safeReason(value.reason) };
  if (!value.owner || !["slice", "integration"].includes(value.owner.kind)) throw protocol("evidence owner is invalid");
  const route = value.owner.kind === "integration" ? "test-verifier" : STACK_ROUTES[value.owner.stack];
  const lane = value.owner.kind === "integration" ? "test" : "slice";
  if (!route || value.route !== route || value.lane !== lane) throw protocol("evidence owner route is invalid");
  const pathB64 = value.owner.path_b64url;
  if (pathB64 !== null) normalizeRepositoryPath(decodeBase64Url(pathB64, "owner path"));
  const method = safeMethod(value.owner.method);
  const expectedReason = method === "integration" ? "integration-fallback" : method;
  if (value.reason !== expectedReason) throw protocol("ownership reason is invalid");
  return { disposition: "route", owner: { kind: value.owner.kind, slice_id: value.owner.kind === "slice" ? safeSliceId(value.owner.slice_id) : null,
    stack: value.owner.kind === "slice" ? value.owner.stack : "test", path_b64url: pathB64, method }, route, lane, reason: expectedReason };
}
function decodeBase64Url(value, label) { if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) throw protocol(`${label} is invalid`); const bytes = Buffer.from(value, "base64url"); if (bytes.toString("base64url") !== value) throw protocol(`${label} is invalid`); const decoded = bytes.toString("utf8"); if (!Buffer.from(decoded).equals(bytes)) throw protocol(`${label} is invalid`); return decoded; }
function safeSliceId(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)) throw protocol("slice id is invalid"); return value; }
function safeMethod(value) { if (!["check-slice-id", "changed-files", "integration"].includes(value)) throw protocol("owner method is invalid"); return value; }
function safeReason(value) { if (!OWNERSHIP_REASONS.has(value)) throw protocol("ownership reason is invalid"); return value; }
function compareBytes(left, right) { return Buffer.compare(Buffer.from(left, "base64url"), Buffer.from(right, "base64url")); }
function sortPaths(paths) { return [...paths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))); }
function normalizeHeaders(headers) {
  if (headers == null) return new Map();
  const entries = headers instanceof Map ? [...headers] : Array.isArray(headers) ? headers : Object.entries(headers);
  const result = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string" || !/^[A-Za-z0-9-]+$/u.test(entry[0]) || /[\r\n]/u.test(entry[1])) throw protocol("invalid response headers");
    const key = entry[0].toLowerCase();
    if (result.has(key)) throw protocol("duplicate response header");
    result.set(key, entry[1].trim());
  }
  return result;
}
function checkedIdentity(repository, number) { return { repository: validRepository(repository), number: positiveInteger(number, "prNumber") }; }
function validRepository(value) { if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) throw new Error("invalid repository identity"); return value; }
function optionalLogin(value) { if (value == null || value === "") return null; if (typeof value !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(value)) throw new Error("invalid GitHub login"); return value; }
function fullSha(value, label) { if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) throw protocol(`${label} must be a full lowercase SHA`); return value; }
function protocol(message) { return new PostPrCiError("protocol", message); }
function upper(value) { return typeof value === "string" ? value.toUpperCase() : ""; }
function positiveInteger(value, label) { const number = Number(value); if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`); return number; }
function nonNegativeInteger(value, label) { const number = Number(value); if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer`); return number; }
function timeMs(value, label) { const parsed = typeof value === "number" ? value : Date.parse(value); if (!Number.isFinite(parsed)) throw new Error(`${label} must be a timestamp`); return parsed; }
function schedule(now, deadline, delay, unchangedCount) { const at = Math.min(deadline, now + delay); return { action: "schedule", interval_ms: at - now, next_poll_at: new Date(at).toISOString(), unchanged_count: unchangedCount }; }
function terminal(verdict, reason, primary = null) { return { verdict, reason, primary }; }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
function stableJson(value) { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
