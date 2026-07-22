import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  REDACTED_KEY,
  REDACTED_VALUE,
  SCRUB_MARKERS,
  isSecretShapedKey,
  isSensitiveKey,
  isSensitiveValue,
  scrubSensitiveData,
  scrubSensitiveString,
} from "../src/hardening/sensitive-data.js";
import { startB6Span } from "../src/telemetry.js";

describe("sensitive-data policy", () => {
  it("redacts only flattened Basic credential values across supported variants", () => {
    const cases = [
      ["Authorization: Basic dXNlcjpwYXNz", "Authorization: Basic [redacted]"],
      // Proxy-Authorization is a standard credential-bearing header (RFC 7235), not a lookalike.
      ["Proxy-Authorization: Basic dXNlcjpwYXNz", "Proxy-Authorization: Basic [redacted]"],
      ["proxy-authorization\t=\tBASIC\tdXNlcjpwYXNz==", "proxy-authorization\t=\tBASIC\t[redacted]"],
      ["authorization\t=\tBASIC\tdXNlcjpwYXNz==", "authorization\t=\tBASIC\t[redacted]"],
      ["prefix (Authorization : Basic abc+/~._-) suffix", "prefix (Authorization : Basic [redacted]) suffix"],
      [
        "before\nAuthorization: Basic first==\r\nafter Authorization=Basic\tsecond/+=\rend",
        "before\nAuthorization: Basic [redacted]\r\nafter Authorization=Basic\t[redacted]\rend",
      ],
      [
        "Authorization: Basic first, Authorization: Basic second==",
        "Authorization: Basic [redacted], Authorization: Basic [redacted]",
      ],
    ];

    for (const [source, expected] of cases) {
      assert.equal(isSensitiveValue(source), true, source);
      const scrubbed = scrubSensitiveString(source);
      assert.equal(scrubbed, expected);
      assert.equal(scrubSensitiveString(scrubbed), expected);
      for (const credential of source.match(/(?:first|second|dXNlcjpwYXNz|abc\+\/~\._-)+/gu) || []) {
        assert.equal(scrubbed.includes(credential), false, credential);
      }
    }
  });

  it("rejects Basic-header lookalikes and malformed token68 continuations", () => {
    for (const value of [
      "XAuthorization: Basic abc",
      "X-Authorization: Basic abc",
      "X-Proxy-Authorization: Basic abc",
      "Authorization Basic abc",
      "Authorization: Basic",
      "Authorization: Basic ",
      "Authorization:Basic\nabc",
      "Authorization: Basic abc=def",
      "Authorization: Basic abc==def",
    ]) {
      assert.equal(isSensitiveValue(value), false, value);
      assert.equal(scrubSensitiveString(value), value, value);
    }
  });

  it("recognizes baseline key fragments, providers, credentials, hex, and entropy case-insensitively", () => {
    const cases = [
      "GITHUB_PAT_123456789012345678901234567890",
      "GHP_123456789012345678901234567890",
      "HC_API_12345678901234567890",
      "SK-123456789012345678901234567890",
      "XOXB-1234567890-ABCDEFGHIJ",
      "GLPAT-12345678901234567890",
      "Bearer abcdefghijklmnopqrstuvwxyz123456",
      "eyJabcdefg.abcdefghij.abcdefghij",
      "akia1234567890abcdef",
      "0123456789abcdef0123456789abcdef",
      "https://user:pass@example.test/repo.git",
      "Q7M4Z9N2C8V5B1X6L3K0P7R2T9Y4U8I5",
    ];
    for (const value of cases) assert.equal(isSensitiveValue(value), true, value);

    assert.equal(isSensitiveKey("Api-Token"), true);
    assert.equal(isSensitiveKey(cases.at(-1)), true);
    assert.equal(isSecretShapedKey("0123456789ABCDEF0123456789ABCDEF"), true);
    assert.equal(isSensitiveValue("z".repeat(64)), false);
    assert.equal(isSensitiveValue(123), false);
    assert.equal(isSensitiveKey(null), false);
  });

  it("preserves the narrow known-configuration key allowlist", () => {
    for (const key of [
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
      "OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE",
      "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
      "FEATURE_FACTORY_OTEL_ENABLED",
    ]) assert.equal(isSensitiveKey(key), false, key);
  });

  it("adds endpoint-only provider, assignment, bare-hex, and mixed-token rules", () => {
    const endpointOnly = [
      "hcshort_1234567890",
      "abcdef0123456789abcdef0123456789",
      "team=collector",
      "prefix authorization: value",
      "Abcdefghijklmnopqrstu123",
    ];
    for (const value of endpointOnly) {
      assert.equal(isSensitiveValue(value, { mode: "endpoint" }), true, value);
    }
    assert.equal(isSensitiveValue("Abcdefghijklmnopqrstu123", { mode: "baseline" }), false);
    assert.equal(isSensitiveValue("team collector", { mode: "endpoint" }), false);
    assert.equal(scrubSensitiveString("team=collector", { mode: "endpoint" }), REDACTED_VALUE);
  });

  it("validates policy options without including source data", () => {
    assert.throws(() => isSensitiveValue("do-not-include", { mode: "strict" }), /invalid sensitive-data mode/u);
    assert.throws(() => scrubSensitiveData("do-not-include", { keyMode: "rename" }), /invalid sensitive-data key mode/u);
    assert.throws(() => scrubSensitiveData("do-not-include", { maxNodes: -1 }), /invalid sensitive-data maxNodes/u);
    assert.equal(scrubSensitiveString(123), SCRUB_MARKERS.unsupported);
  });
});

describe("bounded prototype-safe projection", () => {
  it("recursively omits sensitive keys and redacts sensitive and oversized values", () => {
    const secretKey = "github_pat_123456789012345678901234567890";
    const result = scrubSensitiveData({
      keep: "ok",
      api_token: "never read",
      [secretKey]: "never read",
      nested: [{ password: "never read", safe: "https://user:pass@example.test" }],
      tooLong: "abcdefghij",
    }, { maxStringLength: 9 });

    assert.equal(Object.getPrototypeOf(result), null);
    assert.deepEqual(Object.keys(result), ["keep", "nested", "tooLong"]);
    assert.equal(result.keep, "ok");
    assert.equal(result.nested[0].safe, REDACTED_VALUE);
    assert.equal(result.tooLong, REDACTED_VALUE);
    assert.doesNotMatch(JSON.stringify(result), /never read|github_pat|api_token|password/u);
  });

  it("redacts keys deterministically without collisions or value access", () => {
    const source = Object.create(null);
    Object.defineProperty(source, REDACTED_KEY, { value: "safe-one", enumerable: true });
    Object.defineProperty(source, "api_token", {
      enumerable: true,
      get() { throw new Error("secret getter text"); },
    });
    Object.defineProperty(source, `${REDACTED_KEY}#2`, { value: "safe-two", enumerable: true });
    Object.defineProperty(source, "password", { value: "secret value", enumerable: true });

    const result = scrubSensitiveData(source, { keyMode: "redact" });
    assert.deepEqual(Object.keys(result), [REDACTED_KEY, `${REDACTED_KEY}#3`, `${REDACTED_KEY}#2`, `${REDACTED_KEY}#4`]);
    assert.equal(result[REDACTED_KEY], "safe-one");
    assert.equal(result[`${REDACTED_KEY}#2`], "safe-two");
    assert.equal(result[`${REDACTED_KEY}#3`], REDACTED_VALUE);
    assert.equal(result[`${REDACTED_KEY}#4`], REDACTED_VALUE);
    assert.doesNotMatch(JSON.stringify(result), /api_token|password|secret getter|secret value/u);
  });

  it("defines prototype-like names as own data properties on null-prototype output", () => {
    const source = Object.create(null);
    for (const key of ["__proto__", "prototype", "constructor"]) {
      Object.defineProperty(source, key, { value: key, enumerable: true });
    }
    const result = scrubSensitiveData(source);
    assert.equal(Object.getPrototypeOf(result), null);
    assert.deepEqual(Object.keys(result), ["__proto__", "prototype", "constructor"]);
    assert.equal(result.__proto__, "__proto__");
    assert.equal(result.constructor, "constructor");
  });

  it("marks unsupported scalars and custom instances while preserving safe scalars", () => {
    class Custom {}
    const source = Object.create(null);
    Object.assign(source, {
      nil: null,
      yes: true,
      number: 12.5,
      zero: 0,
      undefined: undefined,
      fn() {},
      symbol: Symbol("source-secret"),
      bigint: 1n,
      infinity: Infinity,
      nan: NaN,
      negativeZero: -0,
      date: new Date(0),
      custom: new Custom(),
    });
    const result = scrubSensitiveData(source);
    assert.deepEqual([result.nil, result.yes, result.number, result.zero], [null, true, 12.5, 0]);
    for (const key of ["undefined", "fn", "symbol", "bigint", "infinity", "nan", "negativeZero", "date", "custom"]) {
      assert.equal(result[key], SCRUB_MARKERS.unsupported, key);
    }
    assert.doesNotMatch(JSON.stringify(result), /source-secret/u);
  });

  it("enforces root depth, node, key, and collision-safe truncation bounds", () => {
    assert.equal(scrubSensitiveData({ value: "safe" }, { maxDepth: 0 }), SCRUB_MARKERS.truncated);
    assert.equal(scrubSensitiveData("safe", { maxNodes: 0 }), SCRUB_MARKERS.truncated);

    const byNodes = scrubSensitiveData({ first: "safe", second: "safe", third: "safe" }, { maxNodes: 2 });
    assert.deepEqual({ ...byNodes }, { first: "safe", second: SCRUB_MARKERS.truncated });

    const byKeys = scrubSensitiveData({
      [SCRUB_MARKERS.truncated]: "reserved",
      first: "safe",
      second: "not visited",
    }, { maxKeys: 1 });
    assert.deepEqual(Object.keys(byKeys), [SCRUB_MARKERS.truncated, `${SCRUB_MARKERS.truncated}#2`]);
    assert.equal(byKeys[SCRUB_MARKERS.truncated], "reserved");
    assert.equal(byKeys[`${SCRUB_MARKERS.truncated}#2`], SCRUB_MARKERS.truncated);
    assert.doesNotMatch(JSON.stringify(byKeys), /not visited/u);
  });

  it("ignores non-enumerables without spending or reserving the enumerable-key budget", () => {
    const source = Object.create(null);
    Object.defineProperty(source, REDACTED_KEY, { value: "ignored", enumerable: false });
    Object.defineProperty(source, "hidden", { value: "ignored", enumerable: false });
    Object.defineProperty(source, "api_token", { value: "not read", enumerable: true });
    Object.defineProperty(source, "later", { value: "not visited", enumerable: true });

    const result = scrubSensitiveData(source, { keyMode: "redact", maxKeys: 1 });
    assert.deepEqual(Object.keys(result), [REDACTED_KEY, SCRUB_MARKERS.truncated]);
    assert.equal(result[REDACTED_KEY], REDACTED_VALUE);
    assert.equal(result[SCRUB_MARKERS.truncated], SCRUB_MARKERS.truncated);
    assert.doesNotMatch(JSON.stringify(result), /ignored|not read|not visited/u);
  });

  it("stops descriptor inspection after the first over-budget enumerable key", () => {
    const inspected = [];
    const source = {};
    Object.defineProperty(source, "hiddenOne", { value: 1, enumerable: false, configurable: true });
    Object.defineProperty(source, "hiddenTwo", { value: 2, enumerable: false, configurable: true });
    source.first = "safe";
    source.second = "not visited";
    source.later = "not inspected";
    const proxy = new Proxy(source, {
      getOwnPropertyDescriptor(target, key) {
        inspected.push(key);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    const result = scrubSensitiveData(proxy, { maxKeys: 1 });
    assert.deepEqual(inspected, ["hiddenOne", "hiddenTwo", "first", "second"]);
    assert.deepEqual({ ...result }, { first: "safe", [SCRUB_MARKERS.truncated]: SCRUB_MARKERS.truncated });
  });

  it("preserves array holes and named properties and caps without inspecting later indices", () => {
    const source = new Array(5);
    source[1] = "safe";
    Object.defineProperty(source, 3, {
      enumerable: true,
      get() { throw new Error("late-index-secret"); },
    });
    Object.defineProperty(source, "__proto__", { value: "named", enumerable: true });
    Object.defineProperty(source, "api_token", {
      enumerable: true,
      get() { throw new Error("named-secret"); },
    });

    const result = scrubSensitiveData(source, { maxArrayLength: 3 });
    assert.equal(result.length, 3);
    assert.equal(0 in result, false);
    assert.equal(result[1], "safe");
    assert.equal(result[2], SCRUB_MARKERS.truncated);
    assert.equal(Object.hasOwn(result, "__proto__"), true);
    assert.equal(result.__proto__, "named");
    assert.equal(Object.hasOwn(result, "api_token"), false);
    assert.doesNotMatch(JSON.stringify(result), /late-index-secret|named-secret/u);
  });

  it("rejects a zero array-length bound because no truncation slot exists", () => {
    assert.throws(
      () => scrubSensitiveData(["not inspected"], { maxArrayLength: 0 }),
      /invalid sensitive-data maxArrayLength/u,
    );
  });

  it("distinguishes active cycles from completed shared references", () => {
    const shared = { safe: "value" };
    const root = { first: shared, second: shared };
    root.self = root;
    shared.parent = root;

    const result = scrubSensitiveData(root);
    assert.equal(result.first.parent, SCRUB_MARKERS.circular);
    assert.equal(result.second, SCRUB_MARKERS.repeated);
    assert.equal(result.self, SCRUB_MARKERS.circular);
  });
});

describe("descriptor and proxy failures", () => {
  it("never invokes accessors, ignores symbols and non-enumerables, and continues after property failure", () => {
    let getterCalls = 0;
    const source = { before: "safe", accessor: "replaced", after: "safe" };
    Object.defineProperty(source, "accessor", {
      enumerable: true,
      get() { getterCalls += 1; return "secret getter result"; },
    });
    Object.defineProperty(source, "hidden", {
      enumerable: false,
      get() { getterCalls += 1; return "hidden secret"; },
    });
    Object.defineProperty(source, Symbol("symbol-secret"), {
      enumerable: true,
      get() { getterCalls += 1; return "symbol value"; },
    });

    const descriptorFailure = new Proxy(source, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "after") throw new Error("proxy-source-secret");
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const result = scrubSensitiveData(descriptorFailure);
    assert.equal(getterCalls, 0);
    assert.deepEqual({ ...result }, {
      before: "safe",
      accessor: SCRUB_MARKERS.unavailable,
      after: SCRUB_MARKERS.unavailable,
    });
    assert.doesNotMatch(JSON.stringify(result), /getter result|hidden secret|symbol-secret|proxy-source-secret/u);
  });

  it("fails a whole container closed on reflection errors without leaking trap text", () => {
    const source = new Proxy({}, {
      ownKeys() { throw new Error("whole-container-source-secret"); },
    });
    assert.equal(scrubSensitiveData(source), SCRUB_MARKERS.unavailable);

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    assert.equal(scrubSensitiveData(revoked.proxy), SCRUB_MARKERS.unavailable);
  });

  it("marks a disappeared ownKeys entry unavailable without overwriting reserved names and continues", () => {
    const source = {
      [REDACTED_KEY]: "reserved",
      api_token: "not read",
      vanished: "removed",
      after: "safe",
    };
    const proxy = new Proxy(source, {
      ownKeys() {
        return [REDACTED_KEY, "api_token", "vanished", "after"];
      },
      getOwnPropertyDescriptor(target, key) {
        if (key === "vanished") {
          delete target.vanished;
          return undefined;
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    const result = scrubSensitiveData(proxy, { keyMode: "redact" });
    assert.deepEqual(Object.keys(result), [REDACTED_KEY, `${REDACTED_KEY}#2`, "vanished", "after"]);
    assert.equal(result[REDACTED_KEY], "reserved");
    assert.equal(result[`${REDACTED_KEY}#2`], REDACTED_VALUE);
    assert.equal(result.vanished, SCRUB_MARKERS.unavailable);
    assert.equal(result.after, "safe");
    assert.doesNotMatch(JSON.stringify(result), /not read|removed/u);
  });

  it("does not inspect omitted sensitive property values", () => {
    let descriptorCalls = 0;
    const source = new Proxy({ api_token: "source-secret-value", safe: "ok" }, {
      getOwnPropertyDescriptor(target, key) {
        descriptorCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      get() { throw new Error("source get trap"); },
    });
    const result = scrubSensitiveData(source);
    assert.equal(result.safe, "ok");
    assert.equal(Object.hasOwn(result, "api_token"), false);
    assert.equal(descriptorCalls, 2);
    assert.doesNotMatch(JSON.stringify(result), /source-secret-value|source get trap/u);
  });
});

describe("B6 emitted span sensitive-data boundary", () => {
  it("exports only the exact metadata allowlist under hostile keys and values", async () => {
    const spans = [];
    const api = {
      context: { active: () => ({ trace: "active" }) },
      trace: {
        getTracer: () => ({
          startActiveSpan(name, options, context, callback) {
            const span = {
              name,
              attributes: { ...(options?.attributes || {}) },
              setAttribute(key, value) { this.attributes[key] = value; },
              addEvent() {},
              setStatus() {},
              end() {},
            };
            spans.push(span);
            return callback(span);
          },
        }),
      },
    };
    const hostileKey = "github_pat_123456789012345678901234567890";
    const controller = startB6Span("feature_factory.task", {
      "feature_factory.run_id": "safe-run",
      "feature_factory.slice_id": "safe-slice",
      "feature_factory.session_id": "safe-session",
      "feature_factory.call_id": "ghp_123456789012345678901234567890",
      "feature_factory.target_agent": "backend-builder",
      "feature_factory.span_event": "task-before",
      "feature_factory.span_operation": "execute-task",
      "gen_ai.conversation.id": "safe-run",
      prompt: `read ${hostileKey}`,
      messages: [{ content: hostileKey }],
      tool_arguments: { token: hostileKey },
      tool_result: hostileKey,
      review_ref: "reviews/secret.json",
      evidence_hash: "sha256:abcdef",
      raw_path: "/private/secret",
      url: "https://user:pass@example.test",
      traceparent: "00-secret",
      tracestate: "vendor=secret",
      task_id: "task-secret",
      [hostileKey]: "value",
    }, { telemetry: { enabled: true, importer: async () => api } });
    await controller.end();

    assert.deepEqual(spans[0].attributes, {
      "feature_factory.run_id": "safe-run",
      "feature_factory.slice_id": "safe-slice",
      "feature_factory.session_id": `ffid:${createHash("sha256").update("safe-session", "utf8").digest("hex").slice(0, 32)}`,
      "feature_factory.call_id": `ffid:${createHash("sha256").update("ghp_123456789012345678901234567890", "utf8").digest("hex").slice(0, 32)}`,
      "feature_factory.target_agent": "backend-builder",
      "feature_factory.span_event": "task-before",
      "feature_factory.span_operation": "execute-task",
      "gen_ai.conversation.id": "safe-run",
    });
    const serialized = JSON.stringify(spans);
    assert.doesNotMatch(serialized, /github_pat|prompt|messages|tool_|review|evidence|private|user:pass|traceparent|tracestate|task_id|task-secret/u);
  });
});
