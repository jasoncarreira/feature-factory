import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OutputPolicyError,
  SAFE_GENERIC_ERROR_DETAIL,
  SAFE_OUTPUT_FALLBACK,
  StructuredOutputError,
  TRUSTED_SEGMENTS,
  errorOutputSegments,
  freeformSegment,
  identitySegment,
  isDisplaySafeBranch,
  isDisplaySafeRunId,
  isDisplaySafeSteeringRef,
  isOutputSegment,
  projectDiagnosticData,
  projectFreeformData,
  renderErrorForTerminal,
  renderTerminalSegments,
  renderTerminalSegmentsOrFallback,
  safeGenericErrorDetail,
  trustedSegment,
} from "../src/hardening/output-policy.js";
import { serializeTerminalJson } from "../src/hardening/terminal-encoding.js";

const SECRET = "github_pat_123456789012345678901234567890";

describe("typed output segments", () => {
  it("recognizes descriptive run identities without admitting credential or opaque token shapes", () => {
    assert.equal(isDisplaySafeRunId("cleanup-sweep-integration-continuation"), true);
    assert.equal(isDisplaySafeRunId("post-pr-ci-remediation-continuation-2"), true);
    assert.equal(isDisplaySafeRunId("issue-69-planning-seeded-recovery"), true);
    for (const value of [
      SECRET,
      "run-sk-abcdefghijklmnopqrstuvwx",
      "a-ask-abcdefghijklmnopqrst",
      "run-glpat-abcdefghijklmnopqrstuvwx",
      "a-aglpat-abcdefghijklmnopqrstuvwx",
      "run-xoxb-abcdefghijkl-mnopqrstuvwx",
      "a-axoxb-abcdefghijkl-mnopqrstuvwx",
      "cleanup-secret-token",
      "run.lock",
      "run..name",
      "abcdef12-1234-5678-9012-abcdefabcdef",
      "run-abcdef12-1234-5678-9012-abcdefabcdef",
      "eabcdef12-1234-5678-9012-abcdefabcdef",
      "run-abcdef0123456789abcdef0123456789",
      "run-abcdefghijklmnopqrstuvwxyz123456",
      "job-qwertyuiopasdfghjklzxcvbnm123456",
      "run-abcdefghijklmnopqrstuvwxyzabcdef",
    ]) {
      assert.equal(isDisplaySafeRunId(value), false, value);
    }
  });

  it("recognizes descriptive branches without admitting credential or opaque token shapes", () => {
    assert.equal(isDisplaySafeBranch("issue-69-single-slice-acceptance"), true);
    assert.equal(isDisplaySafeBranch("feature/single-slice-69"), true);
    for (const value of [
      SECRET,
      "feature/run-sk-abcdefghijklmnopqrstuvwx",
      "cleanup-secret-token",
      "run.lock",
      "run..name",
      "feature//double",
      "run-abcdef12-1234-5678-9012-abcdefabcdef",
      "branch-abcdefghijklmnopqrstuvwxyzabcdef",
    ]) {
      assert.equal(isDisplaySafeBranch(value), false, value);
    }
  });

  it("recognizes only factory-owned steering refs for identity display", () => {
    assert.equal(isDisplaySafeSteeringRef("steering/pending-2026-07-13T20-55-19-210Z-a21cdd76-6c04-41c6-a890-7403236e8313.json"), true);
    assert.equal(isDisplaySafeSteeringRef("steering/consumed-2026-07-13T20-55-19-210Z-a21cdd76-6c04-41c6-a890-7403236e8313-2.json"), true);
    for (const value of [
      "steering/pending.json",
      "steering/pending-2026-07-13T20-55-19Z-not-a-uuid.json",
      "steering/../pending-2026-07-13T20-55-19Z-a21cdd76-6c04-41c6-a890-7403236e8313.json",
      "steering/pending-2026-07-13T20-55-19Z-github_pat_123456789012345678901234567890.json",
      "other/pending-2026-07-13T20-55-19Z-a21cdd76-6c04-41c6-a890-7403236e8313.json",
    ]) {
      assert.equal(isDisplaySafeSteeringRef(value), false, value);
    }
  });

  it("creates frozen branded segments with the documented public shape", () => {
    const trusted = trustedSegment("ERROR_PREFIX");
    const identity = identitySegment("run-id");
    const freeform = freeformSegment("ready");
    assert.deepEqual(trusted, { kind: "trusted", value: "error: " });
    assert.deepEqual(identity, { kind: "identity", value: "run-id" });
    assert.deepEqual(freeform, { kind: "freeform", value: "ready" });
    for (const segment of [trusted, identity, freeform]) {
      assert.equal(Object.isFrozen(segment), true);
      assert.equal(isOutputSegment(segment), true);
    }
  });

  it("only selects statically declared trusted framing and rejects untyped lookalikes", () => {
    assert.equal(trustedSegment("ERROR_PREFIX"), TRUSTED_SEGMENTS.ERROR_PREFIX);
    assertPolicyFailure(() => trustedSegment("not repository framing"), "segment");
    assertPolicyFailure(
      () => renderTerminalSegments([{ kind: "trusted", value: "forged: " }]),
      "segment",
    );
  });

  it("rejects forged and accessor-backed template-like arrays without reading them", () => {
    const forged = ["forged\u001B\u202E"];
    Object.defineProperty(forged, "raw", {
      value: Object.freeze(["forged\\u001B\\u202E"]),
      enumerable: false, configurable: false, writable: false,
    });
    Object.freeze(forged);
    assertPolicyFailure(() => trustedSegment(forged), "segment");
    let getterCalls = 0;
    const accessorBacked = [];
    Object.defineProperty(accessorBacked, "0", {
      get() { getterCalls += 1; return "forged"; },
    });
    Object.defineProperty(accessorBacked, "raw", {
      get() { getterCalls += 1; return ["forged"]; },
    });
    Object.freeze(accessorBacked);
    assertPolicyFailure(() => trustedSegment(accessorBacked), "segment");
    assert.equal(getterCalls, 0);
  });
});

describe("terminal segment rendering", () => {
  it("inherits credential-only flattened Basic redaction through public APIs", () => {
    const credential = "dXNlcjpwYXNz==";
    const source = `before\r\nAuthorization\t=\tBASIC ${credential}\rafter`;
    const rendered = renderTerminalSegments([freeformSegment(source)]);
    assert.equal(rendered, "before\\u000D\\u000AAuthorization\\u0009=\\u0009BASIC [redacted]\\u000Dafter");
    assert.equal(rendered.includes(credential), false);
    assert.doesNotMatch(rendered, /[\r\n\u001B\u0007]/u);

    const projected = projectFreeformData({ detail: source });
    assert.equal(projected.detail, `before\r\nAuthorization\t=\tBASIC [redacted]\rafter`);
    assert.equal(serializeTerminalJson(projected).includes(credential), false);
  });

  it("redacts Proxy-Authorization Basic credentials through public APIs", () => {
    // Standard credential-bearing header (RFC 7235 section 4.4); previously the
    // lookalike boundary excluded the Proxy- prefix and let the token through.
    const credential = "dXNlcjpwYXNz";
    const source = `Proxy-Authorization: Basic ${credential}`;
    const rendered = renderTerminalSegments([freeformSegment(source)]);
    assert.equal(rendered, "Proxy-Authorization: Basic [redacted]");
    assert.equal(rendered.includes(credential), false);

    const projected = projectFreeformData({ detail: source });
    assert.equal(projected.detail, "Proxy-Authorization: Basic [redacted]");
    assert.equal(serializeTerminalJson(projected).includes(credential), false);
  });

  it("never scrubs identity and always renders it with the ASCII identity profile", () => {
    const identity = `${SECRET}\u001B\u202Eé`;
    assert.equal(renderTerminalSegments([identitySegment(identity)]), `${SECRET}\\u001B\\u202E\\u00E9`);
  });

  it("scrubs freeform strings before Unicode prose encoding", () => {
    const rendered = renderTerminalSegments([
      TRUSTED_SEGMENTS.ERROR_PREFIX,
      identitySegment("run\u001B[2J\u202E42"),
      TRUSTED_SEGMENTS.COLON_SPACE,
      freeformSegment(`token=${SECRET}\u001B]52;c;AAAA\u0007\u202E`),
    ]);
    assert.equal(rendered, "error: run\\u001B[2J\\u202E42: [redacted]");
    assert.doesNotMatch(rendered, /github_pat|\u001B|\u0007|\u202E/u);
  });

  it("recursively scrubs structured freeform data before terminal-safe JSON rendering", () => {
    const rendered = renderTerminalSegments([freeformSegment({
      safe: "hello\u001B[31m\u202E",
      api_token: "must not be read",
      nested: { detail: SECRET },
    })]);
    assert.deepEqual(JSON.parse(rendered), {
      safe: "hello\u001B[31m\u202E", nested: { detail: "[redacted]" },
    });
    assert.match(rendered, /\\u001b/u);
    assert.match(rendered, /\\u202E/u);
    assert.doesNotMatch(rendered, /api_token|must not be read|github_pat/u);
  });

  it("returns one fixed safe fallback when rendering cannot be verified", () => {
    const sourceDetail = "secret-render-detail";
    const hostileIdentity = identitySegment({ toString() { throw new Error(sourceDetail); } });
    assertPolicyFailure(() => renderTerminalSegments([hostileIdentity]), "render");
    assert.equal(renderTerminalSegmentsOrFallback([hostileIdentity]), SAFE_OUTPUT_FALLBACK);
    assert.doesNotMatch(renderTerminalSegmentsOrFallback([hostileIdentity]), /secret-render-detail/u);
  });
});

describe("structured and generic errors", () => {
  it("retains a raw internal message while rendering only structured segment classes", () => {
    const error = new StructuredOutputError(`run run-42 failed: ${SECRET}`, [
      TRUSTED_SEGMENTS.ERROR_PREFIX,
      identitySegment("run-42"),
      TRUSTED_SEGMENTS.COLON_SPACE,
      freeformSegment(SECRET),
    ]);
    assert.equal(error.message, `run run-42 failed: ${SECRET}`);
    assert.equal(renderErrorForTerminal(error), "error: run-42: [redacted]");
    assert.equal(String(error), "error: run-42: [redacted]");
    assert.equal(Object.hasOwn(error, "outputSegments"), false);
    assert.equal(Object.isFrozen(errorOutputSegments(error)), true);
    assert.deepEqual(Object.keys(error), []);
    assert.equal(JSON.stringify(error), "{}");
    assert.doesNotMatch(JSON.stringify({ ...error }), /github_pat/u);
    assert.doesNotMatch(String(error), /github_pat/u);
  });

  it("treats third-party errors wholly as scrubbed freeform without invoking accessors", () => {
    assert.equal(safeGenericErrorDetail(new Error(SECRET)), "[redacted]");
    assert.equal(renderErrorForTerminal(new Error("unsafe\u001B[2J\u202E")), "unsafe\\u001B[2J\\u202E");
    let getterCalls = 0;
    const hostile = {};
    Object.defineProperty(hostile, "message", {
      get() { getterCalls += 1; throw new Error(SECRET); },
    });
    assert.equal(safeGenericErrorDetail(hostile), SAFE_GENERIC_ERROR_DETAIL);
    assert.equal(renderErrorForTerminal(hostile), SAFE_GENERIC_ERROR_DETAIL);
    assert.equal(getterCalls, 0);
  });
});

describe("diagnostic projection", () => {
  it("keeps contractual identity raw while recursively scrubbing designated freeform fields", () => {
    const diagnostic = {
      run_id: SECRET,
      path: "worktree\u001B\u202E",
      evidence: {
        process_id: SECRET,
        detail: { safe: "operator prose", password: "must not escape", nested: [SECRET, "benign"] },
      },
      message: SECRET,
      action: "retry\u001B[2J\u202E",
    };
    diagnostic.unvalidated_id = SECRET;
    diagnostic.evidence.injected_id = SECRET;
    diagnostic.evidence.api_token = "must not be read";
    diagnostic.evidence.unknown = { payload: SECRET };
    diagnostic.evidence[SECRET] = "must not be read";
    const projected = projectDiagnosticData(diagnostic, {
      validatedIdentityPaths: [["run_id"], ["path"], ["evidence", "process_id"]],
    });
    assert.equal(Object.getPrototypeOf(projected), null);
    assert.equal(projected.run_id, SECRET);
    assert.equal(projected.path, "worktree\u001B\u202E");
    assert.equal(projected.evidence.process_id, SECRET);
    assert.equal(projected.unvalidated_id, "[redacted]");
    assert.equal(projected.evidence.injected_id, "[redacted]");
    assert.equal(Object.hasOwn(projected.evidence, "api_token"), false);
    assert.equal(Object.hasOwn(projected.evidence, SECRET), false);
    assert.equal(projected.evidence.unknown.payload, "[redacted]");
    assert.deepEqual({ ...projected.evidence.detail }, {
      safe: "operator prose", nested: ["[redacted]", "benign"],
    });
    assert.equal(projected.message, "[redacted]");
    assert.equal(projected.action, "retry\u001B[2J\u202E");
    const serialized = serializeTerminalJson(projected);
    assert.match(serialized, /\\u001b/u);
    assert.match(serialized, /\\u202E/u);
    assert.doesNotMatch(serialized, /password|must not escape/u);
  });

  it("scrubs token-shaped identity values unless their exact paths are validated", () => {
    const projected = projectDiagnosticData({ run_id: SECRET, nested: { run_id: SECRET } });
    assert.equal(projected.run_id, "[redacted]");
    assert.equal(projected.nested.run_id, "[redacted]");
  });

  it("returns serializer-compatible top-level and nested contractual arrays", () => {
    const diagnostics = [{
      run_id: SECRET,
      items: [{ ref: SECRET, message: SECRET }, { ref: "safe-ref", message: "safe prose" }],
    }];
    const projected = projectDiagnosticData(diagnostics, {
      validatedIdentityPaths: [["*", "run_id"], ["*", "items", "*", "ref"]],
    });
    assert.equal(Object.getPrototypeOf(projected), Array.prototype);
    assert.equal(Object.getPrototypeOf(projected[0].items), Array.prototype);
    assert.equal(projected[0].run_id, SECRET);
    assert.equal(projected[0].items[0].ref, SECRET);
    assert.equal(projected[0].items[0].message, "[redacted]");
    assert.deepEqual(JSON.parse(serializeTerminalJson(projected)), [{
      run_id: SECRET,
      items: [{ ref: SECRET, message: "[redacted]" }, { ref: "safe-ref", message: "safe prose" }],
    }]);
  });

  it("omits sensitive object keys beneath wildcard ancestors before inspecting their values", () => {
    const identity = "github_pat_identity_12345678901234567890";
    const associated = "protected-associated-sensitive-key-value";
    const partial = "github_pat_partial_123456789012345678901";
    const sibling = "github_pat_sibling_12345678901234567890";
    const descendant = "github_pat_descendant_123456789012345678";
    const source = { batches: [{
      entry: { ref: identity, note: sibling, child: { value: descendant } },
      partial,
    }] };
    let sensitiveValueReads = 0;
    Object.defineProperty(source.batches[0], "api_token", {
      enumerable: true,
      get() { sensitiveValueReads += 1; return { ref: associated }; },
    });
    const options = { validatedIdentityPaths: [["batches", "*", "*", "ref"]] };
    const projected = projectDiagnosticData(source, options);
    const serialized = serializeTerminalJson(projected);
    const parsed = JSON.parse(serialized);
    assert.equal(projected.batches[0].entry.ref, identity);
    assert.equal(parsed.batches[0].entry.ref, identity);
    assert.equal(projected.batches[0].entry.note, "[redacted]");
    assert.equal(projected.batches[0].entry.child.value, "[redacted]");
    assert.equal(projected.batches[0].partial, "[redacted]");
    assert.equal(Object.hasOwn(projected.batches[0], "api_token"), false);
    assert.equal(Object.hasOwn(parsed.batches[0], "api_token"), false);
    assert.equal(sensitiveValueReads, 0);
    assert.doesNotMatch(serialized, /api_token|protected-associated-sensitive-key-value/u);
    assertPolicyFailure(() => projectDiagnosticData({
      batches: [{ entry: { ref: { value: identity } } }],
    }, options), "projection");
  });

  it("omits oversized object keys beneath wildcard ancestors before inspecting their values", () => {
    const oversizedKey = "k".repeat(9);
    const identity = "github_pat_identity_12345678901234567890";
    const associated = "protected-associated-oversized-key-value";
    const source = { batches: [{
      entry: { ref: identity, note: SECRET },
    }] };
    let oversizedValueReads = 0;
    Object.defineProperty(source.batches[0], oversizedKey, {
      enumerable: true,
      get() { oversizedValueReads += 1; return { ref: associated }; },
    });
    const projected = projectDiagnosticData(source, {
      validatedIdentityPaths: [["batches", "*", "*", "ref"]],
      maxStringLength: 8,
    });
    const serialized = serializeTerminalJson(projected);
    const parsed = JSON.parse(serialized);
    assert.equal(projected.batches[0].entry.ref, identity);
    assert.equal(parsed.batches[0].entry.ref, identity);
    assert.equal(projected.batches[0].entry.note, "[redacted]");
    assert.equal(parsed.batches[0].entry.note, "[redacted]");
    assert.equal(Object.hasOwn(projected.batches[0], oversizedKey), false);
    assert.equal(Object.hasOwn(parsed.batches[0], oversizedKey), false);
    assert.equal(oversizedValueReads, 0);
    assert.equal(serialized.includes(oversizedKey), false);
    assert.equal(serialized.includes(associated), false);
  });

  it("rejects sparse, named, or accessor-backed contractual arrays with fixed errors", () => {
    const sparse = new Array(2);
    sparse[1] = "value";
    const named = ["value"];
    named.extra = SECRET;
    const accessor = ["value"];
    Object.defineProperty(accessor, "0", {
      enumerable: true, get() { throw new Error(SECRET); },
    });
    for (const value of [sparse, named, accessor]) {
      assertPolicyFailure(() => projectDiagnosticData(value), "projection");
    }
  });

  it("bounds oversized unknown keys and values while exempting only exact validated identities", () => {
    const oversizedKey = "k".repeat(9);
    const projected = projectDiagnosticData({
      id: SECRET,
      value: "v".repeat(9),
      nested: { [oversizedKey]: "must not be read", safe: "ok" },
    }, { validatedIdentityPaths: [["id"]], maxStringLength: 8 });
    assert.equal(projected.id, SECRET);
    assert.equal(projected.value, "[redacted]");
    assert.equal(Object.hasOwn(projected.nested, oversizedKey), false);
    assert.equal(projected.nested.safe, "ok");
    assert.deepEqual(JSON.parse(serializeTerminalJson(projected)), {
      id: SECRET, value: "[redacted]", nested: { safe: "ok" },
    });
  });

  it("enforces shared depth, node, key, and array bounds with strict-JSON-safe markers", () => {
    const byDepth = projectDiagnosticData({ root: { nested: { value: "not visited" } } }, { maxDepth: 2 });
    assert.equal(byDepth.root.nested, "[truncated]");
    const byNodes = projectDiagnosticData({
      first: "ok", second: "not visited", third: "not visited",
    }, { maxNodes: 2 });
    assert.deepEqual({ ...byNodes }, { first: "ok", second: "[truncated]" });
    const byKeys = projectDiagnosticData({ first: "ok", second: "not visited" }, { maxKeys: 1 });
    assert.deepEqual({ ...byKeys }, { first: "ok", "[truncated]": "[truncated]" });
    const byArrayLength = projectDiagnosticData(["first", "second", "not visited"], { maxArrayLength: 2 });
    assert.deepEqual(byArrayLength, ["first", "[truncated]"]);
    assert.equal(Object.getPrototypeOf(byArrayLength), Array.prototype);
    const byArrayKeys = projectDiagnosticData(["first", "second", "not visited"], { maxKeys: 1 });
    assert.deepEqual(byArrayKeys, ["first", "[truncated]"]);
    for (const projected of [byDepth, byNodes, byKeys, byArrayLength, byArrayKeys]) {
      assert.doesNotThrow(() => serializeTerminalJson(projected));
    }
  });

  it("supports standalone full-freeform projection and fixed projection errors", () => {
    const projected = projectFreeformData({ identity_like: SECRET, reason: "safe" });
    assert.deepEqual({ ...projected }, { identity_like: "[redacted]", reason: "safe" });
    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "message", {
      enumerable: true,
      get() { getterCalls += 1; throw new Error("projection source detail"); },
    });
    const accessorProjection = projectDiagnosticData(accessor);
    assert.equal(accessorProjection.message, "[unavailable]");
    assert.equal(getterCalls, 0);
    assert.doesNotThrow(() => serializeTerminalJson(accessorProjection));
  });
});

function assertPolicyFailure(callback, stage) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof OutputPolicyError, true);
    assert.equal(error.name, "OutputPolicyError");
    assert.equal(error.code, "ERR_OUTPUT_POLICY");
    assert.equal(error.stage, stage);
    assert.equal(error.message, SAFE_OUTPUT_FALLBACK);
    return true;
  });
}
