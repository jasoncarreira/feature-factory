import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

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
const STACK_ROUTES = Object.freeze({ backend: "backend-builder", frontend: "frontend-builder" });

export class PostPrCiError extends Error {
  constructor(errorClass, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "PostPrCiError";
    this.errorClass = errorClass;
    this.transient = Boolean(options.transient);
    this.rateLimited = Boolean(options.rateLimited);
    this.exitCode = Number.isInteger(options.exitCode) ? options.exitCode : null;
  }
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
  const reviews = input.reviews ?? [];
  if (!Array.isArray(reviews)) throw protocol("reviews must be an array");
  if (reviews.length > 200) throw protocol("reviews exceeds 200 entries");
  const expectedHeadSha = fullSha(input.expectedHeadSha, "expectedHeadSha");
  const reviewerLogin = optionalLogin(input.reviewerLogin);
  const required = Boolean(input.required || reviewerLogin);
  const latest = latestApplicableReviews(reviews, expectedHeadSha);
  const changeRequest = [...latest.values()].find((review) => review.state === "CHANGES_REQUESTED");
  if (changeRequest) return { verdict: "red", review: safeReview(changeRequest) };
  if (input.isDraft) return { verdict: "not_required", review: null };
  if (reviewerLogin) {
    const configured = latest.get(reviewerLogin.toLowerCase());
    return configured?.state === "APPROVED"
      ? { verdict: "pass", review: safeReview(configured) }
      : { verdict: "pending", review: null };
  }
  if (!required) return { verdict: "not_required", review: null };
  const decision = upper(input.reviewDecision);
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
  const started = timeMs(options.startedAt, "startedAt");
  const now = timeMs(options.now, "now");
  const checks = normalizeChecks(response.statusCheckRollup ?? [], {
    elapsedMs: Math.max(0, now - started), graceMs: options.checkStartGraceMs,
  });
  const review = normalizeReview({
    reviews: response.reviews ?? [], reviewDecision: response.reviewDecision,
    reviewerLogin: options.reviewerLogin, required: options.reviewRequired,
    expectedHeadSha: options.expectedHeadSha, isDraft: Boolean(response.isDraft),
  });
  return {
    head_sha: fullSha(response.headRefOid, "headRefOid"), state: upper(response.state), is_draft: Boolean(response.isDraft),
    checks, review,
    aggregate: aggregateObservation({ expectedHeadSha: options.expectedHeadSha, headRefOid: response.headRefOid,
      state: response.state, isDraft: response.isDraft, checkVerdict: checks.verdict, reviewVerdict: review.verdict }),
  };
}

export function decideObservationSchedule(input) {
  const now = timeMs(input.now, "now");
  const deadline = timeMs(input.deadlineAt, "deadlineAt");
  if (now >= deadline) return { action: "block", reason: "deadline", next_poll_at: null };
  if (input.changed) return schedule(now, deadline, positiveInteger(input.initialPollMs, "initialPollMs"), 0);
  const previous = positiveInteger(input.currentIntervalMs, "currentIntervalMs");
  const maximum = positiveInteger(input.maxPollMs, "maxPollMs");
  const backedOff = Math.ceil((previous * 1.5) / 1000) * 1000;
  return schedule(now, deadline, Math.min(maximum, backedOff), nonNegativeInteger(input.unchangedCount ?? 0, "unchangedCount") + 1);
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
  return schedule(now, deadline, delay, input.unchangedCount ?? 0);
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
  if (nameOwners.length && nameOwners.every((owners) => owners.length === 1)) {
    const ids = new Set(nameOwners.map(([id]) => id));
    if (ids.size === 1) return routeSlice(slices.find((slice) => slice.id === [...ids][0]), "check-slice-id");
    return unsafe("check-owner-conflict");
  }
  if (input.complete === false || input.invalid === true) return unsafe("changed-files-incomplete");
  const paths = (input.paths ?? []).map(normalizeRepositoryPath);
  if (paths.length) {
    const owners = paths.map((path) => slices.filter((slice) => sliceOwnsPath(slice, path)).map((slice) => slice.id));
    if (owners.every((matches) => matches.length === 1) && new Set(owners.map(([id]) => id)).size === 1) {
      const slice = slices.find((candidate) => candidate.id === owners[0][0]);
      if (nameOwners.some((matches) => matches.length && !matches.includes(slice.id))) return unsafe("check-file-conflict");
      return { ...routeSlice(slice, "changed-files"), path: [...paths].sort()[0] };
    }
    if (paths.every(isTestLanePath) && nameOwners.every((matches) => matches.length === 0)) return integration();
    return unsafe("path-owner-ambiguous");
  }
  return nameOwners.every((matches) => matches.length === 0) ? integration() : unsafe("check-owner-ambiguous");
}

export function validateLane(input) {
  const paths = (input.paths ?? []).map(normalizeRepositoryPath);
  if (input.hasRename || input.hasDelete || input.hasGenerated || input.hasSymlink) return { ok: false, reason: "unsafe-change-kind" };
  if (input.lane === "test") return paths.every(isTestLanePath) ? { ok: true } : { ok: false, reason: "path-outside-test-lane" };
  if (input.lane !== "slice" || !input.slice) return { ok: false, reason: "invalid-lane" };
  const slice = validateSlices([input.slice])[0];
  return paths.every((path) => sliceOwnsPath(slice, path)) ? { ok: true } : { ok: false, reason: "path-outside-slice-lane" };
}

export function buildFailureEvidenceInput(input) {
  const failing = (input.failingChecks ?? []).map((check) => ({
    name: check.name?.trust ? check.name : encodeUntrustedMetadata(String(check.name)), verdict: "red",
  })).sort((a, b) => a.name.display.localeCompare(b.name.display));
  const repository = validRepository(input.repository);
  const prNumber = positiveInteger(input.prNumber, "prNumber");
  const canonicalPrUrl = `https://github.com/${repository}/pull/${prNumber}`;
  if (input.prUrl !== canonicalPrUrl) throw new Error("prUrl must match canonical PR identity");
  const evidence = {
    schema_version: 1, kind: "post-pr-ci-failure", run_id: String(input.runId), attempt: positiveInteger(input.attempt, "attempt"),
    source: "github", verdict: "red", observed_at: new Date(timeMs(input.observedAt, "observedAt")).toISOString(),
    pr: { url: canonicalPrUrl, number: prNumber, repository },
    expected_head_sha: fullSha(input.expectedHeadSha, "expectedHeadSha"), observed_head_sha: fullSha(input.observedHeadSha, "observedHeadSha"),
    failing_checks: failing, review: input.review ?? null, primary_failure: failing.length ? "check-red" : "review-red",
    ownership: input.ownership, command: { program: "gh", args: ["pr", "view", String(prNumber), "--repo", repository, "--json", "headRefOid,isDraft,reviewDecision,reviews,state,statusCheckRollup"], exit_code: Number.isInteger(input.exitCode) ? input.exitCode : 0 },
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
    return result;
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
  const paths = [];
  for (let page = 1; page <= 3; page += 1) {
    const endpoint = `repos/${identity.repository}/pulls/${identity.number}/files?per_page=100&page=${page}`;
    const result = await runGitHubOperation({ ...input, args: ["api", "--include", endpoint], limits: GITHUB_LIMITS.ownershipPage });
    const body = parseIncludedArray(result.stdout);
    for (const file of body) {
      if (!file || typeof file !== "object") throw protocol("changed-file entry must be an object");
      paths.push(normalizeRepositoryPath(file.filename));
      if (file.previous_filename !== undefined) paths.push(normalizeRepositoryPath(file.previous_filename));
    }
    if (body.length < 100) return { paths, complete: true, pages: page };
  }
  return { paths, complete: false, pages: 3 };
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
  if (input.timedOut) return new PostPrCiError("timeout", "GitHub command timed out", { transient: true, exitCode });
  if (status === 429 || /rate limit|secondary rate/u.test(text)) return new PostPrCiError("rate-limit", "GitHub rate limit", { transient: true, rateLimited: true, exitCode });
  if (HTTP_TRANSIENT.has(status)) return new PostPrCiError("http-transient", `GitHub HTTP ${status}`, { transient: true, exitCode });
  if (/econnreset|enotfound|eai_again|network|dns/u.test(text)) return new PostPrCiError("network", "GitHub network failure", { transient: true, exitCode });
  if (status === 401 || /bad credentials|authentication failed/u.test(text)) return new PostPrCiError("account-auth", "GitHub authentication failure", { exitCode });
  if (status === 403) return new PostPrCiError("permission", "GitHub permission failure", { exitCode });
  if (status === 404) return new PostPrCiError("not-found", "GitHub resource not found", { exitCode });
  return new PostPrCiError("command", "GitHub command failed", { exitCode });
}

async function withGitHubOperationLock(repositoryRoot, fn, options = {}) {
  const factoryDir = join(repositoryRoot, ".opencode", "factory");
  const lockDir = join(factoryDir, "github-operation.lock");
  const ownerFile = join(lockDir, "owner.json");
  await mkdir(factoryDir, { recursive: true });
  const now = options?.now ?? Date.now;
  const sleep = options?.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const deadline = now() + (options?.timeoutMs ?? 10_000);
  let owner;
  while (!owner) {
    try {
      await mkdir(lockDir);
      owner = { pid: process.pid, hostname: hostname(), nonce: randomUUID() };
      await writeFile(ownerFile, `${JSON.stringify(owner)}\n`, { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await reclaimDeadLocalLock(lockDir, ownerFile)) continue;
      if (now() >= deadline) throw new PostPrCiError("lock-timeout", "GitHub operation lock timed out", { transient: true });
      await sleep(Math.min(25, Math.max(1, deadline - now())));
    }
  }
  try { return await fn(); } finally {
    try {
      const current = JSON.parse(await readFile(ownerFile, "utf8"));
      if (current.nonce === owner.nonce) await rm(lockDir, { recursive: true, force: true });
    } catch { /* Never remove a lock whose ownership cannot be confirmed. */ }
  }
}

async function reclaimDeadLocalLock(lockDir, ownerFile) {
  let owner;
  try { owner = JSON.parse(await readFile(ownerFile, "utf8")); } catch { return false; }
  if (owner.hostname !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.nonce !== "string") return false;
  try { process.kill(owner.pid, 0); return false; } catch (error) { if (error.code !== "ESRCH") return false; }
  const quarantine = `${lockDir}.dead-${randomUUID()}`;
  try { await rename(lockDir, quarantine); await rm(quarantine, { recursive: true, force: true }); return true; } catch { return false; }
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
function checkName(entry) { const name = entry?.name ?? entry?.context; if (typeof name !== "string" || name === "") throw protocol("check name is required"); return name; }
function rawMetadata(value) { if (typeof value === "string") return value; if (value?.encoding === "base64url+terminal-safe-display-v1") return Buffer.from(value.value_b64url, "base64url").toString("utf8"); throw protocol("invalid check metadata"); }
function sliceIdsInName(name, slices) { return slices.filter((slice) => new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegex(slice.id)}(?=$|[^A-Za-z0-9_-])`, "u").test(name)).map((slice) => slice.id); }
function validateSlices(slices) { if (!Array.isArray(slices)) throw new Error("slices must be an array"); return slices.map((slice) => { if (!slice || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(slice.id) || !Array.isArray(slice.paths)) throw new Error("invalid slice"); return { ...slice, paths: slice.paths.map(validatePlanPath) }; }); }
function validatePlanPath(path) { if (typeof path !== "string") return null; if (path.endsWith("/**") && !/[*?[\]{}]/u.test(path.slice(0, -3))) return `${normalizeRepositoryPath(path.slice(0, -3))}/**`; if (/[*?[\]{}]/u.test(path)) return null; return normalizeRepositoryPath(path); }
function sliceOwnsPath(slice, path) { return slice.paths.filter(Boolean).some((accepted) => accepted.endsWith("/**") ? path.startsWith(accepted.slice(0, -2)) : path === accepted); }
function routeSlice(slice, method) { const route = STACK_ROUTES[slice.stack]; if (!route) return unsafe("unknown-slice-stack"); return { disposition: "route", owner: { kind: "slice", slice_id: slice.id, stack: slice.stack, path_b64url: null, method }, route, lane: "slice", reason: method }; }
function integration() { return { disposition: "route", owner: { kind: "integration", slice_id: null, stack: "test", path_b64url: null, method: "integration" }, route: "test-verifier", lane: "test", reason: "integration-fallback" }; }
function unsafe(reason) { return { disposition: "needs-human", owner: null, route: null, lane: null, reason }; }
function isTestLanePath(path) { return TEST_PREFIXES.some((prefix) => path.startsWith(prefix)); }
function requireSuccessful(result, phase) { if (!result || result.exitCode !== 0) { const classified = classifyGitHubFailure(result ?? {}); if (phase === "account-switch") throw new PostPrCiError("account-switch", "GitHub account switch failed", { exitCode: classified.exitCode }); throw classified; } }
function parseJsonObject(text) { try { const value = JSON.parse(text); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; } catch { throw protocol("malformed GitHub JSON response"); } }
function parseIncludedArray(text) { const starts = [text.indexOf("["), text.indexOf("{")].filter((index) => index >= 0); if (!starts.length) throw protocol("malformed GitHub included response"); try { const value = JSON.parse(text.slice(Math.min(...starts))); if (!Array.isArray(value)) throw new Error(); return value; } catch { throw protocol("malformed GitHub included response"); } }
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
