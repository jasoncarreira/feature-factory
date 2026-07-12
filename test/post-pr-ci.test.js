import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  PostPrCiError, aggregateObservation, affectedPathsHash, buildFailureEvidenceInput, canonicalizePanelAffectedPaths, classifyGitHubFailure, classifyOwnership, classifyPanelResult,
  decideObservationSchedule, decideTransientSchedule, emitAffectedJson, encodeUntrustedMetadata, fetchChangedFiles,
  normalizeCheck, normalizeChecks, normalizePullRequestResponse, normalizeRepositoryPath, normalizeReview, parseRetryDelay,
  inspectPanelRunnerReturn, queryPullRequest, requestReviewer, runBoundedProcess, runGitHubOperation, snapshotPanelAffectedValue, validateLane,
} from "../src/post-pr-ci.js";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

describe("post-PR normalization", () => {
  it("normalizes every check family and applies red > pending > indeterminate > pass", () => {
    for (const status of ["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"]) assert.equal(normalizeCheck({ status }), "pending");
    for (const conclusion of ["SUCCESS", "NEUTRAL", "SKIPPED"]) assert.equal(normalizeCheck({ status: "COMPLETED", conclusion }), "pass");
    for (const conclusion of ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]) assert.equal(normalizeCheck({ status: "COMPLETED", conclusion }), "red");
    assert.equal(normalizeCheck({ status: "COMPLETED", conclusion: "STALE" }), "indeterminate");
    for (const [state, expected] of [["SUCCESS", "pass"], ["FAILURE", "red"], ["ERROR", "red"], ["PENDING", "pending"], ["EXPECTED", "pending"], ["NEW", "indeterminate"]]) {
      assert.equal(normalizeCheck({ __typename: "StatusContext", state }), expected);
    }
    const normalized = normalizeChecks([
      { name: "pass", status: "COMPLETED", conclusion: "SUCCESS" }, { name: "unknown", status: "COMPLETED" },
      { name: "wait", status: "IN_PROGRESS" }, { name: "fail", status: "COMPLETED", conclusion: "FAILURE" },
    ]);
    assert.equal(normalized.verdict, "red");
  });

  it("holds zero checks through grace and then marks them not applicable", () => {
    assert.equal(normalizeChecks([], { elapsedMs: 299_999, graceMs: 300_000 }).verdict, "not_started");
    assert.equal(normalizeChecks([], { elapsedMs: 300_000, graceMs: 300_000 }).verdict, "not_applicable");
  });

  it("uses latest current-head reviews, exact case-insensitive reviewer login, and dismissal", () => {
    const reviews = [
      review("Bot", "APPROVED", OTHER_SHA, "2026-01-01T00:00:00Z"),
      review("Bot", "APPROVED", SHA, "2026-01-02T00:00:00Z"),
      review("other", "CHANGES_REQUESTED", SHA, "2026-01-03T00:00:00Z"),
      review("other", "DISMISSED", SHA, "2026-01-04T00:00:00Z"),
      review("ignored", "COMMENTED", SHA, "2026-01-05T00:00:00Z", "never read this body"),
    ];
    assert.equal(normalizeReview({ reviews, expectedHeadSha: SHA, reviewerLogin: "bot" }).verdict, "pass");
    assert.equal(normalizeReview({ reviews: [], expectedHeadSha: SHA, reviewerLogin: "bot" }).verdict, "pending");
    assert.equal(normalizeReview({ reviews: [review("other", "CHANGES_REQUESTED", SHA, "2026-01-03T00:00:00Z")], expectedHeadSha: SHA, isDraft: true }).verdict, "red");
    assert.equal(normalizeReview({ reviews: [review("Bot", "APPROVED", SHA, "2026-01-02T00:00:00Z")], expectedHeadSha: SHA, reviewerLogin: "bot", isDraft: true }).verdict, "not_required");
    assert.equal(normalizeReview({ reviews: [], expectedHeadSha: SHA, reviewDecision: "FUTURE" }).verdict, "indeterminate");
    assert.throws(() => normalizeReview({ reviews: [], expectedHeadSha: SHA, isDraft: 1 }), /isDraft/u);
  });

  it("retains the globally latest applicable changes request with API order as tie-breaker", () => {
    const result = normalizeReview({ expectedHeadSha: SHA, reviews: [
      review("first", "CHANGES_REQUESTED", SHA, "2026-01-03T00:00:00Z"),
      review("newest", "CHANGES_REQUESTED", SHA, "2026-01-04T00:00:00Z"),
      review("tie-wins", "CHANGES_REQUESTED", SHA, "2026-01-04T00:00:00Z"),
    ] });
    assert.equal(Buffer.from(result.review.author.value_b64url, "base64url").toString(), "tie-wins");
    assert.equal(result.review.commit_id, SHA);
    assert.equal(JSON.stringify(result).includes("body"), false);
  });

  it("rejects malformed PR state, draft, decision, check, and review collections", () => {
    const valid = { headRefOid: SHA, isDraft: false, reviewDecision: null, reviews: [], state: "OPEN", statusCheckRollup: [] };
    const options = { expectedHeadSha: SHA, startedAt: 0, now: 1, reviewRequired: false };
    for (const patch of [{ isDraft: 0 }, { state: "UNKNOWN" }, { reviewDecision: "BOGUS" }, { reviews: {} }, { statusCheckRollup: {} }]) {
      assert.throws(() => normalizePullRequestResponse({ ...valid, ...patch }, options), (error) => error.errorClass === "protocol");
    }
    assert.throws(() => normalizeChecks(Array.from({ length: 201 }, () => ({ name: "x" }))), /exceeds 200/u);
    assert.throws(() => normalizeChecks([{ name: "x".repeat(257), status: "QUEUED" }]), /exceeds 256/u);
    assert.throws(() => normalizeReview({ expectedHeadSha: SHA, reviews: Array.from({ length: 201 }, () => ({})) }), /exceeds 200/u);
  });

  it("applies external state, head, review-red, check-red, pending, and green precedence", () => {
    const base = { expectedHeadSha: SHA, headRefOid: SHA, state: "OPEN", checkVerdict: "pass", reviewVerdict: "pass" };
    assert.equal(aggregateObservation({ ...base, state: "MERGED", headRefOid: OTHER_SHA }).reason, "external-merge");
    assert.equal(aggregateObservation({ ...base, state: "CLOSED" }).verdict, "blocked");
    assert.equal(aggregateObservation({ ...base, headRefOid: OTHER_SHA }).reason, "head-mismatch");
    assert.equal(aggregateObservation({ ...base, checkVerdict: "red", reviewVerdict: "red" }).primary, "review");
    assert.equal(aggregateObservation({ ...base, checkVerdict: "red", reviewVerdict: "pass" }).verdict, "red");
    assert.equal(aggregateObservation({ ...base, checkVerdict: "pending" }).verdict, "pending");
    assert.equal(aggregateObservation(base).verdict, "green");
  });
});

describe("durable scheduling decisions", () => {
  it("produces persisted 30/45/68/102/120 second valid backoff and reset", () => {
    const now = Date.parse("2026-01-01T00:00:00Z"); const deadlineAt = now + 3_600_000;
    let current = 30_000;
    const observed = [];
    for (let count = 0; count < 5; count += 1) {
      const result = decideObservationSchedule({ now, deadlineAt, changed: false, currentIntervalMs: current, initialPollMs: 30_000, maxPollMs: 120_000, unchangedCount: count });
      observed.push(result.interval_ms); current = result.interval_ms;
    }
    assert.deepEqual(observed, [45_000, 68_000, 102_000, 120_000, 120_000]);
    assert.equal(decideObservationSchedule({ now, deadlineAt, changed: true, currentIntervalMs: current, initialPollMs: 30_000, maxPollMs: 120_000 }).interval_ms, 30_000);
  });

  it("caps schedules at the original deadline and distinguishes exhaustion", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    assert.equal(decideTransientSchedule({ now, deadlineAt: now + 70_000, consecutiveErrors: 1, maxTransientErrors: 12 }).interval_ms, 60_000);
    assert.equal(decideTransientSchedule({ now, deadlineAt: now + 700_000, consecutiveErrors: 1, maxTransientErrors: 12, rateLimited: true }).interval_ms, 600_000);
    assert.equal(decideTransientSchedule({ now, deadlineAt: now + 700_000, consecutiveErrors: 12, maxTransientErrors: 12 }).reason, "transient-exhausted");
    assert.equal(decideObservationSchedule({ now: now + 1, deadlineAt: now, changed: true, currentIntervalMs: 30_000, initialPollMs: 30_000, maxPollMs: 120_000 }).reason, "deadline");
    assert.equal(decideObservationSchedule({ now, deadlineAt: now + 700_000, changed: true, currentIntervalMs: 30_000, initialPollMs: 30_000, maxPollMs: 120_000 }).consecutive_transient_errors, 0);
  });

  it("validates Retry-After and rate reset headers and chooses the larger delay", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    assert.equal(parseRetryDelay({ "Retry-After": "120" }, now), 120_000);
    assert.equal(parseRetryDelay({ "Retry-After": "Thu, 01 Jan 2026 00:01:00 GMT" }, now), 60_000);
    assert.equal(parseRetryDelay({ "Retry-After": "60", "X-RateLimit-Reset": String((now / 1000) + 180) }, now), 180_000);
    for (const headers of [{ "Retry-After": "later" }, { "X-RateLimit-Reset": "1.5" }, { "Retry-After": "1\nX: y" }]) {
      assert.throws(() => parseRetryDelay(headers, now), (error) => error.errorClass === "protocol");
    }
  });
});

describe("untrusted metadata, paths, ownership, and evidence", () => {
  const slices = [
    { id: "be-api", stack: "backend", paths: ["src/api/**"] },
    { id: "fe-ui", stack: "frontend", paths: ["src/ui/**"] },
  ];

  it("base64url encodes hostile metadata with terminal-safe display", () => {
    const encoded = encodeUntrustedMetadata('x"\\\n🧨');
    assert.equal(Buffer.from(encoded.value_b64url, "base64url").toString(), 'x"\\\n🧨');
    assert.equal(encoded.display, 'x\\"\\\\\\u000A\\uD83E\\uDDE8');
    assert.match(encoded.sha256, /^sha256:[0-9a-f]{64}$/u);
  });

  it("accepts only unchanged repository-relative POSIX paths", () => {
    assert.equal(normalizeRepositoryPath("src/a.js"), "src/a.js");
    for (const path of ["/etc/passwd", "C:/x", "a\\b", "a/../b", "a//b", "a\0b", "a/./b", `${"a".repeat(256)}/x`]) assert.throws(() => normalizeRepositoryPath(path), PostPrCiError);
  });

  it("classifies mutually exclusive owner and lane rows", () => {
    assert.equal(classifyOwnership({ slices, failingCheckNames: ["CI [be-api]"], paths: [] }).route, "backend-builder");
    assert.equal(classifyOwnership({ slices, failingCheckNames: ["build"], paths: ["src/ui/button.js"], complete: true }).route, "frontend-builder");
    assert.equal(classifyOwnership({ slices, failingCheckNames: ["tests"], paths: ["test/a.test.js"], complete: true }).route, "test-verifier");
    assert.equal(Buffer.from(classifyOwnership({ slices, failingCheckNames: ["tests"], paths: ["test/a.test.js"], complete: true }).owner.path_b64url, "base64url").toString(), "test/a.test.js");
    assert.equal(classifyOwnership({ slices, failingCheckNames: ["be-api", "fe-ui"], paths: [], complete: true }).disposition, "needs-human");
    assert.equal(classifyOwnership({ slices, failingCheckNames: ["be-api + fe-ui"], paths: ["src/api/x.js"], complete: true }).reason, "check-owner-ambiguous");
    assert.equal(classifyOwnership({ slices, failingCheckNames: ["be-api"], paths: ["src/ui/x.js"], complete: true }).reason, "check-file-conflict");
    assert.equal(classifyOwnership({ slices, reviewVerdict: "red", failingCheckNames: ["be-api"] }).route, null);
    assert.equal(classifyOwnership({ slices, failingCheckNames: ["build"], paths: ["package.json"], complete: true }).disposition, "needs-human");
    assert.equal(classifyOwnership({ slices, failingCheckNames: ["build"], paths: ["src/api/x.js"], complete: false }).reason, "changed-files-incomplete");
    const selected = classifyOwnership({ slices, failingCheckNames: ["build"], paths: ["src/api/z.js", "src/api/a.js"], complete: true });
    assert.equal(Buffer.from(selected.owner.path_b64url, "base64url").toString(), "src/api/a.js");
    assert.equal(Object.hasOwn(selected, "path"), false);
    assert.equal(validateLane({ lane: "slice", slice: slices[0], paths: ["src/api/x.js"] }).ok, true);
    assert.equal(validateLane({ lane: "slice", slice: slices[0], paths: ["src/ui/x.js"] }).ok, false);
    assert.equal(validateLane({ lane: "test", paths: [".github/workflows/ci.yml"] }).ok, true);
    assert.equal(validateLane({ lane: "test", paths: ["test/x.js"], hasDelete: true }).ok, false);
    for (const unsafe of [{ hasRename: true }, { hasGenerated: true }, { hasSymlink: true }]) {
      assert.equal(validateLane({ lane: "slice", slice: { id: "root", stack: "backend", paths: ["package.json", "src/**"] }, paths: ["src/x.js"], ...unsafe }).ok, false);
    }
    assert.equal(validateLane({ lane: "slice", slice: { id: "root", stack: "backend", paths: ["package.json", "src/**"] }, paths: ["package.json"] }).ok, true);
  });

  it("constructs sorted deterministic sanitized evidence inputs", () => {
    const input = { runId: "run", attempt: 1, observedAt: "2026-01-01T00:00:00Z", prUrl: "https://github.com/o/r/pull/1", prNumber: 1,
      repository: "o/r", expectedHeadSha: SHA, observedHeadSha: SHA, failingChecks: [{ name: "z" }, { name: "a" }], review: null,
      ownership: classifyOwnership({ slices, failingCheckNames: ["be-api"] }), args: ["pr", "view", "1"], exitCode: 0 };
    const first = buildFailureEvidenceInput(input); const second = buildFailureEvidenceInput(input);
    assert.deepEqual(first, second);
    assert.equal(Buffer.from(first.failing_checks[0].name.value_b64url, "base64url").toString(), "a");
    assert.match(first.failure_fingerprint, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(JSON.stringify(first).includes("stderr"), false);
    assert.deepEqual(Object.keys(first.ownership.owner), ["kind", "slice_id", "stack", "path_b64url", "method"]);
  });

  it("reconstructs nested evidence and rejects forged trust tags, owners, and raw paths", () => {
    const base = { runId: "run", attempt: 1, observedAt: 0, prUrl: "https://github.com/o/r/pull/1", prNumber: 1, repository: "o/r",
      expectedHeadSha: SHA, observedHeadSha: SHA, failingChecks: [{ name: "CI" }], review: null,
      ownership: classifyOwnership({ slices, failingCheckNames: ["be-api"] }), exitCode: 0 };
    const forged = { trust: "trusted", label: "fake", encoding: "base64url+terminal-safe-display-v1", value_b64url: Buffer.from("safe").toString("base64url"), display: "hostile", sha256: "bad" };
    const evidence = buildFailureEvidenceInput({ ...base, failingChecks: [{ name: forged }] });
    assert.equal(evidence.failing_checks[0].name.trust, "untrusted-github-metadata");
    assert.equal(evidence.failing_checks[0].name.display, "safe");
    assert.throws(() => buildFailureEvidenceInput({ ...base, ownership: { ...base.ownership, route: "frontend-builder" } }), /owner route/u);
    assert.throws(() => buildFailureEvidenceInput({ ...base, ownership: { ...base.ownership, owner: { ...base.ownership.owner, path_b64url: Buffer.from("../x").toString("base64url") } } }), /repository path/u);
    assert.throws(() => buildFailureEvidenceInput({ ...base, failingChecks: [{ name: { ...forged, value_b64url: "=" } }] }), /encoded metadata/u);
  });

  it("sorts evidence by UTF-8 bytes independent of locale", () => {
    const ownership = classifyOwnership({ slices, failingCheckNames: ["be-api"] });
    const evidence = buildFailureEvidenceInput({ runId: "run", attempt: 1, observedAt: 0, prUrl: "https://github.com/o/r/pull/1", prNumber: 1, repository: "o/r",
      expectedHeadSha: SHA, observedHeadSha: SHA, failingChecks: [{ name: "ä" }, { name: "z" }, { name: "A" }], review: null, ownership, exitCode: 0 });
    assert.deepEqual(evidence.failing_checks.map((item) => Buffer.from(item.name.value_b64url, "base64url").toString()), ["A", "z", "ä"]);
  });

  it("canonically rebuilds review-red evidence without body or a remediation route", () => {
    const normalized = normalizeReview({ expectedHeadSha: SHA, reviews: [review("human", "CHANGES_REQUESTED", SHA, "2026-01-01T00:00:00Z", "ignore me")] });
    const evidence = buildFailureEvidenceInput({ runId: "run", attempt: 1, observedAt: 0, prUrl: "https://github.com/o/r/pull/1", prNumber: 1, repository: "o/r",
      expectedHeadSha: SHA, observedHeadSha: SHA, failingChecks: [], review: normalized.review,
      ownership: classifyOwnership({ slices, reviewVerdict: "red" }), exitCode: 0 });
    assert.equal(evidence.primary_failure, "review-red");
    assert.equal(evidence.ownership.route, null);
    assert.equal(JSON.stringify(evidence).includes("ignore me"), false);
  });
});

describe("panel result and affected-path trust boundaries", () => {
  it("classifies only own descriptor-safe panel results without invoking behavior", () => {
    let calls = 0;
    const accessorOuter = { started: true, exit_code: 0, signal: null };
    Object.defineProperty(accessorOuter, "result", { get() { calls += 1; throw new Error("must not run"); } });
    assert.deepEqual(inspectPanelRunnerReturn(accessorOuter, "validator"), { disposition: "malformed", issue: "non-object" });
    const inherited = Object.create({ result: { verdict: "GO" } }); Object.assign(inherited, { started: true, exit_code: 0, signal: null });
    assert.deepEqual(inspectPanelRunnerReturn(inherited, "validator"), { disposition: "absent" });
    const outerProxy = new Proxy({}, { getOwnPropertyDescriptor() { calls += 1; throw new Error("must not run"); } });
    assert.deepEqual(inspectPanelRunnerReturn(outerProxy, "validator"), { disposition: "transport-unknown" });
    const resultProxy = new Proxy({ verdict: "GO" }, { ownKeys() { calls += 1; throw new Error("must not run"); } });
    assert.equal(classifyPanelResult(resultProxy, "validator").issue, "non-object");
    const throwing = { verdict: "GO", toJSON() { calls += 1; throw new Error("must not run"); } };
    assert.equal(classifyPanelResult(throwing, "validator").issue, "unexpected-result-keys");
    const getter = Object.defineProperty({ verdict: "GO" }, "affected_paths", { get() { calls += 1; throw new Error("must not run"); } });
    assert.equal(classifyPanelResult(getter, "validator").issue, "unexpected-result-keys");
    assert.equal(calls, 0);
    assert.equal(classifyPanelResult({}, "validator").issue, "missing-verdict");
    assert.equal(classifyPanelResult({ extra: true }, "validator").issue, "missing-verdict");
    assert.equal(classifyPanelResult({ verdict: "WRONG", extra: true }, "validator").issue, "unexpected-result-keys");
    assert.equal(classifyPanelResult({ verdict: "WRONG" }, "validator").issue, "invalid-verdict");
    assert.equal(classifyPanelResult(Object.assign(Object.create(null), { verdict: "PASS" }), "security").ok, true);
  });

  it("takes bounded deterministic affected-value snapshots without getters, proxies, cycles, or JSON hooks", () => {
    const descriptor = (value) => ({ value, writable: true, enumerable: true, configurable: true });
    assert.deepEqual(snapshotPanelAffectedValue(descriptor(-0)).value, 0);
    assert.deepEqual(snapshotPanelAffectedValue(descriptor({ z: 1, a: [true, null, "x"] })).value, Object.assign(Object.create(null), { a: [true, null, "x"], z: 1 }));
    const repeated = { x: 1 }; assert.equal(snapshotPanelAffectedValue(descriptor([repeated, repeated])).ok, true);
    const cycle = {}; cycle.self = cycle; assert.equal(snapshotPanelAffectedValue(descriptor(cycle)).ok, false);
    for (const value of [undefined, 1n, Symbol("x"), () => {}, NaN, Infinity, new Date(), Object.create({}), new Proxy({}, {})]) assert.equal(snapshotPanelAffectedValue(descriptor(value)).ok, false);
    assert.equal(snapshotPanelAffectedValue(descriptor("\uD800")).ok, false);
    assert.equal(snapshotPanelAffectedValue(descriptor("a".repeat(4096))).ok, true);
    assert.equal(snapshotPanelAffectedValue(descriptor("a".repeat(4097))).ok, false);
    assert.equal(snapshotPanelAffectedValue(descriptor(new Array(4096).fill(null))).ok, true);
    assert.equal(snapshotPanelAffectedValue(descriptor(new Array(4097).fill(null))).ok, false);
    const sparse = []; sparse.length = 1; assert.equal(snapshotPanelAffectedValue(descriptor(sparse)).ok, false);
    const extra = ["x"]; extra.extra = true; assert.equal(snapshotPanelAffectedValue(descriptor(extra)).ok, false);
    const nestedAccessor = {}; Object.defineProperty(nestedAccessor, "x", { enumerable: true, get() { throw new Error("must not run"); } });
    assert.equal(snapshotPanelAffectedValue(descriptor(nestedAccessor)).ok, false);
  });

  it("covers every affected snapshot limit at the boundary and one over", () => {
    const descriptor = (value) => ({ value, writable: true, enumerable: true, configurable: true });
    for (const value of [null, false, true, "safe", 0, -0, 1.25]) assert.equal(snapshotPanelAffectedValue(descriptor(value)).ok, true);
    const depthValue = (containers) => { let root = {}; let cursor = root; for (let index = 1; index < containers; index += 1) { cursor.x = {}; cursor = cursor.x; } cursor.x = null; return root; };
    assert.equal(snapshotPanelAffectedValue(descriptor(depthValue(32))).ok, true);
    assert.equal(snapshotPanelAffectedValue(descriptor(depthValue(33))).ok, false);
    assert.equal(snapshotPanelAffectedValue(descriptor(new Array(4096).fill(null))).ok, true);
    assert.equal(snapshotPanelAffectedValue(descriptor(new Array(4097).fill(null))).ok, false);
    const occurrenceTree = (extras) => { const root = {}; let level = [root]; for (let depth = 0; depth < 12; depth += 1) { const next = []; for (const node of level) { node.a = {}; node.b = {}; next.push(node.a, node.b); } level = next; } if (extras > 0) level[0].x = {}; if (extras > 1) level[0].y = {}; return root; };
    assert.equal(snapshotPanelAffectedValue(descriptor(occurrenceTree(1))).ok, true);
    assert.equal(snapshotPanelAffectedValue(descriptor(occurrenceTree(2))).ok, false);
    const exactEntries = Object.fromEntries(Array.from({ length: 8192 }, (_, index) => [`k${index.toString(16).padStart(4, "0")}`, null]));
    assert.equal(snapshotPanelAffectedValue(descriptor(exactEntries)).ok, true);
    exactEntries.overflow = null; assert.equal(snapshotPanelAffectedValue(descriptor(exactEntries)).ok, false);
    const nearAggregate = new Array(255).fill("a".repeat(4096));
    assert.equal(snapshotPanelAffectedValue(descriptor(nearAggregate)).ok, true);
    const exactAggregate = new Array(256).fill("a".repeat(4096));
    assert.equal(snapshotPanelAffectedValue(descriptor(exactAggregate)).ok, false); // exact aggregate strings necessarily exceed the independent pretty-emission ceiling
    exactAggregate.push("a"); assert.equal(snapshotPanelAffectedValue(descriptor(exactAggregate)).ok, false);
    const emitted = new Array(255).fill("a".repeat(4096));
    const baseBytes = Buffer.byteLength(JSON.stringify([...emitted, ""], null, 2), "utf8");
    emitted.push("a".repeat(1_048_576 - baseBytes));
    const exactEmission = snapshotPanelAffectedValue(descriptor(emitted));
    assert.equal(exactEmission.ok, true); assert.equal(Buffer.byteLength(exactEmission.json, "utf8"), 1_048_576);
    emitted[emitted.length - 1] += "a"; assert.equal(snapshotPanelAffectedValue(descriptor(emitted)).ok, false);
    assert.equal(emitAffectedJson({ a: ["\b\f\n\r\t", "\u0000", "é"] }), '{\n  "a": [\n    "\\b\\f\\n\\r\\t",\n    "\\u0000",\n    "é"\n  ]\n}');
  });

  it("rejects every exceptional affected container without invoking behavior", () => {
    const descriptor = (value) => ({ value, writable: true, enumerable: true, configurable: true }); let calls = 0;
    const symbolArray = ["x"]; symbolArray[Symbol("x")] = true;
    const accessorArray = ["x"]; Object.defineProperty(accessorArray, "0", { enumerable: true, get() { calls += 1; throw new Error("must not run"); } });
    const nestedProxy = [{ value: new Proxy({}, { ownKeys() { calls += 1; throw new Error("must not run"); } }) }];
    const callableToJson = { toJSON() { calls += 1; return "unsafe"; } };
    const inheritedToJson = Object.create({ toJSON() { calls += 1; } }); inheritedToJson.value = true;
    for (const value of [symbolArray, accessorArray, nestedProxy, callableToJson, inheritedToJson, new String("x"), /x/u, new Map(), new Set(), { value: 1n }, { value: Symbol("x") }, { value() {} }, { value: -Infinity }]) {
      assert.equal(snapshotPanelAffectedValue(descriptor(value)).ok, false);
    }
    assert.equal(calls, 0);
  });

  it("canonicalizes the closed path grammar, NFC duplicates, byte order, and hashes", () => {
    const root = "/tmp/panel-root";
    const valid = canonicalizePanelAffectedPaths(["src/é.js", "src/e\u0301.js", "src/a.js"], root);
    assert.equal(valid.ok, true);
    assert.deepEqual(valid.paths, ["src/a.js", "src/é.js"]);
    assert.equal(valid.hash, "6baaa1bd8c026a2daf4fd9dd32ed05c9c277a310b2f9f3824662133657648cb0");
    assert.equal(affectedPathsHash(["src/a.js"]), "8401f45c9f8a46344b10c43978d5498580842854aaebf2033cfa84e828bc4cc5");
    assert.equal(affectedPathsHash([]), "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
    assert.equal(canonicalizePanelAffectedPaths([], root).category, "empty-paths");
    assert.equal(canonicalizePanelAffectedPaths(["a".repeat(4096)], root).ok, true);
    for (const value of [[1], [new String("x")], [""], ["/x"], ["C:/x"], ["c:/x"], ["a\\b"], ["a\u0000b"], ["a\u001fb"], ["a\u007fb"], ["a//b"], ["a/"], ["a/./b"], ["a/../b"], ["../x"], ["\uD800"], ["a".repeat(4097)], ["src/a.js", "../bad"]]) {
      const result = canonicalizePanelAffectedPaths(value, root); assert.equal(result.category, "invalid-paths"); assert.equal(result.hash, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
    }
  });
});

describe("bounded GitHub execution", () => {
  it("runs mandatory switch immediately before one operation without a shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "post-pr-gh-")); const calls = [];
    try {
      const result = await runGitHubOperation({ repositoryRoot: root, account: "octocat", args: ["pr", "view", "1"], execute: async (input) => {
        calls.push(input); return { exitCode: 0, stdout: calls.length === 2 ? "{}" : "", stderr: "" };
      } });
      assert.equal(result.stdout, "{}");
      assert.deepEqual(calls.map((call) => call.args), [["auth", "switch", "-h", "github.com", "-u", "octocat"], ["pr", "view", "1"]]);
      assert.equal(calls.every((call) => call.executable === "gh"), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed on account switch and does not execute the operation", async () => {
    const root = mkdtempSync(join(tmpdir(), "post-pr-gh-")); let calls = 0;
    try {
      await assert.rejects(runGitHubOperation({ repositoryRoot: root, account: "octocat", args: ["pr", "view"], execute: async () => ({ exitCode: ++calls === 1 ? 1 : 0, stdout: "", stderr: "token" }) }),
        (error) => error.errorClass === "account-switch");
      assert.equal(calls, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("constructs the reviewer request as the sole operation after account switch", async () => {
    const root = mkdtempSync(join(tmpdir(), "post-pr-gh-")); const calls = [];
    try {
      await requestReviewer({ repositoryRoot: root, account: "octocat", repository: "o/r", prNumber: 7, reviewerLogin: "Review-Bot", execute: async (input) => {
        calls.push(input.args); return { exitCode: 0, stdout: "", stderr: "hidden" };
      } });
      assert.deepEqual(calls, [["auth", "switch", "-h", "github.com", "-u", "octocat"], ["pr", "edit", "7", "--repo", "o/r", "--add-reviewer", "Review-Bot"]]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("queries with checked identity and parses only bounded JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "post-pr-gh-")); const calls = [];
    try {
      const response = await queryPullRequest({ repositoryRoot: root, account: "octocat", repository: "o/r", prNumber: 7, execute: async (input) => {
        calls.push(input.args); return { exitCode: 0, stdout: input.args[0] === "pr" ? JSON.stringify({ headRefOid: SHA }) : "", stderr: "" };
      } });
      assert.equal(response.headRefOid, SHA);
      assert.deepEqual(calls[1].slice(0, 5), ["pr", "view", "7", "--repo", "o/r"]);
      await assert.rejects(queryPullRequest({ repositoryRoot: root, account: "octocat", repository: "-R", prNumber: 7 }), /invalid repository/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("follows Link pagination, treats exactly 300 without next as complete, and bounds page size", async () => {
    const root = mkdtempSync(join(tmpdir(), "post-pr-gh-")); let operations = 0;
    try {
      const result = await fetchChangedFiles({ repositoryRoot: root, account: "octocat", repository: "o/r", prNumber: 7, execute: async (input) => {
        if (input.args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
        operations += 1;
        const link = operations < 3 ? `Link: <https://api.github.com/page=${operations + 1}>; rel="next"\n` : "";
        return { exitCode: 0, stdout: `HTTP/2 200\n${link}\n${JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ filename: `test/p${operations}-${index}`, status: "modified" })))}`, stderr: "" };
      } });
      assert.equal(result.complete, true); assert.equal(result.pages, 3); assert.equal(operations, 3); assert.equal(result.paths.length, 300);
      operations = 0;
      await assert.rejects(fetchChangedFiles({ repositoryRoot: root, account: "octocat", repository: "o/r", prNumber: 7, execute: async (input) => {
        if (input.args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 0, stdout: `HTTP/2 200\n\n${JSON.stringify(Array.from({ length: 101 }, (_, index) => ({ filename: `test/${index}` })))}`, stderr: "" };
      } }), /exceeds 100/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("marks a page-three next link incomplete and rejects malformed Link and rename paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "post-pr-gh-")); let page = 0;
    try {
      const execute = async (input) => {
        if (input.args[0] === "auth") return { exitCode: 0, stdout: "", stderr: "" };
        page += 1; return { exitCode: 0, stdout: `HTTP/2 200\nLink: <https://api.github.com/page=${page + 1}>; rel="next"\n\n${JSON.stringify([{ filename: `src/${page}`, previous_filename: `old/${page}`, status: "renamed" }])}`, stderr: "" };
      };
      const result = await fetchChangedFiles({ repositoryRoot: root, account: "octocat", repository: "o/r", prNumber: 7, execute });
      assert.equal(result.complete, false); assert.equal(result.pages, 3); assert.equal(result.changes[0].status, "renamed");
      await assert.rejects(fetchChangedFiles({ repositoryRoot: root, account: "octocat", repository: "o/r", prNumber: 7, execute: async (input) => input.args[0] === "auth"
        ? { exitCode: 0, stdout: "", stderr: "" }
        : { exitCode: 0, stdout: "HTTP/2 200\nLink: nonsense\n\n[]", stderr: "" } }), /Link header/u);
      await assert.rejects(fetchChangedFiles({ repositoryRoot: root, account: "octocat", repository: "o/r", prNumber: 7, execute: async (input) => input.args[0] === "auth"
        ? { exitCode: 0, stdout: "", stderr: "" }
        : { exitCode: 0, stdout: 'HTTP/2 200\n\n[{"filename":"src/x"}]', stderr: "" } }), /status is invalid/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("kills fake executables on stdout cap and timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "post-pr-exec-"));
    try {
      const noisy = fakeExecutable(root, "noisy", "process.stdout.write('x'.repeat(10000)); setTimeout(() => {}, 10000);");
      await assert.rejects(runBoundedProcess({ executable: noisy, args: [], cwd: root, timeoutMs: 1000, stdoutCap: 100, stderrCap: 100 }), (error) => error.errorClass === "protocol");
      const sleepy = fakeExecutable(root, "sleepy", "setTimeout(() => {}, 10000);");
      await assert.rejects(runBoundedProcess({ executable: sleepy, args: [], cwd: root, timeoutMs: 20, stdoutCap: 100, stderrCap: 100 }), (error) => error.errorClass === "timeout" && error.transient);
      const stderrNoisy = fakeExecutable(root, "stderr-noisy", "process.stderr.write('secret'.repeat(1000)); setTimeout(() => {}, 10000);");
      await assert.rejects(runBoundedProcess({ executable: stderrNoisy, args: [], cwd: root, timeoutMs: 1000, stdoutCap: 100, stderrCap: 100 }), (error) => error.errorClass === "protocol" && !error.message.includes("secret"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("spawns an argument-array command with shell disabled", async () => {
    let observed;
    const spawnImpl = (executable, args, options) => {
      observed = { executable, args, options }; const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      queueMicrotask(() => { child.stdout.end("ok"); child.stderr.end(); child.emit("close", 0, null); });
      return child;
    };
    const result = await runBoundedProcess({ executable: "gh", args: ["pr", "view", "7"], cwd: "/tmp", timeoutMs: 1000, stdoutCap: 100, stderrCap: 100, spawnImpl });
    assert.equal(result.stdout, "ok"); assert.equal(observed.options.shell, false); assert.deepEqual(observed.args, ["pr", "view", "7"]);
  });

  it("classifies deterministic transient and permanent errors", () => {
    assert.equal(classifyGitHubFailure({ httpStatus: 429 }).errorClass, "rate-limit");
    assert.equal(classifyGitHubFailure({ httpStatus: 503 }).transient, true);
    assert.equal(classifyGitHubFailure({ message: "ECONNRESET" }).errorClass, "network");
    assert.equal(classifyGitHubFailure({ httpStatus: 401 }).errorClass, "account-auth");
    assert.equal(classifyGitHubFailure({ httpStatus: 403 }).errorClass, "permission");
    assert.equal(classifyGitHubFailure({ httpStatus: 404 }).errorClass, "not-found");
    assert.equal(classifyGitHubFailure({ exitCode: 2 }).errorClass, "command");
    assert.equal(classifyGitHubFailure({ message: "please consider your rate limit" }).errorClass, "command");
    assert.equal(classifyGitHubFailure({ message: "API rate limit exceeded", headers: { "Retry-After": "700" }, now: 0 }).retryAfterMs, 700_000);
    assert.equal(classifyGitHubFailure({ httpStatus: 503, headers: { "Retry-After": "90" }, now: 0 }).retryAfterMs, 90_000);
    assert.equal(classifyGitHubFailure({ message: "secondary rate limit" }).rateLimited, true);
    assert.equal(classifyGitHubFailure({ message: "DNS may be unavailable" }).errorClass, "command");
    assert.equal(classifyGitHubFailure({ stderr: "opaque-token", exitCode: 2 }).message.includes("opaque-token"), false);
    for (const status of [408, 500, 502, 503, 504]) assert.equal(classifyGitHubFailure({ httpStatus: status }).errorClass, "http-transient");
  });

  it("publishes lock ownership before atomic acquisition and cleans failed claims", async () => {
    const root = mkdtempSync(join(tmpdir(), "post-pr-lock-"));
    try {
      await assert.rejects(runGitHubOperation({ repositoryRoot: root, account: "octocat", args: ["pr", "view"], execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        lockOptions: { onClaimPublished: async () => { throw new Error("publication interrupted"); } } }), /publication interrupted/u);
      const factory = join(root, ".opencode", "factory");
      assert.deepEqual(readdirSync(factory), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reclaims only a confirmed dead local lock and preserves live/ownerless locks", async () => {
    const root = mkdtempSync(join(tmpdir(), "post-pr-lock-")); const factory = join(root, ".opencode", "factory"); const lock = join(factory, "github-operation.lock");
    mkdirSync(factory, { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: 999999, hostname: hostname(), nonce: "dead" }));
    try {
      const calls = [];
      await runGitHubOperation({ repositoryRoot: root, account: "octocat", args: ["pr", "view"], execute: async (input) => { calls.push(input.args); return { exitCode: 0, stdout: "", stderr: "" }; }, lockOptions: { isProcessAlive: async () => false } });
      assert.equal(calls.length, 2);
      let clock = 0;
      writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: hostname(), nonce: "live" }));
      await assert.rejects(runGitHubOperation({ repositoryRoot: root, account: "octocat", args: ["pr"], execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        lockOptions: { now: () => clock, sleep: async (ms) => { clock += ms; }, timeoutMs: 1, isProcessAlive: async () => true } }), (error) => error.errorClass === "lock-timeout");
      rmSync(lock);
      writeFileSync(lock, ""); clock = 0;
      await assert.rejects(runGitHubOperation({ repositoryRoot: root, account: "octocat", args: ["pr"], execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        lockOptions: { now: () => clock, sleep: async (ms) => { clock += ms; }, timeoutMs: 1 } }), (error) => error.errorClass === "lock-timeout");
      assert.equal(readdirSync(factory).includes("github-operation.lock"), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("serializes complete switch-operation pairs", async () => {
    const root = mkdtempSync(join(tmpdir(), "post-pr-lock-")); const calls = [];
    let releaseFirst; let markStarted;
    const firstStarted = new Promise((resolvePromise) => { markStarted = resolvePromise; });
    const blocker = new Promise((resolvePromise) => { releaseFirst = resolvePromise; });
    const execute = async (input) => {
      calls.push(input.args);
      if (input.args[0] === "pr" && calls.length === 2) { markStarted(); await blocker; }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    try {
      const first = runGitHubOperation({ repositoryRoot: root, account: "octocat", args: ["pr", "view", "1"], execute });
      await firstStarted;
      const second = runGitHubOperation({ repositoryRoot: root, account: "octocat", args: ["pr", "view", "2"], execute });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      assert.equal(calls.length, 2);
      releaseFirst(); await Promise.all([first, second]);
      assert.deepEqual(calls.map((args) => args.slice(0, 3)), [["auth", "switch", "-h"], ["pr", "view", "1"], ["auth", "switch", "-h"], ["pr", "view", "2"]]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("normalized response integration", () => {
  it("does not turn a long pending observation into red", () => {
    const result = normalizePullRequestResponse({ headRefOid: SHA, isDraft: false, reviewDecision: null, reviews: [], state: "OPEN",
      statusCheckRollup: [{ name: "CI", status: "IN_PROGRESS", conclusion: null }] },
    { expectedHeadSha: SHA, startedAt: "2026-01-01T00:00:00Z", now: "2026-01-01T00:25:00Z", checkStartGraceMs: 300_000, reviewRequired: false });
    assert.equal(result.aggregate.verdict, "pending");
  });
});

function review(login, state, oid, submittedAt, body) { return { author: { login }, state, commit: { oid }, submittedAt, body }; }
function fakeExecutable(root, name, body) {
  const bin = join(root, name); writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`, "utf8"); chmodSync(bin, 0o755); return bin;
}
